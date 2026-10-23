'use strict';

/* ノート（タブ）の管理：boards.json の読み書きと、ノートごとの MemoStore。
 * 各ノートは memos.json と同じ形式（version 2）の別ファイルに保存する。
 * 最初のノートは従来どおり memos.json、追加したノートは memos-<id>.json。
 *
 * ノートはツリーにできる：parentId を持つノートは、その親のノートの「子ノート」。
 * 親を持たないノートが上段のタブになり、タブの中に子ノートが入る。
 * 兄弟の並び順は boards 配列の中での順番。タブ（いちばん上のノート）は、
 * 最後に開いていた子ノートを openId に覚えておき、タブを押したときにそこへ戻る。 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { MemoStore, DATA_FILE, countMemos, emptyStore, readJsonFile, writeFileAtomic, stamp } = require('./store');

const INDEX_FILE = 'boards.json';
const INDEX_VERSION = 1;
const NAME_MAX = 40;
const MAX_TREE_DEPTH = 10; // タブ（0 段目）から数えて、子ノートは 9 段目まで
const MAIN_ID = 'main';
const ID_RE = /^[a-z0-9]{1,32}$/;
const BOARD_FILE_RE = /^memos(?:-([a-z0-9]{1,32}))?\.json$/;

// ツリーの項目は、あるときだけ書く（タブだけの一覧は従来と同じ形のまま）
function treeFields(parentId, openId) {
  return { ...(parentId !== undefined ? { parentId } : {}), ...(openId !== undefined ? { openId } : {}) };
}

function cleanName(name) {
  if (typeof name !== 'string') return '';
  return [...name.replace(/\s+/g, ' ').trim()].slice(0, NAME_MAX).join('').trim();
}

class BoardManager {
  constructor(dir) {
    this.dir = dir;
    this.file = path.join(dir, INDEX_FILE);
    this.boards = []; // { id, name, file }（並び順 = タブの順）
    this.activeId = null;
    this.stores = new Map();
    this.notices = [];
    this.readOnly = false;
  }

  load(now = new Date()) {
    fs.mkdirSync(this.dir, { recursive: true });
    const res = readJsonFile(this.file);
    if (res.status === 'ok' && this.applyIndex(res.value)) return this;

    if (res.status === 'error') {
      // 読めないだけで壊れているとは限らないので上書きしない
      this.readOnly = true;
      this.notice('error', `ノート一覧（${INDEX_FILE}）を読み込めませんでした（${res.error.code || res.error.message}）。ノートの追加・名前変更・削除はできません。`);
      this.rebuild();
      return this;
    }
    if (res.status !== 'missing') {
      try {
        fs.renameSync(this.file, `${this.file}.corrupt-${stamp(now)}`);
      } catch {
        // 退避できなくても一覧は保存ファイルから作り直せる
      }
      this.notice('warn', 'ノート一覧が壊れていたため、保存ファイルから作り直しました（ノート名は仮の名前になります）。');
    }
    // 初回（単一ファイル版からの移行を含む）や破損時は、フォルダ内の保存ファイルから一覧を作る
    this.rebuild();
    this.writeIndex();
    this.ensureFiles();
    return this;
  }

  // 一覧にあるノートは必ずファイルを持つようにする（空のノートも作り直しで見つかるように）
  ensureFiles() {
    for (const b of this.boards) {
      if (fs.existsSync(path.join(this.dir, b.file))) continue;
      try {
        this.save(b.id, emptyStore());
      } catch (err) {
        console.warn('[hex-memo] ノートのファイルを作れませんでした:', err);
      }
    }
  }

  applyIndex(value) {
    if (!value || typeof value !== 'object' || !Array.isArray(value.boards)) return false;
    const ids = new Set();
    const files = new Set();
    const boards = [];
    for (const b of value.boards) {
      if (!b || typeof b !== 'object') continue;
      const id = typeof b.id === 'string' && ID_RE.test(b.id) ? b.id : null;
      const file = typeof b.file === 'string' && BOARD_FILE_RE.test(b.file) ? b.file : null;
      if (!id || !file || ids.has(id) || files.has(file)) continue;
      ids.add(id);
      files.add(file);
      const board = { id, name: cleanName(b.name) || `ノート ${boards.length + 1}`, file };
      if (typeof b.parentId === 'string') board.parentId = b.parentId;
      if (typeof b.openId === 'string') board.openId = b.openId;
      boards.push(board);
    }
    if (!boards.length) return false;
    this.boards = boards;
    this.normalizeTree();
    this.activeId = ids.has(value.activeId) ? value.activeId : boards[0].id;
    return true;
  }

  // 親が無い・自分の子孫が親になっている（循環）・深すぎる、といった親の指定は外してタブにする。
  // openId はそのタブの中のノートだけを指せる
  normalizeTree() {
    const byId = new Map(this.boards.map((b) => [b.id, b]));
    for (const b of this.boards) {
      if (b.parentId !== undefined && (!byId.has(b.parentId) || b.parentId === b.id)) delete b.parentId;
    }
    for (const b of this.boards) {
      const seen = new Set([b.id]);
      let depth = 1;
      for (let p = b.parentId; p !== undefined; p = byId.get(p).parentId) {
        if (p === b.id || depth >= MAX_TREE_DEPTH) {
          delete b.parentId; // 自分に戻ってくる（循環）か、深すぎる
          break;
        }
        if (seen.has(p)) break; // 自分を含まない循環は、その中のノートを見るときに切る
        seen.add(p);
        depth++;
      }
    }
    for (const b of this.boards) {
      if (b.openId === undefined) continue;
      if (b.parentId !== undefined || !byId.has(b.openId) || this.rootOf(b.openId) !== b.id) delete b.openId;
    }
  }

  parentOf(id) {
    const b = this.boards.find((x) => x.id === id);
    return b && b.parentId !== undefined ? b.parentId : null;
  }

  // そのノートが入っているタブ（いちばん上のノート）の ID
  rootOf(id) {
    let cur = id;
    for (let p = this.parentOf(cur); p !== null; p = this.parentOf(cur)) cur = p;
    return cur;
  }

  depthOf(id) {
    let depth = 0;
    for (let p = this.parentOf(id); p !== null; p = this.parentOf(p)) depth++;
    return depth;
  }

  // そのノートと子孫（子ノート・孫ノート…）の ID。親より後ろの順で並ぶ
  subtreeIds(id) {
    const ids = [id];
    for (let i = 0; i < ids.length; i++) {
      for (const b of this.boards) if (b.parentId === ids[i]) ids.push(b.id);
    }
    return ids;
  }

  // 子孫の中でいちばん深い段（自分 = 0）
  subtreeHeight(id) {
    const base = this.depthOf(id);
    return Math.max(...this.subtreeIds(id).map((x) => this.depthOf(x) - base));
  }

  rebuild() {
    let names = [];
    try {
      names = fs.readdirSync(this.dir).filter((f) => BOARD_FILE_RE.test(f));
    } catch {
      names = [];
    }
    const created = (f) => {
      try {
        return fs.statSync(path.join(this.dir, f)).birthtimeMs;
      } catch {
        return 0;
      }
    };
    names.sort((a, b) => (a === DATA_FILE ? -1 : b === DATA_FILE ? 1 : created(a) - created(b)));
    if (!names.length) names = [DATA_FILE];

    const ids = new Set();
    this.boards = [];
    for (const file of names) {
      const id = file === DATA_FILE ? MAIN_ID : BOARD_FILE_RE.exec(file)[1];
      if (ids.has(id)) continue;
      ids.add(id);
      this.boards.push({ id, name: `ノート ${this.boards.length + 1}`, file });
    }
    this.activeId = this.boards[0].id;
  }

  writeIndex() {
    if (this.readOnly) throw new Error('ノート一覧を保存できない状態です');
    const data = {
      version: INDEX_VERSION,
      activeId: this.activeId,
      boards: this.boards.map(({ id, name, file, parentId, openId }) => ({ id, name, file, ...treeFields(parentId, openId) })),
    };
    writeFileAtomic(this.file, `${JSON.stringify(data, null, 2)}\n`);
  }

  list() {
    return {
      boards: this.boards.map(({ id, name, parentId, openId }) => ({ id, name, ...treeFields(parentId, openId) })),
      activeId: this.activeId,
      readOnly: this.readOnly,
    };
  }

  get(id) {
    const board = this.boards.find((b) => b.id === id);
    if (!board) throw new Error('ノートが見つかりません');
    return board;
  }

  store(id) {
    const board = this.get(id);
    let s = this.stores.get(id);
    if (!s) {
      s = new MemoStore(this.dir, board.file);
      s.load();
      this.stores.set(id, s);
    }
    return s;
  }

  save(id, data) {
    return this.store(id).save(data);
  }

  // メモの数（下の階層も数える）と、原点のメモ（ノートのハニカムでノートの説明・表紙として見せる）
  stats(id) {
    const { memos } = this.store(id).current;
    const o = memos['0,0'];
    let origin = null;
    if (o) {
      const text = typeof o.text === 'string' ? (o.text.split('\n').find((l) => l.trim()) || '').trim().slice(0, 80) : '';
      const cover = o.cover && Array.isArray(o.images) ? o.images.find((img) => img.id === o.cover) : null;
      origin = { text, ...(cover ? { cover: cover.thumb || cover.file } : {}) };
    }
    return { memoCount: countMemos(memos), origin };
  }

  nextName() {
    const used = new Set(this.boards.map((b) => b.name));
    let n = this.boards.length + 1;
    while (used.has(`ノート ${n}`)) n++;
    return `ノート ${n}`;
  }

  // parentId を指定すると、そのノートの子ノートとして（兄弟の最後に）作る
  create(name, parentId = null) {
    if (parentId !== null) {
      this.get(parentId);
      if (this.depthOf(parentId) + 1 >= MAX_TREE_DEPTH) throw new Error('これ以上深い子ノートは作れません');
    }
    let id;
    do {
      id = crypto.randomBytes(4).toString('hex'); // 16進なので "main" とは重ならない
    } while (this.boards.some((b) => b.id === id) || fs.existsSync(path.join(this.dir, `memos-${id}.json`)));
    const board = { id, name: cleanName(name) || this.nextName(), file: `memos-${id}.json` };
    if (parentId !== null) board.parentId = parentId;
    const before = this.snapshot();
    this.boards.push(board);
    this.setActive(id);
    try {
      this.writeIndex();
    } catch (err) {
      this.restore(before);
      throw err;
    }
    this.ensureFiles();
    return board;
  }

  rename(id, name) {
    const board = this.get(id);
    const clean = cleanName(name);
    if (!clean) throw new Error('ノート名が空です');
    const prev = board.name;
    board.name = clean;
    try {
      this.writeIndex();
    } catch (err) {
      board.name = prev;
      throw err;
    }
    return board;
  }

  // 表示中のノートを変え、そのタブで最後に開いたノートとして覚える
  setActive(id) {
    this.activeId = id;
    const root = this.boards.find((b) => b.id === this.rootOf(id));
    if (root.id === id) delete root.openId;
    else root.openId = id;
  }

  snapshot() {
    return { boards: this.boards.map((b) => ({ ...b })), activeId: this.activeId };
  }

  restore(snap) {
    this.boards = snap.boards;
    this.activeId = snap.activeId;
  }

  // 並べ替え・親の付け替え。parentId が null ならタブ（いちばん上）に。
  // beforeId の兄弟の直前へ入れる（null なら兄弟の最後へ）
  move(id, parentId = null, beforeId = null) {
    this.get(id);
    if (parentId !== null) {
      this.get(parentId);
      if (this.subtreeIds(id).includes(parentId)) throw new Error('自分の中（子ノート）へは移動できません');
      if (this.depthOf(parentId) + 1 + this.subtreeHeight(id) >= MAX_TREE_DEPTH) throw new Error('これ以上深くは移動できません');
    }
    if (beforeId !== null) {
      if (beforeId === id) return this.activeId;
      if (this.parentOf(beforeId) !== parentId) throw new Error('並べる位置が正しくありません');
    }
    const before = this.snapshot();
    const [board] = this.boards.splice(this.boards.findIndex((b) => b.id === id), 1);
    if (parentId === null) delete board.parentId;
    else board.parentId = parentId;
    const at = beforeId === null ? this.boards.length : this.boards.findIndex((b) => b.id === beforeId);
    this.boards.splice(at, 0, board);
    // タブが変わると「最後に開いたノート」も変わる
    for (const b of this.boards) {
      if (b.openId !== undefined && (b.parentId !== undefined || this.rootOf(b.openId) !== b.id)) delete b.openId;
    }
    this.setActive(this.activeId);
    try {
      this.writeIndex();
    } catch (err) {
      this.restore(before);
      throw err;
    }
    return this.activeId;
  }

  activate(id) {
    this.get(id);
    this.setActive(id);
    if (this.readOnly) return;
    try {
      this.writeIndex();
    } catch (err) {
      console.warn('[hex-memo] ノート一覧の保存に失敗しました:', err);
    }
  }

  // 一覧から外し（子ノートも一緒に）、保存ファイルは消さずに「.deleted-日時」を付けて残す
  remove(id, now = new Date()) {
    this.get(id);
    const ids = this.subtreeIds(id);
    if (ids.length >= this.boards.length) throw new Error('最後のノートは削除できません');
    const before = this.snapshot();
    // 表示中のノートが消えるときの移り先：親のノート。タブごと消すときは右隣（無ければ左隣）のタブ
    let next = this.activeId;
    if (ids.includes(this.activeId)) {
      const parent = this.parentOf(id);
      if (parent !== null) next = parent;
      else {
        const roots = this.boards.filter((b) => b.parentId === undefined);
        const i = roots.findIndex((b) => b.id === id);
        const neighbor = roots[i + 1] || roots[i - 1];
        next = neighbor.openId || neighbor.id;
      }
    }
    const removed = this.boards.filter((b) => ids.includes(b.id));
    this.boards = this.boards.filter((b) => !ids.includes(b.id));
    for (const b of this.boards) if (b.openId !== undefined && ids.includes(b.openId)) delete b.openId;
    this.setActive(next);
    try {
      this.writeIndex();
    } catch (err) {
      this.restore(before);
      throw err;
    }
    for (const board of removed) {
      this.stores.delete(board.id);
      const file = path.join(this.dir, board.file);
      try {
        if (fs.existsSync(file)) fs.renameSync(file, `${file}.deleted-${stamp(now)}`);
      } catch (err) {
        console.warn('[hex-memo] 削除したノートのファイルを退避できませんでした:', err);
      }
    }
    return this.activeId;
  }

  notice(level, message) {
    this.notices.push({ level, message });
  }

  takeNotices() {
    const list = this.notices;
    this.notices = [];
    return list;
  }
}

module.exports = { BoardManager, INDEX_FILE, MAIN_ID, MAX_TREE_DEPTH, cleanName };
