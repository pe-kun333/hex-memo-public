'use strict';

/* アプリ全体の設定（データフォルダの settings.json）。ノートをまたいで使うもの：
 *  ・タグの登録（名前・アイコン・色・使った回数）：マスに付けるハッシュタグ。よく使う6つはボタンで付けられる
 *  ・関連線の種類（名前・色）：関連付けの線に種類・色・ラベルを付けるときの選択肢
 *  ・クイック入力（呼び出すキー・書き込む場所）
 *  ・全体表示は見るだけ（50% 未満で足した操作を止める。既定は切）
 *  ・タグボタンのセット（未配置の棚の右クリックで、9つのボタンでタグを付ける。複数登録して切り替える）
 * Electron に依存しないので Node 単体でテストでき、ブラウザ版（web-fs.js の上）でもそのまま動く。 */

const path = require('node:path');
const { readJsonFile, writeFileAtomic, normalizeTag, normalizeColor } = require('./store');

const SETTINGS_FILE = 'settings.json';
const SETTINGS_VERSION = 1;
const MAX_TAG_ENTRIES = 200;
const MAX_KINDS = 20;
const KIND_ID_RE = /^[a-z0-9_-]{1,32}$/;
const KIND_NAME_MAX = 20;
const ICON_MAX = 2; // 絵文字など、見た目の文字数で
const TOP_TAGS = 6; // よく使うタグとしてボタンに出す数

// タグの色（登録時に順に割り当てる）
const TAG_PALETTE = ['#1d9bf0', '#00ba7c', '#f59e0b', '#f91880', '#a78bfa', '#ef4444', '#14b8a6', '#eab308', '#fb7185', '#60a5fa', '#34d399', '#f97316'];

// directed：向きのある種類（a → b。根拠は主張へ、反論は相手へ、続きは次へ、原因は結果へ）
const DEFAULT_LINK_KINDS = [
  { id: 'related', name: '関連', color: '#a78bfa', directed: false },
  { id: 'support', name: '根拠', color: '#00ba7c', directed: true },
  { id: 'against', name: '反論', color: '#f4212e', directed: true },
  { id: 'next', name: '続き', color: '#1d9bf0', directed: true },
  { id: 'cause', name: '原因', color: '#f59e0b', directed: true },
];
const DEFAULT_DIRECTED = Object.fromEntries(DEFAULT_LINK_KINDS.map((k) => [k.id, k.directed]));

// 期限の通知（本体：OS の通知。ブラウザ版：ブラウザの通知）。time は毎日の時刻（HH:MM）
const DEFAULT_NOTIFY = { enabled: true, time: '09:00' };
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

// 足あと：show（画面に出す）・record（記録する）。どちらもユーザーが選べる
const DEFAULT_FOOTPRINTS = { show: false, record: true };

// クイック入力：呼び出すキー（Electron の accelerator の書き方）、書く場所（origin：原点の近く／latest：最新のマスの近く／ask：毎回選ぶ）、
// global：ほかのアプリの前でも効かせる（デスクトップ版だけ）
// toggle：呼び出したあと、もう一度同じキーで最小化する。hideShortcut：最小化する別のキー（'' は無し）
const DEFAULT_QUICK = { shortcut: 'CommandOrControl+Alt+Q', place: 'origin', global: true, toggle: true, hideShortcut: '' };
const QUICK_PLACES = new Set(['origin', 'latest', 'ask', 'shelf']);

// 定型（マスの配置の型）：選んだマスの並び・本文・タグ・コメント・関連線・領域を登録しておき、右クリックから貼る。
// cells[0] が基準のマス（dq・dr は 0）。links・regions のマスは cells の番号。due は貼った日からの日数
const MAX_TEMPLATES = 100;
const MAX_TEMPLATE_CELLS = 200;
const TEMPLATE_ID_RE = /^t[0-9a-f]{8}$/;
const TEMPLATE_NAME_MAX = 40;
const TEMPLATE_TEXT_MAX = 4000;
const TEMPLATE_COMMENTS_MAX = 50;
const TOP_TEMPLATES = 6; // 右クリックメニューに出す数

