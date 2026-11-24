// ================= StageLoop · app.js =================
const $ = id => document.getElementById(id);
const uid = () => crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
// Disparo inmediato: reacciona en pointerdown (sin esperar al click) y sigue funcionando con
// teclado (Enter/Espacio) y con elemento.click() programático (click con detail === 0).
function rapido(el, fn) {
  el.addEventListener('pointerdown', e => { if (e.button > 0) return; e.preventDefault(); fn(e); });
  el.addEventListener('click', e => { if (e.detail === 0) fn(e); });
}
const NOMBRES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const NEGRAS = [1, 3, 6, 8, 10];
const COLOR_COMBI = ['#d9534f', '#f0a35e', '#2bb5a0', '#7cb342', '#3f7fd9', '#9b59b6', '#e67e22', '#16a085'];
const COLOR_CH = ['#2f8fe0', '#1fa59a', '#8e6bd8', '#d9822b', '#c94f7c', '#4caf50', '#c9a227', '#5c7cfa'];
const MIN_COLS = 8;
let ajustes = { release: 0.25, oct: 1 };
const nombreNota = n => NOMBRES[n % 12] + (Math.floor(n / 12) - ajustes.oct);

// ---------- IndexedDB ----------
const db = (() => {
  const abrir = new Promise((ok, err) => {
    const r = indexedDB.open('stageloop', 1);
    r.onupgradeneeded = () => {
      r.result.createObjectStore('samples', { keyPath: 'id' });
      r.result.createObjectStore('datos');
    };
    r.onsuccess = () => ok(r.result);
    r.onerror = () => err(r.error);
  });
  const op = (store, modo, fn) => abrir.then(d => new Promise((ok, err) => {
    const t = d.transaction(store, modo);
    const req = fn(t.objectStore(store));
    t.oncomplete = () => ok(req.result);
    t.onerror = t.onabort = () => err(t.error);
  }));
  return {
    get: (s, k) => op(s, 'readonly', st => st.get(k)),
    put: (s, v, k) => op(s, 'readwrite', st => (k === undefined ? st.put(v) : st.put(v, k))),
    del: (s, k) => op(s, 'readwrite', st => st.delete(k)),
  };
})();

// ---------- Motor de audio: 8 canales → Master → Limitador ----------
const ctx = new AudioContext({ latencyHint: 'interactive', sampleRate: 48000 }); // latencia.js puede ajustarlo (ver ⚙️ Ajustes)
// Limitador SIN lookahead: el DynamicsCompressorNode añade ~6 ms fijos de retraso, así que se usa un
// recortador suave (WaveShaper): transparente por debajo de 0.7 y satura suave hasta ±1. Latencia = 0.
function curvaLimitador() {
  const N = 2048, t = 0.7, c = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const x = (i / (N - 1)) * 2 - 1, a = Math.abs(x);
    c[i] = Math.sign(x) * (a <= t ? a : t + (1 - t) * Math.tanh((a - t) / (1 - t)));
  }
  return c;
}
const master = new GainNode(ctx, { gain: 0.9 });
const limitador = typeof WaveShaperNode !== 'undefined'
  ? new WaveShaperNode(ctx, { curve: curvaLimitador(), oversample: 'none' })
  : new DynamicsCompressorNode(ctx, { threshold: -3, knee: 0, ratio: 20, attack: 0.002, release: 0.1 });
const recDest = ctx.createMediaStreamDestination();   // solo se conecta mientras graba (ver REC)
master.connect(limitador);
limitador.connect(ctx.destination);
const canales = Array.from({ length: 8 }, () => {
  const gain = new GainNode(ctx);
  const an = new AnalyserNode(ctx, { fftSize: 256 });
  gain.connect(master);
  gain.connect(an);
  return { gain, an, nivel: 0, inHit: 0 };
});

// ---------- Estado ----------
let songs = [], patches = [], actualCancion = 0, actual = 0;
let selCelda = null, modoArrastre = 'MOVER', tran = 0, baseTeclado = 48;
let sustain = false, aprender = null, historial = [], medidores = [], ultimoMidi = 0;
const buffers = new Map();   // sampleId → AudioBuffer
const voces = new Map();     // nota → [voces]
const todas = new Set();
const sostenidas = new Set();
const cancion = () => songs[actualCancion];
let patchPorId = id => patches.find(p => p.id === id);   // let: wav.js lo reasigna
const nuevaCombi = () => ({ id: uid(), nombre: '', capas: {} });
const nuevaCancion = (genero, nombre) => ({ id: uid(), genero, nombre, combis: [], mix: { ch: Array(8).fill(1), master: 0.9 } });
const combiLlena = cb => !!cb && Object.keys(cb.capas).length > 0;

// Puente de audio: motor nativo (Oboe / Core Audio / PC) si existe; Web Audio si no. Ver audioBridge.js
AudioBridge.init({ ctx, canales, buffers, sampleRate: 48000 });
AudioBridge.setHandlers({ on: (n, v) => noteOn(n, v), off: n => noteOff(n) });

// ---------- Guardado, deshacer, mensajes ----------
let tGuardar;
const guardarAhora = () => Promise.all([
  db.put('datos', songs, 'songs'),
  db.put('datos', patches, 'patches'),
  db.put('datos', { cancion: actualCancion }, 'estado'),
  db.put('datos', ajustes, 'ajustes'),
]);
function persistir() { clearTimeout(tGuardar); tGuardar = setTimeout(() => guardarAhora().catch(console.error), 300); }
function guardarHist() { historial.push(JSON.stringify(songs)); if (historial.length > 50) historial.shift(); }

let tMsg;
function toast(txt, ms = 3000) {
  $('mensajeTxt').textContent = txt;
  $('mensaje').classList.remove('oculto');
  clearTimeout(tMsg);
  if (ms) tMsg = setTimeout(() => $('mensaje').classList.add('oculto'), ms);
}

// ---------- Voces ----------
function cortar(v, t, r) {
  AudioBridge.stopSample(v, r);                       // t se conserva por compatibilidad con otros módulos
}
function liberarNota(nota, r = ajustes.release) {
  const lista = voces.get(nota);
  if (!lista) return;
  const t = ctx.currentTime;
  lista.forEach(v => cortar(v, t, r));
  voces.delete(nota);
}
const capaSel = () => selCelda && cancion().combis[selCelda.c]?.capas[selCelda.ch];

