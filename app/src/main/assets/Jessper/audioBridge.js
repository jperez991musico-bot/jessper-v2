// ================= StageLoop · audioBridge.js (v1) =================
// ÚNICA puerta de entrada al sonido. Pads, teclas, MIDI y teclado de PC llaman aquí;
// nadie más toca Web Audio para disparar notas.
//
//   AudioBridge.triggerNote(nota, vel)   → resuelve capas/splits (app.js) y dispara cada voz
//   AudioBridge.noteOff(nota)            → libera la nota
//   AudioBridge.playSample(id, opts)     → dispara UN sample: { rate, gain, ch, loop, ls, le, attack, onEnd }
//   AudioBridge.stopSample(voz|vozId, r) → libera una voz con release de r segundos
//   AudioBridge.stopAll(r)               → corta todo lo nativo (PANIC)
//   AudioBridge.setMix(mix)              → manda volúmenes de canal y master al motor nativo
//   AudioBridge.diag()                   → imprime baseLatency / outputLatency en consola
//
// Motor: si el contenedor nativo inyectó un puente en `window`, se usa ese (mensajes cortos,
// sin JSON, sin esperar respuesta). Si no, o si el puente falla, se usa Web Audio automáticamente.
//
// Puentes reconocidos (en este orden):
//   1. window.NativeAudio              objeto con métodos (PC: Electron/Tauri/host propio)
//   2. window.AndroidAudio             WebView.addJavascriptInterface(..., "AndroidAudio")
//   3. webkit.messageHandlers.audio    WKWebView (iOS)  → postMessage([op, ...números])
//   4. chrome.webview                  WebView2 (Windows) → postMessage([op, ...números])
//
// Se carga ANTES de app.js (app.js llama a AudioBridge.init justo después de crear el AudioContext).
(() => {
  if (window.AudioBridge) return;

  const OP = { PLAY: 1, STOP: 2, STOP_ALL: 3, CH_GAIN: 4, MASTER: 5, LOAD: 6, UNLOAD: 7 };
  const ATAQUE = 0.002;                       // anti-click, igual que antes en app.js

  let ctx = null, canales = null, buffers = null, srPedida = 0;
  let nat = null, natFallo = false;           // adaptador nativo activo / ya falló
  let handlers = { on: null, off: null };
  let vidSig = 1, numSig = 1;
  const vivas = new Map();                    // vozId → voz
  const numDe = new Map();                    // sampleId (texto) → número corto para el motor nativo
  const cargadas = new Map();                 // sampleId → AudioBuffer ya enviado al motor nativo

  const aviso = m => { try { if (typeof toast === 'function') toast(m, 6000); } catch (e) {} };

  // ---------------------------------------------------------------------------------------------
  // 1. Adaptadores nativos: todos exponen la misma forma interna
  // ---------------------------------------------------------------------------------------------
  const directo = (o, nombre) => ({
    nombre,
    load: (n, sr, ch, fr, b64) => o.load(n, sr, ch, fr, b64),
    unload: n => { if (o.unload) o.unload(n); },
    play: (v, s, r, g, c, ls, le) => o.play(v, s, r, g, c, ls, le),
    stop: (v, ms) => o.stop(v, ms),
    stopAll: ms => o.stopAll(ms),
    chGain: (c, g) => o.setChannelGain(c, g),
    master: g => o.setMaster(g),
  });
  const porArray = (post, nombre) => ({
    nombre,
    load: (n, sr, ch, fr, b64) => post([OP.LOAD, n, sr, ch, fr, b64]),
    unload: n => post([OP.UNLOAD, n]),
    play: (v, s, r, g, c, ls, le) => post([OP.PLAY, v, s, r, g, c, ls, le]),
    stop: (v, ms) => post([OP.STOP, v, ms]),
    stopAll: ms => post([OP.STOP_ALL, ms]),
    chGain: (c, g) => post([OP.CH_GAIN, c, g]),
    master: g => post([OP.MASTER, g]),
  });
  function detectarNativo() {
    const W = window;
    if (W.NativeAudio && typeof W.NativeAudio.play === 'function') return directo(W.NativeAudio, 'NativeAudio');
    if (W.AndroidAudio && typeof W.AndroidAudio.play === 'function') return directo(W.AndroidAudio, 'AndroidAudio (Oboe)');
    const h = W.webkit && W.webkit.messageHandlers && W.webkit.messageHandlers.audio;
    if (h && typeof h.postMessage === 'function') return porArray(m => h.postMessage(m), 'WKWebView (Core Audio)');
    const cw = W.chrome && W.chrome.webview;
    if (cw && typeof cw.postMessage === 'function') return porArray(m => cw.postMessage(m), 'WebView2');
    return null;
  }

  // Ejecuta una llamada nativa; si lanza, el puente se da por roto y se vuelve a Web Audio.
  function segura(fn) {
    try { fn(); return true; }
    catch (e) {
      console.error('[AudioBridge] el puente nativo falló, vuelvo a Web Audio:', e);
      nat = null; natFallo = true;
      if (ctx && ctx.state !== 'running') ctx.resume().catch(() => {});
      aviso('⚠️ Motor nativo sin respuesta: usando Web Audio');
      return false;
    }
  }

  function adoptarNativo() {
    if (nat || natFallo) return;
    const a = detectarNativo();
    if (!a) return;
    nat = a;
    console.info('[AudioBridge] motor nativo detectado:', a.nombre);
    // El audio lo hace el nativo: Web Audio queda dormido (solo se usa para decodificar).
    if (ctx && ctx.state === 'running') ctx.suspend().catch(() => {});
    if (buffers) for (const [id, b] of buffers) if (b) encolarCarga(id, b);
    if (buffers && canales && typeof cancion === 'function' && cancion()) setMix(cancion().mix);
  }

  // ---------------------------------------------------------------------------------------------
  // 2. Precarga de samples hacia el motor nativo (al cargar, nunca al pulsar)
  // ---------------------------------------------------------------------------------------------
  const numero = id => { let n = numDe.get(id); if (n === undefined) numDe.set(id, (n = numSig++)); return n; };

  function b64Int16(buf) {                    // AudioBuffer → Int16 intercalado → base64
    const ch = buf.numberOfChannels, n = buf.length, i16 = new Int16Array(n * ch);
    for (let c = 0; c < ch; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < n; i++) { const s = d[i] < -1 ? -1 : d[i] > 1 ? 1 : d[i]; i16[i * ch + c] = s < 0 ? s * 32768 : s * 32767; }
    }
    const bytes = new Uint8Array(i16.buffer);  // little-endian en Android, iOS, Windows, macOS
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  }

  const cola = []; let cargando = false;
  function encolarCarga(id, buf) {
    if (!nat) return;
    cola.push([id, buf]);
    if (!cargando) { cargando = true; setTimeout(procesarCarga, 0); }
  }
  function procesarCarga() {                  // una muestra por turno: no bloquea el hilo de la UI
    const it = cola.shift();
    if (!it || !nat) { cargando = false; return; }
    const [id, buf] = it;
    if (buffers.get(id) === buf && cargadas.get(id) !== buf) {
      const ok = segura(() => nat.load(numero(id), buf.sampleRate, buf.numberOfChannels, buf.length, b64Int16(buf)));
      if (ok) cargadas.set(id, buf);
    }
    setTimeout(procesarCarga, 0);
  }
  // Engancha buffers.set/.delete: así también se enteran sfz.js, wav.js, importaciones, etc.
  function enganchar() {
    const set0 = Map.prototype.set, del0 = Map.prototype.delete;
    buffers.set = function (k, v) { const r = set0.call(this, k, v); if (nat && v) encolarCarga(k, v); return r; };
    buffers.delete = function (k) {
      const r = del0.call(this, k);
      if (r && cargadas.has(k)) { cargadas.delete(k); if (nat) segura(() => nat.unload(numero(k))); }
      return r;
    };
  }

  // ---------------------------------------------------------------------------------------------
  // 3. Voces
  // ---------------------------------------------------------------------------------------------
  function terminar(v) {
    if (!v.activa) return;
    v.activa = false;
    clearTimeout(v.timer);
    vivas.delete(v.id);
    if (v.onEnd) v.onEnd();
  }

  function playWebAudio(id, o, rate, gain, ch) {
    const buf = buffers.get(id);
    if (!buf) return null;
    const t = ctx.currentTime;
    const src = new AudioBufferSourceNode(ctx, { buffer: buf, playbackRate: rate });
    if (o.loop && o.le > o.ls) {
      src.loop = true;
      src.loopStart = o.ls / buf.sampleRate;
      src.loopEnd = o.le / buf.sampleRate;
    }
    const g = new GainNode(ctx, { gain: 0 });
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + (o.attack ?? ATAQUE));
    src.connect(g).connect(canales[ch].gain);
    src.start(t);
    const v = { id: vidSig++, nativa: false, activa: true, parando: false, src, g, timer: 0, onEnd: o.onEnd };
    vivas.set(v.id, v);
    src.onended = () => { try { g.disconnect(); } catch (e) {} terminar(v); };
    return v;
  }

  function playNativo(id, o, rate, gain, ch) {
    const buf = buffers.get(id), loop = !!o.loop && o.le > o.ls, vid = vidSig++;
    if (!segura(() => nat.play(vid, numDe.get(id), rate, gain, ch, loop ? o.ls | 0 : 0, loop ? o.le | 0 : 0))) return null;
    const v = { id: vid, nativa: true, activa: true, parando: false, timer: 0, onEnd: o.onEnd };
    vivas.set(vid, v);
    // El nativo no avisa cuando termina un sample: se estima por duración (los loops terminan al soltar).
    if (!loop && buf) v.timer = setTimeout(() => terminar(v), (buf.duration / rate) * 1000 + 40);
    return v;
  }

  function playSample(id, o) {
    o = o || {};
    const rate = o.rate > 0 ? o.rate : 1, gain = o.gain == null ? 1 : o.gain, ch = o.ch | 0;
    if (nat && cargadas.has(id)) {
      const v = playNativo(id, o, rate, gain, ch);
      if (v) return v;
    }
    // Sin nativo, o ese sample aún no llegó al nativo (precarga en curso): Web Audio.
    if (nat && ctx.state !== 'running') ctx.resume().catch(() => {});
    return playWebAudio(id, o, rate, gain, ch);
  }

  function parar(v, r) {
    if (!v || !v.activa || v.parando) return;
    v.parando = true;
    if (v.nativa) {
      if (nat) segura(() => nat.stop(v.id, Math.round(r * 1000)));
      clearTimeout(v.timer);
      v.timer = setTimeout(() => terminar(v), r * 1000 + 40);
    } else {
      const t = ctx.currentTime;
      v.g.gain.cancelScheduledValues(t);
      v.g.gain.setValueAtTime(v.g.gain.value, t);
      v.g.gain.linearRampToValueAtTime(0, t + r);
      try { v.src.stop(t + r + 0.02); } catch (e) {}
    }
  }
  const stopSample = (x, r = 0.05) => parar(x !== null && typeof x === 'object' ? x : vivas.get(x), r);

  function stopAll(r = 0.01) {
    if (nat) segura(() => nat.stopAll(Math.round(r * 1000)));
    for (const v of [...vivas.values()]) if (v.nativa) { v.activa = false; clearTimeout(v.timer); vivas.delete(v.id); }
  }

  function setMix(m) {
    if (!nat || !m) return;
    segura(() => { m.ch.forEach((v, i) => nat.chGain(i, v)); nat.master(m.master); });
  }

  // ---------------------------------------------------------------------------------------------
  // 4. Desbloqueo de audio (primer gesto) — Chrome/Android: pointerdown · iOS: pointerup/touchend/click
  // ---------------------------------------------------------------------------------------------
  let silencioListo = false;
  function unlock() {
    if (!ctx || nat) return;
    if (ctx.state === 'suspended' || ctx.state === 'interrupted') ctx.resume().catch(() => {});
    if (!silencioListo) {                                    // iOS: un sonido vacío dentro del gesto
      silencioListo = true;
      try {
        const s = ctx.createBufferSource();
        s.buffer = ctx.createBuffer(1, 1, ctx.sampleRate);
        s.connect(ctx.destination);
        s.start(0);
      } catch (e) {}
    }
  }
  ['pointerdown', 'pointerup', 'touchend', 'click', 'keydown'].forEach(ev =>
    window.addEventListener(ev, unlock, { capture: true, passive: true }));

  // ---------------------------------------------------------------------------------------------
  // 5. Diagnóstico de latencia en consola
  // ---------------------------------------------------------------------------------------------
  function diag(etiqueta) {
    const modo = nat ? 'nativo: ' + nat.nombre : 'Web Audio';
    if (!ctx) { console.info('[AudioBridge] motor:', modo, '(sin AudioContext)'); return null; }
    const base = (ctx.baseLatency || 0) * 1000, out = (ctx.outputLatency || 0) * 1000;
    const r = {
      motor: modo, estado: ctx.state, sampleRate: ctx.sampleRate,
      'baseLatency (ms)': +base.toFixed(2),
      'outputLatency (ms)': ctx.outputLatency === undefined ? 'no disponible' : +out.toFixed(2),
      'total (ms)': +(base + out).toFixed(2),
    };
    console.info('[AudioBridge] diagnóstico' + (etiqueta ? ' (' + etiqueta + ')' : ''), r);
    if (srPedida && ctx.sampleRate !== srPedida)
      console.info(`[AudioBridge] pediste ${srPedida} Hz y el dispositivo usa ${ctx.sampleRate} Hz` +
        ' (si latencia.js tiene "Usar la frecuencia de la tarjeta" activo, es lo esperado: evita remuestreo).');
    return r;
  }

  // ---------------------------------------------------------------------------------------------
  window.AudioBridge = {
    version: 1,
    init(o) {
      ctx = o.ctx; canales = o.canales; buffers = o.buffers; srPedida = o.sampleRate || 0;
      enganchar();
      adoptarNativo();
      ctx.addEventListener('statechange', () => {
        if (ctx.state !== 'running') return;
        setTimeout(() => diag('al arrancar'), 300);
        setTimeout(() => diag('estabilizado'), 2500);   // outputLatency tarda en estabilizarse
      });
      if (ctx.state === 'running') setTimeout(() => diag('inicial'), 300);
      window.addEventListener('nativeaudioready', () => this.refresh());   // el host nativo puede avisar tarde
    },
    refresh() { adoptarNativo(); },
    setHandlers(h) { handlers = Object.assign(handlers, h); },
    triggerNote(nota, vel = 100) { if (handlers.on) handlers.on(nota, vel); },
    noteOff(nota) { if (handlers.off) handlers.off(nota); },
    playSample, stopSample, stopAll, setMix, unlock, diag,
    get nativeActive() { return !!nat; },
    get mode() { return nat ? 'nativo · ' + nat.nombre : 'Web Audio'; },
  };
})();
