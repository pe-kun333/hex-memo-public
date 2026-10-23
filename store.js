'use strict';

/* 永続化：memos.json の読み込み・正規化・旧形式からの移行・安全な書き込み。
 * Electron に依存しないので Node 単体でテストできる。 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { isWebUrl, MAX_URL } = require('./urls');
const HP = require('./pocket'); // 区画（写しの作業台）の整え（画面と共有する）

const STORE_VERSION = 2;
const DATA_FILE = 'memos.json';
const MAX_LIKE = 3;
const MAX_DEPTH = 50; // 「周りに書く」階層の深さの上限（壊れたデータで再帰し続けないため）
const MAX_LAYERS = 20;
const SEQ_ID_RE = /^[a-z0-9]{1,16}$/; // 1つのメモの周りに重ねられる層の数（第1層を含む）
const LAYER_NAME_MAX = 20;
const KEY_RE = /^\s*(-?\d+)\s*,\s*(-?\d+)\s*$/;
// タグ（ハッシュタグ）：1つのメモに付けられる数と、1つのタグの長さ
const MAX_TAGS = 20;
const TAG_MAX = 30;
// 関連付けの種類（settings.json に登録した種類の ID）とラベル
const KIND_RE = /^[a-z0-9_-]{1,32}$/;
const LINK_LABEL_MAX = 40;
// 領域（名前を付けたマスの集まり）
const REGION_ID_RE = /^[a-z0-9]{1,32}$/;
const REGION_NAME_MAX = 40;
const MAX_REGIONS = 200;
const MAX_REGION_KEYS = 5000;
const COLOR_RE = /^#[0-9a-f]{6}$/i;
// 期限（YYYY-MM-DD）と進み具合（六角形の辺の数 0〜6。6 で完了）
const DUE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_PROGRESS = 6;
// Dendritic Extension（名前を付けた順路。枝分かれできる）
const DEND_ID_RE = /^[a-z0-9]{1,32}$/;
const DEND_NAME_MAX = 40;
const MAX_DENDRITES = 200;
const MAX_STEPS = 2000;
// 未配置の棚（まだ場所を決めていないメモ）
const MAX_SHELF = 500;
// ゴミ箱：削除したメモ（周りに書いたメモ・関連付けも一緒に）。30 日たったもの・500 件を超えたものは捨てる
const MAX_TRASH = 500;
const TRASH_DAYS = 30;
const TRASH_ID_RE = /^[A-Za-z0-9_-]{6,40}$/;
const STEP_RE = /^-?\d+,-?\d+(?:@\d+)?$/;
// 関連グラフの並び（名前を付けて保存した、メモの ID ごとの位置）
const MAX_GRAPH_LAYOUTS = 50;
const MAX_LAYOUT_NODES = 3000;
const LAYOUT_ID_RE = /^[A-Za-z0-9_-]{4,40}$/;
const LAYOUT_NAME_MAX = 40;
const LAYOUT_COORD_MAX = 1e6;
// 配置ヒント（AI などが書いた、メモの大まかな置き場所。省略可・ノート直下だけ）
const HINT_ZONES = new Set(['center', 'left', 'right', 'top', 'bottom', 'top-left', 'top-right', 'bottom-left', 'bottom-right', 'outer']);
const HINT_GROUP_RE = /^[a-z0-9_-]{1,32}$/;
const HINT_SOURCE_RE = /^[a-z0-9_-]{1,16}$/;
const MAX_HINT_NODES = 3000;
// 足あと（マスごとの訪れた回数）と日ごとの活動
const MAX_FOOTPRINTS = 5000;
const MAX_ACTIVITY_DAYS = 3000;

function emptyStore() {
  return { version: STORE_VERSION, camera: { x: 0, y: 0 }, memos: {} };
}

function toIso(value, fallback) {
  if (typeof value === 'string' || typeof value === 'number') {
    const d = new Date(value);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  return fallback;
}

function finiteOr(value, fallback) {
  const n = Number(value);
  return value !== null && value !== '' && Number.isFinite(n) ? n : fallback;
}

// "q,r" を正規形（空白なし・先頭ゼロなし・-0 なし）にする。読めなければ null。
function normalizeKey(key) {
  const m = KEY_RE.exec(String(key));
  if (!m) return null;
  const q = Number(m[1]);
  const r = Number(m[2]);
  if (!Number.isSafeInteger(q) || !Number.isSafeInteger(r)) return null;
  return `${q + 0},${r + 0}`;
}

function normalizeText(value) {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return '';
}

function normalizeLikedLevel(raw) {
  const clamp = (n) => Math.min(MAX_LIKE, Math.max(0, Math.round(n)));
  if (raw.likedLevel !== undefined && raw.likedLevel !== null) {
    const n = Number(raw.likedLevel);
    if (Number.isFinite(n)) return clamp(n);
  }
  if (raw.liked === true) return 1; // v1: liked は真偽値のみ
  if (typeof raw.liked === 'number' && Number.isFinite(raw.liked)) return clamp(raw.liked);
  return 0;
}

// コメント。parentId があれば、同じメモの別のコメントへの返信（ツリー）。相手が無い・自分自身・輪になるものは返信扱いにしない
function normalizeComments(list, now) {
  if (!Array.isArray(list)) return [];
  const out = [];
  const ids = new Set();
  for (const c of list) {
    const isObj = c !== null && typeof c === 'object';
    const text = typeof c === 'string' ? c : isObj ? normalizeText(c.text) : '';
    if (!text.trim()) continue;
    let id = isObj && typeof c.id === 'string' && c.id ? c.id : crypto.randomUUID();
    if (ids.has(id)) id = crypto.randomUUID();
    ids.add(id);
    const item = { id, text, createdAt: toIso(isObj ? c.createdAt : undefined, now) };
    if (isObj && typeof c.parentId === 'string' && c.parentId && c.parentId !== id) item.parentId = c.parentId;
    out.push(item);
  }
  const byId = new Map(out.map((c) => [c.id, c]));
  for (const c of out) {
    if (!c.parentId) continue;
    if (!byId.has(c.parentId)) {
      delete c.parentId;
      continue;
    }
    // 親をたどって自分に戻ってきたら（輪）、返信扱いをやめる
    let p = byId.get(c.parentId);
    let n = 0;
    while (p && p.parentId && n++ <= out.length) {
      if (p.parentId === c.id) {
        delete c.parentId;
        break;
      }
      p = byId.get(p.parentId);
    }
  }
  return out;
}

// タグ：先頭の # と空白を除き、長すぎれば切る。読めなければ ''
function normalizeTag(value) {
  if (typeof value !== 'string') return '';
  const s = value.replace(/^[#＃\s]+/, '').replace(/[\s#＃]+/g, '').trim();
  return [...s].slice(0, TAG_MAX).join('');
}

function normalizeTags(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const v of list) {
    const t = normalizeTag(v);
    if (t && !out.includes(t)) out.push(t);
    if (out.length >= MAX_TAGS) break;
  }
  return out;
}

function normalizeColor(value) {
  return typeof value === 'string' && COLOR_RE.test(value.trim()) ? value.trim().toLowerCase() : null;
}

// 領域：名前を付けたマスの集まり（その階層のキーの一覧）。マスが空でも場所として残す
function normalizeRegions(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  const ids = new Set();
  for (const r of list) {
    if (out.length >= MAX_REGIONS) break;
    if (!r || typeof r !== 'object') continue;
    const name = typeof r.name === 'string' ? [...r.name.replace(/\s+/g, ' ').trim()].slice(0, REGION_NAME_MAX).join('').trim() : '';
    const keys = [];
    const seen = new Set();
    for (const k of Array.isArray(r.keys) ? r.keys : []) {
      const key = normalizeKey(k);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      keys.push(key);
      if (keys.length >= MAX_REGION_KEYS) break;
    }
    if (!name || !keys.length) continue;
    let id = typeof r.id === 'string' && REGION_ID_RE.test(r.id) ? r.id : crypto.randomBytes(4).toString('hex');
    if (ids.has(id)) id = crypto.randomBytes(4).toString('hex');
    ids.add(id);
    const region = { id, name, keys };
    const color = normalizeColor(r.color);
    if (color) region.color = color;
    out.push(region);
  }
  return out;
}

// 表示倍率（zoom）は 1 以外のときだけ持つ
const MIN_ZOOM = 0.04;
const MAX_ZOOM = 1.5;

function normalizeCamera(cam) {
  const c = cam && typeof cam === 'object' ? cam : {};
  const out = { x: finiteOr(c.x, 0), y: finiteOr(c.y, 0) };
  const z = finiteOr(c.zoom, 1);
  if (z !== 1) out.zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));
  return out;
}

// メモの ID（関連付けに使う。関連付けたときに初めて付く）
const MEMO_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

// ---- 添付（画像・リンク） ----
// 添付ファイルは attachments/ に中身の SHA-256 の名前で置く。記録にはファイル名だけを書く
const ATT_RE = /^[0-9a-f]{64}(.thumb)?.(png|jpg|gif|webp|ico|pdf)$/;
const MAX_IMAGES = 200;
const MAX_URLS = 200;
const LINK_STATUS = new Set(['ok', 'broken', 'error']);

const strOf = (v, max) => (typeof v === 'string' ? [...v.trim()].slice(0, max).join('') : '');
const intOf = (v, max) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 && n <= max ? n : null;
};
const attOf = (v, { thumb = false, exts = ['png', 'jpg', 'gif', 'webp'] } = {}) => {
  const m = typeof v === 'string' ? ATT_RE.exec(v) : null;
  return m && !!m[1] === thumb && exts.includes(m[2]) ? v : null;
};

function uniqueId(raw, ids) {
  let id = typeof raw === 'string' && MEMO_ID_RE.test(raw) ? raw : crypto.randomUUID();
  if (ids.has(id)) id = crypto.randomUUID();
  ids.add(id);
  return id;
}

function normalizeImages(list, now) {
  if (!Array.isArray(list)) return [];
  const ids = new Set();
  const out = [];
  for (const x of list) {
    if (out.length >= MAX_IMAGES) break;
    const file = x && typeof x === 'object' ? attOf(x.file) : null;
    if (!file) continue;
    const img = { id: uniqueId(x.id, ids), file };
    const thumb = attOf(x.thumb, { thumb: true });
    if (thumb) img.thumb = thumb;
    const name = strOf(x.name, 200);
    if (name) img.name = name;
    const width = intOf(x.width, 100000);
    const height = intOf(x.height, 100000);
    if (width && height) {
      img.width = width;
      img.height = height;
    }
    const size = intOf(x.size, 2 ** 40);
    if (size) img.size = size;
    const caption = strOf(x.caption, 1000);
    if (caption) img.caption = caption;
    img.addedAt = toIso(x.addedAt, now);
    out.push(img);
  }
  return out;
}

function normalizeUrls(list, now) {
  if (!Array.isArray(list)) return [];
  const ids = new Set();
  const out = [];
  for (const x of list) {
    if (out.length >= MAX_URLS) break;
    const url = x && typeof x === 'object' && typeof x.url === 'string' ? x.url.trim() : '';
    if (!url || url.length > MAX_URL || !isWebUrl(url)) continue;
    const link = { id: uniqueId(x.id, ids), url };
    for (const [key, max] of [['title', 300], ['description', 1000], ['siteName', 120]]) {
      const v = strOf(x[key], max);
      if (v) link[key] = v;
    }
    const favicon = attOf(x.favicon, { exts: ['png', 'jpg', 'gif', 'webp', 'ico'] });
    if (favicon) link.favicon = favicon;
    const image = attOf(x.image);
    if (image) link.image = image;
    link.addedAt = toIso(x.addedAt, now);
    const fetchedAt = toIso(x.fetchedAt, null);
    if (fetchedAt) link.fetchedAt = fetchedAt;
    if (LINK_STATUS.has(x.status)) {
      link.status = x.status;
      const code = intOf(x.statusCode, 999);
      if (code) link.statusCode = code;
      const checkedAt = toIso(x.checkedAt, null);
      if (checkedAt) link.checkedAt = checkedAt;
    }
    const snap = x.snapshot && typeof x.snapshot === 'object' ? x.snapshot : null;
    const snapFile = snap ? attOf(snap.file, { exts: ['pdf'] }) : null;
    if (snapFile) {
      link.snapshot = { file: snapFile, savedAt: toIso(snap.savedAt, now) };
      const t = strOf(snap.title, 300);
      if (t) link.snapshot.title = t;
    }
    out.push(link);
  }
  return out;
}

function normalizeRecord(raw, now, depth = 0, dropped = [], keepIds = null) {
  if (typeof raw === 'string') raw = { text: raw }; // v0: 本文だけの形式
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const text = normalizeText(raw.text ?? raw.body ?? raw.content);
  const createdAt = toIso(raw.createdAt, toIso(raw.updatedAt, now));
  const updatedAt = toIso(raw.updatedAt, createdAt);
  const likedLevel = normalizeLikedLevel(raw);
  const rec = {
    text,
    createdAt,
    updatedAt,
    likedLevel,
    liked: likedLevel > 0, // 互換用
    bookmarked: raw.bookmarked === true,
    comments: normalizeComments(raw.comments, now),
  };
  if (typeof raw.id === 'string' && MEMO_ID_RE.test(raw.id)) rec.id = raw.id;
  // いいね・ブックマークした時刻（サイドバーの時系列の一覧に使う）。付いているときだけ持つ
  const likedAt = likedLevel > 0 ? toIso(raw.likedAt, null) : null;
  if (likedAt) rec.likedAt = likedAt;
  const bookmarkedAt = rec.bookmarked ? toIso(raw.bookmarkedAt, null) : null;
  if (bookmarkedAt) rec.bookmarkedAt = bookmarkedAt;
  // 添付した画像（表紙はそのうちの1枚）・リンク。あるときだけ持つ
  const images = normalizeImages(raw.images, now);
  if (images.length) {
    rec.images = images;
    if (typeof raw.cover === 'string' && images.some((img) => img.id === raw.cover)) rec.cover = raw.cover;
  }
  const urls = normalizeUrls(raw.urls, now);
  if (urls.length) rec.urls = urls;
  // タグ（ハッシュタグ）。付いているときだけ持つ
  const tags = normalizeTags(raw.tags);
  if (tags.length) rec.tags = tags;
  // 期限（日付だけ）と進み具合（0〜6。6 で完了）。付いているときだけ
  const due = normalizeDue(raw.due);
  if (due) rec.due = due;
  const progress = Number(raw.progress);
  if (Number.isInteger(progress) && progress > 0) rec.progress = Math.min(MAX_PROGRESS, progress);
  // 長文を分けて並べたマスの通し番号（読書モードはこの順に進む）。id は1回の取り込みごと。
  // head は見出し、para は段落の最初のマス（サイドバーの全文で段落を分けるのに使う）
  const seq = raw.seq;
  if (seq && typeof seq === 'object' && typeof seq.id === 'string' && SEQ_ID_RE.test(seq.id)
    && Number.isInteger(seq.n) && seq.n >= 1 && seq.n <= 1000000) {
    rec.seq = { id: seq.id, n: seq.n, ...(seq.head === true ? { head: true } : {}), ...(seq.para === true ? { para: true } : {}) };
  }
  // このマスを中心にした下の階層（周りに書いたメモ）。第1層は children、重ねた第2層以降は moreLayers。
  // 後ろの空の層は持たない。第2層以降があるときは、第1層が空でも番号を保つために残す
  const hasMore = Array.isArray(raw.moreLayers) && raw.moreLayers.length > 0;
  if ((raw.children && typeof raw.children === 'object') || hasMore) {
    if (depth >= MAX_DEPTH) {
      dropped.push(`（${MAX_DEPTH} 階層より深いデータ）`);
    } else {
      const layer = (l) => {
        const ok = l && typeof l === 'object' && !Array.isArray(l);
        const out = { camera: normalizeCamera(ok ? l.camera : null), memos: normalizeMemos(ok ? l.memos : null, now, depth + 1, dropped, keepIds) };
        const name = ok ? normalizeLayerName(l.name) : '';
        if (name) out.name = name;
        const combo = ok ? normalizeCombo(l.combo, images) : null;
        if (combo) out.combo = combo;
        const regions = ok ? normalizeRegions(l.regions) : [];
        if (regions.length) out.regions = regions;
        const footprints = ok ? normalizeFootprints(l.footprints) : null;
        if (footprints) out.footprints = footprints;
        const trails = ok ? normalizeTrails(l.trails) : null;
        if (trails) out.trails = trails;
        return out;
      };
      // 画像を組み合わせた層・領域に名前を付けた層は、メモが無くても残す
      const hasContent = (l) => Object.keys(l.memos).length > 0 || !!l.combo || !!(l.regions && l.regions.length);
      const layers = [layer(raw.children)];
      if (hasMore) for (const l of raw.moreLayers.slice(0, MAX_LAYERS - 1)) layers.push(layer(l));
      while (layers.length > 1 && !hasContent(layers[layers.length - 1])) layers.pop();
      if (layers.length > 1) {
        rec.children = layers[0];
        rec.moreLayers = layers.slice(1);
      } else if (hasContent(layers[0])) {
        rec.children = layers[0];
      }
    }
  }
  return rec;
}

// 層の名前（「感想」「反論」など。無ければ「第n層」と表示）
function normalizeLayerName(name) {
  if (typeof name !== 'string') return '';
  return [...name.replace(/\s+/g, ' ').trim()].slice(0, LAYER_NAME_MAX).join('').trim();
}

// 層と組み合わせた画像：その層の中心のメモ（images）の画像を、ハニカムの下に敷く。
// image は画像の ID、x・y は画像の中心、w は画像の幅（どれもハニカムのワールド座標）、fade は上のセルの濃さ
const COMBO_FADES = new Set(['full', 'half', 'faint']);
const COMBO_MIN_W = 20;
const COMBO_MAX_W = 1e6;
const COMBO_MAX_POS = 1e7;
function normalizeCombo(raw, images) {
  if (!raw || typeof raw !== 'object' || typeof raw.image !== 'string') return null;
  if (!images.some((img) => img.id === raw.image)) return null; // 画像が外されていたら組み合わせも外す
  const clamp = (v, max) => Math.min(max, Math.max(-max, finiteOr(v, 0)));
  const combo = {
    image: raw.image,
    x: clamp(raw.x, COMBO_MAX_POS),
    y: clamp(raw.y, COMBO_MAX_POS),
    w: Math.min(COMBO_MAX_W, Math.max(COMBO_MIN_W, finiteOr(raw.w, 1600))),
  };
  if (COMBO_FADES.has(raw.fade)) combo.fade = raw.fade;
  return combo;
}

// そのメモの周りの層（第1層、重ねた第2層…）
function recordLayers(rec) {
  return rec.children ? [rec.children, ...(rec.moreLayers || [])] : [];
}

// keepIds：関連付けられているメモの ID。本文が空でも、関連があれば残す
function isEmptyRecord(rec, keepIds = null) {
  return !rec.text.trim() && rec.likedLevel === 0 && !rec.bookmarked && rec.comments.length === 0 && !rec.children
    && !(rec.images && rec.images.length) && !(rec.urls && rec.urls.length) && !(rec.tags && rec.tags.length)
    && !rec.due && !(rec.progress > 0)
    && !(keepIds && rec.id && keepIds.has(rec.id));
}

// 期限：YYYY-MM-DD だけ（ISO の日時なら日付の部分）
function normalizeDue(value) {
  if (typeof value !== 'string') return null;
  const s = value.trim().slice(0, 10);
  if (!DUE_RE.test(s) || Number.isNaN(Date.parse(`${s}T00:00:00Z`))) return null;
  return s;
}

// 足あと：マスごとの { n: 回数, at: 最後に訪れた時刻 }。回数の多いものから MAX_FOOTPRINTS まで
function normalizeFootprints(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const entries = [];
  for (const [k, v] of Object.entries(raw)) {
    const key = normalizeKey(k);
    const n = v && typeof v === 'object' ? Number(v.n) : Number(v);
    if (!key || !Number.isFinite(n) || n < 1) continue;
    const at = v && typeof v === 'object' ? toIso(v.at, null) : null;
    entries.push([key, { n: Math.min(1e6, Math.floor(n)), ...(at ? { at } : {}) }]);
  }
  if (!entries.length) return null;
  entries.sort((a, b) => b[1].n - a[1].n);
  return Object.fromEntries(entries.slice(0, MAX_FOOTPRINTS));
}

// 足あとの道：続けて訪れた2つのマス（キーを並べ替えて "q,r|q,r"）→ 回数
function normalizeTrails(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const entries = [];
  for (const [k, v] of Object.entries(raw)) {
    const parts = String(k).split('|');
    if (parts.length !== 2) continue;
    const a = normalizeKey(parts[0]);
    const b = normalizeKey(parts[1]);
    const n = Number(v);
    if (!a || !b || a === b || !Number.isFinite(n) || n < 1) continue;
    entries.push([[a, b].sort().join('|'), Math.min(1e6, Math.floor(n))]);
  }
  if (!entries.length) return null;
  entries.sort((x, y) => y[1] - x[1]);
  return Object.fromEntries(entries.slice(0, MAX_FOOTPRINTS));
}

// 日ごとの活動：{ "YYYY-MM-DD": { v: 訪れた回数, e: 書いた回数 } }
function normalizeActivity(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out = {};
  const days = Object.keys(raw).filter((d) => DUE_RE.test(d)).sort().slice(-MAX_ACTIVITY_DAYS);
  for (const d of days) {
    const x = raw[d] && typeof raw[d] === 'object' ? raw[d] : {};
    const v = Math.max(0, Math.floor(finiteOr(x.v, 0)));
    const e = Math.max(0, Math.floor(finiteOr(x.e, 0)));
    if (v || e) out[d] = { v, e };
  }
  return Object.keys(out).length ? out : null;
}

// Dendritic Extension：名前を付けた順路。steps はメモの ID の列。parentId と at があれば、その順路の at 番目から伸びた枝
function normalizeDendrites(list, ids) {
  if (!Array.isArray(list)) return [];
  const out = [];
  const seen = new Set();
  for (const d of list) {
    if (out.length >= MAX_DENDRITES) break;
    if (!d || typeof d !== 'object') continue;
    const name = typeof d.name === 'string' ? [...d.name.replace(/\s+/g, ' ').trim()].slice(0, DEND_NAME_MAX).join('').trim() : '';
    const steps = [];
    for (const s of Array.isArray(d.steps) ? d.steps : []) {
      if (typeof s === 'string' && ids.has(s) && !steps.includes(s)) steps.push(s);
      if (steps.length >= MAX_STEPS) break;
    }
    if (!name || !steps.length) continue;
    let id = typeof d.id === 'string' && DEND_ID_RE.test(d.id) ? d.id : crypto.randomBytes(4).toString('hex');
    if (seen.has(id)) id = crypto.randomBytes(4).toString('hex');
    seen.add(id);
    const item = { id, name, steps };
    const color = normalizeColor(d.color);
    if (color) item.color = color;
    if (typeof d.parentId === 'string' && DEND_ID_RE.test(d.parentId) && d.parentId !== id) {
      item.parentId = d.parentId;
      const at = Number(d.at);
      item.at = Number.isInteger(at) && at >= 0 ? at : 0;
    }
    out.push(item);
  }
  // 親が無い枝は、ふつうの順路にする
  const have = new Set(out.map((d) => d.id));
  for (const d of out) {
    if (d.parentId && !have.has(d.parentId)) {
      delete d.parentId;
      delete d.at;
    }
  }
  return out;
}

// 未配置の棚：まだマスに置いていないメモ（レコードそのもの）
function normalizeShelf(list, now, dropped, keepIds) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const raw of list) {
    if (out.length >= MAX_SHELF) break;
    const rec = normalizeRecord(raw, now, 0, dropped, keepIds);
    if (rec && !isEmptyRecord(rec, keepIds)) out.push(rec);
  }
  return out;
}

// ゴミ箱の1件：{ id, deletedAt, rec（メモ。周りのメモも中に）, from（'cell'｜'shelf'）, keys・key（元の場所）, where（場所の言葉）, links（そのとき外した関連付け） }
function normalizeTrash(list, now, dropped) {
  if (!Array.isArray(list)) return [];
  const limit = Date.parse(now) - TRASH_DAYS * 86400000;
  const out = [];
  const seen = new Set();
  for (const raw of list) {
    if (out.length >= MAX_TRASH) break;
    if (!raw || typeof raw !== 'object') continue;
    const deletedAt = toIso(raw.deletedAt, null);
    if (!deletedAt || Date.parse(deletedAt) < limit) continue;
    const rec = normalizeRecord(raw.rec, now, 0, dropped, null);
    if (!rec || isEmptyRecord(rec)) continue;
    let id = typeof raw.id === 'string' && TRASH_ID_RE.test(raw.id) ? raw.id : '';
    while (!id || seen.has(id)) id = `t${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
    seen.add(id);
    const entry = { id, deletedAt, rec };
    if (raw.from === 'shelf') entry.from = 'shelf';
    else {
      entry.from = 'cell';
      entry.keys = Array.isArray(raw.keys) ? raw.keys.filter((k) => typeof k === 'string' && STEP_RE.test(k)).slice(0, MAX_DEPTH) : [];
      entry.key = normalizeKey(raw.key) || '0,0';
    }
    if (typeof raw.where === 'string' && raw.where.trim()) entry.where = [...raw.where].slice(0, 200).join('');
    const links = [];
    for (const l of Array.isArray(raw.links) ? raw.links : []) {
      if (!l || typeof l !== 'object' || typeof l.a !== 'string' || typeof l.b !== 'string' || l.a === l.b) continue;
      if (!MEMO_ID_RE.test(l.a) || !MEMO_ID_RE.test(l.b)) continue;
      const link = { a: l.a, b: l.b, createdAt: toIso(l.createdAt, now) };
      if (typeof l.kind === 'string' && KIND_RE.test(l.kind)) link.kind = l.kind;
      const label = typeof l.label === 'string' ? [...l.label.replace(/\s+/g, ' ').trim()].slice(0, LINK_LABEL_MAX).join('').trim() : '';
      if (label) link.label = label;
      links.push(link);
      if (links.length >= 2000) break;
    }
    if (links.length) entry.links = links;
    out.push(entry);
  }
  return out;
}

// 関連グラフの並び：{ id, name, savedAt, scope：'layer'｜'all', keys（scope が layer のときの階層）, focus：{ id, depth }（絞り込み）, pos：{ メモの ID: [x, y] } }
function normalizeGraphLayouts(list, now) {
  if (!Array.isArray(list)) return [];
  const out = [];
  const seen = new Set();
  for (const raw of list) {
    if (out.length >= MAX_GRAPH_LAYOUTS) break;
    if (!raw || typeof raw !== 'object') continue;
    let id = typeof raw.id === 'string' && LAYOUT_ID_RE.test(raw.id) ? raw.id : '';
    while (!id || seen.has(id)) id = `g${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
    seen.add(id);
    const name = typeof raw.name === 'string' ? [...raw.name.replace(/\s+/g, ' ').trim()].slice(0, LAYOUT_NAME_MAX).join('').trim() : '';
    const pos = {};
    let n = 0;
    for (const [k, v] of Object.entries(raw.pos && typeof raw.pos === 'object' ? raw.pos : {})) {
      if (n >= MAX_LAYOUT_NODES) break;
      if (!MEMO_ID_RE.test(k) || !Array.isArray(v) || v.length !== 2) continue;
      const x = Number(v[0]);
      const y = Number(v[1]);
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      const clamp = (c) => Math.round(Math.max(-LAYOUT_COORD_MAX, Math.min(LAYOUT_COORD_MAX, c)));
      pos[k] = [clamp(x), clamp(y)];
      n++;
    }
    if (!n) continue;
    const layout = { id, name: name || `並び ${out.length + 1}`, savedAt: toIso(raw.savedAt, now), scope: raw.scope === 'layer' ? 'layer' : 'all', pos };
    if (layout.scope === 'layer') layout.keys = Array.isArray(raw.keys) ? raw.keys.filter((k) => typeof k === 'string' && STEP_RE.test(k)).slice(0, MAX_DEPTH) : [];
    if (raw.focus && typeof raw.focus === 'object' && typeof raw.focus.id === 'string' && MEMO_ID_RE.test(raw.focus.id)) {
      layout.focus = { id: raw.focus.id, depth: raw.focus.depth === 1 ? 1 : 0 };
    }
    out.push(layout);
  }
  return out;
}

// 配置ヒント：{ v: 1, source?, createdAt, flow?: { dir }, grokOuter?: true, nodes: { メモの ID: { pin?, zone?, group?, rank?, weight? } } }
// メモの ID は、ノートに実在するものだけ残す（関連線と同じ）。読めない項目は黙って捨てる（ヒントは省略できるので警告しない）。
// 中身が空になったら layoutHints ごと省く（null）
function normalizeLayoutHints(raw, ids, now) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out = { v: 1 };
  if (typeof raw.source === 'string' && HINT_SOURCE_RE.test(raw.source)) out.source = raw.source;
  out.createdAt = toIso(raw.createdAt, now);
  if (raw.flow && typeof raw.flow === 'object') out.flow = { dir: raw.flow.dir === 'TB' ? 'TB' : 'LR' };
  if (raw.grokOuter === true) out.grokOuter = true;
  const nodes = {};
  const list = raw.nodes && typeof raw.nodes === 'object' && !Array.isArray(raw.nodes) ? Object.entries(raw.nodes) : [];
  let n = 0;
  for (const [id, h] of list) {
    if (n >= MAX_HINT_NODES) break;
    if (!MEMO_ID_RE.test(id) || !ids.has(id) || !h || typeof h !== 'object') continue;
    const one = normalizeHintNode(h);
    if (!one) continue;
    nodes[id] = one;
    n++;
  }
  if (Object.keys(nodes).length) out.nodes = nodes;
  if (!out.nodes && !out.flow && !out.grokOuter) return null;
  return out;
}

// 1つのメモのヒント。読めた項目だけ残す（1つも無ければ null）
function normalizeHintNode(h) {
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const clamp01 = (v, digits) => {
    const f = 10 ** digits;
    return Math.round(Math.min(1, Math.max(0, v)) * f) / f;
  };
  const one = {};
  if (h.pin && typeof h.pin === 'object') {
    const x = num(h.pin.x);
    const y = num(h.pin.y);
    if (x !== null && y !== null) one.pin = { x: clamp01(x, 3), y: clamp01(y, 3) };
  }
  if (typeof h.zone === 'string' && HINT_ZONES.has(h.zone)) one.zone = h.zone;
  if (typeof h.group === 'string' && HINT_GROUP_RE.test(h.group)) one.group = h.group;
  if (Number.isInteger(h.rank) && h.rank >= 0 && h.rank <= 99) one.rank = h.rank;
  const w = num(h.weight);
  if (w !== null) one.weight = clamp01(w, 2);
  return Object.keys(one).length ? one : null;
}

// ノート全体のメモ ID を集める。同じ ID が重なっていたら後の方の ID を外す（手で編集された場合など）
function collectIds(memos, ids = new Set()) {
  for (const rec of Object.values(memos)) {
    if (rec.id) {
      if (ids.has(rec.id)) delete rec.id;
      else ids.add(rec.id);
    }
    for (const layer of recordLayers(rec)) collectIds(layer.memos, ids);
  }
  return ids;
}

// 関連付け（リンク）：両端のメモが実在し、同じ組は1つだけ
function normalizeLinks(list, ids, now) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (const l of list) {
    if (!l || typeof l !== 'object' || typeof l.a !== 'string' || typeof l.b !== 'string') continue;
    if (l.a === l.b || !ids.has(l.a) || !ids.has(l.b)) continue;
    const pair = l.a < l.b ? `${l.a}|${l.b}` : `${l.b}|${l.a}`;
    if (seen.has(pair)) continue;
    seen.add(pair);
    const link = { a: l.a, b: l.b, createdAt: toIso(l.createdAt, now) };
    // 種類（settings.json に登録した関連線の種類の ID）とラベル。付いているときだけ
    if (typeof l.kind === 'string' && KIND_RE.test(l.kind)) link.kind = l.kind;
    const label = typeof l.label === 'string' ? [...l.label.replace(/\s+/g, ' ').trim()].slice(0, LINK_LABEL_MAX).join('').trim() : '';
    if (label) link.label = label;
    out.push(link);
  }
  return out;
}

// 1階層分の { "q,r": レコード } を正規化する。空のマスは捨て、読めないキーは dropped へ
function normalizeMemos(memosRaw, now, depth, dropped, keepIds = null) {
  const entries = Array.isArray(memosRaw)
    ? memosRaw.map((m) => [m && typeof m === 'object' ? `${m.q},${m.r}` : '', m])
    : memosRaw && typeof memosRaw === 'object'
      ? Object.entries(memosRaw)
      : [];

  const memos = {};
  for (const [rawKey, value] of entries) {
    const key = normalizeKey(rawKey);
    const rec = key ? normalizeRecord(value, now, depth, dropped, keepIds) : null;
    if (!key || !rec) {
      dropped.push(String(rawKey));
      continue;
    }
    if (isEmptyRecord(rec, keepIds)) continue;
    const prev = memos[key];
    if (prev) {
      // 正規化で同じ座標に重なった場合は新しい方を残す
      dropped.push(String(rawKey));
      if (Date.parse(prev.updatedAt) >= Date.parse(rec.updatedAt)) continue;
    }
    memos[key] = rec;
  }
  return memos;
}

// メモの件数（下の階層も含む）
function countMemos(memos) {
  let n = 0;
  for (const rec of Object.values(memos || {})) {
    n++;
    for (const layer of recordLayers(rec)) n += countMemos(layer.memos);
  }
  return n;
}

/**
 * 任意の形式のデータを version 2 に揃える。
 * 対応: v2 / v1（liked: boolean）/ v0（{"q,r": "本文"} や [{q, r, text}]）。
 * 空のマスは捨てる。座標として読めないキーは dropped に入れて返す。
 */
