/* ブラウザ版のオフライン用（scripts/build-web.js が版とファイルの一覧を埋め込む）。
 * ネットにつながっていれば新しいファイルを使い（そのたびに覚え直す）、つながらなければ覚えておいたファイルで開く。
 * メモの中身はここではなく、ブラウザの保存領域（IndexedDB）にある。 */
'use strict';

const CACHE = 'hexmemo-__VERSION__';
const FILES = __FILES__;

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k.startsWith('hexmemo-') && k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin) return;
  e.respondWith(fetch(e.request)
    .then((res) => {
      if (res.ok) {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
      }
      return res;
    })
    .catch(() => caches.match(e.request, { ignoreSearch: true }).then((hit) => hit || caches.match('./'))));
});
