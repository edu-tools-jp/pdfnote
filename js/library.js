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
  }
  function show() { render(); }

  function render() { buildPath(); renderList(); }

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
    subfolders.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    // 現在地の直下にあるノート
    let directNotes = allNotes.filter(n => (n.folder || null) === currentFolder).filter(matchN);
    directNotes.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));

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

  function folderCard(f) {
    const idx = PN.storage.getIndex();
    const noteCount = idx.notebooks.filter(n => n.folder === f.id).length;
    const subCount = (idx.folders || []).filter(x => x.parent === f.id).length;
    const meta = [
      subCount ? (subCount + ' フォルダ') : '',
      noteCount + ' ノート'
    ].filter(Boolean).join(' ・ ');
    const el = document.createElement('div'); el.className = 'card folder-card';
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
    const el = document.createElement('div'); el.className = 'card';
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
