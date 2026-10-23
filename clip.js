'use strict';

/* マスのコピー＆ペースト用のクリップボード形式。
 * 本文はふつうのテキストとして、マスの中身（いいね・コメント・周りのメモ）は HTML 形式の
 * data 属性に埋め込む。ほかのアプリには本文だけが貼り付き、別のメモアプリどうしでは
 * マスごと貼り付けられる。 */

const ATTR = 'data-hex-memo';

function escapeHtml(text) {
  return String(text).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
}

function encodeClipHtml(text, payload) {
  const b64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
  return `<div ${ATTR}="${b64}">${escapeHtml(text).replace(/\r?\n/g, '<br>')}</div>`;
}

// 読めなければ null（ふつうの HTML や壊れたデータ）
function decodeClipHtml(html) {
  const m = new RegExp(`${ATTR}="([A-Za-z0-9+/=]+)"`).exec(html || '');
  if (!m) return null;
  try {
    const payload = JSON.parse(Buffer.from(m[1], 'base64').toString('utf8'));
    return payload && typeof payload === 'object' && payload.record ? payload : null;
  } catch {
    return null;
  }
}

// 複数のマス（records）と、それぞれの位置（offsets：左上のマスからの差 { dq, dr }）を、検査を通ったものだけ組にする。
// 位置は、全部そろっていて重なりが無いときだけ返す（無ければ null。貼り付けは近くの空いているマスへ1件ずつ）
const OFFSET_MAX = 10000;
function clipCells(payload, normalize, max) {
  const raws = Array.isArray(payload && payload.records) ? payload.records.slice(0, max) : [];
  const offs = Array.isArray(payload && payload.offsets) && payload.offsets.length >= raws.length ? payload.offsets : null;
  const okOffset = (o) => !!o && Number.isInteger(o.dq) && Number.isInteger(o.dr) && Math.abs(o.dq) <= OFFSET_MAX && Math.abs(o.dr) <= OFFSET_MAX;
  const cells = [];
  const offsets = [];
  raws.forEach((raw, i) => {
    const rec = normalize(raw);
    if (!rec) return;
    cells.push(rec);
    offsets.push(offs && okOffset(offs[i]) ? { dq: offs[i].dq, dr: offs[i].dr } : null);
  });
  const keep = offsets.length > 0 && offsets.every(Boolean) && new Set(offsets.map((o) => `${o.dq},${o.dr}`)).size === offsets.length;
  return { cells, offsets: keep ? offsets : null };
}

module.exports = { encodeClipHtml, decodeClipHtml, clipCells };
