'use strict';

/* ブラウザ版（iPad など）を dist-web/ に組み立てる：node scripts/build-web.js [出力先]
 * デスクトップ版と同じ画面（index.html・renderer.js・styles.css・hex.js・urls.js・ribbon.js）に、
 *   ・ブラウザ用の窓口（web/web-api.js）と、保存領域の上のファイル置き場（web/web-fs.js）・zip の読み書き（web/zipper.js）
 *   ・デスクトップ版と同じ保存の仕組み（boards.js・store.js・attachments.js・urls.js を1つにまとめた node-modules.js）
 *   ・ホーム画面に追加するための manifest・アイコン、オフラインで開くための sw.js
 * を加える。できたフォルダを https のサイト（または同じ Wi-Fi の PC、scripts/serve-web.js）に置けば、iPad の Safari で開ける。 */

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { crc32 } = require('../zip');

const root = path.resolve(__dirname, '..');
const out = path.resolve(process.argv[2] || path.join(root, 'dist-web'));

const COPY = ['renderer.js', 'styles.css', 'hex.js', 'urls.js', 'ribbon.js', 'send.js', 'pocket.js', 'voice.js', 'web/web-fs.js', 'web/zipper.js', 'web/web-api.js'];
const MODULES = ['urls', 'pocket', 'store', 'boards', 'attachments', 'send', 'sendbox', 'settings']; // node-modules.js にまとめる（require の名前）

// ---- index.html：ブラウザ用の設定と、窓口のスクリプトを加える ----
function buildIndex() {
  let html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const replace = (from, to) => {
    if (!html.includes(from)) throw new Error(`index.html に「${from}」が見つかりません`);
    html = html.replace(from, to);
  };
  // 添付ファイルは blob: の URL（hm-att: はデスクトップ版だけ）。オフライン用の sw.js・manifest を許す
  replace("img-src 'self' data: blob: hm-att:;", "img-src 'self' data: blob:; connect-src 'self' blob:; worker-src 'self'; manifest-src 'self';");
  replace('<meta charset="utf-8">', [
    '<meta charset="utf-8">',
    // maximum-scale=1：入力欄を押したときに画面全体が拡大されないように（拡大縮小はハニカムのピンチで）
    '  <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, viewport-fit=cover">',
    '  <meta name="apple-mobile-web-app-capable" content="yes">',
    '  <meta name="mobile-web-app-capable" content="yes">',
    '  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">',
    '  <meta name="apple-mobile-web-app-title" content="六角メモ">',
    '  <meta name="theme-color" content="#0a0d12">',
    '  <link rel="manifest" href="manifest.webmanifest">',
    '  <link rel="icon" href="icon.svg" type="image/svg+xml">',
    '  <link rel="apple-touch-icon" href="icon-180.png">',
  ].join('\n'));
  replace('<script src="renderer.js"></script>', [
    '<script src="web-fs.js"></script>',
    '  <script src="zipper.js"></script>',
    '  <script src="node-modules.js"></script>',
    '  <script src="web-api.js"></script>',
    '  <script src="renderer.js"></script>',
  ].join('\n'));
  return html;
}

// ---- node-modules.js：require('./boards') などをブラウザで使えるように1つにまとめる ----
// fs・path・crypto は web-fs.js の代わりのものを渡す
function buildModules() {
  const defs = MODULES.map((name) => {
    const src = fs.readFileSync(path.join(root, `${name}.js`), 'utf8');
    return `  defs[${JSON.stringify(name)}] = function (module, exports, require) {\n${src}\n  };`;
  });
  return `/* 自動生成（scripts/build-web.js）：デスクトップ版の ${MODULES.map((m) => `${m}.js`).join('・')} をブラウザで使うためのまとめ。直接編集しないこと */
(function (root) {
  'use strict';
  const defs = {};
  const cache = {};
  function require(name) {
    const bare = String(name).replace(/^node:/, '');
    if (bare === 'fs' || bare === 'path' || bare === 'crypto') return root.HexWebFs[bare];
    const key = bare.replace(/^\\.\\//, '').replace(/\\.js$/, '');
    if (!defs[key]) throw new Error('まとめに含まれていないモジュールです: ' + name);
    if (!cache[key]) {
      const module = { exports: {} };
      cache[key] = module;
      defs[key].call(module.exports, module, module.exports, require);
    }
    return cache[key].exports;
  }
${defs.join('\n')}
  root.HexNode = { require };
})(typeof self !== 'undefined' ? self : globalThis);
`;
}

// ---- アイコン（ホーム画面用の PNG と SVG）：六角形 ----
function hexPath(cx, cy, r) {
  return Array.from({ length: 6 }, (_, k) => {
    const a = (Math.PI / 180) * (60 * k - 90);
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
  });
}

