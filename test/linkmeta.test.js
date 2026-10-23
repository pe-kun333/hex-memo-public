'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const L = require('../linkmeta.js');

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

test('HTML から OGP・タイトル・ファビコンを取り出す（属性の順番・実体参照・相対パス）', () => {
  const html = `<!doctype html><html><head>
    <meta content="記事の&quot;タイトル&quot;" property="og:title">
    <meta name="description" content="説明 &amp; 補足&#x3002;">
    <meta property='og:site_name' content='サイト'>
    <meta property="og:image" content="/img/card.png">
    <link rel="stylesheet" href="/a.css">
    <link rel="icon" href="/favicon.svg" type="image/svg+xml">
    <link rel="icon" href="/fav-32.png" sizes="32x32">
    <title>別のタイトル</title></head><body><meta property="og:title" content="本文の中は見ない"></body></html>`;
  const m = L.parseMeta(html, 'https://example.com/post/1');
  assert.equal(m.title, '記事の"タイトル"');
  assert.equal(m.description, '説明 & 補足。');
  assert.equal(m.siteName, 'サイト');
  assert.equal(m.image, 'https://example.com/img/card.png');
  assert.equal(m.icon, 'https://example.com/fav-32.png'); // SVG より PNG を優先
});

test('OGP が無ければ <title>、アイコンが無ければ /favicon.ico', () => {
  const m = L.parseMeta('<html><head><title>\n  ただの  タイトル </title></head></html>', 'http://ex.com/a/b');
  assert.equal(m.title, 'ただの タイトル');
  assert.equal(m.icon, 'http://ex.com/favicon.ico');
  assert.equal(m.image, null);
});

test('文字コード：Content-Type と <meta charset>（Shift_JIS）', () => {
  const sjis = Buffer.from([0x3c, 0x6d, 0x65, 0x74, 0x61, 0x20, 0x63, 0x68, 0x61, 0x72, 0x73, 0x65, 0x74, 0x3d, 0x22, 0x53, 0x68, 0x69, 0x66, 0x74, 0x5f, 0x4a, 0x49, 0x53, 0x22, 0x3e, 0x93, 0xfa, 0x96, 0x7b]);
  assert.ok(L.decodeHtml(sjis, 'text/html').endsWith('日本'));
  assert.ok(L.decodeHtml(Buffer.from('日本', 'utf8'), 'text/html; charset=utf-8').endsWith('日本'));
});

// ---- ローカルのサーバーで取得・リンク切れの確認 ----

function serve(routes) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const route = routes[req.url.split('?')[0]];
      if (!route) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('not found');
        return;
      }
      route(req, res);
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` }));
  });
}

test('ページの情報・代表画像・ファビコンを取得し、画像は保存関数に渡す', async () => {
  const { server, base } = await serve({
    '/page': (req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<html><head><meta property="og:title" content="テストページ"><meta property="og:image" content="/card.png"><link rel="icon" href="/icon.png"></head><body>x</body></html>');
    },
    '/moved': (req, res) => {
      res.writeHead(301, { Location: '/page' });
      res.end();
    },
    '/card.png': (req, res) => {
      res.writeHead(200, { 'Content-Type': 'image/png' });
      res.end(PNG);
    },
    '/icon.png': (req, res) => {
      res.writeHead(200, { 'Content-Type': 'image/png' });
      res.end(PNG);
    },
    '/photo.png': (req, res) => {
      res.writeHead(200, { 'Content-Type': 'image/png' });
      res.end(PNG);
    },
  });
  try {
    const saved = [];
    const putFile = (buf, kinds) => {
      saved.push(kinds.join('/'));
      return `file-${saved.length}`;
    };
    const p = await L.fetchPreview(`${base}/moved`, { putFile });
    assert.equal(p.url, `${base}/page`); // 転送先
    assert.equal(p.title, 'テストページ');
    assert.ok(p.image && p.favicon);
    assert.equal(saved.length, 2);
    const img = await L.fetchPreview(`${base}/photo.png`, { putFile });
    assert.equal(img.title, 'photo.png');
    assert.ok(img.image);
    await assert.rejects(L.fetchPreview(`${base}/nothing`, { putFile }), /404/);
    await assert.rejects(L.fetchPreview('file:///C:/x', { putFile }), /http/);
  } finally {
    server.close();
  }
});

test('リンク切れの確認：開ける・無い（404）・確かめられない（500・時間切れ）', async () => {
  const { server, base } = await serve({
    '/ok': (req, res) => {
      res.writeHead(200);
      res.end('ok');
    },
    '/nohead': (req, res) => {
      res.writeHead(req.method === 'HEAD' ? 405 : 200);
      res.end();
    },
    '/err': (req, res) => {
      res.writeHead(500);
      res.end();
    },
    '/gone': (req, res) => {
      res.writeHead(410);
      res.end();
    },
    '/slow': () => {}, // 返事をしない
  });
  try {
    const r = await L.checkLinks([`${base}/ok`, `${base}/nohead`, `${base}/missing`, `${base}/gone`, `${base}/err`, `${base}/slow`], { timeoutMs: 800 });
    assert.deepEqual(r.map((x) => x.status), ['ok', 'ok', 'broken', 'broken', 'error', 'error']);
    assert.equal(r[2].code, 404);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});