// 六角形スクショ：呼び出すキー、登録した大きさ（六角形の外接円の半径。画面の px）、最後に使った大きさ、撮ったあとにコメントを書くか
const DEFAULT_CAPTURE = { shortcut: 'CommandOrControl+Alt+H', sizes: [160, 280, 440], last: 280, comment: true };
const CAPTURE_R_MIN = 40;
const CAPTURE_R_MAX = 2000;
const CAPTURE_SIZES_MAX = 12;

// 表示倍率：よく使う倍率（%）を6つ登録する。固定する倍率（%）はハニカム・グラフ別（null は固定しない）
// overviewClick：縮小中（全体表示・50% 未満）にメモのマスをクリックしたとき。'zoom'：そこを拡大（既定）／'edit'：拡大して編集／
// 'pin'：浮かび上がり（100% の写し）をその場に固定して、♡ などを押せるようにする
const DEFAULT_ZOOM = { presets: [25, 50, 75, 100, 125, 150], lock: { grid: null, graph: null }, overviewClick: 'zoom' };
const OVERVIEW_CLICKS = new Set(['zoom', 'edit', 'pin']);
const ZOOM_SLOTS = 6;
const ZOOM_PCT_MIN = 4; // ハニカムの範囲（4%〜150%）。登録もこの範囲
const ZOOM_PCT_MAX = 150;
const ZOOM_GRAPH_MIN = 20; // 関係線のグラフの範囲（20%〜250%）
const ZOOM_GRAPH_MAX = 250;

// トレイに常駐：ウィンドウをすべて閉じても終了せず、トレイ（通知領域）に残る（六角形スクショ・クイック入力のキーが効き続ける）
const DEFAULT_TRAY = { enabled: true };

// タグボタンのセット：未配置の棚の項目を右クリックすると、セットの9つのボタン（1〜9 のキー）でタグを付け外しできる。
// セットは複数登録して切り替える。tags は9つの枠（空きは ''）。tagSetActive は今使っているセットの ID
const MAX_TAG_SETS = 20;
const TAG_SET_SLOTS = 9;
const TAG_SET_ID_RE = /^s[0-9a-f]{8}$/;
const TAG_SET_NAME_MAX = 20;

// 今日の1枚：1日に浮かび上がらせる枚数・選ぶ対象・起動したときに開くか・AI に選んでもらうときの候補の数
const TODAY_SOURCES = new Set(['mixed', 'liked', 'bookmarked', 'old', 'all']);
const DEFAULT_TODAY = { count: 1, source: 'mixed', startup: false, aiCount: 20 };

// 音声で入力：方法（browser：ブラウザの音声認識／record：録音して文字起こし／os：OS の音声入力）・言語・
// 変換コマンド（デスクトップ版：録音した WAV を文字起こしソフトに渡す）・止めたらすぐ文字起こしするか・書き込む先
const VOICE_METHODS = new Set(['browser', 'record', 'os']);
const VOICE_PLACES = new Set(['new', 'append', 'shelf']);
const DEFAULT_VOICE = { method: 'browser', lang: 'ja-JP', command: '', auto: true, place: 'new' };

// よく使う検索：検索語・タグ・並べ方・範囲・領域（名前）を名前付きで保存し、検索のサイドバーから呼び出す
const MAX_SAVED_SEARCHES = 50;
const SAVED_SEARCH_ID_RE = /^q[0-9a-f]{8}$/;
const SEARCH_SORTS = new Set(['relevance', 'updated', 'created', 'tag']);

