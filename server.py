#!/usr/bin/env python3
# ai-visualizer: give your AI agent a face.
# Copyright (C) 2026 Jared Rhodenizer
#
# This program is free software: you can redistribute it and/or modify
# it under the terms of the GNU Affero General Public License as published
# by the Free Software Foundation, either version 3 of the License, or
# (at your option) any later version.
#
# This program is distributed in the hope that it will be useful,
# but WITHOUT ANY WARRANTY; without even the implied warranty of
# MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
# GNU Affero General Public License for more details.
#
# You should have received a copy of the GNU Affero General Public License
# along with this program. If not, see <https://www.gnu.org/licenses/>.
#
# SPDX-License-Identifier: AGPL-3.0-or-later
"""ai-visualizer server. Python standard library only, nothing to install.

Serves the face gallery at http://127.0.0.1:8790/ and exposes:

  /state   polled by the faces (~8x/sec):
           {"state":  "idle|listening|thinking|speaking",
            "level":  0.0-1.0,       voice loudness while speaking
            "samples": [64 floats],  raw waveform snapshot (0s when quiet)
            "alert":  bool,          optional attention signal
            "loading": bool}         true while the voice line plays its
                                     own thinking sound (we stay quiet)
  /config  the merged ai-visualizer.json plus the list of installed
           faces, discovered by scanning the faces/ folder. Drop a new
           folder with an index.html into faces/ and it appears in the
           gallery. That is the whole plugin system.

READ-ONLY on the signal bus. The bus is three tiny files written by a
voice line (backtalk writes them natively, github.com/jaredrhod/backtalk):

  .voice_state        idle | listening | thinking | speaking
  .voice_waveform     JSON {ts, samples: [64 floats]} while audio plays
  .voice_loading_pid  exists while the voice line plays a thinking sound
  .voice_alert        optional: non-empty file = attention needed

Where the bus lives comes from "bus_dir" in ai-visualizer.json (default:
this folder). Point it at your backtalk folder, or point backtalk's
"signals_dir" here. Either direction works.

Run:
  python3 server.py             the real bus
  python3 server.py --mock speaking
                                no voice line needed: /state synthesizes
                                the chosen state (idle|listening|thinking
                                |speaking) so you can see a face perform
  python3 server.py --no-open   do not auto-open the browser
Ctrl-C stops.
"""
import json
import math
import mimetypes
import os
import sys
import threading
import time
import webbrowser
import urllib.request
from urllib.parse import parse_qs, urlparse
import email.utils
import errno
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parent
STATES = {"idle", "listening", "thinking", "speaking"}
WAVEFORM_STALE_S = 0.6

DEFAULTS = {
    "name": "JARVIS",       # shown on the chip / headers, yours to change
    "badge": "",            # optional handle shown in some faces' chrome
    "face": "board",        # the default face the root URL opens
    "host": "127.0.0.1",    # bind address. "127.0.0.1" (default) is
                            # localhost-only; "0.0.0.0" listens on every
                            # interface, needed to reach this from another
                            # machine on the LAN. No auth of any kind
                            # lives here, so only widen this on a network
                            # you already trust.
    "port": 8790,
    "bus_dir": "",          # where the .voice_* files live ("" = here)
    "thinking_sound": True, # play assets/thinking.wav while thinking
    "backend_ws": "",       # backtalk's browser bridge, e.g.
                            # "ws://127.0.0.1:8792" — tap/click-to-talk on
                            # the face. "" leaves it off (default).
    # Hue shift (degrees, CSS hue-rotate) on the face per mic mode, so
    # the mode reads at a glance: push-to-talk, hands-free listening,
    # and paused (waiting for "start listening").
    "mode_hues": {"ptt": 0, "listening": 120, "paused": -110},
}


def load_config():
    cfg = dict(DEFAULTS)
    try:
        # AI_VISUALIZER_CONFIG: a second face (another agent) on its own file.
        path = os.environ.get("AI_VISUALIZER_CONFIG") or HERE / "ai-visualizer.json"
        user = json.loads(Path(path).read_text())
        for k, v in user.items():
            cfg[k] = v
    except FileNotFoundError:
        pass
    except ValueError as e:
        print(f"[config] ai-visualizer.json is not valid JSON ({e}), "
              f"using defaults")
    return cfg


CFG = load_config()
BUS = Path(CFG["bus_dir"]).expanduser() if CFG.get("bus_dir") else HERE

MOCK = None
NO_OPEN = "--no-open" in sys.argv
if "--mock" in sys.argv:
    i = sys.argv.index("--mock")
    MOCK = sys.argv[i + 1] if len(sys.argv) > i + 1 else "speaking"
    if MOCK not in STATES:
        MOCK = "speaking"
HOST = str(CFG.get("host", "127.0.0.1"))
PORT = int(CFG.get("port", 8790))
if "--port" in sys.argv:
    i = sys.argv.index("--port")
    PORT = int(sys.argv[i + 1])


