/* ブラウザ版（iPad など）：デスクトップ版の保存の仕組み（boards.js・store.js）を、そのまま動かすための「ファイル置き場」。
 * Node の fs・path・crypto のうち、それらが使う分だけを、メモリ上の小さなファイルシステムとして用意する。
 * 中身はブラウザの保存領域（IndexedDB）に書き込み、次に開いたときに読み戻す。
 * 添付ファイル（画像など）は別の置き場（att）に、ファイル名 → Blob で持つ。
 * ブラウザでは window.HexWebFs、Node（テスト）では module.exports として使う（テストでは IndexedDB を使わない）。 */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.HexWebFs = api;
})(typeof self !== 'undefined' ? self : globalThis, function (root) {
  'use strict';

  const DB_NAME = 'hexmemo-web';
  const DB_VERSION = 1;

  const files = new Map(); // パス → { data: string, birthtimeMs, mtimeMs }
  const dirs = new Set(['/']);
  const pending = new Set(); // 書き込み中の IndexedDB の処理
  let db = null;

  const fsError = (code, p) => Object.assign(new Error(`${code}: ${p}`), { code });

  // '/a/b/../c' → '/a/c'（Windows の区切りも / に）
  function norm(p) {
    const parts = [];
    for (const seg of String(p).replace(/\\/g, '/').split('/')) {
      if (!seg || seg === '.') continue;
      if (seg === '..') parts.pop();
      else parts.push(seg);
    }
    return `/${parts.join('/')}`;
  }
  const parentOf = (p) => (p === '/' ? '/' : norm(p.slice(0, p.lastIndexOf('/')) || '/'));
  function addDirs(p) {
    for (let d = parentOf(p); !dirs.has(d); d = parentOf(d)) dirs.add(d);
  }

  // ---- 保存領域（IndexedDB） ----

  const reqDone = (req) => new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  const txDone = (tx) => new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error || new Error('保存が中断されました'));
    tx.onerror = () => reject(tx.error);
  });

  function track(promise) {
    const p = promise.catch((err) => {
      console.error('[hex-memo] ブラウザの保存領域に書けませんでした:', err);
      if (typeof api.onPersistError === 'function') api.onPersistError(err);
    });
    pending.add(p);
    p.finally(() => pending.delete(p));
    return p;
  }

  // ファイルの変更を保存領域へ（.tmp は書いてすぐ名前を変えるので、保存領域には書かない）
  function persist(p) {
    if (!db || p.endsWith('.tmp')) return;
    const f = files.get(p);
    const tx = db.transaction('files', 'readwrite');
    const store = tx.objectStore('files');
    if (f) store.put({ path: p, data: f.data, birthtimeMs: f.birthtimeMs, mtimeMs: f.mtimeMs });
    else store.delete(p);
    track(txDone(tx));
  }

  async function open({ name = DB_NAME } = {}) {
    if (db) return;
    const req = root.indexedDB.open(name, DB_VERSION);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains('files')) d.createObjectStore('files', { keyPath: 'path' });
      if (!d.objectStoreNames.contains('att')) d.createObjectStore('att');
    };
    db = await reqDone(req);
    const tx = db.transaction('files', 'readonly');
    const all = await reqDone(tx.objectStore('files').getAll());
    for (const r of all) {
      files.set(r.path, { data: r.data, birthtimeMs: r.birthtimeMs || 0, mtimeMs: r.mtimeMs || 0 });
      addDirs(r.path);
    }
  }

  // まだ保存領域に書き終わっていない変更を待つ
  async function flush() {
    while (pending.size) await Promise.all([...pending]);
  }

  // この保存領域を使うタブを1つに絞る（Web Locks）。起動時に全部読み込んで変えた分を書き戻す作りなので、
  // 2つのタブで開くと古い中身でお互いを上書きしてしまう。先のタブが使っている間は onWait を呼んで待ち、閉じられたら続ける。
  // 持ち主のロックはタブが閉じるまで離さない。Web Locks が無い・使えない環境（http の LAN など）では待たずに通す。
  // 戻り値：'owner'（そのまま使える）・'waited'（待ってから使える）・'unsupported'（絞れない）
  async function claimOwner(locks, name, onWait) {
    if (!locks || typeof locks.request !== 'function') return 'unsupported';
    const hold = () => new Promise(() => {});
    let got;
    try {
      got = await new Promise((resolve, reject) => {
        const done = locks.request(name, { ifAvailable: true }, (lock) => {
          resolve(!!lock);
          return lock ? hold() : undefined;
        });
        if (done && typeof done.catch === 'function') done.catch(reject);
      });
    } catch {
      return 'unsupported';
    }
    if (got) return 'owner';
    if (typeof onWait === 'function') onWait();
    await new Promise((resolve, reject) => {
      const done = locks.request(name, () => {
        resolve();
        return hold();
      });
      if (done && typeof done.catch === 'function') done.catch(reject);
    });
    return 'waited';
  }

  // ---- 添付ファイル（ファイル名 → { blob, addedAt }） ----

  async function attGetAll() {
    if (!db) return new Map();
    const tx = db.transaction('att', 'readonly');
    const store = tx.objectStore('att');
    const [keys, values] = await Promise.all([reqDone(store.getAllKeys()), reqDone(store.getAll())]);
    return new Map(keys.map((k, i) => [k, values[i]]));
  }
  function attPut(name, blob) {
    const tx = db.transaction('att', 'readwrite');
    tx.objectStore('att').put({ blob, addedAt: Date.now() }, name);
    return track(txDone(tx));
  }
  function attDelete(name) {
    const tx = db.transaction('att', 'readwrite');
    tx.objectStore('att').delete(name);
    return track(txDone(tx));
  }

  // すべて消す（データの読み込みで入れ替えるとき）
  async function clearAll() {
    files.clear();
    dirs.clear();
    dirs.add('/');
    if (!db) return;
    const tx = db.transaction(['files', 'att'], 'readwrite');
    tx.objectStore('files').clear();
    tx.objectStore('att').clear();
    await track(txDone(tx));
  }

  // ---- fs（boards.js・store.js が使う同期の関数だけ） ----

  function write(p, data) {
    const now = Date.now();
    const old = files.get(p);
    files.set(p, { data: String(data), birthtimeMs: old ? old.birthtimeMs : now, mtimeMs: now });
    addDirs(p);
    persist(p);
  }

  const fs = {
    existsSync: (p) => files.has(norm(p)) || dirs.has(norm(p)),
    mkdirSync(p) {
      const d = norm(p);
      dirs.add(d);
      addDirs(d);
    },
    readdirSync(p) {
      const d = norm(p);
      if (!dirs.has(d)) throw fsError('ENOENT', p);
      const prefix = d === '/' ? '/' : `${d}/`;
      const names = new Set();
      for (const k of [...files.keys(), ...dirs]) {
        if (k === d || !k.startsWith(prefix)) continue;
        names.add(k.slice(prefix.length).split('/')[0]);
      }
      return [...names].sort();
    },
    readFileSync(p) {
      const f = files.get(norm(p));
      if (!f) throw fsError('ENOENT', p);
      return f.data;
    },
    // writeFileSync(パス or openSync の戻り値, 中身)
    writeFileSync(target, data) {
      if (target && typeof target === 'object' && target.isFd) {
        target.data = String(data);
        return;
      }
      write(norm(target), data);
    },
    openSync: (p) => ({ isFd: true, path: norm(p), data: '' }),
    fsyncSync() {},
    closeSync(fd) {
      if (fd && fd.isFd) write(fd.path, fd.data);
    },
    renameSync(from, to) {
      const a = norm(from);
      const b = norm(to);
      const f = files.get(a);
      if (!f) throw fsError('ENOENT', from);
      files.delete(a);
      const old = files.get(b);
      files.set(b, { ...f, birthtimeMs: old ? old.birthtimeMs : f.birthtimeMs, mtimeMs: Date.now() });
      addDirs(b);
      persist(a);
      persist(b);
    },
    copyFileSync(from, to) {
      const f = files.get(norm(from));
      if (!f) throw fsError('ENOENT', from);
      write(norm(to), f.data);
    },
    rmSync(p, { force = false } = {}) {
      const a = norm(p);
      if (!files.has(a)) {
        if (force) return;
        throw fsError('ENOENT', p);
      }
      files.delete(a);
      persist(a);
    },
    unlinkSync(p) {
      fs.rmSync(p);
    },
    statSync(p) {
      const a = norm(p);
      const f = files.get(a);
      if (f) return { birthtimeMs: f.birthtimeMs, mtimeMs: f.mtimeMs, size: f.data.length, isFile: () => true, isDirectory: () => false };
      if (dirs.has(a)) return { birthtimeMs: 0, mtimeMs: 0, size: 0, isFile: () => false, isDirectory: () => true };
      throw fsError('ENOENT', p);
    },
  };

  const path = {
    sep: '/',
    join: (...parts) => norm(parts.join('/')),
    resolve: (...parts) => norm(parts.join('/')),
    dirname: (p) => parentOf(norm(p)),
    basename(p, ext) {
      const b = String(p).replace(/\\/g, '/').split('/').filter(Boolean).pop() || '';
      return ext && b.endsWith(ext) ? b.slice(0, -ext.length) : b;
    },
    extname(p) {
      const b = path.basename(p);
      const i = b.lastIndexOf('.');
      return i > 0 ? b.slice(i) : '';
    },
  };

  const hex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  const crypto = {
    randomBytes(n) {
      const bytes = new Uint8Array(n);
      root.crypto.getRandomValues(bytes);
      return { toString: () => hex(bytes) };
    },
    randomUUID() {
      if (root.crypto.randomUUID) return root.crypto.randomUUID();
      const b = new Uint8Array(16);
      root.crypto.getRandomValues(b);
      b[6] = (b[6] & 0x0f) | 0x40;
      b[8] = (b[8] & 0x3f) | 0x80;
      const h = hex(b);
      return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
    },
  };

  const api = {
    fs, path, crypto, open, flush, claimOwner, clearAll, attGetAll, attPut, attDelete,
    // テスト用：メモリ上のファイルを直接見る
    _files: files,
    onPersistError: null,
  };
  return api;
});
