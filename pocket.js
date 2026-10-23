/* 区画（写しの作業台）：ノートごとの小さな六角の盤に、マス・コメント・ノートの顔の「写し」（紙片）を並べる。
 * 紙片は写しなので、元のメモを直しても紙片は変わらない（元の場所の印だけを持つ）。
 * 保存の形の整え（store.js）と、画面・2つのウィンドウの合わせ方（renderer.js）で共有する。
 * レンダラでは window.HexPocket、Node（本体・テスト）とブラウザ版のまとめ（node-modules.js）では module.exports として使う。
 * require は書かない（store.js → pocket.js → store.js の循環を避ける）。メモの整え（normalizeRecord）は引数で受ける。
 * 読み込んだ時点では crypto・structuredClone に触らない（ブラウザ版の試験の中には無いため。番号札を作るときにだけ見る）。
 *
 * 保存の形（ノートのファイルの省略できる項目 pockets。段階2〜5 では項目を増やさない）：
 *   pockets[] = { id, name, color?, createdAt, updatedAt, size?, layout?, slips, lines }
 *   slips[]   = { id, kind（'memo'｜'note'｜'comment'）, q, r, at（写した時刻）, rec（写しの中身）, origin?（元の場所の印）, placed?（段階2：置いた記録） }
 *   origin    = { board, memoId?, commentId?, keys?, key?, where?, parentLine?, fromShelf?, shelfKey? }
 *   placed[]  = { board, memoId, at }
 *   lines[]   = { a, b, createdAt, kind?, label? }（段階4：区画の中の線。本物の関連線 links とは別）
 * 段階3（紙片を直す）も項目は増やさない：本文を直すと rec.updatedAt を今にするので、「rec.updatedAt > at」が「直した紙片」の印になる。
 * 紙片に足したコメント（07）も項目は増やさない：「コメントを書いた時刻 > 写した時刻」で見分ける（rec.updatedAt は変えない） */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.HexPocket = api;
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  const MAX_POCKETS = 20;
  const MAX_SLIPS = 200; // 1つの区画の紙片
  const MAX_LINES = 2000;
  const MAX_PLACED = 50; // 1枚の紙片の「置いた記録」（超えたら古いものから落とす）
  const COLS = 2; // 盤の列数（紙片の座標は保存するので、サイドバーの幅では変えない。大きさだけ幅に合わせる）
  const KINDS = ['memo', 'note', 'comment'];
  const NAME_MAX = 40;
  const DEFAULT_NAME = '区画';
  const SIZES = ['read', 'small']; // 段階1では書かない（小／大の予約）
  const POCKET_ID_RE = /^p[0-9a-f]{12}$/;
  const SLIP_ID_RE = /^s[0-9a-f]{16}$/;
  const LINE_TEXT_MAX = 200; // 元の場所の言葉（where）・親のメモの1行目（parentLine）
  // store.js・boards.js と同じ決まり（require しないので写す。test/pocket.test.js で同じかを確かめる）
  const MEMO_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
  const BOARD_ID_RE = /^[a-z0-9]{1,32}$/;
  const STEP_RE = /^-?\d+,-?\d+(?:@\d+)?$/;
  const KEY_RE = /^\s*(-?\d+)\s*,\s*(-?\d+)\s*$/;
  const KIND_RE = /^[a-z0-9_-]{1,32}$/;
  const COLOR_RE = /^#[0-9a-f]{6}$/i;
  const LINK_LABEL_MAX = 40;
  const LAYOUT_COORD_MAX = 1e6;
  const MAX_DEPTH = 50;

  // ---- 番号札 ----
  // iPad を http で開くと crypto.randomUUID が無いので、getRandomValues を使う（それも無ければ Math.random）
  function randomHex(n) {
    const bytes = new Uint8Array(Math.ceil(n / 2));
    const c = typeof globalThis !== 'undefined' ? globalThis.crypto : null;
    if (c && typeof c.getRandomValues === 'function') c.getRandomValues(bytes);
    else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('').slice(0, n);
  }
  const newPocketId = () => `p${randomHex(12)}`;
  const newSlipId = () => `s${randomHex(16)}`;
  function newCommentId() {
    const h = randomHex(32).split('');
    h[12] = '4';
    h[16] = ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16);
    const s = h.join('');
    return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
  }

  // ---- 小物 ----
  function toIso(value, fallback) {
    if (typeof value === 'string' || typeof value === 'number') {
      const d = new Date(value);
      if (!Number.isNaN(d.getTime())) return d.toISOString();
    }
    return fallback;
  }
  function normalizeKey(key) {
    const m = KEY_RE.exec(String(key));
    if (!m) return null;
    const q = Number(m[1]);
    const r = Number(m[2]);
    if (!Number.isSafeInteger(q) || !Number.isSafeInteger(r)) return null;
    return `${q + 0},${r + 0}`;
  }
  const clone = (v) => JSON.parse(JSON.stringify(v)); // 紙片の中身は保存形式（素のオブジェクト）だけ
  const lineText = (v) => (typeof v === 'string' && v.trim() ? [...v].slice(0, LINE_TEXT_MAX).join('') : '');
  // 本文の最初の（空でない）1行
  function firstLine(text, max = LINE_TEXT_MAX) {
    if (typeof text !== 'string') return '';
    const line = text.split('\n').map((s) => s.trim()).find(Boolean) || '';
    return [...line].slice(0, max).join('');
  }
  const byTime = (k) => (a, b) => (a[k] < b[k] ? -1 : a[k] > b[k] ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

  // ---- 盤（縦長の帯）----
  // 上の行 j から順に、行の中は左→右（列 i）に詰める。六角の軸座標では q = i − floor(j / 2)、r = j
  //（奇数の行は半マス右にずれる。ノートのハニカムと同じ、角が上の六角形）
  const keyOf = (q, r) => `${q + 0},${r + 0}`;
  function cellAt(index, cols = COLS) {
    const j = Math.floor(index / cols);
    const i = index % cols;
    return { q: i - Math.floor(j / 2), r: j };
  }
  // 帯の中の何番目のセルか（帯の外・読めない座標なら -1）
  function bandIndex(q, r, cols = COLS) {
    if (!Number.isSafeInteger(q) || !Number.isSafeInteger(r) || r < 0) return -1;
    const i = q + Math.floor(r / 2);
    return i >= 0 && i < cols ? r * cols + i : -1;
  }
  // 上の行から左→右の順に、空いたセルを count 個（occupied はふさがっているセルの "q,r" の Set）
  function nextFreeCells(occupied, count, cols = COLS) {
    const out = [];
    for (let n = 0; out.length < count; n++) {
      const cell = cellAt(n, cols);
      if (!occupied.has(keyOf(cell.q, cell.r))) out.push(cell);
    }
    return out;
  }
  // 座標が読めない・帯の外・ほかの紙片と重なる紙片を、空いたセルへずらす。写した時刻の早い紙片が今のセルに残る。
  // 何も重なっていなければ、渡した配列をそのまま返す（並びは変えない。ずらした紙片だけ新しいオブジェクト）
  function settleSlips(slips, cols = COLS) {
    const order = slips.map((s, n) => ({ s, n })).sort((a, b) => byTime('at')(a.s, b.s) || a.n - b.n);
    const taken = new Set();
    const homeless = [];
    for (const { s, n } of order) {
      const key = keyOf(s.q, s.r);
      if (bandIndex(s.q, s.r, cols) >= 0 && !taken.has(key)) taken.add(key);
      else homeless.push(n);
    }
    if (!homeless.length) return slips;
    const out = slips.slice();
    const free = nextFreeCells(taken, homeless.length, cols);
    homeless.forEach((n, k) => {
      out[n] = { ...slips[n], q: free[k].q, r: free[k].r };
    });
    return out;
  }

  // 盤の左上を原点にした点（px）が、どのセルの上か（段階3のドラッグの落とし先）。cellW はセルの幅（px）。
  // セルの位置は画面の盤（renderer.js の buildHexBoard）と同じ式：中心 x = (q + r/2 + 0.5)·cellW、y = (0.75·r + 0.5)·cellH。
  // 帯の中で、行が 0〜maxRow+1（下に1段分の空き）のセルのうち、中心がいちばん近いもの。遠ければ（盤の外）null
  function cellAtPoint(x, y, cellW, cols = COLS, maxRow = 0) {
    if (!Number.isFinite(x) || !Number.isFinite(y) || !(cellW > 0)) return null;
    const cellH = (cellW * 2) / Math.sqrt(3);
    const rows = Math.max(0, Math.floor(maxRow)) + 2;
    let best = null;
    let bestDist = Infinity;
    for (let r = 0; r < rows; r++) {
      for (let i = 0; i < cols; i++) {
        const q = i - Math.floor(r / 2);
        const dx = x - (q + r / 2 + 0.5) * cellW;
        const dy = y - (0.75 * r + 0.5) * cellH;
        const d = Math.hypot(dx, dy);
        if (d < bestDist) {
          bestDist = d;
          best = { q, r };
        }
      }
    }
    return best && bestDist < cellW * 0.6 ? best : null; // 中心から角までは cellW/√3 ≒ 0.577·cellW（角の先まで、そのセル）
  }
  // 紙片を { q, r } へ：空いたセルなら移動、ほかの紙片があれば2枚を入れ替える（差し込みではない）。
  // 返す slips は新しい配列（動かした紙片だけ新しいオブジェクト。写した時刻・中身・直した時刻は変えない）。
  // kind：'move'｜'swap'｜'same'（今の場所）｜'invalid'（紙片が無い・帯の外）。same・invalid のときは渡した配列のまま
  function moveSlip(slips, id, to, cols = COLS) {
    const list = Array.isArray(slips) ? slips : [];
    const i = list.findIndex((s) => s && s.id === id);
    const q = to && to.q;
    const r = to && to.r;
    if (i < 0 || bandIndex(q, r, cols) < 0) return { kind: 'invalid', slips: list };
    const from = list[i];
    if (from.q === q && from.r === r) return { kind: 'same', slips: list };
    const j = list.findIndex((s, n) => n !== i && s && s.q === q && s.r === r);
    const out = list.slice();
    out[i] = { ...from, q, r };
    if (j < 0) return { kind: 'move', slips: out };
    out[j] = { ...list[j], q: from.q, r: from.r };
    return { kind: 'swap', slips: out };
  }

  // 1つの区画の紙片の上限：超えた分は、写した時刻の新しいものから落とす（並びは変えない）
  function capSlips(slips, max = MAX_SLIPS) {
    if (slips.length <= max) return slips;
    const keep = new Set(slips.slice().sort(byTime('at')).slice(0, max));
    return slips.filter((s) => keep.has(s));
  }

  // ---- 紙片の中身 ----
  // 写さないもの：番号札・長文の通し番号・周りに書いたメモ・期限・進み具合・いいね・ブックマーク（とその時刻）。
  // 外すだけ（何度通しても同じ。コメントの番号札には触らない）。紙片の種類で削るものは変えない
  const NOT_COPIED = ['id', 'seq', 'children', 'moreLayers', 'due', 'progress', 'likedAt', 'bookmarkedAt'];
  function stripForSlip(rec) {
    const out = { ...rec };
    for (const k of NOT_COPIED) delete out[k];
    out.likedLevel = 0;
    out.liked = false;
    out.bookmarked = false;
    if (!Array.isArray(out.comments)) out.comments = [];
    // 空の一覧は持たない（読み込みの整えのあとと同じ形にする。2つのウィンドウで「変わった」と取り違えないように）
    for (const k of ['images', 'urls', 'tags']) if (Array.isArray(out[k]) && !out[k].length) delete out[k];
    if ('cover' in out && !(Array.isArray(out.images) && out.images.some((img) => img && img.id === out.cover))) delete out.cover;
    return out;
  }
  // コメントの番号札を付け直す（返信の親子は保つ）。写すときだけ呼ぶ（読み込みの整えでは呼ばない）。
  // 番号札は、たたんだコメント・選んだコメントの覚え方に使われるので、元のメモと同じにしない
  function renewCommentIds(rec) {
    const map = new Map();
    const list = Array.isArray(rec.comments) ? rec.comments : [];
    // 1件ずつ新しい番号札（番号札の無いコメント・同じ番号札のコメントも別々に）。返信の親は、元の番号札の最初の1件へ
    const fresh = list.map((c) => {
      const id = newCommentId();
      if (c && c.id && !map.has(c.id)) map.set(c.id, id);
      return id;
    });
    rec.comments = list.map((c, i) => {
      const n = { ...c, id: fresh[i] };
      if (c.parentId && map.has(c.parentId)) n.parentId = map.get(c.parentId);
      else delete n.parentId;
      return n;
    });
    return rec;
  }
  // 中身が空（本文・タグ・コメント・画像・リンクのどれも無い）
  function isBlankSlip(rec) {
    if (!rec || typeof rec !== 'object') return true;
    const has = (k) => Array.isArray(rec[k]) && rec[k].length > 0;
    return !(typeof rec.text === 'string' && rec.text.trim()) && !has('tags') && !has('comments') && !has('images') && !has('urls');
  }
  // 写したあとに本文を直した紙片か（段階3）。保存の項目は増やさず、「直した時刻が写した時刻より新しい」で見分ける。
  // 写すときは元の時刻を残す（メモ・ノートは元の直した時刻、コメントは書いた時刻）ので、写した直後は false
  function slipEdited(slip) {
    if (!slip || !slip.rec) return false;
    const at = Date.parse(slip.at);
    const up = Date.parse(slip.rec.updatedAt);
    return Number.isFinite(at) && Number.isFinite(up) && up > at;
  }
  // 写したあとに紙片に書いたコメントか（07）。保存の項目は増やさず「コメントを書いた時刻が写した時刻より新しい」で見分ける
  //（写すときのコメントは元の時刻のまま。どちらかが読めなければ false）
  function slipCommentAdded(slip, c) {
    if (!slip || !c) return false;
    const at = Date.parse(slip.at);
    const t = Date.parse(c.createdAt);
    return Number.isFinite(at) && Number.isFinite(t) && t > at;
  }
  // 写したあとに書いたコメントの数（外すときの確認に使う）
  function slipAddedComments(slip) {
    const list = slip && slip.rec && Array.isArray(slip.rec.comments) ? slip.rec.comments : [];
    return list.filter((c) => slipCommentAdded(slip, c)).length;
  }
  const emptyBody = (text, createdAt, updatedAt) => ({ text, createdAt, updatedAt, likedLevel: 0, liked: false, bookmarked: false, comments: [] });

  // ---- 写す（q, r は持たない。置く場所は呼ぶ側が nextFreeCells で決める）----
  // rec は保存形式のメモ（画面では serializeRecord を通したもの）。元の作った・直した時刻はそのまま残す
  function slipFromMemo(rec, origin, now) {
    const body = renewCommentIds(stripForSlip(clone(rec)));
    if (isBlankSlip(body)) return null;
    const o = normalizeOrigin(origin, 'memo');
    return { id: newSlipId(), kind: 'memo', at: now, rec: body, ...(o ? { origin: o } : {}) };
  }
  // コメント1件の紙片。親のメモの1行目を文字で持つ（元が消えても読める）
  function slipFromComment(comment, parentRec, origin, now) {
    if (!comment || typeof comment.text !== 'string') return null;
    const t = toIso(comment.createdAt, now);
    const body = emptyBody(comment.text, t, t);
    if (isBlankSlip(body)) return null;
    const o = normalizeOrigin({
      ...(origin || {}),
      ...(typeof comment.id === 'string' && comment.id ? { commentId: comment.id } : {}),
      parentLine: firstLine(parentRec && parentRec.text),
    }, 'comment');
    return { id: newSlipId(), kind: 'comment', at: now, rec: body, ...(o ? { origin: o } : {}) };
  }
  // ノートの顔：本文＝ノート名＋改行＋原点のメモの1行目。表紙があれば画像として持つ。元の印はノートだけ
  function slipFromBoard({ name, originRec, board } = {}, now) {
    const title = typeof name === 'string' && name.trim() ? name.trim() : 'ノート';
    const line = firstLine(originRec && originRec.text);
    const createdAt = toIso(originRec && originRec.createdAt, now);
    const body = emptyBody(line ? `${title}\n${line}` : title, createdAt, toIso(originRec && originRec.updatedAt, createdAt));
    const imgs = originRec && Array.isArray(originRec.images) ? originRec.images : [];
    const cover = originRec && originRec.cover ? imgs.find((img) => img && img.id === originRec.cover) : null;
    if (cover) {
      body.images = [clone(cover)];
      body.cover = cover.id;
    }
    const o = normalizeOrigin({ board }, 'note');
    return { id: newSlipId(), kind: 'note', at: now, rec: body, ...(o ? { origin: o } : {}) };
  }

  // ---- 読み込みの整え ----
  // 元の場所の印。番号札は形だけ確かめ、今あるかどうかでは絞らない（元がゴミ箱にある間に読み込んでも消えないように）
  function normalizeOrigin(raw, kind) {
    if (!raw || typeof raw !== 'object' || typeof raw.board !== 'string' || !BOARD_ID_RE.test(raw.board)) return null;
    const o = { board: raw.board };
    if (kind === 'note') return o; // ノートの紙片はノートだけ（原点のメモの番号札は持たない）
    if (typeof raw.memoId === 'string' && MEMO_ID_RE.test(raw.memoId)) o.memoId = raw.memoId;
    if (typeof raw.commentId === 'string' && raw.commentId && raw.commentId.length <= LINE_TEXT_MAX) o.commentId = raw.commentId;
    if (Array.isArray(raw.keys)) {
      const keys = raw.keys.filter((k) => typeof k === 'string' && STEP_RE.test(k)).slice(0, MAX_DEPTH);
      if (keys.length) o.keys = keys;
    }
    const key = normalizeKey(raw.key);
    if (key) o.key = key;
    const where = lineText(raw.where);
    if (where) o.where = where;
    const parentLine = lineText(raw.parentLine);
    if (parentLine) o.parentLine = parentLine;
    if (raw.fromShelf === true) o.fromShelf = true;
    // 棚の項目の番号札（03 の見分け：ID か「作った時刻＋本文」）。本文をまるごと含むので、長さで切らない（切ると一致しない）
    if (typeof raw.shelfKey === 'string' && raw.shelfKey) o.shelfKey = raw.shelfKey;
    return o;
  }
  // 置いた記録（段階2）：メモの番号札ごとに1件（新しい時刻を残す）。古いものから落として 50 件まで。
  // 2つのウィンドウの合わせ方でも使う（いくつかの一覧をまとめて渡すと和になる）
  function mergePlaced(...lists) {
    const byId = new Map();
    for (const list of lists) {
      for (const p of Array.isArray(list) ? list : []) {
        if (!p || typeof p !== 'object') continue;
        if (typeof p.board !== 'string' || !BOARD_ID_RE.test(p.board) || typeof p.memoId !== 'string' || !MEMO_ID_RE.test(p.memoId)) continue;
        const at = toIso(p.at, null);
        if (!at) continue;
        const prev = byId.get(p.memoId);
        if (!prev || at > prev.at) byId.set(p.memoId, { board: p.board, memoId: p.memoId, at });
      }
    }
    return [...byId.values()].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.memoId < b.memoId ? -1 : 1)).slice(-MAX_PLACED);
  }
  function normalizeSlip(raw, now, normalizeRecord) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !KINDS.includes(raw.kind)) return null;
    let src = raw.rec;
    if (src && typeof src === 'object' && !Array.isArray(src)) {
      src = { ...src };
      delete src.children; // 周りのメモは写さないので、整える前に外す（深い階層を丸ごと整えないように）
      delete src.moreLayers;
    }
    const norm = normalizeRecord(src, now);
    if (!norm) return null;
    const rec = stripForSlip(norm);
    if (isBlankSlip(rec)) return null;
    const slip = {
      id: typeof raw.id === 'string' && SLIP_ID_RE.test(raw.id) ? raw.id : newSlipId(),
      kind: raw.kind,
      q: Number.isSafeInteger(raw.q) ? raw.q : null, // 読めない座標は settleSlips が空いたセルへ
      r: Number.isSafeInteger(raw.r) ? raw.r : null,
      at: toIso(raw.at, now),
      rec,
    };
    const origin = normalizeOrigin(raw.origin, raw.kind);
    if (origin) slip.origin = origin;
    // 時刻が読めない記録は、捨てずに今の時刻にする
    const placed = mergePlaced(Array.isArray(raw.placed) ? raw.placed.map((p) => (p && typeof p === 'object' ? { ...p, at: toIso(p.at, now) } : p)) : []);
    if (placed.length) slip.placed = placed;
    return slip;
  }
  function normalizeLines(list, slipIds, now) {
    const out = [];
    const seen = new Set();
    for (const l of Array.isArray(list) ? list : []) {
      if (out.length >= MAX_LINES) break;
      if (!l || typeof l !== 'object' || typeof l.a !== 'string' || typeof l.b !== 'string' || l.a === l.b) continue;
      if (!slipIds.has(l.a) || !slipIds.has(l.b)) continue;
      const pair = l.a < l.b ? `${l.a}|${l.b}` : `${l.b}|${l.a}`;
      if (seen.has(pair)) continue;
      seen.add(pair);
      const line = { a: l.a, b: l.b, createdAt: toIso(l.createdAt, now) };
      if (typeof l.kind === 'string' && KIND_RE.test(l.kind)) line.kind = l.kind;
      const label = typeof l.label === 'string' ? [...l.label.replace(/\s+/g, ' ').trim()].slice(0, LINK_LABEL_MAX).join('').trim() : '';
      if (label) line.label = label;
      out.push(line);
    }
    return out;
  }
  // 段階5のグラフの並びの予約：{ 紙片の番号札: { x, y } }。その区画にある紙片だけ
  function normalizeLayout(raw, slipIds) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const out = {};
    let n = 0;
    for (const [id, v] of Object.entries(raw)) {
      if (!slipIds.has(id) || !v || typeof v !== 'object') continue;
      const x = Number(v.x);
      const y = Number(v.y);
      if (v.x === null || v.y === null || !Number.isFinite(x) || !Number.isFinite(y)) continue;
      const clamp = (c) => Math.round(Math.max(-LAYOUT_COORD_MAX, Math.min(LAYOUT_COORD_MAX, c)));
      out[id] = { x: clamp(x), y: clamp(y) };
      n++;
    }
    return n ? out : null;
  }
  const normalizeName = (v) => (typeof v === 'string' ? [...v.replace(/\s+/g, ' ').trim()].slice(0, NAME_MAX).join('').trim() : '') || DEFAULT_NAME;
  const normalizeColor = (v) => (typeof v === 'string' && COLOR_RE.test(v.trim()) ? v.trim().toLowerCase() : null);
  // 名前・色が既定の区画（両方のウィンドウが同時に作った「最初の区画」をまとめてよいもの）
  const isPlainPocket = (p) => !!p && (p.name || DEFAULT_NAME) === DEFAULT_NAME && !p.color && !p.size;
  // 保存しない区画：紙片も線も無く、名前・色が既定（区画は最初に写したときに作る。空のまま残さない）
  const isBlankPocket = (p) => !p || (!(p.slips && p.slips.length) && !(p.lines && p.lines.length) && (p.name || DEFAULT_NAME) === DEFAULT_NAME && !p.color);
  const newPocket = (now) => ({ id: newPocketId(), name: DEFAULT_NAME, createdAt: now, updatedAt: now, slips: [], lines: [] });

  // 区画の一覧の整え（読み込み・保存のたび。2回通しても同じ）。normalizeRecord は store.js のもの
  function normalizePockets(list, now, { normalizeRecord } = {}) {
    if (!Array.isArray(list) || typeof normalizeRecord !== 'function') return [];
    const out = [];
    const pocketIds = new Set();
    const slipIds = new Set(); // 紙片の番号札はノートの中で重ねない
    for (const raw of list) {
      if (out.length >= MAX_POCKETS) break;
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
      let id = typeof raw.id === 'string' && POCKET_ID_RE.test(raw.id) ? raw.id : '';
      while (!id || pocketIds.has(id)) id = newPocketId();
      pocketIds.add(id);
      let slips = [];
      for (const s of Array.isArray(raw.slips) ? raw.slips : []) {
        const slip = normalizeSlip(s, now, normalizeRecord);
        if (!slip) continue;
        while (slipIds.has(slip.id)) slip.id = newSlipId();
        slipIds.add(slip.id);
        slips.push(slip);
      }
      slips = settleSlips(capSlips(slips));
      const ids = new Set(slips.map((s) => s.id));
      const lines = normalizeLines(raw.lines, ids, now);
      const name = normalizeName(raw.name);
      const color = normalizeColor(raw.color);
      const pocket = { id, name };
      if (color) pocket.color = color;
      if (isBlankPocket({ name, color, slips, lines })) continue;
      pocket.createdAt = toIso(raw.createdAt, toIso(raw.updatedAt, now));
      pocket.updatedAt = toIso(raw.updatedAt, pocket.createdAt);
      if (SIZES.includes(raw.size)) pocket.size = raw.size;
      const layout = normalizeLayout(raw.layout, ids);
      if (layout) pocket.layout = layout;
      pocket.slips = slips;
      pocket.lines = lines;
      out.push(pocket);
    }
    return out.sort(byTime('createdAt'));
  }

  // ---- 段階2：写しの表・元の状態・写しを置く ----

  // 写しの表：メモの番号札 → [{ pocketId, slipId }]。ノートの区画すべてから作る（サイドバーに出している区画には頼らない）。
  // 数えるのは「このメモから写した紙片」（元の場所の印。コメントの紙片は親のメモ）と「この紙片からこのメモへ置いた写し」（置いた記録）。
  // 同じ紙片は1つのメモに1回だけ。ノートの紙片は元のメモの番号札を持たないので入らない。ほかのノートの印・記録は除く
  function buildCopyIndex(pockets, boardId) {
    const index = new Map();
    for (const p of Array.isArray(pockets) ? pockets : []) {
      for (const s of p && Array.isArray(p.slips) ? p.slips : []) {
        if (!s) continue;
        const ids = new Set();
        const o = s.origin;
        if (s.kind !== 'note' && o && o.board === boardId && o.memoId) ids.add(o.memoId);
        for (const pl of Array.isArray(s.placed) ? s.placed : []) if (pl && pl.board === boardId && pl.memoId) ids.add(pl.memoId);
        for (const id of ids) {
          if (!index.has(id)) index.set(id, []);
          index.get(id).push({ pocketId: p.id, slipId: s.id });
        }
      }
    }
    return index;
  }

  // この紙片からハニカムに置いた写しのうち、今このノートのハニカムにあるもの（新しい順）。記録そのものは消さない（戻せば数に戻る）
  function livePlaced(slip, { boardId, liveIds } = {}) {
    const list = slip && Array.isArray(slip.placed) ? slip.placed : [];
    return list.filter((pl) => pl && pl.board === boardId && liveIds && liveIds.has(pl.memoId)).reverse();
  }
  const placedCount = (slip, ctx) => livePlaced(slip, ctx).length;

  // 紙片をハニカムに置くときのメモ：紙片の中身（本文・タグ・コメント・画像・リンク）の写し。番号札は付けない（置く側で新しく）、
  // いいね・期限・下の階層などは持たない。コメントの番号札は付け直す（返信の親子は保つ）。作った・直した時刻は置いた時刻
  function recordForPlacing(slip, now) {
    const rec = renewCommentIds(stripForSlip(clone((slip && slip.rec) || { text: '' })));
    rec.createdAt = now;
    rec.updatedAt = now;
    return rec;
  }

  // 保存形式のメモ（周りのメモも中に）の番号札を集める（ゴミ箱の記録・ほかのノートの中身を見るとき）
  function collectStoredIds(rec, ids = new Set()) {
    if (!rec || typeof rec !== 'object') return ids;
    if (typeof rec.id === 'string' && rec.id) ids.add(rec.id);
    const layers = [rec.children, ...(Array.isArray(rec.moreLayers) ? rec.moreLayers : [])];
    for (const layer of layers) {
      const memos = layer && layer.memos && typeof layer.memos === 'object' ? layer.memos : null;
      if (memos) for (const child of Object.values(memos)) collectStoredIds(child, ids);
    }
    return ids;
  }

  // ほかのノートの保存形式の中身（覗いたもの）で、番号札のメモを探す：ハニカム（下の階層・重ねた層も）→ 棚（項目の中も）→ ゴミ箱。
  // 見つかれば { where: 'hive' | 'shelf' | 'trash' }、無ければ null（切り替えたあとの場所は、画面の側で番号札から引き直す）
  function findMemoInStore(store, memoId) {
    if (!store || typeof store !== 'object' || typeof memoId !== 'string' || !memoId) return null;
    const memos = store.memos && typeof store.memos === 'object' ? store.memos : {};
    for (const rec of Object.values(memos)) if (collectStoredIds(rec).has(memoId)) return { where: 'hive' };
    for (const rec of Array.isArray(store.shelf) ? store.shelf : []) if (collectStoredIds(rec).has(memoId)) return { where: 'shelf' };
    for (const t of Array.isArray(store.trash) ? store.trash : []) if (t && t.rec && collectStoredIds(t.rec).has(memoId)) return { where: 'trash' };
    return null;
  }

  // 紙片の元が今どこにあるか（区画を描くたび。ctx はノート全体を1回だけ集めたもの）。
  // ctx：{ boardId（今のノート）, liveIds（ハニカムのメモ）, shelfIds（棚のメモ。項目の中も）, shelfKeys（棚の項目の番号札）,
  //        trashIds（ゴミ箱の記録の中のメモ）, trashShelfKeys（棚から削除した記録の番号札）, boardIds（あるノート） }
  // state：'ok'（ハニカム）｜'shelf'（棚）｜'trash'（ゴミ箱）｜'missing'（見つからない）｜'other'（ほかのノート。描くときは見ない）｜
  //        'note'（ノートの紙片で、そのノートがある）｜'note-missing'。label は灰色のときの理由の文
  function originState(slip, ctx = {}) {
    const o = slip && slip.origin;
    const has = (set, v) => !!v && !!set && set.has(v);
    const where = (o && o.where) || '記録なし';
    const result = (state, label = '') => ({ state, label });
    // ノートの紙片は元のメモを持たず、ふつう今開いていないノートから作るので、先に判定する
    if (slip && slip.kind === 'note') return o && has(ctx.boardIds, o.board) ? result('note') : result('note-missing', '元のノートは見つかりません');
    if (!o) return result('missing', '元の場所は記録されていません');
    if (o.board !== ctx.boardId) return has(ctx.boardIds, o.board) ? result('other') : result('missing', '元のノートは見つかりません');
    const inTrash = '元のメモはゴミ箱にあります（左上メニューの「ゴミ箱（削除したメモ）」から戻せます）';
    const gone = `元のメモは見つかりません（場所：${where}）`;
    if (o.fromShelf) {
      // 棚の項目のコメントの紙片：棚の項目の番号札（03 の見分け）か番号札で
      if (has(ctx.shelfKeys, o.shelfKey) || has(ctx.shelfIds, o.memoId)) return result('shelf');
      if (has(ctx.trashShelfKeys, o.shelfKey) || has(ctx.trashIds, o.memoId)) return result('trash', inTrash);
      if (has(ctx.liveIds, o.memoId)) return result('ok'); // 番号札つきでハニカムに置かれた
      return result('missing', gone);
    }
    if (has(ctx.shelfIds, o.memoId)) return result('shelf'); // 棚へ移した（棚が先）
    if (has(ctx.liveIds, o.memoId)) return result('ok');
    if (has(ctx.trashIds, o.memoId)) return result('trash', inTrash);
    return result('missing', gone);
  }

  // 絞り込み：本文・コメント・タグ（と、ノート・コメントの紙片の元の言葉）を1つの文字列に（小文字・全角半角をそろえる）
  const fold = (s) => String(s || '').normalize('NFKC').toLowerCase();
  function slipHaystack(slip) {
    const rec = (slip && slip.rec) || {};
    const parts = [rec.text];
    for (const c of Array.isArray(rec.comments) ? rec.comments : []) parts.push(c && c.text);
    for (const t of Array.isArray(rec.tags) ? rec.tags : []) parts.push(t, `#${t}`);
    if (slip && slip.origin && slip.origin.parentLine) parts.push(slip.origin.parentLine);
    return fold(parts.filter((x) => typeof x === 'string').join('\n'));
  }
  // 空白で区切った言葉をすべて含むか（空なら常に true）
  function slipMatches(slip, query) {
    const words = fold(query).split(/\s+/).filter(Boolean);
    if (!words.length) return true;
    const hay = slipHaystack(slip);
    return words.every((w) => hay.includes(w));
  }

  return {
    MAX_POCKETS,
    MAX_SLIPS,
    MAX_LINES,
    MAX_PLACED,
    COLS,
    KINDS,
    NAME_MAX,
    DEFAULT_NAME,
    SIZES,
    POCKET_ID_RE,
    SLIP_ID_RE,
    MEMO_ID_RE,
    BOARD_ID_RE,
    STEP_RE,
    KIND_RE,
    COLOR_RE,
    LINK_LABEL_MAX,
    LAYOUT_COORD_MAX,
    MAX_DEPTH,
    newPocketId,
    newSlipId,
    newCommentId,
    newPocket,
    keyOf,
    cellAt,
    bandIndex,
    nextFreeCells,
    settleSlips,
    capSlips,
    stripForSlip,
    renewCommentIds,
    isBlankSlip,
    slipEdited,
    slipCommentAdded,
    slipAddedComments,
    cellAtPoint,
    moveSlip,
    normalizeName,
    normalizeColor,
    firstLine,
    slipFromMemo,
    slipFromComment,
    slipFromBoard,
    normalizeOrigin,
    mergePlaced,
    normalizePockets,
    isPlainPocket,
    isBlankPocket,
    slipHaystack,
    slipMatches,
    buildCopyIndex,
    livePlaced,
    placedCount,
    recordForPlacing,
    collectStoredIds,
    findMemoInStore,
    originState,
  };
});
