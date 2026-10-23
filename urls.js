/* URL まわりの小さな道具（リンクの添付・本文のリンク・マスへのリンク）
 * レンダラでは window.HexUrls、Node（メインプロセス・テスト）では module.exports として使う。 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.HexUrls = api;
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  const MAX_URL = 2048;
  const INTERNAL_SCHEME = 'hexmemo:';
  const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

  // 貼り付けたときに外す、追跡用の付加情報
  const TRACKING = [/^utm_/i, /^fbclid$/i, /^gclid$/i, /^dclid$/i, /^msclkid$/i, /^igshid$/i, /^mc_(cid|eid)$/i, /^_hsenc$/i, /^_hsmi$/i, /^yclid$/i, /^twclid$/i];
  const YT_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be', 'www.youtu.be']);
  const X_HOSTS = new Set(['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com', 'mobile.twitter.com', 'mobile.x.com']);

  function parse(url) {
    try {
      return new URL(url);
    } catch {
      return null;
    }
  }

  // 開いてよい・保存してよい Web の URL（http / https だけ）
  function isWebUrl(text) {
    if (typeof text !== 'string' || text.length > MAX_URL) return false;
    const u = parse(text.trim());
    return !!u && (u.protocol === 'http:' || u.protocol === 'https:') && !!u.hostname;
  }

  // 貼り付けた文字が URL 1つだけか（前後の空白は無視）。http(s) なら 'web'、マスへのリンクなら 'memo'
  function classifyPasted(text) {
    if (typeof text !== 'string') return null;
    const t = text.trim();
    if (!t || /\s/.test(t) || t.length > MAX_URL) return null;
    if (isWebUrl(t)) return 'web';
    if (parseInternalLink(t)) return 'memo';
    return null;
  }

  // 追跡用の付加情報を外す（YouTube の共有用 si、X の s / t も）。読めなければそのまま返す
  function stripTracking(url) {
    const u = parse(url);
    if (!u || !u.search) return url;
    const host = u.hostname.toLowerCase();
    const drop = [];
    for (const key of u.searchParams.keys()) {
      if (TRACKING.some((re) => re.test(key))) drop.push(key);
      else if (YT_HOSTS.has(host) && key === 'si') drop.push(key);
      else if (X_HOSTS.has(host) && (key === 's' || key === 't')) drop.push(key);
    }
    if (!drop.length) return url;
    for (const key of drop) u.searchParams.delete(key);
    return u.toString();
  }

  // ---- YouTube ----

  // "754" "754s" "12m34s" "1h2m3s" "12:34" "1:02:03" → 秒。読めなければ null
  function parseTime(value) {
    if (value === null || value === undefined) return null;
    const s = String(value).trim().toLowerCase();
    if (!s) return null;
    if (/^\d+$/.test(s)) return Number(s);
    if (/^\d+s$/.test(s)) return Number(s.slice(0, -1));
    let m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(s);
    if (m && (m[1] || m[2] || m[3])) return Number(m[1] || 0) * 3600 + Number(m[2] || 0) * 60 + Number(m[3] || 0);
    m = /^(?:(\d+):)?(\d{1,2}):(\d{1,2})$/.exec(s);
    if (m) return Number(m[1] || 0) * 3600 + Number(m[2]) * 60 + Number(m[3]);
    return null;
  }

  function formatTime(sec) {
    const s = Math.max(0, Math.floor(sec));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const r = s % 60;
    const pad = (n) => String(n).padStart(2, '0');
    return h ? `${h}:${pad(m)}:${pad(r)}` : `${m}:${pad(r)}`;
  }

  const YT_ID_RE = /^[A-Za-z0-9_-]{6,20}$/;

  // YouTube の動画なら { id, start }（start は再生位置の秒。無ければ null）
  function youtubeInfo(url) {
    const u = parse(url);
    if (!u || !YT_HOSTS.has(u.hostname.toLowerCase())) return null;
    let id = null;
    if (u.hostname.toLowerCase().endsWith('youtu.be')) id = u.pathname.split('/')[1] || null;
    else if (u.pathname === '/watch') id = u.searchParams.get('v');
    else {
      const m = /^\/(?:shorts|live|embed|v)\/([^/?#]+)/.exec(u.pathname);
      if (m) id = m[1];
    }
    if (!id || !YT_ID_RE.test(id)) return null;
    const start = parseTime(u.searchParams.get('t') ?? u.searchParams.get('start'));
    return { id, start };
  }

  // 再生位置を付け直した URL（sec が null なら外す）
  function withYoutubeStart(url, sec) {
    const u = parse(url);
    if (!u || !youtubeInfo(url)) return url;
    u.searchParams.delete('start');
    if (sec === null || sec === undefined || !(sec > 0)) u.searchParams.delete('t');
    else u.searchParams.set('t', `${Math.floor(sec)}s`);
    return u.toString();
  }

  // ---- 同じページかどうか（自動の関連付けに使う） ----

  // 大文字小文字・www・末尾の / ・#以降・追跡用の付加情報・引数の順番の違いを無視する。
  // YouTube は動画ごと（再生位置が違っても同じ動画）
  function pageKey(url) {
    const yt = youtubeInfo(url);
    if (yt) return `youtube:${yt.id}`;
    const u = parse(stripTracking(url));
    if (!u || !(u.protocol === 'http:' || u.protocol === 'https:')) return null;
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    const port = u.port && !((u.protocol === 'http:' && u.port === '80') || (u.protocol === 'https:' && u.port === '443')) ? `:${u.port}` : '';
    const pathname = u.pathname.replace(/\/+$/, '') || '';
    const params = [...u.searchParams.entries()].sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1));
    const query = params.length ? `?${params.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&')}` : '';
    return `${host}${port}${pathname}${query}`;
  }

  // ---- 表示 ----

  function hostOf(url) {
    const u = parse(url);
    return u ? u.hostname.replace(/^www\./, '') : '';
  }

  // 見た目の似た文字を使った国際化ドメイン（xn--）か
  function isSuspiciousHost(url) {
    const u = parse(url);
    return !!u && u.hostname.split('.').some((label) => label.startsWith('xn--'));
  }

  // 本文に出す短い形：example.com/path…（max 文字まで）
  function shortUrl(url, max = 36) {
    const u = parse(url);
    if (!u) return url;
    let s = `${u.hostname.replace(/^www\./, '')}${u.pathname === '/' ? '' : decodeSafe(u.pathname)}${u.search ? decodeSafe(u.search) : ''}`;
    if ([...s].length > max) s = `${[...s].slice(0, max - 1).join('')}…`;
    return s;
  }

  function decodeSafe(s) {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  }

  // 本文の中の URL（http(s):// と hexmemo://）を見つける。末尾の句読点・閉じかっこは含めない
  const URL_IN_TEXT = /(?:https?:\/\/|hexmemo:\/\/)[^\s<>"'`「」『』（）【】、。，．]+/g;
  const TRAIL = /[.,;:!?)\]}'"。、．，！？）」』】>]+$/;

  function findUrls(text) {
    const out = [];
    if (typeof text !== 'string' || !text.includes('://')) return out;
    URL_IN_TEXT.lastIndex = 0;
    let m;
    while ((m = URL_IN_TEXT.exec(text))) {
      let url = m[0];
      // 対応するかっこが中にある「(...)」は残す（Wikipedia の URL など）
      while (TRAIL.test(url)) {
        const last = url[url.length - 1];
        if (last === ')' && (url.match(/\(/g) || []).length >= (url.match(/\)/g) || []).length) break;
        url = url.slice(0, -1);
      }
      if (!url.endsWith('://') && url.length > 10) out.push({ index: m.index, url });
    }
    return out;
  }

  // ---- マスへのリンク（hexmemo://memo/<メモID>?b=<ノートID>&a=<メモアプリID>） ----

  function makeInternalLink({ memoId, boardId, appId = null }) {
    const q = new URLSearchParams();
    if (boardId) q.set('b', boardId);
    if (appId) q.set('a', appId);
    return `hexmemo://memo/${memoId}${q.toString() ? `?${q}` : ''}`;
  }

  function parseInternalLink(text) {
    const u = parse(typeof text === 'string' ? text.trim() : '');
    if (!u || u.protocol !== INTERNAL_SCHEME || u.hostname !== 'memo') return null;
    const memoId = u.pathname.replace(/^\//, '');
    if (!ID_RE.test(memoId)) return null;
    const boardId = u.searchParams.get('b');
    const appId = u.searchParams.get('a');
    return {
      memoId,
      boardId: boardId && /^[a-z0-9]{1,32}$/.test(boardId) ? boardId : null,
      appId: appId && /^[a-z0-9]{1,32}$/.test(appId) ? appId : null,
    };
  }

  return {
    MAX_URL, isWebUrl, classifyPasted, stripTracking, parseTime, formatTime, youtubeInfo, withYoutubeStart,
    pageKey, hostOf, isSuspiciousHost, shortUrl, findUrls, makeInternalLink, parseInternalLink,
  };
});
