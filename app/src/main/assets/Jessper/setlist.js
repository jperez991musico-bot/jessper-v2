// ================= StageLoop · setlist.js =================
// Pestaña SET LIST = botones de COMBI (modo escenario) + cajón de canciones (☰).
// Se carga DESPUÉS de app.js y panel.js.
(() => {
  // Colores como HOJAstage: rojo, mostaza, verde, turquesa, azul…
  COLOR_COMBI.splice(0, COLOR_COMBI.length,
    '#c4423f', '#c9a227', '#6fa83a', '#3fd3c6', '#2f5fb3', '#8e5bc9', '#d9762b', '#1c9c86');

  const visible = () => !$('vistaSetlist').classList.contains('oculto');
  const llenas = () => (cancion()?.combis || []).map((cb, c) => ({ cb, c })).filter(x => combiLlena(x.cb));

  // ---------- Botones de COMBI ----------
  function renderTiles() {
    const box = $('tiles');
    if (!box || !cancion()) return;
    const items = llenas();
    box.innerHTML = items.map(({ cb, c }) => `
      <div class="tile${c === actual ? ' activa' : ''}" data-c="${c}" style="--col:${COLOR_COMBI[c % COLOR_COMBI.length]}">
        <b><i>${c + 1}</i>${esc(nombreCombi(cb))}</b>
        <span class="barraNivel"></span>
      </div>`).join('') ||
      `<div class="tilesVacio">
         <span>Esta canción todavía no tiene COMBIs.</span>
         <button id="irACombis">Crear COMBIs</button>
       </div>`;
  }
  function marcarActiva() {
    $('tiles').querySelectorAll('.tile').forEach(el => el.classList.toggle('activa', +el.dataset.c === actual));
  }

  // Al renderizar la lista de canciones (cambio de canción, deshacer…) también se redibujan los botones
  const renderSetlistBase = renderSetlist;
  renderSetlist = function () { renderSetlistBase(); renderTiles(); };

  // Cualquier cambio de COMBI (toque, MIDI Program Change, traductores) marca el botón activo
  const activarBase = activarCombi;
  activarCombi = function (c) { activarBase(c); marcarActiva(); };

  // Tocar = activar al instante · mantener pulsado o doble clic = editar
  let tPulsar = null;
  const editar = c => { activarCombi(c); mostrarVista('combis'); };
  $('tiles').addEventListener('pointerdown', e => {
    const t = e.target.closest('.tile');
    if (!t) return;
    const c = +t.dataset.c;
    activarCombi(c);
    clearTimeout(tPulsar);
    tPulsar = setTimeout(() => editar(c), 650);
  });
  ['pointerup', 'pointercancel', 'pointerleave'].forEach(ev =>
    $('tiles').addEventListener(ev, () => clearTimeout(tPulsar)));
  $('tiles').addEventListener('dblclick', e => {
    const t = e.target.closest('.tile');
    if (t) editar(+t.dataset.c);
  });
  $('tiles').addEventListener('click', e => {
    if (e.target.id === 'irACombis') mostrarVista('combis');
  });
  $('tiles').addEventListener('contextmenu', e => e.preventDefault());

  // ---------- Teclado de la PC: ← → y 1–9 ----------
  function irRel(d) {
    const cs = cancion().combis;
    let c = actual + d;
    while (c >= 0 && c < cs.length && !combiLlena(cs[c])) c += d;
    if (cs[c]) activarCombi(c);
  }
  document.addEventListener('keydown', e => {
    if (!visible() || esCampo(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === 'ArrowRight') { e.preventDefault(); irRel(1); }
    if (e.key === 'ArrowLeft') { e.preventDefault(); irRel(-1); }
    if (/^[1-9]$/.test(e.key)) {
      const c = +e.key - 1;
      if (combiLlena(cancion().combis[c])) activarCombi(c);
    }
  });

  // ---------- Medidor en vivo del botón activo ----------
  function nivelLoop() {
    if (visible()) {
      const el = $('tiles').querySelector('.tile.activa .barraNivel');
      const cb = cancion()?.combis[actual];
      if (el && cb) {
        let n = 0;
        for (const ch of Object.keys(cb.capas)) n = Math.max(n, canales[ch].nivel);
        el.style.setProperty('--n', Math.min(1, n * 1.4).toFixed(3));
      }
    }
    requestAnimationFrame(nivelLoop);
  }
  requestAnimationFrame(nivelLoop);

  // ---------- Cajón de canciones (☰) ----------
  const abrirCajon = () => { renderSetlistBase(); $('cajon').classList.remove('oculto'); $('cajonFondo').classList.remove('oculto'); };
  const cerrarCajon = () => { $('cajon').classList.add('oculto'); $('cajonFondo').classList.add('oculto'); };
  const alternarCajon = () => ($('cajon').classList.contains('oculto') ? abrirCajon() : cerrarCajon());

  $('btnMenu').onclick = alternarCajon;
  $('cancionTxt').onclick = alternarCajon;
  $('cajonCerrar').onclick = cerrarCajon;
  $('cajonFondo').onclick = cerrarCajon;
  document.addEventListener('keydown', e => { if (e.key === 'Escape') cerrarCajon(); });

  // Al elegir una canción, el cajón se cierra solo
  const elegirBase = elegirCancion;
  elegirCancion = async function (i) {
    if (songs[i]) cerrarCajon();
    return elegirBase(i);
  };
})();