function normalizeStore(raw, now = new Date().toISOString()) {
  const store = emptyStore();
  let fromVersion = STORE_VERSION;
  let memosRaw = null;

  if (Array.isArray(raw)) {
    fromVersion = 0;
    memosRaw = raw;
  } else if (raw && typeof raw === 'object') {
    if ('memos' in raw || 'version' in raw) {
      fromVersion = Number.isInteger(raw.version) ? raw.version : 1;
      memosRaw = raw.memos;
      store.camera = normalizeCamera(raw.camera);
    } else {
      fromVersion = 0;
      memosRaw = raw;
    }
  }

  const dropped = [];
  const obj = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const rawLinks = Array.isArray(obj.links) ? obj.links : [];
  // 関連付け・順路（Dendritic Extension）で使われているメモは、本文が空でも残す
  const keepIds = new Set();
  for (const l of rawLinks) {
    if (l && typeof l.a === 'string' && typeof l.b === 'string' && MEMO_ID_RE.test(l.a) && MEMO_ID_RE.test(l.b)) {
      keepIds.add(l.a);
      keepIds.add(l.b);
    }
  }
  for (const d of Array.isArray(obj.dendrites) ? obj.dendrites : []) {
    for (const s of d && Array.isArray(d.steps) ? d.steps : []) if (typeof s === 'string' && MEMO_ID_RE.test(s)) keepIds.add(s);
  }
  store.memos = normalizeMemos(memosRaw, now, 0, dropped, keepIds);
  const ids = collectIds(store.memos);
  // 未配置の棚のメモも ID を持てる（置いたときに関連付けや順路が生きる）
  const shelf = normalizeShelf(obj.shelf, now, dropped, keepIds);
  for (const rec of shelf) {
    if (rec.id && ids.has(rec.id)) delete rec.id;
    if (rec.id) ids.add(rec.id);
  }
  if (shelf.length) store.shelf = shelf;
  const links = normalizeLinks(rawLinks, ids, now);
  if (links.length) store.links = links;
  const regions = normalizeRegions(obj.regions);
  if (regions.length) store.regions = regions;
  const dendrites = normalizeDendrites(obj.dendrites, ids);
  if (dendrites.length) store.dendrites = dendrites;
  const footprints = normalizeFootprints(obj.footprints);
  if (footprints) store.footprints = footprints;
  const trails = normalizeTrails(obj.trails);
  if (trails) store.trails = trails;
  const activity = normalizeActivity(obj.activity);
  if (activity) store.activity = activity;
  const trash = normalizeTrash(obj.trash, now, dropped);
  if (trash.length) store.trash = trash;
  const graphLayouts = normalizeGraphLayouts(obj.graphLayouts, now);
  if (graphLayouts.length) store.graphLayouts = graphLayouts;
  // 配置ヒント（ファイル直下）。ID は、棚まで集め終わった今の一覧（ids）で確かめる
  const layoutHints = normalizeLayoutHints(obj.layoutHints, ids, now);
  if (layoutHints) store.layoutHints = layoutHints;
  // 区画（写しの作業台）。紙片の番号札はメモの番号札の一覧（ids）に足さない（関連付け・順路の相手にしない）
  const pockets = HP.normalizePockets(obj.pockets, now, { normalizeRecord });
  if (pockets.length) store.pockets = pockets;
  return { store, fromVersion, dropped };
}