const MODIFIERS = new Set(['commandorcontrol', 'cmdorctrl', 'command', 'cmd', 'control', 'ctrl', 'alt', 'option', 'shift', 'super', 'meta']);
const KEY_NAMES = new Set(['space', 'tab', 'enter', 'return', 'escape', 'esc', 'backspace', 'delete', 'insert', 'home', 'end', 'pageup', 'pagedown',
  'up', 'down', 'left', 'right', 'plus', 'capslock', 'numlock', 'scrolllock', 'printscreen',
  'numadd', 'numsub', 'nummult', 'numdiv', 'numdec', ...Array.from({ length: 10 }, (_, i) => `num${i}`), ...Array.from({ length: 24 }, (_, i) => `f${i + 1}`)]);

// Electron の accelerator として使える形か（修飾キー＋キー1つ）。ふつうのキーには修飾キーを1つ以上付ける
function isAccelerator(value) {
  if (typeof value !== 'string' || !value.trim()) return false;
  const parts = value.split('+').map((s) => s.trim());
  if (parts.some((p) => !p)) return false;
  const key = parts[parts.length - 1];
  const mods = parts.slice(0, -1).map((p) => p.toLowerCase());
  if (mods.some((m) => !MODIFIERS.has(m)) || new Set(mods).size !== mods.length) return false;
  const k = key.toLowerCase();
  const plain = /^[a-z0-9]$/.test(k) || /^[-=;,.\/`\[\]\\']$/.test(k);
  const named = KEY_NAMES.has(k);
  if (!plain && !named) return false;
  // F キー以外は、修飾キー無しでは登録しない（ふつうの入力の邪魔になる）
  return mods.length > 0 || /^f\d{1,2}$/.test(k);
}

function normalizeTagEntry(raw, index, now) {
  const obj = raw && typeof raw === 'object' ? raw : { name: raw };
  const name = normalizeTag(obj.name);
  if (!name) return null;
  const entry = { name, color: normalizeColor(obj.color) || TAG_PALETTE[index % TAG_PALETTE.length], uses: 0 };
  const icon = typeof obj.icon === 'string' ? [...obj.icon.replace(/\s+/g, '')].slice(0, ICON_MAX * 2).join('') : '';
  if (icon) entry.icon = [...icon].slice(0, 4).join(''); // 結合文字つきの絵文字も入るように少し余裕を
  const uses = Number(obj.uses);
  if (Number.isFinite(uses) && uses > 0) entry.uses = Math.floor(uses);
  if (typeof obj.lastUsedAt === 'string' && !Number.isNaN(Date.parse(obj.lastUsedAt))) entry.lastUsedAt = new Date(obj.lastUsedAt).toISOString();
  return entry;
}

function normalizeTagEntries(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  const names = new Set();
  for (const raw of list) {
    if (out.length >= MAX_TAG_ENTRIES) break;
    const e = normalizeTagEntry(raw, out.length);
    if (!e || names.has(e.name)) continue;
    names.add(e.name);
    out.push(e);
  }
  return out;
}

function normalizeLinkKinds(list) {
  const src = Array.isArray(list) ? list : DEFAULT_LINK_KINDS;
  const out = [];
  const ids = new Set();
  for (const raw of src) {
    if (out.length >= MAX_KINDS) break;
    if (!raw || typeof raw !== 'object') continue;
    const id = typeof raw.id === 'string' && KIND_ID_RE.test(raw.id) ? raw.id : '';
    const name = typeof raw.name === 'string' ? [...raw.name.replace(/\s+/g, ' ').trim()].slice(0, KIND_NAME_MAX).join('').trim() : '';
    if (!id || !name || ids.has(id)) continue;
    ids.add(id);
    const directed = typeof raw.directed === 'boolean' ? raw.directed : !!DEFAULT_DIRECTED[id];
    out.push({ id, name, color: normalizeColor(raw.color) || DEFAULT_LINK_KINDS[0].color, directed });
  }
  return out.length ? out : DEFAULT_LINK_KINDS.map((k) => ({ ...k }));
}

function normalizeNotify(raw) {
  const n = raw && typeof raw === 'object' ? raw : {};
  return { enabled: n.enabled !== false, time: typeof n.time === 'string' && TIME_RE.test(n.time) ? n.time : DEFAULT_NOTIFY.time };
}

function normalizeFootprintsPref(raw) {
  const f = raw && typeof raw === 'object' ? raw : {};
  return { show: f.show === true, record: f.record !== false };
}

// キーの組み合わせを比べるための形（修飾キーの書き方と順番、大文字・小文字をそろえる）
const MOD_ALIAS = { cmdorctrl: 'commandorcontrol', ctrl: 'control', cmd: 'command', option: 'alt', super: 'meta' };
function acceleratorKey(value) {
  if (!isAccelerator(value)) return '';
  const parts = value.split('+').map((p) => p.trim().toLowerCase());
  const key = parts.pop();
  return [...parts.map((m) => MOD_ALIAS[m] || m).sort(), key].join('+');
}

function normalizeQuick(raw) {
  const q = raw && typeof raw === 'object' ? raw : {};
  const shortcut = isAccelerator(q.shortcut) ? q.shortcut.trim() : DEFAULT_QUICK.shortcut;
  // 最小化するキーは、呼び出すキーと同じなら持たない（同じキーで最小化するのは toggle）
  const hide = isAccelerator(q.hideShortcut) ? q.hideShortcut.trim() : '';
  return {
    shortcut,
    place: QUICK_PLACES.has(q.place) ? q.place : DEFAULT_QUICK.place,
    global: q.global !== false,
    toggle: q.toggle !== false,
    hideShortcut: hide && acceleratorKey(hide) !== acceleratorKey(shortcut) ? hide : '',
  };
}

const cleanText = (v, max) => (typeof v === 'string' ? [...v].slice(0, max).join('') : '');
const cleanName = (v, max) => [...String(typeof v === 'string' ? v : '').replace(/\s+/g, ' ').trim()].slice(0, max).join('').trim();
const intOr = (v, fallback) => (Number.isInteger(Number(v)) ? Number(v) : fallback);

function newTemplateId() {
  return `t${Math.random().toString(16).slice(2, 10).padEnd(8, '0')}`;
}

function normalizeTemplate(raw, ids) {
  if (!raw || typeof raw !== 'object') return null;
  const name = cleanName(raw.name, TEMPLATE_NAME_MAX);
  if (!name) return null;
  // マス：基準（最初のマス）からの相対座標。同じ座標は1つだけ
  const cells = [];
  const seen = new Set();
  const src = Array.isArray(raw.cells) ? raw.cells : [];
  const base = src.find((c) => c && typeof c === 'object' && Number.isInteger(Number(c.dq)) && Number.isInteger(Number(c.dr)));
  if (!base) return null;
  const bq = Number(base.dq);
  const br = Number(base.dr);
  const indexMap = new Map(); // 元の番号 → 新しい番号
  src.forEach((c, i) => {
    if (cells.length >= MAX_TEMPLATE_CELLS || !c || typeof c !== 'object') return;
    if (!Number.isInteger(Number(c.dq)) || !Number.isInteger(Number(c.dr))) return;
    const dq = Number(c.dq) - bq;
    const dr = Number(c.dr) - br;
    const k = `${dq},${dr}`;
    if (seen.has(k)) return;
    seen.add(k);
    const cell = { dq, dr, text: cleanText(c.text, TEMPLATE_TEXT_MAX) };
    const tags = [...new Set((Array.isArray(c.tags) ? c.tags : []).map(normalizeTag).filter(Boolean))].slice(0, 20);
    if (tags.length) cell.tags = tags;
    const comments = [];
    for (const cm of Array.isArray(c.comments) ? c.comments : []) {
      if (comments.length >= TEMPLATE_COMMENTS_MAX) break;
      const text = typeof cm === 'string' ? cm : cm && typeof cm === 'object' ? cm.text : '';
      const t = cleanText(text, TEMPLATE_TEXT_MAX).trim();
      if (!t) continue;
      const item = { text: t };
      const parent = cm && typeof cm === 'object' ? intOr(cm.parent, -1) : -1;
      if (parent >= 0 && parent < comments.length) item.parent = parent;
      comments.push(item);
    }
    if (comments.length) cell.comments = comments;
    const due = intOr(c.due, null);
    if (due !== null && due >= 0 && due <= 3650) cell.due = due;
    const progress = intOr(c.progress, 0);
    if (progress >= 1 && progress <= 6) cell.progress = progress;
    indexMap.set(i, cells.length);
    cells.push(cell);
  });
  if (!cells.length) return null;
  const idx = (v) => (indexMap.has(Number(v)) ? indexMap.get(Number(v)) : -1);
  const links = [];
  const pairs = new Set();
  for (const l of Array.isArray(raw.links) ? raw.links : []) {
    if (!l || typeof l !== 'object') continue;
    const a = idx(l.a);
    const b = idx(l.b);
    if (a < 0 || b < 0 || a === b) continue;
    const pair = a < b ? `${a}|${b}` : `${b}|${a}`;
    if (pairs.has(pair)) continue;
    pairs.add(pair);
    const link = { a, b };
    if (typeof l.kind === 'string' && KIND_ID_RE.test(l.kind)) link.kind = l.kind;
    const label = cleanName(l.label, 40);
    if (label) link.label = label;
    links.push(link);
  }
  const regions = [];
  for (const r of Array.isArray(raw.regions) ? raw.regions : []) {
    if (!r || typeof r !== 'object') continue;
    const rname = cleanName(r.name, 40);
    const members = [...new Set((Array.isArray(r.cells) ? r.cells : []).map(idx).filter((i) => i >= 0))];
    if (!rname || !members.length) continue;
    const region = { name: rname, cells: members };
    const color = normalizeColor(r.color);
    if (color) region.color = color;
    regions.push(region);
  }
  let id = typeof raw.id === 'string' && TEMPLATE_ID_RE.test(raw.id) ? raw.id : newTemplateId();
  while (ids.has(id)) id = newTemplateId();
  ids.add(id);
  const out = { id, name, cells, links, regions, pinned: raw.pinned === true, uses: Math.max(0, Math.floor(Number(raw.uses) || 0)) };
  const color = normalizeColor(raw.color);
  if (color) out.color = color;
  const last = typeof raw.lastUsedAt === 'string' && Number.isFinite(Date.parse(raw.lastUsedAt)) ? raw.lastUsedAt : null;
  if (last) out.lastUsedAt = last;
  return out;
}

function normalizeTemplates(list) {
  if (!Array.isArray(list)) return [];
  const ids = new Set();
  const out = [];
  for (const raw of list) {
    if (out.length >= MAX_TEMPLATES) break;
    const t = normalizeTemplate(raw, ids);
    if (t) out.push(t);
  }
  return out;
}

// 右クリックに出す定型：ピン留めしたものを先に（並び順）、あとは使った回数の多い順（同じなら最近使った順、登録順）
function topTemplates(settings, n = TOP_TEMPLATES) {
  const list = (settings.templates || []).map((t, i) => ({ t, i }));
  list.sort((a, b) => (b.t.pinned ? 1 : 0) - (a.t.pinned ? 1 : 0)
    || (a.t.pinned && b.t.pinned ? a.i - b.i : 0)
    || (b.t.uses || 0) - (a.t.uses || 0) || (Date.parse(b.t.lastUsedAt || 0) || 0) - (Date.parse(a.t.lastUsedAt || 0) || 0) || a.i - b.i);
  return list.slice(0, n).map((x) => x.t);
}

function normalizeCapture(raw) {
  const c = raw && typeof raw === 'object' ? raw : {};
  const clampR = (v) => Math.min(CAPTURE_R_MAX, Math.max(CAPTURE_R_MIN, Math.round(v)));
  const sizes = [...new Set((Array.isArray(c.sizes) ? c.sizes : []).map(Number).filter(Number.isFinite).map(clampR))].sort((a, b) => a - b).slice(0, CAPTURE_SIZES_MAX);
  const last = Number(c.last);
  return {
    shortcut: isAccelerator(c.shortcut) ? c.shortcut.trim() : DEFAULT_CAPTURE.shortcut,
    sizes: sizes.length ? sizes : DEFAULT_CAPTURE.sizes.slice(),
    last: Number.isFinite(last) ? clampR(last) : DEFAULT_CAPTURE.last,
    comment: c.comment !== false,
  };
}

// 数（数字の文字列も）なら四捨五入して min〜max に収める。数でなければ null
function zoomPct(v, min, max) {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : null;
}

// 登録はいつも6つ（枠の順のまま。おかしな枠は既定の値）。固定はハニカム 4〜150・グラフ 20〜250 の整数か null
function normalizeZoom(raw) {
  const z = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const list = Array.isArray(z.presets) ? z.presets : [];
  const presets = DEFAULT_ZOOM.presets.map((d, i) => zoomPct(list[i], ZOOM_PCT_MIN, ZOOM_PCT_MAX) ?? d);
  const lock = z.lock && typeof z.lock === 'object' ? z.lock : {};
  return {
    presets,
    lock: {
      grid: zoomPct(lock.grid, ZOOM_PCT_MIN, ZOOM_PCT_MAX),
      graph: zoomPct(lock.graph, ZOOM_GRAPH_MIN, ZOOM_GRAPH_MAX),
    },
    overviewClick: OVERVIEW_CLICKS.has(z.overviewClick) ? z.overviewClick : DEFAULT_ZOOM.overviewClick,
  };
}

function normalizeToday(raw) {
  const t = raw && typeof raw === 'object' ? raw : {};
  const int = (v, min, max, d) => (Number.isInteger(Number(v)) ? Math.min(max, Math.max(min, Number(v))) : d);
  return {
    count: int(t.count, 1, 9, DEFAULT_TODAY.count),
    source: TODAY_SOURCES.has(t.source) ? t.source : DEFAULT_TODAY.source,
    startup: t.startup === true,
    aiCount: int(t.aiCount, 5, 50, DEFAULT_TODAY.aiCount),
  };
}

function normalizeVoice(raw) {
  const v = raw && typeof raw === 'object' ? raw : {};
  return {
    method: VOICE_METHODS.has(v.method) ? v.method : DEFAULT_VOICE.method,
    lang: typeof v.lang === 'string' && /^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})*$/.test(v.lang) ? v.lang : DEFAULT_VOICE.lang,
    command: typeof v.command === 'string' ? [...v.command.replace(/[\r\n]+/g, ' ').trim()].slice(0, 600).join('') : '',
    auto: v.auto !== false,
    place: VOICE_PLACES.has(v.place) ? v.place : DEFAULT_VOICE.place,
  };
}

function normalizeTray(raw) {
  const t = raw && typeof raw === 'object' ? raw : {};
  return { enabled: t.enabled !== false };
}

function newTagSetId() {
  return `s${Math.random().toString(16).slice(2, 10).padEnd(8, '0')}`;
}

// 名前が無ければ「セット n」。枠は9つに揃え、同じタグが2つあれば後の方を空きにする
function normalizeTagSets(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  const ids = new Set();
  for (const raw of list) {
    if (out.length >= MAX_TAG_SETS) break;
    if (!raw || typeof raw !== 'object') continue;
    let id = typeof raw.id === 'string' && TAG_SET_ID_RE.test(raw.id) ? raw.id : '';
    while (!id || ids.has(id)) id = newTagSetId();
    ids.add(id);
    const src = Array.isArray(raw.tags) ? raw.tags : [];
    const seen = new Set();
    const tags = Array.from({ length: TAG_SET_SLOTS }, (_, i) => {
      const t = normalizeTag(src[i]);
      if (!t || seen.has(t)) return '';
      seen.add(t);
      return t;
    });
    out.push({ id, name: cleanName(raw.name, TAG_SET_NAME_MAX) || `セット ${out.length + 1}`, tags });
  }
  return out;
}

function newSavedSearchId() {
  return `q${Math.random().toString(16).slice(2, 10).padEnd(8, '0')}`;
}

function normalizeSavedSearches(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  const ids = new Set();
  for (const raw of list) {
    if (out.length >= MAX_SAVED_SEARCHES) break;
    if (!raw || typeof raw !== 'object') continue;
    const query = cleanText(raw.query, 200).replace(/\s+/g, ' ').trim();
    const tags = [...new Set((Array.isArray(raw.tags) ? raw.tags : []).map(normalizeTag).filter(Boolean))].slice(0, 20);
    const region = cleanName(raw.region, 40);
    if (!query && !tags.length && !region) continue; // 何も絞らない検索は残さない
    let id = typeof raw.id === 'string' && SAVED_SEARCH_ID_RE.test(raw.id) ? raw.id : '';
    while (!id || ids.has(id)) id = newSavedSearchId();
    ids.add(id);
    const item = {
      id,
      name: cleanName(raw.name, 40) || query || tags.map((t) => `#${t}`).join(' ') || region,
      query,
      tags,
      sort: SEARCH_SORTS.has(raw.sort) ? raw.sort : 'relevance',
      scope: raw.scope === 'all' ? 'all' : 'board',
    };
    if (region) item.region = region;
    out.push(item);
  }
  return out;
}

