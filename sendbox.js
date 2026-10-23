'use strict';

/* 「コピーして送る」の保存の側（デスクトップ版の本体 main.js と、ブラウザ版 web-api.js で使う）。
 *  ・送り先の登録：すべてのメモアプリで共通（大もとのデータフォルダの send-targets.json）。ブラウザ版はそのデータの中。
 *    送り先は「ノート（原点の下の階層へ）」か「メモ（マスへのリンク。そのマスの下の階層へ）」。ID だけを持ち、
 *    見出し（アプリ名・ノート名・メモの最初の行）はそのつど作る（名前を変えても古くならないように）
 *  ・同じメモアプリのノートへ：そのノートの保存内容に写しを置いて保存する（insertIntoBoards）
 *  ・ほかのメモアプリへ：相手のデータフォルダの inbox/ に、写しと画像のファイルを置き（dropToInbox）、
 *    相手のプロセスが取り込む（processInbox）。相手のノートのファイルは直接書き換えない
 *    （相手が動いていると、相手の次の保存で上書きされてしまうため。相手のファイルを書くのは相手のプロセスだけ） */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const HS = require('./send');
const { normalizeRecord, normalizeStore, readJsonFile, writeFileAtomic, MAX_DEPTH } = require('./store');
const { BoardManager } = require('./boards');
const { collectRecordRefs } = require('./attachments');

const TARGETS_FILE = 'send-targets.json';
const MAX_TARGETS = 60;
const BOARD_ID_RE = /^[a-z0-9]{1,32}$/;
const APP_ID_RE = /^[0-9a-f]{8}$/;
const MEMO_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const TARGET_ID_RE = /^[a-z0-9]{4,32}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

const nowIso = () => new Date().toISOString();

// ---- 送り先の登録 -----------------------------------------------------------

// { id, kind: 'board'|'memo', appId（null は大もとの六角メモ）, boardId, memoId?, addedAt }。形の合わないものは null
function normalizeTarget(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const kind = raw.kind === 'board' || raw.kind === 'memo' ? raw.kind : null;
  const appId = raw.appId == null || raw.appId === '' ? null : typeof raw.appId === 'string' && APP_ID_RE.test(raw.appId) ? raw.appId : undefined;
  if (!kind || appId === undefined) return null;
  const boardId = typeof raw.boardId === 'string' && BOARD_ID_RE.test(raw.boardId) ? raw.boardId : null;
  const memoId = typeof raw.memoId === 'string' && MEMO_ID_RE.test(raw.memoId) ? raw.memoId : null;
  if (kind === 'board' && !boardId) return null;
  if (kind === 'memo' && !memoId) return null;
  const out = {
    id: typeof raw.id === 'string' && TARGET_ID_RE.test(raw.id) ? raw.id : crypto.randomBytes(6).toString('hex'),
    kind,
    appId,
    boardId,
  };
  if (kind === 'memo') out.memoId = memoId;
  out.addedAt = typeof raw.addedAt === 'string' && ISO_RE.test(raw.addedAt) ? raw.addedAt : nowIso();
  return out;
}

// 同じ送り先か（ノートはノートの ID、メモはメモの ID で比べる。どちらもメモアプリが同じとき）
function sameTarget(a, b) {
  if (!a || !b || a.kind !== b.kind || (a.appId || null) !== (b.appId || null)) return false;
  return a.kind === 'board' ? a.boardId === b.boardId : a.memoId === b.memoId;
}

function parseTargets(value) {
  if (!value || !Array.isArray(value.targets)) return [];
  const out = [];
  for (const raw of value.targets) {
    const t = normalizeTarget(raw);
    if (t && !out.some((x) => x.id === t.id || sameTarget(x, t))) out.push(t);
    if (out.length >= MAX_TARGETS) break;
  }
  return out;
}

// 見るための読み込み（読めなければ空）
function readTargets(dir) {
  const res = readJsonFile(path.join(dir, TARGETS_FILE));
  return res.status === 'ok' ? parseTargets(res.value) : [];
}

