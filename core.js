/*
 * ai-visualizer: give your AI agent a face.
 * Copyright (C) 2026 Jared Rhodenizer
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published
 * by the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program. If not, see <https://www.gnu.org/licenses/>.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/* ============================================================
   ai-visualizer core — the shared plumbing every face rides on.

   A face is one self-contained page in faces/<name>/index.html.
   It includes this script, calls AV.init(opts), then reads these
   fields every animation frame after calling AV.tick(dtMs):

     AV.state      "idle" | "listening" | "thinking" | "speaking"
     AV.level      0..1 raw voice loudness (speaking only)
     AV.env        0..1 smoothed speech envelope (attack/release eased,
                   adaptively normalized — use this for motion)
     AV.samples    Float32Array(64), 0..1 normalized waveform ring
     AV.alert      bool, optional attention signal
     AV.listening  bool, this tab's mic is taking a question (draw that,
                   not state "listening")
     AV.tasks      running background tasks (one indicator each)
     AV.termShown / AV.termTop
                   the terminal is open and starts this far down (CSS
                   px): fit the focal object in the space above it
     AV.hitCenterX/Y, AV.hitRadius
                   set by the face each frame (CSS px): the focal object
                   is the tap-to-talk target, the space around it takes
                   swipes (terminal) and multi-taps (hands-free)
     AV.micLevel   0..1 your microphone (only if init({mic:true}), and
                   only while listening; 0 otherwise)
     AV.name       display name from config ("JARVIS" by default)
     AV.label      the dotted chip label ("J.A.R.V.I.S.")
     AV.badge      optional handle from config ("" by default)

   Modes:
     live   served by server.py — rides the real signal bus
     demo   ?demo=1, or the page opened as a plain file — a scripted
            voice-turn loop (idle, listening, thinking, speaking) with
            synthesized audio, so every face performs with no voice
            line installed
     shot   ?shot=<state>&t=ms — pins one state and runs the frame
            loop deterministically, then sets document.title to
            "ready" (screenshot/verification harness)

   The thinking sound: assets/thinking.wav plays while the state is
   "thinking", exactly like a voice line would play it. If the bus
   says the voice line is already playing its own (.voice_loading_pid),
   this player stays quiet — you never hear it twice. The speaker
   button (bottom left) toggles it; browsers may require one click on
   the page before audio is allowed.
   ============================================================ */
"use strict";