// 今使っているセット：無い ID なら最初のセット（セットが無ければ ''）
function normalizeTagSetActive(id, sets) {
  return typeof id === 'string' && sets.some((x) => x.id === id) ? id : sets.length ? sets[0].id : '';
}

function normalizeSettings(raw) {
  const s = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const tagSets = normalizeTagSets(s.tagSets);
  return {
    version: SETTINGS_VERSION,
    tags: normalizeTagEntries(s.tags),
    linkKinds: normalizeLinkKinds(s.linkKinds),
    quickInput: normalizeQuick(s.quickInput),
    notify: normalizeNotify(s.notify),
    footprints: normalizeFootprintsPref(s.footprints),
    templates: normalizeTemplates(s.templates),
    capture: normalizeCapture(s.capture),
    tray: normalizeTray(s.tray),
    tagSets,
    tagSetActive: normalizeTagSetActive(s.tagSetActive, tagSets),
    savedSearches: normalizeSavedSearches(s.savedSearches),
    today: normalizeToday(s.today),
    voice: normalizeVoice(s.voice),
    zoom: normalizeZoom(s.zoom),
    overviewViewOnly: s.overviewViewOnly === true,
  };
}

// よく使うタグ（使った回数の多い順。同じなら最近使った順、同じなら登録順）
function topTags(settings, n = TOP_TAGS) {
  const list = settings.tags.map((t, i) => ({ t, i }));
  list.sort((a, b) => (b.t.uses || 0) - (a.t.uses || 0) || (Date.parse(b.t.lastUsedAt || 0) || 0) - (Date.parse(a.t.lastUsedAt || 0) || 0) || a.i - b.i);
  return list.slice(0, n).map((x) => x.t);
}