def list_faces():
    faces = []
    fdir = HERE / "faces"
    if fdir.is_dir():
        for p in sorted(fdir.iterdir()):
            if p.is_dir() and (p / "index.html").exists():
                meta = {"id": p.name, "title": p.name.title(), "tagline": ""}
                try:
                    meta.update(json.loads((p / "face.json").read_text()))
                except (OSError, ValueError):
                    pass
                meta["id"] = p.name
                faces.append(meta)
    return faces


def mock_bus():
    t = time.time()
    level = 0.0
    samples = [0.0] * 64
    if MOCK == "speaking":
        level = abs(math.sin(t * 6.0)) * 0.85
        samples = [
            (math.sin(i * 0.55 + t * 9.0) * 0.6
             + math.sin(i * 1.7 - t * 13.0) * 0.4)
            * 9000.0 * (0.35 + 0.65 * abs(math.sin(t * 2.6)))
            for i in range(64)
        ]
    return {"state": MOCK, "level": level, "samples": samples,
            "alert": False, "loading": MOCK == "thinking",
            # Faked so the usage readout can be looked at without
            # spending a real session to make it appear.
            "rate_limits": {
                "five_hour": {"utilization": 0.34, "resets_at": t + 9200},
                "seven_day": {"utilization": 0.61, "resets_at": t + 288000},
            }}


def read_bus(device: str = ""):
    if MOCK:
        return mock_bus()
    entry = _device_entry(device)
    out = _owned_state(device, entry) if entry.get("owned") else _shared_bus()
    # countdowns for this device's face (<<timers>>), owned or not
    out["timers"] = entry.get("timers") or []
    return out


def _shared_bus():
    try:
        state = (BUS / ".voice_state").read_text().strip().lower()
        if state not in STATES:
            state = "idle"
    except OSError:
        state = "idle"
    level = 0.0
    samples = [0.0] * 64
    try:
        payload = json.loads((BUS / ".voice_waveform").read_text())
        age = time.time() - float(payload.get("ts", 0))
        raw = payload.get("samples") or []
        if raw and age < WAVEFORM_STALE_S:
            # A fresh waveform IS speech, whatever the state file says.
            state = "speaking"
            samples = [float(s) for s in raw[:64]]
            mean = sum(abs(s) for s in samples) / len(samples)
            level = min(1.0, mean / 3000.0)
    except (OSError, ValueError, KeyError, TypeError):
        pass
    try:
        alert = (BUS / ".voice_alert").stat().st_size > 0
    except OSError:
        alert = False
    loading = (BUS / ".voice_loading_pid").exists()
    # Absent unless the voice line was told to publish it, which is the
    # normal case: it is the account holder's own spend and it stays off
    # until asked for. An empty dict simply means no readout.
    rate_limits = {}
    try:
        rate_limits = json.loads((BUS / ".voice_rate_limits").read_text())
    except (OSError, ValueError):
        pass
    # How many of the agent's background tasks are still running (the
    # faces draw one satellite per task). Written by the voice line as
    # `.voice_tasks` holding a plain integer; absent or unreadable = 0.
    tasks = 0
    try:
        tasks = max(0, int((BUS / ".voice_tasks").read_text().strip() or 0))
    except (OSError, ValueError):
        pass
    # Which browser connection the CURRENT turn's reply is going to, if
    # a specific one asked for it; "" means everyone (nobody specific
    # asked, or no turn in flight). Written by the voice line as
    # `.voice_active_conn`; absent or unreadable = "" (everyone).
    active_conn = ""
    try:
        active_conn = (BUS / ".voice_active_conn").read_text().strip()
    except OSError:
        pass
    # The last model call's speed, {gen, read?, ts} tok/s (backtalk's
    # show_speed); {} = no readout.
    speed = {}
    try:
        speed = json.loads((BUS / ".voice_speed").read_text())
    except (OSError, ValueError):
        pass
    return {"state": state, "level": level, "samples": samples,
            "alert": alert, "loading": loading, "rate_limits": rate_limits,
            "tasks": tasks, "active_conn": active_conn, "speed": speed}


def _device_entry(device: str) -> dict:
    """This device's entry in `.voice_devices` (written by the voice line),
    {} if none: {owned, state, samples, wave_ts, tasks, timers}. A device
    owned by a second agent session (cook-with-me in the kitchen) reads
    its state from here instead of the shared bus."""
    if not device:
        return {}
    try:
        d = json.loads((BUS / ".voice_devices").read_text()).get(device)
    except (OSError, ValueError, AttributeError):
        return {}
    return d if isinstance(d, dict) else {}


