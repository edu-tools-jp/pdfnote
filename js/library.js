/* PDFノート — ライブラリ（フォルダ式の整理） */
window.PN = window.PN || {};

PN.library = (function () {
  const $ = (s) => document.querySelector(s);

  let currentFolder = null;   // null = ホーム、または folder id
  let search = '';
  let thumbUrls = [];

  function init() {
    $('#lib-new').addEventListener('click', newNotebook);
    $('#lib-new-folder').addEventListener('click', newFolder);
    $('#lib-change-folder').addEventListener('click', changeStorageFolder);
    $('#filter-search').addEventListener('input', (e) => { search = e.target.value.trim(); renderList(); });
    bindSort($('#lib-list'));
  }
  function show() { render(); }

  function render() {
    buildPath(); renderList();
    // 消したノートのタブを外し、名前を変えたノートのタブを新しい名前にする
    if (PN.tabs) PN.tabs.sync();
  }

  /* ---- 現在地（ホーム › 親 › 子 …） ---- */
  function buildPath() {
    const idx = PN.storage.getIndex();
    const path = $('#lib-path'); path.innerHTML = '';
    // 現在地までのチェーンを上から下に並べる
    const chain = [];
    let cur = currentFolder;
    while (cur) {
      const f = (idx.folders || []).find(x => x.id === cur);
      if (!f) { currentFolder = null; break; }
      chain.unshift(f);
      cur = f.parent || null;
    }
    const homeBtn = document.createElement('button');
    homeBtn.className = 'path-link' + (currentFolder === null ? ' current' : '');
    homeBtn.innerHTML = PN.ui.icon('folder-open') + 'ホーム';
    homeBtn.addEventListener('click', () => { currentFolder = null; render(); });
    path.appendChild(homeBtn);
    chain.forEach((node, i) => {
      const sep = document.createElement('span'); sep.className = 'path-sep'; sep.textContent = '›';
      path.appendChild(sep);
      const isLast = (i === chain.length - 1);
      if (isLast) {
        const cur = document.createElement('span'); cur.className = 'path-current'; cur.innerHTML = PN.ui.icon('folder') + PN.ui.escapeHTML(node.name);
        path.appendChild(cur);
      } else {
        const btn = document.createElement('button');
        btn.className = 'path-link'; btn.innerHTML = PN.ui.icon('folder') + PN.ui.escapeHTML(node.name);
        btn.addEventListener('click', () => { currentFolder = node.id; render(); });
        path.appendChild(btn);
      }
    });
  }

  /* ---- フォルダのパス文字列（カードのメタ表示用） ---- */
  function folderPath(id) {
    if (!id) return '';
    const idx = PN.storage.getIndex();
    const folders = idx.folders || [];
    const parts = [];
    let cur = id;
    while (cur) {
      const f = folders.find(x => x.id === cur);
      if (!f) break;
      parts.unshift(f.name);
      cur = f.parent || null;
    }
    return parts.join(' › ');
  }

  /* ---- 子孫フォルダのID集合（移動先候補から除外するため） ---- */
  function descendantsOf(id) {
    const idx = PN.storage.getIndex();
    const folders = idx.folders || [];
    const set = new Set([id]);
    let added = true;
    while (added) {
      added = false;
      folders.forEach(f => { if (set.has(f.parent) && !set.has(f.id)) { set.add(f.id); added = true; } });
    }
    return set;
  }

  /* ---- 一覧（現在地のサブフォルダ＋ノートを表示） ---- */
  function renderList() {
    // 並べ替えの途中で描き直すことになったら、持ち上げたカードは元に戻す
    if (sort) {
      const s = sort; sort = null; clearTimeout(s.timer); cancelAnimationFrame(s.raf);
      if (s.ghost) s.ghost.remove();
      document.body.classList.remove('sorting');
    }
    thumbUrls.forEach(u => URL.revokeObjectURL(u)); thumbUrls = [];
    const list = $('#lib-list'); list.innerHTML = '';
    const idx = PN.storage.getIndex();
    const folders = idx.folders || [];
    const allNotes = idx.notebooks || [];

    $('#lib-empty').hidden = !(folders.length === 0 && allNotes.length === 0);
    if (folders.length === 0 && allNotes.length === 0) return;

    const matchN = (n) => !search || (n.title || '').toLowerCase().includes(search.toLowerCase());
    const matchF = (f) => !search || (f.name || '').toLowerCase().includes(search.toLowerCase());

    // 現在地（currentFolder）の直下にあるサブフォルダ
    let subfolders = folders.filter(f => (f.parent || null) === currentFolder).filter(matchF);
    subfolders.sort(byOrder((a, b) => (a.name || '').localeCompare(b.name || '')));
    // 現在地の直下にあるノート
    let directNotes = allNotes.filter(n => (n.folder || null) === currentFolder).filter(matchN);
    directNotes.sort(byOrder((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)));

    if (subfolders.length) {
      const grid = document.createElement('div'); grid.className = 'cards';
      subfolders.forEach(f => grid.appendChild(folderCard(f)));
      list.appendChild(grid);
    }
    if (directNotes.length) {
      if (subfolders.length) {
        const h = document.createElement('h2'); h.className = 'section-title';
        h.textContent = (currentFolder === null) ? 'フォルダに入れていないノート' : 'このフォルダのノート';
        list.appendChild(h);
      }
      const grid = document.createElement('div'); grid.className = 'cards';
      directNotes.forEach(n => grid.appendChild(noteCard(n)));
      list.appendChild(grid);
    }
    if (!subfolders.length && !directNotes.length) {
      list.innerHTML = '<p style="color:var(--muted);padding:20px">'
        + (search ? '該当するものがありません。'
          : (currentFolder === null
            ? '該当するものがありません。'
            : 'このフォルダにはまだ何もありません。「新規ノート」「新規フォルダ」で追加してください。'))
        + '</p>';
    }
  }

  /* 並べ替えた順（order）で並べる。order を持たないもの＝まだ並べ替えていない段のもの、
     あとから足したもの・移してきたものは、先頭にこれまでの順（fallback）で並べる。
     一度も並べ替えていない段は、これまでとまったく同じ並びになる。 */
  function byOrder(fallback) {
    return (a, b) => {
      const ah = typeof a.order === 'number', bh = typeof b.order === 'number';
      if (ah && bh) return a.order - b.order;
      if (!ah && !bh) return fallback(a, b);
      return ah ? 1 : -1;
    };
  }

  function folderCard(f) {
    const idx = PN.storage.getIndex();
    const noteCount = idx.notebooks.filter(n => n.folder === f.id).length;
    const subCount = (idx.folders || []).filter(x => x.parent === f.id).length;
    const meta = [
      subCount ? (subCount + ' フォルダ') : '',
      noteCount + ' ノート'
    ].filter(Boolean).join(' ・ ');
    const el = document.createElement('div'); el.className = 'card folder-card'; el.dataset.id = f.id;
    const fc = folderColor(f.color);
    el.style.setProperty('--fc', fc.glyph);
    el.innerHTML = `
      <div class="card-thumb folder-thumb">${PN.ui.icon('folder-solid', 'ic-solid')}</div>
      <div class="card-body">
        <div class="card-title">${PN.ui.escapeHTML(f.name)}</div>
        <div class="card-meta">${meta}</div>
      </div>
      <div class="card-actions">
        <button class="bar-btn primary" data-act="open">開く</button>
        <button class="bar-btn ghost icon" data-act="more" title="このフォルダの操作">${PN.ui.icon('more')}</button>
      </div>`;
    el.querySelector('[data-act="open"]').addEventListener('click', () => { currentFolder = f.id; render(); });
    el.querySelector('[data-act="more"]').addEventListener('click', (e) => folderMenu(e.currentTarget, f));
    return el;
  }

  function noteCard(n) {
    const el = document.createElement('div'); el.className = 'card'; el.dataset.id = n.id;
    const d = n.updatedAt ? new Date(n.updatedAt) : null;
    const dStr = d ? `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}` : '';
    const fpath = folderPath(n.folder);
    el.innerHTML = `
      <div class="card-thumb">${n.hasThumb ? '' : PN.ui.icon('note')}</div>
      <div class="card-body">
        <div class="card-title">${PN.ui.escapeHTML(n.title || '(無題)')}</div>
        <div class="card-meta">${fpath ? PN.ui.icon('folder') + PN.ui.escapeHTML(fpath) : PN.ui.icon('folder-open') + 'ホーム'}</div>
        <div class="card-meta">${n.pageCount || 0} ページ ・ ${dStr}</div>
      </div>
      <div class="card-actions">
        <button class="bar-btn primary" data-act="open">開く</button>
        <button class="bar-btn ghost icon" data-act="more" title="このノートの操作">${PN.ui.icon('more')}</button>
      </div>`;
    el.querySelector('[data-act="open"]').addEventListener('click', () => openNotebook(n.id));
    el.querySelector('[data-act="more"]').addEventListener('click', (e) => cardMenu(e.currentTarget, n));
    if (n.hasThumb) {
      PN.storage.readThumb(n.id).then(blob => {
        if (!blob) return;
        const url = URL.createObjectURL(blob); thumbUrls.push(url);
        const t = el.querySelector('.card-thumb'); t.style.backgroundImage = `url(${url})`; t.textContent = '';
      });
    }
    return el;
  }

  /* ---- 並べ替え（ドラッグ／長押し） ----
     マウス … カードを押したまま 6px 動かすと持ち上がる
     指・ペン … 0.4 秒押さえると持ち上がる。その前に動かせば、ふつうの縦スクロール
     持ち上げたカードは指についてきて、重なったカードの前か後ろに入る。
     フォルダはフォルダの中で、ノートはノートの中で並べ替える。
     画面の上下の端まで持っていくと、一覧が自動でスクロールする。 */
  const SORT_LONG_MS = 400;
  const SORT_SLOP = 10;       // 指・ペンがこれより動いたら、スクロールとみなす
  const SORT_MOUSE_SLOP = 6;  // マウスはこれだけ動かしたら持ち上げる
  let sort = null;
  let sortSwallowUntil = 0;   // 並べ替え直後のクリックは無視する

  function bindSort(list) {
    list.addEventListener('pointerdown', sortDown);
    list.addEventListener('pointermove', sortMove);
    list.addEventListener('pointerup', sortUp);
    list.addEventListener('pointercancel', sortCancel);
    // 持ち上げたあとは、指を動かしても一覧をスクロールさせない
    list.addEventListener('touchmove', (e) => { if (sort && sort.mode === 'drag') e.preventDefault(); }, { passive: false });
    // 長押しで右クリックのメニューが出ないように（Windows のタッチ・ペン）
    list.addEventListener('contextmenu', (e) => { if (e.target.closest('.card')) e.preventDefault(); });
    // 並べ替えた直後に、指を離した所のボタンが押されないように
    list.addEventListener('click', (e) => {
      if (performance.now() < sortSwallowUntil) { e.preventDefault(); e.stopPropagation(); }
    }, true);
  }

  function sortDown(e) {
    if (sort || e.button > 0 || search) return;             // 検索中は並べ替えない
    const card = e.target.closest('.card');
    if (!card || !card.dataset.id || e.target.closest('button')) return;   // ボタンはそのまま押せる
    const grid = card.parentElement;
    if (grid.querySelectorAll('.card').length < 2) return;
    const mouse = e.pointerType === 'mouse';
    sort = { id: e.pointerId, card, grid, mouse, x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY,
             mode: 'press', timer: null, kind: card.classList.contains('folder-card') ? 'folder' : 'note' };
    if (!mouse) sort.timer = setTimeout(() => { if (sort && sort.mode === 'press') sortLift(); }, SORT_LONG_MS);
    try { card.setPointerCapture(e.pointerId); } catch (err) {}
  }

  function sortMove(e) {
    if (!sort || e.pointerId !== sort.id) return;
    sort.x = e.clientX; sort.y = e.clientY;
    if (sort.mode === 'press') {
      const far = Math.hypot(e.clientX - sort.x0, e.clientY - sort.y0);
      if (sort.mouse) { if (far > SORT_MOUSE_SLOP) sortLift(); }
      else if (far > SORT_SLOP) { clearTimeout(sort.timer); sort = null; }   // スクロールしたかった
      return;
    }
    e.preventDefault();
    sortFollow();
  }

  /* カードを持ち上げる：本物はその場に「入る場所」として薄く残し、
     そっくりの写しを指の下に浮かせて動かす */
  function sortLift() {
    clearTimeout(sort.timer);
    sort.mode = 'drag';
    const r = sort.card.getBoundingClientRect();
    sort.gx = sort.x0 - r.left; sort.gy = sort.y0 - r.top;   // カードのどこをつかんだか
    sort.before = sortOrder(sort.grid);
    const g = sort.card.cloneNode(true);
    g.classList.add('card-ghost');
    g.removeAttribute('data-id');
    g.style.width = r.width + 'px'; g.style.height = r.height + 'px';
    document.body.appendChild(g);
    sort.ghost = g;
    sort.card.classList.add('sort-placeholder');
    document.body.classList.add('sorting');
    try { if (navigator.vibrate) navigator.vibrate(12); } catch (err) {}
    sortFollow();
    sort.raf = requestAnimationFrame(sortAutoScroll);
  }

  const sortOrder = (grid) => [...grid.querySelectorAll('.card')].map(c => c.dataset.id);

  function sortFollow() {
    const s = sort;
    s.ghost.style.transform = 'translate(' + (s.x - s.gx) + 'px,' + (s.y - s.gy) + 'px) scale(1.04)';
    // 指の下にあるカードを探し、その左半分なら前へ、右半分なら後ろへ入れる
    const cards = [...s.grid.querySelectorAll('.card')];
    for (const c of cards) {
      if (c === s.card) continue;
      const r = c.getBoundingClientRect();
      if (s.x < r.left - 8 || s.x > r.right + 8 || s.y < r.top - 8 || s.y > r.bottom + 8) continue;
      const after = s.x > r.left + r.width / 2;
      const ref = after ? c.nextElementSibling : c;
      if (ref !== s.card && s.card.nextElementSibling !== ref) s.grid.insertBefore(s.card, ref);
      return;
    }
    // どのカードにも重なっていない：いちばん後ろのカードより先なら最後へ、最初より前なら先頭へ。
    // ただし、この並び（フォルダならフォルダ、ノートならノート）から大きく外れた所では何もしない
    // （ノートをフォルダの上へ持っていっただけで、ノートの先頭に入らないように）
    const gr = s.grid.getBoundingClientRect();
    if (s.x < gr.left - 40 || s.x > gr.right + 40 || s.y < gr.top - 60 || s.y > gr.bottom + 60) return;
    const others = cards.filter(c => c !== s.card);
    if (!others.length) return;
    const last = others[others.length - 1].getBoundingClientRect();
    const first = others[0].getBoundingClientRect();
    if (s.y > last.bottom || (s.y > last.top && s.x > last.right)) {
      if (s.grid.lastElementChild !== s.card) s.grid.appendChild(s.card);
    } else if (s.y < first.top || (s.y < first.bottom && s.x < first.left)) {
      if (s.grid.firstElementChild !== s.card) s.grid.insertBefore(s.card, s.grid.firstElementChild);
    }
  }

  /* 画面の上下の端に寄せると、一覧をスクロールする */
  function sortAutoScroll() {
    if (!sort || sort.mode !== 'drag') return;
    const list = $('#lib-list'), lr = list.getBoundingClientRect(), EDGE = 70;
    let dy = 0;
    if (sort.y < lr.top + EDGE) dy = -Math.ceil((lr.top + EDGE - sort.y) / EDGE * 16);
    else if (sort.y > lr.bottom - EDGE) dy = Math.ceil((sort.y - (lr.bottom - EDGE)) / EDGE * 16);
    if (dy) {
      const before = list.scrollTop;
      list.scrollTop += dy;
      if (list.scrollTop !== before) sortFollow();
    }
    sort.raf = requestAnimationFrame(sortAutoScroll);
  }

  async function sortDrop(s) {
    cancelAnimationFrame(s.raf);
    if (s.ghost) s.ghost.remove();
    s.card.classList.remove('sort-placeholder');
    document.body.classList.remove('sorting');
    const now = sortOrder(s.grid);
    if (now.join('\n') === s.before.join('\n')) return;
    try { await PN.storage.setOrder(s.kind, now); }
    catch (e) { console.error(e); PN.ui.toast('並び順を保存できませんでした'); render(); }
  }

  function sortUp(e) {
    if (!sort || e.pointerId !== sort.id) return;
    const s = sort; sort = null;
    clearTimeout(s.timer);
    if (s.mode === 'drag') { sortSwallowUntil = performance.now() + 400; sortDrop(s); }
  }
  function sortCancel(e) {
    if (!sort || e.pointerId !== sort.id) return;
    const s = sort; sort = null;
    clearTimeout(s.timer);              // 持ち上げる前なら、一覧のスクロールが始まっただけ
    if (s.mode === 'drag') sortDrop(s);
  }

  /* ---- メニュー ---- */
  /* フォルダの色。key を index.json に保存し、bg=サムネの背景／line=カードの枠 */
  /* フォルダの色。color = 色えらびの丸 / glyph = フォルダの絵そのものの色 */
  const FOLDER_COLORS = [
    { value: '',       label: '標準（黄）', color: '#f5c141', glyph: '#f5c141' },
    { value: 'blue',   label: '青',        color: '#4a9bff', glyph: '#4a9bff' },
    { value: 'green',  label: '緑',        color: '#4ecb71', glyph: '#4ecb71' },
    { value: 'teal',   label: '水色',      color: '#3fc9dd', glyph: '#3fc9dd' },
    { value: 'orange', label: 'だいだい',   color: '#ff9c33', glyph: '#ff9c33' },
    { value: 'red',    label: '赤',        color: '#ef5f4a', glyph: '#ef5f4a' },
    { value: 'pink',   label: '桃',        color: '#ff86c2', glyph: '#ff86c2' },
    { value: 'purple', label: '紫',        color: '#b07cf5', glyph: '#b07cf5' }
  ];
  const folderColor = (key) => FOLDER_COLORS.find(c => c.value === (key || '')) || FOLDER_COLORS[0];

  function folderMenu(anchor, f) {
    PN.ui.menu(anchor, [
      { label: '開く', onClick: () => { currentFolder = f.id; render(); } },
      { label: '名前を変える', onClick: () => renameFolder(f) },
      { label: '色を変える', onClick: () => changeFolderColor(f) },
      { label: '場所を変える', onClick: () => moveFolderDialog(f) },
      { label: '削除する', danger: true, onClick: () => deleteFolder(f) }
    ]);
  }
  function cardMenu(anchor, n) {
    PN.ui.menu(anchor, [
      { label: '開く', onClick: () => openNotebook(n.id) },
      { label: 'PDF・画像を追加', onClick: () => openNotebook(n.id, true) },
      { label: '名前を変える', onClick: () => renameNotebook(n) },
      { label: 'フォルダを変える', onClick: () => moveNotebook(n) },
      { label: 'コピーを作る', onClick: () => copyNotebook(n) },
      { label: '削除する', danger: true, onClick: () => deleteNotebook(n) }
    ]);
  }

  /* ---- 操作 ---- */
  // フォルダ選択肢を階層インデント付きで生成。excludeIds は候補から除外（移動先での循環防止）
  function folderOptions(includeNone, excludeIds) {
    const excludeSet = excludeIds instanceof Set ? excludeIds : new Set(excludeIds || []);
    const idx = PN.storage.getIndex();
    const folders = idx.folders || [];
    const childrenOf = new Map();
    folders.forEach(f => {
      const p = f.parent || null;
      if (!childrenOf.has(p)) childrenOf.set(p, []);
      childrenOf.get(p).push(f);
    });
    const opts = [];
    function walk(parent, depth) {
      const kids = (childrenOf.get(parent) || []).slice().sort((a, b) => (a.name || '').localeCompare(b.name || ''));
      for (const f of kids) {
        if (excludeSet.has(f.id)) continue;
        opts.push({ value: f.id, label: '　'.repeat(depth) + f.name });
        walk(f.id, depth + 1);
      }
    }
    walk(null, 0);
    if (includeNone) opts.unshift({ value: '', label: '（ホーム）' });
    return opts;
  }

  async function newNotebook() {
    const opts = folderOptions(true);
    const vals = await PN.ui.form({
      title: '新しいノートをつくる', ok: 'つくる',
      fields: [
        { name: 'title', label: 'ノートの名前', placeholder: '例）1章 光の世界 まとめプリント' },
        { name: 'folder', label: '入れるフォルダ', type: 'select', value: currentFolder || '', options: opts }
      ]
    });
    if (!vals) return;
    if (!vals.title) { PN.ui.toast('ノートの名前を入れてください'); return; }
    PN.ui.busy(true, '作成中…');
    try {
      const nb = await PN.storage.createNotebook({ title: vals.title, folder: vals.folder || null });
      PN.ui.busy(false);
      PN.app.openEditor(nb, true);
    } catch (e) { PN.ui.busy(false); console.error(e); PN.ui.toast('作成に失敗しました'); }
  }

  async function newFolder() {
    const opts = folderOptions(true);
    const vals = await PN.ui.form({
      title: '新しいフォルダをつくる', ok: 'つくる',
      fields: [
        { name: 'name', label: 'フォルダ名', placeholder: '例）2年 化学 / 第1章 など' },
        { name: 'parent', label: '入れる場所', type: 'select', value: currentFolder || '', options: opts },
        { name: 'color', label: '色（種類ごとに分けるとき）', type: 'swatch', value: '', options: FOLDER_COLORS }
      ]
    });
    if (!vals) return;
    if (!vals.name) { PN.ui.toast('フォルダ名を入れてください'); return; }
    await PN.storage.createFolder(vals.name, vals.parent || null, vals.color || '');
    render();
  }

  async function renameFolder(f) {
    const vals = await PN.ui.form({ title: 'フォルダ名を変える', ok: '変更', fields: [{ name: 'name', label: 'フォルダ名', value: f.name }] });
    if (!vals || !vals.name) return;
    await PN.storage.renameFolder(f.id, vals.name);
    render();
  }
  async function changeFolderColor(f) {
    const vals = await PN.ui.form({
      title: 'フォルダの色を変える', ok: '変更',
      fields: [{ name: 'color', label: `「${f.name}」の色`, type: 'swatch', value: f.color || '', options: FOLDER_COLORS }]
    });
    if (!vals) return;
    await PN.storage.setFolderColor(f.id, vals.color || '');
    render();
  }
  async function moveFolderDialog(f) {
    // 自分自身と子孫は移動先候補から除外（循環防止）
    const opts = folderOptions(true, descendantsOf(f.id));
    const vals = await PN.ui.form({
      title: 'フォルダの場所を変える', ok: '移す',
      fields: [{ name: 'parent', label: '入れる場所', type: 'select', value: f.parent || '', options: opts }]
    });
    if (!vals) return;
    try {
      await PN.storage.moveFolder(f.id, vals.parent || null);
      render();
    } catch (e) {
      PN.ui.toast(e.message || '場所を変えられませんでした');
    }
  }
  async function deleteFolder(f) {
    const idx = PN.storage.getIndex();
    const noteCount = idx.notebooks.filter(n => n.folder === f.id).length;
    const subCount = (idx.folders || []).filter(x => x.parent === f.id).length;
    const parentName = f.parent ? ((idx.folders || []).find(x => x.id === f.parent) || { name: '' }).name : null;
    const where = parentName ? `「${parentName}」` : 'ホーム';
    let msg;
    if (noteCount || subCount) {
      const parts = [];
      if (subCount) parts.push(`${subCount} 個のフォルダ`);
      if (noteCount) parts.push(`${noteCount} 個のノート`);
      msg = `「${f.name}」フォルダを削除します。\n中の ${parts.join('・')} は ${where} に移ります（中身は消えません）。よろしいですか？`;
    } else {
      msg = `「${f.name}」フォルダを削除します。よろしいですか？`;
    }
    if (!(await PN.ui.confirm(msg, { danger: true, ok: '削除する' }))) return;
    await PN.storage.deleteFolder(f.id);
    if (currentFolder === f.id) currentFolder = f.parent || null;
    render();
  }

  async function renameNotebook(n) {
    const vals = await PN.ui.form({ title: '名前を変える', ok: '変更', fields: [{ name: 'title', label: 'ノートの名前', value: n.title }] });
    if (!vals || !vals.title) return;
    await PN.storage.updateMeta(n.id, { title: vals.title });
    render();
  }
  async function moveNotebook(n) {
    const opts = folderOptions(true);
    const vals = await PN.ui.form({
      title: 'フォルダを変える', ok: '変更',
      fields: [{ name: 'folder', label: '入れるフォルダ', type: 'select', value: n.folder || '', options: opts }]
    });
    if (!vals) return;
    await PN.storage.updateMeta(n.id, { folder: vals.folder || null });
    render();
  }
  async function copyNotebook(n) {
    const opts = folderOptions(true);
    const vals = await PN.ui.form({
      title: 'ノートのコピーを作る', ok: 'コピー',
      fields: [
        { name: 'title', label: 'コピー後の名前', value: (n.title || '無題') + ' のコピー' },
        { name: 'folder', label: '入れるフォルダ', type: 'select', value: n.folder || '', options: opts }
      ]
    });
    if (!vals) return;
    if (!vals.title) { PN.ui.toast('名前を入れてください'); return; }
    PN.ui.busy(true, 'コピー中…');
    try {
      const copy = await PN.storage.copyNotebook(n.id, { title: vals.title, folder: vals.folder || null });
      PN.ui.busy(false);
      // コピー先のフォルダに移動して結果を見せる
      currentFolder = copy.folder || null;
      render();
      PN.ui.toast('コピーを作りました');
    } catch (e) { PN.ui.busy(false); console.error(e); PN.ui.toast('コピーに失敗しました'); }
  }

  async function deleteNotebook(n) {
    if (!(await PN.ui.confirm(`「${n.title}」を削除します。\n書き込みや取り込んだPDF・画像もすべて消えます。元に戻せません。`, { danger: true, ok: '削除する' }))) return;
    PN.ui.busy(true, '削除中…');
    try { await PN.storage.deleteNotebook(n.id); } catch (e) { console.error(e); }
    PN.ui.busy(false);
    render();
  }

  async function openNotebook(id, pickAfter) {
    PN.ui.busy(true, '読み込み中…');
    try {
      const nb = await PN.storage.getNotebook(id);
      PN.ui.busy(false);
      if (!nb) { PN.ui.toast('ノートを開けませんでした'); return; }
      PN.app.openEditor(nb, pickAfter && nb.pages.length === 0);
    } catch (e) { PN.ui.busy(false); console.error(e); PN.ui.toast('読み込みに失敗しました'); }
  }

  async function changeStorageFolder() {
    if (!(await PN.ui.confirm('データの保存先（PC内のフォルダ）を選び直します。今のノートはそのまま残ります。よろしいですか？'))) return;
    try {
      if (await PN.storage.pickFolder()) { currentFolder = null; search = ''; $('#filter-search').value = ''; render(); PN.ui.toast('保存先を変更しました'); }
    } catch (e) { /* キャンセル */ }
  }

  return { init, show };
})();
