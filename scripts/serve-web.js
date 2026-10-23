'use strict';

/* ブラウザ版（dist-web/）を手元で開くための小さなサーバー：node scripts/serve-web.js [--port 8787] [--lan] [--dir dist-web]
 * ふつうはこの PC だけ（http://localhost:8787）。--lan を付けると同じ Wi-Fi の iPad からも開ける（http なので、
 * オフラインで開く・システムのクリップボード・共有シートは使えない。本番は https のサイトに置く）。 */

const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const port = Number(opt('--port', 8787));
const lan = args.includes('--lan');
const dir = path.resolve(opt('--dir', path.join(__dirname, '..', 'dist-web')));

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml',
};

if (!fs.existsSync(path.join(dir, 'index.html'))) {
  console.error(`${dir} にブラウザ版がありません。先に npm run build:web を実行してください。`);
  process.exit(1);
}

const server = http.createServer((req, res) => {
  let rel;
  try {
    rel = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    // 「/%」のような壊れたアドレスで、サーバーごと止まらないように
    res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('アドレスが正しくありません');
    return;
  }
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.join(dir, path.normalize(rel).replace(/^([/\\])+/, ''));
  if (!file.startsWith(dir) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('見つかりません');
    return;
  }
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
  fs.createReadStream(file).pipe(res);
});

server.listen(port, lan ? '0.0.0.0' : '127.0.0.1', () => {
  console.log(`ブラウザ版を開けます：http://localhost:${port}/`);
  if (lan) {
    for (const list of Object.values(os.networkInterfaces())) {
      for (const a of list || []) if (a.family === 'IPv4' && !a.internal) console.log(`  同じ Wi-Fi の iPad から：http://${a.address}:${port}/`);
    }
  }
});