function noteOn(nota, vel = 100) {
  if (aprender) {                                     // MIDI Learn del rango
    const capa = capaSel();
    if (capa) {
      guardarHist();
      capa[aprender] = nota;
      if (capa.lo > capa.hi) [capa.lo, capa.hi] = [capa.hi, capa.lo];
      persistir();
      toast(`Rango: ${nombreNota(capa.lo)} – ${nombreNota(capa.hi)}`);
    }
    aprender = null;
    renderCombis(); renderEditor();
    return;
  }
  const combi = cancion()?.combis[actual];
  if (combi) {
    sostenidas.delete(nota);
    liberarNota(nota, 0.03);

    const lista = [];
    for (const [ch, capa] of Object.entries(combi.capas)) {
      if (nota < capa.lo || nota > capa.hi) continue;  // split por capa
      const p = patchPorId(capa.patchId);
      if (!p) continue;
      const n = nota + tran + (capa.tr || 0);
      const z = p.zonas.find(z => n >= z.lo && n <= z.hi && vel >= (z.vlo ?? 0) && vel <= (z.vhi ?? 127));
      const buf = z && buffers.get(z.sampleId);
      if (!buf) continue;

      const v = AudioBridge.playSample(z.sampleId, {
        rate: Math.pow(2, (n - z.root) / 12),
        gain: capa.vol * (0.2 + 0.8 * vel / 127),
        ch: +ch,
        loop: !!z.loop && z.le > z.ls, ls: z.ls, le: z.le,
        onEnd: () => todas.delete(v),
      });
      if (!v) continue;
      todas.add(v);
      lista.push(v);
      canales[ch].inHit = performance.now();
    }
    if (lista.length) voces.set(nota, lista);
    while (todas.size > 96) {                        // límite de polifonía
      const v = todas.values().next().value;
      AudioBridge.stopSample(v, 0.01);
      todas.delete(v);
    }
  }
  marcarTecla(nota, true);                           // lo visual va DESPUÉS de disparar el sonido
}
function noteOff(nota) {
  marcarTecla(nota, false);
  if (sustain) sostenidas.add(nota); else liberarNota(nota);
}
function pedal(on) {
  sustain = on;
  if (!on) { sostenidas.forEach(n => liberarNota(n)); sostenidas.clear(); }
}
function detenerTodo(r) {
  const t = ctx.currentTime;
  todas.forEach(v => cortar(v, t, r));
  AudioBridge.stopAll(r);                            // PANIC también en el motor nativo
  teclaPend.clear();
  todas.clear(); voces.clear(); sostenidas.clear();
  sustain = false;
  document.querySelectorAll('.tecla.on').forEach(k => k.classList.remove('on'));
}

// ---------- MIDI ----------
function onMidi(e) {
  const [st, d1, d2 = 0] = e.data;
  if (st >= 0xf0) return;                            // Clock, SysEx, Active Sensing
  ultimoMidi = performance.now();
  const cmd = st & 0xf0;
  if (cmd === 0x90 && d2 > 0) AudioBridge.triggerNote(d1, d2);
  else if (cmd === 0x80 || cmd === 0x90) AudioBridge.noteOff(d1);
  else if (cmd === 0xb0) {
    if (d1 === 64) pedal(d2 >= 64);
    else if (d1 === 120 || d1 === 123) detenerTodo(0.05);
  }
  else if (cmd === 0xc0) activarCombi(d1);           // Program Change → COMBI
}
async function iniciarMIDI() {
  if (!navigator.requestMIDIAccess) { toast('Este navegador no tiene Web MIDI: usa Chrome o Edge', 6000); return; }
  try {
    const acc = await navigator.requestMIDIAccess();
    const conectar = () => {
      const ins = [...acc.inputs.values()];
      ins.forEach(i => (i.onmidimessage = onMidi));
      $('ledMidi').title = ins.map(i => i.name).join(', ') || 'Sin controlador';
      if (ins.length) toast('🎹 ' + ins[0].name + ' conectado');
    };
    conectar();
    acc.onstatechange = conectar;
  } catch { toast('Permiso MIDI denegado'); }
}

// ---------- Samples en memoria ----------
function pcmABuffer(pcm, sr) {
  const b = new AudioBuffer({ length: Math.max(1, pcm.length), sampleRate: sr, numberOfChannels: 1 });
  b.copyToChannel(pcm, 0);
  return b;
}
async function asegurarPatch(pid) {
  const p = patchPorId(pid);
  if (!p) return;
  for (const z of p.zonas) {
    if (buffers.has(z.sampleId)) continue;
    const s = await db.get('samples', z.sampleId);
    if (!s) continue;
    try {
      buffers.set(z.sampleId, s.kind === 'pcm' ? pcmABuffer(s.pcm, s.sr) : await ctx.decodeAudioData(s.datos.slice(0)));
    } catch (e) { console.warn('Sample ilegible', z.sampleId, e); }
  }
}
function liberarNoUsados() {
  const usados = new Set();
  for (const cb of cancion().combis)
    for (const capa of Object.values(cb.capas)) patchPorId(capa.patchId)?.zonas.forEach(z => usados.add(z.sampleId));
  for (const id of [...buffers.keys()]) if (!usados.has(id)) buffers.delete(id);
}
async function cargarCancion() {
  const pids = new Set(cancion().combis.flatMap(cb => Object.values(cb.capas).map(c => c.patchId)));
  for (const pid of pids) await asegurarPatch(pid);
  liberarNoUsados();                                 // en RAM solo la canción actual
}

// ---------- Importación WAV / Carpeta ----------
const AUDIO_RE = /\.(wav|mp3|ogg|flac|m4a|aiff?)$/i;
const NOTA_BASE = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };

function detectarRaiz(nombre) {                      // "EP_C#3.wav" → nota MIDI
  const base = nombre.replace(/\.[^.]+$/, '');
  const m = [...base.matchAll(/(?:^|[^a-z])([a-g])(#|s|b)?(-?\d)(?!\d)/gi)];
  if (m.length) {
    const [, l, alt, oct] = m[m.length - 1];
    const a = (alt || '').toLowerCase();
    const n = NOTA_BASE[l.toLowerCase()] + (a === '#' || a === 's' ? 1 : a === 'b' ? -1 : 0) + (parseInt(oct) + ajustes.oct) * 12;
    if (n >= 0 && n <= 127) return n;
  }
  const k = base.match(/(?:^|\D)(\d{2,3})(?!\d)/);  // "Piano_060.wav"
  if (k && +k[1] >= 21 && +k[1] <= 108) return +k[1];
  return null;
}
function mapearZonas(items) {                        // reparte el teclado entre las raíces
  const z = [...items].sort((a, b) => a.root - b.root);
  return z.map((x, i) => ({
    ...x,
    lo: i === 0 ? 0 : Math.floor((z[i - 1].root + x.root) / 2) + 1,
    hi: i === z.length - 1 ? 127 : Math.floor((x.root + z[i + 1].root) / 2),
  }));
}
async function importarArchivo(f) {
  const id = uid();
  const datos = await f.arrayBuffer();
  try { buffers.set(id, await ctx.decodeAudioData(datos.slice(0))); }
  catch { toast('⚠️ No pude leer ' + f.name); return null; }
  await db.put('samples', { id, kind: 'enc', datos });
  return id;
}
function finImport(txt) { persistir(); renderPatches(); liberarNoUsados(); toast('✓ ' + txt); }

async function importarWAVs(files) {
  let i = 0;
  for (const f of files) {
    toast(`Importando ${++i}/${files.length}: ${f.name}`, 0);
    const id = await importarArchivo(f);
    if (!id) continue;
    patches.push({ id: uid(), nombre: f.name.replace(/\.[^.]+$/, ''), lib: 'WAV',
      zonas: [{ sampleId: id, root: detectarRaiz(f.name) ?? 60, lo: 0, hi: 127 }] });
  }
  finImport(`${i} archivo(s) importados`);
}

async function importarCarpeta(files) {              // 1 subcarpeta = 1 patch multizona
  const grupos = new Map();
  for (const f of files) {
    if (!AUDIO_RE.test(f.name)) continue;
    const dir = (f.webkitRelativePath || f.name).split('/').slice(0, -1).join('/') || 'Carpeta';
    if (!grupos.has(dir)) grupos.set(dir, []);
    grupos.get(dir).push(f);
  }
  if (!grupos.size) { toast('La carpeta no tiene audios compatibles'); return; }
  const total = [...grupos.values()].reduce((n, g) => n + g.length, 0);
  let hechos = 0;
  for (const [dir, lista] of grupos) {
    const partes = dir.split('/'), items = [];
    for (const f of lista) {
      toast(`Importando ${++hechos}/${total}: ${f.name}`, 0);
      const id = await importarArchivo(f);
      if (id) items.push({ sampleId: id, root: detectarRaiz(f.name) });
    }
    if (!items.length) continue;
    const conNota = items.filter(z => z.root !== null);
    let zonas;
    if (conNota.length) {
      zonas = mapearZonas(conNota);
      for (const z of items.filter(z => z.root === null)) { buffers.delete(z.sampleId); await db.del('samples', z.sampleId); }
    } else {                                         // sin notas en el nombre → modo kit (1 tecla c/u desde C2)
      zonas = items.map((z, i) => { const k = Math.min(127, 36 + i); return { ...z, root: k, lo: k, hi: k }; });
    }
    patches.push({ id: uid(), nombre: partes.at(-1), lib: partes[0], zonas });
  }
  finImport(`${grupos.size} patch(es) creados`);
}

// ---------- Lector SF2 (SoundFont 2) ----------
function parseSF2(buf) {
  const dv = new DataView(buf);
  const str = (o, n) => { let s = ''; for (let i = 0; i < n; i++) { const c = dv.getUint8(o + i); if (!c) break; s += String.fromCharCode(c); } return s.trim(); };
  const chunks = {};
  (function recorrer(ini, fin) {
    for (let o = ini; o + 8 <= fin;) {
      const id = str(o, 4), size = dv.getUint32(o + 4, true);
      if (id === 'RIFF' || id === 'LIST') recorrer(o + 12, Math.min(fin, o + 8 + size));
      else chunks[id] = { o: o + 8, size };
      o += 8 + size + (size & 1);
    }
  })(0, buf.byteLength);
  for (const c of ['phdr', 'pbag', 'pgen', 'inst', 'ibag', 'igen', 'shdr', 'smpl'])
    if (!chunks[c]) throw new Error('SF2 inválido: falta ' + c);

  const leer = (id, tam, fn) => { const c = chunks[id], r = []; for (let o = c.o; o + tam <= c.o + c.size; o += tam) r.push(fn(o)); return r; };
  const gen = o => ({ op: dv.getUint16(o, true), amt: dv.getInt16(o + 2, true), lo: dv.getUint8(o + 2), hi: dv.getUint8(o + 3) });
  const phdr = leer('phdr', 38, o => ({ nombre: str(o, 20), preset: dv.getUint16(o + 20, true), bank: dv.getUint16(o + 22, true), bag: dv.getUint16(o + 24, true) }));
  const pbag = leer('pbag', 4, o => dv.getUint16(o, true));
  const pgen = leer('pgen', 4, gen);
  const inst = leer('inst', 22, o => ({ bag: dv.getUint16(o + 20, true) }));
  const ibag = leer('ibag', 4, o => dv.getUint16(o, true));
  const igen = leer('igen', 4, gen);
  const shdr = leer('shdr', 46, o => ({ start: dv.getUint32(o + 20, true), end: dv.getUint32(o + 24, true),
    ls: dv.getUint32(o + 28, true), le: dv.getUint32(o + 32, true), sr: dv.getUint32(o + 36, true),
    pitch: dv.getUint8(o + 40), tipo: dv.getUint16(o + 44, true) }));
  const smpl = chunks.smpl;
  const gensDe = (bags, gens, b) => { const m = {}; for (let g = bags[b]; g < bags[b + 1]; g++) if (gens[g]) m[gens[g].op] = gens[g]; return m; };
  const rango = g => (g ? [g.lo, g.hi] : null);

  const presets = [];
  for (let p = 0; p < phdr.length - 1; p++) {
    const zonas = [];
    for (let b = phdr[p].bag; b < phdr[p + 1].bag; b++) {
      const pg = gensDe(pbag, pgen, b);
      if (!pg[41]) continue;                                   // 41 = instrument
      const ii = pg[41].amt & 0xffff;
      if (!inst[ii + 1]) continue;
      const pKey = rango(pg[43]);
      let global = {};
      for (let ib = inst[ii].bag; ib < inst[ii + 1].bag; ib++) {
        const local = gensDe(ibag, igen, ib);
        if (!local[53]) { if (ib === inst[ii].bag) global = local; continue; }   // zona global
        const g = { ...global, ...local };
        const si = g[53].amt & 0xffff, s = shdr[si];             // 53 = sampleID
        if (!s || s.end <= s.start || (s.tipo & 2) || (s.tipo & 0x8000)) continue; // canal derecho / ROM
        const iKey = rango(g[43]) || [0, 127];
        const k = pKey ? [Math.max(pKey[0], iKey[0]), Math.min(pKey[1], iKey[1])] : iKey;
        if (k[0] > k[1]) continue;
        const v = rango(g[44]) || [0, 127];
        const raiz = g[58] && g[58].amt >= 0 ? g[58].amt : s.pitch < 128 ? s.pitch : 60;
        zonas.push({ s: si, lo: k[0], hi: k[1], vlo: v[0], vhi: v[1],
          root: raiz - (g[51] ? g[51].amt : 0),                  // 51 = coarseTune
          loop: !!(g[54] && (g[54].amt & 1)),                    // 54 = sampleModes
          ls: s.ls - s.start, le: s.le - s.start });
      }
    }
    if (zonas.length) presets.push({ nombre: phdr[p].nombre || 'Preset ' + p, bank: phdr[p].bank, preset: phdr[p].preset, zonas });
  }
  presets.sort((a, b) => a.bank - b.bank || a.preset - b.preset);

  const pcmDe = i => {                               // Int16 → Float32 con DataView (sin problemas de alineación)
    const s = shdr[i], base = smpl.o + s.start * 2;
    const n = Math.max(0, Math.min(s.end - s.start, Math.floor((buf.byteLength - base) / 2)));
    const f = new Float32Array(n);
    for (let j = 0; j < n; j++) f[j] = dv.getInt16(base + j * 2, true) / 32768;
    return { pcm: f, sr: s.sr || 44100 };
  };
  return { presets, pcmDe };
}

async function importarSF2(file) {
  if (/\.nki$/i.test(file.name)) {
    toast('NKI es un formato cerrado de Kontakt. Expórtalo a WAV o SF2 e impórtalo aquí.', 8000);
    return;
  }
  toast('Leyendo ' + file.name + '…', 0);
  let sf;
  try { sf = parseSF2(await file.arrayBuffer()); }
  catch (e) { console.error(e); toast('⚠️ El archivo SF2 no es válido'); return; }
  const lib = file.name.replace(/\.[^.]+$/, ''), fid = uid(), hechos = new Set();
  let i = 0;
  for (const pr of sf.presets) {
    toast(`SF2: preset ${++i}/${sf.presets.length} · ${pr.nombre}`, 0);
    const zonas = [];
    for (const z of pr.zonas) {
      const sid = fid + '_' + z.s;
      if (!hechos.has(sid)) {
        const { pcm, sr } = sf.pcmDe(z.s);
        await db.put('samples', { id: sid, kind: 'pcm', pcm, sr });
        hechos.add(sid);
      }
      zonas.push({ sampleId: sid, root: z.root, lo: z.lo, hi: z.hi, vlo: z.vlo, vhi: z.vhi, loop: z.loop, ls: z.ls, le: z.le });
    }
    patches.push({ id: uid(), nombre: pr.nombre, lib, zonas });
  }
  finImport(`${sf.presets.length} patch(es) desde ${file.name}`);
}

// ---------- Render: cabecera y COMBIs ----------
function renderCabecera() {
  const s = cancion();
  $('cGenero').textContent = s.genero || '—';
  $('cNombre').textContent = s.nombre || '—';
  $('tranVal').textContent = (tran > 0 ? '+' : '') + tran;
  $('octTxt').textContent = nombreNota(baseTeclado);
}
const nombreCombi = cb => cb.nombre ||
  Object.keys(cb.capas).sort().map(ch => patchPorId(cb.capas[ch].patchId)?.nombre || '?').join(' + ') || 'vacío';
const rangoTxt = c => (c.lo === 0 && c.hi === 127 ? 'TODO' : `${nombreNota(c.lo)}–${nombreNota(c.hi)}`) +
  (c.tr ? ` · ${c.tr > 0 ? '+' : ''}${c.tr}` : '');

function renderCombis() {
  const s = cancion(), cols = Math.max(s.combis.length + 1, MIN_COLS), grid = $('grid');
  let h = '<div class="esq"></div>';
  for (let c = 0; c < cols; c++) {
    const cb = s.combis[c];
    h += combiLlena(cb)
      ? `<div class="cab${c === actual ? ' activa' : ''}" data-c="${c}" style="--col:${COLOR_COMBI[c % COLOR_COMBI.length]}"><span>${c + 1}&nbsp;&nbsp;${esc(nombreCombi(cb))}</span></div>`
      : `<div class="cab vacia" data-c="${c}"><span>${c + 1}&nbsp;&nbsp;${esc(cb?.nombre || 'vacío')}</span></div>`;
  }
  for (let ch = 0; ch < 8; ch++) {
    h += `<div class="chh" style="--col:${COLOR_CH[ch]}"><div class="io"><i class="in"></i><i class="out"></i></div><b>CH${ch + 1}</b></div>`;
    for (let c = 0; c < cols; c++) {
      const capa = s.combis[c]?.capas[ch];
      const sel = selCelda && selCelda.c === c && selCelda.ch === ch ? ' sel' : '';
      if (!capa) { h += `<div class="celda${sel}" data-c="${c}" data-ch="${ch}">+</div>`; continue; }
      const p = patchPorId(capa.patchId);
      h += `<div class="celda llena${sel}" data-c="${c}" data-ch="${ch}" style="--col:${COLOR_CH[ch]}">
        <div class="nom">${esc(p ? p.lib : '¿?')}/<br>${esc(p ? p.nombre : 'patch borrado')}</div>
        <div class="cpie"><small>${rangoTxt(capa)}</small><span class="vol"><span style="width:${Math.round(capa.vol * 100)}%"></span></span></div>
      </div>`;
    }
  }
  grid.style.gridTemplateColumns = `78px repeat(${cols}, 122px)`;
  grid.innerHTML = h;
  medidores = [...grid.querySelectorAll('.chh')].map(el => ({ inp: el.querySelector('.in'), out: el.querySelector('.out') }));
}

function activarCombi(c) {
  if (!cancion()?.combis[c]) return;
  actual = c;
  $('irCombi').value = c + 1;
  $('grid').querySelectorAll('.cab').forEach(el => el.classList.toggle('activa', +el.dataset.c === c && !el.classList.contains('vacia')));
  $('grid').querySelector(`.cab[data-c="${c}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}
function seleccionarCelda(c, ch) {
  selCelda = { c, ch };
  aprender = null;
  $('grid').querySelectorAll('.celda.sel').forEach(el => el.classList.remove('sel'));
  $('grid').querySelector(`.celda[data-c="${c}"][data-ch="${ch}"]`)?.classList.add('sel');
  $('panel').classList.remove('oculto');
  activarCombi(c);
  renderEditor();
}
function limpiarCombis() {
  const cs = cancion().combis;
  while (cs.length && !combiLlena(cs.at(-1))) cs.pop();
  if (actual >= cs.length) actual = Math.max(0, cs.length - 1);
}
function moverCapa(a, b) {
  const s = cancion(), origen = s.combis[a.c]?.capas[a.ch];
  if (!origen) return;
  guardarHist();
  while (s.combis.length <= b.c) s.combis.push(nuevaCombi());
  s.combis[b.c].capas[b.ch] = structuredClone(origen);
  if (modoArrastre === 'MOVER') delete s.combis[a.c].capas[a.ch];
  limpiarCombis();
  selCelda = { c: b.c, ch: b.ch };
  persistir(); renderCombis(); renderEditor();
}

// Tocar, seleccionar y arrastrar celdas
let arrastre = null;
$('grid').addEventListener('pointerdown', e => {
  const cab = e.target.closest('.cab');
  if (cab) { activarCombi(+cab.dataset.c); return; }
  const cel = e.target.closest('.celda');
  if (cel) arrastre = { c: +cel.dataset.c, ch: +cel.dataset.ch, x: e.clientX, y: e.clientY, llena: cel.classList.contains('llena') };
});
window.addEventListener('pointerup', e => {
  if (!arrastre) return;
  const a = arrastre;
  arrastre = null;
  const el = document.elementFromPoint(e.clientX, e.clientY)?.closest('.celda');
  if (!el) return;
  const b = { c: +el.dataset.c, ch: +el.dataset.ch };
  const movio = Math.hypot(e.clientX - a.x, e.clientY - a.y) > 12;
  if (movio && a.llena && (b.c !== a.c || b.ch !== a.ch)) moverCapa(a, b);
  else if (!movio) seleccionarCelda(b.c, b.ch);
});
window.addEventListener('pointercancel', () => (arrastre = null));
$('grid').addEventListener('dblclick', e => {
  const cab = e.target.closest('.cab');
  const cb = cab && cancion().combis[+cab.dataset.c];
  if (!cb) return;
  const n = prompt('Nombre de la COMBI (vacío = automático):', cb.nombre);
  if (n === null) return;
  guardarHist(); cb.nombre = n.trim(); persistir(); renderCombis();
});

// ---------- Panel: editor de capa ----------
function renderEditor() {
  const ed = $('editorCapa');
  if (!selCelda) { $('panelTitulo').textContent = 'Toca una celda para elegir la capa (CH)'; ed.innerHTML = ''; return; }
  $('panelTitulo').textContent = `CH${selCelda.ch + 1} · COMBI ${selCelda.c + 1} → elige un patch`;
  const capa = capaSel();
  if (!capa) { ed.innerHTML = ''; return; }
  ed.innerHTML = `
    <div class="fila"><span>Rango</span>
      <button data-ap="lo">${nombreNota(capa.lo)} 🎹</button>–<button data-ap="hi">${nombreNota(capa.hi)} 🎹</button>
      <button data-acc="todo">TODO</button></div>
    <div class="fila"><span>Vol</span><input type="range" min="0" max="1" step="0.01" value="${capa.vol}" data-acc="vol"></div>
    <div class="fila"><span>Trans</span><button data-acc="tr-">−</button><b>${capa.tr || 0}</b><button data-acc="tr+">+</button>
      <button data-acc="quitar" class="peligro">Quitar capa</button></div>`;
}
$('editorCapa').addEventListener('click', e => {
  const b = e.target.closest('button'), capa = capaSel();
  if (!b || !capa) return;
  if (b.dataset.ap) {
    aprender = b.dataset.ap;
    toast(`🎹 Toca una tecla para fijar el ${aprender === 'lo' ? 'inicio' : 'final'} del rango`, 0);
    return;
  }
  const a = b.dataset.acc;
  if (!a) return;
  guardarHist();
  if (a === 'todo') { capa.lo = 0; capa.hi = 127; }
  if (a === 'tr-') capa.tr = Math.max(-24, (capa.tr || 0) - 1);
  if (a === 'tr+') capa.tr = Math.min(24, (capa.tr || 0) + 1);
  if (a === 'quitar') { delete cancion().combis[selCelda.c].capas[selCelda.ch]; limpiarCombis(); }
  persistir(); renderCombis(); renderEditor();
});
$('editorCapa').addEventListener('input', e => {
  const capa = capaSel();
  if (e.target.dataset.acc !== 'vol' || !capa) return;
  capa.vol = +e.target.value;
  persistir(); renderCombis();
});
$('btnPanelAbrir').onclick = () => { $('panel').classList.remove('oculto'); renderEditor(); };
$('panelCerrar').onclick = () => {
  selCelda = null; aprender = null;
  $('panel').classList.add('oculto');
  renderCombis(); renderEditor();
};

// ---------- Panel: lista de patches ----------
function renderPatches() {
  const libs = [...new Set(patches.map(p => p.lib))].sort();
  const sel = $('filtroLib');
  const lib = libs.includes(sel.value) ? sel.value : '';
  sel.innerHTML = '<option value="">Todas las librerías</option>' +
    libs.map(l => `<option value="${esc(l)}" ${l === lib ? 'selected' : ''}>${esc(l)}</option>`).join('');
  const q = $('buscar').value.toLowerCase();
  const lista = patches.filter(p => (!lib || p.lib === lib) && p.nombre.toLowerCase().includes(q))
    .sort((a, b) => a.nombre.localeCompare(b.nombre));
  $('listaPatches').innerHTML = lista.map(p => `
    <div class="patch" data-id="${p.id}">
      <div><b>${esc(p.nombre)}</b><small>${esc(p.lib)} · Sampler · ${p.zonas.length} zonas</small></div>
      <button data-acc="ren" title="Renombrar">✎</button><button data-acc="del" title="Borrar">🗑</button>
    </div>`).join('') || '<p class="vacio">Sin patches. Importa con + Carpeta, + WAV o + SF2.</p>';
}
$('buscar').oninput = renderPatches;
$('filtroLib').onchange = renderPatches;

$('listaPatches').addEventListener('click', async e => {
  const fila = e.target.closest('.patch');
  if (!fila) return;
  const p = patchPorId(fila.dataset.id);
  if (!p) return;
  const acc = e.target.closest('button')?.dataset.acc;
  if (acc === 'ren') {
    const n = prompt('Nombre del patch:', p.nombre);
    if (n) { p.nombre = n.trim(); persistir(); renderPatches(); renderCombis(); }
    return;
  }
  if (acc === 'del') { await borrarPatch(p); return; }
  if (!selCelda) { toast('Primero toca una celda (CH) de la cuadrícula'); return; }

  const { c, ch } = selCelda, s = cancion();
  guardarHist();
  while (s.combis.length <= c) s.combis.push(nuevaCombi());
  const prev = s.combis[c].capas[ch];
  s.combis[c].capas[ch] = { patchId: p.id, lo: prev?.lo ?? 0, hi: prev?.hi ?? 127, vol: prev?.vol ?? 0.8, tr: prev?.tr ?? 0 };
  persistir(); renderCombis(); renderEditor();
  toast('Cargando ' + p.nombre + '…', 0);
  await asegurarPatch(p.id);
  activarCombi(c);
  toast(`✓ ${p.nombre} en CH${ch + 1}`);
});

async function borrarPatch(p) {
  guardarHist();
  songs.forEach(s => s.combis.forEach(cb => { for (const ch in cb.capas) if (cb.capas[ch].patchId === p.id) delete cb.capas[ch]; }));
  patches = patches.filter(x => x !== p);
  const enUso = new Set(patches.flatMap(x => x.zonas.map(z => z.sampleId)));
  for (const z of p.zonas) if (!enUso.has(z.sampleId)) { buffers.delete(z.sampleId); await db.del('samples', z.sampleId); }
  limpiarCombis();
  persistir(); renderPatches(); renderCombis(); renderEditor();
}

$('inWav').onchange = e => { importarWAVs([...e.target.files]); e.target.value = ''; };
$('inCarpeta').onchange = e => { importarCarpeta([...e.target.files]); e.target.value = ''; };
$('inSf2').onchange = e => { if (e.target.files[0]) importarSF2(e.target.files[0]); e.target.value = ''; };

// ---------- SET LIST ----------
function renderSetlist() {
  $('listaCanciones').innerHTML = songs.map((s, i) => `
    <div class="cancionFila ${i === actualCancion ? 'activa' : ''}" data-i="${i}">
      <span class="num">${i + 1}</span>
      <div><small>${esc(s.genero)}</small><b>${esc(s.nombre)}</b></div>
      <small>${s.combis.filter(combiLlena).length} combis</small>
      <button data-acc="ren">✎</button><button data-acc="up">▲</button><button data-acc="del">🗑</button>
    </div>`).join('');
}
async function elegirCancion(i) {
  if (!songs[i]) return;
  detenerTodo(0.05);
  actualCancion = i; actual = 0; selCelda = null; aprender = null;
  aplicarMix(); renderTodo(); persistir();
  toast('Cargando ' + cancion().nombre + '…', 0);
  await cargarCancion();
  toast('✓ ' + cancion().nombre + ' lista');
}
$('nuevaCancion').onclick = () => {
  const genero = prompt('Género o carpeta (ej. Cumbia):', cancion()?.genero || '');
  if (genero === null) return;
  const nombre = prompt('Nombre de la canción:');
  if (!nombre) return;
  guardarHist();
  songs.push(nuevaCancion(genero.trim(), nombre.trim()));
  elegirCancion(songs.length - 1);
};
$('listaCanciones').addEventListener('click', e => {
  const fila = e.target.closest('.cancionFila');
  if (!fila) return;
  const i = +fila.dataset.i, s = songs[i], acc = e.target.closest('button')?.dataset.acc;
  if (!acc) { elegirCancion(i); return; }
  if (acc === 'ren') {
    const g = prompt('Género:', s.genero); if (g === null) return;
    const n = prompt('Nombre:', s.nombre); if (!n) return;
    guardarHist(); s.genero = g.trim(); s.nombre = n.trim();
  }
  if (acc === 'up') {
    if (i === 0) return;
    guardarHist();
    [songs[i - 1], songs[i]] = [songs[i], songs[i - 1]];
    if (actualCancion === i) actualCancion--; else if (actualCancion === i - 1) actualCancion++;
  }
  if (acc === 'del') {
    if (songs.length === 1) { toast('Debe quedar al menos una canción'); return; }
    if (!confirm(`¿Borrar "${s.nombre}"?`)) return;
    guardarHist();
    songs.splice(i, 1);
    if (i < actualCancion || actualCancion >= songs.length) actualCancion--;
    elegirCancion(Math.max(0, actualCancion));
    return;
  }
  persistir(); renderSetlist(); renderCabecera();
});
rapido($('cPrev'), () => elegirCancion(actualCancion - 1));
rapido($('cSig'), () => elegirCancion(actualCancion + 1));

// ---------- MIXER ----------
function aplicarMix() {
  const m = cancion().mix, t = ctx.currentTime;
  m.ch.forEach((v, i) => canales[i].gain.gain.setTargetAtTime(v, t, 0.02));
  master.gain.setTargetAtTime(m.master, t, 0.02);
  AudioBridge.setMix(m);                             // volúmenes también al motor nativo
}
function renderMixer() {
  const m = cancion().mix;
  const tira = (et, color, v, ch, cls = '') =>
    `<div class="tira ${cls}"><b style="color:${color}">${et}</b><input type="range" min="0" max="1.5" step="0.01" value="${v}" data-ch="${ch}"><span>${Math.round(v * 100)}%</span></div>`;
  $('mixer').innerHTML = m.ch.map((v, i) => tira('CH' + (i + 1), COLOR_CH[i], v, i)).join('') + tira('MASTER', '#fff', m.master, 'm', 'master');
}
$('mixer').addEventListener('input', e => {
  const ch = e.target.dataset.ch;
  if (ch === undefined) return;
  const m = cancion().mix, v = +e.target.value;
  if (ch === 'm') m.master = v; else m.ch[+ch] = v;
  e.target.nextElementSibling.textContent = Math.round(v * 100) + '%';
  aplicarMix(); persistir();
});

// ---------- Teclado virtual ----------
function renderTeclado() {
  const cont = $('teclado');
  cont.innerHTML = '';
  const fin = baseTeclado + 36;
  let total = 0;
  for (let n = baseTeclado; n <= fin; n++) if (!NEGRAS.includes(n % 12)) total++;
  const w = 100 / total;
  let i = 0;
  for (let n = baseTeclado; n <= fin; n++) {
    const negra = NEGRAS.includes(n % 12);
    const k = document.createElement('div');
    k.className = 'tecla ' + (negra ? 'negra' : 'blanca');
    k.dataset.n = n;
    if (negra) {
      k.style.left = (i * w - w * 0.3) + '%';
      k.style.width = (w * 0.6) + '%';
    } else {
      k.style.left = (i * w) + '%';
      k.style.width = w + '%';
      if (n % 12 === 0) k.innerHTML = `<span>${nombreNota(n)}</span>`;
      i++;
    }
    cont.appendChild(k);
  }
  $('octTxt').textContent = nombreNota(baseTeclado);
}
// Lo visual se aplica en el siguiente frame y agrupado: el sonido no espera al DOM.
const teclaPend = new Map();
let teclaRaf = 0;
function marcarTecla(n, on) {
  teclaPend.set(n, on);
  if (teclaRaf) return;
  teclaRaf = requestAnimationFrame(() => {
    teclaRaf = 0;
    teclaPend.forEach((o, k) => $('teclado').querySelector(`.tecla[data-n="${k}"]`)?.classList.toggle('on', o));
    teclaPend.clear();
  });
}
const punteros = new Map();                          // pointerId → nota (o null)
function teclaEn(x, y) {
  const k = document.elementFromPoint(x, y)?.closest?.('.tecla');
  return k ? +k.dataset.n : null;
}
$('teclado').addEventListener('pointerdown', e => {
  const k = e.target.closest('.tecla');
  if (!k) return;
  e.preventDefault();
  const n = +k.dataset.n, r = k.getBoundingClientRect();
  const vel = Math.round(40 + 87 * Math.min(1, Math.max(0, (e.clientY - r.top) / r.height))); // más abajo = más fuerte
  punteros.set(e.pointerId, n);
  AudioBridge.triggerNote(n, vel);
});
window.addEventListener('pointermove', e => {
  if (!punteros.has(e.pointerId)) return;
  const n = teclaEn(e.clientX, e.clientY), prev = punteros.get(e.pointerId);
  if (n === prev) return;                            // glissando
  if (prev !== null) AudioBridge.noteOff(prev);
  punteros.set(e.pointerId, n);
  if (n !== null) AudioBridge.triggerNote(n, 100);
});
function soltarPuntero(e) {
  if (!punteros.has(e.pointerId)) return;
  const n = punteros.get(e.pointerId);
  punteros.delete(e.pointerId);
  if (n !== null) AudioBridge.noteOff(n);
}
window.addEventListener('pointerup', soltarPuntero);
window.addEventListener('pointercancel', soltarPuntero);
rapido($('octMas'), () => { if (baseTeclado <= 79) { baseTeclado += 12; renderTeclado(); } });
rapido($('octMenos'), () => { if (baseTeclado >= 12) { baseTeclado -= 12; renderTeclado(); } });
$('btnTeclado').onclick = () => $('piano').classList.toggle('oculto');

// Teclado de la PC: A W S E D F T G Y H U J K = una octava · Z/X = octava
const TECLAS_PC = 'awsedftgyhujk';
const esCampo = el => ['INPUT', 'SELECT', 'TEXTAREA'].includes(el?.tagName);
document.addEventListener('keydown', e => {
  if (e.repeat || esCampo(e.target) || e.ctrlKey || e.metaKey) return;
  const key = e.key.toLowerCase();
  const k = TECLAS_PC.indexOf(key);
  if (k >= 0) AudioBridge.triggerNote(baseTeclado + 12 + k, 100);
  if (key === 'z') $('octMenos').click();
  if (key === 'x') $('octMas').click();
});
document.addEventListener('keyup', e => {
  const k = TECLAS_PC.indexOf(e.key.toLowerCase());
  if (k >= 0) AudioBridge.noteOff(baseTeclado + 12 + k);
});

// ---------- Barra superior ----------
function mostrarVista(v) {
  document.querySelectorAll('.tabs button').forEach(x => x.classList.toggle('activa', x.dataset.vista === v));
  $('vistaCombis').classList.toggle('oculto', v !== 'combis');
  $('vistaSetlist').classList.toggle('oculto', v !== 'setlist');
  $('vistaMixer').classList.toggle('oculto', v !== 'mixer');
  if (v === 'setlist') renderSetlist();
  if (v === 'mixer') renderMixer();
}
document.querySelectorAll('.tabs button').forEach(b => (b.onclick = () => mostrarVista(b.dataset.vista)));
$('btnMenu').onclick = () => mostrarVista('setlist');
$('btnInfo').onclick = () => alert('StageLoop · PWA para tocar en vivo con teclado MIDI');
$('btnGuardar').onclick = () => guardarAhora().then(() => toast('✓ Guardado')).catch(() => toast('⚠️ No se pudo guardar'));
$('btnDeshacer').onclick = () => {
  const prev = historial.pop();
  if (!prev) { toast('Nada que deshacer'); return; }
  songs = JSON.parse(prev);
  actualCancion = Math.min(actualCancion, songs.length - 1);
  actual = Math.min(actual, Math.max(0, cancion().combis.length - 1));
  selCelda = null;
  aplicarMix(); renderTodo(); persistir(); cargarCancion();
  toast('↶ Deshecho');
};
rapido($('tranMenos'), () => { if (tran > -24) { tran--; renderCabecera(); } });
rapido($('tranMas'), () => { if (tran < 24) { tran++; renderCabecera(); } });
rapido($('btnStop'), () => detenerTodo(0.3));
rapido($('btnPanic'), () => { detenerTodo(0.01); toast('⏹ PANIC: todo detenido'); });
$('irCombi').onchange = e => activarCombi((+e.target.value || 1) - 1);
$('btnArrastre').onclick = () => {
  modoArrastre = modoArrastre === 'MOVER' ? 'COPIAR' : 'MOVER';
  $('btnArrastre').textContent = 'Arrastrar: ' + modoArrastre;
};
$('btnFull').onclick = () => {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen?.().catch(() => {});
};
$('mensajeCerrar').onclick = () => $('mensaje').classList.add('oculto');

// REC: graba la salida master en un archivo
let grabador = null, trozos = [];
$('btnRec').onclick = () => {
  if (grabador) { grabador.stop(); return; }
  if (!window.MediaRecorder) { toast('Este navegador no puede grabar'); return; }
  trozos = [];
  limitador.connect(recDest);
  const rec = new MediaRecorder(recDest.stream);
  rec.ondataavailable = e => e.data.size && trozos.push(e.data);
  rec.onstop = () => {
    const tipo = rec.mimeType || 'audio/webm';
    const blob = new Blob(trozos, { type: tipo });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${cancion().nombre}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.${tipo.includes('mp4') ? 'm4a' : 'webm'}`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    try { limitador.disconnect(recDest); } catch (e) {}
    grabador = null;
    $('btnRec').classList.remove('activo');
    toast('✓ Grabación descargada');
  };
  rec.start();
  grabador = rec;
  $('btnRec').classList.add('activo');
  toast('● Grabando… pulsa REC para terminar', 0);
};

// Ajustes
$('btnAjustes').onclick = () => {
  $('ajRelease').value = ajustes.release;
  $('ajReleaseVal').textContent = ajustes.release.toFixed(2) + ' s';
  $('ajOctava').value = String(ajustes.oct);
  const lat = ((ctx.baseLatency || 0) + (ctx.outputLatency || 0)) * 1000;
  $('ajLat').textContent = `Latencia de salida: ${lat ? lat.toFixed(1) + ' ms' : 'no disponible'} · ${ctx.sampleRate} Hz · motor: ${AudioBridge.mode}`;
  $('dlgAjustes').showModal();
};
$('ajRelease').oninput = e => {
  ajustes.release = +e.target.value;
  $('ajReleaseVal').textContent = ajustes.release.toFixed(2) + ' s';
  persistir();
};
$('ajOctava').onchange = e => { ajustes.oct = +e.target.value; persistir(); renderTodo(); renderTeclado(); };
$('ajCerrar').onclick = () => $('dlgAjustes').close();

// ---------- Desbloqueo de audio, MIDI y pantalla ----------
let iniciado = false;
async function desbloquear() {
  if (!AudioBridge.nativeActive && ctx.state !== 'running') ctx.resume();   // si hay motor nativo, Web Audio queda dormido
  if (iniciado) return;
  iniciado = true;
  iniciarMIDI();
  navigator.storage?.persist?.();
  try { await navigator.wakeLock?.request('screen'); } catch {}
}
window.addEventListener('pointerdown', desbloquear, { capture: true });
window.addEventListener('keydown', desbloquear, { capture: true });
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && iniciado) navigator.wakeLock?.request('screen').catch(() => {});
});

