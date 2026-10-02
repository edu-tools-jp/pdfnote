/* PDFノート — 開いているノートのタブ
 *
 *  画面のいちばん上に、開いたノートをタブとして並べる。
 *  タブを押せばそのノートへ、× で閉じる。左端の「一覧」でノート一覧に戻る。
 *
 *  ・同時に読み込んでおくのは、いま見ている1冊だけ。切り替えるたびに
 *    保存して閉じ、次のノートを開き直す（教室のPCでもメモリが増えない）。
 *  ・そのかわり、各タブで見ていた場所（倍率・スクロール位置）は覚えておき、
 *    戻ったときに同じ場所をそのまま見せる。
 *  ・開いているタブの並びは保存しておき、次に起動したときも残っている。
 *  ・タブはドラッグで並べ替えられる。マウスはそのまま動かせば、
 *    指とペンは長押しで持ち上げてから動かす（すぐ動かすと帯の横スクロール）。
 */
window.PN = window.PN || {};

PN.tabs = (function () {
  const $ = (s) => document.querySelector(s);
  const KEY = 'pdfnote.tabs';

  let ids = [];               // 開いているノート（左から順）
  let active = null;          // いま見ているノート。null は「一覧」
  const views = new Map();    // ノートごとの見ていた場所（このセッションのあいだだけ）
  let busy = false;           // 切り替え中は次の操作を受け付けない
  let bar, list, home;

  function init() {
    bar = $('#tabbar'); list = $('#tab-list'); home = $('#tab-home');
    try {
      const v = JSON.parse(localStorage.getItem(KEY) || '{}');
      if (Array.isArray(v.ids)) ids = v.ids.filter(x => typeof x === 'string');
    } catch (e) { /* 読めなければタブなしで始める */ }
    home.addEventListener('click', () => goHome());
    list.addEventListener('click', onListClick);
    // 並べ替え（マウスはドラッグ、指・ペンは長押しで持ち上げる）
    list.addEventListener('pointerdown', onDown);
    list.addEventListener('pointermove', onMove);
    list.addEventListener('pointerup', onUp);
    list.addEventListener('pointercancel', onCancel);
    // 長押しで右クリックのメニューが出ないように（Windows のタッチ・ペン）
    list.addEventListener('contextmenu', (e) => e.preventDefault());
    // マウスのホイールで、隠れているタブまで横にスクロールできるように
    list.addEventListener('wheel', (e) => {
      if (list.scrollWidth <= list.clientWidth || Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
      list.scrollLeft += e.deltaY; e.preventDefault();
    }, { passive: false });
    // パソコンのマウスなら、ホイールを押してもタブを閉じられる
    list.addEventListener('auxclick', (e) => {
      const t = e.button === 1 && e.target.closest('.tab');
      if (t) { e.preventDefault(); closeTab(t.dataset.id); }
    });
    list.addEventListener('keydown', (e) => {
      const t = e.target.closest('.tab');
      if (t && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); switchTo(t.dataset.id); }
    });
  }
  function persist() {
    try { localStorage.setItem(KEY, JSON.stringify({ ids })); } catch (e) {}
  }

  const indexReady = () => !!(PN.storage.getIndex && PN.storage.getIndex());
  function titleOf(id) {
    const e = indexReady() ? PN.storage.entryOf(id) : null;
    return (e && e.title) || '無題';
  }

  /* 一覧から消されたノートのタブを外す。一覧を描き直すたびに呼ぶ
     （名前を変えたときも、ここでタブの表示が新しい名前になる） */
  function sync() {
    if (indexReady()) {
      const alive = new Set(PN.storage.getIndex().notebooks.map(n => n.id));
      const n = ids.length;
      ids = ids.filter(id => alive.has(id));
      for (const id of [...views.keys()]) if (!alive.has(id)) views.delete(id);
      if (ids.length !== n) persist();
    }
    render();
  }

  function render() {
    if (!bar) return;
    if (drag) { clearTimeout(drag.timer); drag = null; list.classList.remove('reordering'); }
    // タブが1つも無いとき、最初の画面（保存先を選ぶ）では出さない
    const onStart = !$('#screen-start').hidden;
    const show = ids.length > 0 && !onStart && indexReady();
    bar.hidden = !show;
    document.body.classList.toggle('has-tabs', show);
    if (!show) { list.innerHTML = ''; return; }

    home.classList.toggle('active', active === null);
    home.setAttribute('aria-selected', String(active === null));
    list.innerHTML = '';
    ids.forEach(id => {
      const title = titleOf(id);
      const t = document.createElement('div');
      t.className = 'tab' + (id === active ? ' active' : '');
      t.dataset.id = id;
      t.setAttribute('role', 'tab');
      t.setAttribute('aria-selected', String(id === active));
      t.tabIndex = 0;
      t.title = title;
      t.innerHTML = '<span class="tab-title"></span>'
        + '<button class="tab-close" type="button" title="タブを閉じる"><svg class="ic"><use href="#i-x"/></svg></button>';
      t.querySelector('.tab-title').textContent = title;
      t.querySelector('.tab-close').setAttribute('aria-label', '「' + title + '」のタブを閉じる');
      list.appendChild(t);
    });
    const a = list.querySelector('.tab.active');
    if (a && a.scrollIntoView) a.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  function onListClick(e) {
    const t = e.target.closest('.tab'); if (!t) return;
    if (performance.now() < swallowUntil) return;   // 並べ替え・スクロールの直後
    if (e.target.closest('.tab-close')) { e.stopPropagation(); closeTab(t.dataset.id); return; }
    switchTo(t.dataset.id);
  }

  /* ---------- 並べ替え ----------
     マウス … 押したまま 6px 動かすと持ち上がる
     指・ペン … 0.38 秒押さえると持ち上がる。その前に動かしたら帯の横スクロール
     持ち上げたタブは指についてきて、となりのタブの真ん中を越えたら入れ替わる。 */
  const LONG_PRESS_MS = 380;
  const SLOP = 10;          // 指・ペンが、これより動いたらスクロールとみなす
  const MOUSE_SLOP = 6;     // マウスは、これだけ動かしたらドラッグ開始
  let drag = null;
  let swallowUntil = 0;     // この時刻までの click は無視する
  const order = () => [...list.querySelectorAll('.tab')].map(t => t.dataset.id);

  function onDown(e) {
    if (busy || drag || e.button > 0) return;
    const t = e.target.closest('.tab');
    if (!t || e.target.closest('.tab-close')) return;   // × は click で閉じる
    const mouse = e.pointerType === 'mouse';
    drag = { id: e.pointerId, el: t, mouse, x0: e.clientX, y0: e.clientY, lastX: e.clientX, mode: 'press', timer: null };
    if (!mouse) drag.timer = setTimeout(() => { if (drag && drag.mode === 'press') lift(); }, LONG_PRESS_MS);
    try { t.setPointerCapture(e.pointerId); } catch (err) {}
  }

  function onMove(e) {
    if (!drag || e.pointerId !== drag.id) return;
    if (drag.mode === 'press') {
      const far = Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0);
      if (drag.mouse) { if (far <= MOUSE_SLOP) return; lift(); }
      else if (far > SLOP) { clearTimeout(drag.timer); drag.mode = 'scroll'; }
      else return;
    }
    if (drag.mode === 'scroll') {
      list.scrollLeft -= e.clientX - drag.lastX;
      drag.lastX = e.clientX;
      return;
    }
    drag.lastX = e.clientX;
    follow(e.clientX);
  }

  /* タブを持ち上げる */
  function lift() {
    clearTimeout(drag.timer);
    drag.mode = 'drag';
    drag.grab = drag.x0 - drag.el.getBoundingClientRect().left;   // タブのどこをつかんだか
    drag.before = order();
    drag.el.classList.add('dragging');
    list.classList.add('reordering');
    try { if (navigator.vibrate) navigator.vibrate(12); } catch (err) {}
    follow(drag.lastX);
  }

  /* 持ち上げたタブを指に合わせて動かし、通り過ぎたタブと入れ替える */
  function follow(x) {
    const el = drag.el, lr = list.getBoundingClientRect();
    // 帯の端まで持っていくと、隠れているタブのほうへスクロール
    if (x < lr.left + 32) list.scrollLeft -= 12;
    else if (x > lr.right - 32) list.scrollLeft += 12;
    const want = x - drag.grab;                                         // 指についていく位置
    const left = Math.max(lr.left, Math.min(lr.right - el.offsetWidth, want));   // 見た目は帯の中に収める
    // 入れ替えの判定は、帯の端で止める前の位置で行う
    // （止めた位置だと、同じ幅のタブでは端のタブの真ん中とちょうど重なって越えられない）
    const center = want + el.offsetWidth / 2;
    const base = lr.left - list.scrollLeft;   // 帯の中での位置 → 画面上の位置
    let before = null;
    for (const t of list.querySelectorAll('.tab')) {
      if (t === el) continue;
      if (center < base + t.offsetLeft + t.offsetWidth / 2) { before = t; break; }
    }
    if (before !== el.nextElementSibling) list.insertBefore(el, before);
    el.style.transform = 'translateX(' + (left - (base + el.offsetLeft)) + 'px)';
  }

  function drop(d) {
    d.el.classList.remove('dragging');
    d.el.style.transform = '';
    list.classList.remove('reordering');
    const now = order();
    if (now.join('\n') !== d.before.join('\n')) { ids = now; persist(); }
    render();
  }

  function onUp(e) {
    if (!drag || e.pointerId !== drag.id) return;
    const d = drag; drag = null;
    clearTimeout(d.timer);
    if (d.mode === 'drag') { swallowUntil = performance.now() + 400; drop(d); }
    else if (d.mode === 'scroll') swallowUntil = performance.now() + 400;
    // 'press' のまま離した＝ふつうのタップ。切り替えは click で行う
  }
  function onCancel(e) {
    if (!drag || e.pointerId !== drag.id) return;
    const d = drag; drag = null;
    clearTimeout(d.timer);
    if (d.mode === 'drag') drop(d);
  }

  /* 切り替えに時間がかかったときだけ「読み込み中」を出す（すぐ終わればチラつかせない） */
  async function slowBusy(fn) {
    const timer = setTimeout(() => PN.ui.busy(true, '読み込み中…'), 250);
    try { return await fn(); }
    finally { clearTimeout(timer); PN.ui.busy(false); }
  }

  /* いま開いているノートの見ていた場所を覚えて、保存して閉じる */
  async function leaveCurrent() {
    const cur = PN.editor.currentId();
    if (!cur) return;
    const v = PN.editor.getView();
    if (v) views.set(cur, v);
    if (PN.pages && PN.pages.close) PN.pages.close();   // ページ一覧を開いていたら閉じる
    await PN.editor.close();
  }

  /* 開く。前に開いていたタブなら、そのとき見ていた場所から */
  async function show(nb, pickAfter) {
    active = nb.id;
    PN.app.showEditorScreen();
    const view = views.get(nb.id) || null;
    await PN.editor.open(nb, view ? { view, keepTool: true } : undefined);
    render();
    if (pickAfter) PN.editor.addPageDialog();   // 新しいノートは、何を入れるかから選ばせる
  }

  /* 一覧からノートを開いた。開いていなければ右端にタブを足し、開いていればそのタブへ */
  async function openNotebook(nb, pickAfter) {
    if (busy) return;
    busy = true;
    try {
      if (!ids.includes(nb.id)) { ids.push(nb.id); persist(); }
      await leaveCurrent();
      await show(nb, pickAfter);
    } finally { busy = false; render(); }
  }

  async function switchTo(id) {
    if (busy || id === active) return;
    busy = true;
    try {
      await leaveCurrent();
      const nb = await slowBusy(() => PN.storage.getNotebook(id));
      if (!nb) {
        // 別の場所で消されていた。タブを外して一覧へ
        ids = ids.filter(x => x !== id); views.delete(id); persist();
        active = null; PN.app.showLibrary();
        PN.ui.toast('ノートを開けませんでした');
        return;
      }
      await show(nb, false);
    } catch (e) {
      console.error(e); PN.ui.toast('ノートを開けませんでした');
      active = null; PN.app.showLibrary();
    } finally { busy = false; render(); }
  }

  async function goHome() {
    if (busy) return;
    if (active === null && !$('#screen-library').hidden) return;
    busy = true;
    try {
      await leaveCurrent();
      active = null;
      PN.app.showLibrary();
    } finally { busy = false; render(); }
  }

  /* タブを閉じる。見ているタブなら右隣へ、右が無ければ左隣へ。どちらも無ければ一覧へ */
  async function closeTab(id) {
    if (busy) return;
    const i = ids.indexOf(id);
    if (i < 0) return;
    if (id !== active) {
      ids.splice(i, 1); views.delete(id); persist(); render();
      return;
    }
    const next = ids[i + 1] || ids[i - 1] || null;
    busy = true;
    try { await leaveCurrent(); }
    finally { busy = false; }
    ids.splice(i, 1); views.delete(id); persist();
    active = null;
    if (next) await switchTo(next);
    else { PN.app.showLibrary(); render(); }
  }

  return { init, render, sync, openNotebook, switchTo, goHome, closeTab };
})();