function readJsonFile(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    return err.code === 'ENOENT' ? { status: 'missing' } : { status: 'error', error: err };
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== 'object') throw new Error('JSON がオブジェクトではありません');
    return { status: 'ok', value };
  } catch (err) {
    return { status: 'corrupt', error: err };
  }
}

// 一時ファイルに書いて fsync → rename。途中で落ちても元のファイルは壊れない。
function writeFileAtomic(file, content) {
  const tmp = `${file}.tmp`;
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeFileSync(fd, content, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.renameSync(tmp, file);
  } catch (err) {
    // Windows でウイルス対策ソフト等がファイルを掴んでいると rename が失敗することがある
    if (!['EPERM', 'EBUSY', 'EACCES'].includes(err.code)) throw err;
    fs.writeFileSync(file, content, 'utf8');
    fs.rmSync(tmp, { force: true });
  }
}

function stamp(date) {
  return date.toISOString().replace(/[:.]/g, '-');
}

class MemoStore {
  constructor(dir, fileName = DATA_FILE) {
    this.dir = dir;
    this.fileName = fileName;
    this.file = path.join(dir, fileName);
    this.current = emptyStore();
    this.readOnly = false;
    this.notices = [];
    this.preserveAs = null; // 移行・読み飛ばしがあったとき、元ファイルを残す先
    this.backupDone = false; // セッション最初の書き込み前に .bak を作ったか
  }

