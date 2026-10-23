'use strict';

/* リンク先の情報（タイトル・説明・サイト名・代表画像・ファビコン）の取得と、リンク切れの確認。
 * 通信は fetchImpl（Electron では net.fetch）で行い、文字だけを取り出して返す。
 * ページの HTML やスクリプトを画面に入れることはない。 */

const { isWebUrl } = require('./urls');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 hex-memo';
const HTML_LIMIT = 1536 * 1024;
const IMAGE_LIMIT = 5 * 1024 * 1024;
const ICON_LIMIT = 512 * 1024;
const TIMEOUT = 8000;

// 本文を上限まで読む（それ以上は読まずに切る）
async function fetchLimited(fetchImpl, url, { method = 'GET', maxBytes = HTML_LIMIT, timeoutMs = TIMEOUT, headers = {} } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      method,
      redirect: 'follow',
      signal: ctrl.signal,
      headers: { 'User-Agent': UA, 'Accept-Language': 'ja,en;q=0.8', ...headers },
    });
    const chunks = [];
    let size = 0;
    if (method !== 'HEAD' && res.body && maxBytes > 0) {
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(Buffer.from(value));
        size += value.length;
        if (size >= maxBytes) {
          try {
            await reader.cancel();
          } catch {
            // 読み切らずに切るだけ
          }
          break;
        }
      }
    }
    return { res, buf: Buffer.concat(chunks).subarray(0, maxBytes), url: res.url || url };
  } finally {
    clearTimeout(timer);
  }
}

// ---- HTML から情報を取り出す ----

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };

function decodeEntities(s) {
  return String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

const clean = (s, max) => {
  const t = decodeEntities(String(s || '')).replace(/\s+/g, ' ').trim();
  return [...t].length > max ? `${[...t].slice(0, max - 1).join('')}…` : t;
};

function parseAttrs(tag) {
  const attrs = {};
  const re = /([^\s=/>"']+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g;
  let m;
  while ((m = re.exec(tag))) attrs[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? '';
  return attrs;
}

// 文字コード：Content-Type → <meta charset> → 既定の UTF-8
function decodeHtml(buf, contentType = '') {
  let label = (/charset\s*=\s*["']?([\w-]+)/i.exec(contentType) || [])[1];
  if (!label) {
    const head = buf.subarray(0, 4096).toString('latin1');
    label = (/<meta[^>]+charset\s*=\s*["']?([\w-]+)/i.exec(head) || [])[1];
  }
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) label = 'utf-8';
  try {
    return new TextDecoder(label || 'utf-8').decode(buf);
  } catch {
    return new TextDecoder('utf-8').decode(buf);
  }
}

function absolute(href, base) {
  if (!href) return null;
  try {
    const u = new URL(decodeEntities(href.trim()), base);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString() : null;
  } catch {
    return null;
  }
}

function parseMeta(html, baseUrl) {
  const endHead = html.search(/<\/head\s*>/i);
  const head = endHead > 0 ? html.slice(0, endHead) : html.slice(0, 300 * 1024);
  const meta = {};
  for (const m of head.matchAll(/<meta\b[^>]*>/gi)) {
    const a = parseAttrs(m[0]);
    const key = (a.property || a.name || a.itemprop || '').toLowerCase();
    if (key && a.content !== undefined && meta[key] === undefined) meta[key] = a.content;
  }
  const titleTag = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(head);
  const icons = [];
  for (const m of head.matchAll(/<link\b[^>]*>/gi)) {
    const a = parseAttrs(m[0]);
    const rel = (a.rel || '').toLowerCase().split(/\s+/);
    if (!rel.includes('icon') && !rel.includes('apple-touch-icon') && !rel.includes('shortcut')) continue;
    const href = absolute(a.href, baseUrl);
    if (!href) continue;
    const size = Number((/(\d+)x\d+/.exec(a.sizes || '') || [])[1]) || 0;
    // 小さな画面の表示に向く 32px 前後・PNG を優先
    const score = (rel.includes('icon') ? 100 : 50) - Math.abs((size || 32) - 32) + (/\.png(\?|$)/i.test(href) ? 5 : 0) - (/\.svg(\?|$)/i.test(href) ? 200 : 0);
    icons.push({ href, score });
  }
  icons.sort((x, y) => y.score - x.score);
  const pick = (...keys) => {
    for (const k of keys) if (meta[k]) return meta[k];
    return '';
  };
  return {
    title: clean(pick('og:title', 'twitter:title') || (titleTag ? titleTag[1] : ''), 300),
    description: clean(pick('og:description', 'twitter:description', 'description'), 1000),
    siteName: clean(pick('og:site_name', 'application-name', 'twitter:site'), 120),
    image: absolute(pick('og:image:secure_url', 'og:image:url', 'og:image', 'twitter:image', 'twitter:image:src'), baseUrl),
    icon: icons.length ? icons[0].href : absolute('/favicon.ico', baseUrl),
  };
}

// ---- 取得 ----

// putFile(buf, kinds) で画像を保存し、ファイル名を返す関数（添付ファイルの保存）を受け取る
async function fetchPreview(url, { fetchImpl = globalThis.fetch, putFile = null, timeoutMs = TIMEOUT } = {}) {
  if (!isWebUrl(url)) throw new Error('http / https の URL だけ取得できます');
  const { res, buf, url: finalUrl } = await fetchLimited(fetchImpl, url, {
    timeoutMs,
    headers: { Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5' },
  });
  if (!res.ok) throw new Error(`ページを取得できませんでした（${res.status}）`);
  const type = (res.headers.get('content-type') || '').toLowerCase();
  const out = { url: finalUrl, title: '', description: '', siteName: '', favicon: null, image: null };
  const fileName = () => {
    try {
      return decodeURIComponent(new URL(finalUrl).pathname.split('/').pop() || '');
    } catch {
      return '';
    }
  };
  if (type.startsWith('image/')) {
    // 画像そのものの URL
    out.title = fileName();
    if (putFile) out.image = await safePut(putFile, buf, ['png', 'jpg', 'gif', 'webp']);
    return out;
  }
  if (!type.includes('html') && !type.includes('xml')) {
    out.title = fileName();
    return out;
  }
  const meta = parseMeta(decodeHtml(buf, type), finalUrl);
  out.title = meta.title;
  out.description = meta.description;
  out.siteName = meta.siteName;
  if (putFile) {
    const [image, favicon] = await Promise.all([
      meta.image ? fetchFile(fetchImpl, meta.image, IMAGE_LIMIT, timeoutMs).then((b) => b && safePut(putFile, b, ['png', 'jpg', 'gif', 'webp'])) : null,
      meta.icon ? fetchFile(fetchImpl, meta.icon, ICON_LIMIT, timeoutMs).then((b) => b && safePut(putFile, b, ['png', 'jpg', 'gif', 'webp', 'ico'])) : null,
    ]);
    out.image = image || null;
    out.favicon = favicon || null;
  }
  return out;
}

async function fetchFile(fetchImpl, url, limit, timeoutMs) {
  try {
    const { res, buf } = await fetchLimited(fetchImpl, url, { maxBytes: limit + 1, timeoutMs, headers: { Accept: 'image/*,*/*;q=0.5' } });
    if (!res.ok || buf.length > limit || !buf.length) return null;
    return buf;
  } catch {
    return null;
  }
}

async function safePut(putFile, buf, kinds) {
  try {
    return putFile(buf, kinds) || null;
  } catch {
    return null;
  }
}

// ---- リンク切れの確認 ----

// { status: 'ok' | 'broken' | 'error', code }：broken はページが無い（404・410・ドメインが無い）、error は確かめられなかった
async function checkLink(url, { fetchImpl = globalThis.fetch, timeoutMs = TIMEOUT } = {}) {
  if (!isWebUrl(url)) return { status: 'broken', code: 0 };
  const judge = (code) => (code >= 200 && code < 400 ? 'ok' : code === 404 || code === 410 ? 'broken' : 'error');
  let code = 0;
  try {
    const { res } = await fetchLimited(fetchImpl, url, { method: 'HEAD', maxBytes: 0, timeoutMs });
    code = res.status;
    // HEAD を受け付けないサーバーもあるので、そのときは GET で確かめ直す
    if (code === 405 || code === 403 || code === 501 || code === 400) {
      const again = await fetchLimited(fetchImpl, url, { maxBytes: 1024, timeoutMs, headers: { Range: 'bytes=0-1023' } });
      code = again.res.status;
    }
    return { status: judge(code), code };
  } catch (err) {
    const msg = `${err && err.message} ${err && err.cause && (err.cause.code || err.cause.message)}`;
    if (/NAME_NOT_RESOLVED|ENOTFOUND|EAI_AGAIN|ADDRESS_UNREACHABLE/i.test(msg)) return { status: 'broken', code: 0 };
    return { status: 'error', code };
  }
}

async function checkLinks(urls, opts = {}, concurrency = 4) {
  const out = new Array(urls.length);
  let next = 0;
  const worker = async () => {
    while (next < urls.length) {
      const i = next++;
      out[i] = { url: urls[i], ...(await checkLink(urls[i], opts)) };
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, urls.length) }, worker));
  return out;
}

module.exports = { parseMeta, decodeHtml, decodeEntities, fetchPreview, checkLink, checkLinks, fetchLimited, UA };