const AV = (() => {
  const Q = new URLSearchParams(location.search);
  const SHOT = Q.get("shot");
  const SHOT_T = parseInt(Q.get("t") || "4000", 10);
  const DEMO = Q.get("demo") === "1" || location.protocol === "file:" || !!SHOT;
  // ?display=1&device=<id>: embedded in a native app that does its own
  // audio. Draw only: no socket, no mic, no thinking sound (the app's
  // open mic would hear it); animate for that device's turns; the app
  // sets the mode color through AV.setMode(ptt|listening|paused).
  const DISPLAY = Q.get("display") === "1";

  // where core.js lives -> where assets/ lives (works over http and file://)
  const ROOT = new URL(".", document.currentScript.src);

  const A = {
    state: "idle", level: 0, env: 0, alert: false, micLevel: 0,
    samples: new Float32Array(64),
    name: "JARVIS", label: "J.A.R.V.I.S.", badge: "",
    demo: DEMO, shot: SHOT, faces: [],
    _sndOn: true, _mic: false, _readyCbs: [], _ready: false,
    backendWs: "", recording: false,
  };

  function dotted(name) {
    const up = String(name).toUpperCase();
    if (/^[A-Z0-9]{2,10}$/.test(up)) return up.split("").join(".") + ".";
    return up;
  }

  /* -------------------------------- config -------------------------------- */
  function applyConfig(cfg) {
    if (cfg.name) { A.name = String(cfg.name); A.label = dotted(A.name); }
    A.badge = String(cfg.badge || "");
    if (cfg.thinking_sound === false) A._sndWant = false;
    A.faces = cfg.faces || [];
    A.backendWs = String(cfg.backend_ws || "");
    A.modeHues = cfg.mode_hues || {};
    A.setMode = (m) => viPaintMode(m);
    if (DISPLAY) { A._sndWant = false; VI = { connId: Q.get("device") || null }; }
    else if (A.backendWs && !DEMO) viInit();
    if (!DEMO && (DISPLAY || A.backendWs)) termInit();
    A._ready = true;
    A._readyCbs.forEach(cb => cb(A));
    A._readyCbs = [];
  }

  A.ready = cb => { A._ready ? cb(A) : A._readyCbs.push(cb); };

  /* ------------------------------ bus polling ------------------------------ */
  const TASKS_PREVIEW = (() => {
    const v = new URLSearchParams(location.search).get("tasks");
    return v === null ? null : Math.max(0, parseInt(v, 10) || 0);
  })();
  let raw = { state: "idle", level: 0, samples: null, alert: false,
              loading: false };
  if (!DEMO) {
    setInterval(async () => {
      try {
        // this device's own state if a dedicated session owns it
        const dev = DISPLAY ? (Q.get("device") || "") : DEVICE_ID;
        const r = await fetch("/state?device=" + encodeURIComponent(dev), { cache: "no-store" });
        raw = await r.json();
      } catch (e) { /* server gone: hold last state */ }
    }, 120);
  }

  /* --------------------------------- timers -------------------------------- */
  // Countdowns a session sent this device (<<timers>>, via /state): the
  // next three, soonest first, plus any clock-time line ("eating 7:42 PM").
  // Nothing at all when there are none. Tinted with the mic mode like the
  // terminal.
  let timersEl = null;
  setInterval(() => {
    const list = (raw && raw.timers) || [];
    if (!list.length) {
      if (timersEl) timersEl.style.display = "none";
      document.documentElement.style.setProperty("--av-timers-h", "0px");
      return;
    }
    if (!timersEl) {
      timersEl = document.createElement("div");
      timersEl.style.cssText =
        "position:fixed;top:18px;left:50%;transform:translateX(-50%);z-index:90;" +
        "min-width:220px;pointer-events:none;filter:var(--av-mode-filter,none);" +
        "font:14px/1.6 'SF Mono',Menlo,Consolas,monospace;letter-spacing:.06em;" +
        "color:rgb(150,230,175);text-shadow:0 0 8px rgba(90,200,130,.5)";
      document.body.appendChild(timersEl);
    }
    // the reader card starts below the timers, which sit above its dimming
    document.documentElement.style.setProperty("--av-timers-h", timersEl.offsetHeight + 30 + "px");
    const now = Date.now() / 1000;
    const esc = (t) => String(t).replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
    const row = (label, val, bright) =>
      `<div style="display:flex;justify-content:space-between;gap:24px;opacity:${bright ? 1 : .6}">` +
      `<span>${esc(label).toUpperCase()}</span><span>${val}</span></div>`;
    const down = list.filter(t => !t.clock).sort((x, y) => x.at - y.at).slice(0, 3);
    const clock = list.filter(t => t.clock);
    timersEl.innerHTML =
      down.map((t, i) => {
        const left = Math.max(0, Math.round(t.at - now));
        return row(t.label, left ? `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}` : "NOW", i === 0);
      }).join("") +
      clock.map(t => row(t.label, new Date(t.at * 1000).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }), false)).join("");
    timersEl.style.display = "block";
  }, 250);

  /* ------------------------------ demo driver ------------------------------ */
  // A scripted voice turn: the face performs everything with no voice line.
  const SCRIPT = [["idle", 6000], ["listening", 3500], ["thinking", 4200],
                  ["speaking", 8500]];
  let demoT = 0, demoClock = 0;
  const PIN = SHOT || Q.get("state");   // ?state=speaking pins the demo
  function demoUpdate(dt) {
    demoClock += dt;
    let st = PIN || "idle";
    if (!PIN) {
      demoT = (demoT + dt) % SCRIPT.reduce((a, s) => a + s[1], 0);
      let t = demoT;
      for (const [name, len] of SCRIPT) {
        if (t < len) { st = name; break; }
        t -= len;
      }
    }
    const tt = demoClock / 1000;
    const speaking = st === "speaking";
    const cadence = speaking
      ? Math.max(0, Math.sin(tt * 2.1) * 0.6 + Math.sin(tt * 0.9) * 0.5)
      : 0;
    const samples = new Array(64);
    for (let i = 0; i < 64; i++) {
      // drifting per-sample color so the synthetic voice has a moving
      // spectrum, not a steady tone — spectrum-driven faces dance
      const m = 0.3 + 0.7 * Math.abs(Math.sin(i * 0.23 + tt * 1.7))
        * Math.abs(Math.sin(tt * 2.9 + i * 0.05));
      samples[i] = speaking
        ? (Math.sin(i * 0.55 + tt * 9) * 0.6 + Math.sin(i * 1.7 - tt * 13)
           * 0.4) * 9000 * (0.15 + 0.85 * cadence) * m
        : 0;
    }
    raw = { state: st, level: speaking ? Math.min(1, cadence) : 0,
            samples, alert: false, loading: false };
    if (st === "listening")
      A.micLevel = 0.25 + 0.55 * Math.abs(Math.sin(tt * 2.7))
        * Math.abs(Math.sin(tt * 0.61));
  }

  /* ----------------------- envelope + samples easing ----------------------- */
  let peak = 0.05, sPeak = 200;
  let lastWorking = false;   // see the button visibility note below
  function tick(dt) {
    if (DEMO) demoUpdate(dt);
    A.state = raw.state || "idle";
    // Per-device animation: a turn with a specific asker only animates
    // on that connection (mirrors the audio, which already only plays
    // there); "" means everyone (nobody specific asked, or nothing's
    // in flight). A face still gets to know Jarvis is busy SOMEWHERE
    // via A.busyElsewhere, so a tab that isn't the one talking doesn't
    // have to look flatly idle while he's genuinely working elsewhere.
    // Resolved BEFORE the button-visibility check below, on purpose:
    // that check used to read the pre-gate A.state, so the Interrupt
    // button showed on every tab during someone else's turn too, and a
    // tab that isn't part of a turn has nothing of its own to
    // interrupt.
    A.activeConn = raw.active_conn || "";
    const forThisTab = !A.activeConn || !VI || VI.connId == null
      || String(A.activeConn) === String(VI.connId);
    A.busyElsewhere = !forThisTab
      && (raw.state === "thinking" || raw.state === "speaking");
    if (!forThisTab) A.state = "idle";
    // What a face draws as "listening": this tab recording (a press) or its
    // open mic mid-utterance (hands-free), never the global bus state,
    // which every tab polls. The demo script stands in for both.
    A.listening = !!(A.recording || A.hfCapturing || (DEMO && A.state === "listening"));
    // Not "listening": that's while YOU'RE recording, nothing of
    // Jarvis's own to interrupt yet, and the button popping in the
    // instant you press reads as noise, not a control.
    //
    // While recording, though, trust the LATCHED reading from the
    // instant before you pressed, not the live one: a queued tap
    // doesn't stop the backend's own turn, so its state can flicker
    // against "listening" for the same reason the sonar fix below
    // does (signals.py's self-heal racing _begin_capture's write).
    // Live here would make the button flicker in and out of existence
    // on top of a reply that's still genuinely in flight.
    if (!A.recording)
      lastWorking = A.state === "thinking" || A.state === "speaking";
    if (VI && VI.btn)
      VI.btn.style.display =
        ((A.recording ? lastWorking
                       : A.state === "thinking" || A.state === "speaking")
         || VI.btnPressed || VI.call)
          ? "block" : "none";
    // With the terminal open, the pill sits centered in the gap between
    // the orb and the terminal; closed, 28 px off the bottom. It glides
    // between the two (eased here, the orb eases the same way), so it
    // tucks in toward the orb on the way up and drifts off on the way down.
    if (VI && VI.btn) {
      const h = VI.btn.offsetHeight || 56;
      const gap = A.termGap();
      const target = gap ? gap - h / 2 : innerHeight - 28 - h;
      VI.btnTop = VI.btnTop == null ? target
        : VI.btnTop + (target - VI.btnTop) * Math.min(1, .12 * dt / 16.667);
      VI.btn.style.top = VI.btnTop + "px";
      VI.btn.style.bottom = "auto";
    }
    A.alert = !!raw.alert;
    // Running background tasks (satellites). ?tasks=N in the URL forces a
    // count, to preview the look before the voice line publishes one.
    A.tasks = TASKS_PREVIEW !== null ? TASKS_PREVIEW : Math.max(0, raw.tasks | 0);
    // Empty unless the voice line was told to publish usage. A face that
    // wants to draw it reads AV.rateLimits; every other face ignores it.
    A.rateLimits = raw.rate_limits || {};

    // Gate on A.recording, not the backend state: a queued tap doesn't
    // stop the backend's own turn (it's still genuinely speaking, state
    // and all, see signals.py's self-heal), so riding A.state here would
    // just inherit that race as visible flicker. A.recording is set
    // synchronously client-side the instant you press, with nothing to
    // race against, and it's what actually answers "should the reply
    // visuals hold still right now" — the playback clock is frozen for
    // exactly the same span (see viPress).
    if (!A.recording) {
      // Same per-device gate as A.state above: a turn that isn't for
      // this tab must look silent here too, not just report "idle",
      // otherwise the envelope and waveform ring keep tracking the
      // OTHER tab's real audio regardless, and the blob still visibly
      // pulses in lockstep with a reply this tab never asked for.
      A.level = forThisTab ? (raw.level || 0) : 0;

      // adaptive envelope: normalize against a decaying peak, then ease
      // (attack 50ms, release 350ms) — motion code rides AV.env
      const dts = dt / 1000;
      peak = Math.max(A.level, 0.05, peak - 0.5 * peak * dts);
      const target = Math.min(1, A.level / peak);
      const tau = target > A.env ? 50 : 350;
      A.env += (target - A.env) * Math.min(1, dt / tau);

      // waveform ring: rectify, normalize against its own decaying peak,
      // blend toward the newest frame so the ring flows instead of flickers
      const s = forThisTab ? raw.samples : null;
      A.rawSamples = s && s.length ? s : null;   // signed, int16-scale floats
      if (s && s.length) {
        let mx = 0;
        for (let i = 0; i < s.length; i++) mx = Math.max(mx, Math.abs(s[i]));
        sPeak = Math.max(mx, 200, sPeak * 0.98);
        const n = s.length;
        for (let i = 0; i < 64; i++) {
          const v = Math.abs(s[Math.min(n - 1, Math.round(i * (n - 1) / 63))])
            / sPeak;
          A.samples[i] = A.samples[i] * 0.45 + Math.min(1, v) * 0.55;
        }
      } else {
        for (let i = 0; i < 64; i++) A.samples[i] *= Math.max(0, 1 - dts * 6);
      }
      if (A.state !== "speaking" && !DEMO)
        for (let i = 0; i < 64; i++) A.samples[i] *= Math.max(0, 1 - dts * 6);
    }

    if (A._mic && A._micAnalyser) micRead();
    soundUpdate();
  }

  /* --------------------------------- mic ---------------------------------- */
  let micPeak = 0.02;
  function micRead() {
    const an = A._micAnalyser;
    const buf = A._micBuf;
    an.getFloatTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
    const rms = Math.sqrt(sum / buf.length);
    micPeak = Math.max(rms, 0.02, micPeak * 0.999);
    A.micLevel = Math.min(1, rms / micPeak);
  }
  // Raw mic: the browser's default voice processing (echo cancellation,
  // noise suppression, auto gain) gated the speech into dropouts, worst
  // with other tabs or speakers playing audio (saved clips measured 43-52%
  // near-silence inside speech). Push-to-talk already pauses Jarvis's own
  // playback while recording, so echo cancellation buys nothing here.
  // (Live intercom will want it back, on its own stream.)
  const MIC_RAW = { audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } };
  // Hands-free is a live stream of that same raw mic (the voice line's
  // "listen" frame turns it on). Echo cancellation was tried and
  // dropped: it didn't keep this page's own playback out of the mic
  // (the tab goes deaf while playing instead, see the capture), and on
  // the Pi the processed audio transcribed noticeably worse.
  const MIC_HF = MIC_RAW;

  /* ------------------------------ voice input ------------------------------
     Tap/click the face to talk: a second push-to-talk, the pointer in
     place of a key. Only active when the config names a `backend_ws`
     (backtalk's browser bridge); off by default. One persistent socket,
     opened at startup so the first tap isn't paying handshake latency.
     Mic capture opens only while listening (a press, hands-free, a
     call) and is fully released after; a face's mic:true meter reads
     that same capture stream, so no face holds the mic at idle.

     Tap anywhere on the face = talk, in every state — while idle it's
     the only turn, while Jarvis is working it QUEUES behind the
     current one (the backend's turn-stream reader lines it up; nothing
     here stops anything). The one Interrupt button (shown only while
     working) is the sole way to actually stop a reply: it sends
     interrupt_press instead of press, and a "stop" control frame back
     from the server clears whatever audio is already scheduled here. */
  // This tab's own identity for per-device audio/animation routing
  // (compared against AV.activeConn). Generated once and kept in
  // sessionStorage so it survives reloads and reconnects (a server-
  // assigned id resets on every reconnect, silently reassigning the
  // tab mid-session). Not localStorage: that's shared by every tab of
  // the same origin, so two tabs would read the SAME id and collide.
  // Caveat: browsers copy sessionStorage into a DUPLICATED tab, so a
  // duplicate shares its original's id; open a fresh tab instead.
  const DEVICE_ID = (() => {
    try {
      let id = sessionStorage.getItem("av_device_id");
      if (!id) { id = crypto.randomUUID(); sessionStorage.setItem("av_device_id", id); }
      return id;
    } catch (e) { return crypto.randomUUID(); }
  })();
  let VI = null;   // { ws, capCtx, proc, mute, playCtx, nextPlayTime, sources, btn }
  function viConnect() {
    if (VI && VI.ws && VI.ws.readyState <= 1) return;
    try {
      const ws = new WebSocket(A.backendWs);
      ws.binaryType = "arraybuffer";
      ws.onopen = () => ws.send(JSON.stringify({ type: "hello", device_id: DEVICE_ID }));
      ws.onmessage = viOnMessage;
      ws.onclose = () => setTimeout(viConnect, 1500);
      ws.onerror = () => {};
      VI = VI || {};
      VI.ws = ws;
      VI.connId = DEVICE_ID;
    } catch (e) { /* bad backend_ws URL: voice input just stays off */ }
  }
  function viPlayCtx() {
    if (!VI.playCtx) {
      VI.playCtx = new AudioContext(); VI.nextPlayTime = 0;
      // A page may not make sound until it has been clicked once (after
      // a reload, hands-free has no press to count). Show why, and let
      // ANY click anywhere unlock it.
      const note = document.createElement("div");
      note.textContent = "CLICK ANYWHERE TO ENABLE SOUND";
      note.style.cssText =
        "position:fixed;left:50%;top:18px;transform:translateX(-50%);z-index:70;" +
        "display:none;padding:8px 16px;border-radius:20px;pointer-events:none;" +
        "font:12px 'SF Mono',Menlo,Consolas,monospace;letter-spacing:.15em;" +
        "color:rgba(235,245,235,.85);background:rgba(40,60,45,.6)";
      document.body.appendChild(note);
      const show = () => { note.style.display =
        VI.playCtx.state === "running" || VI.pausedForQueue ? "none" : "block"; };
      VI.playCtx.onstatechange = show;
      addEventListener("pointerdown", () => {
        if (VI.playCtx.state !== "running" && !VI.pausedForQueue)
          VI.playCtx.resume().catch(() => {});
      }, true);
      setTimeout(show, 500);
    }
    return VI.playCtx;
  }
  function viOnMessage(ev) {
    if (typeof ev.data === "string") {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === "stop") viStopPlayback();
        // hands-free: the voice line is capturing an utterance from this
        // tab's open mic (the listening rings show, as for a press)
        else if (msg.type === "capturing") A.hfCapturing = !!msg.on;
        // a tap's speech ended (or never came): the server's second tap
        else if (msg.type === "endpoint") { if (VI.latched) viRelease(); }
        else if (msg.type === "line") A.termLine(msg.who, msg.text, msg.show);
        else if (msg.type === "call") viCall(msg);
        else if (msg.type === "show") msg.close ? A.showDoc(null) : A.showDoc(msg.title, msg.markdown);
        else if (msg.type === "lines") A.termLines(msg.lines);
        else if (msg.type === "listen") {
          VI.hfMuted = !!msg.muted;
          viListen(!!msg.on);
          viPaintMode(msg.on ? (msg.muted ? "paused" : "listening") : "ptt");
        }
      } catch (e) { /* ignore */ }
      return;
    }
    const buf = ev.data;
    if (buf.byteLength < 4) return;
    const rate = new DataView(buf).getUint32(0, true);
    const i16 = new Int16Array(buf.slice(4));
    const ctx = viPlayCtx();
    // A tab the browser paused (screen locked, backgrounded, reconnected
    // without a tap) would play every reply into silence. Allowed
    // without a fresh gesture once the page has had one. Never during a
    // queued press, though: that pause is deliberate, and the release
    // resumes it, with everything that arrived meanwhile still queued.
    if (ctx.state !== "running" && !VI.pausedForQueue) ctx.resume().catch(() => {});
    const abuf = ctx.createBuffer(1, i16.length, rate);
    const chan = abuf.getChannelData(0);
    let sq = 0;
    for (let i = 0; i < i16.length; i++) { chan[i] = i16[i] / 32768; sq += i16[i] * i16[i]; }
    const src = ctx.createBufferSource();
    src.buffer = abuf;
    src.connect(ctx.destination);
    const now = ctx.currentTime;
    if (VI.nextPlayTime < now + 0.02) VI.nextPlayTime = now + 0.05;
    src.start(VI.nextPlayTime);
    VI.nextPlayTime += abuf.duration;
    // On a call the far end streams nonstop, so this tab goes deaf only
    // while it actually plays a voice (the browser's echo cancellation
    // can't hear this page's own playback): speakers take turns.
    if (VI.call && Math.sqrt(sq / i16.length) > 500) VI.loudUntil = VI.nextPlayTime + 0.3;
    VI.sources = VI.sources || [];
    VI.sources.push(src);
    src.onended = () => {
      const i = VI.sources.indexOf(src);
      if (i >= 0) VI.sources.splice(i, 1);
    };
  }
  function viStopPlayback() {
    // An interrupt: every chunk already sent but not yet played gets
    // discarded, mirroring mouth.shut_up() on the server side.
    (VI.sources || []).forEach(src => { try { src.stop(); } catch (e) {} });
    VI.sources = [];
    if (VI.playCtx) VI.nextPlayTime = VI.playCtx.currentTime;
  }
  // One open at a time: a press and a hands-free "listen" racing each
  // other would otherwise each open a stream, and one would never close.
  function viEnsureCapture() {
    if (VI.proc) return Promise.resolve(true);
    return VI.capP || (VI.capP = viOpenCapture().finally(() => { VI.capP = null; }));
  }
  async function viOpenCapture() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia(VI.hf ? MIC_HF : MIC_RAW);
      const ctx = new AudioContext({ sampleRate: 16000 });
      // Hands-free can start with no gesture on this page (a reload
      // that comes back listening): resume on the first one.
      if (ctx.state === "suspended") {
        ctx.resume().catch(() => {});
        addEventListener("pointerdown", () => ctx.resume().catch(() => {}), { once: true });
      }
      const src = ctx.createMediaStreamSource(stream);
      // deprecated but universal; AudioWorkletNode is the future upgrade
      const proc = ctx.createScriptProcessor(4096, 1, 1);
      proc.onaudioprocess = (e) => {
        if (!(A.recording || VI.hf || VI.call) || !VI.ws || VI.ws.readyState !== 1) return;
        // On a call: deaf only while the far end's voice plays (viOnMessage).
        if (VI.call) { if (VI.playCtx && VI.playCtx.currentTime < (VI.loudUntil || 0)) return; }
        // Hands-free goes deaf while this tab plays anything of its own:
        // the reply (plus a short tail) and the thinking sound. This is
        // the ONLY hands-free gate; the voice line doesn't care whose
        // turn it is. The open mic heard both and Whisper turned them
        // into words ("1, 2, 3... 9, 9, 9" from the thinking sound).
        else if (!A.recording && ((audio && !audio.paused) || (VI.playCtx
            && VI.nextPlayTime > VI.playCtx.currentTime - 0.3))) return;
        const input = e.inputBuffer.getChannelData(0);
        const i16 = new Int16Array(input.length);
        // the tap beep goes out as silence (MIC_RAW has no echo cancellation)
        if (performance.now() >= (VI.quietUntil || 0))
        for (let i = 0; i < input.length; i++) {
          const s = Math.max(-1, Math.min(1, input[i]));
          i16[i] = s < 0 ? s * 32768 : s * 32767;
        }
        const frame = new Uint8Array(4 + i16.byteLength);
        new DataView(frame.buffer).setUint32(0, ctx.sampleRate, true);
        frame.set(new Uint8Array(i16.buffer), 4);
        VI.ws.send(frame.buffer);
      };
      // ScriptProcessorNode only fires once connected; a muted gain
      // keeps your own mic from coming back out of your own speakers.
      const mute = ctx.createGain();
      mute.gain.value = 0;
      src.connect(proc);
      // a mic:true face's meter (AV.micLevel) taps the same capture
      if (A._mic) {
        const an = ctx.createAnalyser();
        an.fftSize = 512;
        src.connect(an);
        A._micAnalyser = an;
        A._micBuf = new Float32Array(an.fftSize);
      }
      proc.connect(mute);
      mute.connect(ctx.destination);
      VI.capCtx = ctx; VI.proc = proc; VI.mute = mute;
      VI.capStream = stream;
      return true;
    } catch (e) { return false; }
  }
  // Hold the mic ONLY while pressed. A tab that kept its capture open
  // after its first press held the mic forever, and with two tabs holding
  // it the recording dropped out constantly (gone the moment the second
  // tab closed). Released on every key-up; reopened on the next press.
  function viReleaseCapture() {
    if (!VI || !VI.proc || VI.hf) return;   // hands-free keeps it
    try { VI.proc.onaudioprocess = null; VI.proc.disconnect(); } catch (e) {}
    try { VI.mute.disconnect(); } catch (e) {}
    try { VI.capCtx.close(); } catch (e) {}
    if (VI.capStream) VI.capStream.getTracks().forEach(t => t.stop());
    VI.proc = VI.capCtx = VI.mute = VI.capStream = A._micAnalyser = null;
    A.micLevel = 0;
  }
  // An intercom call: the mic streams (as for hands-free) until it ends,
  // and the Interrupt pill becomes HANG UP.
  function viCall(msg) {
    if (msg.on && !VI.call) { VI.hfBeforeCall = VI.hf; if (!VI.hf) viListen(true); }
    if (!msg.on && VI.call && !VI.hfBeforeCall) viListen(false);
    VI.call = msg.on ? (msg.with || "?") : null;
    if (VI.btn) VI.btn.textContent = VI.call ? "HANG UP" : "INTERRUPT";
  }
  function viPaintMode(mode) {
    const stage = document.getElementById("stage");
    const deg = Number(A.modeHues[mode]) || 0;
    if (stage) stage.style.filter = deg ? `hue-rotate(${deg}deg)` : "";
    // the terminal lives outside #stage; it reads this to shift with it
    document.documentElement.style.setProperty("--av-mode-filter", deg ? `hue-rotate(${deg}deg)` : "none");
  }
  async function viListen(on) {
    if (on === !!VI.hf) return;
    if (!on) { VI.hf = false; if (!A.recording) viReleaseCapture(); return; }
    viReleaseCapture();   // a raw push-to-talk capture, if one is open
    VI.hf = true;
    if (!(await viEnsureCapture())) VI.hf = false;
    // hands-free went off while the mic was still opening
    else if (!VI.hf && !VI.held) viReleaseCapture();
  }
  function viPress(isInterrupt) {
    if (!VI || !VI.ws || VI.ws.readyState !== 1) return;
    // Create/resume the playback context HERE, synchronously inside
    // the user gesture. Left to happen later (e.g. the first time a
    // reply chunk actually arrives, well outside any gesture) it hits
    // autoplay policy: the context stays suspended, every part of the
    // pipeline runs without error, and no sound ever comes out.
    const pctx = viPlayCtx();
    if (pctx.state === "suspended") pctx.resume().catch(() => {});
    if (isInterrupt) {
      // The Interrupt button must land as fast as a key press: stop
      // the reply FIRST, never gated on mic capture (which can take a
      // moment on first use, or fail outright). A quick tap-release
      // with nothing recorded still stops Jarvis; it just never sends
      // a question behind it.
      VI.pressActive = true;
      VI.ws.send(JSON.stringify({ type: "interrupt_press" }));
    }
    VI.held = true;   // the finger is down; cleared on release
    viEnsureCapture().then(ok => {
      if (!ok || !VI || !VI.ws || VI.ws.readyState !== 1) return;
      // Released before the mic finished opening (a quick tap): drop the
      // mic again rather than start a recording nobody will ever release.
      if (!VI.held) { viReleaseCapture(); return; }
      A.recording = true;
      if (isInterrupt) return;
      VI.pressActive = true;
      // A queued tap (not the Interrupt button) pauses playback rather
      // than touching it: the AudioContext clock freezes, so whatever
      // was scheduled just picks back up exactly where it left off on
      // release, nothing lost, nothing restarted.
      if (VI.playCtx && VI.playCtx.state === "running") {
        VI.playCtx.suspend().catch(() => {});
        VI.pausedForQueue = true;
      }
      VI.ws.send(JSON.stringify({ type: "press" }));
      if (VI.latched) VI.ws.send(JSON.stringify({ type: "latch" }));
    });
  }
  // A tapped press is listening: one short soft tone. ponytail: whole
  // 256 ms capture blocks go silent for 450 ms (beep plus a block), so a
  // word started within ~0.3 s of the beep can lose its onset; an
  // AudioWorklet with per-sample timing is the upgrade.
  function viBeep() {
    VI.quietUntil = performance.now() + 450;
    try {
      const ctx = new AudioContext(), o = ctx.createOscillator(), g = ctx.createGain(), t = ctx.currentTime;
      o.frequency.value = 660;
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.2, t + 0.02);
      g.gain.linearRampToValueAtTime(0, t + 0.12);
      o.connect(g); g.connect(ctx.destination);
      o.onended = () => ctx.close();
      o.start(t); o.stop(t + 0.13);
    } catch (e) {}
  }
  function viRelease() {
    const wasHeld = !!(VI && VI.held);
    if (VI) { VI.held = VI.latched = false; clearTimeout(VI.latchT); }
    // After "stop listening", ANY click on the orb brings hands-free
    // back, even a tap too quick to open the mic. Sent on release, so
    // a held press is still an ordinary push-to-talk turn first; and
    // only after a real press (pointerleave also lands here).
    const unmute = wasHeld && VI.hfMuted && VI.ws && VI.ws.readyState === 1;
    if (unmute) VI.hfMuted = false;
    try {
      // Gated on pressActive, not A.recording: an Interrupt tap sends
      // its control message immediately, before capture even resolves,
      // so a release arriving before that promise settles still has to
      // reach the server; waiting on A.recording would strand it there
      // mid-press instead.
      if (!VI || !VI.pressActive) return;
      VI.pressActive = false;
      A.recording = false;
      if (VI.pausedForQueue) {
        VI.pausedForQueue = false;
        if (VI.playCtx) VI.playCtx.resume().catch(() => {});
      }
      if (VI.ws && VI.ws.readyState === 1)
        VI.ws.send(JSON.stringify({ type: "release" }));
      viReleaseCapture();
    } finally {
      if (unmute) VI.ws.send(JSON.stringify({ type: "unmute" }));
    }
  }
  function viInit() {
    viConnect();
    VI = VI || {};
    viPlayCtx();
    const stage = document.getElementById("stage");
    if (!stage) return;
    // The faces hide the cursor (cursor:none in their own CSS) for a
    // clean look on a passive display. Tapping the face is a real
    // control now, so a MOUSE needs the cursor visible to aim with —
    // but only while actually moving, so the clean look returns once
    // it's been idle a bit. A touchscreen has no cursor to manage;
    // (pointer: coarse) is the PRIMARY input, so a touchscreen stays
    // cursor:none exactly as the CSS already has it.
    if (!matchMedia("(pointer: coarse)").matches) {
      let cursorHideT = null;
      const cursorShow = () => {
        document.body.style.cursor = "default";
        clearTimeout(cursorHideT);
        cursorHideT = setTimeout(() => {
          document.body.style.cursor = "none";
        }, 1500);
      };
      addEventListener("mousemove", cursorShow);
      cursorShow();
    }
    stage.style.touchAction = "none";
    // a forgotten tap sends after 120 s, backtalk's hands_free_timeout_s
    const TAP_MS = 350, LATCH_MAX_MS = 120000;
    let orbDownAt = 0;   // timeStamp of the orb press in progress
    stage.addEventListener("pointerdown", (e) => {
      // A face may narrow this to its own visible shape (e.g. the
      // bioradial swarm) by setting A.hitCenterX/Y and A.hitRadius
      // each frame; a face that never sets them keeps today's
      // whole-stage behavior.
      if (A.hitRadius != null) {
        const dx = e.clientX - A.hitCenterX, dy = e.clientY - A.hitCenterY;
        if (dx * dx + dy * dy > A.hitRadius * A.hitRadius) {
          tapDownAt = e.timeStamp;
          // held half a second in hands-free: paused while held
          clearTimeout(muteT);
          muteT = setTimeout(() => {
            if (VI && VI.hf && !VI.hfMuted && VI.ws && VI.ws.readyState === 1) {
              muteHeld = true;
              VI.ws.send(JSON.stringify({ type: "hands_free", on: true, muted: true }));
            }
          }, 500);
          return;
        }
      }
      e.preventDefault();
      // Tap to talk (it sends itself when you stop talking), or tap again to send; a hold
      // still ends on release. The second tap sends on touch-down.
      if (VI && VI.latched) { orbDownAt = 0; viRelease(); return; }
      orbDownAt = e.timeStamp; viPress(false);
    });
    ["pointerup", "pointercancel", "pointerleave"].forEach(evt =>
      stage.addEventListener(evt, (e) => {
        if (!orbDownAt) return;   // not an orb press, or already latched
        const tap = e.type === "pointerup" && e.timeStamp - orbDownAt < TAP_MS;
        orbDownAt = 0;
        // A tap latches (the listening rings stay up); while paused a
        // tap still just resumes, so it releases as before.
        if (!tap || !VI || !VI.held || VI.hfMuted) return viRelease();
        VI.latched = true;
        clearTimeout(VI.latchT);
        VI.latchT = setTimeout(() => { if (VI.latched) viRelease(); }, LATCH_MAX_MS);
        // the voice line ends it on silence after speech (or drops it if
        // nothing's said in 5 s) and says "endpoint"; a tap still sends
        if (VI.pressActive && VI.ws && VI.ws.readyState === 1)
          VI.ws.send(JSON.stringify({ type: "latch" }));
        viBeep();
      }));
    // Clicks on the blank space around the orb, counted until they stop
    // (same as the phone app's taps), all silent, the color answers:
    // triple = hands-free on/off, double while hands-free = pause/resume,
    // and holding it in hands-free pauses until you let go.
    let tapDownAt = 0, taps = 0, tapT = null, muteT = null, muteHeld = false;
    const endMute = () => {
      clearTimeout(muteT);
      if (!muteHeld) return false;
      muteHeld = false;
      if (VI.ws && VI.ws.readyState === 1)
        VI.ws.send(JSON.stringify({ type: "hands_free", on: true, muted: false }));
      return true;
    };
    ["pointercancel", "pointerleave"].forEach(evt => stage.addEventListener(evt, endMute));
    let swipeY0 = null;
    stage.addEventListener("pointerdown", (e) => {
      swipeY0 = e.clientY;
      // keep the drag: a swipe down ends over the terminal, which would
      // otherwise swallow the release
      try { stage.setPointerCapture(e.pointerId); } catch (err) {}
    }, true);
    stage.addEventListener("pointermove", (e) => {
      // a drag is a swipe, never a hold-to-pause
      if (swipeY0 != null && Math.abs(e.clientY - swipeY0) > 30) clearTimeout(muteT);
    });
    stage.addEventListener("pointerup", (e) => {
      const y0 = swipeY0; swipeY0 = null;
      if (y0 != null && tapDownAt && !muteHeld && A.termSwipe(y0, e.clientY)) { tapDownAt = 0; return; }
      if (endMute()) { tapDownAt = 0; return; }
      if (!tapDownAt || e.timeStamp - tapDownAt > 300) { tapDownAt = 0; return; }
      tapDownAt = 0; taps++;
      clearTimeout(tapT);
      tapT = setTimeout(() => {
        const n = taps; taps = 0;
        const on = !!(VI && VI.hf) || !!(VI && VI.hfMuted);
        const set = (o, m) => VI.ws && VI.ws.readyState === 1 &&
          VI.ws.send(JSON.stringify({ type: "hands_free", on: o, muted: m }));
        if (n >= 3) set(!on, false);
        else if (n === 2 && on) set(true, !VI.hfMuted);
      }, 350);
    });

    // ONE Interrupt button, shown only while Jarvis is working (tick()
    // toggles it via A.state). It's a separate element appended to
    // <body>, not a child of #stage, so its taps never reach the
    // stage's tap-anywhere-queues handler above — no event plumbing
    // needed to keep them apart, they're just not in the same subtree.
    const btn = document.createElement("div");
    btn.id = "av-int";
    btn.textContent = "INTERRUPT";
    btn.style.cssText =
      "position:fixed;left:50%;bottom:28px;transform:translateX(-50%);" +
      "z-index:60;display:none;padding:18px 36px;border-radius:40px;" +
      "font:bold 15px 'SF Mono',Menlo,Consolas,monospace;" +
      "letter-spacing:.15em;color:rgba(255,235,235,.92);" +
      "background:rgba(200,30,30,.38);" +
      "-webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px);" +
      "border:1px solid rgba(255,140,140,.45);cursor:pointer;" +
      "touch-action:none;user-select:none;" +
      "box-shadow:0 0 18px rgba(220,40,40,.35),inset 0 0 12px rgba(255,90,90,.18)";
    btn.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (VI.call) { VI.ws.send(JSON.stringify({ type: "hangup" })); return; }
      VI.btnPressed = true;   // held through the state flip to "listening"
      viPress(true);
    });
    ["pointerup", "pointercancel", "pointerleave"].forEach(evt =>
      btn.addEventListener(evt, (e) => {
        e.stopPropagation();
        if (!VI.btnPressed) return;     // a HANG UP tap, or a leave without a press
        VI.btnPressed = false;
        viRelease();
      }));
    document.body.appendChild(btn);
    VI = VI || {};   // viConnect() may not have run if backendWs was bad
    VI.btn = btn;
  }

  /* -------------------------------- terminal ------------------------------- */
  // The conversation as text along the bottom, fading out toward the top,
  // scrollable, with a box to type to the agent. Hidden until you swipe
  // up from the blank space below the orb (AV.termShow(true)); a swipe
  // down from above the orb hides it again. Only where the screen is at
  // least 600 CSS px tall in its current orientation (phones upright, the
  // Fold's inner screen either way, desktops; not the Echo Show or a phone
  // on its side). Uses the screen, not the window, so a phone keyboard
  // opening doesn't hide it mid-typing. Lines arrive as "line" frames for
  // this device's turns. Embedded in the app (display mode) the app owns
  // the socket and the touches: it calls AV.termLine(who, text) /
  // AV.termLines([...]) / AV.termShow(on), and typed text goes to
  // window.JarvisApp.send. A.termTop is where it starts (CSS px from the
  // top; the window's height when hidden), for a face to fit its orb above.
  let term = null, termOpen = false, termFit = () => {};
  A.termTop = innerHeight;
  A.termShow = (on) => { termOpen = !!on; termFit(); };
  // The middle of the gap between the orb and the terminal's top edge
  // (CSS px from the top), or 0 when it's hidden; the Interrupt pill's spot.
  A.termGap = () => !A.termShown || A.hitRadius == null ? 0
    : (A.hitCenterY + A.hitRadius * 1.25 + A.termTop) / 2;
  // A swipe on the blank space around the orb (callers check it started
  // off the orb): up opens the terminal, down closes it. True when it was
  // one (not a tap). Requiring "below" / "above" the orb was too fussy: on
  // a wide window the strip above the orb is thin.
  A.termSwipe = (y0, y1) => {
    if (Math.abs(y1 - y0) < 60) return false;
    A.termShow(y1 < y0);
    return true;
  };
  function termClear() { if (term) term.log.textContent = ""; }
  A.termLines = (lines) => { termClear(); (lines || []).forEach(l => A.termLine(l.who, l.text, l.show)); };
  // show: {title, path} from a <<show>>, a button that reopens that card
  // with the file's current contents (the app relays it, else the socket)
  A.reopenDoc = (path) => {
    const m = { type: "reopen", path };
    if (window.JarvisApp && window.JarvisApp.reopen) window.JarvisApp.reopen(path);
    else if (VI && VI.ws && VI.ws.readyState === 1) VI.ws.send(JSON.stringify(m));
  };
  A.termLine = (who, text, show) => {
    if (!term) return;
    const log = term.log;
    const atEnd = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
    // consecutive lines from the same speaker join one entry
    let last = log.lastElementChild;
    if (!last || last.dataset.who !== who) {
      last = document.createElement("div");
      last.dataset.who = who;
      last.className = "av-t-" + (who === "you" ? "you" : "ai");
      const tag = document.createElement("span");
      tag.className = "av-t-tag";
      tag.textContent = who === "you" ? "> " : A.name.toLowerCase() + ": ";
      last.appendChild(tag);
      last.appendChild(document.createElement("span"));
      log.appendChild(last);
    }
    const body = last.lastElementChild;
    if (text) body.innerHTML += (body.innerHTML ? " " : "") + linkify(mdInline(esc(text)));
    if (show && show.path) {
      const b = document.createElement("button");
      b.type = "button"; b.className = "av-t-open";
      b.textContent = "Open " + (show.title || "card");
      b.dataset.path = show.path;     // a data attribute: later text rewrites innerHTML
      body.appendChild(b);
      log.onclick = (e) => { const o = e.target.closest(".av-t-open"); if (o) A.reopenDoc(o.dataset.path); };
    }
    while (log.childElementCount > 120) log.firstElementChild.remove();
    if (atEnd) log.scrollTop = log.scrollHeight;
  };
  /* ------------------------------ a little Markdown ----------------------------- */
  // Enough for replies and notes: headings, lists, bold, italics, inline
  // code, rules. Text is escaped first, so a note can never inject markup.
  const esc = (t) => String(t).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const mdInline = (t) => t
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
    .replace(/(^|[\s(])[*_]([^*_\s][^*_]*)[*_](?=[\s).,;:!?]|$)/g, "$1<i>$2</i>")
    .replace(/\[\[([^\]|]+)(\|([^\]]+))?\]\]/g, (m, a, b, c) => c || a);
  // http(s) URLs in already-escaped HTML become links. A URL stops at
  // markup or an escaped quote/bracket, and sheds trailing punctuation and
  // an unmatched ")" so "see https://x.com/a." links the right thing.
  const linkify = (h) => h.replace(/https?:\/\/(?:(?!&(?:lt|gt|quot);)[^\s<>"'`])+/g, (u) => {
    let tail = "";
    for (;;) {
      const m = u.match(/[.,;:!?]+$/);
      if (m) { tail = m[0] + tail; u = u.slice(0, -m[0].length); continue; }
      if (u.endsWith(")") && u.split("(").length < u.split(")").length) { tail = ")" + tail; u = u.slice(0, -1); continue; }
      break;
    }
    return `<a href="${u}" target="_blank" rel="noopener noreferrer">${u}</a>${tail}`;
  });
  function mdBlock(md) {
    const out = []; let list = null;
    const close = () => { if (list) { out.push(`</${list}>`); list = null; } };
    for (const raw of String(md).split("\n")) {
      const line = raw.trimEnd(), t = esc(line.trim());
      let m;
      if (!t) { close(); continue; }
      if ((m = t.match(/^(#{1,4})\s+(.*)/))) { close(); out.push(`<h${m[1].length + 1}>${mdInline(m[2])}</h${m[1].length + 1}>`); }
      else if (/^(-{3,}|\*{3,})$/.test(t)) { close(); out.push("<hr>"); }
      else if ((m = t.match(/^[-*]\s+(\[[ x]\]\s+)?(.*)/))) { if (list !== "ul") { close(); out.push("<ul>"); list = "ul"; } out.push(`<li>${mdInline(m[2])}</li>`); }
      else if ((m = t.match(/^\d+[.)]\s+(.*)/))) { if (list !== "ol") { close(); out.push("<ol>"); list = "ol"; } out.push(`<li>${mdInline(m[1])}</li>`); }
      else { close(); out.push(`<p>${mdInline(t)}</p>`); }
    }
    close();
    return out.join("");
  }

  /* ------------------------------ full-screen reader ----------------------------- */
  // A recipe or a list, whole: a card over the dimmed face, below any
  // timers, scrolled by dragging, closed by a double-tap anywhere on it, a
  // tap outside it, the close mark, Escape, or "close that" (the voice
  // line's {"type": "show", "close": true}). Tinted with the mode.
  let reader = null;
  A.showDoc = (title, md) => {
    if (reader) { reader.remove(); reader = null; }
    A.readerOpen = title != null;     // the app lets touches through while it's up
    if (title == null) return;
    reader = document.createElement("div");
    reader.style.cssText =
      "position:fixed;inset:0;z-index:80;background:rgba(0,6,3,.72);display:flex;" +
      "align-items:center;justify-content:center;filter:var(--av-mode-filter,none);" +
      "box-sizing:border-box;padding-top:var(--av-timers-h,0px)";
    reader.innerHTML =
      '<div class="av-doc" style="position:relative;width:min(760px,92vw);max-height:calc(88vh - var(--av-timers-h,0px));overflow-y:auto;touch-action:pan-y;' +
      "padding:28px 30px 34px;border:1px solid rgba(90,200,130,.45);border-radius:10px;" +
      "background:rgba(6,20,12,.94);color:rgb(200,240,212);font:16px/1.6 'SF Mono',Menlo,Consolas,monospace;" +
      'box-shadow:0 0 40px rgba(60,200,120,.18)">' +
      '<div class="av-x" style="position:absolute;top:10px;right:16px;cursor:pointer;font-size:22px;color:rgb(120,210,150)">&times;</div>' +
      `<h1>${esc(title)}</h1>${mdBlock(md)}</div>`;
    const css = document.getElementById("av-doc-css") || document.head.appendChild(Object.assign(
      document.createElement("style"), { id: "av-doc-css", textContent:
        ".av-doc h1{font-size:1.35em;margin:0 0 .6em;color:rgb(150,240,180)}" +
        ".av-doc h2,.av-doc h3,.av-doc h4,.av-doc h5{margin:1.1em 0 .4em;color:rgb(140,225,170)}" +
        ".av-doc ul,.av-doc ol{margin:.3em 0 .8em;padding-left:1.4em}.av-doc li{margin:.25em 0}" +
        ".av-doc p{margin:.5em 0}.av-doc code{background:rgba(90,200,130,.12);padding:0 .3em;border-radius:3px}" +
        ".av-doc hr{border:0;border-top:1px solid rgba(90,200,130,.3);margin:1em 0}" }));
    void css;
    let down = null, lastTap = 0;
    reader.addEventListener("pointerdown", (e) => {
      e.stopPropagation();
      down = [e.clientX, e.clientY];
      if (e.target === reader || e.target.classList.contains("av-x")) A.showDoc(null);
    });
    reader.addEventListener("pointerup", (e) => {   // a double-tap (not a scroll drag) closes it
      e.stopPropagation();
      if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 12) { lastTap = 0; return; }
      if (e.timeStamp - lastTap < 350) A.showDoc(null); else lastTap = e.timeStamp;
    });
    reader.addEventListener("pointercancel", () => { lastTap = 0; });   // the browser took it as a scroll
    reader.addEventListener("keydown", e => e.stopPropagation());
    document.body.appendChild(reader);
  };
  addEventListener("keydown", (e) => { if (e.key === "Escape" && reader) A.showDoc(null); });

  function termInit() {
    const css = document.createElement("style");
    css.textContent =
      "#av-term{position:fixed;left:0;right:0;bottom:0;height:44vh;z-index:55;display:flex;" +
      // revealed by a wipe upward, and wiped back down when closed
      "opacity:0;visibility:hidden;clip-path:inset(100% 0 0 0);" +
      "transition:opacity .45s,visibility .45s,clip-path .45s cubic-bezier(.2,.7,.2,1);" +
      "flex-direction:column;margin:0 max(12px,3vw);padding:0 12px 10px;" +
      // a TUI frame: side rules and bottom corners, fading out with the
      // text toward the top
      "border:1px solid rgba(90,200,130,.45);border-top:0;border-radius:0 0 6px 6px;" +
      "box-shadow:inset 0 -18px 30px -24px rgba(90,200,130,.35);" +
      "-webkit-mask-image:linear-gradient(to bottom,transparent 0,#000 55%);" +
      "mask-image:linear-gradient(to bottom,transparent 0,#000 55%);" +
      "font:13px/1.5 'SF Mono',Menlo,Consolas,monospace;color:rgb(150,230,175);cursor:auto;" +
      "filter:var(--av-mode-filter,none)}" +
      "html.av-term-on #av-term{opacity:1;visibility:visible;clip-path:inset(0 0 0 0)}" +
      // the top padding lets the oldest line scroll down out of the fade
      "#av-term .av-t-log{flex:1;overflow-y:auto;padding:25vh 2px 8px;scrollbar-width:none;" +
      "display:flex;flex-direction:column}" +
      "#av-term .av-t-log::-webkit-scrollbar{display:none}" +
      "#av-term .av-t-log>div:first-child{margin-top:auto}" +
      "#av-term .av-t-log>div{margin:4px 0;white-space:pre-wrap;word-wrap:break-word}" +
      "#av-term .av-t-tag{color:rgb(70,140,95)}" +
      "#av-term .av-t-you{color:rgb(200,235,210)}" +
      "#av-term .av-t-open{display:block;margin:6px 0 2px;padding:5px 12px;font:inherit;cursor:pointer;" +
      "color:rgb(150,240,180);background:rgba(90,200,130,.12);border:1px solid rgba(90,200,130,.45);border-radius:4px}" +
      "#av-term a{color:inherit;text-decoration:underline}" +
      "#av-term form{display:flex;align-items:center;gap:8px;padding:9px 12px;" +
      "border:1px solid rgba(90,200,130,.35);border-radius:4px;background:rgba(8,22,14,.75);" +
      "-webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px)}" +
      "#av-term input{flex:1;min-width:0;background:none;border:0;outline:0;color:rgb(200,245,215);" +
      "font:inherit;caret-color:rgb(110,240,150)}" +
      "#av-term input::placeholder{color:rgba(110,180,135,.5)}" +
      "#av-term .av-t-p{color:rgb(90,200,130)}" +
      "#av-term .av-t-add{background:none;border:0;padding:0 2px;font:inherit;font-size:20px;line-height:1;" +
      "color:rgb(110,220,150);cursor:pointer}";
    document.head.appendChild(css);
    const el = document.createElement("div");
    el.id = "av-term";
    // clear of the browser's sound toggle (bottom left); the app has none
    el.style.bottom = DISPLAY ? "24px" : "48px";
    el.innerHTML = '<div class="av-t-log"></div>' +
      '<form autocomplete="off"><span class="av-t-p">&gt;</span>' +
      '<input enterkeyhint="send" placeholder="message ' + A.name.toLowerCase() + '">' +
      '<button type="button" class="av-t-add" title="attach a file">+</button>' +
      '<input type="file" class="av-t-file" hidden></form>';
    document.body.appendChild(el);
    term = { el, log: el.firstElementChild, input: el.querySelector("input") };
    // typing, scrolling, and taps here never reach the face's own handlers
    ["pointerdown", "pointerup", "keydown"].forEach(t => el.addEventListener(t, e => e.stopPropagation()));
    // +: attach a file. In the app, Android's picker (the app uploads it);
    // in a browser, the file chooser, sent over the socket. Either way it
    // rides along with the next question, like a shared picture.
    const picker = el.querySelector(".av-t-file");
    el.querySelector(".av-t-add").addEventListener("click", () => {
      if (DISPLAY) { if (window.JarvisApp && window.JarvisApp.pickFile) window.JarvisApp.pickFile(); }
      else picker.click();
    });
    picker.addEventListener("change", () => {
      const f = picker.files[0]; picker.value = "";
      if (!f || !VI || !VI.ws || VI.ws.readyState !== 1) return;
      const r = new FileReader();
      r.onload = () => {
        VI.ws.send(JSON.stringify({ type: "file", name: f.name, mime: f.type, data: String(r.result).split(",")[1] || "" }));
        A.termLine("you", "[attached " + f.name + "]");
      };
      r.readAsDataURL(f);
    });
    el.querySelector("form").addEventListener("submit", (e) => {
      e.preventDefault();
      const t = term.input.value.trim();
      if (!t) return;
      if (DISPLAY) { if (window.JarvisApp) window.JarvisApp.send(t); }
      else if (VI && VI.ws && VI.ws.readyState === 1) VI.ws.send(JSON.stringify({ type: "text", text: t }));
      else return;    // offline: keep what was typed
      term.input.value = "";
      term.log.scrollTop = term.log.scrollHeight;
    });
    const fit = termFit = () => {
      const on = termOpen && screen.height >= 600 && !SHOT;
      if (!on && document.activeElement === term.input) term.input.blur();
      document.documentElement.classList.toggle("av-term-on", on);
      A.termShown = on;
      A.termTop = on ? el.getBoundingClientRect().top : innerHeight;
    };
    addEventListener("resize", fit);
    fit();
  }

  /* --------------------------------- version -------------------------------- */
  // Small in the bottom right corner while the terminal is hidden: the app's
  // version (it passes ?v=), else this face's build date (core.js's
  // Last-Modified).
  (async () => {
    if (SHOT) return;
    let t = Q.get("v") ? "v" + Q.get("v") : "";
    if (!t) try {
      const lm = (await fetch(new URL("core.js", ROOT))).headers.get("Last-Modified");
      const d = lm && new Date(lm);
      if (d && d.getFullYear() > 2000) t = "face " + d.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
    } catch (e) { /* no build to show */ }
    if (!t) return;
    const css = document.createElement("style");
    css.textContent = "#av-ver{position:fixed;right:10px;bottom:8px;z-index:40;pointer-events:none;" +
      "font:13px/1 'SF Mono',Menlo,Consolas,monospace;letter-spacing:.06em;color:rgb(170,245,195);" +
      "opacity:.8;text-shadow:0 0 6px rgba(0,0,0,.9);" +
      "filter:var(--av-mode-filter,none)}html.av-term-on #av-ver{display:none}";
    document.head.appendChild(css);
    const el = document.createElement("div");
    el.id = "av-ver"; el.textContent = t;
    document.body.appendChild(el);
  })();

  /* ----------------------------- thinking sound ---------------------------- */
  let audio = null, sndBtn = null, playing = false;
  A._sndWant = true;
  function soundInit() {
    if (SHOT) return;
    try { A._sndOn = localStorage.getItem("av_sound") !== "0"; }
    catch (e) { A._sndOn = true; }
    audio = new Audio(new URL("assets/thinking.wav", ROOT).href);
    audio.volume = 0.35;
    sndBtn = document.createElement("div");
    // hidden until the mouse moves, so it never collides with a face's
    // chrome and never shows on camera or in an OBS source
    sndBtn.style.cssText =
      "position:fixed;left:64px;bottom:14px;z-index:50;cursor:pointer;" +
      "font:12px 'SF Mono',Menlo,Consolas,monospace;letter-spacing:.2em;" +
      "color:#5a6a72;opacity:0;transition:opacity .4s;user-select:none;" +
      "pointer-events:none";
    sndBtn.title = "thinking sound on/off";
    let hideT = null;
    addEventListener("mousemove", () => {
      sndBtn.style.opacity = ".65";
      sndBtn.style.pointerEvents = "auto";
      clearTimeout(hideT);
      hideT = setTimeout(() => {
        sndBtn.style.opacity = "0";
        sndBtn.style.pointerEvents = "none";
      }, 3000);
    });
    sndBtn.onclick = () => {
      A._sndOn = !A._sndOn;
      try { localStorage.setItem("av_sound", A._sndOn ? "1" : "0"); }
      catch (e) {}
      if (!A._sndOn) stopSound();
      paintBtn();
    };
    paintBtn();
    document.body.appendChild(sndBtn);
  }
  function paintBtn() {
    if (sndBtn) sndBtn.textContent = A._sndOn ? "SND ON" : "SND OFF";
  }
  function stopSound() {
    if (audio && playing) { audio.pause(); audio.currentTime = 0; }
    playing = false;
  }
  function soundUpdate() {
    if (!audio || !A._sndWant) return;
    const want = A._sndOn && A.state === "thinking" && !raw.loading;
    if (want && !playing) {
      playing = true;
      audio.currentTime = 0;
      audio.play().catch(() => { playing = false; });
    } else if (!want && playing) {
      stopSound();
    }
  }

  /* ------------------------------ shot harness ----------------------------- */
  // Runs the face's frame() deterministically (a synchronous burst of t ms).
  // A headless browser resizes the window and finishes loading images AFTER
  // the first burst, so the burst re-runs on resize and on two late timers
  // (the last one flags "ready"), then keeps painting at frame pace so the
  // late capture always sees a fresh composite.
  A.shotRun = (frame) => {
    const burst = () => { for (let t = 0; t < SHOT_T; t += 16.6) frame(16.6); };
    burst();
    addEventListener("resize", burst);
    setTimeout(burst, 450);
    setTimeout(burst, 900);
    setTimeout(() => { burst(); document.title = "ready"; }, 3000);
    // fat 100ms steps: assets that finish loading after the last burst
    // still reach their steady state within a few paints
    const loop = () => { frame(100); requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
  };

  /* ---------------------------------- init --------------------------------- */
  A.init = (opts = {}) => {
    A._mic = !!opts.mic;   // the meter opens with the capture, never at load
    if (opts.sound !== false) soundInit(); else A._sndWant = false;
    if (DEMO) {
      applyConfig({ name: Q.get("name") || "JARVIS" });
    } else {
      fetch("/config", { cache: "no-store" })
        .then(r => r.json()).then(applyConfig)
        .catch(() => applyConfig({}));
    }
    return A;
  };

  A.tick = tick;

  /* ----------------------------- render helpers ---------------------------- */
  const U = {};
  U.dim = (c, f) => {
    f = Math.max(0, Math.min(1, f));
    return `rgb(${c[0] * f | 0},${c[1] * f | 0},${c[2] * f | 0})`;
  };
  U.rgba = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;

  // How long until a usage window resets, in the shortest honest unit.
  U.relTime = (ep) => {
    const d = ep - Date.now() / 1000;
    if (!(d > 0)) return "";
    if (d < 3600) return Math.round(d / 60) + "m";
    if (d < 86400) return Math.round(d / 3600) + "h";
    return Math.round(d / 86400) + "d";
  };

  // The plan-usage windows, formatted ONCE for every face that draws them.
  // Lives here rather than in each face because four copies of one format
  // drift apart silently, and the first symptom is two faces disagreeing
  // about the same number.
  //
  // Returns [] when the voice line publishes no usage, so a face can call
  // it unconditionally and simply draw nothing when there is nothing to say.
  // A window that is KNOWN but has no percentage yet still returns a row:
  // hiding it entirely was the original bug, and a row that says "no number
  // yet" is information where a missing row is just confusing.
  U.usageRows = () => {
    const rl = A.rateLimits || {};
    const out = [];
    for (const [label, w] of [["5H", rl.five_hour], ["7D", rl.seven_day]]) {
      if (!w) continue;
      const known = w.utilization != null;
      const pct = known ? Math.round(w.utilization * 100) : null;
      const rel = w.resets_at ? U.relTime(w.resets_at) : "";
      out.push({
        label, pct, known,
        hot: known && pct >= 80,
        text: (known ? pct + "%" : "\u2014") + (rel ? "  " + rel : "")
      });
    }
    return out;
  };
  U.mix = (c1, c2, t) => [c1[0] + (c2[0] - c1[0]) * t | 0,
                          c1[1] + (c2[1] - c1[1]) * t | 0,
                          c1[2] + (c2[2] - c1[2]) * t | 0];
  // soft additive glow sprite (canvas), cached by the caller
  U.makeGlow = (rgb, size) => {
    const c = document.createElement("canvas");
    c.width = c.height = size;
    const g = c.getContext("2d");
    const grd = g.createRadialGradient(size / 2, size / 2, 0,
                                       size / 2, size / 2, size / 2);
    grd.addColorStop(0, `rgba(${rgb[0]},${rgb[1]},${rgb[2]},1)`);
    grd.addColorStop(.25, `rgba(${rgb[0]},${rgb[1]},${rgb[2]},.55)`);
    grd.addColorStop(1, "rgba(0,0,0,0)");
    g.fillStyle = grd;
    g.fillRect(0, 0, size, size);
    return c;
  };
  // the one-field bloom rule: draw everything luminous into one field
  // canvas, bloom the WHOLE field (two downscale taps), composite
  // additively — bloom applied per-element reads as pencil lines
  U.bloomBlit = (dst, field, w, h) => {
    if (!field._b4 || field._b4.width !== w >> 2) {
      field._b4 = document.createElement("canvas");
      field._b4.width = Math.max(1, w >> 2);
      field._b4.height = Math.max(1, h >> 2);
      field._b8 = document.createElement("canvas");
      field._b8.width = Math.max(1, w >> 3);
      field._b8.height = Math.max(1, h >> 3);
    }
    const g4 = field._b4.getContext("2d"), g8 = field._b8.getContext("2d");
    g4.clearRect(0, 0, field._b4.width, field._b4.height);
    g4.drawImage(field, 0, 0, field._b4.width, field._b4.height);
    g8.clearRect(0, 0, field._b8.width, field._b8.height);
    g8.drawImage(field, 0, 0, field._b8.width, field._b8.height);
    const prev = dst.globalCompositeOperation;
    dst.globalCompositeOperation = "lighter";
    dst.drawImage(field, 0, 0);
    dst.drawImage(field._b4, 0, 0, w, h);
    dst.drawImage(field._b8, 0, 0, w, h);
    dst.globalCompositeOperation = prev;
  };
  // text that resolves out of glyph noise, left to right
  U.Descrambler = class {
    constructor(text, perChar = 50, hold = null) {
      this.text = text; this.per = perChar; this.hold = hold;
      this.t = 0; this.done = false;
      this.chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789#$%&";
    }
    render(dt) {
      this.t += dt;
      const n = this.t / this.per | 0;
      let out = "";
      for (let i = 0; i < this.text.length; i++) {
        const ch = this.text[i];
        out += (i < n || ch === " ") ? ch
          : this.chars[Math.random() * this.chars.length | 0];
      }
      if (this.hold != null && this.t > this.per * this.text.length + this.hold)
        this.done = true;
      return out;
    }
  };
  A.util = U;

  return A;
})();
