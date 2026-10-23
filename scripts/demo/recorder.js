'use strict';

/* デモ動画・画面イメージを作るための道具（開発用。アプリには含めない）。
 * ブラウザ版（dist-web/）を小さなサーバーで開き、サンプルノートを読み込んで、Playwright で操作する。
 * 録画は Chrome の画面の配信（CDP の Page.startScreencast）を受け取り、時刻に合わせて同じ1枚を繰り返して
 * 一定のコマ数（既定 30fps）にそろえ、ffmpeg（H.264）に流して mp4 にする。
 * 使うもの：Playwright（npm i -D playwright か、環境に入っているもの）と ffmpeg。 */

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..', '..');

function loadPlaywright() {
  const tries = [process.env.PLAYWRIGHT_MODULE, 'playwright', '/opt/node22/lib/node_modules/playwright'].filter(Boolean);
  for (const t of tries) {
    try {
      return require(t);
    } catch {
      // 次の場所を試す
    }
  }
  throw new Error('Playwright が見つかりません（npm i -D playwright か、PLAYWRIGHT_MODULE で場所を指定）');
}

// ブラウザ版を開くサーバー（scripts/serve-web.js を別のポートで）
async function startServer(port) {
  if (!fs.existsSync(path.join(ROOT, 'dist-web', 'index.html'))) throw new Error('先に npm run build:web を実行してください');
  const child = spawn(process.execPath, [path.join(ROOT, 'scripts', 'serve-web.js'), '--port', String(port)], { stdio: 'ignore' });
  const url = `http://localhost:${port}/`;
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) return { url, stop: () => child.kill() };
    } catch {
      // まだ立ち上がっていない
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  child.kill();
  throw new Error('サーバーが立ち上がりませんでした');
}

const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

class Demo {
  constructor(page) {
    this.page = page;
    this.mouse = { x: 640, y: 420 };
  }

  wait(ms) {
    return this.page.waitForTimeout(ms);
  }

  // マウスを滑らかに動かす（矢印が見えるように、少しずつ）
  async moveTo(x, y, ms = 520) {
    const from = { ...this.mouse };
    const steps = Math.max(6, Math.round(ms / 16));
    for (let i = 1; i <= steps; i++) {
      const t = ease(i / steps);
      await this.page.mouse.move(from.x + (x - from.x) * t, from.y + (y - from.y) * t);
      await this.page.waitForTimeout(ms / steps);
    }
    this.mouse = { x, y };
  }

  async box(target) {
    const loc = typeof target === 'string' ? this.page.locator(target).first() : target;
    await loc.waitFor({ state: 'visible', timeout: 8000 });
    await loc.scrollIntoViewIfNeeded().catch(() => {});
    return loc.boundingBox();
  }

  async moveToEl(target, { dx = 0.5, dy = 0.5, ms = 520 } = {}) {
    const b = await this.box(target);
    const x = b.x + b.width * dx;
    const y = b.y + b.height * dy;
    await this.moveTo(x, y, ms);
    return { x, y, b };
  }

  async click(target, { button = 'left', dx, dy, ms, pause = 140, clickCount = 1 } = {}) {
    const { x, y } = await this.moveToEl(target, { dx, dy, ms });
    await this.wait(pause);
    await this.page.mouse.click(x, y, { button, clickCount, delay: 70 });
  }

  rightClick(target, opts = {}) {
    return this.click(target, { ...opts, button: 'right' });
  }

  async type(text, delay = 55) {
    await this.page.keyboard.type(text, { delay });
  }

  async press(key, label = null) {
    if (label) await this.page.evaluate((l) => window.__demo.key(l), label);
    await this.page.keyboard.press(key);
  }

  caption(step, text, sub = '', opts = {}) {
    return this.page.evaluate(([s, t, u, o]) => window.__demo.caption(s, t, u, o), [step, text, sub, opts]);
  }

  title(head, sub = '', chips = []) {
    return this.page.evaluate(([h, s, c]) => window.__demo.title(h, s, c), [head, sub, chips]);
  }

  async spot(target, pad = 8) {
    const b = target ? await this.box(target) : null;
    await this.page.evaluate(([r, p]) => window.__demo.spot(r, p), [b, pad]);
  }

  raise() {
    return this.page.evaluate(() => window.__demo.raise());
  }
}

// 画面の配信を受け取り、一定のコマ数で ffmpeg に流す
class Recorder {
  constructor(page, { fps = 30, width = 1920, height = 1200, quality = 88 } = {}) {
    Object.assign(this, { page, fps, width, height, quality });
    this.cdp = null;
    this.ff = null;
    this.prev = null;
    this.t0 = 0;
    this.written = 0;
    this.paused = false;
  }