// 設定に無いタグを登録に加える（AI のタグ付けの読み込み・新しいタグを付けたとき）。足したタグの名前を返す
function registerTags(settings, names) {
  const added = [];
  const have = new Set(settings.tags.map((t) => t.name));
  for (const raw of names) {
    const name = normalizeTag(raw);
    if (!name || have.has(name) || settings.tags.length >= MAX_TAG_ENTRIES) continue;
    have.add(name);
    settings.tags.push({ name, color: TAG_PALETTE[settings.tags.length % TAG_PALETTE.length], uses: 0 });
    added.push(name);
  }
  return added;
}

class SettingsStore {
  constructor(dir) {
    this.dir = dir;
    this.file = path.join(dir, SETTINGS_FILE);
    this.current = normalizeSettings(null);
    this.loaded = false;
  }

  load() {
    const res = readJsonFile(this.file);
    this.current = normalizeSettings(res.status === 'ok' ? res.value : null);
    this.loaded = true;
    return this.current;
  }

  get() {
    if (!this.loaded) this.load();
    return this.current;
  }

  // patch の項目（tags・linkKinds・quickInput）だけを入れ替えて保存する
  update(patch) {
    const cur = this.get();
    const p = patch && typeof patch === 'object' ? patch : {};
    const next = normalizeSettings({
      tags: 'tags' in p ? p.tags : cur.tags,
      linkKinds: 'linkKinds' in p ? p.linkKinds : cur.linkKinds,
      quickInput: 'quickInput' in p ? { ...cur.quickInput, ...(p.quickInput || {}) } : cur.quickInput,
      notify: 'notify' in p ? { ...cur.notify, ...(p.notify || {}) } : cur.notify,
      footprints: 'footprints' in p ? { ...cur.footprints, ...(p.footprints || {}) } : cur.footprints,
      templates: 'templates' in p ? p.templates : cur.templates,
      capture: 'capture' in p ? { ...cur.capture, ...(p.capture || {}) } : cur.capture,
      tray: 'tray' in p ? { ...cur.tray, ...(p.tray || {}) } : cur.tray,
      tagSets: 'tagSets' in p ? p.tagSets : cur.tagSets,
      tagSetActive: 'tagSetActive' in p ? p.tagSetActive : cur.tagSetActive,
      savedSearches: 'savedSearches' in p ? p.savedSearches : cur.savedSearches,
      today: 'today' in p ? { ...cur.today, ...(p.today || {}) } : cur.today,
      voice: 'voice' in p ? { ...cur.voice, ...(p.voice || {}) } : cur.voice,
      // 登録（presets）は丸ごと入れ替え、固定（lock）はハニカム・グラフの片方だけでも渡せる
      zoom: 'zoom' in p ? { ...cur.zoom, ...(p.zoom || {}), lock: { ...cur.zoom.lock, ...((p.zoom && p.zoom.lock) || {}) } } : cur.zoom,
      overviewViewOnly: 'overviewViewOnly' in p ? p.overviewViewOnly === true : cur.overviewViewOnly === true,
    });
    this.current = next;
    this.save();
    return next;
  }