def _owned_state(device: str, d: dict):
    state = d.get("state") if d.get("state") in STATES else "idle"
    samples, level = [0.0] * 64, 0.0
    raw = d.get("samples") or []
    if raw and time.time() - float(d.get("wave_ts") or 0) < WAVEFORM_STALE_S:
        state = "speaking"
        samples = [float(x) for x in raw[:64]]
        level = min(1.0, sum(abs(x) for x in samples) / len(samples) / 3000.0)
    return {"state": state, "level": level, "samples": samples,
            "alert": False, "loading": False, "rate_limits": {},
            "tasks": max(0, int(d.get("tasks") or 0)), "active_conn": device}


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        path = self.path.split("?")[0]
        try:
            if path == "/state":
                q = parse_qs(urlparse(self.path).query)
                self._send(json.dumps(read_bus((q.get("device") or [""])[0])).encode(),
                           "application/json")
            elif path == "/config":
                out = {"name": CFG["name"], "badge": CFG["badge"],
                       "face": CFG["face"],
                       "thinking_sound": bool(CFG["thinking_sound"]),
                       "backend_ws": CFG.get("backend_ws", ""),
                       "mode_hues": CFG.get("mode_hues", {}),
                       "faces": list_faces()}
                self._send(json.dumps(out).encode(), "application/json")
            else:
                self._static(path)
        except ConnectionError:
            # THE WHOLE FAMILY, not one member of it. A tab closed or
            # reloaded mid-response raises ConnectionResetError, which is a
            # SIBLING of BrokenPipeError rather than a subclass -- so
            # catching only BrokenPipeError sent it to the generic branch
            # below, which then wrote a 500 back down the socket that had
            # just died and raised a SECOND, uncaught error from inside
            # flush_headers(). One disconnect, two tracebacks. ConnectionError
            # is the common parent of Reset, Broken, Aborted and Refused.
            pass
        except Exception as e:
            body = json.dumps({"error": str(e)}).encode()
            try:
                self._send(body, "application/json", 500)
            except ConnectionError:
                # A real error AND the client already gone. There is nobody
                # left to tell; saying so twice helps no one.
                pass

    def _static(self, path):
        if path == "/":
            path = "/index.html"
        target = (HERE / path.lstrip("/")).resolve()
        if target != HERE and HERE not in target.parents:
            self._send(b"not found", "text/plain", 404)
            return
        if target.is_dir():
            target = target / "index.html"
        if not target.is_file():
            self._send(b"not found", "text/plain", 404)
            return
        ctype = mimetypes.guess_type(str(target))[0] or \
            "application/octet-stream"
        self._send(target.read_bytes(), ctype,
                   modified=email.utils.formatdate(target.stat().st_mtime, usegmt=True))

    def _send(self, body, ctype, code=200, modified=None):
        self.send_response(code)
        if modified:
            self.send_header("Last-Modified", modified)   # the face's build, shown in a corner
        self.send_header("Content-Type", ctype)
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    # a face's build check: the same headers (Last-Modified), no body
    do_HEAD = do_GET

    def log_message(self, *a):
        pass


if __name__ == "__main__":
    mode = f"MOCK={MOCK}" if MOCK else f"bus: {BUS}"
    root = f"http://127.0.0.1:{PORT}/"
    # The browser opens on the configured face; the gallery stays at "/" for switching.
    face = CFG.get("face", "")
    url = f"{root}faces/{face}/" if face and (HERE / "faces" / face / "index.html").exists() else root
    # ALREADY RUNNING IS NOT AN ERROR, and treating it as one was the whole
    # bug. Closing the browser tab does not stop this server; it keeps going
    # headless. Relaunching then failed to bind, died before the line that
    # opens the browser, and took the traceback with it when the launcher
    # window closed. The end-user symptom was "I can hear my agent but the
    # face never shows up", with the face running perfectly the entire time.
    try:
        srv = ThreadingHTTPServer((HOST, PORT), Handler)
    except OSError as e:
        if e.errno not in (errno.EADDRINUSE, errno.EACCES):
            raise
        # Something holds the port. Ask it whether it is us before claiming
        # anything: a stranger on this port is a different problem and
        # deserves a different sentence.
        mine = False
        try:
            with urllib.request.urlopen(root + "state", timeout=2) as r:
                mine = r.status == 200
        except Exception:
            mine = False
        if mine:
            print(f"already running at {root}  opening it instead", flush=True)
            if not NO_OPEN:
                webbrowser.open(url)
            sys.exit(0)
        print(f"port {PORT} is taken by something that is not this server.",
              flush=True)
        print("Close whatever is using it, or set a different \"port\" in "
              "ai-visualizer.json.", flush=True)
        sys.exit(1)
    srv.allow_reuse_address = True
    print(f"ai-visualizer on {root}  opening {url}  ({mode})  Ctrl-C stops", flush=True)
    if not NO_OPEN:
        threading.Timer(0.6, lambda: webbrowser.open(url)).start()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