  load(now = new Date()) {
    fs.mkdirSync(this.dir, { recursive: true });
    let res = readJsonFile(this.file);

    if (res.status === 'missing') {
      this.current = emptyStore();
      this.backupDone = true;
      return this.current;
    }

    if (res.status === 'error') {
      this.readOnly = true;
      this.current = emptyStore();
      this.notice('error', `データを読み込めませんでした（${res.error.code || res.error.message}）。上書きを防ぐため保存を停止しています。`);
      return this.current;
    }

    if (res.status === 'corrupt') {
      const corruptPath = `${this.file}.corrupt-${stamp(now)}`;
      try {
        fs.renameSync(this.file, corruptPath);
      } catch (err) {
        this.readOnly = true;
        this.current = emptyStore();
        this.notice('error', `保存ファイルが壊れており、退避もできませんでした（${err.code || err.message}）。保存を停止しています。`);
        return this.current;
      }
      this.backupDone = true;
      const bak = readJsonFile(`${this.file}.bak`);
      if (bak.status !== 'ok') {
        this.current = emptyStore();
        this.notice('warn', `保存ファイルが壊れていたため、空の状態で開始しました。壊れたファイルは ${path.basename(corruptPath)} として残しています。`);
        return this.current;
      }
      res = bak;
      this.notice('warn', `保存ファイルが壊れていたため、バックアップ（${this.fileName}.bak）から復元しました。壊れたファイルは ${path.basename(corruptPath)} として残しています。`);
    }

    const { store, fromVersion, dropped } = normalizeStore(res.value, now.toISOString());
    this.current = store;
    if (fromVersion !== STORE_VERSION || dropped.length) {
      const base = this.fileName.replace(/\.json$/, '');
      this.preserveAs = path.join(this.dir, `${base}.backup-v${fromVersion}-${stamp(now)}.json`);
      if (fromVersion !== STORE_VERSION) {
        this.notice('info', `旧形式（v${fromVersion}）のデータを新形式に変換しました。元のファイルは ${path.basename(this.preserveAs)} に残します。`);
      }
      if (dropped.length) {
        this.notice('warn', `座標として読めないデータ ${dropped.length} 件を読み飛ばしました。元のファイルは ${path.basename(this.preserveAs)} に残します。`);
      }
    }
    return this.current;
  }

