// ================= StageLoop · latencia.js (v13, con TURBO) =================
// Se carga ANTES de app.js.
//  · AudioContext con búfer mínimo (modo configurable) y frecuencia nativa de la tarjeta.
//  · Salta el silencio inicial de los samples al tocarlos.
//  · Mantiene la tarjeta despierta y reanuda el audio si se pausa.
//  · Detecta notas programadas tarde y mide latencia en ⚙️ Ajustes.
(() => {
  if (window.__slLatencia) return;                       // no instalar dos veces
  window.__slLatencia = true;

  // ---------- Configuración ----------
  const KEY = 'stageloop.lat';
  const leer = () => { try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch (e) { return {}; } };
  const cfg = Object.assign({ hint: 'interactive', trim: true, nativa: true, despierta: true }, leer());
  const guardar = () => localStorage.setItem(KEY, JSON.stringify(cfg));
  const VALIDOS = ['interactive', 'balanced', 'playback'];
  const hint = () => (VALIDOS.includes(cfg.hint) ? cfg.hint : (isFinite(+cfg.hint) ? +cfg.hint : 'interactive'));

  const existe = n => { try { return new Function('return typeof ' + n + ' !== "undefined"')(); } catch (e) { return false; } };
  const avisar = (m, ms = 6000) => {
    console.warn(m);
    try { if (existe('toast')) new Function('return toast')()(m, ms); } catch (e) {}
  };

  // ---------- 1. AudioContext rápido ----------
  let actx = null, srPedido = null;
  const Orig = window.AudioContext || window.webkitAudioContext;
  if (Orig) {
    class ACRapido extends Orig {
      constructor(opts) {
        const o = Object.assign({}, opts || {});
        if (o.sampleRate) { srPedido = o.sampleRate; if (cfg.nativa) delete o.sampleRate; }
        o.latencyHint = hint();
        super(o);
        actx = this;
        setTimeout(despertar, 300);
      }
    }
    window.AudioContext = ACRapido;
    if ('webkitAudioContext' in window) window.webkitAudioContext = ACRapido;
  }

  // ---------- 2. Momento de la última nota tocada (para el detector) ----------
  let ultNota = -1e9;
  const marcarNota = () => { ultNota = performance.now(); };

  // ---------- 3. Detector de notas programadas tarde ----------
  let avisoFuturo = false;
  function revisarFuturo(node, when) {
    if (avisoFuturo || !when || !actx || node.context !== actx) return;
    if (performance.now() - ultNota > 40) return;        // solo justo después de tocar (ignora loops)
    const ms = (when - actx.currentTime) * 1000;
    if (ms > 20 && ms < 1000) {
      avisoFuturo = true;
      avisar(`⚡ Turbo: una nota se programó ${Math.round(ms)} ms tarde. Busca "currentTime +" en noteOn de app.js.`, 0);
    }
  }

  // ---------- 4. Saltar silencio inicial de los samples ----------
  const offs = new WeakMap();
  let conocidos = new WeakSet(), ultRevision = 0, recortados = 0;

  function esSample(buf) {
    try {
      if (!existe('buffers')) return false;
      const B = new Function('return buffers')();
      if (!(B instanceof Map)) return false;
      if (conocidos.has(buf)) return true;
      const ahora = performance.now();
      if (ahora - ultRevision < 1000) return false;
      ultRevision = ahora;
      conocidos = new WeakSet();
      for (const b of B.values()) if (b) conocidos.add(b);
      return conocidos.has(buf);
    } catch (e) { return false; }
  }
  function silencioInicial(buf) {
    let s = offs.get(buf);
    if (s !== undefined) return s;
    const sr = buf.sampleRate, max = Math.min(buf.length, Math.round(sr * 0.3));
    const chs = [];
    for (let c = 0; c < buf.numberOfChannels; c++) chs.push(buf.getChannelData(c));
    let i = 0;
    busca: for (; i < max; i++) for (const d of chs) if (Math.abs(d[i]) > 0.001) break busca;   // ≈ −60 dB
    s = i >= max ? 0 : Math.max(0, i / sr - 0.001);                                             // deja 1 ms
    if (s < 0.002) s = 0;
    offs.set(buf, s);
    if (s > 0) recortados++;
    return s;
  }

  const ABS = window.AudioBufferSourceNode && AudioBufferSourceNode.prototype;
  if (ABS) {
    const start0 = ABS.start;
    ABS.start = function (when, offset, dur) {
      try {
        revisarFuturo(this, when);
        if (cfg.trim && !offset && this.buffer && !(this.loop && !this.loopStart) && esSample(this.buffer)) {
          const s = silencioInicial(this.buffer);
          if (s > 0) return dur === undefined ? start0.call(this, when || 0, s) : start0.call(this, when || 0, s, dur);
        }
      } catch (e) {}
      return start0.apply(this, arguments);
    };
  }
  const ASN = window.AudioScheduledSourceNode && AudioScheduledSourceNode.prototype;
  if (ASN) {                                             // osciladores y otras fuentes
    const st0 = ASN.start;
    ASN.start = function (when) {
      try { revisarFuturo(this, when); } catch (e) {}
      return st0.apply(this, arguments);
    };
  }

  // ---------- 5. Tarjeta despierta (señal de −100 dB, inaudible) ----------
  let vivo = null;
  const nativoActivo = () => !!(window.AudioBridge && AudioBridge.nativeActive);   // audioBridge.js: motor nativo en uso
  function despertar() {
    if (!cfg.despierta || vivo || !actx || actx.state !== 'running' || nativoActivo()) return;
    try {
      vivo = actx.createConstantSource();
      vivo.offset.value = 0.00001;
      vivo.connect(actx.destination);
      vivo.start();
    } catch (e) { vivo = null; console.warn('latencia.js: keep-alive no disponible', e); }
  }
  function dormir() {
    if (!vivo) return;
    try { vivo.stop(); vivo.disconnect(); } catch (e) {}
    vivo = null;
  }

  // ---------- 6. Reanudar el audio si Windows/Chrome lo pausan ----------
  const reanudar = () => {
    if (actx && !nativoActivo() && actx.state !== 'running' && actx.state !== 'closed') actx.resume().catch(() => {});
    setTimeout(despertar, 100);
  };
  ['pointerdown', 'keydown', 'touchstart'].forEach(ev =>
    addEventListener(ev, () => { marcarNota(); reanudar(); }, { passive: true, capture: true }));
  document.addEventListener('visibilitychange', () => { if (!document.hidden) reanudar(); });
  setInterval(despertar, 2000);

  // ---------- 7. Entrada MIDI: mide retraso y marca notas ----------
  const midiMs = [];
  if (navigator.requestMIDIAccess) {
    const req0 = navigator.requestMIDIAccess.bind(navigator);
    navigator.requestMIDIAccess = (...a) => req0(...a).then(acc => {
      const engancha = inp => {
        if (inp.__slLat) return;
        inp.__slLat = true;
        inp.addEventListener('midimessage', e => {
          if ((e.data[0] & 0xF0) !== 0x90 || !e.data[2]) return;
          marcarNota();
          if (actx && !nativoActivo() && actx.state === 'suspended') actx.resume().catch(() => {});
          const d = performance.now() - e.timeStamp;
          if (d >= 0 && d < 1000) { midiMs.push(d); if (midiMs.length > 30) midiMs.shift(); }
        });
      };
      acc.inputs.forEach(engancha);
      acc.addEventListener('statechange', e => { if (e.port.type === 'input') engancha(e.port); });
      return acc;
    });
  }

  // ---------- 8. Panel en ⚙️ Ajustes ----------
  const css = document.createElement('style');
  css.textContent = `
    button, #teclado, .tiles { touch-action: manipulation; }
    .latBox{margin:12px 0;padding:10px;border:1px solid #3a3f48;border-radius:8px;display:flex;flex-direction:column;gap:8px}
    .latTit{font-size:11px;font-weight:800;letter-spacing:1px;color:var(--naranja,#f39c12)}
    .latBox select{height:32px;background:#2a2e35;color:#fff;border:1px solid #3a3f48;border-radius:6px;padding:0 8px}
    .latChk{display:flex;align-items:center;gap:8px;font-size:12.5px}
    .latMed{font-size:12px;line-height:1.6;font-variant-numeric:tabular-nums}
    .latMed b{color:#fff}
    #latAplicar{height:32px}`;
  document.head.appendChild(css);

  const dlg = document.getElementById('dlgAjustes');
  if (!dlg) return;
  const box = document.createElement('div');
  box.className = 'latBox';
  box.innerHTML = `
    <div class="latTit">⚡ LATENCIA</div>
    <label>Modo de audio
      <select id="latModo">
        <option value="0">Mínima (experimental)</option>
        <option value="interactive">Baja (recomendada)</option>
        <option value="balanced">Equilibrada</option>
        <option value="playback">Segura (si escuchas clics o cortes)</option>
      </select></label>
    <label class="latChk"><input type="checkbox" id="latTrim"> Saltar el silencio inicial de los samples</label>
    <label class="latChk"><input type="checkbox" id="latNativa"> Usar la frecuencia de la tarjeta (sin conversión)</label>
    <label class="latChk"><input type="checkbox" id="latDespierta"> Mantener la tarjeta despierta (primera nota sin retraso)</label>
    <div id="latMed" class="latMed"></div>
    <button id="latAplicar" hidden>Recargar para aplicar</button>`;
  dlg.insertBefore(box, document.getElementById('ajCerrar'));

  const $l = id => document.getElementById(id);
  $l('latModo').value = String(cfg.hint);
  if (!$l('latModo').value) $l('latModo').value = 'interactive';
  $l('latTrim').checked = !!cfg.trim;
  $l('latNativa').checked = !!cfg.nativa;
  $l('latDespierta').checked = !!cfg.despierta;

  const pedirRecarga = () => { $l('latAplicar').hidden = false; };
  $l('latModo').addEventListener('change', e => { cfg.hint = e.target.value; guardar(); pedirRecarga(); });
  $l('latNativa').addEventListener('change', e => { cfg.nativa = e.target.checked; guardar(); pedirRecarga(); });
  $l('latTrim').addEventListener('change', e => { cfg.trim = e.target.checked; guardar(); medir(); });
  $l('latDespierta').addEventListener('change', e => {
    cfg.despierta = e.target.checked; guardar();
    if (cfg.despierta) despertar(); else dormir();
    medir();
  });
  $l('latAplicar').addEventListener('click', () => location.reload());

  const f = ms => ms.toFixed(1) + ' ms';
  function medir() {
    const el = $l('latMed');
    if (!actx) { el.textContent = 'El audio aún no arrancó: toca una nota y vuelve a abrir Ajustes.'; return; }
    const base = (actx.baseLatency || 0) * 1000;
    const out = (actx.outputLatency || 0) * 1000;
    const tot = base + out;
    const mid = midiMs.length ? midiMs.reduce((a, b) => a + b, 0) / midiMs.length : null;
    const luz = tot < 15 ? '🟢' : tot < 30 ? '🟡' : '🔴';
    const sr = srPedido
      ? (cfg.nativa ? ` (app.js pedía ${srPedido} Hz → ignorado ✓)` : ` (forzada por app.js)`)
      : '';
    el.innerHTML = `
      Búfer de audio: <b>${f(base)}</b><br>
      Salida (driver + dispositivo): <b>${out ? f(out) : 'no disponible'}</b><br>
      ${luz} Total audio: <b>${f(tot)}</b>${out > 100 ? ' — ⚠️ parece Bluetooth: usa cable' : ''}<br>
      Entrada MIDI → app: <b>${mid == null ? 'toca unas notas en tu teclado' : f(mid)}</b>${mid > 5 ? ' — ⚠️ la app está ocupada' : ''}<br>
      Frecuencia: <b>${actx.sampleRate} Hz</b>${sr}<br>
      Estado: <b>${actx.state}</b> · Tarjeta despierta: <b>${vivo ? 'sí' : 'no'}</b> · Samples recortados: <b>${recortados}</b>`;
  }
  let timer = null;
  new MutationObserver(() => {
    if (dlg.open && !timer) { medir(); timer = setInterval(medir, 500); }
    if (!dlg.open && timer) { clearInterval(timer); timer = null; }
  }).observe(dlg, { attributes: true, attributeFilter: ['open'] });
})();