// ---------- Medidores (60 fps, sin re-render) ----------
const tmp = new Float32Array(256);
let ultVoces = -1, cuadro = 0;
function animar() {
  if (++cuadro & 1) { requestAnimationFrame(animar); return; }   // medidores a ~30 fps: menos trabajo del hilo principal
  const ahora = performance.now();
  canales.forEach((c, i) => {
    c.an.getFloatTimeDomainData(tmp);
    let pico = 0;
    for (let j = 0; j < tmp.length; j++) { const a = Math.abs(tmp[j]); if (a > pico) pico = a; }
    c.nivel = Math.max(pico, c.nivel * 0.9);
    const m = medidores[i];
    if (m) {
      m.out.style.setProperty('--n', Math.min(1, c.nivel).toFixed(3));
      m.inp.classList.toggle('on', ahora - c.inHit < 120);
    }
  });
  $('ledMidi').classList.toggle('on', ahora - ultimoMidi < 120);
  if (todas.size !== ultVoces) { ultVoces = todas.size; $('infoCarga').textContent = 'Voces ' + ultVoces; }
  requestAnimationFrame(animar);
}

// ---------- Render global y arranque ----------
function renderTodo() { renderCabecera(); renderCombis(); renderEditor(); renderPatches(); renderSetlist(); renderMixer(); }

(async () => {
  try {
    songs = (await db.get('datos', 'songs')) || [];
    patches = (await db.get('datos', 'patches')) || [];
    ajustes = { ...ajustes, ...((await db.get('datos', 'ajustes')) || {}) };
    const est = (await db.get('datos', 'estado')) || {};
    actualCancion = est.cancion || 0;
  } catch (e) {
    console.error(e);
    toast('⚠️ No pude abrir la base de datos local', 6000);
  }
  if (!songs.length) songs.push(nuevaCancion('Cumbia', 'ECLISMA'));
  songs.forEach(s => {                               // migración de datos viejos
    s.combis ||= [];
    s.mix ||= { ch: Array(8).fill(1), master: 0.9 };
  });
  actualCancion = Math.min(Math.max(0, actualCancion), songs.length - 1);
  aplicarMix();
  renderTodo();
  renderTeclado();
  requestAnimationFrame(animar);
  toast('Toca la pantalla o una tecla para activar el audio y el MIDI', 6000);
  await cargarCancion();
})();

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