// 書き換えるための読み込み：すべてのメモアプリが共有するファイルなので、読めないとき（ほかのプロセスが掴んでいる
// など）は書き換えない（登録を消してしまわないように）。壊れていれば退避してから作り直す
function readTargetsForWrite(dir) {
  const file = path.join(dir, TARGETS_FILE);
  const res = readJsonFile(file);
  if (res.status === 'ok') return parseTargets(res.value);
  if (res.status === 'missing') return [];
  if (res.status === 'error') throw new Error('送り先の一覧を読めませんでした。少し待ってから、もう一度試してください');
  try {
    fs.renameSync(file, `${file}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  } catch {
    throw new Error('送り先の一覧が壊れていて、退避もできませんでした');
  }
  return [];
}

// ほかのプロセスと同時に書いても混ざらないよう、自分だけの一時ファイルに書いてから置き換える
function writeTargets(dir, list) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, TARGETS_FILE);
  const pid = typeof process !== 'undefined' && process.pid ? process.pid : 0;
  const tmp = `${file}.${pid}-${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify({ version: 1, targets: list }, null, 2)}\n`, 'utf8');
  try {
    renameRetry(tmp, file);
  } catch (err) {
    rmrf(tmp);
    throw err;
  }
  return list;
}

// 登録する（同じ送り先がすでにあれば、そのまま）。{ targets, target, existed }
function addTarget(dir, raw) {
  const t = normalizeTarget({ ...(raw && typeof raw === 'object' ? raw : {}), id: undefined, addedAt: undefined });
  if (!t) throw new Error('送り先の形が正しくありません');
  const list = readTargetsForWrite(dir);
  const found = list.find((x) => sameTarget(x, t));
  if (found) return { targets: list, target: found, existed: true };
  if (list.length >= MAX_TARGETS) throw new Error(`送り先は ${MAX_TARGETS} 件まで登録できます（使わないものを外してください）`);
  list.push(t);
  writeTargets(dir, list);
  return { targets: list, target: t, existed: false };
}

function removeTarget(dir, id) {
  const list = readTargetsForWrite(dir);
  const next = list.filter((x) => x.id !== id);
  if (next.length !== list.length) writeTargets(dir, next);
  return next;
}

// drop(t) が true の送り先を外す（ノートを削除したとき）
function pruneTargets(dir, drop) {
  const list = readTargetsForWrite(dir);
  const next = list.filter((t) => !drop(t));
  if (next.length !== list.length) writeTargets(dir, next);
  return next;
}

// ---- ノートの一覧と中身（自分のメモアプリは動いている BoardManager、ほかのアプリはファイルを読むだけ） ----

// ノートの道筋の名前（親のノート › 子のノート）
function boardPathNames(list, id) {
  const names = [];
  const seen = new Set();
  let b = list.find((x) => x.id === id);
  while (b && !seen.has(b.id)) {
    seen.add(b.id);
    names.unshift(b.name);
    b = b.parentId ? list.find((x) => x.id === b.parentId) : null;
  }
  return names;
}

const ownView = (boards) => ({
  list: boards.list().boards,
  activeId: boards.list().activeId,
  store: (id) => boards.store(id).current,
});

// ほかのメモアプリのノート：boards.json とノートのファイルを読むだけ（BoardManager.load・MemoStore.load は
// 読み込み時にファイルを作り直すことがあるので使わない）。一度も起動していないアプリは「ノート 1」だけ
function otherView(dir) {
  if (!dir) return null;
  const res = readJsonFile(path.join(dir, 'boards.json'));
  let entries;
  let activeId;
  if (res.status === 'ok') {
    const bm = new BoardManager(dir);
    if (!bm.applyIndex(res.value)) return null;
    entries = bm.boards.map((b) => ({ ...b }));
    activeId = bm.activeId;
  } else if (res.status === 'missing') {
    entries = [{ id: 'main', name: 'ノート 1', file: 'memos.json' }];
    activeId = 'main';
  } else {
    return null;
  }
  const cache = new Map();
  return {
    list: entries.map(({ id, name, parentId }) => ({ id, name, ...(parentId ? { parentId } : {}) })),
    activeId,
    store: (id) => {
      if (cache.has(id)) return cache.get(id);
      const b = entries.find((x) => x.id === id);
      let store = null;
      if (b) {
        const r = readJsonFile(path.join(dir, b.file));
        if (r.status === 'ok') store = normalizeStore(r.value, nowIso()).store;
        else if (r.status === 'missing') store = { version: 2, camera: { x: 0, y: 0 }, memos: {} };
      }
      cache.set(id, store);
      return store;
    },
  };
}

// メモの ID から、そのメモがあるノートを探す（prefer のノートを先に）
function findMemoIn(view, memoId, prefer) {
  const ids = view.list.map((b) => b.id);
  const order = prefer && ids.includes(prefer) ? [prefer, ...ids.filter((i) => i !== prefer)] : ids;
  for (const id of order) {
    const st = view.store(id);
    const found = st && HS.findMemo(st.memos, memoId);
    if (found) return { boardId: id, ...found };
  }
  return null;
}

// ctx：{ selfAppId, boards（このアプリの BoardManager）, apps: [{ id, name }], dataDirOf(appId) → フォルダ | null }
function viewOf(ctx, appId) {
  const views = ctx._views || (ctx._views = new Map());
  const key = appId || '';
  if (!views.has(key)) {
    let view = null;
    try {
      view = (appId || null) === (ctx.selfAppId || null) ? ownView(ctx.boards) : otherView(ctx.dataDirOf ? ctx.dataDirOf(appId) : null);
    } catch {
      view = null;
    }
    views.set(key, view);
  }
  return views.get(key);
}

// 送り先に見出しを付ける：{ ...送り先, self（このメモアプリか）, appName, exists, boardId（メモの場所から分かったもの）,
// boardPath: [ノートの名前…], memoText（メモの最初の行） }
function describeTargets(targets, ctx) {
  const appName = (id) => {
    const a = (ctx.apps || []).find((x) => (x.id || null) === (id || null));
    return a ? a.name : null;
  };
  return targets.map((t) => {
    const self = (t.appId || null) === (ctx.selfAppId || null);
    const out = { ...t, self, appName: appName(t.appId), exists: false, boardPath: [], memoText: '' };
    const view = viewOf(ctx, t.appId);
    if (!view) return out;
    try {
      let boardId = t.boardId;
      if (t.kind === 'memo') {
        const found = findMemoIn(view, t.memoId, t.boardId);
        if (found) {
          boardId = found.boardId;
          out.exists = true;
          out.memoText = HS.memoLabel(found.rec) || '（本文なし）';
        }
      } else {
        out.exists = view.list.some((b) => b.id === boardId);
        // ノートの原点のメモ（ID があれば、ほかのメモアプリでも「送り先を開く」でそのノートへ行ける）
        const st = out.exists ? view.store(boardId) : null;
        const origin = st && st.memos && st.memos[HS.CENTER];
        if (origin && typeof origin.id === 'string') out.originId = origin.id;
      }
      if (boardId && view.list.some((b) => b.id === boardId)) {
        out.boardId = boardId;
        out.boardPath = boardPathNames(view.list, boardId);
      }
    } catch {
      out.exists = false;
    }
    return out;
  });
}

// 「送り先を追加」で選べるノート：メモアプリごとのノート（ツリーの順）
function catalog(ctx) {
  return (ctx.apps || []).map((a) => {
    const self = (a.id || null) === (ctx.selfAppId || null);
    const view = viewOf(ctx, a.id || null);
    const list = view ? view.list : [];
    const ordered = [];
    const walk = (parentId, depth) => {
      for (const b of list.filter((x) => (x.parentId || null) === parentId)) {
        ordered.push({ id: b.id, name: b.name, depth });
        walk(b.id, depth + 1);
      }
    };
    walk(null, 0);
    for (const b of list) if (!ordered.some((x) => x.id === b.id)) ordered.push({ id: b.id, name: b.name, depth: 0 });
    return { id: a.id || null, name: a.name, self, available: !!view, boards: ordered };
  });
}

// ---- 同じメモアプリのノートへ置く -----------------------------------------------

// boards（このアプリの BoardManager）の、送り先のノートに写しを置いて保存する。
// fallback：送り先のメモ・ノートが見つからない・深すぎるときは、ノート（無ければ開いているノート）の原点の下へ置く
// （ほかのアプリから後で届いたときに、写しを失わないように）。返り値 { boardId, placed, fellBack, memoText }
function insertIntoBoards(boards, target, cells, offsets, { now = nowIso(), fallback = false } = {}) {
  const view = ownView(boards);
  const ids = view.list.map((b) => b.id);
  let boardId = target.boardId && ids.includes(target.boardId) ? target.boardId : null;
  let memoId = target.kind === 'memo' ? target.memoId : null;
  let memoText = '';
  let fellBack = null; // 送り先に置けず、ノートの原点の下へ置いたわけ（'missing-memo'・'missing-board'・'too-deep'・'full'）
  if (memoId) {
    const found = findMemoIn(view, memoId, boardId);
    if (found) {
      boardId = found.boardId;
      memoText = HS.memoLabel(found.rec) || '（本文なし）';
    } else if (fallback) {
      memoId = null;
      fellBack = 'missing-memo';
      boardId = boardId || view.activeId;
    } else {
      throw new Error('送り先のマスが見つかりません（削除された可能性があります）');
    }
  } else if (!boardId) {
    if (!fallback) throw new Error('送り先のノートが見つかりません（削除された可能性があります）');
    boardId = view.activeId;
    fellBack = 'missing-board';
  }
  const s = boards.store(boardId);
  if (s.readOnly) throw Object.assign(new Error('送り先のノートは、読み込みに失敗したため保存を止めています'), { transient: true });
  let data = JSON.parse(JSON.stringify(s.current));
  let res;
  try {
    res = HS.insertCopies(data, { memoId }, cells, { offsets, now, maxDepth: MAX_DEPTH });
  } catch (err) {
    if (!fallback || !memoId) throw err;
    // 送り先のマスの下に置けない（深すぎる・空きが無い）：ノートの原点の下へ
    data = JSON.parse(JSON.stringify(s.current));
    memoId = null;
    memoText = '';
    fellBack = /深すぎる/.test(String(err && err.message)) ? 'too-deep' : 'full';
    res = HS.insertCopies(data, { memoId: null }, cells, { offsets, now, maxDepth: MAX_DEPTH });
  }
  boards.save(boardId, data);
  return { boardId, placed: res.placed, fellBack: !!fellBack, fellBackReason: fellBack, memoText, boardPath: boardPathNames(view.list, boardId) };
}

// ---- ほかのメモアプリへの受け渡し（inbox） ----------------------------------------

const INBOX = 'inbox';
const INBOX_URL = 'hexmemo://inbox'; // 相手のプロセスへの合図（中身は持たない。古い版の六角メモは何もせずに無視する）
const isInboxArg = (a) => typeof a === 'string' && /^hexmemo:\/\/inbox\/?$/i.test(a);
const MAX_PAYLOAD = 64 * 1024 * 1024;
const RESULT_KEEP_MS = 10 * 60 * 1000;
const UNREADABLE_WAIT_MS = 60 * 1000;

function inboxPaths(dir) {
  const base = path.join(dir, INBOX);
  return { base, results: path.join(base, 'results'), failed: path.join(base, 'failed'), notices: path.join(base, 'notices.json') };
}

const sleepSync = (ms) => {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    // 待てない環境では、すぐにもう一度試す
  }
};

// Windows ではウイルス対策ソフトなどが掴んでいると名前の変更が失敗することがあるので、少し待って試し直す
function renameRetry(from, to, tries = 10) {
  for (let i = 0; ; i++) {
    try {
      fs.renameSync(from, to);
      return true;
    } catch (err) {
      if (i >= tries - 1 || !['EPERM', 'EBUSY', 'EACCES'].includes(err.code)) throw err;
      sleepSync(60);
    }
  }
}

const rmrf = (p) => {
  try {
    fs.rmSync(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    // 消せなくても次に片付ける
  }
};

const isDir = (p) => {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
};

// 送る側：相手のデータフォルダの inbox/<uuid>/ に、payload.json と、写しが使う画像のファイル（files/）を置く。
// <uuid>.part に書いてから名前を変えるので、相手が書きかけを読むことはない。files：[{ name, abs }]
function dropToInbox(targetDir, payload, files = []) {
  const p = inboxPaths(targetDir);
  fs.mkdirSync(p.base, { recursive: true });
  const id = crypto.randomUUID();
  const part = path.join(p.base, `${id}.part`);
  try {
    fs.mkdirSync(path.join(part, 'files'), { recursive: true });
    let missing = 0;
    for (const f of files) {
      try {
        fs.copyFileSync(f.abs, path.join(part, 'files', path.basename(f.name)));
      } catch {
        missing++;
      }
    }
    fs.writeFileSync(path.join(part, 'payload.json'), JSON.stringify({ ...payload, v: 1, id }), 'utf8');
    renameRetry(part, path.join(p.base, id));
    return { id, missing };
  } catch (err) {
    rmrf(part);
    throw err;
  }
}

// 送ったものの今の様子：'done'（結果がある）・'taking'（取り込み中）・'waiting'（まだ）・'gone'（見当たらない）
function inboxState(targetDir, id) {
  const p = inboxPaths(targetDir);
  if (fs.existsSync(path.join(p.results, `${id}.json`))) return 'done';
  if (fs.existsSync(path.join(p.base, `${id}.taking`))) return 'taking';
  if (fs.existsSync(path.join(p.base, id))) return 'waiting';
  return 'gone';
}

// まだ取り込めないわけ（受け取る側が、一時的に取り込めなかったときに残す）。無ければ null
function inboxWaitReason(targetDir, id) {
  if (!UUID_RE.test(String(id))) return null;
  const res = readJsonFile(path.join(inboxPaths(targetDir).results, `${id}.wait.json`));
  return res.status === 'ok' && typeof res.value.reason === 'string' ? res.value.reason : null;
}

// 受け取れる版（このファイルの版）の六角メモが動いている印：inbox/.alive に自分のプロセス番号を書く
function markInboxAlive(dir, pid) {
  try {
    const p = inboxPaths(dir);
    fs.mkdirSync(p.base, { recursive: true });
    fs.writeFileSync(path.join(p.base, '.alive'), JSON.stringify({ pid, v: 1 }), 'utf8');
  } catch {
    // 印が無くても、受け取りはできる（送る側が「古い版かも」と案内するだけ）
  }
}

function clearInboxAlive(dir, pid) {
  const file = path.join(inboxPaths(dir).base, '.alive');
  const res = readJsonFile(file);
  if (res.status === 'ok' && res.value.pid === pid) rmrf(file);
}

const pidAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
};

// 相手のメモアプリの様子（Windows）：'stopped'（動いていない）・'ready'（受け取れる版が動いている）・
// 'old'（動いているが、受け取れない古い版）。動いている間は、データフォルダに Chromium の lockfile がある。
// 受け取れる版は、起動するとすぐ .alive に自分のプロセス番号を書く（古い版は書かない）。
// .alive のプロセスがもう無いのに lockfile がある：落ちたときの残りか、起動の途中 → 動いていないものとして扱う
function appStatus(dir, isAlive = pidAlive) {
  if (!fs.existsSync(path.join(dir, 'lockfile'))) return 'stopped';
  const res = readJsonFile(path.join(inboxPaths(dir).base, '.alive'));
  if (res.status !== 'ok' || !Number.isInteger(res.value.pid)) return 'old';
  return isAlive(res.value.pid) ? 'ready' : 'stopped';
}

// 結果を読んで片付ける（無ければ null）
function takeInboxResult(targetDir, id) {
  if (!UUID_RE.test(String(id))) return null;
  const file = path.join(inboxPaths(targetDir).results, `${id}.json`);
  const res = readJsonFile(file);
  if (res.status !== 'ok') return null;
  rmrf(file);
  return res.value;
}

function writeResult(p, id, value) {
  try {
    fs.mkdirSync(p.results, { recursive: true });
    writeFileAtomic(path.join(p.results, `${id}.json`), JSON.stringify(value));
  } catch (err) {
    console.warn('[hex-memo] 受け渡しの結果を書けませんでした:', err);
  }
}

// 取り込み済み・古くなった結果を片付ける（送った側が読まなかったもの）
function cleanResults(p, now) {
  let names = [];
  try {
    names = fs.readdirSync(p.results);
  } catch {
    return;
  }
  for (const name of names) {
    const file = path.join(p.results, name);
    try {
      if (now - fs.statSync(file).mtimeMs > RESULT_KEEP_MS) rmrf(file);
    } catch {
      // 次に片付ける
    }
  }
}

const fromName = (payload) => {
  const n = payload && payload.from && typeof payload.from.appName === 'string' ? [...payload.from.appName.trim()].slice(0, 60).join('') : '';
  return n || 'ほかのメモアプリ';
};

const FALLBACK_WHY = {
  'missing-memo': '送り先のマスが見つからなかったため',
  'missing-board': '送り先のノートが見つからなかったため',
  'too-deep': '送り先のマスの下が深すぎるため',
  full: '送り先のマスの下に空きが無かったため',
};

function arrivalMessage(from, r, missing) {
  const where = `${r.boardPath.join(' › ') || 'ノート'}${r.memoText ? `・『${r.memoText}』の下` : 'の原点の下'}`;
  const head = r.fellBack
    ? `「${from}」から届いた ${r.placed.length} マスは、${FALLBACK_WHY[r.fellBackReason] || '送り先に置けなかったため'}「${where}」に置きました`
    : `「${from}」から ${r.placed.length} マス届きました（${where}）`;
  return missing ? `${head}。画像 ${missing} 件は届きませんでした` : head;
}

// 受け取る側：このアプリの inbox/ に届いたものを、順に取り込む（同期で動かす：途中で保存などが割り込まないように）。
// 返り値 { imported: [{ id, boardId, placed, … }], failed: [{ id, error }], notices: [{ level, message }] }
function processInbox({ dir, boards, attachments, now = Date.now(), maxPayload = MAX_PAYLOAD }) {
  const p = inboxPaths(dir);
  const out = { imported: [], failed: [], notices: [], deferred: [] };
  let names;
  try {
    names = fs.readdirSync(p.base);
  } catch {
    return out;
  }
  cleanResults(p, now);
  const iso = new Date(now).toISOString();
  for (const name of names) {
    const m = /^(.{36})(\.taking)?$/.exec(name);
    if (!m || !UUID_RE.test(m[1])) continue; // .part（書きかけ）・results・failed などは見ない
    const id = m[1];
    let work = path.join(p.base, name);
    if (!isDir(work)) continue;
    // 取り込み済みの印（inbox/<id>.imported）があれば、片付けが途中で止まっただけ：二重に取り込まない。
    // 印は消すフォルダの外に置く（片付けが途中で止まっても、印だけ先に消えることがないように）
    const marker = path.join(p.base, `${id}.imported`);
    if (fs.existsSync(marker)) {
      rmrf(work);
      if (!fs.existsSync(work)) rmrf(marker);
      continue;
    }
    if (m[2]) {
      // 前回の取り込みが途中で止まった：結果があれば取り込み済み（片付けるだけ）、無ければもう一度
      if (fs.existsSync(path.join(p.results, `${id}.json`))) {
        rmrf(work);
        continue;
      }
    } else {
      // 取り込む印に名前を変える（ウイルス対策ソフトなどが掴んでいれば少し待って試し直す。だめなら次に回す）
      const taking = path.join(p.base, `${id}.taking`);
      try {
        renameRetry(work, taking, 4);
      } catch (err) {
        defer('ファイルが使用中のため', false);
        continue;
      }
      work = taking;
    }
    // 一時的に取り込めない：わけを残して（送った側が待たずに知れるように）、あとでもう一度
    function defer(reason, notify) {
      const waitFile = path.join(p.results, `${id}.wait.json`);
      const first = !fs.existsSync(waitFile);
      try {
        fs.mkdirSync(p.results, { recursive: true });
        writeFileAtomic(waitFile, JSON.stringify({ reason, at: iso }));
      } catch {
        // わけが残せなくても、送った側は「まだ」と案内する
      }
      out.deferred.push({ id, reason });
      return first && notify;
    }
    const unclaim = () => {
      try {
        renameRetry(work, path.join(p.base, id), 3);
      } catch {
        // 次に起動したときに、.taking のまま取り込み直す
      }
    };
    // 取り込めなかったもの：inbox/failed/ に残し、送った側（結果）と、このアプリの画面（お知らせ）に伝える
    const fail = (message, fromApp) => {
      writeResult(p, id, { ok: false, error: message, at: iso }); // 先に結果を（送った側が「見当たらない」と迷わないように）
      try {
        fs.mkdirSync(p.failed, { recursive: true });
        renameRetry(work, path.join(p.failed, id), 3);
      } catch {
        rmrf(work);
      }
      out.failed.push({ id, error: message });
      out.notices.push({ level: 'error', message: `${fromApp ? `「${fromApp}」から` : ''}送られたマスを取り込めませんでした：${message}（データフォルダの inbox/failed に残しています）` });
    };
    const payloadFile = path.join(work, 'payload.json');
    let stat = null;
    try {
      stat = fs.statSync(payloadFile);
    } catch {
      stat = null;
    }
    const read = stat && stat.size <= maxPayload ? readJsonFile(payloadFile) : { status: stat ? 'too-big' : 'missing' };
    if (read.status === 'error') {
      // 読めない（ほかのプロセスが掴んでいるなど）：壊れているわけではないので、あとでもう一度
      unclaim();
      defer('ファイルが使用中のため', false);
      continue;
    }
    if (read.status !== 'ok') {
      let age = Infinity;
      try {
        age = now - fs.statSync(work).mtimeMs;
      } catch {
        age = Infinity;
      }
      if (read.status !== 'too-big' && age < UNREADABLE_WAIT_MS) {
        unclaim(); // 書き終わっていないかもしれない：次に回す
        continue;
      }
      fail('payload を読めませんでした', null);
      continue;
    }
    const payload = read.value;
    const from = fromName(payload);
    try {
      const target = normalizeTarget(payload.target);
      if (!target) throw new Error('送り先の形が正しくありません');
      const { cells, offsets } = HS.pairCells(payload.records, payload.offsets, (r) => normalizeRecord(r, iso), HS.MAX_SEND);
      if (!cells.length) throw new Error('送られたメモが読めませんでした');
      // 画像：同じ inbox の files/ からだけ取り込む（送った側のフォルダは読まない）
      const refs = new Set();
      for (const r of cells) collectRecordRefs(r, refs);
      let missing = 0;
      const filesDir = path.join(work, 'files');
      for (const f of refs) if (!attachments.has(f) && !attachments.importFrom(filesDir, f)) missing++;
      const r = insertIntoBoards(boards, target, cells, offsets, { now: iso, fallback: true });
      // 取り込んだ印を、片付ける前に残す（片付けが途中で止まっても、次に二重に取り込まないように）
      try {
        fs.writeFileSync(marker, iso, 'utf8');
      } catch {
        // 印が書けなくても、結果のファイルで見分ける
      }
      writeResult(p, id, { ok: true, placed: r.placed, boardId: r.boardId, boardPath: r.boardPath, memoText: r.memoText, fellBack: r.fellBack, fellBackReason: r.fellBackReason, missing, at: iso });
      rmrf(path.join(p.results, `${id}.wait.json`));
      out.imported.push({ id, from, ...r, missing });
      out.notices.push({ level: r.fellBack || missing ? 'warn' : 'info', message: arrivalMessage(from, r, missing) });
      rmrf(work);
      if (!fs.existsSync(work)) rmrf(marker);
    } catch (err) {
      if (err && err.transient) {
        unclaim(); // 一時的に保存できない：あとでもう一度
        if (defer(err.message, true)) out.notices.push({ level: 'warn', message: `「${from}」から届いたマスを、まだ取り込めていません：${err.message}（あとでもう一度試します）` });
        continue;
      }
      fail(err && err.message ? err.message : String(err), from);
    }
  }
  // 取り込み済みの印だけが残ったもの（フォルダはもう片付いた）を消す
  for (const name of names) {
    const m = /^(.{36})\.imported$/.exec(name);
    if (!m || !UUID_RE.test(m[1])) continue;
    if (!fs.existsSync(path.join(p.base, m[1])) && !fs.existsSync(path.join(p.base, `${m[1]}.taking`))) rmrf(path.join(p.base, name));
  }
  return out;
}

// 画面が無いとき（受け渡しのためだけに起動したとき）のお知らせは、次に開いた画面で出す
function saveInboxNotices(dir, notices) {
  if (!notices || !notices.length) return;
  const p = inboxPaths(dir);
  try {
    fs.mkdirSync(p.base, { recursive: true });
    const res = readJsonFile(p.notices);
    const list = res.status === 'ok' && Array.isArray(res.value.notices) ? res.value.notices : [];
    writeFileAtomic(p.notices, JSON.stringify({ notices: [...list, ...notices].slice(-50) }));
  } catch (err) {
    console.warn('[hex-memo] お知らせを残せませんでした:', err);
  }
}

function takeInboxNotices(dir) {
  const p = inboxPaths(dir);
  const res = readJsonFile(p.notices);
  if (res.status === 'missing') return [];
  rmrf(p.notices);
  if (res.status !== 'ok' || !Array.isArray(res.value.notices)) return [];
  return res.value.notices
    .filter((n) => n && typeof n.message === 'string' && ['info', 'warn', 'error'].includes(n.level))
    .map((n) => ({ level: n.level, message: n.message.slice(0, 500) }));
}

module.exports = {
  TARGETS_FILE,
  INBOX_URL,
  isInboxArg,
  normalizeTarget,
  sameTarget,
  readTargets,
  addTarget,
  removeTarget,
  pruneTargets,
  boardPathNames,
  describeTargets,
  catalog,
  insertIntoBoards,
  dropToInbox,
  inboxState,
  inboxWaitReason,
  takeInboxResult,
  markInboxAlive,
  clearInboxAlive,
  appStatus,
  FALLBACK_WHY,
  processInbox,
  saveInboxNotices,
  takeInboxNotices,
};