  save() {
    writeFileAtomic(this.file, `${JSON.stringify(this.current, null, 2)}\n`);
  }
}

module.exports = {
  SettingsStore, normalizeSettings, normalizeTagEntry, normalizeLinkKinds, isAccelerator, acceleratorKey, normalizeQuick, topTags, registerTags,
  normalizeTemplates, normalizeTemplate, topTemplates, newTemplateId, normalizeCapture, normalizeTray, normalizeTagSets, newTagSetId, normalizeSavedSearches, normalizeToday, DEFAULT_TODAY, normalizeVoice, DEFAULT_VOICE,
  normalizeZoom, DEFAULT_ZOOM, ZOOM_PCT_MIN, ZOOM_PCT_MAX, ZOOM_GRAPH_MIN, ZOOM_GRAPH_MAX,
  DEFAULT_LINK_KINDS, DEFAULT_QUICK, DEFAULT_NOTIFY, DEFAULT_FOOTPRINTS, DEFAULT_CAPTURE, DEFAULT_TRAY, TAG_PALETTE, SETTINGS_FILE, TOP_TAGS, TOP_TEMPLATES,
  MAX_TEMPLATES, MAX_TEMPLATE_CELLS, CAPTURE_R_MIN, CAPTURE_R_MAX, MAX_TAG_SETS, TAG_SET_SLOTS,
};
