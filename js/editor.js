/* PDFノート — エディタ（縦スクロール連結表示・書き込み・全画面） */
window.PN = window.PN || {};

PN.editor = (function () {
  const $ = (s) => document.querySelector(s);

  /* ペンの色。先生が入れ替えられるので、中身を書き換えて localStorage に覚えておく
     （並び自体は変えないので、他の場所からの参照はそのまま使える） */
  const DEFAULT_COLORS = ['#e0301e', '#1e6fe0', '#15a05a', '#f0a500', '#1a1a1a', '#ffffff'];
  const COLORS = DEFAULT_COLORS.slice();
  const COLORS_KEY = 'pdfnote.penColors';
  /* ペンの太さ。値はページ幅に対する割合で持つ（どの大きさの紙でも同じ見た目になる）。
     先生に見せるときは mm に直す。A4の紙の横幅 210mm を目安にしているので、
     配付プリント（A4）の上では、そのままの太さで印刷される。 */
  const MM_PER_PAGE = 210;
  const mmOf = (w) => w * MM_PER_PAGE;
  const widthOf = (mm) => mm / MM_PER_PAGE;
  const MM_MIN = 0.1, MM_MAX = 2.0;
  const DEFAULT_WIDTHS = [0.4, 0.8, 1.2, 2.0].map(widthOf);
  const WIDTHS = DEFAULT_WIDTHS.slice();
  const WIDTHS_KEY = 'pdfnote.penWidths';
  /* マーカー（蛍光ペン）。うすく重ねるので、色は淡いものを既定にする */
  const DEFAULT_MK_COLORS = ['#ffd54a', '#ff9ec4', '#a8e05a', '#7fd6f0', '#c9a7f0', '#ffab5e'];
  const MK_COLORS = DEFAULT_MK_COLORS.slice();
  const MK_COLORS_KEY = 'pdfnote.markerColors';
  const MK_ALPHA = 0.35;                 // 下の文字が読めるうすさ
  /* マーカーはペンよりずっと太い。同じく mm で決められる */
  const MK_MM_MIN = 1, MK_MM_MAX = 20;
  const DEFAULT_MK_WIDTHS = [4, 6, 9, 13].map(widthOf);
  const MK_WIDTHS = DEFAULT_MK_WIDTHS.slice();
  const MK_WIDTHS_KEY = 'pdfnote.markerWidths';

  const DEFAULT_MASK_COLORS = ['#c0392b', '#2d6cdf', '#4a5163'];
  const MASK_COLORS = DEFAULT_MASK_COLORS.slice();
  const MASK_COLORS_KEY = 'pdfnote.maskColors';
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
  let mkColor = MK_COLORS[0], mkWidthIdx = 1;
  const isFreehand = (t) => (t === 'pen' || t === 'marker');   // なぞって描く道具
  const isPenLike = (t) => (t === 'pen' || t === 'marker' || t === 'line');
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
  let immersive = false;

  /* 書き込みはタッチペンだけ、というのが既定。
     アクティブペンは pointerType が 'pen'、指と静電式ペンは 'touch' で届く。
     設定で「指だけで操作できるようにする」をオンにすると、書き込みも投げ縄も
     指でできるようになる（そのぶん、スクロールは2本指）。 */
  const FINGER_DRAW_KEY = 'pdfnote.fingerDraw';
  let fingerDraw = false;
  const penOnly = () => !fingerDraw;
  let scrollRAF = null;

  /* DOM */
  let ed, elStage, elScroller, elPages, elNoPages, elExit;

  function init() {
    ed = $('#screen-editor');
    elStage = $('#ed-stage'); elScroller = $('#ed-scroller'); elPages = $('#ed-pages');
    elNoPages = $('#ed-nopages'); elExit = $('#ed-imm-exit');

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

  let drawTextColors = null;     // 文字の色の並びを描き直す（syncTextControls から呼ぶ）

  /* 白っぽい色か（上に載せる印の色を決めるため） */
  function isLightColor(hex) {
    const m = /^#([0-9a-f]{6})$/i.exec(String(hex || ''));
    if (!m) return false;
    const n = parseInt(m[1], 16);
    const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    return (0.299 * r + 0.587 * g + 0.114 * b) > 150;
  }

  /* 覚えておいた色を読み出す（数が合わないときは既定にもどす） */
  function loadPalette(key, list, def) {
    try {
      const v = JSON.parse(localStorage.getItem(key) || 'null');
      if (Array.isArray(v) && v.length === def.length && v.every(c => /^#[0-9a-f]{6}$/i.test(c))) {
        v.forEach((c, i) => { list[i] = c; });
      }
    } catch (e) { /* 読めなければ既定のまま */ }
  }
  const savePalette = (key, list) => { try { localStorage.setItem(key, JSON.stringify(list)); } catch (e) {} };

  /* 色のボタンを並べる。
     選んでいない色を押す → その色にする。
     選んでいる色をもう一度押す → 色そのものを選び直せる（プリセット／カスタム）。 */
  function buildColorRow(host, list, key, def, getCur, setCur, after) {
    const draw = () => {
      host.innerHTML = '';
      list.forEach((c, i) => {
        const b = document.createElement('span');
        const on = (getCur() === c);
        b.className = 'color-swatch' + (on ? ' active' : '');
        b.style.background = c; b.dataset.color = c;
        b.style.setProperty('--mark', isLightColor(c) ? '#1a1a1a' : '#ffffff');   // 「∨」印を見える色にする
        b.title = on ? 'もう一度押すと、この色を変えられます' : c;
        b.addEventListener('click', () => {
          if (getCur() !== list[i]) { setCur(list[i]); draw(); return; }   // まずは色をえらぶだけ
          PN.ui.colorPicker(b, list[i], (picked) => {
            list[i] = picked; setCur(picked);
            savePalette(key, list); draw(); if (after) after();
          }, {
            onReset: () => {
              def.forEach((c2, j) => { list[j] = c2; });
              setCur(list[i]); savePalette(key, list); draw(); if (after) after();
              PN.ui.toast('色をもとにもどしました');
            }
          });
        });
        host.appendChild(b);
      });
    };
    draw();
    return draw;
  }

  function buildSwatches() {
    loadPalette(COLORS_KEY, COLORS, DEFAULT_COLORS);
    loadPalette(MK_COLORS_KEY, MK_COLORS, DEFAULT_MK_COLORS);
    loadPalette(MASK_COLORS_KEY, MASK_COLORS, DEFAULT_MASK_COLORS);
    color = COLORS[0]; mkColor = MK_COLORS[0]; maskColor = MASK_COLORS[0];
    buildColorRow($('#mask-swatches'), MASK_COLORS, MASK_COLORS_KEY, DEFAULT_MASK_COLORS,
      () => maskColor, (c) => { maskColor = c; });
    loadWidths();
    refreshPenPanels();
  }

  /* 色と太さの並びを、いまの道具（ペン／マーカー）に合わせて作り直す */
  function refreshPenPanels() {
    const mk = (tool === 'marker');
    buildColorRow($('#color-swatches'),
      mk ? MK_COLORS : COLORS,
      mk ? MK_COLORS_KEY : COLORS_KEY,
      mk ? DEFAULT_MK_COLORS : DEFAULT_COLORS,
      () => (mk ? mkColor : color),
      (c) => { if (mk) mkColor = c; else color = c; },
      () => { if (!mk) buildLassoColors(); });
    buildWidthRow();
  }

  /* 覚えておいた太さを読み出す（数や範囲が合わないときは既定にもどす） */
  function loadWidthSet(key, list, def, lo, hi) {
    try {
      const v = JSON.parse(localStorage.getItem(key) || 'null');
      if (Array.isArray(v) && v.length === def.length &&
          v.every(mm => typeof mm === 'number' && mm >= lo && mm <= hi)) {
        v.forEach((mm, i) => { list[i] = widthOf(mm); });
      }
    } catch (e) { /* 読めなければ既定のまま */ }
  }
  function loadWidths() {
    loadWidthSet(WIDTHS_KEY, WIDTHS, DEFAULT_WIDTHS, MM_MIN, MM_MAX);
    loadWidthSet(MK_WIDTHS_KEY, MK_WIDTHS, DEFAULT_MK_WIDTHS, MK_MM_MIN, MK_MM_MAX);
  }
  const saveWidthSet = (key, list) => {
    try { localStorage.setItem(key, JSON.stringify(list.map(w => Math.round(mmOf(w) * 100) / 100))); } catch (e) {}
  };

  /* 太さのボタンを並べる。
     選んでいない太さを押す → その太さにする。
     選んでいる太さをもう一度押す → つまみで自由に変えられる（0.1〜2.0mm）。 */
  function buildWidthRow() {
    const mk = (tool === 'marker');
    const LIST = mk ? MK_WIDTHS : WIDTHS;
    const DEF = mk ? DEFAULT_MK_WIDTHS : DEFAULT_WIDTHS;
    const KEY = mk ? MK_WIDTHS_KEY : WIDTHS_KEY;
    const LO = mk ? MK_MM_MIN : MM_MIN, HI = mk ? MK_MM_MAX : MM_MAX;
    const cur = () => (mk ? mkWidthIdx : widthIdx);
    const setCur = (i) => { if (mk) mkWidthIdx = i; else widthIdx = i; };
    const ws = $('#width-btns'); ws.innerHTML = '';
    LIST.forEach((w, i) => {
      const b = document.createElement('button');
      const on = (i === cur());
      b.className = 'width-btn' + (on ? ' active' : '');
      const d = document.createElement('span'); d.className = 'dot';
      sizeDot(d, mmOf(w), HI);
      b.appendChild(d);
      b.title = on ? 'もう一度押すと太さを変えられます（今 ' + fmtMm(mmOf(w)) + ' mm）'
                   : fmtMm(mmOf(w)) + ' mm';
      b.addEventListener('click', () => {
        if (cur() !== i) { setCur(i); buildWidthRow(); return; }   // まずは太さをえらぶだけ
        PN.ui.widthPicker(b, mmOf(LIST[i]), {
          min: LO, max: HI,
          // つまみを動かしている間は、押したボタンの丸だけを直す（並べ直すとちらつくため）
          onChange: (mm) => {
            LIST[i] = widthOf(mm); saveWidthSet(KEY, LIST);
            sizeDot(d, mm, HI);
            b.title = 'もう一度押すと太さを変えられます（今 ' + fmtMm(mm) + ' mm）';
          },
          onReset: () => {
            DEF.forEach((v, j) => { LIST[j] = v; });
            saveWidthSet(KEY, LIST); buildWidthRow();
            PN.ui.toast('太さをもとにもどしました');
          }
        });
      });
      ws.appendChild(b);
    });
  }
  /* 太さが見て分かる大きさの丸にする（その道具の上限を 20px にあてる） */
  function sizeDot(dot, mm, hi) {
    const px = Math.max(4, Math.min(20, 3 + (mm / (hi || MM_MAX)) * 17));
    dot.style.width = px + 'px'; dot.style.height = px + 'px';
  }
  const fmtMm = (v) => {
    const n = Math.round(v * 100) / 100;
    return n.toFixed((Math.round(n * 100) % 10 === 0) ? 1 : 2);
  };

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
    $('#ed-add-page').addEventListener('click', addPageDialog);
    $('#ed-page-list').addEventListener('click', () => PN.pages.open());
    $('#ed-image').addEventListener('click', (e) => imageMenu(e.currentTarget));
    try { fingerDraw = localStorage.getItem(FINGER_DRAW_KEY) === '1'; } catch (e) {}
    try { snapShapes = localStorage.getItem(SHAPE_KEY) !== '0'; } catch (e) {}
    buildLassoControls();
    $('#ed-settings').addEventListener('click', (e) => settingsMenu(e.currentTarget));
  }

  function setTool(t) {
    tool = t;
    document.querySelectorAll('.tool-btn').forEach(b => b.classList.toggle('active', b.dataset.tool === t));
    const isPen = isPenLike(t);
    $('#grp-color').hidden = !isPen;
    $('#grp-width').hidden = !isPen;
    $('#grp-mask').hidden = (t !== 'mask');
    $('#grp-text').hidden = (t !== 'text');
    $('#grp-lasso').hidden = (t !== 'lasso');
    if (t !== 'text') {
      selText = null;
      // 「文字」から離れるときに、書かないまま残った空の箱を片づける
      if (nb && nb.pages.length) pageViews.forEach(pv => dropEmptyTexts(pv));
    }
    if (t !== 'image') selImg = null;
    if (t !== 'lasso') clearLasso();
    if (isPenLike(t)) refreshPenPanels();   // ペンとマーカーで色・太さの並びを入れ替える
    pageViews.forEach(pv => { renderTexts(pv); renderImages(pv); });
    updateRouting();
  }

  /* レイヤーのポインタ受付（道具に応じて）。全画面でも通常どおり描ける */
  function updatePVRouting(pv) {
    const drawTool = (isPenLike(tool) || tool === 'eraser' || tool === 'lasso');
    pv.live.style.pointerEvents = drawTool ? 'auto' : 'none';
    pv.mask.style.pointerEvents = (tool === 'mask' || tool === 'reveal') ? 'auto' : 'none';
    pv.text.style.pointerEvents = (tool === 'text') ? 'auto' : 'none';
    pv.img.style.pointerEvents = (tool === 'image') ? 'auto' : 'none';
    pv.ink.style.pointerEvents = 'none';
  }
  function updateRouting() { pageViews.forEach(updatePVRouting); }

  /* ---------- ノートを開く / 閉じる ---------- */
  async function open(notebook) {
    nb = notebook; currentIdx = 0; zoom = 1;
    undoStack = []; redoStack = []; dirty = false; structureDirty = false; viewDirty = false;
    pdfCache = {}; imgCache = {}; imgUrls.forEach(u => URL.revokeObjectURL(u)); imgUrls = [];
    // 全画面状態はリセット（レイアウトのみ）
    selText = null; selImg = null; lassoSel = null;
    Object.keys(objUrls).forEach(k => delete objUrls[k]);
    immersive = false; ed.classList.remove('immersive'); elExit.hidden = true;
    $('#ed-title').textContent = nb.title;
    setTool('pen');   // 既定ではペンだけで書くので、指で誤って線を引くことはない
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
  function showNoPages() { elNoPages.hidden = false; elScroller.style.display = 'none'; elPages.innerHTML = ''; pageViews = []; }
  async function flushSave() { if (dirty || viewDirty) await saveNow(); }
  async function close() {
    stopGlide();
    if (nb && nb.pages.length) pageViews.forEach(pv => dropEmptyTexts(pv));   // 空の箱は残さない
    await flushSave();
    if (immersive) { ed.classList.remove('immersive'); elExit.hidden = true; immersive = false; }
    imgUrls.forEach(u => URL.revokeObjectURL(u)); imgUrls = []; pdfCache = {}; imgCache = {};
    elPages.innerHTML = ''; pageViews = []; nb = null;
  }

  /* ---------- ページ群の生成・レイアウト ---------- */
  const annOf = (idx) => {
    const p = nb.pages[idx];
    if (!p.annotations) p.annotations = { strokes: [], masks: [], texts: [], images: [] };
    if (!p.annotations.texts) p.annotations.texts = [];     // 旧データにも文字入れを追加
    if (!p.annotations.images) p.annotations.images = [];   // 旧データにも画像を追加
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
      const img = document.createElement('div'); img.className = 'layer img-layer pv-img';
      const text = document.createElement('div'); text.className = 'layer text-layer pv-text';
      const mask = document.createElement('div'); mask.className = 'layer mask-layer pv-mask';
      const num = document.createElement('div'); num.className = 'pv-num'; num.textContent = (i + 1);
      // 画像は手書きより下、文字はマスクより下（＝目かくしで答えの文字も隠せる）
      el.append(bg, img, ink, live, text, mask, num);
      elPages.appendChild(el);
      const pv = {
        idx: i, el, bg, ink, live, mask, text, img,
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
      // 書き込み（線・目かくし）はここで同期的に描き直す。
      // 背景の再描画（非同期）を待つと、その間だけ線が消えてしまうため。
      if (!pv.freed) { renderInk(pv); renderMasks(pv); renderTexts(pv); renderImages(pv); }
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
      } else if (p.type === 'blank') {
        // 白紙のページ。まっ白に塗るだけ
        const r = Math.max(0.05, Math.min(dprv(), MAX_DIM / pv.cssW, MAX_DIM / pv.cssH));
        pv.bg.width = Math.max(1, Math.round(pv.cssW * r)); pv.bg.height = Math.max(1, Math.round(pv.cssH * r));
        pv.bg.style.width = pv.cssW + 'px'; pv.bg.style.height = pv.cssH + 'px';
        pv.bgctx.setTransform(1, 0, 0, 1, 0, 0);
        pv.bgctx.fillStyle = '#fff'; pv.bgctx.fillRect(0, 0, pv.bg.width, pv.bg.height);
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
    renderInk(pv); renderMasks(pv); renderTexts(pv); renderImages(pv);
  }

  function clearCtx(canvas, ctx) { ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, canvas.width, canvas.height); ctx.restore(); }

  /* 保存した線は tool、描いている途中の線は type に道具の名前が入っている */
  const kindOf = (s) => (s.tool || s.type);
  const isMarkerStroke = (s) => kindOf(s) === 'marker';

  /* extra を渡すと、描いている途中の線も正しい重なり順で一緒に描く */
  function renderInk(pv, extra) {
    clearCtx(pv.ink, pv.inkctx);
    /* マーカーを先に、手書きをあとに描く。こうすると手書きがマーカーの上に来る。
       テキストボックスはこのキャンバスより上のレイヤーなので、もともと上になる。 */
    const st = annOf(pv.idx).strokes;
    st.forEach(s => { if (isMarkerStroke(s)) drawStroke(pv.inkctx, s, pv); });
    if (extra && isMarkerStroke(extra)) drawStroke(pv.inkctx, extra, pv);
    st.forEach(s => { if (!isMarkerStroke(s)) drawStroke(pv.inkctx, s, pv); });
    if (extra && !isMarkerStroke(extra)) drawStroke(pv.inkctx, extra, pv);
  }
  /* ========== 押さえたままで、形をきれいにする ==========
     ペンで書いたあと、画面から離さずにその場で止めていると、
     直線・丸・四角・三角に見えるものをきれいな形に直す。
     まぎらわしいものは直さない（間違って直すより、そのままの方がよいため）。 */
  const SHAPE_HOLD_MS = 700;      // これだけ止めていたら直す
  const SHAPE_MOVE_TOL = 3;       // これ以下の動きは「止まっている」とみなす
  const SHAPE_KEY = 'pdfnote.snapShapes';
  let snapShapes = true;

  /* 点と線分の距離（点は [x, y] で渡す） */
  function ptSegDist(p, a, b) {
    const vx = b[0] - a[0], vy = b[1] - a[1];
    const L = vx * vx + vy * vy;
    let t = L ? ((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / L : 0;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(p[0] - (a[0] + t * vx), p[1] - (a[1] + t * vy));
  }
  /* 線を、形が変わらない程度に間引く（Ramer–Douglas–Peucker） */
  function rdp(P, eps) {
    if (P.length < 3) return P.slice();
    let idx = -1, max = 0;
    for (let i = 1; i < P.length - 1; i++) {
      const d = ptSegDist(P[i], P[0], P[P.length - 1]);
      if (d > max) { max = d; idx = i; }
    }
    if (max <= eps) return [P[0], P[P.length - 1]];
    return rdp(P.slice(0, idx + 1), eps).slice(0, -1).concat(rdp(P.slice(idx), eps));
  }
  /* 閉じた線から「角」をさがす（ほぼまっすぐな所は角とみなさない） */
  function cornersOf(P, tol) {
    const s = rdp(P, tol);
    if (s.length > 3 && Math.hypot(s[0][0] - s[s.length - 1][0], s[0][1] - s[s.length - 1][1]) < tol * 2) s.pop();
    const out = [];
    for (let i = 0; i < s.length; i++) {
      const p = s[(i - 1 + s.length) % s.length], q = s[i], r = s[(i + 1) % s.length];
      let d = Math.abs(Math.atan2(r[1] - q[1], r[0] - q[0]) - Math.atan2(q[1] - p[1], q[0] - p[0]));
      if (d > Math.PI) d = Math.PI * 2 - d;
      if (d > 0.5) out.push(q);      // 約29度以上曲がっていれば角
    }
    return out;
  }

  /* 書いた線を見て、きれいな形の点を返す。どれにも見えなければ null */
  function recognizeShape(pts) {
    if (!pts || pts.length < 8) return null;
    const P = pts.map(p => [p[0], p[1]]);
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, len = 0;
    for (let i = 0; i < P.length; i++) {
      const p = P[i];
      if (p[0] < x0) x0 = p[0]; if (p[0] > x1) x1 = p[0];
      if (p[1] < y0) y0 = p[1]; if (p[1] > y1) y1 = p[1];
      if (i) len += Math.hypot(p[0] - P[i - 1][0], p[1] - P[i - 1][1]);
    }
    const w = x1 - x0, h = y1 - y0, diag = Math.hypot(w, h);
    if (diag < 24 || len < diag * 0.7) return null;        // 小さすぎる・短すぎる

    const A = P[0], B = P[P.length - 1];
    const span = Math.hypot(B[0] - A[0], B[1] - A[1]);

    // ---- 直線：始めと終わりを結んだ線から、どれだけ外れているか ----
    if (span > diag * 0.8) {
      let dev = 0;
      for (const p of P) { const d = ptSegDist(p, A, B); if (d > dev) dev = d; }
      if (dev <= Math.max(2, span * 0.07)) return { kind: 'line', a: A, b: B };
    }

    // ---- ここから先は「閉じた形」だけ ----
    if (span > Math.max(10, diag * 0.34)) return null;     // 始点と終点が離れている
    if (w < diag * 0.12 || h < diag * 0.12) return null;   // つぶれすぎ

    /* 四角と丸は取り違えやすいので、しきい値は計算して決めてある。
       ・囲む四角で正規化した「中心からの距離」のばらつき（cv）は、
         きれいな丸で 0、四角では 0.110。→ 丸とみなすのは 0.09 未満。
       ・「囲む四角の辺までの距離」は、丸では平均 0.035×対角・最大 0.104×対角。
         → 四角とみなすのは 平均 0.022×対角 未満かつ 最大 0.06×対角 未満。
       どちらの向きにも十分な余裕があるので、取り違えない。 */

    // ---- 四角：すべての点が、囲む四角の辺の近くにあるか ----
    let far = 0, sumd = 0;
    for (const p of P) {
      const d = Math.min(Math.abs(p[0] - x0), Math.abs(p[0] - x1), Math.abs(p[1] - y0), Math.abs(p[1] - y1));
      sumd += d; if (d > far) far = d;
    }
    if (sumd / P.length < diag * 0.022 && far < diag * 0.06) {
      return { kind: 'rect', box: { x0, y0, x1, y1 } };
    }

    // ---- 丸（楕円）：中心からの距離のばらつきが小さいか ----
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, rx = w / 2, ry = h / 2;
    let sum = 0;
    const rs = P.map(p => { const r = Math.hypot((p[0] - cx) / rx, (p[1] - cy) / ry); sum += r; return r; });
    const mean = sum / rs.length;
    let vs = 0; for (const r of rs) vs += (r - mean) * (r - mean);
    if (Math.sqrt(vs / rs.length) / (mean || 1) < 0.09) return { kind: 'ellipse', box: { x0, y0, x1, y1 } };

    // ---- 角の数で見分ける（傾いた四角もここで拾う） ----
    const c = cornersOf(P, diag * 0.07);
    if (c.length === 3 || c.length === 4) return { kind: 'poly', c: c.map(q => [q[0], q[1]]) };
    return null;
  }

  /* 形を決める点（つかんでいる点）から、実際に描く点をつくる */
  function shapePoints(sh, hx, hy) {
    if (sh.kind === 'line') return [sh.a, [hx, hy]];
    if (sh.kind === 'rect' || sh.kind === 'ellipse') {
      const x0 = Math.min(sh.a[0], hx), x1 = Math.max(sh.a[0], hx);
      const y0 = Math.min(sh.a[1], hy), y1 = Math.max(sh.a[1], hy);
      if (sh.kind === 'rect') return [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]];
      const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, rx = (x1 - x0) / 2, ry = (y1 - y0) / 2;
      const out = [];
      for (let i = 0; i <= 64; i++) { const a = (i / 64) * Math.PI * 2; out.push([cx + rx * Math.cos(a), cy + ry * Math.sin(a)]); }
      return out;
    }
    const p = sh.pts.map(q => [q[0], q[1]]);
    p[sh.i] = [hx, hy];
    return p.concat([p[0]]);
  }

  /* 止まっているのを見張る。動くたびに数え直す */
  function armShapeHold(g) {
    if (!snapShapes || !g || !isFreehand(g.type)) return;
    clearTimeout(g.holdTimer);
    g.holdTimer = setTimeout(() => snapGestureShape(g), SHAPE_HOLD_MS);
  }
  function snapGestureShape(g) {
    if (!gesture || gesture !== g || g.snapped) return;
    const r = recognizeShape(g.points);
    if (!r) return;
    let pr = 0; g.points.forEach(p => { pr += (p[2] > 0 ? p[2] : 0.5); });
    pr = g.points.length ? pr / g.points.length : 0.5;

    /* ペンに近い点を「つかむ点」にして、その向かい側を固定する。
       離さずに動かすと、この点だけが動いて大きさが変わる。 */
    const last = g.points[g.points.length - 1];
    const pen = [last[0], last[1]];
    const near = (list) => {
      let ni = 0, nd = Infinity;
      list.forEach((c, i) => { const d = Math.hypot(pen[0] - c[0], pen[1] - c[1]); if (d < nd) { nd = d; ni = i; } });
      return ni;
    };
    let sh, handle;
    if (r.kind === 'line') {
      const i = near([r.a, r.b]);
      sh = { kind: 'line', a: i ? r.a : r.b };          // 遠い方の端を固定
      handle = i ? r.b : r.a;
    } else if (r.kind === 'rect' || r.kind === 'ellipse') {
      const b = r.box;
      const cs = [[b.x0, b.y0], [b.x1, b.y0], [b.x1, b.y1], [b.x0, b.y1]];
      const i = near(cs);
      sh = { kind: r.kind, a: cs[(i + 2) % 4] };        // 向かい合う角を固定
      handle = cs[i];
    } else {
      const i = near(r.c);
      sh = { kind: 'poly', pts: r.c.map(q => [q[0], q[1]]), i };   // 近い角だけ動かす
      handle = r.c[i];
    }
    g.shape = sh; g.handleAt = handle; g.penAt = pen; g.pr = pr;
    g.points = shapePoints(sh, handle[0], handle[1]).map(p => [p[0], p[1], pr]);
    g.snapped = true;
    redrawLiveShape(g);
  }
  function redrawLiveShape(g) {
    const pv = g.pv;
    clearCtx(pv.live, pv.livectx); liveDrawnUpTo = 0;
    if (g.type === 'marker') renderInk(pv, g);      // マーカーは手書きの下・うすいまま
    else drawStroke(pv.livectx, g, pv);
  }
  /* きれいにしたあと、離さずに動かして大きさを変える */
  function dragSnappedShape(g, pv, e) {
    const [x, y] = toIntrinsic(e, pv);
    const hx = Math.max(0, Math.min(pv.baseW, g.handleAt[0] + (x - g.penAt[0])));
    const hy = Math.max(0, Math.min(pv.baseH, g.handleAt[1] + (y - g.penAt[1])));
    g.points = shapePoints(g.shape, hx, hy).map(p => [p[0], p[1], g.pr]);
    redrawLiveShape(g);
  }

  /* マーカーを描く。
     ・うすく重ねて、下の文字が読めるようにする
     ・筆圧では太さを変えない（蛍光ペンは一定の太さ）
     ・線をひと筆で描く。分けて描くと、重なった所だけ濃くなってしまう */
  function drawMarker(ctx, s, scale, baseCss) {
    const pts = s.points;
    ctx.save();
    ctx.globalAlpha = MK_ALPHA;
    ctx.strokeStyle = s.color; ctx.fillStyle = s.color;
    ctx.lineWidth = Math.max(1, baseCss);
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    if (pts.length === 1) {
      ctx.beginPath(); ctx.arc(pts[0][0] * scale, pts[0][1] * scale, Math.max(0.5, baseCss / 2), 0, Math.PI * 2); ctx.fill();
    } else {
      ctx.beginPath();
      ctx.moveTo(pts[0][0] * scale, pts[0][1] * scale);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0] * scale, pts[i][1] * scale);
      ctx.stroke();
    }
    ctx.restore();
  }

  function drawStroke(ctx, s, pv) {
    const pts = s.points; if (!pts || !pts.length) return;
    const baseCssM = s.width * pv.cssW;
    if (isMarkerStroke(s)) { drawMarker(ctx, s, pv.scale, baseCssM); return; }
    ctx.strokeStyle = s.color; ctx.fillStyle = s.color; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    const baseCss = baseCssM;
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

  /* ========== ページに置く画像（写真・カメラ撮影） ========== */

  const imagesOf = (idx) => annOf(idx).images;
  const objUrls = {};      // asset名 → 表示用URL（ノートを閉じるときに解放）
  let selImg = null;       // 選択中の画像 { pv, idx }

  async function imageUrl(asset) {
    if (objUrls[asset]) return objUrls[asset];
    const blob = await PN.storage.readAsset(nb.id, asset);
    if (!blob) return null;
    const url = URL.createObjectURL(blob);
    objUrls[asset] = url; imgUrls.push(url);
    return url;
  }

  /* 画像レイヤーの描画 */
  function renderImages(pv) {
    pv.img.innerHTML = '';
    if (!nb || !nb.pages.length) return;
    const editing = (tool === 'image');
    imagesOf(pv.idx).forEach((im, idx) => {
      const box = document.createElement('div');
      box.className = 'imgbox' + (editing ? ' editing' : '') +
        (selImg && selImg.pv === pv && selImg.idx === idx ? ' selected' : '');
      box.dataset.idx = idx;
      box.style.left = (im.x / pv.baseW * 100) + '%';
      box.style.top = (im.y / pv.baseH * 100) + '%';
      box.style.width = (im.w / pv.baseW * 100) + '%';
      box.style.height = (im.h / pv.baseH * 100) + '%';
      const el = document.createElement('img');
      el.alt = ''; el.draggable = false;
      imageUrl(im.asset).then(u => { if (u) el.src = u; });
      box.appendChild(el);
      if (editing) {
        const del = document.createElement('button'); del.className = 'ib-del'; del.textContent = '×'; del.title = '削除';
        const rs = document.createElement('button'); rs.className = 'ib-resize'; rs.title = 'ドラッグで大きさ変更';
        box.append(del, rs);
        box.addEventListener('pointerdown', (e) => {
          if (e.target === del || e.target === rs) return;
          startImgDrag(e, pv, idx, 'move', box);
        });
        del.addEventListener('pointerdown', (e) => e.stopPropagation());
        del.addEventListener('click', (e) => {
          e.stopPropagation(); pushUndo(pv.idx);
          imagesOf(pv.idx).splice(idx, 1); selImg = null; renderImages(pv); markDirty();
        });
        rs.addEventListener('pointerdown', (e) => startImgDrag(e, pv, idx, 'resize', box));
      }
      pv.img.appendChild(box);
    });
  }

  /* 画像の移動・サイズ変更（縦横比は保つ） */
  let imgDrag = null;
  function startImgDrag(e, pv, idx, mode, box) {
    e.preventDefault(); e.stopPropagation();
    const im = imagesOf(pv.idx)[idx]; if (!im) return;
    selImg = { pv, idx };
    pv.img.querySelectorAll('.imgbox').forEach(b => b.classList.toggle('selected', +b.dataset.idx === idx));
    pushUndo(pv.idx);
    imgDrag = { pv, idx, mode, box, startX: e.clientX, startY: e.clientY, x0: im.x, y0: im.y, w0: im.w, h0: im.h };
    try { box.setPointerCapture(e.pointerId); } catch (err) {}
    document.addEventListener('pointermove', onImgDragMove);
    document.addEventListener('pointerup', endImgDrag);
  }
  function onImgDragMove(e) {
    if (!imgDrag) return;
    const { pv, idx, mode, box } = imgDrag;
    const im = imagesOf(pv.idx)[idx]; if (!im) return;
    const dx = (e.clientX - imgDrag.startX) / pv.scale, dy = (e.clientY - imgDrag.startY) / pv.scale;
    if (mode === 'move') {
      im.x = Math.max(-im.w / 2, Math.min(pv.baseW - im.w / 2, imgDrag.x0 + dx));
      im.y = Math.max(-im.h / 2, Math.min(pv.baseH - im.h / 2, imgDrag.y0 + dy));
      box.style.left = (im.x / pv.baseW * 100) + '%';
      box.style.top = (im.y / pv.baseH * 100) + '%';
    } else {
      const ratio = imgDrag.h0 / imgDrag.w0;
      const w = Math.max(30, imgDrag.w0 + dx);
      im.w = w; im.h = w * ratio;                       // 縦横比を保つ
      box.style.width = (im.w / pv.baseW * 100) + '%';
      box.style.height = (im.h / pv.baseH * 100) + '%';
    }
  }
  function endImgDrag() {
    if (!imgDrag) return;
    document.removeEventListener('pointermove', onImgDragMove);
    document.removeEventListener('pointerup', endImgDrag);
    imgDrag = null; markDirty();
  }

  /* 画像をいまのページに置く（読み込んだ画像ファイルから） */
  async function placeImageOnPage(file) {
    if (!nb || !nb.pages.length) { PN.ui.toast('先にPDFか画像のページを追加してください'); return; }
    const pv = pageViews[currentIdx]; if (!pv) return;
    PN.ui.busy(true, '画像を読み込み中…');
    try {
      const ext = (file.name && file.name.match(/\.(png|jpe?g|webp)$/i) || [, 'png'])[1].toLowerCase();
      const asset = await PN.storage.addAsset(nb.id, file, ext);
      const url = URL.createObjectURL(file); imgUrls.push(url);
      objUrls[asset] = url;
      const img = await loadImg(url);
      // ページ幅の半分くらいの大きさで、見えている位置の中央に置く
      const targetW = Math.min(pv.baseW * 0.5, img.naturalWidth);
      const ratio = img.naturalHeight / img.naturalWidth;
      const w = targetW, h = targetW * ratio;
      const c = visibleCenterOf(pv);
      pushUndo(pv.idx);
      imagesOf(pv.idx).push({
        id: 'im-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7),
        asset, x: Math.max(0, c.x - w / 2), y: Math.max(0, c.y - h / 2), w, h
      });
      selImg = { pv, idx: imagesOf(pv.idx).length - 1 };
      setTool('image');
      renderImages(pv);
      markDirty();
      PN.ui.toast('画像を置きました。ドラッグで移動、右下で大きさ変更');
    } catch (e) {
      console.error(e); PN.ui.toast('画像を読み込めませんでした');
    }
    PN.ui.busy(false);
  }

  /* いま画面に見えているページ内の中心（ページ座標） */
  function visibleCenterOf(pv) {
    const sr = elScroller.getBoundingClientRect(), r = pv.el.getBoundingClientRect();
    const cx = Math.min(Math.max(sr.left + sr.width / 2, r.left), r.right);
    const cy = Math.min(Math.max(sr.top + sr.height / 2, r.top), r.bottom);
    return { x: (cx - r.left) / pv.scale, y: (cy - r.top) / pv.scale };
  }

  /* ---- カメラで撮る ---- */
  /* onShot を渡すと、撮った写真の使い道を変えられる（既定はページの上に置く） */
  async function captureFromCamera(onShot) {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      PN.ui.toast('このブラウザではカメラを使えません'); return;
    }
    let stream = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false });
    } catch (e) {
      PN.ui.toast(e && e.name === 'NotAllowedError' ? 'カメラの使用が許可されませんでした' : 'カメラを起動できませんでした');
      return;
    }
    const back = document.createElement('div');
    back.className = 'modal-back';
    back.innerHTML = `
      <div class="modal cam-modal">
        <h3>カメラで撮る</h3>
        <div class="cam-wrap"><video id="cam-video" autoplay playsinline muted></video></div>
        <div class="modal-foot">
          <button class="bar-btn ghost" data-act="cancel">やめる</button>
          <button class="bar-btn primary" data-act="shot">${PN.ui.icon('camera')}撮影する</button>
        </div>
      </div>`;
    document.getElementById('modal-root').appendChild(back);
    const video = back.querySelector('#cam-video');
    video.srcObject = stream;
    const close = () => { try { stream.getTracks().forEach(t => t.stop()); } catch (e) {} back.remove(); };
    back.addEventListener('click', async (e) => {
      const act = e.target.getAttribute('data-act');
      if (e.target === back || act === 'cancel') { close(); return; }
      if (act === 'shot') {
        const cv = document.createElement('canvas');
        cv.width = video.videoWidth || 1280; cv.height = video.videoHeight || 720;
        cv.getContext('2d').drawImage(video, 0, 0, cv.width, cv.height);
        close();
        const blob = await new Promise(res => cv.toBlob(res, 'image/jpeg', 0.9));
        if (blob) { blob.name = 'photo.jpg'; await (onShot ? onShot(blob) : placeImageOnPage(blob)); }
      }
    });
  }

  /* 「画像」ボタンのメニュー */
  function imageMenu(anchor) {
    PN.ui.menu(anchor, [
      { icon: 'image', label: '写真を選ぶ', onClick: () => PN.app.pickImageForPage() },
      { icon: 'camera', label: 'カメラで撮る', onClick: captureFromCamera }
    ]);
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
  const DEFAULT_TEXT_COLORS = ['#1a1a1a', '#e0301e', '#1e6fe0', '#15a05a', '#f0a500', '#ffffff'];
  const TEXT_COLORS = DEFAULT_TEXT_COLORS.slice();
  const TEXT_COLORS_KEY = 'pdfnote.textColors';

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
      loadPalette(TEXT_COLORS_KEY, TEXT_COLORS, DEFAULT_TEXT_COLORS);
      textStyle.color = TEXT_COLORS[0];
      drawTextColors = buildColorRow(cs, TEXT_COLORS, TEXT_COLORS_KEY, DEFAULT_TEXT_COLORS,
        () => (selectedTextObj() || textStyle).color,
        (c) => applyTextStyle({ color: c }));
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

  /* 投げ縄パネルの結線 */
  function buildLassoControls() {
    loadLassoPick();      // 前回の「選ぶ種類」を復元する
    document.querySelectorAll('#grp-lasso [data-kind]').forEach(cb => {
      cb.checked = lassoPick[cb.dataset.kind];
      cb.addEventListener('change', () => { lassoPick[cb.dataset.kind] = cb.checked; saveLassoPick(); });
    });
    $('#lasso-cut').addEventListener('click', () => copySelection(true));
    $('#lasso-copy').addEventListener('click', () => copySelection(false));
    $('#lasso-paste').addEventListener('click', pasteClipboard);
    $('#lasso-dup').addEventListener('click', duplicateSelection);
    $('#lasso-delete').addEventListener('click', () => deleteSelection(false));
    buildLassoColors();
    updateLassoButtons();
  }

  /* 投げ縄の「色を変える」は、ペンの色をそのまま使う（入れ替えたら付いてくる） */
  function buildLassoColors() {
    const cs = $('#lasso-colors'); if (!cs) return;
    cs.innerHTML = '';
    COLORS.forEach((c) => {
      const b = document.createElement('span');
      b.className = 'color-swatch'; b.style.background = c; b.dataset.color = c; b.title = c;
      b.addEventListener('click', () => recolorSelection(c));
      cs.appendChild(b);
    });
  }

  /* 書式パネルの表示を、いまの設定（または選択中のボックス）に合わせる */
  function syncTextControls() {
    const t = selectedTextObj() || textStyle;
    const sel = $('#text-font'); if (sel) sel.value = t.font;
    const size = $('#text-size'); if (size) size.value = t.size;
    if (drawTextColors) drawTextColors();      // 選ばれている色の印を付け直す
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
      // 縦書き⇄横書きを切り替えたら、箱の縦横も入れ替えて向きを合わせる
      const flip = (patch.vertical !== undefined && !!patch.vertical !== !!t.vertical);
      Object.assign(t, patch);
      if (flip) {
        const pv = selText.pv, w = t.w, h = t.h;
        t.w = Math.min(h, pv.baseW); t.h = Math.min(w, pv.baseH);
        t.x = Math.max(0, Math.min(pv.baseW - t.w, t.x));
        t.y = Math.max(0, Math.min(pv.baseH - t.h, t.y));
      }
      renderTexts(selText.pv);
      markDirty();
    }
    syncTextControls();
  }

  /* ---- 描画（DOM） ---- */

  /* 箱の位置・大きさ・書式を反映する。入力中の文字にはさわらない */
  function styleTextBox(el, body, t, pv, idx) {
    el.style.left = (t.x / pv.baseW * 100) + '%';
    el.style.top = (t.y / pv.baseH * 100) + '%';
    el.style.width = (t.w / pv.baseW * 100) + '%';
    el.style.height = (t.h / pv.baseH * 100) + '%';
    el.style.background = (t.bg === 'white') ? '#fff' : '';
    el.classList.toggle('selected', !!(selText && selText.pv === pv && selText.idx === idx));
    body.style.fontFamily = t.font;
    body.style.fontSize = (t.size * pv.scale) + 'px';
    body.style.color = t.color;
    body.style.fontWeight = t.bold ? '700' : '400';
    body.style.textAlign = t.align || 'left';
    body.style.writingMode = t.vertical ? 'vertical-rl' : '';
  }

  /* 入力中の箱があるか（この文字レイヤーの中に焦点があるか） */
  function editingBodyIn(pv) {
    const a = document.activeElement;
    return (a && a.classList && a.classList.contains('tb-body') && pv.text.contains(a)) ? a : null;
  }

  function renderTexts(pv) {
    if (!nb || !nb.pages.length) { pv.text.innerHTML = ''; return; }
    const arr = textsOf(pv.idx);

    /* 入力中の箱は作り直さない。
       作り直すと焦点が外れ、ソフトウェアキーボードも閉じてしまう。
       （キーボードが出ると画面が縮んで resize → relayoutAll が走り、
         ここが呼ばれる。書きかけの箱が消える原因になっていた）
       位置と書式だけ合わせ直し、中身の文字と入力中の変換はそのままにする。 */
    if (editingBodyIn(pv) && pv.text.querySelectorAll('.textbox').length === arr.length) {
      arr.forEach((t, idx) => {
        const el = pv.text.querySelector('.textbox[data-idx="' + idx + '"]');
        const body = el && el.querySelector('.tb-body');
        if (el && body) styleTextBox(el, body, t, pv, idx);
      });
      syncTextControls();
      return;
    }

    pv.text.innerHTML = '';
    const editing = (tool === 'text');
    arr.forEach((t, idx) => {
      const el = document.createElement('div');
      el.className = 'textbox' + (editing ? ' editing' : '');
      el.dataset.idx = idx;

      const body = document.createElement('div');
      body.className = 'tb-body';
      body.textContent = t.text || '';
      if (editing) { body.contentEditable = 'true'; body.spellcheck = false; }
      el.appendChild(body);
      styleTextBox(el, body, t, pv, idx);

      if (editing) {
        // 左右の線＝幅を変えるつまみ。移動は「投げ縄」で行う
        const wl = document.createElement('button'); wl.className = 'tb-wl'; wl.title = '左右に動かして幅を変える';
        const wr = document.createElement('button'); wr.className = 'tb-wr'; wr.title = '左右に動かして幅を変える';
        const del = document.createElement('button'); del.className = 'tb-del'; del.textContent = '×'; del.title = '削除';
        const rs = document.createElement('button'); rs.className = 'tb-resize'; rs.title = '上下に動かして高さを変える';
        el.append(wl, wr, del, rs);
        wireTextBox(pv, el, idx, body, wl, wr, del, rs);
      }
      pv.text.appendChild(el);
    });
    syncTextControls();
    // 投げ縄の選択枠はこのレイヤーに重ねているので、作り直したら付け直す
    // （付け直さないと、枠だけ消えて選択が残り、指のスクロールが止まったままになる）
    if (lassoSel && lassoSel.pv === pv) renderLasso();
  }

  /* ---- 1つのテキストボックスの操作 ---- */
  function wireTextBox(pv, el, idx, body, wl, wr, del, rs) {
    body.addEventListener('pointerdown', (e) => { e.stopPropagation(); selectText(pv, idx); });
    body.addEventListener('input', () => { textsOf(pv.idx)[idx].text = body.innerText; markDirty(); });
    // 焦点が当たったら、キーボードが出ても画面が動かないよう位置を押さえる
    body.addEventListener('focus', holdViewForKeyboard);
    // ※ 空の箱は blur では消さない（キーボードの出入りでも外れてしまうため）。
    //    dropEmptyTexts で、作り直すとき・道具を変えるとき・閉じるときに片づける。
    // つまみを押しても、入力中の焦点が外れないようにする
    [wl, wr, del, rs].forEach(btn => btn.addEventListener('mousedown', (e) => e.preventDefault()));
    del.addEventListener('pointerdown', (e) => e.stopPropagation());
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      pushUndo(pv.idx);
      textsOf(pv.idx).splice(idx, 1);
      selText = null; renderTexts(pv); markDirty();
    });
    wl.addEventListener('pointerdown', (e) => startTextDrag(e, pv, idx, 'w-left', el));
    wr.addEventListener('pointerdown', (e) => startTextDrag(e, pv, idx, 'w-right', el));
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
    const MINW = 40;
    if (mode === 'w-right') {                     // 右の線＝右へ広げる／左へ縮める
      t.w = Math.max(MINW, Math.min(pv.baseW - t.x, textDrag.w0 + dx));
      textDrag.el.style.width = (t.w / pv.baseW * 100) + '%';
    } else if (mode === 'w-left') {               // 左の線＝右の端は動かさずに幅を変える
      const right = textDrag.x0 + textDrag.w0;
      const nx = Math.max(0, Math.min(right - MINW, textDrag.x0 + dx));
      t.x = nx; t.w = right - nx;
      textDrag.el.style.left = (t.x / pv.baseW * 100) + '%';
      textDrag.el.style.width = (t.w / pv.baseW * 100) + '%';
    } else {                                      // 下のつまみ＝高さだけ変える
      t.h = Math.max(24, Math.min(pv.baseH - t.y, textDrag.h0 + dy));
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

  /* 何もない所をタップ＝新しいテキストボックスを作る（タッチペンでも指でもよい） */
  let pendingText = null;      // 指でタップしたときだけ作るための覚え書き
  function onTextLayerDown(e, pv) {
    if (tool !== 'text' || suppressDraw) return;
    if (e.target.closest('.textbox')) return;      // 既存のボックス上なら何もしない
    /* ペンや指でタップすると、ブラウザはこのあと mousedown・click を追加で送ってくる。
       できたばかりの箱の上には幅を変えるつまみと × があるため、
       そのままだと押したことになってしまう。既定の動作を止めて防ぐ。 */
    e.preventDefault();
    /* 指のときは、離すまで待つ。動かさずに離した（＝タップした）ときだけ箱を作る。
       動かしたときは画面のスクロールなので、箱を作らない
       （作ってしまうと、スクロールのたびにソフトウェアキーボードが開いてしまう）。 */
    if (e.pointerType === 'touch') {
      pendingText = { pv, id: e.pointerId, x: e.clientX, y: e.clientY };
      return;
    }
    createTextAt(e, pv);
  }
  /* 指を離したとき：動かしていなければ、そこに箱を作る */
  function onTextLayerUp(e) {
    const g = pendingText; pendingText = null;
    if (!g || g.id !== e.pointerId) return;
    if (tool !== 'text' || suppressDraw || !nb) return;
    if (Math.hypot(e.clientX - g.x, e.clientY - g.y) > 10) return;   // 動かした＝スクロール
    if (Date.now() - lastPinchEnd < 300) return;                     // ピンチの直後は作らない
    if (!pageViews.includes(g.pv)) return;
    createTextAt(e, g.pv);
  }
  function createTextAt(e, pv) {
    const [x, y] = toIntrinsic(e, pv);
    pushUndo(pv.idx);
    dropEmptyTexts(pv);              // 書かないまま残っていた箱をここで片づける
    // 縦書きなら縦長、横書きなら横長の箱で作る
    const longSide = 130, shortSide = Math.max(40, textStyle.size * 2);
    const bw = textStyle.vertical ? shortSide : longSide;
    const bh = textStyle.vertical ? longSide : shortSide;
    const t = {
      x: Math.max(0, Math.min(pv.baseW - bw, x)), y: Math.max(0, Math.min(pv.baseH - bh, y)),
      w: Math.min(bw, pv.baseW), h: Math.min(bh, pv.baseH),
      text: '', font: textStyle.font, size: textStyle.size, color: textStyle.color,
      bold: textStyle.bold, align: textStyle.align, vertical: textStyle.vertical, bg: textStyle.bg
    };
    const arr = textsOf(pv.idx);
    arr.push(t);
    selText = { pv, idx: arr.length - 1 };
    renderTexts(pv);
    markDirty();

    /* すぐに入力できるようにする。
       preventScroll:true ＝ 焦点を当てたせいで画面が動くのを止める。
       setTimeout ではなくその場で当てるので、あとから来る操作に邪魔されない。 */
    const el = pv.text.querySelector('.textbox[data-idx="' + (arr.length - 1) + '"] .tb-body');
    if (el) {
      focusTextBody(el);
      // 念のため、次の描画のあとにもう一度確かめる（何かに取られていたら戻す）
      requestAnimationFrame(() => { if (el.isConnected && document.activeElement !== el) focusTextBody(el); });
    }

    /* このあと1回だけ来る「クリック」を食い止める。
       放っておくと、いま作った箱の「移動」つまみや × の上に落ちてしまう。 */
    const eatClick = (ev) => { ev.stopPropagation(); ev.preventDefault(); };
    pv.text.addEventListener('click', eatClick, true);
    setTimeout(() => pv.text.removeEventListener('click', eatClick, true), 700);
  }

  function focusTextBody(el) {
    try { el.focus({ preventScroll: true }); } catch (err) { el.focus(); }
  }

  /* ソフトウェアキーボードが出るとき、ブラウザが「入力中の所を見せよう」として
     画面を勝手に動かすことがある（タブレットで、書きかけの箱が上へずれて見えなくなる）。
     焦点が当たってからしばらくの間、元の位置に戻し続けて動かさないようにする。
     viewport の interactive-widget=overlays-content と合わせた二重の備え。 */
  let kbHold = null;
  function holdViewForKeyboard() {
    if (!elScroller) return;
    releaseViewHold();
    const left = elScroller.scrollLeft, top = elScroller.scrollTop;
    const restore = () => {
      if (elScroller.scrollLeft !== left) elScroller.scrollLeft = left;
      if (elScroller.scrollTop !== top) elScroller.scrollTop = top;
      if (window.scrollX || window.scrollY) window.scrollTo(0, 0);   // ページ全体が動くのも止める
    };
    const vv = window.visualViewport;
    if (vv) vv.addEventListener('resize', restore);
    const iv = setInterval(restore, 50);     // キーボードが出てくる途中も押さえ続ける
    const end = setTimeout(releaseViewHold, 1600);
    kbHold = { iv, end, restore };
  }
  /* 先生が自分で動かしはじめたら、押さえるのをやめる */
  function releaseViewHold() {
    if (!kbHold) return;
    clearInterval(kbHold.iv); clearTimeout(kbHold.end);
    if (window.visualViewport) window.visualViewport.removeEventListener('resize', kbHold.restore);
    kbHold = null;
  }

  /* 中身が空のままの箱を片づける。
     以前は「焦点が外れたら消す」にしていたが、ソフトウェアキーボードの出入りや
     つまみへの焦点移動でも外れてしまい、書く前に消えることがあった。
     新しく作るとき・道具を変えるとき・ノートを閉じるときにだけ片づける。 */
  function dropEmptyTexts(pv) {
    if (!nb || !nb.pages[pv.idx]) return false;
    const arr = textsOf(pv.idx);
    let removed = false;
    for (let i = arr.length - 1; i >= 0; i--) {
      if (!(arr[i].text || '').trim()) { arr.splice(i, 1); removed = true; }
    }
    if (removed) { selText = null; renderTexts(pv); }
    return removed;
  }

  /* ========== 投げ縄（なげなわ選択） ========== */

  /* どの種類を選ぶか（1つずつ切り替えられる） */
  const lassoPick = { strokes: true, images: true, texts: true, masks: true };
  const LASSO_PICK_KEY = 'pdfnote.lassoPick';
  function loadLassoPick() {
    try {
      const v = JSON.parse(localStorage.getItem(LASSO_PICK_KEY) || 'null');
      if (v && typeof v === 'object') KINDS.forEach(k => { if (typeof v[k] === 'boolean') lassoPick[k] = v[k]; });
    } catch (e) { /* 読めなければ既定のまま */ }
  }
  function saveLassoPick() {
    try { localStorage.setItem(LASSO_PICK_KEY, JSON.stringify(lassoPick)); } catch (e) {}
  }
  let lassoPath = null;      // 描いている最中の囲み線
  let lassoSel = null;       // { pv, items:{strokes:[],images:[],texts:[],masks:[]}, box:{x,y,w,h} }
  let clipboard = null;      // コピー／カットしたもの

  const KINDS = ['strokes', 'images', 'texts', 'masks'];

  function pointInPoly(x, y, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1];
      if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / ((yj - yi) || 1e-9) + xi)) inside = !inside;
    }
    return inside;
  }
  /* 線分 ab と 線分 cd が交わるか */
  function segCross(a, b, c, d) {
    const cr = (p, q, r) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
    const d1 = cr(c, d, a), d2 = cr(c, d, b), d3 = cr(a, b, c), d4 = cr(a, b, d);
    return ((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0));
  }
  /* 線分 ab が囲みの線と交わるか */
  function segCrossesPoly(a, b, poly) {
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++)
      if (segCross(a, b, poly[j], poly[i])) return true;
    return false;
  }
  /* 囲みを囲む長方形（遠くのものを手早く除くため） */
  function polyBBox(poly) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    poly.forEach(p => { x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]); x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]); });
    return { x0, y0, x1, y1 };
  }
  const bbOverlap = (bb, x0, y0, x1, y1) => !(x1 < bb.x0 || x0 > bb.x1 || y1 < bb.y0 || y0 > bb.y1);

  /* 箱が囲みに少しでも重なっていれば選ぶ（全部を囲まなくてよい）。
     ①角が囲みの中 ②囲みが箱の中 ③辺どうしが交わる のどれかで「重なり」とみなす。
     この3つで、重なっている場合をもれなく拾える。 */
  function boxHitsPoly(o, poly, bb) {
    const x0 = o.x, y0 = o.y, x1 = o.x + o.w, y1 = o.y + o.h;
    if (bb && !bbOverlap(bb, x0, y0, x1, y1)) return false;
    const corners = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
    for (const c of corners) if (pointInPoly(c[0], c[1], poly)) return true;
    for (const p of poly) if (p[0] >= x0 && p[0] <= x1 && p[1] >= y0 && p[1] <= y1) return true;
    for (let i = 0; i < 4; i++) if (segCrossesPoly(corners[i], corners[(i + 1) % 4], poly)) return true;
    return false;
  }
  /* テキストボックスの「実際に文字が見えている範囲」を内部座標で返す。
     箱は中身より大きいことが多く（作成時は横260px）、「文字」以外の道具では
     枠が見えないため、見えている文字のまわりを囲んだだけでは選べなかった。
     文字が空のときや、まだ描画されていないページのときは null を返し、
     呼び出し側は箱そのもので判定する。 */
  function textVisibleRect(pv, idx) {
    const body = pv.text.querySelector('.textbox[data-idx="' + idx + '"] .tb-body');
    if (!body || !body.firstChild) return null;
    let rects;
    try {
      const range = document.createRange();
      range.selectNodeContents(body);
      rects = range.getClientRects();
    } catch (e) { return null; }
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let i = 0; i < rects.length; i++) {
      const q = rects[i];
      if (!q.width && !q.height) continue;    // 改行だけの行は無視
      x0 = Math.min(x0, q.left); y0 = Math.min(y0, q.top);
      x1 = Math.max(x1, q.right); y1 = Math.max(y1, q.bottom);
    }
    if (!isFinite(x0) || x1 <= x0 || y1 <= y0) return null;
    const pr = pv.el.getBoundingClientRect();
    return {
      x: (x0 - pr.left) / pv.scale, y: (y0 - pr.top) / pv.scale,
      w: (x1 - x0) / pv.scale, h: (y1 - y0) / pv.scale
    };
  }
  /* 文字は、見えている文字のまわりで判定する。
     箱は中身よりずっと大きいことが多く（作成時は横260px）、そのまま使うと
     文字から離れた所を囲んだだけで選ばれてしまうため。
     まだ描画されていないページでは箱そのもので判定する。 */
  function textHitsPoly(pv, idx, o, poly, bb) {
    const v = textVisibleRect(pv, idx);
    return boxHitsPoly(v || o, poly, bb);
  }
  /* 線は、一部でも囲みにかかっていれば選ぶ。
     ①点が囲みの中にある ②線が囲みの線と交わる のどちらかで選ぶ。
     ②があるので、点の少ない「直線」を横切っただけでも選べる。 */
  function strokeHitsPoly(s, poly, bb) {
    const pts = s.points || []; if (!pts.length) return false;
    if (bb) {                                  // 遠くの線は手早く除く
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const p of pts) { if (p[0] < x0) x0 = p[0]; if (p[0] > x1) x1 = p[0]; if (p[1] < y0) y0 = p[1]; if (p[1] > y1) y1 = p[1]; }
      if (!bbOverlap(bb, x0, y0, x1, y1)) return false;
    }
    for (const p of pts) if (pointInPoly(p[0], p[1], poly)) return true;
    for (let i = 1; i < pts.length; i++) if (segCrossesPoly(pts[i - 1], pts[i], poly)) return true;
    return false;
  }

  function selectionBox(pv, items) {
    let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
    const add = (ax, ay, bx, by) => { x1 = Math.min(x1, ax); y1 = Math.min(y1, ay); x2 = Math.max(x2, bx); y2 = Math.max(y2, by); };
    const ann = annOf(pv.idx);
    items.strokes.forEach(i => (ann.strokes[i].points || []).forEach(p => add(p[0], p[1], p[0], p[1])));
    ['images', 'texts', 'masks'].forEach(k => items[k].forEach(i => { const o = ann[k][i]; add(o.x, o.y, o.x + o.w, o.y + o.h); }));
    if (!isFinite(x1)) return null;
    const pad = 6;
    return { x: x1 - pad, y: y1 - pad, w: (x2 - x1) + pad * 2, h: (y2 - y1) + pad * 2 };
  }
  const selCount = (items) => KINDS.reduce((n, k) => n + items[k].length, 0);

  /* 囲み終わったら中身を判定して選択する */
  function finishLasso(pv, poly) {
    const ann = annOf(pv.idx);
    const items = { strokes: [], images: [], texts: [], masks: [] };
    const bb = polyBBox(poly);
    if (lassoPick.strokes) ann.strokes.forEach((s, i) => { if (strokeHitsPoly(s, poly, bb)) items.strokes.push(i); });
    if (lassoPick.images) ann.images.forEach((o, i) => { if (boxHitsPoly(o, poly, bb)) items.images.push(i); });
    if (lassoPick.texts) ann.texts.forEach((o, i) => { if (textHitsPoly(pv, i, o, poly, bb)) items.texts.push(i); });
    if (lassoPick.masks) ann.masks.forEach((o, i) => { if (boxHitsPoly(o, poly, bb)) items.masks.push(i); });
    if (!selCount(items)) { clearLasso(); PN.ui.toast('囲みの中に選べるものがありませんでした'); return; }
    // 囲んだ曲線をそのまま覚えておき、選択の形として表示する
    lassoSel = { pv, items, box: selectionBox(pv, items), poly: poly.map(p => [p[0], p[1]]) };
    renderLasso();
  }
  function clearLasso() { lassoSel = null; renderLasso(); }
  /* 囲んだ範囲の大きさ（タップと囲みを見分けるため） */
  function polySpan(poly) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    poly.forEach(p => { x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]); x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]); });
    return Math.max(x1 - x0, y1 - y0);
  }

  /* 囲んでいる最中の線を描く */
  function drawLassoPath(pv, poly) {
    clearCtx(pv.live, pv.livectx);
    const ctx = pv.livectx;
    ctx.save();
    ctx.strokeStyle = '#3d8bfd'; ctx.lineWidth = 1.5; ctx.setLineDash([6, 4]);
    ctx.beginPath();
    ctx.moveTo(poly[0][0] * pv.scale, poly[0][1] * pv.scale);
    for (let i = 1; i < poly.length; i++) ctx.lineTo(poly[i][0] * pv.scale, poly[i][1] * pv.scale);
    ctx.closePath(); ctx.stroke();
    ctx.fillStyle = 'rgba(61,139,253,.10)'; ctx.fill();
    ctx.restore();
  }

  /* 四角い枠のかわりに使う、長方形の形（貼り付け・複製のときはこちら） */
  const rectPoly = (b) => [[b.x, b.y], [b.x + b.w, b.y], [b.x + b.w, b.y + b.h], [b.x, b.y + b.h]];
  /* 形を囲む長方形。表示と、拡大縮小のつまみの位置に使う */
  function polyRect(poly) {
    const b = polyBBox(poly);
    return { x: b.x0, y: b.y0, w: Math.max(1, b.x1 - b.x0), h: Math.max(1, b.y1 - b.y0) };
  }
  /* 表示に使う形（囲んだ曲線。貼り付け・複製では長方形） */
  const shapeOf = (sel) => (sel.poly && sel.poly.length > 2) ? sel.poly : rectPoly(sel.box);

  /* 選択を表示する。囲んだときの曲線を、そのまま選択の形として残す */
  function renderLasso() {
    document.querySelectorAll('.lasso-sel').forEach(e => e.remove());
    updateLassoButtons();
    if (!lassoSel) return;
    const pv = lassoSel.pv;
    const poly = shapeOf(lassoSel);
    const sb = polyRect(poly);          // 入れ物は「描いた形」に合わせる（つまみもその右下に付く）
    const el = document.createElement('div');
    el.className = 'lasso-sel';
    el.style.left = (sb.x / pv.baseW * 100) + '%';
    el.style.top = (sb.y / pv.baseH * 100) + '%';
    el.style.width = (sb.w / pv.baseW * 100) + '%';
    el.style.height = (sb.h / pv.baseH * 100) + '%';

    /* 曲線は SVG で描く。囲みの外にはみ出しても切れないよう overflow は visible。
       線の太さと点線の間隔は、拡大しても一定に見えるよう non-scaling-stroke にする。 */
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('class', 'ls-shape');
    svg.setAttribute('viewBox', sb.x + ' ' + sb.y + ' ' + sb.w + ' ' + sb.h);
    svg.setAttribute('preserveAspectRatio', 'none');
    const pg = document.createElementNS(NS, 'polygon');
    pg.setAttribute('points', poly.map(p => p[0] + ',' + p[1]).join(' '));
    pg.setAttribute('vector-effect', 'non-scaling-stroke');
    svg.appendChild(pg);
    el.appendChild(svg);

    const rs = document.createElement('button'); rs.className = 'ls-resize'; rs.title = 'ドラッグで拡大・縮小';
    el.appendChild(rs);
    el.addEventListener('pointerdown', (e) => { if (!rs.contains(e.target)) startLassoDrag(e, 'move'); });
    rs.addEventListener('pointerdown', (e) => startLassoDrag(e, 'resize'));
    pv.text.appendChild(el);       // 文字レイヤーの上に重ねて表示
    // ※ レイヤー全体は塞がない。曲線の中と、右下のつまみだけが操作を受け取る
    //   （曲線の外のタップは下の投げ縄に通り、選択を解除して次の選択に移れる）
  }

  /* 選択したものをまとめて動かす／拡大縮小する */
  let lassoDrag = null;
  function startLassoDrag(e, mode) {
    if (!lassoSel) return;
    e.preventDefault(); e.stopPropagation();
    pushUndo(lassoSel.pv.idx);
    lassoDrag = { mode, startX: e.clientX, startY: e.clientY, box0: Object.assign({}, lassoSel.box),
      sb0: polyRect(shapeOf(lassoSel)),                       // 拡大縮小はこの形を基準にする
      poly0: (lassoSel.poly || []).map(p => [p[0], p[1]]), snap: snapshotSelection() };
    document.addEventListener('pointermove', onLassoDragMove);
    document.addEventListener('pointerup', endLassoDrag);
  }
  function snapshotSelection() {
    const ann = annOf(lassoSel.pv.idx), out = {};
    out.strokes = lassoSel.items.strokes.map(i => JSON.parse(JSON.stringify(ann.strokes[i].points)));
    ['images', 'texts', 'masks'].forEach(k => {
      out[k] = lassoSel.items[k].map(i => { const o = ann[k][i]; return { x: o.x, y: o.y, w: o.w, h: o.h, size: o.size }; });
    });
    return out;
  }
  function onLassoDragMove(e) {
    if (!lassoDrag || !lassoSel) return;
    const pv = lassoSel.pv, ann = annOf(pv.idx), b0 = lassoDrag.box0, s = lassoDrag.snap;
    const dx = (e.clientX - lassoDrag.startX) / pv.scale, dy = (e.clientY - lassoDrag.startY) / pv.scale;
    if (lassoDrag.mode === 'move') {
      lassoSel.items.strokes.forEach((idx, n) => {
        ann.strokes[idx].points = s.strokes[n].map(p => [p[0] + dx, p[1] + dy, p[2]]);
      });
      ['images', 'texts', 'masks'].forEach(k => lassoSel.items[k].forEach((idx, n) => {
        ann[k][idx].x = s[k][n].x + dx; ann[k][idx].y = s[k][n].y + dy;
      }));
      lassoSel.box = { x: b0.x + dx, y: b0.y + dy, w: b0.w, h: b0.h };
      lassoSel.poly = lassoDrag.poly0.map(p => [p[0] + dx, p[1] + dy]);
    } else {
      // つまみが指について来るよう、描いた形の左上を固定して拡大縮小する
      const s0 = lassoDrag.sb0;
      const f = Math.max(0.15, Math.min(6, (s0.w + dx) / s0.w));
      const ox = s0.x, oy = s0.y;
      lassoSel.items.strokes.forEach((idx, n) => {
        ann.strokes[idx].points = s.strokes[n].map(p => [ox + (p[0] - ox) * f, oy + (p[1] - oy) * f, p[2]]);
      });
      ['images', 'texts', 'masks'].forEach(k => lassoSel.items[k].forEach((idx, n) => {
        const o = ann[k][idx], q = s[k][n];
        o.x = ox + (q.x - ox) * f; o.y = oy + (q.y - oy) * f;
        o.w = q.w * f; o.h = q.h * f;
        if (k === 'texts' && q.size) o.size = Math.max(6, q.size * f);
      }));
      lassoSel.box = { x: ox + (b0.x - ox) * f, y: oy + (b0.y - oy) * f, w: b0.w * f, h: b0.h * f };
      lassoSel.poly = lassoDrag.poly0.map(p => [ox + (p[0] - ox) * f, oy + (p[1] - oy) * f]);
    }
    redrawSelPage(); renderLasso();
  }
  function endLassoDrag() {
    if (!lassoDrag) return;
    document.removeEventListener('pointermove', onLassoDragMove);
    document.removeEventListener('pointerup', endLassoDrag);
    lassoDrag = null; markDirty();
  }
  /* ページを描き直す。選択を解除したあとでも描き直せるよう、対象ページを渡せる */
  function redrawSelPage(pvArg) {
    const pv = pvArg || (lassoSel && lassoSel.pv);
    if (!pv) return;
    renderInk(pv); renderImages(pv); renderTexts(pv); renderMasks(pv);
  }

  /* ---- 削除・コピー・カット・複製・色 ---- */
  function copySelection(cut) {
    if (!lassoSel) return;
    const ann = annOf(lassoSel.pv.idx), box = lassoSel.box;
    const data = { box: Object.assign({}, box), strokes: [], images: [], texts: [], masks: [] };
    lassoSel.items.strokes.forEach(i => data.strokes.push(JSON.parse(JSON.stringify(ann.strokes[i]))));
    ['images', 'texts', 'masks'].forEach(k => lassoSel.items[k].forEach(i => data[k].push(JSON.parse(JSON.stringify(ann[k][i])))));
    clipboard = data;
    if (cut) deleteSelection(true);
    else { PN.ui.toast(selCount(lassoSel.items) + ' 個をコピーしました'); updateLassoButtons(); }
  }
  function deleteSelection(quiet) {
    if (!lassoSel) return;
    const pv = lassoSel.pv, ann = annOf(pv.idx);
    pushUndo(pv.idx);
    KINDS.forEach(k => {
      lassoSel.items[k].slice().sort((a, b) => b - a).forEach(i => ann[k].splice(i, 1));
    });
    const n = selCount(lassoSel.items);
    clearLasso();
    redrawSelPage(pv);          // 選択を解除したあとでも、そのページを確実に描き直す
    markDirty();
    if (!quiet) PN.ui.toast(n + ' 個を削除しました');
    else PN.ui.toast(n + ' 個をカットしました');
  }
  function duplicateSelection() {
    if (!lassoSel) return;
    const pv = lassoSel.pv, ann = annOf(pv.idx), d = 24;
    pushUndo(pv.idx);
    const added = { strokes: [], images: [], texts: [], masks: [] };
    lassoSel.items.strokes.forEach(i => {
      const s = JSON.parse(JSON.stringify(ann.strokes[i]));
      s.points = s.points.map(p => [p[0] + d, p[1] + d, p[2]]);
      ann.strokes.push(s); added.strokes.push(ann.strokes.length - 1);
    });
    ['images', 'texts', 'masks'].forEach(k => lassoSel.items[k].forEach(i => {
      const o = JSON.parse(JSON.stringify(ann[k][i]));
      o.x += d; o.y += d; if (o.id) o.id = o.id + '-c' + Math.random().toString(36).slice(2, 6);
      ann[k].push(o); added[k].push(ann[k].length - 1);
    }));
    lassoSel = { pv, items: added, box: selectionBox(pv, added) };
    redrawSelPage(); renderLasso(); markDirty();
    PN.ui.toast('複製しました');
  }
  function pasteClipboard() {
    if (!clipboard) { PN.ui.toast('コピーされたものがありません'); return; }
    const pv = pageViews[currentIdx]; if (!pv) return;
    const ann = annOf(pv.idx);
    const same = lassoSel && lassoSel.pv === pv;
    const d = same ? 24 : 0;
    pushUndo(pv.idx);
    const added = { strokes: [], images: [], texts: [], masks: [] };
    clipboard.strokes.forEach(s0 => {
      const s = JSON.parse(JSON.stringify(s0));
      s.points = s.points.map(p => [p[0] + d, p[1] + d, p[2]]);
      ann.strokes.push(s); added.strokes.push(ann.strokes.length - 1);
    });
    ['images', 'texts', 'masks'].forEach(k => clipboard[k].forEach(o0 => {
      const o = JSON.parse(JSON.stringify(o0));
      o.x = Math.max(0, Math.min(pv.baseW - 10, o.x + d));
      o.y = Math.max(0, Math.min(pv.baseH - 10, o.y + d));
      if (o.id) o.id = o.id + '-p' + Math.random().toString(36).slice(2, 6);
      ann[k].push(o); added[k].push(ann[k].length - 1);
    }));
    setTool('lasso');
    lassoSel = { pv, items: added, box: selectionBox(pv, added) };
    redrawSelPage(); renderLasso(); markDirty();
    PN.ui.toast('貼り付けました');
  }
  function recolorSelection(c) {
    if (!lassoSel) return;
    const ann = annOf(lassoSel.pv.idx);
    pushUndo(lassoSel.pv.idx);
    lassoSel.items.strokes.forEach(i => { ann.strokes[i].color = c; });
    lassoSel.items.texts.forEach(i => { ann.texts[i].color = c; });
    redrawSelPage(); renderLasso(); markDirty();
  }

  /* 投げ縄パネルのボタンの有効・無効 */
  function updateLassoButtons() {
    const has = !!lassoSel;
    ['lasso-delete', 'lasso-copy', 'lasso-cut', 'lasso-dup'].forEach(id => {
      const b = $('#' + id); if (b) b.disabled = !has;
    });
    const p = $('#lasso-paste'); if (p) p.disabled = !clipboard;
    const cg = $('#lasso-colors'); if (cg) cg.style.opacity = has ? '1' : '.4';
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
    pv.img.addEventListener('pointerdown', (e) => onImgLayerDown(e, pv));
  }

  /* 画像レイヤーの何もない所をタップ＝選択を外す（＝指でスクロールできる状態に戻す） */
  function onImgLayerDown(e, pv) {
    if (tool !== 'image' || !selImg) return;
    if (e.target.closest('.imgbox')) return;
    selImg = null;
    pv.img.querySelectorAll('.imgbox.selected').forEach(b => b.classList.remove('selected'));
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
    // ペンだけで書く設定のときは、指・手のひらでは何もしない（1本指はスクロールになる）
    if (penOnly() && e.pointerType === 'touch') {
      // 投げ縄で選んでいるとき、何もない所を指でタップしたら選択を外す
      // （＝また指でスクロールできる状態に戻す）
      if (tool === 'lasso' && lassoSel) clearLasso();
      return;
    }
    pv.live.setPointerCapture(e.pointerId); liveDrawnUpTo = 0;
    const [x, y] = toIntrinsic(e, pv);
    const common = { pv, pointerId: e.pointerId, downX: e.clientX, downY: e.clientY, downT: Date.now() };
    if (tool === 'lasso') {
      clearLasso();
      gesture = Object.assign(common, { type: 'lasso', poly: [[x, y]] });
      return;
    }
    if (tool === 'eraser') { gesture = Object.assign(common, { type: 'erase', before: structuredClone(annOf(pv.idx)), changed: false }); eraseAt(pv, x, y); return; }
    const p = (e.pressure && e.pressure > 0) ? e.pressure : (e.pointerType === 'pen' ? 0 : 0.5);
    const mk = (tool === 'marker');
    gesture = Object.assign(common, { type: tool, color: mk ? mkColor : color, width: mk ? MK_WIDTHS[mkWidthIdx] : WIDTHS[widthIdx], points: [[x, y, p]] });
    gesture.holdAt = [x, y];
    armShapeHold(gesture);
  }
  function onMove(e, pv) {
    if (!gesture || gesture.pv !== pv) return;
    if (gesture.type === 'erase') { const [x, y] = toIntrinsic(e, pv); eraseAt(pv, x, y); return; }
    if (gesture.type === 'lasso') {
      const [x, y] = toIntrinsic(e, pv);
      gesture.poly.push([x, y]);
      drawLassoPath(pv, gesture.poly);
      return;
    }
    if (isFreehand(gesture.type)) {
      // きれいな形にしたあとは、離さずに動かすと大きさが変わる
      if (gesture.snapped) { dragSnappedShape(gesture, pv, e); return; }
      const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
      evs.forEach(ev => { const [x, y] = toIntrinsic(ev, pv); const p = (ev.pressure && ev.pressure > 0) ? ev.pressure : 0.5; gesture.points.push([x, y, p]); });
      /* マーカーは、描いている途中も手書きの下・うすいまま見せたい。
         上に重なる live の層ではなく、インクの層へ正しい順番で描き直す。 */
      if (gesture.type === 'marker') { clearCtx(pv.live, pv.livectx); renderInk(pv, gesture); }
      else drawLiveIncremental(pv);
      // ペンを動かしたら、止まっている時間を数え直す
      const last = gesture.points[gesture.points.length - 1];
      if (!gesture.holdAt || Math.hypot(last[0] - gesture.holdAt[0], last[1] - gesture.holdAt[1]) > SHAPE_MOVE_TOL) {
        gesture.holdAt = [last[0], last[1]];
        armShapeHold(gesture);
      }
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
    clearTimeout(g.holdTimer);
    if (g.type === 'lasso') {
      clearCtx(pv.live, pv.livectx);
      // ごく小さい囲み＝ただのタップ。選択を解除するだけで、メッセージは出さない
      if (g.poly.length >= 3 && polySpan(g.poly) > 8) finishLasso(pv, g.poly);
      return;
    }
    if (g.type === 'erase') { if (g.changed) { pushUndoSnap(pv.idx, g.before); markDirty(); } return; }
    if (g.type === 'marker' && !g.points.length) { renderInk(pv); return; }   // 途中で描いたぶんを消す
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
    if (tool !== 'mask' || !nb || suppressDraw || immersive) return;
    if (penOnly() && e.pointerType === 'touch') return;
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
    if (gesture) {
      clearTimeout(gesture.holdTimer);
      const g = gesture;
      try { g.pv.live.releasePointerCapture(g.pointerId); } catch (e) {}
      clearCtx(g.pv.live, g.pv.livectx);
      gesture = null; liveDrawnUpTo = 0;
      if (g.type === 'marker') renderInk(g.pv);     // 途中まで描いたマーカーを消す
    }
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
    const pv = pageViews[e.idx]; if (pv) { renderInk(pv); renderMasks(pv); renderTexts(pv); renderImages(pv); }
    markDirty();
  }
  function redo() {
    if (!redoStack.length) return;
    const e = redoStack.pop();
    undoStack.push({ idx: e.idx, before: structuredClone(annOf(e.idx)) });
    nb.pages[e.idx].annotations = e.before;
    const pv = pageViews[e.idx]; if (pv) { renderInk(pv); renderMasks(pv); renderTexts(pv); renderImages(pv); }
    markDirty();
  }

  /* ---------- ズーム ---------- */
  function setZoom(z) { stopGlide(); releaseViewHold(); zoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z)); relayoutAll(); }

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
  }

  /* ---------- 保存 ---------- */
  function markDirty() { dirty = true; setSaveState('saving'); clearTimeout(saveTimer); saveTimer = setTimeout(saveNow, 700); }
  function setSaveState(s) {
    const el = $('#ed-save-state');
    if (s === 'saving') el.textContent = '保存中…';
    else if (s === 'saved') el.innerHTML = PN.ui.icon('check') + '保存済み';
    else el.textContent = '';
  }
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
    elExit.addEventListener('click', exitImmersive);
  }
  // 全画面ボタンの見た目を切り替える（アイコンを消さずに中身だけ差し替える）
  function setImmersiveBtn(iconId, label, title) {
    const btn = $('#ed-immersive'); if (!btn) return;
    const use = btn.querySelector('use'); if (use) use.setAttribute('href', iconId);
    const lbl = btn.querySelector('.lbl'); if (lbl) lbl.textContent = label;
    btn.title = title;
  }

  function enterImmersive() {
    immersive = true;
    ed.classList.add('immersive');
    elExit.hidden = false;
    setImmersiveBtn('#i-exit-full', '全画面解除', '全画面を解除する');
    // ブラウザの全画面API（requestFullscreen）は使わない。使うと Chrome が
    // 「全画面表示を終了するには Esc キーを押します」を毎回出すため。
    // 上下のメニューはアプリ側で隠しているので、PDF は画面いっぱいに映る。
    updateRouting();
    setTimeout(relayoutAll, 80);
    PN.ui.toast('終了するには、右上の「全画面解除」を押します（Esc キーでも戻れます）。', 6000);
  }
  function exitImmersive() {
    immersive = false;
    ed.classList.remove('immersive'); elExit.hidden = true;
    setImmersiveBtn('#i-full', '全画面', '全画面（メニューを隠してPDFを大きく映す）');
    updateRouting();
    setTimeout(relayoutAll, 80);
  }

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
  /* 指でつかんで動かせるもの（画像・投げ縄の選択枠・テキストボックス）の上か */
  const onGrabbable = (e) =>
    !!(e.target && e.target.closest && e.target.closest('.imgbox, .lasso-sel, .textbox'));
  // ペンだけで書く設定なら、どの道具でも1本指はスクロール。めくりは従来どおり1本指で操作できる
  const isViewTool = () => (tool === 'reveal' || penOnly());

  function bindTouch() {
    elPages.addEventListener('pointerdown', onTouchDown, true);
    document.addEventListener('pointermove', onTouchMove);
    document.addEventListener('pointerup', onTouchUp);
    document.addEventListener('pointercancel', onTouchUp);
    document.addEventListener('pointerup', onTextLayerUp);
    document.addEventListener('pointercancel', () => { pendingText = null; });
  }
  function onTouchDown(e) {
    if (e.pointerType !== 'touch') return;
    stopGlide();                       // 動いている最中に触れたら、その場で止める
    ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (ptrs.size >= 2) { one = null; pendingText = null; if (!two) startTwo(); return; }
    /* 指でつかんで動かせるもの（画像・投げ縄の選択枠・テキストボックス）に
       触れたときは、ノートを一緒に動かさない。
       画像や投げ縄で選んでいる間も同じく止めておき、
       何もない所を1回タップすれば選択が外れて、また指でスクロールできる。 */
    if (ptrs.size === 1 && isViewTool() && !selImg && !lassoSel && !onGrabbable(e)) {
      one = { id: e.pointerId, lastX: e.clientX, lastY: e.clientY, moved: 0, vx: 0, vy: 0, lastT: nowMs() };
    }
  }
  function onTouchMove(e) {
    if (!ptrs.has(e.pointerId)) return;
    ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (two && ptrs.size >= 2) { releaseViewHold(); moveTwo(); return; }
    if (one && e.pointerId === one.id) {
      releaseViewHold();
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
  /* 追加する位置を、いまのページから決める。
     'before' = 今のページの前 / 'after' = 今のページの後ろ / 'end' = 最後 */
  function insertIndexFor(position, len) {
    if (!len) return 0;
    if (position === 'before') return Math.max(0, Math.min(currentIdx, len));
    if (position === 'after') return Math.max(0, Math.min(currentIdx + 1, len));
    return len;
  }

  async function addFiles(files, position) {
    // position: 'before' | 'after' | 'end'（未指定は 'end'）
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
      let insertAt = insertIndexFor(position, startLen);
      if (insertAt < startLen) {
        const moved = nb.pages.splice(startLen, added);       // 末尾に付いた新ページを取り出す
        nb.pages.splice(insertAt, 0, ...moved);                // 決めた位置へ入れ直す
      }
      structureDirty = true; await saveNow();
      elNoPages.hidden = true; elScroller.style.display = '';
      buildPages(); renderVisible(); updateCurrent();
      if (pageViews[insertAt]) pageViews[insertAt].el.scrollIntoView({ block: 'start' });
      PN.ui.toast(added + ' ページを追加しました');
    }
  }
  /* 白紙のページを足す。大きさは今のページに合わせる（無ければA4たて） */
  async function addBlankPage(position) {
    if (!nb) return;
    const cur = nb.pages[currentIdx];
    let w = 595.28, h = 841.89;                       // A4たて（pt）
    if (cur) {
      // 画像のページは96dpi前提なので pt に直してそろえる
      const k = (cur.type === 'image') ? 0.75 : 1;
      w = Math.round(cur.baseW * k * 100) / 100; h = Math.round(cur.baseH * k * 100) / 100;
    }
    const page = { id: 'pg-' + Date.now(), type: 'blank', baseW: w, baseH: h,
      annotations: { strokes: [], masks: [], texts: [], images: [] } };
    const at = insertIndexFor(position, nb.pages.length);
    nb.pages.splice(at, 0, page);
    structureDirty = true; await saveNow();
    elNoPages.hidden = true; elScroller.style.display = '';
    buildPages(); renderVisible(); updateCurrent();
    if (pageViews[at]) pageViews[at].el.scrollIntoView({ block: 'start' });
    PN.ui.toast('白紙のページを追加しました');
  }

  /* 「ページ追加」ボタン：どこに・何を入れるかを選ぶ */
  async function addPageDialog() {
    const r = await PN.ui.addPage({ hasPages: !!(nb && nb.pages.length) });
    if (!r) return;
    if (r.how === 'blank') return addBlankPage(r.where);
    if (r.how === 'camera') return captureFromCamera(async (blob) => { await addFiles([blob], r.where); });
    PN.app.pickFilesForCurrentNotebook(r.where, r.how);   // 'image' | 'pdf'
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
  function settingsMenu(anchor) {
    PN.ui.menu(anchor, [
      fingerDraw
        ? { icon: 'check', label: '指だけで操作できるようにする（スクロールは2本指）', onClick: () => setFingerDraw(false) }
        : { label: '指だけで操作できるようにする（スクロールは2本指）', onClick: () => setFingerDraw(true) },
      snapShapes
        ? { icon: 'check', label: '押さえたままで図形をきれいにする', onClick: () => setSnapShapes(false) }
        : { label: '押さえたままで図形をきれいにする', onClick: () => setSnapShapes(true) }
    ]);
  }
  function setFingerDraw(on) {
    fingerDraw = !!on;
    try { localStorage.setItem(FINGER_DRAW_KEY, on ? '1' : '0'); } catch (e) {}
    PN.ui.toast(on ? '指だけで操作できるようにしました。画面のスクロールは2本指で行います。'
                   : 'タッチペンで操作します。1本指では画面がスクロールします。', 6000);
  }
  function setSnapShapes(on) {
    snapShapes = !!on;
    try { localStorage.setItem(SHAPE_KEY, on ? '1' : '0'); } catch (e) {}
    PN.ui.toast(on ? 'ペンで書いたあと、離さずに押さえたままにすると、直線・丸・四角・三角をきれいに直します。'
                   : '書いた線は、そのままの形で残します。', 6000);
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
    } else if (def.type === 'blank') {
      const scale = targetW / def.baseW;
      canvas.width = Math.round(def.baseW * scale); canvas.height = Math.round(def.baseH * scale);
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    } else {
      const img = await getImage(def.asset), scale = targetW / def.baseW;
      canvas.width = Math.round(def.baseW * scale); canvas.height = Math.round(def.baseH * scale);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    }
    return canvas;
  }
  function renderThumbBlob(def, w) { return renderThumbToCanvas(def, w).then(c => new Promise(res => c.toBlob(res, 'image/png'))); }

  /* ---------- ページの合成描画（背景＋書き込み＋目かくし）: 一覧サムネ・PDF書き出し用 ---------- */
  function composeStroke(ctx, s, scale, canvasW) {
    const pts = s.points; if (!pts || !pts.length) return;
    const baseCssM = s.width * canvasW;
    if (isMarkerStroke(s)) { drawMarker(ctx, s, scale, baseCssM); return; }
    ctx.strokeStyle = s.color; ctx.fillStyle = s.color; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    const baseCss = baseCssM;
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
    } else if (def.type === 'blank') {
      canvas.width = Math.round(def.baseW * scale); canvas.height = Math.round(def.baseH * scale);
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    } else {
      const img = await getImage(def.asset);
      canvas.width = Math.round(def.baseW * scale); canvas.height = Math.round(def.baseH * scale);
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    }
    const ann = def.annotations || {};
    // 背景 → 置いた画像 → 書き込み → 入れた文字 → 目かくし（上に重ねて答えを隠す）の順
    if (ann.images) {
      for (const im of ann.images) {
        try {
          const el = await getImage(im.asset);
          ctx.drawImage(el, im.x * scale, im.y * scale, im.w * scale, im.h * scale);
        } catch (e) { /* 画像が見つからないときは飛ばす */ }
      }
    }
    if (wantInk && ann.strokes) {
      // 画面と同じく、マーカーを先に描いて手書きの下にする
      ann.strokes.forEach(s => { if (isMarkerStroke(s)) composeStroke(ctx, s, scale, canvas.width); });
      ann.strokes.forEach(s => { if (!isMarkerStroke(s)) composeStroke(ctx, s, scale, canvas.width); });
    }
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
        // PDFと白紙は baseW/H が pt。画像は96dpi前提で pt換算
        const inPt = (def.type === 'pdf' || def.type === 'blank');
        const wpt = inPt ? def.baseW : def.baseW * 0.75;
        const hpt = inPt ? def.baseH : def.baseH * 0.75;
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
    if (ctrl && e.key.toLowerCase() === 'c' && lassoSel) { e.preventDefault(); copySelection(false); return; }
    if (ctrl && e.key.toLowerCase() === 'x' && lassoSel) { e.preventDefault(); copySelection(true); return; }
    if (ctrl && e.key.toLowerCase() === 'v' && clipboard) { e.preventDefault(); pasteClipboard(); return; }
    if ((e.key === 'Delete' || e.key === 'Backspace') && lassoSel) { e.preventDefault(); deleteSelection(false); return; }
    if (e.key === 'Escape' && lassoSel) { e.preventDefault(); clearLasso(); return; }
    if (e.key === 'ArrowRight' || e.key === 'PageDown') { e.preventDefault(); goPage(currentIdx + 1); }
    else if (e.key === 'ArrowLeft' || e.key === 'PageUp') { e.preventDefault(); goPage(currentIdx - 1); }
    else if (e.key === 'Escape' && immersive) { exitImmersive(); }
    // 数字キーは、上のバーの道具の並び順どおり。
    // 「画像」だけは道具ではなくメニューなので、ボタンを押したことにする
    else if (e.key === '7') { const b = $('#ed-image'); if (b) b.click(); }
    else { const map = { '1': 'lasso', '2': 'pen', '3': 'marker', '4': 'line', '5': 'eraser', '6': 'text', '8': 'mask', '9': 'reveal' }; if (map[e.key]) setTool(map[e.key]); }
  }

  function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

  return {
    init, open, close, flushSave, addFiles, addPageDialog, placeImage: placeImageOnPage,
    getPages, getCurrentIndex, gotoPageId, composePage,
    reorderPages, deletePagesByIds, duplicatePagesByIds, exportPagesToPdf
  };
})();
