'use strict';

/* ブラウザのブックマーク（Chrome・Edge・Firefox の「HTML に書き出し」形式）の読み込み。
 * フォルダはノートのツリーに、ブックマークはそのノートの六角形のマスに（中心から渦巻き状に）並べる。 */

const crypto = require('node:crypto');
const { decodeEntities } = require('./linkmeta');
const { isWebUrl } = require('./urls');

const MAX_TITLE = 280;

// { title, folders: [...], items: [{ title, url, addedAt }] } の木にする
function parseBookmarksHtml(html) {
  const root = { title: '', folders: [], items: [] };
  const stack = [root];
  let pending = null; // <H3> の直後の <DL> が、そのフォルダの中身
  const re = /<(h3)\b([^>]*)>([\s\S]*?)<\/h3\s*>|<(a)\b([^>]*)>([\s\S]*?)<\/a\s*>|<(\/?)dl\b[^>]*>/gi;
  let m;
  while ((m = re.exec(String(html || '')))) {
    const cur = stack[stack.length - 1];
    if (m[1]) {
      pending = { title: text(m[3]) || '（名前のないフォルダ）', folders: [], items: [] };
      cur.folders.push(pending);
    } else if (m[4]) {
      const attrs = attrsOf(m[5]);
      const url = decodeEntities(attrs.href || '').trim();
      if (!isWebUrl(url)) continue; // javascript: や chrome:// などは読まない
      const sec = Number(attrs.add_date);
      cur.items.push({
        title: text(m[6]) || url,
        url,
        addedAt: Number.isFinite(sec) && sec > 0 ? new Date(sec * 1000).toISOString() : null,
      });
    } else if (m[7] === '/') {
      if (stack.length > 1) stack.pop();
    } else {
      stack.push(pending || cur); // フォルダの見出しが無い <DL>（いちばん外側）は、今のフォルダのまま
      pending = null;
    }
  }
  return root;
}

function text(html) {
  const t = decodeEntities(String(html).replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
  return [...t].slice(0, MAX_TITLE).join('');
}

function attrsOf(s) {
  const out = {};
  for (const m of String(s).matchAll(/([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) out[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? '';
  return out;
}

// 中心 (0,0) から近い周の順に、各周は右上を起点に時計回り（貼り付けの並びと同じ）
function spiralKeys(n) {
  const keys = [];
  for (let ring = 0; keys.length < n; ring++) {
    const cells = [];
    for (let q = -ring; q <= ring; q++) {
      for (let r = Math.max(-ring, -q - ring); r <= Math.min(ring, -q + ring); r++) {
        if ((Math.abs(q) + Math.abs(r) + Math.abs(q + r)) / 2 !== ring) continue;
        const x = Math.sqrt(3) * (q + r / 2);
        const y = 1.5 * r;
        cells.push({ key: `${q},${r}`, angle: (Math.atan2(x, -y) + 2 * Math.PI) % (2 * Math.PI) });
      }
    }
    cells.sort((a, b) => a.angle - b.angle);
    for (const c of cells) {
      keys.push(c.key);
      if (keys.length >= n) break;
    }
  }
  return keys;
}

function recordFor(item, now) {
  const t = item.addedAt || now;
  return {
    text: item.title,
    createdAt: t,
    updatedAt: t,
    likedLevel: 0,
    liked: false,
    bookmarked: false,
    comments: [],
    urls: [{ id: crypto.randomUUID(), url: item.url, title: item.title, addedAt: now }],
  };
}

// 作るノートの一覧（親が先）。maxDepth より深いフォルダの中身は、その上のノートに「フォルダ名 › 」を付けて入れる
function planImport(tree, { rootName = 'ブックマーク', maxDepth = 9, now = new Date().toISOString() } = {}) {
  const notebooks = [];
  let count = 0;
  const flatten = (folder, prefix) => {
    const items = folder.items.map((it) => ({ ...it, title: `${prefix}${it.title}` }));
    for (const f of folder.folders) items.push(...flatten(f, `${prefix}${f.title} › `));
    return items;
  };
  const hasAny = (f) => f.items.length > 0 || f.folders.some(hasAny);
  const add = (folder, name, parent, depth) => {
    const index = notebooks.length;
    const items = [...folder.items];
    const nb = { name, parent, memos: {} };
    notebooks.push(nb);
    for (const f of folder.folders) {
      if (!hasAny(f)) continue;
      if (depth + 1 > maxDepth) items.push(...flatten(f, `${f.title} › `));
      else add(f, f.title, index, depth + 1);
    }
    const keys = spiralKeys(items.length);
    items.forEach((it, i) => {
      nb.memos[keys[i]] = recordFor(it, now);
    });
    count += items.length;
  };
  add(tree, rootName, null, 0);
  return { notebooks, bookmarks: count };
}

module.exports = { parseBookmarksHtml, planImport, spiralKeys };
