// ================= StageLoop · wav.js (v12) =================
// Instrumentos multisample desde WAV (sin NKI):
//  · "+ Instrumento WAV": carpeta de WAV con la nota en el nombre (Piano_C3.wav, Piano_C3_v60.wav…)
//  · "🎙 Auto-sampler": genera un MIDI, grabas tu sonido en el DAW y StageLoop corta la grabación.
// Se carga DESPUÉS de app.js y sfz.js. Usa el mismo formato de zonas que sfz.js.
(() => {
  const LIB = 'Mis instrumentos WAV';
  const LEAD = 1;                       // segundos de silencio antes de la primera nota del MIDI
  let lista = [];
  const mapa = new Map();

  // ---------- 0. Comprobaciones ----------
  if (document.getElementById('inWavInst')) return;                 // ya instalado
  const existe = n => { try { return new Function('return typeof ' + n + ' !== "undefined"')(); } catch (e) { return false; } };
  const aviso = m => { console.error(m); if (window.mostrarError) mostrarError(m); else alert(m); };
  const faltan = ['db', 'buffers', 'patchPorId', 'renderCombis', 'cancion', 'persistir', 'toast'].filter(n => !existe(n));
  if (faltan.length) { aviso('wav.js: faltan cosas de app.js → ' + faltan.join(', ')); return; }

  const $ = id => document.getElementById(id);
  const nuevoId = () => (existe('uid') ? uid() : Date.now().toString(36) + Math.random().toString(36).slice(2, 7));
  const escH = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const audio = () => (existe('ctx') && ctx ? ctx : null);
  async function esperarAudio() {
    let a = audio();
    while (!a) { await new Promise(r => setTimeout(r, 300)); a = audio(); }
    return a;
  }
  async function audioActivo() {
    const a = audio();
    if (!a) throw new Error('el audio aún no arrancó: toca una nota y vuelve a intentarlo');
    if (a.state === 'suspended') await a.resume().catch(() => {});
    return a;
  }

  // ---------- Estilos ----------
  const css = document.createElement('style');
  css.textContent = `
    .wavSec{display:flex;flex-direction:column;gap:4px;margin-bottom:8px}
    .wavTit{font-size:10.5px;font-weight:800;letter-spacing:1px;color:var(--naranja,#f39c12);padding:2px 2px 4px}
    .wavItem{display:flex;align-items:center;gap:8px;padding:8px 10px;background:#30343b;
      border:1px solid #3a3f48;border-radius:6px;cursor:pointer;font-size:12px}
    .wavItem:hover{border-color:var(--naranja,#f39c12)}
    .wavItem span{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .wavItem small{color:var(--sub,#9aa);font-size:10.5px}
    .wavItem button{height:26px;padding:0 7px;font-size:11px}
    #dlgAuto{background:#1e2126;color:#e8e8e8;border:1px solid #3a3f48;border-radius:10px;padding:18px;width:min(560px,94vw)}
    #dlgAuto::backdrop{background:rgba(0,0,0,.6)}
    #dlgAuto h3{margin:0 0 6px}
    .autoAyuda{font-size:12px;color:var(--sub,#9aa);margin:6px 0}
    .autoGrid{display:grid;grid-template-columns:1fr 1fr;gap:8px 12px;margin:10px 0}
    .autoGrid label{display:flex;flex-direction:column;gap:3px;font-size:11.5px;color:var(--sub,#9aa)}
    .autoGrid input,.autoGrid select{height:32px;background:#2a2e35;color:#fff;border:1px solid #3a3f48;border-radius:6px;padding:0 8px}
    .autoGrid .auChk{flex-direction:row;align-items:center;gap:8px;grid-column:1/-1}
    .autoGrid .auChk input{height:auto}
    .autoBtns{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px}
    .autoBtns button,.autoBtns .btn{height:36px;padding:0 12px}`;
  document.head.appendChild(css);

  // ---------- El buscador de patches también encuentra estos ----------
  try {
    const base = patchPorId;
    patchPorId = id => mapa.get(id) || base(id);
  } catch (e) {
    aviso('wav.js: no pude enlazar patchPorId (' + e.message + ')');
    return;
  }

  // ---------- Botones ----------
  const fila = ($('inSf2') && $('inSf2').closest('.importar')) || document.querySelector('.importar');
  if (!fila) { aviso('wav.js: no encontré la fila de botones .importar del panel PATCH'); return; }
  const lblSfz = $('inSfz') && $('inSfz').parentElement;
  if (lblSfz && lblSfz.firstChild && lblSfz.firstChild.nodeType === 3) lblSfz.firstChild.textContent = '+ SFZ';
  const bInst = document.createElement('label');
  bInst.className = 'btn';
  bInst.title = 'Carpeta con WAV que tengan la nota en el nombre (C3, D#3…)';
  bInst.innerHTML = '+ Instrumento WAV<input type="file" id="inWavInst" webkitdirectory multiple hidden>';
  const bAuto = document.createElement('button');
  bAuto.className = 'btn';
  bAuto.textContent = '🎙 Auto-sampler';
  fila.append(bInst, bAuto);
  $('inWavInst').addEventListener('change', e => { importarCarpeta(e.target.files); e.target.value = ''; });

  // ---------- Notas ----------
  const SEMI = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };
  const NOM = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const offOct = () => ($('ajOctava') && $('ajOctava').value === '2' ? 2 : 1);   // C3 = 60 (Yamaha) o C4 = 60
  const nombreNota = n => NOM[n % 12] + (Math.floor(n / 12) - offOct());

  function notaDeNombre(txt) {                      // última nota tipo C3, D#3, Eb2, C-1
    const re = /(?:^|[^a-z])([a-g])(#|b)?(-?\d)(?!\d)/gi;
    let m, ult = null;
    while ((m = re.exec(txt))) { ult = m; re.lastIndex = m.index + 1; }
    if (!ult) return null;
    const acc = ult[2] === '#' ? 1 : ult[2] ? -1 : 0;
    const n = (+ult[3] + offOct()) * 12 + SEMI[ult[1].toLowerCase()] + acc;
    return n >= 0 && n <= 127 ? n : null;
  }
  function notaDeNumero(txt) {                      // Piano_060.wav → 60 (solo 21–108)
    const m = [...txt.matchAll(/(?:^|[_\-\s.])(\d{2,3})(?=$|[_\-\s.])/g)].pop();
    if (!m) return null;
    const n = +m[1];
    return n >= 21 && n <= 108 ? n : null;
  }
  const leerNota = v => (/^\s*\d+\s*$/.test(v) ? +v : notaDeNombre(String(v).trim()));
  const DIN = { ppp: 20, pp: 35, p: 50, mp: 65, mf: 80, f: 100, ff: 115, fff: 127 };
  function velDe(txt) {                             // v60, vel100, pp, mf, ff…
    for (const t of txt.toLowerCase().split(/[_\-\s.]+/)) {
      const m = /^(?:v|vel|velocity)(\d{1,3})$/.exec(t);
      if (m) return Math.min(127, Math.max(1, +m[1]));
      if (DIN[t]) return DIN[t];
    }
    return null;
  }
  const rrDe = txt => { const m = /(?:^|[_\-\s.])rr(\d+)/i.exec(txt); return m ? +m[1] : 1; };

  // ---------- WAV: frecuencia original + chunk smpl (nota raíz y loop) ----------
  function leerWav(ab) {
    const v = new DataView(ab), r = { rate: 0, raiz: null, cents: 0, loop: null };
    if (ab.byteLength < 12 || v.getUint32(0) !== 0x52494646 || v.getUint32(8) !== 0x57415645) return r;
    let p = 12;
    while (p + 8 <= ab.byteLength) {
      const id = v.getUint32(p), sz = v.getUint32(p + 4, true), d = p + 8;
      if (id === 0x666d7420 && d + 8 <= ab.byteLength) r.rate = v.getUint32(d + 4, true);       // 'fmt '
      if (id === 0x736d706c && d + 36 <= ab.byteLength) {                                        // 'smpl'
        const u = v.getUint32(d + 12, true);
        if (u > 0 && u < 128) r.raiz = u;
        r.cents = v.getUint32(d + 16, true) / 4294967296 * 100;
        if (v.getUint32(d + 28, true) > 0 && d + 60 <= ab.byteLength) {
          const s = v.getUint32(d + 44, true), e = v.getUint32(d + 48, true);
          if (e > s) r.loop = { s, e };
        }
      }
      p = d + sz + (sz & 1);
    }
    return r;
  }

  async function guardarSample(ab) {
    const a = await audioActivo();
    const buf = await a.decodeAudioData(ab.slice(0));          // copia: decodeAudioData consume el buffer
    const sid = 'wav:s:' + nuevoId();
    await db.put('datos', ab, sid);
    buffers.set(sid, buf);
    return { sid, buf };
  }
  async function borrarSample(sid) {
    buffers.delete(sid);
    if (typeof db.del === 'function') await db.del('datos', sid).catch(() => {});
    else await db.put('datos', null, sid).catch(() => {});
  }

  // ---------- Zonas: cada sample cubre las teclas más cercanas ----------
  function armarZonas(items) {
    const vels = [...new Set(items.map(i => i.vel))].sort((a, b) => a - b);
    const zonas = [];
    vels.forEach((vel, i) => {
      const vlo = i === 0 ? 0 : Math.floor((vels[i - 1] + vel) / 2) + 1;
      const vhi = i === vels.length - 1 ? 127 : Math.floor((vel + vels[i + 1]) / 2);
      const capa = items.filter(it => it.vel === vel).sort((a, b) => a.raiz - b.raiz);
      capa.forEach((it, k) => {
        zonas.push({
          sampleId: it.sid,
          lo: k === 0 ? 0 : Math.floor((capa[k - 1].raiz + it.raiz) / 2) + 1,
          hi: k === capa.length - 1 ? 127 : Math.floor((it.raiz + capa[k + 1].raiz) / 2),
          root: it.raiz + (it.cents || 0) / 100,
          vlo, vhi,
          loop: !!it.loop, ls: it.loop ? it.loop.s : 0, le: it.loop ? it.loop.e : 0,
        });
      });
    });
    return zonas;
  }

  async function crearPatch(nombre, items) {
    items.forEach(it => { if (it.vel == null) it.vel = 100; });
    const vistos = new Set(), quedan = [];
    for (const it of items) {                       // una muestra por nota y capa
      const k = it.vel + ':' + it.raiz;
      if (vistos.has(k)) await borrarSample(it.sid); else { vistos.add(k); quedan.push(it); }
    }
    const zonas = armarZonas(quedan);
    const raices = quedan.map(i => i.raiz);
    const p = {
      id: 'wav:' + nuevoId(), nombre, lib: LIB, zonas,
      samples: [...new Set(zonas.map(z => z.sampleId))],
      capas: new Set(quedan.map(i => i.vel)).size,
      rango: [Math.min(...raices), Math.max(...raices)],
    };
    lista.push(p);
    mapa.set(p.id, p);
    await guardarLista();
    refrescarLista();
    return p;
  }

  // ---------- Importar carpeta (cada subcarpeta = un instrumento) ----------
  async function importarCarpeta(files) {
    files = [...files].filter(f => /\.(wav|wave|flac|mp3|ogg)$/i.test(f.name));
    if (!files.length) { toast('No encontré archivos de audio en esa carpeta.', 0); return; }
    try { await audioActivo(); } catch (e) { toast('⚠️ ' + e.message, 0); return; }
    const grupos = new Map();
    files.forEach(f => {
      const r = (f.webkitRelativePath || f.name).replace(/\\/g, '/');
      const d = r.split('/').slice(0, -1).join('/') || 'Instrumento';
      if (!grupos.has(d)) grupos.set(d, []);
      grupos.get(d).push(f);
    });
    let ok = 0, i = 0;
    const sinNota = [];
    for (const [dir, fs] of grupos) {
      const items = [];
      for (const f of fs) {
        toast(`Leyendo ${++i}/${files.length}: ${f.name}…`, 0);
        const base = f.name.replace(/\.[^.]+$/, '');
        if (rrDe(base) > 1) continue;               // round robin: solo rr1
        try {
          const ab = await f.arrayBuffer();
          const w = /\.wave?$/i.test(f.name) ? leerWav(ab) : { rate: 0, raiz: null, cents: 0, loop: null };
          const raiz = notaDeNombre(base) ?? w.raiz ?? notaDeNumero(base);
          if (raiz == null) { sinNota.push(f.name); continue; }
          const { sid, buf } = await guardarSample(ab);
          const fac = w.rate ? buf.sampleRate / w.rate : 1;          // loops ajustados a la frecuencia del audio
          const loop = w.loop ? { s: Math.round(w.loop.s * fac), e: Math.round(w.loop.e * fac) } : null;
          items.push({ sid, raiz, cents: w.cents, vel: velDe(base), loop });
        } catch (e) { console.error(e); toast('⚠️ ' + f.name + ': ' + e.message, 0); }
      }
      if (items.length) { await crearPatch(dir.split('/').pop(), items); ok++; }
    }
    if (sinNota.length) {
      toast(`✓ ${ok} instrumento(s). ⚠️ ${sinNota.length} archivo(s) sin nota en el nombre (ej.: ${sinNota[0]}). Para sonidos sueltos usa «+ WAV».`, 0);
    } else toast(`✓ ${ok} instrumento(s) importado(s)`, 3000);
  }

  // ---------- Auto-sampler ----------
  const dlg = document.createElement('dialog');
  dlg.id = 'dlgAuto';
  dlg.innerHTML = `
    <h3>🎙 Auto-sampler</h3>
    <p class="autoAyuda">① Descarga el MIDI · ② Tócalo con tu sonido de Kontakt en el DAW y exporta un WAV
      desde el inicio del proyecto · ③ Carga ese WAV aquí.</p>
    <div class="autoGrid">
      <label>Nombre del instrumento <input id="auNombre" value="Mi sonido"></label>
      <label>Velocidades (separadas por coma) <input id="auVels" value="100" placeholder="ej. 60,120"></label>
      <label>Nota más grave <input id="auLo" value="C1"></label>
      <label>Nota más aguda <input id="auHi" value="C7"></label>
      <label>Una muestra cada
        <select id="auPaso">
          <option value="1">1 semitono (máxima calidad)</option>
          <option value="2">2 semitonos</option>
          <option value="3" selected>3 semitonos (recomendado)</option>
          <option value="4">4 semitonos</option>
          <option value="6">6 semitonos</option>
          <option value="12">12 semitonos (liviano)</option>
        </select></label>
      <label>Nota sostenida (segundos) <input id="auHold" type="number" value="3" min="0.3" step="0.5"></label>
      <label>Cola / release (segundos) <input id="auCola" type="number" value="1.5" min="0.2" step="0.5"></label>
      <label class="auChk"><input id="auDetect" type="checkbox"> Detectar el inicio automáticamente (si tu WAV no empieza exactamente en el inicio del proyecto)</label>
    </div>
    <p id="auResumen" class="autoAyuda"></p>
    <div class="autoBtns">
      <button id="auMidi">① Descargar MIDI</button>
      <label class="btn">③ Cargar grabación WAV<input type="file" id="auWav" accept=".wav,audio/wav,audio/*" hidden></label>
      <button id="auCerrar">Cerrar</button>
    </div>`;
  document.body.appendChild(dlg);

  const CAMPOS = ['auNombre', 'auVels', 'auLo', 'auHi', 'auPaso', 'auHold', 'auCola'];
  try {
    const g = JSON.parse(localStorage.getItem('stageloop.auto') || '{}');
    CAMPOS.forEach(k => { if (g[k] != null) $(k).value = g[k]; });
  } catch (e) {}

  function plan() {
    const lo = leerNota($('auLo').value), hi = leerNota($('auHi').value);
    const paso = +$('auPaso').value;
    const hold = Math.max(0.3, +$('auHold').value || 3), cola = Math.max(0.2, +$('auCola').value || 1.5);
    const vels = [...new Set($('auVels').value.split(/[,\s;]+/).map(Number).filter(v => v >= 1 && v <= 127))].sort((a, b) => a - b);
    if (lo == null || hi == null || hi < lo || !vels.length) return null;
    const notas = [];
    for (let n = lo; n <= hi; n += paso) notas.push(n);
    if (notas[notas.length - 1] !== hi) notas.push(hi);
    const pasos = [];
    let t = LEAD;
    for (const v of vels) for (const n of notas) { pasos.push({ n, v, t }); t += hold + cola; }
    return { nombre: $('auNombre').value.trim() || 'Auto-sample', notas, vels, hold, cola, pasos, total: t };
  }
  function actualizarResumen() {
    const P = plan();
    const g = {}; CAMPOS.forEach(k => { g[k] = $(k).value; });
    localStorage.setItem('stageloop.auto', JSON.stringify(g));
    $('auResumen').textContent = P
      ? `${P.notas.length} notas × ${P.vels.length} velocidad(es) = ${P.pasos.length} muestras · grabación de ${Math.ceil(P.total)} s (≈ ${(P.total / 60).toFixed(1)} min). Usa EXACTAMENTE estos valores al cargar el WAV.`
      : '⚠️ Revisa las notas (ej. C1, F#2 o 36) y las velocidades (1–127).';
  }
  CAMPOS.forEach(k => $(k).addEventListener('input', actualizarResumen));
  bAuto.addEventListener('click', () => { actualizarResumen(); dlg.showModal(); });
  $('auCerrar').addEventListener('click', () => dlg.close());

  function midiDe(P) {                              // SMF tipo 0, 120 BPM, 480 PPQ
    const PPQ = 480, tick = s => Math.round(s * PPQ * 2);
    const ev = [];
    P.pasos.forEach(p => { ev.push([tick(p.t), 0x90, p.n, p.v]); ev.push([tick(p.t + P.hold), 0x80, p.n, 64]); });
    ev.sort((a, b) => a[0] - b[0] || (a[1] === 0x80 ? -1 : 1));
    const vlq = n => { const b = [n & 0x7F]; while ((n >>= 7)) b.unshift((n & 0x7F) | 0x80); return b; };
    const tr = [0x00, 0xFF, 0x51, 0x03, 0x07, 0xA1, 0x20];          // tempo 120 BPM
    let prev = 0;
    for (const [t, st, a, b] of ev) { tr.push(...vlq(t - prev), st, a, b); prev = t; }
    tr.push(...vlq(tick(P.cola)), 0xFF, 0x2F, 0x00);
    const L = tr.length;
    return new Uint8Array([
      0x4D, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, PPQ >> 8, PPQ & 255,
      0x4D, 0x54, 0x72, 0x6B, (L >>> 24) & 255, (L >> 16) & 255, (L >> 8) & 255, L & 255, ...tr,
    ]);
  }
  $('auMidi').addEventListener('click', () => {
    const P = plan();
    if (!P) { toast('Revisa los valores del Auto-sampler'); return; }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([midiDe(P)], { type: 'audio/midi' }));
    a.download = `StageLoop_${P.nombre.replace(/[^\w\-]+/g, '_')}.mid`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    toast('✓ MIDI descargado. Arrástralo al INICIO de una pista con tu sonido de Kontakt.', 5000);
  });

  function wav16(chs, a, b, sr) {                   // corta [a, b) a WAV 16 bits con fade-out de 20 ms
    const n = b - a, nc = chs.length, ab = new ArrayBuffer(44 + n * nc * 2), v = new DataView(ab);
    const s = (o, t) => { for (let i = 0; i < t.length; i++) v.setUint8(o + i, t.charCodeAt(i)); };
    s(0, 'RIFF'); v.setUint32(4, 36 + n * nc * 2, true); s(8, 'WAVE');
    s(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, nc, true);
    v.setUint32(24, sr, true); v.setUint32(28, sr * nc * 2, true); v.setUint16(32, nc * 2, true); v.setUint16(34, 16, true);
    s(36, 'data'); v.setUint32(40, n * nc * 2, true);
    const fade = Math.max(1, Math.min(n, Math.round(sr * 0.02)));
    let o = 44;
    for (let i = 0; i < n; i++) {
      const g = i > n - fade ? (n - i) / fade : 1;
      for (let c = 0; c < nc; c++) {
        const x = Math.max(-1, Math.min(1, chs[c][a + i] * g));
        v.setInt16(o, x < 0 ? x * 0x8000 : x * 0x7FFF, true);
        o += 2;
      }
    }
    return ab;
  }

  $('auWav').addEventListener('change', async e => {
    const f = e.target.files[0];
    e.target.value = '';
    const P = plan();
    if (!f || !P) return;
    try {
      const actx = await audioActivo();
      toast('Leyendo la grabación…', 0);
      const buf = await actx.decodeAudioData(await f.arrayBuffer());
      const sr = buf.sampleRate;
      const chs = [...Array(buf.numberOfChannels)].map((_, c) => buf.getChannelData(c));
      let off = 0;
      if ($('auDetect').checked) {
        let pico = 0;
        for (const d of chs) for (let i = 0; i < d.length; i += 4) pico = Math.max(pico, Math.abs(d[i]));
        const umbral = pico * 0.02;
        let ini = -1;
        for (let i = 0; i < chs[0].length && ini < 0; i++) for (const d of chs) if (Math.abs(d[i]) > umbral) { ini = i; break; }
        if (ini < 0) throw new Error('la grabación está en silencio');
        off = Math.max(0, ini / sr - 0.005) - LEAD;
      }
      const items = [];
      let mudas = 0;
      for (const [k, p] of P.pasos.entries()) {
        toast(`Cortando ${k + 1}/${P.pasos.length}: ${nombreNota(p.n)} · vel ${p.v}…`, 0);
        const a = Math.max(0, Math.round((p.t + off) * sr));
        const b = Math.min(buf.length, Math.round((p.t + off + P.hold + P.cola - 0.01) * sr));
        if (b - a < sr * 0.05) break;               // la grabación terminó antes

        // ⚡ inicio real del sonido (quita el silencio inicial → menos latencia)
        let ini = a;
        const lim = Math.min(b, a + Math.round(sr * 0.3));
        busca: for (; ini < lim; ini++) for (const d of chs) if (Math.abs(d[ini]) > 0.001) break busca;
        ini = ini >= lim ? a : Math.max(a, ini - Math.round(sr * 0.001));   // deja 1 ms antes del ataque

        // final real (quita el silencio de la cola)
        let fin = b;
        buscar: for (; fin > ini; fin--) for (const d of chs) if (Math.abs(d[fin - 1]) > 0.0005) break buscar;
        if (fin - ini < sr * 0.02) { mudas++; continue; }   // nota fuera del rango del sonido
        fin = Math.min(b, fin + Math.round(sr * 0.05));

        const { sid } = await guardarSample(wav16(chs, ini, fin, sr));
        items.push({ sid, raiz: p.n, cents: 0, vel: p.v, loop: null });
      }
      if (!items.length) throw new Error('no encontré notas. ¿Exportaste desde el inicio del proyecto?');
      const pt = await crearPatch(P.nombre, items);
      dlg.close();
      toast(`✓ «${pt.nombre}»: ${items.length} muestras${mudas ? ` (${mudas} notas en silencio omitidas)` : ''}. Asígnalo a una celda.`, 0);
    } catch (err) {
      console.error(err);
      toast('⚠️ Auto-sampler: ' + err.message, 0);
    }
  });

  // ---------- Lista en el panel PATCH ----------
  const guardarLista = () => db.put('datos', lista, 'wavPatches').catch(console.error);

  function refrescarLista() {
    const box = $('listaPatches'), sel = $('filtroLib');
    if (!box || !sel) return;
    if (lista.length && ![...sel.options].some(o => o.value === LIB)) sel.add(new Option(LIB, LIB));
    box.querySelector('.wavSec')?.remove();
    const f = ($('buscar')?.value || '').trim().toLowerCase();
    if (sel.value && sel.value !== LIB) return;
    const items = lista.filter(p => !f || p.nombre.toLowerCase().includes(f));
    if (!items.length) return;
    const sec = document.createElement('div');
    sec.className = 'wavSec';
    sec.innerHTML = `<div class="wavTit">🎹 MIS INSTRUMENTOS WAV</div>` + items.map(p => `
      <div class="wavItem" data-id="${escH(p.id)}">
        <span>${escH(p.nombre)}</span>
        <small>${p.zonas.length} zonas · ${p.capas} capa(s) · ${nombreNota(p.rango[0])}–${nombreNota(p.rango[1])}</small>
        <button data-del title="Borrar">🗑</button>
      </div>`).join('');
    box.prepend(sec);
  }
  new MutationObserver(() => {
    if (lista.length && !$('listaPatches').querySelector('.wavSec')) refrescarLista();
  }).observe($('listaPatches'), { childList: true });
  $('buscar')?.addEventListener('input', () => setTimeout(refrescarLista));
  $('filtroLib')?.addEventListener('change', () => setTimeout(refrescarLista));

  $('listaPatches').addEventListener('click', e => {
    const it = e.target.closest('.wavItem');
    if (!it) return;
    e.stopPropagation();
    const id = it.dataset.id;
    if (e.target.closest('[data-del]')) { borrar(id); return; }
    const celda = existe('selCelda') ? selCelda : null;
    if (!celda) { toast('Toca primero una celda de la cuadrícula'); return; }
    const cb = cancion().combis[celda.c];
    if (!cb) { toast('Esa COMBI no existe todavía'); return; }
    if (existe('guardarHist')) guardarHist();
    const prev = cb.capas[celda.ch];
    cb.capas[celda.ch] = prev ? { ...prev, patchId: id } : { patchId: id, vol: 0.8, tr: 0, lo: 0, hi: 127 };
    persistir(); renderCombis();
    if (existe('renderEditor')) renderEditor();
    toast(`✓ ${mapa.get(id).nombre} → CH${celda.ch + 1}`);
  }, true);

  async function borrar(id) {
    const p = mapa.get(id);
    if (!p || !confirm(`¿Borrar «${p.nombre}» y sus samples?`)) return;
    for (const sid of p.samples) await borrarSample(sid);
    lista = lista.filter(x => x !== p);
    mapa.delete(id);
    await guardarLista();
    refrescarLista(); renderCombis();
  }

  // ---------- Arranque ----------
  async function cargar() {
    lista = (await db.get('datos', 'wavPatches').catch(() => null)) || [];
    lista.forEach(p => mapa.set(p.id, p));
    refrescarLista();
    renderCombis();
    if (!lista.length) return;
    const actx = await esperarAudio();                 // espera a que app.js cree el audio
    for (const p of lista) for (const sid of p.samples) {
      if (buffers.has(sid)) continue;
      const ab = await db.get('datos', sid).catch(() => null);
      if (ab) buffers.set(sid, await actx.decodeAudioData(ab.slice(0)).catch(() => null));
    }
  }
  cargar().catch(e => toast('⚠️ No se pudieron cargar los instrumentos WAV: ' + e.message, 0));
})();
