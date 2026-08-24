/* PDFノート — 保存層
 * データは利用者が選んだフォルダ（File System Access API）に
 * 本物のファイルとして保存する。フォルダの場所だけは IndexedDB に覚えておく。
 *
 *  <選んだフォルダ>/
 *  ├── index.json                 … 全ノートの目次（学年・単元・更新日 など）
 *  └── notebooks/
 *      └── <ノートID>/
 *          ├── notebook.json      … ページ構成と書き込み（線・かくす枠）
 *          ├── thumb.png          … 一覧用サムネイル
 *          └── assets/            … 取り込んだ PDF / 画像の本体
 */
window.PN = window.PN || {};

/* ---- 最小 IndexedDB（フォルダの場所を覚えるだけ） ---- */
PN.idb = (function () {
  const DB = 'pdfnote', STORE = 'kv';
  function open() {
    return new Promise((res, rej) => {
      const r = indexedDB.open(DB, 1);
      r.onupgradeneeded = () => r.result.createObjectStore(STORE);
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  }
  async function get(key) {
    const db = await open();
    return new Promise((res, rej) => {
      const rq = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
      rq.onsuccess = () => res(rq.result);
      rq.onerror = () => rej(rq.error);
    });
  }
  async function set(key, val) {
    const db = await open();
    return new Promise((res, rej) => {
      const t = db.transaction(STORE, 'readwrite');
      t.objectStore(STORE).put(val, key);
      t.oncomplete = () => res();
      t.onerror = () => rej(t.error);
    });
  }
  return { get, set };
})();

PN.storage = (function () {
  let root = null;     // 選ばれたルートフォルダの handle
  let index = null;    // index.json の中身

  const now = () => Date.now();
  const rid = () => Math.random().toString(36).slice(2, 8);

  /* ---- 権限まわり ---- */
  async function verifyPermission(handle, write = true) {
    const opts = { mode: write ? 'readwrite' : 'read' };
    if (!handle.queryPermission) return true;
    if ((await handle.queryPermission(opts)) === 'granted') return true;
    if ((await handle.requestPermission(opts)) === 'granted') return true;
    return false;
  }

  /* 起動時：前回のフォルダを復元できるか調べる（ユーザー操作なしで呼べる） */
  async function tryRestore() {
    let h;
    try { h = await PN.idb.get('rootHandle'); } catch (e) { h = null; }
    if (!h) return { state: 'none' };
    let perm = 'granted';
    try { perm = h.queryPermission ? await h.queryPermission({ mode: 'readwrite' }) : 'granted'; }
    catch (e) { return { state: 'none' }; }
    if (perm === 'granted') {
      root = h;
      await ensureStructure();
      await loadIndex();
      return { state: 'ready' };
    }
    if (perm === 'prompt') return { state: 'prompt', name: h.name, handle: h };
    return { state: 'denied', name: h.name };
  }

  /* 前回のフォルダを使う（ボタン押下＝ユーザー操作から呼ぶこと） */
  async function usePrevious(handle) {
    if (!(await verifyPermission(handle, true))) return false;
    root = handle;
    await PN.idb.set('rootHandle', handle);
    await ensureStructure();
    await loadIndex();
    return true;
  }

  /* フォルダを選び直す（ユーザー操作から） */
  async function pickFolder() {
    const h = await window.showDirectoryPicker({ id: 'pdfnote-data', mode: 'readwrite' });
    if (!(await verifyPermission(h, true))) return false;
    root = h;
    await PN.idb.set('rootHandle', h);
    await ensureStructure();
    await loadIndex();
    return true;
  }

  /* ---- ファイルシステム小道具 ---- */
  async function getDir(path, create) {
    let d = root;
    for (const name of path) d = await d.getDirectoryHandle(name, { create: !!create });
    return d;
  }
  async function readJSON(dir, name) {
    try {
      const fh = await dir.getFileHandle(name);
      const f = await fh.getFile();
      return JSON.parse(await f.text());
    } catch (e) {
      if (e.name === 'NotFoundError') return null;
      throw e;
    }
  }
  async function writeFile(dir, name, data, type) {
    const fh = await dir.getFileHandle(name, { create: true });
    const w = await fh.createWritable();
    await w.write(type ? new Blob([data], { type }) : data);
    await w.close();
  }
  const writeJSON = (dir, name, obj) =>
    writeFile(dir, name, JSON.stringify(obj), 'application/json');
  async function readBlob(dir, name) {
    try { return await (await dir.getFileHandle(name)).getFile(); }
    catch (e) { if (e.name === 'NotFoundError') return null; throw e; }
  }

  async function ensureStructure() {
    await getDir(['notebooks'], true);
    if (!(await readJSON(root, 'index.json'))) {
      await writeJSON(root, 'index.json', {
        version: 1, grades: ['1年', '2年', '3年'], notebooks: []
      });
    }
  }

  /* ---- index.json ---- */
  async function loadIndex() {
    index = (await readJSON(root, 'index.json')) || { version: 2, folders: [], grades: ['1年', '2年', '3年'], notebooks: [] };
    if (!Array.isArray(index.grades)) index.grades = ['1年', '2年', '3年'];
    if (!Array.isArray(index.notebooks)) index.notebooks = [];
    if (!Array.isArray(index.folders)) index.folders = [];
    // v1 → v2 移行：既存のノート（grade/unit を持つ）を同名のフォルダに自動分類
    if ((index.version || 1) < 2) {
      const nameToId = new Map();
      index.folders.forEach(f => nameToId.set(f.name, f.id));
      index.notebooks.forEach(n => {
        if (n.folder) return;
        const parts = [];
        if (n.grade) parts.push(n.grade);
        if (n.unit) parts.push(n.unit);
        const name = parts.join(' ');
        if (!name) { n.folder = null; return; }
        let id = nameToId.get(name);
        if (!id) {
          id = 'fd-' + now() + '-' + rid();
          index.folders.push({ id, name, parent: null, createdAt: now() });
          nameToId.set(name, id);
        }
        n.folder = id;
      });
      index.version = 2;
      await saveIndex();
    }
    // 親フォルダ（parent）フィールドの正規化：未設定なら null（トップ階層）
    let needSave = false;
    index.folders.forEach(f => { if (f.parent === undefined) { f.parent = null; needSave = true; } });
    if (needSave) await saveIndex();
    return index;
  }
  const saveIndex = () => writeJSON(root, 'index.json', index);
  const getIndex = () => index;
  const entryOf = (id) => index.notebooks.find(n => n.id === id);

  /* ---- フォルダ操作 ---- */
  async function createFolder(name, parent = null) {
    const id = 'fd-' + now() + '-' + rid();
    const folder = { id, name, parent: parent || null, createdAt: now() };
    index.folders.push(folder);
    await saveIndex();
    return folder;
  }
  async function renameFolder(id, name) {
    const f = index.folders.find(x => x.id === id);
    if (!f) return;
    f.name = name;
    await saveIndex();
  }
  /* 親フォルダを変える。循環（自分自身や自分の子孫に入れる）は拒否 */
  async function moveFolder(id, parent) {
    parent = parent || null;
    if (parent === id) throw new Error('自分自身の中には入れられません');
    let cur = parent;
    while (cur) {
      if (cur === id) throw new Error('そのフォルダの中（子孫）には入れられません');
      const f = index.folders.find(x => x.id === cur);
      cur = f ? (f.parent || null) : null;
    }
    const f = index.folders.find(x => x.id === id);
    if (!f) return;
    f.parent = parent;
    await saveIndex();
  }
  /* フォルダ削除：中のサブフォルダ・ノートは「削除するフォルダの親」に引き上げる */
  async function deleteFolder(id) {
    const f = index.folders.find(x => x.id === id);
    const newParent = f ? (f.parent || null) : null;
    index.folders.forEach(x => { if (x.parent === id) x.parent = newParent; });
    index.notebooks.forEach(n => { if (n.folder === id) n.folder = newParent; });
    index.folders = index.folders.filter(x => x.id !== id);
    await saveIndex();
  }

  /* ---- ノート操作 ---- */
  async function createNotebook({ title, folder, grade, unit }) {
    const id = 'nb-' + now() + '-' + rid();
    const t = now();
    const nb = { id, title, folder: folder || null, grade: grade || '', unit: unit || '', createdAt: t, updatedAt: t, pages: [] };
    await writeJSON(await getDir(['notebooks', id], true), 'notebook.json', nb);
    index.notebooks.push({ id, title, folder: folder || null, grade: grade || '', unit: unit || '', pageCount: 0, createdAt: t, updatedAt: t, hasThumb: false });
    await saveIndex();
    return nb;
  }

  async function getNotebook(id) {
    const dir = await getDir(['notebooks', id]);
    return readJSON(dir, 'notebook.json');
  }

  /* opts.touch === false のときは更新日時を変えない
     （「最後に開いていたページ」だけの保存で、一覧の並び順が動かないように） */
  async function saveNotebook(nb, opts) {
    if (!opts || opts.touch !== false) nb.updatedAt = now();
    await writeJSON(await getDir(['notebooks', nb.id], true), 'notebook.json', nb);
    const e = entryOf(nb.id);
    if (e) {
      e.title = nb.title;
      e.grade = nb.grade || ''; e.unit = nb.unit || '';
      e.folder = nb.folder || null;
      e.pageCount = nb.pages.length; e.updatedAt = nb.updatedAt;
    }
    await saveIndex();
  }

  /* メタ情報だけ更新（名前変更・フォルダ移動） */
  async function updateMeta(id, { title, grade, unit, folder }) {
    const nb = await getNotebook(id);
    if (title != null) nb.title = title;
    if (grade != null) nb.grade = grade;
    if (unit != null) nb.unit = unit;
    if (folder !== undefined) nb.folder = folder;
    await saveNotebook(nb);
    return nb;
  }

  async function deleteNotebook(id) {
    try { await (await getDir(['notebooks'])).removeEntry(id, { recursive: true }); }
    catch (e) { if (e.name !== 'NotFoundError') throw e; }
    index.notebooks = index.notebooks.filter(n => n.id !== id);
    await saveIndex();
  }

  /* ノートを丸ごと複製（書き込み・PDF/画像の本体も別ファイルとしてコピー） */
  async function copyNotebook(srcId, { title, folder } = {}) {
    const src = await getNotebook(srcId);
    if (!src) throw new Error('コピー元のノートが見つかりません');
    const newId = 'nb-' + now() + '-' + rid();
    const t = now();
    const newDir = await getDir(['notebooks', newId], true);

    // アセット（PDF/画像の本体）を新しい名前でコピー。同じファイルは1回だけ複製
    const assetMap = new Map();
    for (const p of (src.pages || [])) {
      if (!p.asset || assetMap.has(p.asset)) continue;
      const blob = await readAsset(srcId, p.asset);
      if (!blob) { assetMap.set(p.asset, p.asset); continue; }
      const ext = (p.asset.match(/\.([a-z0-9]+)$/i) || [, 'bin'])[1];
      const newName = 'a-' + now() + '-' + rid() + '.' + ext;
      await writeFile(await getDir(['notebooks', newId, 'assets'], true), newName, blob);
      assetMap.set(p.asset, newName);
    }

    // ページ（書き込み含む）をディープコピーし、アセット名・ページIDを付け替え
    const pages = (src.pages || []).map((p, i) => {
      const np = JSON.parse(JSON.stringify(p));
      if (np.asset && assetMap.has(np.asset)) np.asset = assetMap.get(np.asset);
      np.id = 'pg-' + t + '-' + i + '-' + rid();
      return np;
    });

    const nb = {
      id: newId,
      title: title || ((src.title || '無題') + ' のコピー'),
      folder: (folder !== undefined) ? (folder || null) : (src.folder || null),
      grade: src.grade || '', unit: src.unit || '',
      createdAt: t, updatedAt: t, pages
    };
    await writeJSON(newDir, 'notebook.json', nb);

    // サムネイルもコピー
    let hasThumb = false;
    try { const thumb = await readThumb(srcId); if (thumb) { await writeFile(newDir, 'thumb.png', thumb); hasThumb = true; } }
    catch (e) { /* サムネは無くてよい */ }

    index.notebooks.push({
      id: newId, title: nb.title, folder: nb.folder, grade: nb.grade, unit: nb.unit,
      pageCount: pages.length, createdAt: t, updatedAt: t, hasThumb
    });
    await saveIndex();
    return nb;
  }

  /* ---- アセット（PDF・画像の本体） ---- */
  async function addAsset(nbId, blob, ext) {
    const name = 'a-' + now() + '-' + rid() + '.' + ext;
    await writeFile(await getDir(['notebooks', nbId, 'assets'], true), name, blob);
    return name;
  }
  async function readAsset(nbId, name) {
    try { return await readBlob(await getDir(['notebooks', nbId, 'assets']), name); }
    catch (e) { if (e.name === 'NotFoundError') return null; throw e; }
  }

  /* ---- サムネイル ---- */
  async function saveThumb(nbId, blob) {
    await writeFile(await getDir(['notebooks', nbId], true), 'thumb.png', blob);
    const e = entryOf(nbId);
    if (e && !e.hasThumb) { e.hasThumb = true; await saveIndex(); }
  }
  async function readThumb(nbId) {
    try { return await readBlob(await getDir(['notebooks', nbId]), 'thumb.png'); }
    catch (e) { return null; }
  }

  const rootName = () => (root ? root.name : '');

  return {
    tryRestore, usePrevious, pickFolder,
    getIndex, loadIndex, saveIndex, entryOf,
    createFolder, renameFolder, moveFolder, deleteFolder,
    createNotebook, getNotebook, saveNotebook, updateMeta, deleteNotebook, copyNotebook,
    addAsset, readAsset, saveThumb, readThumb, rootName
  };
})();