  async start(out) {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    this.out = out;
    this.ff = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(this.fps), '-c:v', 'mjpeg', '-i', '-',
      '-vf', `scale=${this.width}:${this.height}:flags=lanczos`, '-c:v', 'libx264', '-preset', 'medium', '-crf', '21', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', out], { stdio: ['pipe', 'inherit', 'inherit'] });
    this.done = new Promise((resolve, reject) => {
      this.ff.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg が失敗しました（${code}）`))));
    });
    this.cdp = await this.page.context().newCDPSession(this.page);
    this.cdp.on('Page.screencastFrame', ({ data, metadata, sessionId }) => {
      this.cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
      this.frame(Buffer.from(data, 'base64'), metadata.timestamp);
    });
    await this.cdp.send('Page.startScreencast', { format: 'jpeg', quality: this.quality, maxWidth: this.width, maxHeight: this.height, everyNthFrame: 1 });
  }

  // 前の1枚を、今の時刻までのコマ数だけ繰り返して書く
  flushTo(t) {
    if (!this.prev) return;
    const target = Math.floor((t - this.t0) * this.fps);
    while (this.written < target) {
      this.ff.stdin.write(this.prev);
      this.written++;
    }
  }

  frame(buf, t) {
    if (this.paused) return;
    if (!this.prev) this.t0 = t;
    this.flushTo(t);
    this.prev = buf;
  }

  async stop() {
    this.flushTo(Date.now() / 1000);
    if (this.prev && this.written === 0) this.ff.stdin.write(this.prev);
    await this.cdp.send('Page.stopScreencast').catch(() => {});
    this.ff.stdin.end();
    await this.done;
    return { out: this.out, seconds: this.written / this.fps };
  }
}

// サンプルノートを読み込む（ブラウザ版の「データの読み込み」と同じ zip にして渡す）。設定（タグの登録など）も
async function seed(page, sample) {
  await page.evaluate(async ({ name, store, settings }) => {
    const index = { version: 1, activeId: 'main', boards: [{ id: 'main', name, file: 'memos.json' }] };
    const entries = [
      { name: 'hexmemo-app.json', data: JSON.stringify({ format: 'hexmemo-app', version: 1, name: '六角メモ' }) },
      { name: 'boards.json', data: JSON.stringify(index) },
      { name: 'memos.json', data: JSON.stringify(store) },
    ];
    const file = new File([window.HexZip.createZip(entries)], 'demo.hexmemo-app.zip', { type: 'application/zip' });
    const res = await window.hexMemo.importData(file);
    if (!res.ok) throw new Error(res.error);
    const set = await window.hexMemo.setSettings(settings || {});
    if (!set.ok) throw new Error(set.error);
  }, sample);
  await page.reload();
  await page.waitForSelector('.cell');
  await page.waitForTimeout(1200);
}

// ブラウザを開く。font：日本語の字形の揃ったフォント（この環境では IPA P ゴシック）を画面の文字に使う
async function openApp({ port = 8790, width = 1280, height = 800, scale = 1.5, font = 'IPAPGothic' } = {}) {
  const { chromium } = loadPlaywright();
  const server = await startServer(port);
  const browser = await chromium.launch({ args: ['--font-render-hinting=none'] });
  const context = await browser.newContext({
    viewport: { width, height }, deviceScaleFactor: scale, bypassCSP: true, locale: 'ja-JP', timezoneId: 'Asia/Tokyo', colorScheme: 'dark', acceptDownloads: true,
  });
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: server.url.replace(/\/$/, '') });
  await context.addInitScript({ path: path.join(__dirname, 'overlay.js') });
  if (font) {
    await context.addInitScript((f) => {
      document.addEventListener('DOMContentLoaded', () => {
        const s = document.createElement('style');
        s.textContent = `:root { --font: "${f}", sans-serif !important; } body, button, input, textarea, select { font-family: "${f}", sans-serif; }`;
        document.head.append(s);
      });
    }, font);
  }
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.goto(server.url);
  await page.waitForSelector('.cell');
  return {
    page, context, errors, demo: new Demo(page),
    close: async () => {
      await browser.close();
      server.stop();
    },
  };
}

// マスの場所（"1, 0" のような表示）から、そのマスを指す
const cellAt = (page, coord) => page.locator('.cell').filter({ has: page.locator('.meta-coord', { hasText: new RegExp(`^${coord.replace(/[()]/g, '\\$&')}$`) }) });

module.exports = { openApp, seed, Recorder, Demo, cellAt, loadPlaywright, ROOT };