function pointInConvex(poly, x, y) {
  let sign = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x1, y1] = poly[i];
    const [x2, y2] = poly[(i + 1) % poly.length];
    const c = (x2 - x1) * (y - y1) - (y2 - y1) * (x - x1);
    if (c !== 0) {
      if (sign === 0) sign = Math.sign(c);
      else if (Math.sign(c) !== sign) return false;
    }
  }
  return true;
}

function distToPoly(poly, x, y) {
  let best = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const [x1, y1] = poly[i];
    const [x2, y2] = poly[(i + 1) % poly.length];
    const dx = x2 - x1;
    const dy = y2 - y1;
    const t = Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / (dx * dx + dy * dy)));
    best = Math.min(best, Math.hypot(x - (x1 + t * dx), y - (y1 + t * dy)));
  }
  return best;
}

const BG = [14, 19, 26];
const ACCENT = [29, 155, 240];
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);

function iconPng(size) {
  const outer = hexPath(size / 2, size / 2, size * 0.34);
  const inner = hexPath(size / 2, size / 2, size * 0.13);
  const stroke = size * 0.055;
  const fill = mix(BG, ACCENT, 0.16);
  const px = Buffer.alloc(size * size * 4);
  const S = 4; // 4×4 の点で縁をなめらかに
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let acc = [0, 0, 0];
      for (let sy = 0; sy < S; sy++) {
        for (let sx = 0; sx < S; sx++) {
          const fx = x + (sx + 0.5) / S;
          const fy = y + (sy + 0.5) / S;
          let c = BG;
          if (pointInConvex(outer, fx, fy)) c = fill;
          if (distToPoly(outer, fx, fy) <= stroke / 2) c = ACCENT;
          if (pointInConvex(inner, fx, fy)) c = ACCENT;
          acc = acc.map((v, i) => v + c[i]);
        }
      }
      const o = (y * size + x) * 4;
      px[o] = Math.round(acc[0] / (S * S));
      px[o + 1] = Math.round(acc[1] / (S * S));
      px[o + 2] = Math.round(acc[2] / (S * S));
      px[o + 3] = 255;
    }
  }
  const rows = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) px.copy(rows, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // 8 ビット
  ihdr[9] = 6; // RGBA
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(rows, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

function iconSvg() {
  const pts = (poly) => poly.map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join(' ');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" rx="22" fill="rgb(${BG})"/>`
    + `<polygon points="${pts(hexPath(50, 50, 34))}" fill="rgb(${mix(BG, ACCENT, 0.16).map(Math.round)})" stroke="rgb(${ACCENT})" stroke-width="5.5" stroke-linejoin="round"/>`
    + `<polygon points="${pts(hexPath(50, 50, 13))}" fill="rgb(${ACCENT})"/></svg>\n`;
}

// ---- 組み立て ----
function build() {
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  const files = {};
  files['index.html'] = buildIndex();
  for (const f of COPY) files[path.basename(f)] = fs.readFileSync(path.join(root, f));
  files['node-modules.js'] = buildModules();
  files['manifest.webmanifest'] = `${JSON.stringify({
    name: '六角メモ',
    short_name: '六角メモ',
    description: '無限のハニカムに想いを置く — 六角形のマスに書くメモ（ブラウザ版）',
    start_url: './',
    scope: './',
    display: 'standalone',
    background_color: '#0a0d12',
    theme_color: '#0a0d12',
    lang: 'ja',
    icons: [
      { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
      { src: 'icon.svg', sizes: 'any', type: 'image/svg+xml' },
    ],
  }, null, 2)}\n`;
  files['icon.svg'] = iconSvg();
  for (const size of [180, 192, 512]) files[`icon-${size}.png`] = iconPng(size);

  // オフライン用：この版のファイルを覚えておく（中身が変われば版も変わり、次に開いたときに入れ替わる）
  const names = Object.keys(files).sort();
  const version = crypto.createHash('sha256').update(names.map((n) => `${n}\0${files[n].length}\0`).join('')).update(Buffer.concat(names.map((n) => Buffer.from(files[n])))).digest('hex').slice(0, 12);
  const sw = fs.readFileSync(path.join(root, 'web/sw.js'), 'utf8')
    .replace('__VERSION__', version)
    .replace('__FILES__', JSON.stringify(['./', ...names]));
  files['sw.js'] = sw;

  for (const [name, data] of Object.entries(files)) fs.writeFileSync(path.join(out, name), data);
  return { out, files: Object.keys(files).length, version };
}

if (require.main === module) {
  const res = build();
  console.log(`ブラウザ版を組み立てました：${res.out}（${res.files} ファイル・版 ${res.version}）`);
}

module.exports = { build, buildIndex, buildModules, iconPng, COPY, MODULES };
