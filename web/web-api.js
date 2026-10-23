/* ブラウザ版（iPad など）：デスクトップ版の preload.js（window.hexMemo）と同じ呼び方の窓口。
 * ノートとメモは、デスクトップ版と同じ boards.js・store.js を、ブラウザの保存領域の上（web-fs.js）で動かす。
 * 添付ファイルはブラウザの保存領域に Blob で持ち、画面には blob: の URL で見せる。
 * 読み込み・書き出しは zip（デスクトップ版の「メモアプリ全体の書き出し」・ノートの書き出しと同じ形）。
 * デスクトップでしかできないこと（複数ウィンドウ・常に最前面・リンク先の情報の取得など）は、使えない旨を返す。 */
(function () {
  'use strict';

  const W = window.HexWebFs;
  const Z = window.HexZip;
  const { require } = window.HexNode;
  const { BoardManager } = require('./boards');
  const { normalizeRecord } = require('./store');
  const HS = require('./send');
  const SB = require('./sendbox'); // コピーして送る（送り先の登録・ほかのノートへ置く）
  const { SettingsStore } = require('./settings'); // タグの登録・関連線の種類・クイック入力・定型・タグボタンのセット（棚の右クリック）など
  const { collectStoreRefs, isAttachmentFile, MIME } = require('./attachments');

  const DATA_DIR = '/data';
  const APP_FILE = '/data/web-app.json'; // このブラウザ版のデータの名前（読み込んだ zip のメモアプリ名）
  const MAX_CLIP_CELLS = 200;
  const IMAGE_EXTS = ['png', 'jpg', 'gif', 'webp'];
  const MB = 1024 * 1024;

  let boards = null;
  let settings = null;
  const revs = new Map();
  const attUrls = new Map(); // ファイル名 → blob: URL
  let clip = null; // このアプリの中でコピーしたマス（貼り付けに使う）

  const ok = (value = {}) => ({ ok: true, ...value });
  const fail = (err) => ({ ok: false, error: (err && err.message) || String(err) });
  const wrap = (fn) => async (...args) => {
    try {
      return ok(await fn(...args));
    } catch (err) {
      console.error('[hex-memo]', err);
      return fail(err);
    }
  };
  const notHere = (what) => async () => fail(new Error(`${what}は、ブラウザ版（iPad など）では使えません`));
  const clone = (v) => (typeof structuredClone === 'function' ? structuredClone(v) : JSON.parse(JSON.stringify(v)));
  const revOf = (id) => revs.get(String(id)) || 0;

  // コピーして送る：送り先の見出しを作るための情報（このブラウザのデータだけ）
  const sendContext = () => ({ selfAppId: null, boards, apps: [{ id: null, name: appName() }], dataDirOf: () => null });

  function appName() {
    try {
      const v = JSON.parse(W.fs.readFileSync(APP_FILE));
      if (v && typeof v.name === 'string' && v.name.trim()) return v.name.trim().slice(0, 60);
    } catch {
      // 名前がなければ既定の名前
    }
    return '六角メモ';
  }

  // ---- 起動 ----

  // 同じ保存領域を2つのタブで開くと上書きし合うので、先のタブが使っている間は読み込まずに案内を出して待つ
  const TAB_LOCK = 'hexmemo-web-data';
  let tabNotice = null;
  function showTabNotice() {
    const box = document.createElement('div');
    box.setAttribute('role', 'alert');
    box.style.cssText = 'position:fixed;inset:0;z-index:2147483647;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;padding:24px;text-align:center;background:#0a0d12;color:#e6edf3;font:16px/1.7 system-ui,-apple-system,sans-serif';
    const title = document.createElement('div');
    title.style.cssText = 'font-size:20px;font-weight:700';
    title.textContent = '六角メモは、別のタブですでに開かれています';
    const body = document.createElement('div');
    body.style.cssText = 'max-width:30em;color:#9aa7b4';
    body.textContent = '同じデータを2つのタブで開くと、お互いの内容を上書きしてしまうため、このタブでは開かずに待っています。もう一方のタブ（またはウィンドウ）を閉じると、自動でここで開きます。';
    box.append(title, body);
    document.body.append(box);
    tabNotice = box;
  }
  function hideTabNotice() {
    if (tabNotice) tabNotice.remove();
    tabNotice = null;
  }

  let started = null;
  function start() {
    if (!started) {
      started = (async () => {
        await W.claimOwner(navigator.locks, TAB_LOCK, showTabNotice);
        hideTabNotice();
        await W.open();
        W.fs.mkdirSync(DATA_DIR);
        boards = new BoardManager(DATA_DIR).load();
        settings = new SettingsStore(DATA_DIR);
        settings.load();
        for (const [name, v] of await W.attGetAll()) if (v && v.blob) attUrls.set(name, URL.createObjectURL(v.blob));
        // ホーム画面に追加したアプリでは、保存領域を消されにくくする（できる環境だけ）
        try {
          if (navigator.storage && navigator.storage.persist) navigator.storage.persist();
        } catch {
          // 頼めなくても使える
        }
      })();
    }
    return started;
  }

  // ---- 添付ファイル ----

  // 中身の先頭で種類を見分ける（デスクトップ版の attachments.js と同じ）
  function sniff(b) {
    if (!b || b.length < 4) return null;
    const ascii = (from, to) => String.fromCharCode(...b.subarray(from, to));
    if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'png';
    if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg';
    if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return 'gif';
    if (b.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'webp';
    if (b[0] === 0x00 && b[1] === 0x00 && b[2] === 0x01 && b[3] === 0x00) return 'ico';
    if (ascii(0, 5) === '%PDF-') return 'pdf';
    return null;
  }

  async function sha256(bytes) {
    // crypto.subtle は安全な接続（https・localhost）でしか使えないので、無ければ自前で計算する
    if (window.crypto && crypto.subtle && crypto.subtle.digest) {
      try {
        const digest = await crypto.subtle.digest('SHA-256', bytes);
        return [...new Uint8Array(digest)].map((x) => x.toString(16).padStart(2, '0')).join('');
      } catch {
        // 下の計算で
      }
    }
    return Z.sha256Hex(bytes);
  }

  async function putAttachment(name, bytes) {
    const ext = name.split('.').pop();
    const blob = new Blob([bytes], { type: MIME[ext] || 'application/octet-stream' });
    await W.attPut(name, blob);
    const old = attUrls.get(name);
    if (old) URL.revokeObjectURL(old);
    attUrls.set(name, URL.createObjectURL(blob));
  }

  async function putImage({ data, thumb }) {
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    const ext = sniff(bytes);
    if (!ext || !IMAGE_EXTS.includes(ext)) throw new Error('対応していない種類のファイルです（PNG・JPEG・GIF・WebP の画像に対応）');
    if (bytes.length > 25 * MB) throw new Error('ファイルが大きすぎます（25MB まで）');
    const hash = await sha256(bytes);
    const file = `${hash}.${ext}`;
    if (!attUrls.has(file)) await putAttachment(file, bytes);
    const image = { file, type: MIME[ext], size: bytes.length };
    if (thumb) {
      try {
        const t = thumb instanceof Uint8Array ? thumb : new Uint8Array(thumb);
        const text = sniff(t);
        if (text && IMAGE_EXTS.includes(text) && t.length <= 4 * MB) {
          image.thumb = `${hash}.thumb.${text}`;
          if (!attUrls.has(image.thumb)) await putAttachment(image.thumb, t);
        }
      } catch (err) {
        console.warn('[hex-memo] 縮小版を保存できませんでした:', err);
      }
    }
    return { image };
  }

  async function attachmentBytes(file) {
    const url = attUrls.get(file);
    if (!url) return null;
    return new Uint8Array(await (await fetch(url)).arrayBuffer());
  }

  // ---- 書き出し（ダウンロード）----

  const safeFileName = (name) => String(name || 'ノート').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/[. ]+$/, '').slice(0, 80) || 'ノート';

  // iPad では共有シート（「ファイル」に保存・Google Drive などへ）、それ以外はダウンロード
  async function deliver(bytes, fileName, type = 'application/zip') {
    const blob = new Blob([bytes], { type });
    try {
      const file = new File([blob], fileName, { type });
      if (navigator.canShare && navigator.share && navigator.canShare({ files: [file] }) && /iPad|iPhone|Macintosh/.test(navigator.userAgent) && 'ontouchend' in document) {
        await navigator.share({ files: [file], title: fileName });
        return fileName;
      }
    } catch (err) {
      if (err && err.name === 'AbortError') throw new Error('書き出しを取りやめました');
      // 共有できなければダウンロードにする
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    return fileName;
  }

  // zip の説明文（README.txt）の2行目：区画の紙片・棚・ゴミ箱のメモの画像も入ることを書く（デスクトップ版の main.js と同じ文）
  const ZIP_ATT_NOTE = 'attachments/ には、マスのメモだけでなく、区画の紙片と、未配置の棚のメモと、ゴミ箱（削除から 30 日以内）のメモの画像なども入っています';

  async function exportBoard(id) {
    await W.flush();
    const board = boards.get(String(id));
    const store = boards.store(board.id).current;
    const refs = [...collectStoreRefs(store)].sort();
    const entries = [{ name: 'memos.json', data: `${JSON.stringify(store, null, 2)}\n` }];
    let missing = 0;
    for (const f of refs) {
      const bytes = await attachmentBytes(f);
      if (bytes) entries.push({ name: `attachments/${f}`, data: bytes });
      else missing++;
    }
    entries.push({ name: 'README.txt', data: `六角メモ「${board.name}」の書き出し（${new Date().toLocaleString('ja-JP')}・ブラウザ版から）\r\n${ZIP_ATT_NOTE}\r\n` });
    const path = await deliver(Z.createZip(entries), `${safeFileName(board.name)}.hexmemo.zip`);
    return { path, files: refs.length - missing, missing };
  }

  async function exportApp() {
    await W.flush();
    const list = boards.list();
    const refs = new Set();
    const index = { version: 1, activeId: list.activeId, boards: [] };
    const files = [];
    for (const b of list.boards) {
      const board = boards.get(b.id);
      const store = boards.store(b.id).current;
      collectStoreRefs(store, refs);
      index.boards.push({ id: board.id, name: board.name, file: board.file, ...(board.parentId ? { parentId: board.parentId } : {}), ...(board.openId ? { openId: board.openId } : {}) });
      files.push({ name: board.file, data: `${JSON.stringify(store, null, 2)}\n` });
    }
    const name = appName();
    const entries = [
      { name: 'hexmemo-app.json', data: `${JSON.stringify({ format: 'hexmemo-app', version: 1, name, exportedAt: new Date().toISOString(), boards: list.boards.length, from: 'web' }, null, 2)}\n` },
      { name: 'boards.json', data: `${JSON.stringify(index, null, 2)}\n` },
      ...files,
    ];
    let missing = 0;
    for (const f of [...refs].sort()) {
      const bytes = await attachmentBytes(f);
      if (bytes) entries.push({ name: `attachments/${f}`, data: bytes });
      else missing++;
    }
    entries.push({ name: 'README.txt', data: `六角メモ「${name}」全体の書き出し（${new Date().toLocaleString('ja-JP')}・ノート ${list.boards.length} 冊・ブラウザ版から）\r\n${ZIP_ATT_NOTE}\r\n` });
    const stamp = new Date().toISOString().slice(0, 10);
    const path = await deliver(Z.createZip(entries), `${safeFileName(name)}-${stamp}.hexmemo-app.zip`);
    return { path, boards: list.boards.length, files: refs.size - missing, missing };
  }

  // ---- 読み込み（zip） ----

  // zip の中身を調べる。ほかのアプリで作り直した zip で、全体が1つのフォルダに入っていても読めるように
  async function readPackage(file) {
    if (!file) throw new Error('ファイルが選ばれていません');
    let entries = await Z.readZip(new Uint8Array(await file.arrayBuffer()));
    const top = entries.length && entries.every((e) => e.name.includes('/')) ? entries[0].name.split('/')[0] : null;
    if (top && entries.every((e) => e.name.startsWith(`${top}/`)) && !entries.some((e) => /^(boards|memos)\.json$/.test(e.name))) {
      entries = entries.map((e) => ({ ...e, name: e.name.slice(top.length + 1) }));
    }
    const byName = new Map(entries.map((e) => [e.name, e]));
    const json = (name) => {
      const e = byName.get(name);
      if (!e) return null;
      try {
        return JSON.parse(Z.text(e.data).replace(/^﻿/, ''));
      } catch {
        throw new Error(`${name} を読めませんでした（壊れているようです）`);
      }
    };
    const baseName = String(file.name || '').replace(/\.zip$/i, '').replace(/\.hexmemo(-app)?$/i, '').replace(/-\d{4}-\d{2}-\d{2}$/, '') || 'ノート';
    const atts = entries.filter((e) => e.name.startsWith('attachments/') && isAttachmentFile(e.name.slice('attachments/'.length)));
    if (byName.has('boards.json')) {
      const index = json('boards.json');
      const meta = json('hexmemo-app.json') || {};
      const list = Array.isArray(index && index.boards) ? index.boards : [];
      if (!list.length) throw new Error('boards.json にノートがありません');
      return { kind: 'app', name: (typeof meta.name === 'string' && meta.name.trim()) || baseName, boards: list.length, attachments: atts.length, index, byName, atts };
    }
    if (byName.has('memos.json')) {
      return { kind: 'board', name: baseName, boards: 1, attachments: atts.length, store: json('memos.json'), atts };
    }
    throw new Error('六角メモの書き出した zip ではないようです（boards.json も memos.json も見つかりません）');
  }

  async function importAttachments(atts) {
    let bad = 0;
    for (const e of atts) {
      const name = e.name.slice('attachments/'.length);
      // 中身と名前（中身から計算した値）が合うものだけ。縮小版は元の画像の名前なので中身では確かめない
      const m = /^([0-9a-f]{64})(\.thumb)?\./.exec(name);
      if (!m || (!m[2] && (await sha256(e.data)) !== m[1])) {
        bad++;
        continue;
      }
      await putAttachment(name, e.data);
    }
    return bad;
  }

  async function inspectImport(file) {
    await start();
    const p = await readPackage(file);
    return { kind: p.kind, name: p.name, boards: p.boards, attachments: p.attachments, current: { name: appName(), boards: boards.list().boards.length } };
  }

  async function importData(file) {
    await start();
    const p = await readPackage(file);
    await W.flush();
    if (p.kind === 'app') {
      // 全体を入れ替える：今のデータを消して、zip のノート一覧・ノート・添付ファイルを入れる
      const files = [];
      for (const b of p.index.boards) {
        const f = b && typeof b.file === 'string' && /^memos(?:-[a-z0-9]{1,32})?\.json$/.test(b.file) ? p.byName.get(b.file) : null;
        if (f) files.push({ name: b.file, text: Z.text(f.data) });
      }
      const keepSettings = clone(settings.get()); // 設定（タグの登録など）は zip には入っていないので、今のものを引き継ぐ
      await W.clearAll();
      for (const url of attUrls.values()) URL.revokeObjectURL(url);
      attUrls.clear();
      W.fs.mkdirSync(DATA_DIR);
      W.fs.writeFileSync(`${DATA_DIR}/boards.json`, `${JSON.stringify(p.index, null, 2)}\n`);
      for (const f of files) W.fs.writeFileSync(`${DATA_DIR}/${f.name}`, f.text);
      W.fs.writeFileSync(APP_FILE, `${JSON.stringify({ name: p.name, importedAt: new Date().toISOString() })}\n`);
      const bad = await importAttachments(p.atts);
      await W.flush();
      boards = new BoardManager(DATA_DIR).load();
      settings.update(keepSettings);
      return { kind: 'app', name: p.name, boards: boards.list().boards.length, attachments: p.atts.length - bad, skipped: bad };
    }
    // ノート1冊：新しいタブとして加える
    const { id } = boards.create(p.name, null);
    boards.save(id, p.store || {});
    const bad = await importAttachments(p.atts);
    await W.flush();
    return { kind: 'board', name: p.name, id, boards: 1, attachments: p.atts.length - bad, skipped: bad };
  }

  // ---- 使われていない添付ファイルの片付け（すべてのノートと、そのバックアップが使っていないもの） ----

  async function sweepAttachments({ graceMs = 60 * 1000 } = {}) {
    await W.flush();
    const refs = new Set();
    for (const name of W.fs.readdirSync(DATA_DIR)) {
      if (!/^memos(?:-[a-z0-9]{1,32})?\.json/.test(name)) continue;
      try {
        collectStoreRefs(JSON.parse(W.fs.readFileSync(`${DATA_DIR}/${name}`)), refs);
      } catch {
        return { removed: 0, bytes: 0, kept: 0 }; // 読めないファイルがあれば何も消さない
      }
    }
    let removed = 0;
    let bytes = 0;
    const now = Date.now();
    for (const [name, v] of await W.attGetAll()) {
      if (refs.has(name) || (v && now - (v.addedAt || 0) < graceMs)) continue;
      await W.attDelete(name);
      const url = attUrls.get(name);
      if (url) URL.revokeObjectURL(url);
      attUrls.delete(name);
      removed++;
      bytes += v && v.blob ? v.blob.size : 0;
    }
    return { removed, bytes, kept: attUrls.size };
  }

  // ---- クリップボード：マスのコピーはアプリの中に持ち、文字はシステムのクリップボードにも ----

  const clipText = (payload) => (payload && typeof payload.text === 'string' ? payload.text : payload && payload.record && typeof payload.record.text === 'string' ? payload.record.text : '');

  async function writeClip(payload) {
    clip = clone(payload);
    try {
      await navigator.clipboard.writeText(clipText(payload));
    } catch {
      // 許可されなければアプリの中だけで
    }
    return {};
  }

  async function readClip() {
    let sys = null;
    try {
      sys = await navigator.clipboard.readText();
    } catch {
      sys = null; // 読めない（許可されない）ときは、アプリの中でコピーしたものを使う
    }
    if (clip && (sys === null || sys === clipText(clip))) {
      const now = new Date().toISOString();
      const record = normalizeRecord(clone(clip.record), now);
      if (record) {
        const cells = Array.isArray(clip.records) ? clip.records.slice(0, MAX_CLIP_CELLS).map((r) => normalizeRecord(clone(r), now)).filter(Boolean) : [];
        return { cell: { record, nonce: String(clip.nonce || ''), cut: clip.cut === true }, ...(cells.length > 1 ? { cells } : {}) };
      }
    }
    return { text: sys || null };
  }

  // ---- 窓口 ----

  const noop = () => {};
  window.hexMemo = {
    platform: 'web',
    attachmentUrl: (file) => attUrls.get(file) || '',
    init: wrap(async () => {
      await start();
      const list = boards.list();
      return { ...list, notices: boards.takeNotices(), app: { id: null, name: appName() }, settings: clone(settings.get()), quickInput: false };
    }),
    // 設定：このブラウザのデータの中に持つ。クイック入力のキーはアプリの中だけで効く（ほかのアプリの前からは呼び出せない）
    getSettings: wrap(async () => {
      await start();
      return { settings: clone(settings.get()) };
    }),
    setSettings: wrap(async (patch) => {
      await start();
      return { settings: clone(settings.update(patch)), shortcutError: null };
    }),
    onSettingsChanged: noop,
    notifyDue: wrap(async () => ({})), // ブラウザ版の通知は画面側（Notification API）で出す
    onCapture: noop, // 六角形スクショは本体だけ（ブラウザはほかの画面を撮れない）
    saveTextFile: wrap(async ({ name, text, type } = {}) => ({ path: await deliver(new TextEncoder().encode(String(text || '')), String(name || 'file.txt'), String(type || 'application/json')) })),
    saveBinaryFile: wrap(async ({ name, bytes, type } = {}) => ({ path: await deliver(new Uint8Array(bytes), String(name || 'file.bin'), String(type || 'application/octet-stream')) })),
    openTextFile: wrap(({ filters } = {}) => new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      const exts = (Array.isArray(filters) ? filters : []).flatMap((f) => (f && Array.isArray(f.extensions) ? f.extensions : [])).filter((x) => x && x !== '*');
      input.accept = exts.length ? exts.map((x) => `.${x}`).join(',') : '.json,.txt,application/json,text/plain';
      input.hidden = true;
      document.body.append(input);
      const done = (value) => {
        input.remove();
        resolve(value);
      };
      input.addEventListener('change', async () => {
        const file = input.files && input.files[0];
        if (!file) return done({ canceled: true });
        if (file.size > 20 * 1024 * 1024) return done(fail(new Error('ファイルが大きすぎます（20MB まで）')));
        done({ path: file.name, text: await file.text() });
      });
      input.addEventListener('cancel', () => done({ canceled: true }));
      input.click();
    })),
    createBoard: wrap(async (parentId = null) => {
      const { id, name } = boards.create(undefined, parentId ? String(parentId) : null);
      return { board: { id, name }, ...boards.list() };
    }),
    moveBoard: wrap(async (id, parentId = null, beforeId = null) => {
      boards.move(String(id), parentId ? String(parentId) : null, beforeId ? String(beforeId) : null);
      return boards.list();
    }),
    renameBoard: wrap(async (id, name) => {
      boards.rename(String(id), name);
      return boards.list();
    }),
    deleteBoard: wrap(async (id) => {
      const gone = new Set(boards.subtreeIds(String(id)));
      boards.remove(String(id));
      // 削除したノート（子ノートも）を指す送り先の登録も外す
      try {
        SB.pruneTargets(DATA_DIR, (t) => !t.appId && gone.has(t.boardId));
      } catch (err) {
        console.warn('[hex-memo] 送り先の登録を片付けられませんでした:', err);
      }
      return boards.list();
    }),
    activateBoard: wrap(async (id) => {
      boards.activate(String(id));
      return {};
    }),
    loadBoard: wrap(async (id) => {
      const s = boards.store(String(id));
      return { store: clone(s.current), rev: revOf(id), notices: s.takeNotices(), readOnly: s.readOnly };
    }),
    boardStats: wrap(async (id) => boards.stats(String(id))),
    peekBoard: wrap(async (id) => ({ store: clone(boards.store(String(id)).current) })),
    saveBoard: async (id, data) => {
      try {
        boards.save(String(id), data);
        revs.set(String(id), revOf(id) + 1);
        return { ok: true, savedAt: new Date().toISOString(), rev: revOf(id) };
      } catch (err) {
        console.error('[hex-memo] 保存に失敗しました:', err);
        return fail(err);
      }
    },
    saveSync: (snapshots) => {
      const results = (Array.isArray(snapshots) ? snapshots : []).map((s) => {
        try {
          boards.save(String(s.id), s.data);
          return { ok: true };
        } catch (err) {
          return fail(err);
        }
      });
      return { ok: results.every((r) => r.ok), results };
    },
    listApps: wrap(async () => ({ apps: [] })),
    createApp: notHere('別のメモアプリの作成'),
    openApp: notHere('別のメモアプリを開くこと'),
    openDataFolder: notHere('データフォルダを開くこと'),
    writeClip: wrap(writeClip),
    readClip: wrap(readClip),
    writeLink: wrap(async ({ url }) => {
      try {
        await navigator.clipboard.writeText(String(url));
      } catch {
        throw new Error('クリップボードに書き込めませんでした');
      }
      return {};
    }),
    putImage: wrap(putImage),
    openAttachment: wrap(async (file) => {
      const url = attUrls.get(file);
      if (!url) throw new Error('ファイルが見つかりません');
      window.open(url, '_blank');
      return {};
    }),
    revealAttachment: notHere('フォルダで表示'),
    saveAttachmentAs: wrap(async (file, name) => {
      const bytes = await attachmentBytes(file);
      if (!bytes) throw new Error('ファイルが見つかりません');
      const ext = file.split('.').pop();
      const base = safeFileName(String(name || '').replace(/\.[^.]+$/, '')) || '画像';
      return { path: await deliver(bytes, `${base}.${ext}`, MIME[ext] || 'application/octet-stream') };
    }),
    sweepAttachments: wrap(sweepAttachments),
    exportBoard: wrap(exportBoard),
    exportApp: wrap(exportApp),
    inspectImport: wrap(inspectImport),
    importData: wrap(importData),
    previewLink: wrap(async () => ({ preview: {} })), // リンク先の情報は取りに行けない（ブラウザの制限）
    checkLinks: notHere('リンク切れの確認'),
    openLink: wrap(async (url) => {
      window.open(String(url), '_blank', 'noopener');
      return {};
    }),
    snapshotLink: notHere('ページの保存（PDF）'),
    openMemoLink: notHere('ほかのメモアプリのマスへのリンク'),
    takePendingLink: wrap(async () => ({ url: null })),
    onNavigate: noop,
    registerProtocol: notHere('マスへのリンクの登録'),
    importBookmarks: notHere('ブックマークの読み込み'),
    onCommand: noop,
    newWindow: notHere('新しいウィンドウ'),
    exitMini: wrap(async () => ({})), // 小窓はデスクトップ版だけ
    setOnTop: wrap(async () => ({ onTop: false })),
    onOnTop: noop,
    onBoardChanged: noop,
    onBoardsChanged: noop,
    // コピーして送る：このブラウザのデータの中だけ（ほかのメモアプリは無い）
    sendTargets: wrap(async () => ({ targets: SB.describeTargets(SB.readTargets(DATA_DIR), sendContext()) })),
    sendRegistered: wrap(async () => ({ targets: SB.readTargets(DATA_DIR) })),
    sendCatalog: wrap(async () => ({ apps: SB.catalog(sendContext()) })),
    addSendTarget: wrap(async (raw) => {
      const r = SB.addTarget(DATA_DIR, { ...(raw || {}), appId: null });
      return { targets: SB.describeTargets(r.targets, sendContext()), id: r.target.id, existed: r.existed };
    }),
    removeSendTarget: wrap(async (id) => ({ targets: SB.describeTargets(SB.removeTarget(DATA_DIR, String(id)), sendContext()) })),
    sendRecords: wrap(async (target, payload) => {
      const t = SB.normalizeTarget(target);
      if (!t) throw new Error('送り先の形が正しくありません');
      if (t.appId) throw new Error('ほかのメモアプリへは、ブラウザ版（iPad など）からは送れません');
      const now = new Date().toISOString();
      const { cells, offsets } = HS.pairCells(payload && payload.records, payload && payload.offsets, (r) => normalizeRecord(r, now), HS.MAX_SEND);
      if (!cells.length) throw new Error('送るメモがありません');
      // 保存（の書き換え）は待たずに、すぐ行う：途中で画面がそのノートを読み直しても、送ったものが入っているように
      const r = SB.insertIntoBoards(boards, t, cells, offsets, { now });
      revs.set(r.boardId, revOf(r.boardId) + 1);
      return { delivered: true, self: true, boardId: r.boardId, boardPath: r.boardPath, memoText: r.memoText, placed: r.placed, fellBack: false };
    }),
    onAppNotice: noop,
    // ブラウザの保存領域への書き込みを待つ（書き出しの前・画面を離れるとき）
    flush: () => W.flush(),
  };

  // 保存領域に書けなかったとき（空き容量が足りないなど）は、画面に知らせる
  W.onPersistError = (err) => window.dispatchEvent(new CustomEvent('hexmemo-storage-error', { detail: (err && err.message) || String(err) }));

  // 一度開けば、ネットにつながっていなくても開けるように（https か localhost で開いたときだけ使える）
  if ('serviceWorker' in navigator && window.isSecureContext) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch((err) => console.warn('[hex-memo] オフライン用の準備ができませんでした:', err));
    });
  }
})();
