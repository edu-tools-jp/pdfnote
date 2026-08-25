/* PDFノート — エディタ（縦スクロール連結表示・書き込み・全画面） */
window.PN = window.PN || {};

PN.editor = (function () {
  const $ = (s) => document.querySelector(s);

  const COLORS = ['#e0301e', '#1e6fe0', '#15a05a', '#f0a500', '#1a1a1a', '#ffffff'];
  const WIDTHS = [0.0035, 0.006, 0.010, 0.016];   // ページ幅に対する割合
  const MASK_COLORS = ['#c0392b', '#2d6cdf', '#4a5163'];
  const ZOOM_MIN = 0.25, ZOOM_MAX = 6;
  const PAD = 20;

  /* キャンバス（テクスチャ）の安全な最大寸法。教室の内蔵GPUは上限4096pxのことが多く、
     これを超えるとテクスチャ化できず真っ白になる。WebGLで実機の上限を調べ、
     安全側に 2048〜4096 にクランプして使う（拡大表示はブラウザがテクスチャを拡大）。 */
  let _maxDim = 0;
  function maxCanvasDim() {
    if (_maxDim) return _maxDim;
    let m = 4096;
    try {
      const c = document.createElement('canvas');
      const gl = c.getContext('webgl') || c.getContext('experimental-webgl');
      if (gl) { const v = gl.getParameter(gl.MAX_TEXTURE_SIZE); if (v && isFinite(v)) m = v; }
    } catch (e) { /* WebGL 不可なら既定4096 */ }
    _maxDim = Math.max(2048, Math.min(m, 4096));
    return _maxDim;
  }

  /* 状態 */
  let nb = null, currentIdx = 0;
  let tool = 'pen', color = COLORS[0], widthIdx = 1, maskColor = MASK_COLORS[0];
  let zoom = 1, baseContentW = 1;
  const dprv = () => window.devicePixelRatio || 1;

  let undoStack = [], redoStack = [];   // {idx, before}
  let dirty = false, structureDirty = false, saveTimer = null;
  let viewDirty = false;   // 「最後に開いていたページ」だけが変わった状態（軽い保存対象）

  let pdfCache = {}, imgCache = {}, imgUrls = [];
  let pageViews = [];     // {idx, el, bg, ink, live, mask, *ctx, baseW, baseH, scale, cssW, cssH, rendered, renderToken}
  let gesture = null;

  /* ピンチ・全画面 */
  const ptrs = new Map();
  let one = null, two = null, suppressDraw = false, lastPinchEnd = 0;
  let immersive = false, paletteOpen = false;
  let scrollRAF = null;

  /* DOM */
  let ed, elStage, elScroller, elPages, elNoPages, elFab;

  function init() {
    ed = $('#screen-editor');
    elStage = $('#ed-stage'); elScroller = $('#ed-scroller'); elPages = $('#ed-pages');
    elNoPages = $('#ed-nopages'); elFab = $('#ed-imm-fab');

    buildSwatches();
    buildTextControls();
    bindToolbar();
    bindTouch();
    bindImmersive();
    elScroller.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', debounce(() => { if (nb && nb.pages.length) relayoutAll(); }, 150));
    document.addEventListener('keydown', onKey);
  }

  /* ---------- ツールバー ---------- */
  function buildSwatches() {
    const cs = $('#color-swatches'); cs.innerHTML = '';
    COLORS.forEach((c, i) => {
      const b = document.createElement('span');
      b.className = 'color-swatch' + (i === 0 ? ' active' : '');
      b.style.background = c; b.dataset.color = c;
      b.addEventListener('click', () => { color = c; cs.querySelectorAll('.color-swatch').forEach(x => x.classList.toggle('active', x.dataset.color === c)); });
      cs.appendChild(b);
    });
    const ws = $('#width-btns'); ws.innerHTML = '';
    WIDTHS.forEach((w, i) => {
      const b = document.createElement('button');
      b.className = 'width-btn' + (i === widthIdx ? ' active' : '');
      const d = document.createElement('span'); d.className = 'dot';
      const px = 5 + i * 6; d.style.width = px + 'px'; d.style.height = px + 'px';
      b.appendChild(d);
      b.addEventListener('click', () => { widthIdx = i; ws.querySelectorAll('.width-btn').forEach((x, j) => x.classList.toggle('active', j === i)); });
      ws.appendChild(b);
    });
    const ms = $('#mask-swatches'); ms.innerHTML = '';
    MASK_COLORS.forEach((c, i) => {
      const b = document.createElement('span');
      b.className = 'color-swatch' + (i === 0 ? ' active' : '');
      b.style.background = c; b.dataset.color = c;
      b.addEventListener('click', () => { maskColor = c; ms.querySelectorAll('.color-swatch').forEach(x => x.classList.toggle('active', x.dataset.color === c)); });
      ms.appendChild(b);
    });
  }

  function bindToolbar() {
    document.querySelectorAll('.tool-btn').forEach(b => b.addEventListener('click', () => setTool(b.dataset.tool)));
    $('#ed-back').addEventListener('click', () => PN.app.backToLibrary());
    $('#ed-undo').addEventListener('click', undo);
    $('#ed-redo').addEventListener('click', redo);
    $('#ed-zoom-in').addEventListener('click', () => setZoom(zoom * 1.25));
    $('#ed-zoom-out').addEventListener('click', () => setZoom(zoom * 0.8));
    $('#ed-zoom-fit').addEventListener('click', () => setZoom(1));
    $('#ed-reveal-all').addEventListener('click', () => setAllMasks(true));
    $('#ed-hide-all').addEventListener('click', () => setAllMasks(false));
    $('#ed-prev').addEventListener('click', () => goPage(currentIdx - 1));
    $('#ed-next').addEventListener('click', () => goPage(currentIdx + 1));
    $('#ed-add-page').addEventListener('click', () => PN.app.pickFilesForCurrentNotebook());
    $('#ed-page-list').addEventListener('click', () => PN.pages.open());
    $('#ed-page-menu').addEventListener('click', (e) => pageMenu(e.currentTarget));
  }

  function setTool(t) {
    tool = t;
    document.querySelectorAll('.tool-btn').forEach(b => b.classList.toggle('active', b.dataset.tool === t));
    const isPen = (t === 'pen' || t === 'line');
    $('#grp-color').hidden = !isPen;
    $('#grp-width').hidden = !isPen;
    $('#grp-mask').hidden = (t !== 'mask');
    $('#grp-text').hidden = (t !== 'text');
    if (t !== 'text') selText = null;
    pageViews.forEach(renderTexts);
    // 1本指が書き込みに使われる道具（ペン・直線・消す・かくす枠）のときだけ案内を出す
    const showHint = ['pen', 'line', 'eraser', 'mask'].includes(t);
    const hint = $('#ed-swipe-hint');
    if (hint) hint.hidden = !showHint;
    // 案内を出すあいだは、ボタン群を独立した行にして案内を左端に置く
    ed.classList.toggle('has-hint', showHint);
    elScroller.classList.toggle('panning', t === 'pan');
    updateRouting();
  }

  /* レイヤーのポインタ受付（道具に応じて）。全画面でも通常どおり描ける */
  function updatePVRouting(pv) {
    const drawTool = (tool === 'pen' || tool === 'line' || tool === 'eraser' || tool === 'pan');
    pv.live.style.pointerEvents = drawTool ? 'auto' : 'none';
    pv.mask.style.pointerEvents = (tool === 'mask' || tool === 'reveal') ? 'auto' : 'none';
    pv.text.style.pointerEvents = (tool === 'text') ? 'auto' : 'none';
    pv.ink.style.pointerEvents = 'none';
  }
  function updateRouting() { pageViews.forEach(updatePVRouting); }

  /* ---------- ノートを開く / 閉じる ---------- */
  async function open(notebook) {
    nb = notebook; currentIdx = 0; zoom = 1;
    undoStack = []; redoStack = []; dirty = false; structureDirty = false; viewDirty = false;
    pdfCache = {}; imgCache = {}; imgUrls.forEach(u => URL.revokeObjectURL(u)); imgUrls = [];
    // 全画面状態はリセット（レイアウトのみ）
    selText = null;
    immersive = false; paletteOpen = false; ed.classList.remove('immersive', 'palette-open'); elFab.hidden = true;
    $('#ed-title').textContent = nb.title;
    setTool('pan');   // 開いた直後は「移動」（誤って線を引かないように）
    computeBase();
    if (nb.pages.length) {
      elNoPages.hidden = true; elScroller.style.display = '';
      buildPages();
      const restored = restoreLastPage();   // 前回開いていたページの位置から表示する
      renderVisible();
      // 復元したときは、その位置で確定（スクロール反映待ちで1ページ目に戻らないように）
      if (restored) refreshPageUI(); else updateCurrent();
    }
    else showNoPages();
    setSaveState('saved');
  }

  /* 前回このノートで開いていたページ（nb.lastPageId）へスクロールする。
     ページIDで覚えているので、並べ替えや削除をしても正しいページに戻る。 */
  function restoreLastPage() {
    const id = nb.lastPageId;
    if (!id) return false;
    const i = nb.pages.findIndex(p => p.id === id);
    if (i <= 0) return false;      // 見つからない／1ページ目ならそのまま
    const pv = pageViews[i]; if (!pv) return false;
    currentIdx = i;
    if (pv.el.scrollIntoView) pv.el.scrollIntoView({ block: 'start' });
    return true;
  }
  function showNoPages() { elNoPages.hidden = false; elScroller.style.display = 'none'; elPages.innerHTML = ''; pageViews = []; $('#ed-pagelabel').textContent = '- / -'; }
  async function flushSave() { if (dirty || viewDirty) await saveNow(); }
  async function close() {
    stopGlide();
    await flushSave();
    if (immersive) { ed.classList.remove('immersive', 'palette-open'); if (document.fullscreenElement && document.exitFullscreen) document.exitFullscreen(); immersive = false; }
    imgUrls.forEach(u => URL.revokeObjectURL(u)); imgUrls = []; pdfCache = {}; imgCache = {};
    elPages.innerHTML = ''; pageViews = []; nb = null;
  }

  /* ---------- ページ群の生成・レイアウト ---------- */
  const annOf = (idx) => {
    const p = nb.pages[idx];
    if (!p.annotations) p.annotations = { strokes: [], masks: [], texts: [] };
    if (!p.annotations.texts) p.annotations.texts = [];   // 旧データにも文字入れを追加
    if (!p.annotations.strokes) p.annotations.strokes = [];
    if (!p.annotations.masks) p.annotations.masks = [];
    return p.annotations;
  };
  function computeBase() { baseContentW = Math.max(120, elScroller.clientWidth - PAD * 2); }

  function buildPages() {
    elPages.innerHTML = ''; pageViews = [];
    nb.pages.forEach((p, i) => {
      const el = document.createElement('div'); el.className = 'pageview'; el.dataset.idx = i;
      const bg = mkCanvas('pv-bg'), ink = mkCanvas('layer pv-ink'), live = mkCanvas('layer pv-live');
      const text = document.createElement('div'); text.className = 'layer text-layer pv-text';
      const mask = document.createElement('div'); mask.className = 'layer mask-layer pv-mask';
      const num = document.createElement('div'); num.className = 'pv-num'; num.textContent = (i + 1);
      // 文字はマスクより下（＝かくす枠で答えの文字も隠せる）
      el.append(bg, ink, live, text, mask, num);
      elPages.appendChild(el);
      const pv = {
        idx: i, el, bg, ink, live, mask, text,
        bgctx: bg.getContext('2d'), inkctx: ink.getContext('2d'), livectx: live.getContext('2d'),
        baseW: p.baseW, baseH: p.baseH, scale: 1, cssW: 1, cssH: 1, rendered: false, renderToken: 0
      };
      pageViews.push(pv);
      wirePV(pv);
      layoutPV(pv);
      updatePVRouting(pv);
    });
  }
  function mkCanvas(cls) { const c = document.createElement('canvas'); c.className = cls; return c; }

  function layoutPV(pv) {
    const MAX = maxCanvasDim();
    const contentW = baseContentW * zoom;
    pv.scale = contentW / pv.baseW; pv.cssW = contentW; pv.cssH = pv.baseH * pv.scale;
    pv.el.style.width = pv.cssW + 'px'; pv.el.style.height = pv.cssH + 'px';
    // ink/live のビットマップは MAX(=最大4096) を超えないよう解像度を落とす。表示サイズ(style)は
    // cssW/H のままなので、テクスチャをブラウザが拡大表示する（拡大は効くが白くならない）。
    const r = dprv();
    const safeR = Math.max(0.25, Math.min(r, MAX / Math.max(pv.cssW, 1), MAX / Math.max(pv.cssH, 1)));
    [pv.ink, pv.live].forEach(c => {
      c.width = Math.max(1, Math.round(pv.cssW * safeR));
      c.height = Math.max(1, Math.round(pv.cssH * safeR));
      c.style.width = pv.cssW + 'px'; c.style.height = pv.cssH + 'px';
    });
    pv.inkctx.setTransform(safeR, 0, 0, safeR, 0, 0); pv.livectx.setTransform(safeR, 0, 0, safeR, 0, 0);
    pv.bg.style.width = pv.cssW + 'px'; pv.bg.style.height = pv.cssH + 'px';
  }

  function relayoutAll() {
    if (!pageViews.length) return;
    computeBase();
    pageViews.forEach(pv => {
      layoutPV(pv); pv.rendered = false;
      // 書き込み（線・かくす枠）はここで同期的に描き直す。
      // 背景の再描画（非同期）を待つと、その間だけ線が消えてしまうため。
      if (!pv.freed) { renderInk(pv); renderMasks(pv); renderTexts(pv); }
    });
    renderVisible(); updateCurrent();
  }

  /* 画面に入っているページだけ描画（遅延レンダリング） */
  function renderVisible() {
    if (!pageViews.length) return;
    const sr = elScroller.getBoundingClientRect();
    const margin = sr.height;
    const farMargin = sr.height * 3;
    pageViews.forEach(pv => {
      const r = pv.el.getBoundingClientRect();
      const visible = r.bottom > sr.top - margin && r.top < sr.bottom + margin;
      const far = r.bottom < sr.top - farMargin || r.top > sr.bottom + farMargin;
      if (visible && !pv.rendered) renderPageBg(pv);
      else if (far && pv.rendered) freePageBg(pv);
    });
  }

  /* 画面から大きく離れたページのキャンバスを 1×1 に縮めてメモリを解放
     （強拡大での累積メモリ枯渇＝白化を防ぐ） */
  function freePageBg(pv) {
    if (pv.renderTask) { try { pv.renderTask.cancel(); } catch (e) {} pv.renderTask = null; }
    pv.renderToken++;
    [pv.bg, pv.ink, pv.live].forEach(c => { c.width = 1; c.height = 1; });
    pv.rendered = false;
    pv.freed = true;
  }

  async function renderPageBg(pv) {
    // 既に走っている描画タスクがあればキャンセル（連続拡大で空のまま残るのを防ぐ）
    if (pv.renderTask) { try { pv.renderTask.cancel(); } catch (e) {} pv.renderTask = null; }
    // 解放されていたキャンバスを再確保
    if (pv.freed) { layoutPV(pv); pv.freed = false; }
    const token = ++pv.renderToken; pv.rendered = true;
    const p = nb.pages[pv.idx];
    const MAX_DIM = maxCanvasDim();   // ビットマップ寸法の安全上限（内蔵GPU対策）
    let ok = false;
    try {
      if (p.type === 'pdf') {
        const doc = await getPdfDoc(p.asset); if (token !== pv.renderToken) return;
        const page = await doc.getPage(p.pageIndex + 1); if (token !== pv.renderToken) return;
        const ideal = pv.scale * dprv();
        const safeScale = Math.max(0.05, Math.min(ideal, MAX_DIM / pv.baseW, MAX_DIM / pv.baseH));
        const vp = page.getViewport({ scale: safeScale });
        // ★ いったんオフスクリーンに描いてから差し替える。
        //   表示中のキャンバスを先に消してしまうと、描き終わるまで白く見えてしまうため。
        const off = document.createElement('canvas');
        off.width = Math.round(vp.width); off.height = Math.round(vp.height);
        const offctx = off.getContext('2d');
        offctx.fillStyle = '#fff'; offctx.fillRect(0, 0, off.width, off.height);
        const task = page.render({ canvasContext: offctx, viewport: vp });
        pv.renderTask = task;
        await task.promise;
        pv.renderTask = null;
        if (token !== pv.renderToken) return;
        // ここから下は同期処理なので、途中の空白状態が画面に出ない
        pv.bg.width = off.width; pv.bg.height = off.height;
        pv.bg.style.width = pv.cssW + 'px'; pv.bg.style.height = pv.cssH + 'px';
        pv.bgctx.setTransform(1, 0, 0, 1, 0, 0);
        pv.bgctx.drawImage(off, 0, 0);
        ok = true;
      } else {
        const img = await getImage(p.asset); if (token !== pv.renderToken) return;
        const ideal = dprv();
        const safeR = Math.max(0.05, Math.min(ideal, MAX_DIM / pv.cssW, MAX_DIM / pv.cssH));
        pv.bg.width = Math.max(1, Math.round(pv.cssW * safeR)); pv.bg.height = Math.max(1, Math.round(pv.cssH * safeR));
        pv.bg.style.width = pv.cssW + 'px'; pv.bg.style.height = pv.cssH + 'px';
        pv.bgctx.setTransform(1, 0, 0, 1, 0, 0);
        pv.bgctx.clearRect(0, 0, pv.bg.width, pv.bg.height);
        pv.bgctx.drawImage(img, 0, 0, pv.bg.width, pv.bg.height);
        ok = true;
      }
    } catch (e) {
      pv.renderTask = null;
      if (e && e.name === 'RenderingCancelledException') return;
      console.error('ページ描画エラー', e);
    }
    if (token !== pv.renderToken) return;
    if (!ok) { pv.rendered = false; return; }   // 失敗時は再試行できるよう戻す
    renderInk(pv); renderMasks(pv); renderTexts(pv);
  }

  function clearCtx(canvas, ctx) { ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, canvas.width, canvas.height); ctx.restore(); }

  function renderInk(pv) {
    clearCtx(pv.ink, pv.inkctx);
    annOf(pv.idx).strokes.forEach(s => drawStroke(pv.inkctx, s, pv));
  }
  function drawStroke(ctx, s, pv) {
    const pts = s.points; if (!pts || !pts.length) return;
    ctx.strokeStyle = s.color; ctx.fillStyle = s.color; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    const baseCss = s.width * pv.cssW;
    if (pts.length === 1) { const w = strokeW(baseCss, pts[0][2]); ctx.beginPath(); ctx.arc(pts[0][0] * pv.scale, pts[0][1] * pv.scale, Math.max(0.4, w / 2), 0, Math.PI * 2); ctx.fill(); return; }
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i];
      ctx.lineWidth = strokeW(baseCss, b[2]);
      ctx.beginPath(); ctx.moveTo(a[0] * pv.scale, a[1] * pv.scale); ctx.lineTo(b[0] * pv.scale, b[1] * pv.scale); ctx.stroke();
    }
  }
  function strokeW(base, pressure) { let p = pressure; if (!p || p <= 0) p = 0.5; return Math.max(0.4, base * (0.5 + p)); }

  /* ---------- マスク（答えかくし） ---------- */
  function renderMasks(pv) {
    pv.mask.innerHTML = '';
    const editing = (tool === 'mask');
    annOf(pv.idx).masks.forEach((m, idx) => {
      const d = document.createElement('div');
      d.className = 'mask' + (editing ? ' editing' : '') + (m.revealed ? ' revealed' : '');
      d.style.setProperty('--mask-color', m.color || maskColor);
      d.style.left = (m.x / pv.baseW * 100) + '%'; d.style.top = (m.y / pv.baseH * 100) + '%';
      d.style.width = (m.w / pv.baseW * 100) + '%'; d.style.height = (m.h / pv.baseH * 100) + '%';
      d.dataset.idx = idx;
      if (editing) {
        const del = document.createElement('button'); del.className = 'mask-del'; del.textContent = '×';
        del.addEventListener('click', (e) => { e.stopPropagation(); pushUndo(pv.idx); annOf(pv.idx).masks.splice(idx, 1); renderMasks(pv); markDirty(); });
        d.appendChild(del);
      }
      pv.mask.appendChild(d);
    });
  }
  function toggleReveal(pv, idx) {
    const m = annOf(pv.idx).masks[idx]; if (!m) return;
    m.revealed = !m.revealed;
    const child = pv.mask.querySelector('.mask[data-idx="' + idx + '"]');
    if (child) child.classList.toggle('revealed', m.revealed);
    markDirty();
  }
  function setAllMasks(reveal) {
    const pv = pageViews[currentIdx]; if (!pv) return;
    annOf(currentIdx).masks.forEach(m => { m.revealed = reveal; });
    renderMasks(pv); markDirty();
  }

  /* ========== 文字入れ（テキストボックス） ========== */

  /* すぐ使えるフォント（Windows標準。端末のフォント一覧も後から読み込める） */
  const BASE_FONTS = [
    { label: 'ゴシック体（游ゴシック）', css: '"Yu Gothic UI","Yu Gothic","Meiryo",sans-serif' },
    { label: 'ゴシック体（メイリオ）', css: '"Meiryo","Yu Gothic UI",sans-serif' },
    { label: 'ゴシック体（MS ゴシック）', css: '"MS Gothic","Yu Gothic UI",monospace' },
    { label: '明朝体（游明朝）', css: '"Yu Mincho","MS Mincho",serif' },
    { label: '明朝体（MS 明朝）', css: '"MS Mincho","Yu Mincho",serif' },
    { label: '教科書体（UD デジタル教科書体）', css: '"UD Digi Kyokasho N-R","UD Digi Kyokasho NK-R","Yu Gothic UI",sans-serif' },
    { label: '丸ゴシック（BIZ UDP）', css: '"BIZ UDPGothic","Yu Gothic UI",sans-serif' },
    { label: '欧文（Arial）', css: 'Arial,Helvetica,sans-serif' },
    { label: '欧文（Times）', css: '"Times New Roman",Times,serif' }
  ];
  const TEXT_SIZES = [10, 12, 14, 16, 18, 20, 24, 28, 32, 40, 48, 64, 80];
  const TEXT_COLORS = ['#1a1a1a', '#e0301e', '#1e6fe0', '#15a05a', '#f0a500', '#ffffff'];

  /* 新しいテキストボックスに使う書式（最後に使った設定を覚えておく） */
  let textStyle = { font: BASE_FONTS[0].css, size: 20, color: '#1a1a1a', bold: false, align: 'left', vertical: false, bg: 'none' };
  let selText = null;        // { pv, idx } 選択中のテキストボックス
  let localFontsLoaded = false;

  const textsOf = (idx) => annOf(idx).texts;

  /* ---- 端末に入っているフォントを読み込む（Chrome/Edge の対応時のみ） ---- */
  async function loadLocalFonts() {
    if (localFontsLoaded) return true;
    if (!window.queryLocalFonts) { PN.ui.toast('このブラウザでは端末のフォント一覧を読み込めません'); return false; }
    try {
      const fonts = await window.queryLocalFonts();
      const seen = new Set(BASE_FONTS.map(f => f.label));
      const extra = [];
      fonts.forEach(f => {
        const fam = f.family;
        if (!fam || seen.has(fam)) return;
        seen.add(fam);
        extra.push({ label: fam, css: '"' + fam.replace(/"/g, '') + '"' });
      });
      extra.sort((a, b) => a.label.localeCompare(b.label, 'ja'));
      const sel = $('#text-font');
      const grp = document.createElement('optgroup');
      grp.label = 'この端末のフォント';
      extra.forEach(f => { const o = document.createElement('option'); o.value = f.css; o.textContent = f.label; grp.appendChild(o); });
      sel.appendChild(grp);
      localFontsLoaded = true;
      PN.ui.toast(extra.length + ' 個のフォントを読み込みました');
      return true;
    } catch (e) {
      if (e && e.name === 'NotAllowedError') PN.ui.toast('フォントの読み込みが許可されませんでした');
      else { console.error(e); PN.ui.toast('フォントを読み込めませんでした'); }
      return false;
    }
  }

  /* ---- 書式パネルの組み立て ---- */
  function buildTextControls() {
    const sel = $('#text-font');
    if (sel && !sel.options.length) {
      const grp = document.createElement('optgroup');
      grp.label = 'よく使うフォント';
      BASE_FONTS.forEach(f => { const o = document.createElement('option'); o.value = f.css; o.textContent = f.label; grp.appendChild(o); });
      sel.appendChild(grp);
      sel.value = textStyle.font;
      sel.addEventListener('change', () => applyTextStyle({ font: sel.value }));
    }
    const size = $('#text-size');
    if (size && !size.options.length) {
      TEXT_SIZES.forEach(s => { const o = document.createElement('option'); o.value = s; o.textContent = s; size.appendChild(o); });
      size.value = textStyle.size;
      size.addEventListener('change', () => applyTextStyle({ size: +size.value }));
    }
    const cs = $('#text-colors');
    if (cs && !cs.children.length) {
      TEXT_COLORS.forEach((c, i) => {
        const b = document.createElement('span');
        b.className = 'color-swatch' + (i === 0 ? ' active' : '');
        b.style.background = c; b.dataset.color = c;
        b.addEventListener('click', () => applyTextStyle({ color: c }));
        cs.appendChild(b);
      });
    }
    $('#text-bold').addEventListener('click', () => applyTextStyle({ bold: !textStyle.bold }));
    $('#text-vertical').addEventListener('click', () => applyTextStyle({ vertical: !textStyle.vertical }));
    $('#text-bg').addEventListener('click', () => applyTextStyle({ bg: textStyle.bg === 'white' ? 'none' : 'white' }));
    document.querySelectorAll('#grp-text [data-align]').forEach(b => {
      b.addEventListener('click', () => applyTextStyle({ align: b.dataset.align }));
    });
    $('#text-load-fonts').addEventListener('click', loadLocalFonts);
    $('#text-delete').addEventListener('click', deleteSelectedText);
    syncTextControls();
  }

  /* 書式パネルの表示を、いまの設定（または選択中のボックス）に合わせる */
  function syncTextControls() {
    const t = selectedTextObj() || textStyle;
    const sel = $('#text-font'); if (sel) sel.value = t.font;
    const size = $('#text-size'); if (size) size.value = t.size;
    document.querySelectorAll('#text-colors .color-swatch').forEach(s => s.classList.toggle('active', s.dataset.color === t.color));
    $('#text-bold').classList.toggle('active', !!t.bold);
    $('#text-vertical').classList.toggle('active', !!t.vertical);
    $('#text-bg').classList.toggle('active', t.bg === 'white');
    document.querySelectorAll('#grp-text [data-align]').forEach(b => b.classList.toggle('active', b.dataset.align === (t.align || 'left')));
    $('#text-delete').disabled = !selText;
  }
  function selectedTextObj() {
    if (!selText) return null;
    const arr = textsOf(selText.pv.idx);
    return arr ? arr[selText.idx] : null;
  }

  /* 書式の変更。選択中のボックスがあればそれに適用、無ければ次に作る文字の設定に */
  function applyTextStyle(patch) {
    Object.assign(textStyle, patch);
    const t = selectedTextObj();
    if (t) {
      pushUndo(selText.pv.idx);
      Object.assign(t, patch);
      renderTexts(selText.pv);
      markDirty();
    }
    syncTextControls();
  }

  /* ---- 描画（DOM） ---- */
  function renderTexts(pv) {
    pv.text.innerHTML = '';
    if (!nb || !nb.pages.length) return;
    const editing = (tool === 'text');
    textsOf(pv.idx).forEach((t, idx) => {
      const el = document.createElement('div');
      el.className = 'textbox' + (editing ? ' editing' : '') +
        (selText && selText.pv === pv && selText.idx === idx ? ' selected' : '');
      el.dataset.idx = idx;
      el.style.left = (t.x / pv.baseW * 100) + '%';
      el.style.top = (t.y / pv.baseH * 100) + '%';
      el.style.width = (t.w / pv.baseW * 100) + '%';
      el.style.height = (t.h / pv.baseH * 100) + '%';
      if (t.bg === 'white') el.style.background = '#fff';

      const body = document.createElement('div');
      body.className = 'tb-body';
      body.style.fontFamily = t.font;
      body.style.fontSize = (t.size * pv.scale) + 'px';
      body.style.color = t.color;
      body.style.fontWeight = t.bold ? '700' : '400';
      body.style.textAlign = t.align || 'left';
      if (t.vertical) body.style.writingMode = 'vertical-rl';
      body.textContent = t.text || '';
      if (editing) { body.contentEditable = 'true'; body.spellcheck = false; }
      el.appendChild(body);

      if (editing) {
        const mv = document.createElement('button'); mv.className = 'tb-move'; mv.textContent = '✥'; mv.title = 'ドラッグで移動';
        const del = document.createElement('button'); del.className = 'tb-del'; del.textContent = '×'; del.title = '削除';
        const rs = document.createElement('button'); rs.className = 'tb-resize'; rs.title = 'ドラッグで大きさ変更';
        el.append(mv, del, rs);
        wireTextBox(pv, el, idx, body, mv, del, rs);
      }
      pv.text.appendChild(el);
    });
    syncTextControls();
  }

  /* ---- 1つのテキストボックスの操作 ---- */
  function wireTextBox(pv, el, idx, body, mv, del, rs) {
    body.addEventListener('pointerdown', (e) => { e.stopPropagation(); selectText(pv, idx); });
    body.addEventListener('input', () => { textsOf(pv.idx)[idx].text = body.innerText; markDirty(); });
    body.addEventListener('blur', () => {
      const t = textsOf(pv.idx)[idx];
      if (t && !(t.text || '').trim()) {        // 空のまま離れたら消す
        textsOf(pv.idx).splice(idx, 1);
        if (selText && selText.pv === pv && selText.idx === idx) selText = null;
        renderTexts(pv); markDirty();
      }
    });
    del.addEventListener('pointerdown', (e) => e.stopPropagation());
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      pushUndo(pv.idx);
      textsOf(pv.idx).splice(idx, 1);
      selText = null; renderTexts(pv); markDirty();
    });
    mv.addEventListener('pointerdown', (e) => startTextDrag(e, pv, idx, 'move', el));
    rs.addEventListener('pointerdown', (e) => startTextDrag(e, pv, idx, 'resize', el));
  }

  function selectText(pv, idx) {
    selText = { pv, idx };
    pv.text.querySelectorAll('.textbox').forEach(b => b.classList.toggle('selected', +b.dataset.idx === idx));
    syncTextControls();
  }
  function deleteSelectedText() {
    const t = selectedTextObj(); if (!t) return;
    const { pv, idx } = selText;
    pushUndo(pv.idx);
    textsOf(pv.idx).splice(idx, 1);
    selText = null; renderTexts(pv); markDirty();
  }

  /* 移動・サイズ変更 */
  let textDrag = null;
  function startTextDrag(e, pv, idx, mode, el) {
    e.preventDefault(); e.stopPropagation();
    const t = textsOf(pv.idx)[idx]; if (!t) return;
    selectText(pv, idx);
    pushUndo(pv.idx);
    textDrag = { pv, idx, mode, el, startX: e.clientX, startY: e.clientY, x0: t.x, y0: t.y, w0: t.w, h0: t.h };
    try { el.setPointerCapture(e.pointerId); } catch (err) {}
    document.addEventListener('pointermove', onTextDragMove);
    document.addEventListener('pointerup', endTextDrag);
  }
  function onTextDragMove(e) {
    if (!textDrag) return;
    const { pv, idx, mode } = textDrag;
    const t = textsOf(pv.idx)[idx]; if (!t) return;
    const dx = (e.clientX - textDrag.startX) / pv.scale;
    const dy = (e.clientY - textDrag.startY) / pv.scale;
    if (mode === 'move') {
      t.x = Math.max(0, Math.min(pv.baseW - t.w, textDrag.x0 + dx));
      t.y = Math.max(0, Math.min(pv.baseH - t.h, textDrag.y0 + dy));
      textDrag.el.style.left = (t.x / pv.baseW * 100) + '%';
      textDrag.el.style.top = (t.y / pv.baseH * 100) + '%';
    } else {
      t.w = Math.max(40, Math.min(pv.baseW - t.x, textDrag.w0 + dx));
      t.h = Math.max(24, Math.min(pv.baseH - t.y, textDrag.h0 + dy));
      textDrag.el.style.width = (t.w / pv.baseW * 100) + '%';
      textDrag.el.style.height = (t.h / pv.baseH * 100) + '%';
    }
  }
  function endTextDrag() {
    if (!textDrag) return;
    document.removeEventListener('pointermove', onTextDragMove);
    document.removeEventListener('pointerup', endTextDrag);
    textDrag = null;
    markDirty();
  }

  /* 何もない所をタップ＝新しいテキストボックスを作る */
  function onTextLayerDown(e, pv) {
    if (tool !== 'text' || suppressDraw) return;
    if (e.target.closest('.textbox')) return;      // 既存のボックス上なら何もしない
    const [x, y] = toIntrinsic(e, pv);
    pushUndo(pv.idx);
    const t = {
      x: Math.max(0, Math.min(pv.baseW - 200, x)), y: Math.max(0, Math.min(pv.baseH - 40, y)),
      w: Math.min(260, pv.baseW - x), h: Math.max(40, textStyle.size * 2),
      text: '', font: textStyle.font, size: textStyle.size, color: textStyle.color,
      bold: textStyle.bold, align: textStyle.align, vertical: textStyle.vertical, bg: textStyle.bg
    };
    const arr = textsOf(pv.idx);
    arr.push(t);
    selText = { pv, idx: arr.length - 1 };
    renderTexts(pv);
    markDirty();
    // 作った直後に入力できるようにする
    const el = pv.text.querySelector('.textbox[data-idx="' + (arr.length - 1) + '"] .tb-body');
    if (el) setTimeout(() => el.focus(), 0);
  }

  /* ---------- 入力 ---------- */
  function wirePV(pv) {
    pv.live.addEventListener('pointerdown', (e) => onDown(e, pv));
    pv.live.addEventListener('pointermove', (e) => onMove(e, pv));
    pv.live.addEventListener('pointerup', (e) => onUp(e, pv));
    pv.live.addEventListener('pointercancel', (e) => onUp(e, pv));
    pv.mask.addEventListener('pointerdown', (e) => onMaskDown(e, pv));
    pv.mask.addEventListener('pointermove', (e) => onMaskMove(e, pv));
    pv.mask.addEventListener('pointerup', (e) => onMaskUp(e, pv));
    pv.mask.addEventListener('click', (e) => onMaskClick(e, pv));
    pv.text.addEventListener('pointerdown', (e) => onTextLayerDown(e, pv));
  }
  function toIntrinsic(e, pv) {
    const r = pv.el.getBoundingClientRect();
    let x = (e.clientX - r.left) / pv.scale, y = (e.clientY - r.top) / pv.scale;
    return [Math.max(0, Math.min(pv.baseW, x)), Math.max(0, Math.min(pv.baseH, y))];
  }

  let liveDrawnUpTo = 0;
  function onDown(e, pv) {
    if (!nb || suppressDraw) return;
    stopGlide();                       // 描き始めたら慣性は止める
    if (gesture) return;                 // 既に1本で描画中：他の指（手のひら等）は無視
    if (tool === 'pan' && e.pointerType === 'touch') return;  // 指の移動は elPages 側で1本指スクロール
    pv.live.setPointerCapture(e.pointerId); liveDrawnUpTo = 0;
    const [x, y] = toIntrinsic(e, pv);
    const common = { pv, pointerId: e.pointerId, downX: e.clientX, downY: e.clientY, downT: Date.now() };
    if (tool === 'pan') { gesture = Object.assign(common, { type: 'pan', sx: e.clientX, sy: e.clientY, l: elScroller.scrollLeft, t: elScroller.scrollTop }); return; }
    if (tool === 'eraser') { gesture = Object.assign(common, { type: 'erase', before: structuredClone(annOf(pv.idx)), changed: false }); eraseAt(pv, x, y); return; }
    const p = (e.pressure && e.pressure > 0) ? e.pressure : (e.pointerType === 'pen' ? 0 : 0.5);
    gesture = Object.assign(common, { type: tool, color, width: WIDTHS[widthIdx], points: [[x, y, p]] });
  }
  function onMove(e, pv) {
    if (!gesture || gesture.pv !== pv) return;
    if (gesture.type === 'pan') { elScroller.scrollLeft = gesture.l - (e.clientX - gesture.sx); elScroller.scrollTop = gesture.t - (e.clientY - gesture.sy); return; }
    if (gesture.type === 'erase') { const [x, y] = toIntrinsic(e, pv); eraseAt(pv, x, y); return; }
    if (gesture.type === 'pen') {
      const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
      evs.forEach(ev => { const [x, y] = toIntrinsic(ev, pv); const p = (ev.pressure && ev.pressure > 0) ? ev.pressure : 0.5; gesture.points.push([x, y, p]); });
      drawLiveIncremental(pv);
    } else if (gesture.type === 'line') {
      const [x, y] = toIntrinsic(e, pv); gesture.points[1] = [x, y, 0.5];
      clearCtx(pv.live, pv.livectx); drawStroke(pv.livectx, gesture, pv);
    }
  }
  function drawLiveIncremental(pv) {
    const pts = gesture.points, baseCss = gesture.width * pv.cssW;
    pv.livectx.strokeStyle = gesture.color; pv.livectx.lineCap = 'round'; pv.livectx.lineJoin = 'round';
    for (let i = Math.max(1, liveDrawnUpTo); i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i];
      pv.livectx.lineWidth = strokeW(baseCss, b[2]);
      pv.livectx.beginPath(); pv.livectx.moveTo(a[0] * pv.scale, a[1] * pv.scale); pv.livectx.lineTo(b[0] * pv.scale, b[1] * pv.scale); pv.livectx.stroke();
    }
    liveDrawnUpTo = pts.length;
  }
  function onUp(e, pv) {
    if (!gesture || gesture.pv !== pv) return;
    try { pv.live.releasePointerCapture(e.pointerId); } catch (err) {}
    const g = gesture; gesture = null; liveDrawnUpTo = 0;
    if (g.type === 'pan') return;
    if (g.type === 'erase') { if (g.changed) { pushUndoSnap(pv.idx, g.before); markDirty(); } return; }
    if (g.type === 'line' && g.points.length < 2) { clearCtx(pv.live, pv.livectx); return; }
    if (g.points.length) {
      pushUndo(pv.idx);
      annOf(pv.idx).strokes.push({ tool: g.type, color: g.color, width: g.width, points: g.points });
      clearCtx(pv.live, pv.livectx); renderInk(pv); markDirty();
    }
  }
  function eraseAt(pv, x, y) {
    const ann = annOf(pv.idx); const radius = 12 / pv.scale; let removed = false;
    for (let i = ann.strokes.length - 1; i >= 0; i--) if (strokeHit(ann.strokes[i], x, y, radius, pv)) { ann.strokes.splice(i, 1); removed = true; }
    if (removed) { gesture.changed = true; renderInk(pv); }
  }
  function strokeHit(s, x, y, radius, pv) {
    const pts = s.points, tol = radius + s.width * pv.baseW;
    if (pts.length === 1) return Math.hypot(pts[0][0] - x, pts[0][1] - y) <= tol;
    for (let i = 1; i < pts.length; i++) if (distToSeg(x, y, pts[i - 1], pts[i]) <= tol) return true;
    return false;
  }
  function distToSeg(px, py, a, b) {
    const dx = b[0] - a[0], dy = b[1] - a[1], len2 = dx * dx + dy * dy;
    let t = len2 ? ((px - a[0]) * dx + (py - a[1]) * dy) / len2 : 0; t = Math.max(0, Math.min(1, t));
    return Math.hypot(px - (a[0] + t * dx), py - (a[1] + t * dy));
  }

  /* マスク作成・めくり */
  let maskGesture = null;
  function onMaskDown(e, pv) {
    if (tool !== 'mask' || !nb || suppressDraw || (immersive && !paletteOpen)) return;
    if (e.target.classList.contains('mask-del')) return;
    pv.mask.setPointerCapture(e.pointerId);
    const [x, y] = toIntrinsic(e, pv);
    maskGesture = { pv, x0: x, y0: y, el: null, pointerId: e.pointerId };
  }
  function onMaskMove(e, pv) {
    if (!maskGesture || maskGesture.pv !== pv) return;
    const [x, y] = toIntrinsic(e, pv);
    if (!maskGesture.el) { maskGesture.el = document.createElement('div'); maskGesture.el.className = 'mask editing'; maskGesture.el.style.setProperty('--mask-color', maskColor); pv.mask.appendChild(maskGesture.el); }
    const x1 = Math.min(maskGesture.x0, x), y1 = Math.min(maskGesture.y0, y), w = Math.abs(x - maskGesture.x0), h = Math.abs(y - maskGesture.y0);
    const el = maskGesture.el;
    el.style.left = (x1 / pv.baseW * 100) + '%'; el.style.top = (y1 / pv.baseH * 100) + '%';
    el.style.width = (w / pv.baseW * 100) + '%'; el.style.height = (h / pv.baseH * 100) + '%';
    maskGesture.rect = { x: x1, y: y1, w, h };
  }
  function onMaskUp(e, pv) {
    if (!maskGesture || maskGesture.pv !== pv) return;
    try { pv.mask.releasePointerCapture(e.pointerId); } catch (err) {}
    const g = maskGesture; maskGesture = null;
    if (g.rect && g.rect.w * pv.scale > 6 && g.rect.h * pv.scale > 6) {
      pushUndo(pv.idx);
      annOf(pv.idx).masks.push({ x: g.rect.x, y: g.rect.y, w: g.rect.w, h: g.rect.h, color: maskColor, revealed: false });
      markDirty();
    }
    renderMasks(pv);
  }
  function onMaskClick(e, pv) {
    if (suppressDraw || Date.now() - lastPinchEnd < 350) return;
    const m = e.target.closest('.mask');
    if (tool === 'reveal' && m) toggleReveal(pv, +m.dataset.idx);
  }

  /* 進行中の描画を破棄（ピンチ開始時など） */
  function cancelGesture() {
    if (gesture) { try { gesture.pv.live.releasePointerCapture(gesture.pointerId); } catch (e) {} clearCtx(gesture.pv.live, gesture.pv.livectx); gesture = null; liveDrawnUpTo = 0; }
    if (maskGesture) { try { maskGesture.pv.mask.releasePointerCapture(maskGesture.pointerId); } catch (e) {} if (maskGesture.el) maskGesture.el.remove(); maskGesture = null; }
  }

  /* ---------- 元に戻す / やり直す ---------- */
  function pushUndo(idx) { undoStack.push({ idx, before: structuredClone(annOf(idx)) }); if (undoStack.length > 80) undoStack.shift(); redoStack = []; }
  function pushUndoSnap(idx, before) { undoStack.push({ idx, before }); if (undoStack.length > 80) undoStack.shift(); redoStack = []; }
  function undo() {
    if (!undoStack.length) return;
    const e = undoStack.pop();
    redoStack.push({ idx: e.idx, before: structuredClone(annOf(e.idx)) });
    nb.pages[e.idx].annotations = e.before;
    const pv = pageViews[e.idx]; if (pv) { renderInk(pv); renderMasks(pv); renderTexts(pv); }
    markDirty();
  }
  function redo() {
    if (!redoStack.length) return;
    const e = redoStack.pop();
    undoStack.push({ idx: e.idx, before: structuredClone(annOf(e.idx)) });
    nb.pages[e.idx].annotations = e.before;
    const pv = pageViews[e.idx]; if (pv) { renderInk(pv); renderMasks(pv); renderTexts(pv); }
    markDirty();
  }

  /* ---------- ズーム ---------- */
  function setZoom(z) { stopGlide(); zoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z)); relayoutAll(); }

  /* ---------- ページ移動・現在ページ ---------- */
  function goPage(i) { if (!nb || i < 0 || i >= nb.pages.length || !pageViews[i]) return; stopGlide(); pageViews[i].el.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
  function onScroll() { if (scrollRAF) return; scrollRAF = requestAnimationFrame(() => { scrollRAF = null; renderVisible(); updateCurrent(); }); }
  function updateCurrent() {
    if (!pageViews.length) return;
    const sr = elScroller.getBoundingClientRect(), cy = sr.top + sr.height / 2;
    let best = 0, bestD = Infinity;
    pageViews.forEach(pv => { const r = pv.el.getBoundingClientRect(); const d = Math.abs((r.top + r.height / 2) - cy); if (d < bestD) { bestD = d; best = pv.idx; } });
    currentIdx = best;
    refreshPageUI();
  }

  /* ページ番号の表示と前後ボタンの状態、そして「最後に開いていたページ」の記録 */
  function refreshPageUI() {
    if (!nb || !nb.pages.length) return;
    // 次に開いたときのために覚えておく（保存は次の保存時にまとめて）
    const curId = nb.pages[currentIdx] && nb.pages[currentIdx].id;
    if (curId && nb.lastPageId !== curId) { nb.lastPageId = curId; viewDirty = true; }
    $('#ed-pagelabel').textContent = (currentIdx + 1) + ' / ' + nb.pages.length;
    $('#ed-prev').disabled = currentIdx <= 0; $('#ed-next').disabled = currentIdx >= nb.pages.length - 1;
  }

  /* ---------- 保存 ---------- */
  function markDirty() { dirty = true; setSaveState('saving'); clearTimeout(saveTimer); saveTimer = setTimeout(saveNow, 700); }
  function setSaveState(s) { $('#ed-save-state').textContent = s === 'saving' ? '保存中…' : s === 'saved' ? '保存済み ✓' : ''; }
  async function saveNow() {
    if (!nb) return; clearTimeout(saveTimer);
    const viewOnly = !dirty && viewDirty;   // 中身は変わらず、見ていたページだけ変わった
    try {
      await PN.storage.saveNotebook(nb, { touch: !viewOnly });
      if (structureDirty) { structureDirty = false; await regenThumb(); }
      dirty = false; viewDirty = false; setSaveState('saved');
    } catch (e) { console.error('保存エラー', e); setSaveState(''); PN.ui.toast('保存に失敗しました。フォルダの権限を確認してください'); }
  }

  /* ---------- 全画面（イマーシブ） ---------- */
  function bindImmersive() {
    $('#ed-immersive').addEventListener('click', () => immersive ? exitImmersive() : enterImmersive());
    $('#ed-imm-hide').addEventListener('click', closePalette);
    elFab.addEventListener('click', openPalette);
    document.addEventListener('fullscreenchange', () => {
      if (!document.fullscreenElement && immersive) exitImmersive();
      else if (nb && nb.pages.length) setTimeout(relayoutAll, 60);
    });
  }
  function enterImmersive() {
    immersive = true; paletteOpen = false;
    ed.classList.add('immersive'); ed.classList.remove('palette-open');
    elFab.hidden = false;
    const btn = $('#ed-immersive'); btn.textContent = '⤡ 全画面解除'; btn.title = '全画面を解除する';
    const el = document.documentElement; const p = el.requestFullscreen && el.requestFullscreen(); if (p && p.catch) p.catch(() => {});
    updateRouting();
    setTimeout(relayoutAll, 80);
    PN.ui.toast('全画面：そのままペンで書けます。2本指でスクロール／ピンチ拡大、「☰」でメニュー');
  }
  function exitImmersive() {
    immersive = false; paletteOpen = false;
    ed.classList.remove('immersive', 'palette-open'); elFab.hidden = true;
    const btn = $('#ed-immersive'); btn.textContent = '⛶ 全画面'; btn.title = '全画面（メニューを隠してPDFを大きく映す）';
    if (document.fullscreenElement && document.exitFullscreen) document.exitFullscreen();
    updateRouting();
    setTimeout(relayoutAll, 80);
  }
  function openPalette() { paletteOpen = true; ed.classList.add('palette-open'); elFab.hidden = true; updateRouting(); }
  function closePalette() { paletteOpen = false; ed.classList.remove('palette-open'); if (immersive) elFab.hidden = false; updateRouting(); }

  /* ---------- 慣性スクロール（指を離したあとスッと滑って止まる） ---------- */
  const FRICTION = 0.96;    // 1フレームごとの減速率（小さいほど早く止まる）
  const MIN_V = 0.02;       // これ未満の速さになったら停止（px/ms）
  const MAX_V = 3;          // 速すぎる勢いは頭打ちに（px/ms）
  let glide = null;         // 慣性アニメーションのID

  const nowMs = () => (window.performance && performance.now ? performance.now() : Date.now());
  function stopGlide() { if (glide) { cancelAnimationFrame(glide); glide = null; } }
  /* 速度の記録（指の動き px/ms を、直近の動きを重めにならして保持） */
  function trackVelocity(g, dx, dy, t) {
    const dt = t - g.lastT;
    if (dt <= 0) return;
    g.lastT = t;
    const nvx = dx / dt, nvy = dy / dt;
    g.vx = g.vx * 0.6 + nvx * 0.4;
    g.vy = g.vy * 0.6 + nvy * 0.4;
  }
  function startGlide(vx, vy) {
    stopGlide();
    const clamp = (v) => Math.max(-MAX_V, Math.min(MAX_V, v));
    vx = clamp(vx); vy = clamp(vy);
    if (Math.abs(vx) < MIN_V && Math.abs(vy) < MIN_V) return;   // ほぼ止まっているなら何もしない
    let last = nowMs();
    const step = () => {
      const t = nowMs();
      const dt = Math.min(64, t - last); last = t;              // 64ms 上限（タブ復帰時の飛びを防ぐ）
      const decay = Math.pow(FRICTION, dt / 16.67);
      vx *= decay; vy *= decay;
      const beforeL = elScroller.scrollLeft, beforeT = elScroller.scrollTop;
      elScroller.scrollLeft -= vx * dt;
      elScroller.scrollTop -= vy * dt;
      // 端に着いたらその方向の勢いは打ち切る
      if (Math.abs(elScroller.scrollLeft - beforeL) < 0.01) vx = 0;
      if (Math.abs(elScroller.scrollTop - beforeT) < 0.01) vy = 0;
      if (Math.abs(vx) < MIN_V && Math.abs(vy) < MIN_V) { glide = null; return; }
      glide = requestAnimationFrame(step);
    };
    glide = requestAnimationFrame(step);
  }

  /* ---------- 指の操作：1本指スクロール（ビュー道具）＋ 2本指スクロール/ピンチ ---------- */
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const isViewTool = () => (tool === 'pan' || tool === 'reveal');   // ペン系以外＝1本指でスクロール

  function bindTouch() {
    elPages.addEventListener('pointerdown', onTouchDown, true);
    document.addEventListener('pointermove', onTouchMove);
    document.addEventListener('pointerup', onTouchUp);
    document.addEventListener('pointercancel', onTouchUp);
  }
  function onTouchDown(e) {
    if (e.pointerType !== 'touch') return;
    stopGlide();                       // 動いている最中に触れたら、その場で止める
    ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (ptrs.size >= 2) { one = null; if (!two) startTwo(); return; }
    if (ptrs.size === 1 && isViewTool()) {
      one = { id: e.pointerId, lastX: e.clientX, lastY: e.clientY, moved: 0, vx: 0, vy: 0, lastT: nowMs() };
    }
  }
  function onTouchMove(e) {
    if (!ptrs.has(e.pointerId)) return;
    ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (two && ptrs.size >= 2) { moveTwo(); return; }
    if (one && e.pointerId === one.id) {
      const dx = e.clientX - one.lastX, dy = e.clientY - one.lastY;
      one.lastX = e.clientX; one.lastY = e.clientY; one.moved += Math.abs(dx) + Math.abs(dy);
      trackVelocity(one, dx, dy, nowMs());
      elScroller.scrollLeft -= dx; elScroller.scrollTop -= dy;
    }
  }
  function onTouchUp(e) {
    const wasOne = one && e.pointerId === one.id;
    if (ptrs.has(e.pointerId)) ptrs.delete(e.pointerId);
    if (two && ptrs.size < 2) endTwo();
    if (wasOne) {
      if (one.moved > 8) lastPinchEnd = Date.now();   // ドラッグ後の誤タップ（めくり）防止
      // 指を離した勢いで滑らせる（動きが止まってから離した場合は滑らない）
      if (nowMs() - one.lastT < 120) startGlide(one.vx, one.vy);
      one = null;
    }
    if (ptrs.size === 0) suppressDraw = false;
  }
  function startTwo() {
    if (!nb || !pageViews.length) return;
    suppressDraw = true; cancelGesture(); one = null;
    const [a, b] = [...ptrs.values()];
    two = { startDist: dist(a, b) || 1, lastMid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, zooming: false, z0: zoom, zoomBaseDist: 1, lastScale: 1, fx: 0, fy: 0, vx: 0, vy: 0, lastT: nowMs() };
  }
  function moveTwo() {
    const [a, b] = [...ptrs.values()];
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const d = dist(a, b);
    // 2本指の中点移動 → なめらかにスクロール
    const mdx = mid.x - two.lastMid.x, mdy = mid.y - two.lastMid.y;
    if (!two.zooming) trackVelocity(two, mdx, mdy, nowMs());   // 拡大中は勢いを記録しない
    elScroller.scrollLeft -= mdx;
    elScroller.scrollTop -= mdy;
    two.lastMid = mid;
    // 指の間隔が一定以上（26px）変わったらズーム作動。小さな動きでは反応しない
    if (!two.zooming && Math.abs(d - two.startDist) > 26) {
      two.zooming = true; two.zoomBaseDist = d || 1; two.z0 = zoom;
      const rect = elPages.getBoundingClientRect();
      const ox = mid.x - rect.left, oy = mid.y - rect.top;
      elPages.style.transformOrigin = ox + 'px ' + oy + 'px';
      two.fx = rect.width ? ox / rect.width : 0; two.fy = rect.height ? oy / rect.height : 0;
    }
    if (two.zooming) {
      const fz = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, two.z0 * d / two.zoomBaseDist));
      two.lastScale = fz / two.z0;
      elPages.style.transform = 'scale(' + two.lastScale + ')';
    }
  }
  function endTwo() {
    const t = two; two = null; lastPinchEnd = Date.now();
    // 拡大していない（＝2本指スクロールだった）なら、離した勢いで滑らせる
    if (!t.zooming && nowMs() - t.lastT < 120) startGlide(t.vx, t.vy);
    if (t.zooming) {
      elPages.style.transform = ''; elPages.style.transformOrigin = '';
      zoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, t.z0 * t.lastScale));
      relayoutAll();
      const rect = elPages.getBoundingClientRect();
      elScroller.scrollLeft += (rect.left + t.fx * rect.width) - t.lastMid.x;
      elScroller.scrollTop += (rect.top + t.fy * rect.height) - t.lastMid.y;
    }
  }

  /* ---------- ページ追加 ---------- */
  async function addFiles(files, position) {
    // position: 'after'（今のページの直後） | 'end'（最後）。未指定は 'end'
    if (!nb) return;
    PN.ui.busy(true, 'ファイルを取り込み中…');
    const startLen = nb.pages.length;
    try {
      for (const file of files) {
        const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
        if (isPdf) await addPdf(file);
        else if (/^image\//.test(file.type) || /\.(png|jpe?g|webp)$/i.test(file.name)) await addImage(file);
      }
    } catch (e) { console.error(e); PN.ui.toast('取り込みに失敗したファイルがあります'); }
    PN.ui.busy(false);
    const added = nb.pages.length - startLen;
    if (added) {
      let insertAt = startLen;  // 末尾（既定）
      if (position === 'after' && startLen > 0) {
        const moved = nb.pages.splice(startLen, added);       // 末尾に付いた新ページを取り出す
        insertAt = Math.min(currentIdx + 1, startLen);
        nb.pages.splice(insertAt, 0, ...moved);                // 今のページの直後へ挿入
      }
      structureDirty = true; await saveNow();
      elNoPages.hidden = true; elScroller.style.display = '';
      buildPages(); renderVisible(); updateCurrent();
      if (pageViews[insertAt]) pageViews[insertAt].el.scrollIntoView({ block: 'start' });
      PN.ui.toast(added + ' ページを追加しました');
    }
  }
  async function addPdf(file) {
    const buf = await file.arrayBuffer();
    const asset = await PN.storage.addAsset(nb.id, new Blob([buf], { type: 'application/pdf' }), 'pdf');
    const doc = await pdfjsLib.getDocument({ data: new Uint8Array(buf.slice(0)) }).promise;
    pdfCache[asset] = Promise.resolve(doc);
    for (let i = 0; i < doc.numPages; i++) {
      const vp = (await doc.getPage(i + 1)).getViewport({ scale: 1 });
      nb.pages.push({ id: 'pg-' + Date.now() + '-' + i, type: 'pdf', asset, pageIndex: i, baseW: Math.round(vp.width), baseH: Math.round(vp.height), annotations: { strokes: [], masks: [] } });
    }
    return doc.numPages;
  }
  async function addImage(file) {
    const ext = (file.name.match(/\.(png|jpe?g|webp)$/i) || [, 'png'])[1].toLowerCase();
    const asset = await PN.storage.addAsset(nb.id, file, ext);
    const url = URL.createObjectURL(file); const img = await loadImg(url);
    imgCache[asset] = Promise.resolve(img); imgUrls.push(url);
    nb.pages.push({ id: 'pg-' + Date.now(), type: 'image', asset, baseW: img.naturalWidth, baseH: img.naturalHeight, annotations: { strokes: [], masks: [] } });
    return 1;
  }

  /* ---------- ページ操作メニュー ---------- */
  function pageMenu(anchor) {
    if (!nb || !nb.pages.length) return;
    PN.ui.menu(anchor, [
      { label: '▲ 今のページを前へ', onClick: () => movePage(-1) },
      { label: '▼ 今のページを後ろへ', onClick: () => movePage(1) },
      { label: '今のページの書き込みを全消去', onClick: clearPageInk },
      { label: '今のページを削除', danger: true, onClick: deletePage }
    ]);
  }
  function movePage(dir) {
    const j = currentIdx + dir; if (j < 0 || j >= nb.pages.length) return;
    const t = nb.pages[currentIdx]; nb.pages[currentIdx] = nb.pages[j]; nb.pages[j] = t;
    structureDirty = true; buildPages(); renderVisible();
    if (pageViews[j]) pageViews[j].el.scrollIntoView({ block: 'center' });
    updateCurrent(); markDirty();
  }
  async function clearPageInk() {
    if (!(await PN.ui.confirm('今表示しているページの書き込み（線・かくす枠）をすべて消します。よろしいですか？', { danger: true, ok: '消す' }))) return;
    pushUndo(currentIdx); nb.pages[currentIdx].annotations = { strokes: [], masks: [], texts: [] };
    const pv = pageViews[currentIdx]; if (pv) { renderInk(pv); renderMasks(pv); renderTexts(pv); } markDirty();
  }
  async function deletePage() {
    if (!(await PN.ui.confirm('今表示しているページを削除します。元に戻せません。よろしいですか？', { danger: true, ok: '削除' }))) return;
    nb.pages.splice(currentIdx, 1);
    structureDirty = true; undoStack = []; redoStack = [];
    if (nb.pages.length) { buildPages(); renderVisible(); updateCurrent(); } else showNoPages();
    await saveNow();
  }

  /* ---------- サムネイル（一覧用 thumb.png） ---------- */
  async function regenThumb() {
    if (!nb.pages.length) return;
    try { const blob = await renderThumbBlob(nb.pages[0], 360); if (blob) await PN.storage.saveThumb(nb.id, blob); } catch (e) {}
  }
  async function renderThumbToCanvas(def, targetW) {
    const canvas = document.createElement('canvas'), ctx = canvas.getContext('2d');
    if (def.type === 'pdf') {
      const page = await (await getPdfDoc(def.asset)).getPage(def.pageIndex + 1);
      const vp = page.getViewport({ scale: targetW / def.baseW });
      canvas.width = Math.round(vp.width); canvas.height = Math.round(vp.height);
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: ctx, viewport: vp }).promise;
    } else {
      const img = await getImage(def.asset), scale = targetW / def.baseW;
      canvas.width = Math.round(def.baseW * scale); canvas.height = Math.round(def.baseH * scale);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    }
    return canvas;
  }
  function renderThumbBlob(def, w) { return renderThumbToCanvas(def, w).then(c => new Promise(res => c.toBlob(res, 'image/png'))); }

  /* ---------- ページの合成描画（背景＋書き込み＋かくす枠）: 一覧サムネ・PDF書き出し用 ---------- */
  function composeStroke(ctx, s, scale, canvasW) {
    const pts = s.points; if (!pts || !pts.length) return;
    ctx.strokeStyle = s.color; ctx.fillStyle = s.color; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    const baseCss = s.width * canvasW;
    if (pts.length === 1) { const w = strokeW(baseCss, pts[0][2]); ctx.beginPath(); ctx.arc(pts[0][0] * scale, pts[0][1] * scale, Math.max(0.4, w / 2), 0, Math.PI * 2); ctx.fill(); return; }
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i];
      ctx.lineWidth = strokeW(baseCss, b[2]);
      ctx.beginPath(); ctx.moveTo(a[0] * scale, a[1] * scale); ctx.lineTo(b[0] * scale, b[1] * scale); ctx.stroke();
    }
  }
  async function composePage(def, targetW, opts) {
    opts = opts || {};
    const wantInk = opts.ink !== false, wantMasks = opts.masks !== false;
    const canvas = document.createElement('canvas'), ctx = canvas.getContext('2d');
    const scale = targetW / def.baseW;
    if (def.type === 'pdf') {
      const page = await (await getPdfDoc(def.asset)).getPage(def.pageIndex + 1);
      const vp = page.getViewport({ scale });
      canvas.width = Math.round(vp.width); canvas.height = Math.round(vp.height);
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: ctx, viewport: vp }).promise;
    } else {
      const img = await getImage(def.asset);
      canvas.width = Math.round(def.baseW * scale); canvas.height = Math.round(def.baseH * scale);
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    }
    const ann = def.annotations || {};
    // 背景 → 書き込み → 入れた文字 → かくす枠（上に重ねて答えを隠す）の順
    if (wantInk && ann.strokes) ann.strokes.forEach(s => composeStroke(ctx, s, scale, canvas.width));
    if (ann.texts) ann.texts.forEach(t => composeText(ctx, t, scale));
    if (wantMasks && ann.masks) ann.masks.forEach(m => { ctx.fillStyle = m.color || '#c0392b'; ctx.fillRect(m.x * scale, m.y * scale, m.w * scale, m.h * scale); });
    return canvas;
  }

  /* テキストボックスをキャンバスに描く（PDF書き出し・サムネイル用） */
  function composeText(ctx, t, scale) {
    const x = t.x * scale, y = t.y * scale, w = t.w * scale, h = t.h * scale;
    const size = Math.max(1, (t.size || 20) * scale);
    const lh = size * 1.35, pad = 4 * scale;
    ctx.save();
    if (t.bg === 'white') { ctx.fillStyle = '#fff'; ctx.fillRect(x, y, w, h); }
    ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();      // はみ出しは切る（画面と同じ見え方）
    ctx.fillStyle = t.color || '#1a1a1a';
    ctx.font = (t.bold ? 'bold ' : '') + size + 'px ' + (t.font || 'sans-serif');
    ctx.textBaseline = 'top';
    const raw = String(t.text || '');
    if (t.vertical) {
      // 縦書き：右の列から、上から下へ1文字ずつ
      let cx = x + w - pad - size, cy = y + pad;
      for (const ch of raw) {
        if (ch === '\n' || cy + size > y + h - pad) { cx -= lh; cy = y + pad; if (ch === '\n') continue; }
        if (cx < x - size) break;
        ctx.fillText(ch, cx, cy);
        cy += lh;
      }
    } else {
      const maxW = Math.max(1, w - pad * 2);
      const lines = [];
      raw.split('\n').forEach(para => {
        let line = '';
        for (const ch of para) {
          if (ctx.measureText(line + ch).width > maxW && line) { lines.push(line); line = ch; }
          else line += ch;
        }
        lines.push(line);
      });
      lines.forEach((line, i) => {
        const ty = y + pad + i * lh;
        if (ty + size > y + h + lh) return;
        const lw = ctx.measureText(line).width;
        let tx = x + pad;
        if (t.align === 'center') tx = x + (w - lw) / 2;
        else if (t.align === 'right') tx = x + w - pad - lw;
        ctx.fillText(line, tx, ty);
      });
    }
    ctx.restore();
  }

  /* ---------- ページ操作（一覧画面から呼ばれる。ID指定で安全に） ---------- */
  function getPages() { return nb ? nb.pages.slice() : []; }
  function getCurrentIndex() { return currentIdx; }
  function gotoPageId(id) { if (!nb) return; const i = nb.pages.findIndex(p => p.id === id); if (i >= 0) goPage(i); }

  async function reorderPages(orderedIds) {
    if (!nb) return;
    const map = new Map(nb.pages.map(p => [p.id, p]));
    const next = [];
    orderedIds.forEach(id => { if (map.has(id)) { next.push(map.get(id)); map.delete(id); } });
    nb.pages.forEach(p => { if (map.has(p.id)) next.push(p); });  // 念のため取りこぼしを末尾に
    nb.pages = next;
    structureDirty = true; undoStack = []; redoStack = [];
    buildPages(); renderVisible(); updateCurrent(); await saveNow();
  }
  async function deletePagesByIds(ids) {
    if (!nb) return;
    const set = new Set(ids);
    nb.pages = nb.pages.filter(p => !set.has(p.id));
    if (currentIdx >= nb.pages.length) currentIdx = Math.max(0, nb.pages.length - 1);
    structureDirty = true; undoStack = []; redoStack = [];
    if (nb.pages.length) { buildPages(); renderVisible(); updateCurrent(); } else showNoPages();
    await saveNow();
  }
  async function duplicatePagesByIds(ids) {
    if (!nb) return;
    const set = new Set(ids);
    const out = [];
    nb.pages.forEach(p => {
      out.push(p);
      if (set.has(p.id)) {
        const cp = JSON.parse(JSON.stringify(p));  // 書き込みごと複製（同一ノート内なのでアセットは共有でOK）
        cp.id = 'pg-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);
        out.push(cp);
      }
    });
    nb.pages = out;
    structureDirty = true;
    buildPages(); renderVisible(); updateCurrent(); await saveNow();
  }

  async function exportPagesToPdf(idxOrIdList, filename) {
    if (!nb || !idxOrIdList || !idxOrIdList.length) return;
    const jsPDFctor = (window.jspdf && window.jspdf.jsPDF) || null;
    if (!jsPDFctor) { PN.ui.toast('PDF書き出し機能を読み込めませんでした'); return; }
    // idまたはindexの配列を受け付ける
    const defs = idxOrIdList.map(v => (typeof v === 'number') ? nb.pages[v] : nb.pages.find(p => p.id === v)).filter(Boolean);
    if (!defs.length) return;
    PN.ui.busy(true, 'PDFを作成中…（' + defs.length + 'ページ）');
    try {
      let pdf = null;
      for (const def of defs) {
        const targetW = Math.min(2200, Math.max(1000, Math.round(def.baseW * 2)));
        const canvas = await composePage(def, targetW, { ink: true, masks: true });
        // PDFのページ寸法（pt, 72dpi）。PDFページは baseW/H がpt。画像は96dpi前提で pt換算
        const wpt = def.type === 'pdf' ? def.baseW : def.baseW * 0.75;
        const hpt = def.type === 'pdf' ? def.baseH : def.baseH * 0.75;
        const jpg = canvas.toDataURL('image/jpeg', 0.85);
        if (!pdf) pdf = new jsPDFctor({ unit: 'pt', format: [wpt, hpt], compress: true });
        else pdf.addPage([wpt, hpt]);
        pdf.addImage(jpg, 'JPEG', 0, 0, wpt, hpt);
      }
      const blob = pdf.output('blob');
      await savePdfBlob(blob, filename || ((nb.title || 'ノート') + '.pdf'));
    } catch (e) { console.error('PDF書き出しエラー', e); PN.ui.toast('PDF書き出しに失敗しました'); }
    PN.ui.busy(false);
  }
  async function savePdfBlob(blob, filename) {
    try {
      if (window.showSaveFilePicker) {
        const h = await window.showSaveFilePicker({ suggestedName: filename, types: [{ description: 'PDF', accept: { 'application/pdf': ['.pdf'] } }] });
        const w = await h.createWritable(); await w.write(blob); await w.close();
        PN.ui.toast('PDFを書き出しました'); return;
      }
    } catch (e) { if (e && e.name === 'AbortError') return; console.error(e); }
    // フォールバック：ダウンロード
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    PN.ui.toast('PDFを書き出しました');
  }

  /* ---------- アセット ---------- */
  function getPdfDoc(asset) {
    if (!pdfCache[asset]) pdfCache[asset] = (async () => { const blob = await PN.storage.readAsset(nb.id, asset); if (!blob) throw new Error('asset missing'); return pdfjsLib.getDocument({ data: new Uint8Array(await blob.arrayBuffer()) }).promise; })();
    return pdfCache[asset];
  }
  function getImage(asset) {
    if (!imgCache[asset]) imgCache[asset] = (async () => { const blob = await PN.storage.readAsset(nb.id, asset); if (!blob) throw new Error('asset missing'); const url = URL.createObjectURL(blob); imgUrls.push(url); return loadImg(url); })();
    return imgCache[asset];
  }
  function loadImg(url) { return new Promise((res, rej) => { const img = new Image(); img.onload = () => res(img); img.onerror = rej; img.src = url; }); }

  /* ---------- キーボード ---------- */
  function onKey(e) {
    if ($('#screen-editor').hidden) return;
    if (e.target && /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName)) return;
    if (e.target && e.target.isContentEditable) return;   // 文字入力中はショートカットを効かせない
    const ctrl = e.ctrlKey || e.metaKey;
    if (ctrl && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
    if (ctrl && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); return; }
    if (e.key === 'ArrowRight' || e.key === 'PageDown') { e.preventDefault(); goPage(currentIdx + 1); }
    else if (e.key === 'ArrowLeft' || e.key === 'PageUp') { e.preventDefault(); goPage(currentIdx - 1); }
    else if (e.key === 'Escape' && immersive) { exitImmersive(); }
    else { const map = { '1': 'pen', '2': 'line', '3': 'eraser', '4': 'text', '5': 'mask', '6': 'reveal', '7': 'pan' }; if (map[e.key]) setTool(map[e.key]); }
  }

  function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

  return {
    init, open, close, flushSave, addFiles,
    getPages, getCurrentIndex, gotoPageId, composePage,
    reorderPages, deletePagesByIds, duplicatePagesByIds, exportPagesToPdf
  };
})();