  save(data) {
    if (this.readOnly) throw new Error('読み込みに失敗したため保存を停止しています');
    const { store } = normalizeStore(data);
    this.backupBeforeFirstWrite();
    writeFileAtomic(this.file, `${JSON.stringify(store, null, 2)}\n`);
    this.current = store;
    return store;
  }

  backupBeforeFirstWrite() {
    if (this.backupDone) return;
    if (fs.existsSync(this.file)) {
      // 移行前の原本が残せないなら上書きしない（例外で保存を失敗させ、次回に再試行）
      if (this.preserveAs && !fs.existsSync(this.preserveAs)) fs.copyFileSync(this.file, this.preserveAs);
      try {
        fs.copyFileSync(this.file, `${this.file}.bak`);
      } catch (err) {
        console.warn('[hex-memo] バックアップの作成に失敗しました:', err);
      }
    }
    this.backupDone = true;
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

module.exports = {
  STORE_VERSION,
  DATA_FILE,
  MAX_DEPTH,
  MAX_LAYERS,
  countMemos,
  MemoStore,
  emptyStore,
  normalizeStore,
  normalizeRecord,
  normalizeTrash,
  normalizeGraphLayouts,
  normalizeLayoutHints,
  TRASH_DAYS,
  MAX_TRASH,
  normalizeKey,
  isEmptyRecord,
  normalizeTag,
  normalizeTags,
  normalizeRegions,
  normalizeColor,
  normalizeDue,
  normalizeDendrites,
  normalizeShelf,
  normalizeFootprints,
  normalizeTrails,
  normalizeActivity,
  MAX_PROGRESS,
  MAX_TAGS,
  TAG_MAX,
  KIND_RE,
  COLOR_RE,
  ATT_RE,
  readJsonFile,
  writeFileAtomic,
  stamp,
};
