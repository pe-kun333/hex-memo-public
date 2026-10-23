'use strict';

/* メインプロセス：ウィンドウ、メニュー、IPC、永続化 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn, exec: execCommand } = require('node:child_process');
const { app, BrowserWindow, clipboard, desktopCapturer, dialog, globalShortcut, ipcMain, Menu, nativeImage, net, Notification, protocol, screen, shell, systemPreferences, Tray } = require('electron');
const { BoardManager, MAX_TREE_DEPTH } = require('./boards');
const { normalizeRecord, MAX_DEPTH } = require('./store');
const { encodeClipHtml, decodeClipHtml, clipCells } = require('./clip');
const { AppRegistry, validateAppName, MAIN_NAME, ID_RE } = require('./apps');
const { AttachmentStore, IMAGE_EXTS, collectRecordRefs, collectStoreRefs, collectDirRefs } = require('./attachments');
const { fetchPreview, checkLinks, UA } = require('./linkmeta');
const { parseBookmarksHtml, planImport } = require('./bookmarks');
const { createZip } = require('./zip');
const { isWebUrl, parseInternalLink } = require('./urls');
const HS = require('./send');
const SB = require('./sendbox');
const { SettingsStore, isAccelerator } = require('./settings');
const Voice = require('./voice'); // 文字起こしの結果を読む（音声で入力）

if (process.env.HEX_MEMO_DISABLE_GPU === '1') app.disableHardwareAcceleration();

// 添付した画像を画面に見せる専用の読み込み口（hm-att://file/<ファイル名>）。準備完了より前に登録する
const ATT_SCHEME = 'hm-att';
protocol.registerSchemesAsPrivileged([{ scheme: ATT_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } }]);

// データフォルダ。productName が日本語でもパスは ASCII にしておく。
// HEX_MEMO_DATA_DIR（または HEX_MEMO_HOME）を指定すると別フォルダで起動できる（検証・持ち運び用）。
const root = process.env.HEX_MEMO_HOME
  ? path.resolve(process.env.HEX_MEMO_HOME)
  : process.env.HEX_MEMO_DATA_DIR
    ? path.resolve(process.env.HEX_MEMO_DATA_DIR)
    : path.join(app.getPath('appData'), 'hex-memo');

// 別のメモアプリ（起動ファイル「名前.cmd」から開いたもの）は、apps/<ID>/ にデータを分けて持つ。
// 保存先ごとに多重起動の判定も分かれるので、複数のメモアプリを同時に開ける
const appId = ID_RE.test(process.env.HEX_MEMO_APP_ID || '') ? process.env.HEX_MEMO_APP_ID : null;
const dataDir = appId ? new AppRegistry(root).dataDir(appId) : root;
app.setPath('userData', dataDir);

// アプリの名前：別のメモアプリは起動ファイルの名前（変えればアプリ名も変わる）
function resolveAppName() {
  if (!appId) return MAIN_NAME;
  const fromLauncher = validateAppName(process.env.HEX_MEMO_APP_NAME || '');
  if (fromLauncher.ok) return fromLauncher.name;
  const entry = new AppRegistry(root).load().get(appId);
  return entry ? entry.name : 'メモアプリ';
}
const appName = resolveAppName();
// 新しく作る起動ファイルの置き場所（既定はアプリのフォルダ＝六角メモ.cmd と同じ場所）
const launcherDir = process.env.HEX_MEMO_LAUNCHER_DIR ? path.resolve(process.env.HEX_MEMO_LAUNCHER_DIR) : __dirname;

const isMac = process.platform === 'darwin';
const indexPath = path.join(__dirname, 'index.html');
const boards = new BoardManager(dataDir);
const attachments = new AttachmentStore(dataDir);
const settings = new SettingsStore(dataDir); // タグの登録・関連線の種類・クイック入力
// 開いているウィンドウ。1つのメモアプリ（同じデータ）を複数のウィンドウで開ける。
// どのウィンドウも同じノートのファイルを扱うので、保存したら同じノートを開いているほかのウィンドウへ知らせる
const windows = new Set();
let lastFocused = null;

// そのウィンドウの画面（webContents）が、このアプリのウィンドウならそのウィンドウ
function ourWindow(wc) {
  const win = wc ? BrowserWindow.fromWebContents(wc) : null;
  return win && windows.has(win) ? win : null;
}

// 前面のウィンドウ（無ければ最後に使ったウィンドウ）
function activeWindow() {
  const focused = BrowserWindow.getFocusedWindow();
  if (focused && windows.has(focused)) return focused;
  if (lastFocused && windows.has(lastFocused) && !lastFocused.isDestroyed()) return lastFocused;
  return windows.values().next().value || null;
}

// ほかのウィンドウへ知らせる（except のウィンドウには送らない）
function broadcast(channel, payload, except = null) {
  for (const win of windows) {
    if (win !== except && !win.isDestroyed()) win.webContents.send(channel, payload);
  }
}

// 常に最前面に表示（ウィンドウごと）。メニューのチェックは前面のウィンドウに合わせる
function setOnTop(win, flag) {
  if (!win || win.isDestroyed()) return false;
  win.setAlwaysOnTop(!!flag);
  win.webContents.send('window:on-top', win.isAlwaysOnTop());
  syncWindowMenu(win);
  return win.isAlwaysOnTop();
}

function syncWindowMenu(win = activeWindow()) {
  const menu = Menu.getApplicationMenu();
  const item = menu && menu.getMenuItemById('always-on-top');
  if (item && win && !win.isDestroyed()) item.checked = win.isAlwaysOnTop();
}

// マスへのリンク（hexmemo://）から起動されたとき・ほかのプロセスから渡されたときの行き先。画面の準備ができたら渡す
const LINK_PREFIX = 'hexmemo://';
// hexmemo://inbox は「コピーして送る」の合図（届いたものを取り込む）。マスへのリンクとしては扱わない
const linkFromArgv = (argv) => (Array.isArray(argv) ? argv.find((a) => typeof a === 'string' && a.startsWith(LINK_PREFIX) && !SB.isInboxArg(a)) : null) || null;
let pendingLink = linkFromArgv(process.argv);
// 受け渡しの合図だけで起動された（このアプリはまだ動いていなかった）：取り込んだら、画面を開かずに終わる
const inboxLaunch = process.argv.some(SB.isInboxArg) && !pendingLink;
let inboxQuitting = false;

// ---- テスト用の差し替え（本物のブラウザ・ファイル選択の画面を開かない） ----
const TEST_OPEN_LOG = process.env.HEX_MEMO_TEST_OPEN_LOG || null;

function openExternalSafe(url) {
  if (TEST_OPEN_LOG) return fs.appendFileSync(TEST_OPEN_LOG, `external ${url}\n`);
  return shell.openExternal(url);
}

function openPathSafe(abs) {
  if (TEST_OPEN_LOG) return fs.appendFileSync(TEST_OPEN_LOG, `path ${abs}\n`);
  return shell.openPath(abs);
}

async function pickOpenFile(options) {
  if (process.env.HEX_MEMO_TEST_PICK_FILE) return process.env.HEX_MEMO_TEST_PICK_FILE;
  const res = await dialog.showOpenDialog(activeWindow(), { properties: ['openFile'], ...options });
  return res.canceled || !res.filePaths.length ? null : res.filePaths[0];
}

async function pickSavePath(options) {
  if (process.env.HEX_MEMO_TEST_SAVE_DIR) return path.join(process.env.HEX_MEMO_TEST_SAVE_DIR, path.basename(options.defaultPath || 'file'));
  const res = await dialog.showSaveDialog(activeWindow(), options);
  return res.canceled || !res.filePath ? null : res.filePath;
}

// Windows のファイル名に使えない文字を置き換える
const safeFileName = (name) => String(name || 'ノート').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/[. ]+$/, '').slice(0, 80) || 'ノート';

// ---- 小窓：複製したウィンドウを、常に最前面・セル1個分（約 223×257）よりやや広い大きさで開く ----
// 画面の部分（ウィンドウの枠を除く）の大きさ。小窓ではタブ・ツールバーを隠し、ハニカムだけを見せる
const MINI_SIZE = { width: 270, height: 300 };
const MINI_MIN = { width: 160, height: 160 };
const NORMAL_MIN = { width: 720, height: 480 };
const NORMAL_SIZE = { width: 1280, height: 840 };
const STEP_RE = /^-?\d{1,7},-?\d{1,7}(?:@\d{1,2})?$/; // 階層の道筋の1段（マスのキー、重ねた層なら「@層の番号」付き）
const KEY_RE = /^-?\d{1,7},-?\d{1,7}$/;

// 小窓で最初に見せる場所（道筋 keys と、真ん中に置くマス key）。形の合わないものは使わない
function miniView(opts) {
  if (!opts || typeof opts !== 'object' || !opts.mini) return null;
  const keys = Array.isArray(opts.keys) && opts.keys.length <= MAX_DEPTH && opts.keys.every((k) => typeof k === 'string' && STEP_RE.test(k)) ? opts.keys : [];
  const key = typeof opts.key === 'string' && KEY_RE.test(opts.key) ? opts.key : null;
  return { keys, key };
}

const clampTo = (v, lo, hi) => Math.min(Math.max(v, lo), Math.max(lo, hi));

// 小窓の置き場所：元のウィンドウの右上の内側（ツールバーの下）。画面からはみ出さないように
function miniPlace(from) {
  const { width, height } = MINI_SIZE;
  const ok = from && !from.isDestroyed();
  const area = (ok ? screen.getDisplayMatching(from.getBounds()) : screen.getPrimaryDisplay()).workArea;
  let x = area.x + area.width - width - 40;
  let y = area.y + 80;
  if (ok && !from.isMinimized()) {
    const b = from.getContentBounds();
    x = b.x + b.width - width - 24;
    y = b.y + 96;
  }
  return {
    x: Math.round(clampTo(x, area.x, area.x + area.width - width - 16)),
    y: Math.round(clampTo(y, area.y, area.y + area.height - height - 48)),
    width,
    height,
  };
}

// boardId：開くノート（無ければ前回のノート）。from：そのウィンドウから少しずらした位置・同じ大きさで開く。
// mini（{ keys, key }）なら小窓：常に最前面・小さな大きさで、元のウィンドウの右上に開く
function createWindow({ boardId = null, from = null, mini = null } = {}) {
  const place = {};
  if (mini) {
    Object.assign(place, miniPlace(from));
  } else if (from && !from.isDestroyed() && !from.isMaximized() && !from.isFullScreen()) {
    const [x, y] = from.getPosition();
    const [width, height] = from.getSize();
    Object.assign(place, { x: x + 32, y: y + 32, width, height });
  }
  const win = new BrowserWindow({
    width: NORMAL_SIZE.width,
    height: NORMAL_SIZE.height,
    ...place,
    minWidth: mini ? MINI_MIN.width : NORMAL_MIN.width,
    minHeight: mini ? MINI_MIN.height : NORMAL_MIN.height,
    useContentSize: !!mini, // 小窓は画面の部分の大きさで決める（枠の分は外側に）
    alwaysOnTop: !!mini,
    title: appName,
    backgroundColor: '#0a0d12',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  win.hexInitialBoard = boardId;
  win.hexMini = mini;
  windows.add(win);
  win.once('ready-to-show', () => win.show());
  win.on('focus', () => {
    lastFocused = win;
    syncWindowMenu(win);
  });
  // ほかのアプリへ移ったり、最小化したりしたら、「キーで呼び出したところ」は終わり（次のキーはまた呼び出す）
  const endQuickSession = () => {
    win.hexQuickSession = false;
  };
  win.on('blur', endQuickSession);
  win.on('minimize', endQuickSession);
  win.on('hide', endQuickSession);
  win.on('always-on-top-changed', () => {
    if (!win.isDestroyed()) win.webContents.send('window:on-top', win.isAlwaysOnTop());
    syncWindowMenu();
  });
  win.on('closed', () => {
    windows.delete(win);
    if (lastFocused === win) lastFocused = null;
  });

  // アプリ外への遷移・新規ウィンドウは開かない（ファイルのドロップ等）
  const { webContents } = win;
  webContents.on('will-navigate', (event, url) => {
    if (url !== webContents.getURL()) event.preventDefault();
  });
  webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  // 入力欄の右クリックメニュー
  webContents.on('context-menu', (_event, params) => {
    if (!params.isEditable) return;
    const f = params.editFlags;
    Menu.buildFromTemplate([
      { role: 'undo', label: '元に戻す', enabled: f.canUndo },
      { role: 'redo', label: 'やり直す', enabled: f.canRedo },
      { type: 'separator' },
      { role: 'cut', label: '切り取り', enabled: f.canCut },
      { role: 'copy', label: 'コピー', enabled: f.canCopy },
      { role: 'paste', label: '貼り付け', enabled: f.canPaste },
      { type: 'separator' },
      { role: 'selectAll', label: 'すべて選択', enabled: f.canSelectAll },
    ]).popup({ window: win });
  });

  // アプリ名は最初の描画から出したいので、ページの読み込み時に渡す
  win.loadFile(indexPath, { query: { app: appName } });
  return win;
}

function buildMenu() {
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: 'ファイル',
      submenu: [
        { label: '新しいウィンドウ', accelerator: 'CommandOrControl+N', registerAccelerator: false, click: (_item, win) => sendCommand('new-window', win) },
        { type: 'separator' },
        { label: 'クイック入力（空いたマスにすぐ書く）', click: () => triggerQuickInput() },
        { label: 'クイック入力の設定（キー・書く場所）…', click: (_item, win) => sendCommand('quick-settings', win) },
        { type: 'separator' },
        { label: '六角形スクショ（画面を六角形に切り取って棚へ）', click: () => startHexCapture() },
        { label: '六角形スクショの設定（キー・大きさ・常駐）…', click: (_item, win) => sendCommand('capture-settings', win) },
        { type: 'separator' },
        { label: 'データフォルダを開く', click: () => shell.openPath(dataDir) },
        { type: 'separator' },
        { label: 'ブラウザのブックマークを読み込む…', click: (_item, win) => sendCommand('import-bookmarks') },
        { label: '使われていない画像を片付ける', click: (_item, win) => sendCommand('sweep-attachments') },
        { label: 'hexmemo:// のリンクをほかのアプリから開けるようにする', click: (_item, win) => sendCommand('register-protocol') },
        { type: 'separator' },
        isMac ? { role: 'close', label: '閉じる' } : { role: 'quit', label: '終了' },
      ],
    },
    {
      label: '編集',
      submenu: [
        // macOS は文字の入力欄のために役割（role）のまま（キーは先に画面に届き、入力欄の外なら画面がメモの操作を元に戻す）。
        // Windows・Linux はキーを画面に渡し、画面が「入力欄なら文字・それ以外ならメモの操作」を元に戻す
        ...(isMac ? [{ role: 'undo', label: '元に戻す' }, { role: 'redo', label: 'やり直す' }] : [
          { label: '元に戻す', accelerator: 'CommandOrControl+Z', registerAccelerator: false, click: (_item, win) => sendCommand('undo', win) },
          { label: 'やり直す', accelerator: 'CommandOrControl+Y', registerAccelerator: false, click: (_item, win) => sendCommand('redo', win) },
        ]),
        { type: 'separator' },
        { role: 'cut', label: '切り取り' },
        { role: 'copy', label: 'コピー' },
        { role: 'paste', label: '貼り付け' },
        { role: 'selectAll', label: 'すべて選択' },
      ],
    },
    {
      label: '表示',
      submenu: [
        // 画面全体ではなくハニカムを拡大縮小する（キー操作は画面側で受け取るので、ここでは表示だけ）
        { label: '全体を表示', accelerator: 'Shift+1', registerAccelerator: false, click: (_item, win) => sendCommand('zoom-fit') },
        { label: '拡大', accelerator: 'CommandOrControl+Plus', registerAccelerator: false, click: (_item, win) => sendCommand('zoom-in') },
        { label: '縮小', accelerator: 'CommandOrControl+-', registerAccelerator: false, click: (_item, win) => sendCommand('zoom-out') },
        { label: '100% に戻す', accelerator: 'CommandOrControl+0', registerAccelerator: false, click: (_item, win) => sendCommand('zoom-reset') },
        // 登録した倍率は Ctrl+Shift+1〜6（キーは画面側で受け取る）
        { label: '倍率の登録と固定…', click: (_item, win) => sendCommand('zoom-menu', win) },
        { type: 'separator' },
        { label: '関連付けの線を表示／隠す', accelerator: 'CommandOrControl+Shift+L', registerAccelerator: false, click: (_item, win) => sendCommand('toggle-links') },
        { label: '表紙の画像を表示／隠す', click: (_item, win) => sendCommand('toggle-covers') },
        { label: '縮小したときの1行の吹き出しを出す／隠す', click: (_item, win) => sendCommand('toggle-tips') },
        { label: '1行の吹き出しの設定（コメント・本文）…', click: (_item, win) => sendCommand('line-tips', win) },
        { type: 'separator' },
        { label: '検索（サイドバー）…', accelerator: 'CommandOrControl+F', registerAccelerator: false, click: (_item, win) => sendCommand('search', win) },
        { label: 'タグの登録…', click: (_item, win) => sendCommand('tag-settings', win) },
        { label: 'タグボタンのセット（棚の右クリック）…', click: (_item, win) => sendCommand('tag-sets', win) },
        { label: 'ゴミ箱（削除したメモ）', click: (_item, win) => sendCommand('trash', win) },
        { label: '今日の1枚（見直すメモ）', click: (_item, win) => sendCommand('today', win) },
        { label: '音声で入力…', accelerator: 'CommandOrControl+Shift+M', registerAccelerator: false, click: (_item, win) => sendCommand('voice', win) },
        { label: '画像・HTML で書き出す・印刷…', click: (_item, win) => sendCommand('export', win) },
        { label: '関連線の種類…', click: (_item, win) => sendCommand('link-kinds', win) },
        { label: '定型の登録（マスの配置の型）…', click: (_item, win) => sendCommand('templates', win) },
        { type: 'separator' },
        { id: 'always-on-top', label: '常に最前面に表示', type: 'checkbox', accelerator: 'CommandOrControl+Alt+T', registerAccelerator: false, click: (item, win) => setOnTop(win || activeWindow(), item.checked) },
        { role: 'togglefullscreen', label: '全画面表示' },
        { type: 'separator' },
        { role: 'reload', label: '再読み込み' },
        { role: 'toggleDevTools', label: '開発者ツール' },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function sendCommand(cmd, win = activeWindow()) {
  const target = win && windows.has(win) ? win : activeWindow();
  if (target && !target.isDestroyed()) target.webContents.send('view:command', cmd);
}

// ---- クイック入力：設定したキーで（ほかのアプリの前からでも）ウィンドウを前に出し、空いたマスにすぐ書く ----
// キーで呼び出したウィンドウが前にある間にもう一度同じキーを押すと（toggle）、最小化して元のアプリに戻る。
// 最小化する別のキー（hideShortcut）も登録できる
let quickRegistered = null;
let hideRegistered = null;

// 設定のキーをアプリの外からも効くように登録する。登録できなければ、そのわけ（アプリの中ではそのまま使える）
function applyQuickShortcut() {
  for (const acc of [quickRegistered, hideRegistered]) {
    if (!acc) continue;
    try {
      globalShortcut.unregister(acc);
    } catch {
      // 登録が無ければそれでよい
    }
  }
  quickRegistered = null;
  hideRegistered = null;
  const q = settings.get().quickInput;
  if (!q.global) return null;
  const errors = [];
  const register = (acc, fn, what) => {
    if (!isAccelerator(acc)) return false;
    try {
      if (globalShortcut.register(acc, fn)) return true;
      errors.push(`「${acc}」はほかのアプリが使っているため、アプリの外からは${what}（アプリの中では使えます）`);
    } catch (err) {
      errors.push(`「${acc}」を登録できませんでした：${err.message}`);
    }
    return false;
  };
  if (register(q.shortcut, () => triggerQuickInput(), '呼び出せません')) quickRegistered = q.shortcut;
  if (q.hideShortcut && register(q.hideShortcut, () => minimizeApp(), '最小化できません')) hideRegistered = q.hideShortcut;
  return errors.length ? errors.join('。') : null;
}

// ---- 六角形スクショ：設定したキーで、マウスのある画面を撮って六角形に切り取り、コメントを付けて未配置の棚へ ----
// 先に画面全体を撮り（自分の枠が写り込まないように）、その静止画を全画面の枠ウィンドウ（capture.html）に見せる。
// 枠はマウスに追従し、ホイール／ピンチで大きさを変える。クリックで切り取り、コメントを書いて本体へ。本体は添付に保存して、
// 前面のウィンドウ（無ければ新しく開く）のノートの棚へ渡す
let captureRegistered = null;
let captureWin = null;
let capturing = false;

function applyCaptureShortcut() {
  if (captureRegistered) {
    try {
      globalShortcut.unregister(captureRegistered);
    } catch {
      // 登録が無ければそれでよい
    }
    captureRegistered = null;
  }
  const c = settings.get().capture;
  if (!isAccelerator(c.shortcut)) return null;
  try {
    if (!globalShortcut.register(c.shortcut, () => startHexCapture())) {
      return `「${c.shortcut}」はほかのアプリが使っているため、アプリの外からは呼び出せません（アプリの中では使えます）`;
    }
  } catch (err) {
    return `「${c.shortcut}」を登録できませんでした：${err.message}`;
  }
  captureRegistered = c.shortcut;
  return null;
}

// 撮れなかったときなどの知らせ：ウィンドウがあればその画面に、無ければ OS の通知で
function captureNotice(message, level = 'warn') {
  const win = activeWindow();
  if (win && !win.isDestroyed() && win.isVisible()) win.webContents.send('app:notice', { level, message });
  else if (Notification.isSupported()) new Notification({ title: appName, body: message }).show();
}

function closeCaptureWin() {
  const win = captureWin;
  captureWin = null;
  if (win && !win.isDestroyed()) win.close();
}

async function startHexCapture() {
  if (captureWin && !captureWin.isDestroyed()) {
    captureWin.focus();
    return;
  }
  if (capturing) return;
  capturing = true;
  try {
    const cursor = screen.getCursorScreenPoint();
    const display = screen.getDisplayNearestPoint(cursor);
    const { bounds, scaleFactor } = display;
    if (isMac && systemPreferences.getMediaAccessStatus('screen') === 'denied') {
      captureNotice('六角形スクショ：画面収録が許可されていません。「システム設定」→「プライバシーとセキュリティ」→「画面収録」で許可してください', 'error');
      return;
    }
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: Math.round(bounds.width * scaleFactor), height: Math.round(bounds.height * scaleFactor) },
    });
    const src = sources.find((s) => String(s.display_id) === String(display.id)) || sources[0];
    const image = src ? src.thumbnail : null;
    if (!image || image.isEmpty()) {
      captureNotice('六角形スクショ：画面を取得できませんでした', 'error');
      return;
    }
    const size = image.getSize();
    const c = settings.get().capture;
    const win = new BrowserWindow({
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
      frame: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      hasShadow: false,
      enableLargerThanScreen: true,
      show: false,
      backgroundColor: '#000000',
      title: '六角形スクショ',
      webPreferences: {
        preload: path.join(__dirname, 'capture-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: false,
      },
    });
    captureWin = win;
    win.setMenuBarVisibility(false);
    win.setAlwaysOnTop(true, 'screen-saver');
    if (isMac) win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.on('closed', () => {
      if (captureWin === win) captureWin = null;
    });
    win.webContents.once('did-finish-load', () => {
      if (win.isDestroyed()) return;
      win.webContents.send('capture:frame', {
        png: image.toPNG(),
        width: bounds.width,
        height: bounds.height,
        pixelWidth: size.width,
        pixelHeight: size.height,
        cursor: { x: cursor.x - bounds.x, y: cursor.y - bounds.y },
        sizes: c.sizes,
        r: c.last,
        comment: c.comment,
      });
      win.show();
      win.focus();
    });
    await win.loadFile(path.join(__dirname, 'capture.html'));
  } catch (err) {
    console.error('[hex-memo] 六角形スクショ:', err);
    captureNotice(`六角形スクショ：${err.message}`, 'error');
  } finally {
    capturing = false;
  }
}

const fromCaptureWin = (event) => !!captureWin && !captureWin.isDestroyed() && BrowserWindow.fromWebContents(event.sender) === captureWin;

// 切り取った画像を棚へ：前面のウィンドウに渡す。無ければ開いて、読み込みが済んだところで渡す（boards:init）
function deliverCapture(payload) {
  let win = activeWindow();
  if (!win || win.isDestroyed()) {
    win = createWindow();
    win.hexPendingCapture = payload;
  } else {
    win.webContents.send('capture:shelf', payload);
  }
  if (Notification.isSupported()) {
    const n = new Notification({ title: appName, body: `六角形スクショを「未配置の棚」に置きました${payload.comment ? `：${payload.comment.slice(0, 60)}` : ''}`, silent: true });
    n.on('click', () => {
      const w = activeWindow();
      if (!w || w.isDestroyed()) return;
      if (w.isMinimized()) w.restore();
      w.show();
      w.focus();
      w.webContents.send('view:command', 'shelf');
    });
    n.show();
  }
}

function registerCaptureIpc() {
  ipcMain.handle('capture:done', (event, payload) => {
    if (!fromCaptureWin(event)) return { ok: false, error: 'unexpected sender' };
    try {
      const { png, comment, r } = payload || {};
      const buf = Buffer.from(png);
      const saved = attachments.put(buf, { kinds: IMAGE_EXTS });
      const img = nativeImage.createFromBuffer(buf);
      const sz = img.getSize();
      const image = { file: saved.file, type: saved.type, size: saved.size, name: '六角形スクショ.png', width: sz.width, height: sz.height };
      try {
        image.thumb = attachments.putThumb(saved.file, (sz.width > 480 ? img.resize({ width: 480 }) : img).toPNG());
      } catch (err) {
        console.warn('[hex-memo] 縮小版を保存できませんでした:', err);
      }
      const radius = Math.round(Number(r));
      if (Number.isFinite(radius)) broadcast('settings:changed', settings.update({ capture: { last: radius } }));
      deliverCapture({ image, comment: String(comment || ''), capturedAt: new Date().toISOString(), r: Number.isFinite(radius) ? radius : null });
      closeCaptureWin();
      return { ok: true };
    } catch (err) {
      console.error('[hex-memo] capture:done:', err);
      return { ok: false, error: err.message };
    }
  });
  ipcMain.handle('capture:cancel', (event) => {
    if (fromCaptureWin(event)) closeCaptureWin();
    return { ok: true };
  });
  ipcMain.handle('capture:save-size', (event, r) => {
    if (!fromCaptureWin(event)) return { ok: false, error: 'unexpected sender' };
    const cur = settings.get().capture;
    const s = settings.update({ capture: { sizes: [...cur.sizes, Math.round(Number(r))] } });
    broadcast('settings:changed', s);
    return { ok: true, sizes: s.capture.sizes };
  });
}

// ---- トレイに常駐：ウィンドウをすべて閉じても終了せず、トレイ（通知領域）から開ける。六角形スクショ・クイック入力のキーも効き続ける ----
let tray = null;
let quitting = false;

function trayIcon() {
  const { iconPng } = require('./scripts/build-web');
  return nativeImage.createFromBuffer(iconPng(32), { scaleFactor: 2 });
}

function showMainWindow() {
  const win = activeWindow() || [...windows].find((w) => !w.isDestroyed());
  if (!win) {
    createWindow();
    return;
  }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function quitApp() {
  quitting = true;
  app.quit();
}

function rebuildTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: `${appName} を開く`, click: () => showMainWindow() },
    { type: 'separator' },
    { label: '六角形スクショ（画面を六角形に切り取って棚へ）', click: () => startHexCapture() },
    { label: 'クイック入力（空いたマスにすぐ書く）', click: () => triggerQuickInput() },
    { type: 'separator' },
    {
      label: 'ウィンドウを閉じても常駐する',
      type: 'checkbox',
      checked: settings.get().tray.enabled,
      click: (item) => {
        broadcast('settings:changed', settings.update({ tray: { enabled: item.checked } }));
        applyTray();
      },
    },
    { type: 'separator' },
    { label: '終了', click: () => quitApp() },
  ]));
}

function applyTray() {
  const want = settings.get().tray.enabled;
  if (want && !tray) {
    try {
      tray = new Tray(trayIcon());
      tray.setToolTip(appName);
      tray.on('click', () => showMainWindow());
    } catch (err) {
      console.warn('[hex-memo] トレイを作れませんでした:', err);
      tray = null;
    }
  } else if (!want && tray) {
    tray.destroy();
    tray = null;
    if (!isMac && ![...windows].some((w) => !w.isDestroyed())) app.quit(); // 常駐をやめて、ウィンドウも無ければ終了
  }
  rebuildTrayMenu();
}

// ---- 期限の通知：期限が今日までで完了していないメモを、起動時と毎日の設定時刻に OS の通知で知らせる ----
let notifyTimer = 0;
let notifiedDay = '';
const localDay = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// すべてのノートから、期限が today まで（過ぎたものを含む）で完了していないメモ
function dueMemos(today) {
  const out = [];
  const walk = (memos, boardName) => {
    for (const rec of Object.values(memos || {})) {
      if (rec.due && rec.due <= today && !(rec.progress >= 6)) out.push({ board: boardName, text: rec.text, due: rec.due });
      for (const layer of [rec.children, ...(rec.moreLayers || [])]) if (layer) walk(layer.memos, boardName);
    }
  };
  for (const b of boards.list().boards) {
    try {
      walk(boards.store(b.id).current.memos, b.name);
    } catch (err) {
      console.warn('[hex-memo] 期限の確認でノートを読めませんでした:', err);
    }
  }
  out.sort((a, b) => (a.due < b.due ? -1 : a.due > b.due ? 1 : 0));
  return out;
}

function notifyDue({ force = false } = {}) {
  const s = settings.get().notify;
  if (!s.enabled || !Notification.isSupported()) return;
  const today = localDay();
  if (!force && notifiedDay === today) return;
  const list = dueMemos(today);
  if (!list.length) return;
  notifiedDay = today;
  const line = (x) => `・${(x.text.split('\n').find((l) => l.trim()) || '（本文なし）').trim().slice(0, 30)}（${x.due}${x.due < today ? '・期限切れ' : ''}）`;
  const n = new Notification({
    title: `${appName}：期限のメモ ${list.length} 件`,
    body: `${list.slice(0, 3).map(line).join('\n')}${list.length > 3 ? `\nほか ${list.length - 3} 件` : ''}`,
  });
  n.on('click', () => {
    const win = activeWindow() || [...windows].find((w) => !w.isDestroyed()) || createWindow();
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    win.webContents.send('view:command', 'due-list');
  });
  n.show();
}

// 毎日の設定時刻（HH:MM）に知らせる
function scheduleNotify() {
  clearTimeout(notifyTimer);
  const s = settings.get().notify;
  if (!s.enabled) return;
  const [hh, mm] = s.time.split(':').map(Number);
  const now = new Date();
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hh, mm, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  notifyTimer = setTimeout(() => {
    notifyDue({ force: true });
    scheduleNotify();
  }, Math.min(next - now, 2 ** 31 - 1));
}

// クイック入力のキー。キーで呼び出したウィンドウ（hexQuickSession）がまだ前にあれば、もう一度のキーで最小化する
function triggerQuickInput() {
  const focused = BrowserWindow.getFocusedWindow();
  if (settings.get().quickInput.toggle && focused && windows.has(focused) && focused.hexQuickSession && !focused.isMinimized()) {
    minimizeWindow(focused);
    return;
  }
  let win = activeWindow();
  if (!win) win = [...windows].find((w) => !w.isDestroyed()) || null;
  if (!win) {
    win = createWindow();
    win.hexQuickInput = true; // 開いたら、画面の準備ができたところで書き始める
    win.hexQuickSession = true;
    return;
  }
  if (isMac) app.show(); // 最小化のときに隠していれば、出し直す
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  win.hexQuickSession = true;
  win.webContents.send('view:command', 'quick-input');
}

// 書いている途中の本文を確かめてから（画面に「書き終わり」を伝える）、最小化する。
// Mac は、ほかに見えているウィンドウが無ければアプリも隠して、前に使っていたアプリに戻す
function minimizeWindow(win) {
  if (!win || win.isDestroyed()) return;
  win.hexQuickSession = false;
  win.webContents.send('view:command', 'quick-done');
  if (win.isFullScreen()) win.setFullScreen(false);
  win.minimize();
  if (isMac && ![...windows].some((w) => !w.isDestroyed() && w.isVisible() && !w.isMinimized())) app.hide();
}

// 最小化する別のキー：見えている六角メモのウィンドウ（小窓も）をすべて最小化する
function minimizeApp() {
  for (const win of windows) {
    if (!win.isDestroyed() && win.isVisible() && !win.isMinimized()) minimizeWindow(win);
  }
}

function trySave(id, data) {
  try {
    boards.save(String(id), data);
    return { ok: true, savedAt: new Date().toISOString() };
  } catch (err) {
    console.error('[hex-memo] 保存に失敗しました:', err);
    return { ok: false, error: err.message };
  }
}

// 結果は常に { ok, ... } で返す（例外はレンダラ側で読みやすいメッセージにする）。fn は非同期でもよい
function handle(channel, fn) {
  handleFrom(channel, (_win, ...args) => fn(...args));
}

// 送ってきたウィンドウも受け取る版
function handleFrom(channel, fn) {
  ipcMain.handle(channel, async (event, ...args) => {
    const win = ourWindow(event.sender);
    if (!win) return { ok: false, error: 'unexpected sender' };
    try {
      return { ok: true, ...(await fn(win, ...args)) };
    } catch (err) {
      console.error(`[hex-memo] ${channel}:`, err);
      return { ok: false, error: err.message };
    }
  });
}

// ノート一覧（名前・ツリー）が変わったら、ほかのウィンドウのタブも作り直させる
function boardsChanged(win) {
  broadcast('boards:changed', boards.list(), win);
}

// ノートごとの版の番号（保存のたびに1つ進む）。ウィンドウは「どの版をもとに変更したか」を添えて保存し、
// もとにした版が古ければ（その間に別のウィンドウが保存していれば）保存せずに最新の内容を返す。
// ウィンドウはそれと自分の変更を合わせてから保存し直す（変更が上書きで消えないように）
const revs = new Map();
const revOf = (id) => revs.get(String(id)) || 0;

// ノートの中身を保存したら、同じノートを開いているほかのウィンドウに新しい内容を渡す（data：中身の変更か）
function boardSaved(id, win, data = true) {
  const key = String(id);
  revs.set(key, revOf(key) + 1);
  try {
    broadcast('board:changed', { id: key, rev: revOf(key), store: boards.store(key).current, data }, win);
  } catch (err) {
    console.warn('[hex-memo] ほかのウィンドウへの通知に失敗しました:', err);
  }
  return revOf(key);
}

// 別のメモアプリを、このアプリとは別のプロセスとして開く（すでに開いていれば、そのウィンドウが前に出る）
function launchApp(entry, extraArgs = []) {
  const env = { ...process.env, HEX_MEMO_HOME: root };
  for (const key of ['HEX_MEMO_DATA_DIR', 'HEX_MEMO_APP_ID', 'HEX_MEMO_APP_NAME', 'HEX_MEMO_APP_LAUNCHER', 'ELECTRON_RUN_AS_NODE']) delete env[key];
  if (entry) {
    env.HEX_MEMO_APP_ID = entry.id;
    env.HEX_MEMO_APP_NAME = entry.name;
    if (entry.launcher) env.HEX_MEMO_APP_LAUNCHER = entry.launcher;
  }
  const child = spawn(process.execPath, [app.getAppPath(), ...extraArgs], { env, detached: true, stdio: 'ignore' });
  child.unref();
}

function listApps() {
  const registry = new AppRegistry(root).load();
  return {
    current: appId,
    apps: [{ id: null, name: MAIN_NAME }, ...registry.apps.map(({ id, name }) => ({ id, name }))],
  };
}

const MAX_CLIP_CELLS = 200; // まとめて貼り付けるマスの上限

// ---- コピーして送る（送り先の登録・同じアプリのノートへ・ほかのメモアプリへ） ----
// 送り先の登録は、すべてのメモアプリで共通（大もとのデータフォルダ root の send-targets.json）

// 送り先の見出しを作るための、メモアプリの一覧とデータフォルダ
function sendContext() {
  const registry = new AppRegistry(root).load();
  const apps = [{ id: null, name: MAIN_NAME }, ...registry.apps.map(({ id, name }) => ({ id, name }))]
    .map((a) => ((a.id || null) === appId ? { ...a, name: appName } : a));
  return { selfAppId: appId, boards, apps, dataDirOf: (id) => (!id ? root : registry.get(id) ? registry.dataDir(id) : null) };
}

// 届いたもの（ほかのメモアプリから送られたマス）を取り込む。mode：
// 'startup'（起動したとき。お知らせは最初の画面で）・'live'（動いているときに合図が来た。開いている画面に知らせる）・
// 'headless'（受け取るためだけに起動した。お知らせは次に開いた画面で）
let inboxRetryTimer = 0;
let inboxRetries = 0;
function runInbox(mode) {
  let res;
  try {
    res = SB.processInbox({ dir: dataDir, boards, attachments });
  } catch (err) {
    console.error('[hex-memo] 届いたマスを取り込めませんでした:', err);
    return null;
  }
  for (const id of new Set(res.imported.map((r) => r.boardId))) boardSaved(id, null, true); // そのノートを開いている画面へ
  if (res.notices.length) {
    if (mode === 'startup') for (const n of res.notices) boards.notice(n.level, n.message);
    else if (mode === 'live' && windows.size) for (const n of res.notices) broadcast('app:notice', n);
    else SB.saveInboxNotices(dataDir, res.notices);
  }
  // 一時的に取り込めなかったもの（ファイルが使用中など）は、少し待ってもう一度（回数を決めて）
  if (!res.deferred.length) inboxRetries = 0;
  else if (mode !== 'headless' && !inboxRetryTimer && inboxRetries < 8) {
    inboxRetries++;
    inboxRetryTimer = setTimeout(() => {
      inboxRetryTimer = 0;
      runInbox('live');
    }, 3000);
  }
  return res;
}

// 送ったもの（inbox の id）を相手が取り込んだ結果を待つ。取り込み中なら長めに待つ。来なければ null
async function waitInbox(dir, id) {
  const started = Date.now();
  let limit = 12000;
  let gone = 0;
  while (Date.now() - started < limit) {
    const state = SB.inboxState(dir, id);
    if (state === 'done') return SB.takeInboxResult(dir, id);
    // 相手が一時的に取り込めなかった（わけを残した）：待たずに知らせる（相手があとでもう一度試す）
    const reason = state === 'waiting' ? SB.inboxWaitReason(dir, id) : null;
    if (reason) return { pending: true, reason };
    if (state === 'taking') limit = 45000;
    if (state === 'gone' && ++gone >= 5) return SB.takeInboxResult(dir, id) || { ok: false, error: '送ったものが見当たりません' };
    await new Promise((r) => setTimeout(r, 150));
  }
  return null;
}

// 待ちきれなかったものは、しばらく見張っておき、届いたら送った画面に知らせる
function watchLate(win, dir, id, name) {
  const started = Date.now();
  const timer = setInterval(() => {
    let res = null;
    try {
      res = SB.takeInboxResult(dir, id);
    } catch {
      res = null;
    }
    if (!res && Date.now() - started < 3 * 60 * 1000) return;
    clearInterval(timer);
    if (!res || !win || win.isDestroyed()) return;
    win.webContents.send('app:notice', res.ok
      ? { level: 'info', message: `「${name}」に届きました（${(res.placed || []).length} マス）` }
      : { level: 'error', message: `「${name}」が受け取れませんでした：${res.error || '不明なエラー'}` });
  }, 2000);
}

// マスの写しを送り先へ。同じメモアプリならそのノートに置いて保存し、開いている画面へ知らせる。
// ほかのメモアプリなら、相手の inbox に置いて合図し、相手が取り込むのを待つ（相手のファイルは書き換えない）
async function sendRecords(win, rawTarget, payload) {
  const target = SB.normalizeTarget(rawTarget);
  if (!target) throw new Error('送り先の形が正しくありません');
  const now = new Date().toISOString();
  const { cells, offsets } = HS.pairCells(payload && payload.records, payload && payload.offsets, (r) => normalizeRecord(r, now), HS.MAX_SEND);
  if (!cells.length) throw new Error('送るメモがありません');
  if ((target.appId || null) === appId) {
    const r = SB.insertIntoBoards(boards, target, cells, offsets, { now });
    boardSaved(r.boardId, null, true);
    return { delivered: true, self: true, boardId: r.boardId, boardPath: r.boardPath, memoText: r.memoText, placed: r.placed };
  }
  const registry = new AppRegistry(root).load();
  const entry = target.appId ? registry.get(target.appId) : null;
  if (target.appId && !entry) throw new Error('送り先のメモアプリが見つかりません');
  const name = entry ? entry.name : MAIN_NAME;
  const dir = target.appId ? registry.dataDir(target.appId) : root;
  // 写しが使う画像のファイルも一緒に置く（相手が後で取り込むときに、こちらで消えていても届くように）
  const refs = new Set();
  for (const r of cells) collectRecordRefs(r, refs);
  const files = [...refs].map((f) => ({ name: f, abs: attachments.resolve(f) })).filter((f) => f.abs && fs.existsSync(f.abs));
  // 相手が受け取れない古い版のまま動いているなら、合図は送らない（古い版は合図でウィンドウを前に出してしまう）。
  // 置いたものは、相手を起動し直したときに受け取る
  const status = process.platform === 'win32' ? SB.appStatus(dir) : 'unknown';
  const sent = SB.dropToInbox(dir, { target, records: cells, offsets, from: { appId, appName }, sentAt: now }, files);
  const lost = refs.size - files.length + sent.missing;
  if (status === 'old') return { pending: true, reason: 'old', appName: name, missing: lost };
  launchApp(entry, [SB.INBOX_URL]);
  const res = await waitInbox(dir, sent.id);
  if (!res || res.pending) {
    if (!res) watchLate(win, dir, sent.id, name);
    return { pending: true, reason: res ? res.reason : null, appName: name, missing: lost };
  }
  if (!res.ok) throw new Error(`「${name}」が受け取れませんでした：${res.error || '不明なエラー'}`);
  return {
    delivered: true, self: false, appName: name, boardId: res.boardId, boardPath: res.boardPath || [], memoText: res.memoText || '',
    placed: res.placed || [], fellBack: !!res.fellBack, fellBackReason: res.fellBackReason || null, missing: lost + (res.missing || 0),
  };
}

// 別のメモアプリからコピーしたマスの添付ファイルを、このアプリの添付フォルダへ取り込む。取り込めなかった数を返す
function importClipAttachments(payload, records) {
  const refs = new Set();
  for (const r of records) collectRecordRefs(r, refs);
  let missing = 0;
  const src = typeof payload.attDir === 'string' && path.isAbsolute(payload.attDir) ? path.resolve(payload.attDir) : null;
  for (const f of refs) {
    if (attachments.has(f)) continue;
    if (!src || src === path.resolve(attachments.dir) || !attachments.importFrom(src, f)) missing++;
  }
  return missing;
}

// エクスプローラーでコピーした画像ファイル（Windows。1つだけ）
function readClipboardImageFile() {
  if (process.platform !== 'win32') return null;
  try {
    const p = clipboard.readBuffer('FileNameW').toString('ucs2').replace(/\0+$/, '');
    if (!p || !/\.(png|jpe?g|gif|webp)$/i.test(p)) return null;
    const st = fs.statSync(p);
    if (!st.isFile() || st.size > 25 * 1024 * 1024) return null;
    return { data: fs.readFileSync(p), name: path.basename(p) };
  } catch {
    return null;
  }
}

// ---- 添付ファイル（画像） ----

function registerAttachmentIpc() {
  // 画像の本体と、画面で作った縮小版を保存する
  handle('att:put-image', ({ data, thumb }) => {
    const saved = attachments.put(Buffer.from(data), { kinds: IMAGE_EXTS });
    const image = { file: saved.file, type: saved.type, size: saved.size };
    if (thumb) {
      try {
        image.thumb = attachments.putThumb(saved.file, Buffer.from(thumb));
      } catch (err) {
        console.warn('[hex-memo] 縮小版を保存できませんでした:', err);
      }
    }
    return { image };
  });
  handle('att:open', (file) => {
    const abs = attachments.resolve(file);
    if (!abs || !fs.existsSync(abs)) throw new Error('ファイルが見つかりません');
    openPathSafe(abs);
    return {};
  });
  handle('att:reveal', (file) => {
    const abs = attachments.resolve(file);
    if (!abs || !fs.existsSync(abs)) throw new Error('ファイルが見つかりません');
    if (TEST_OPEN_LOG) fs.appendFileSync(TEST_OPEN_LOG, `reveal ${abs}\n`);
    else shell.showItemInFolder(abs);
    return {};
  });
  handle('att:save-as', async (file, name) => {
    const abs = attachments.resolve(file);
    if (!abs || !fs.existsSync(abs)) throw new Error('ファイルが見つかりません');
    const ext = path.extname(file);
    const base = safeFileName(String(name || '').replace(/\.[^.]+$/, '')) || '画像';
    const dest = await pickSavePath({ defaultPath: `${base}${ext}`, filters: [{ name: '画像', extensions: [ext.slice(1)] }] });
    if (!dest) return { canceled: true };
    fs.copyFileSync(abs, dest);
    return { path: dest };
  });
  // どのノートからも使われていないファイルを片付ける（graceMs：作って間もないものは残す）
  handle('att:sweep', ({ graceMs = 60 * 1000 } = {}) => {
    const refs = collectDirRefs(dataDir);
    if (!refs) throw new Error('ノートのファイルを読めなかったため、片付けを中止しました');
    return attachments.sweep(refs, { graceMs });
  });
  // zip の説明文（README.txt）の1行：区画の紙片・棚・ゴミ箱のメモの画像も入ることを書く（ブラウザ版の web/web-api.js と同じ文）
  const ZIP_ATT_NOTE = 'attachments/ には、マスのメモだけでなく、区画の紙片と、未配置の棚のメモと、ゴミ箱（削除から 30 日以内）のメモの画像なども入っています';
  // ノートを書き出す（メモ・添付ファイル・説明を1つの zip に）
  handle('board:export', async (id) => {
    const board = boards.get(String(id));
    const store = boards.store(board.id).current;
    const refs = [...collectStoreRefs(store)].sort();
    const dest = await pickSavePath({ defaultPath: `${safeFileName(board.name)}.hexmemo.zip`, filters: [{ name: 'zip ファイル', extensions: ['zip'] }] });
    if (!dest) return { canceled: true };
    const entries = [{ name: 'memos.json', data: `${JSON.stringify(store, null, 2)}\n` }];
    let missing = 0;
    for (const f of refs) {
      if (attachments.has(f)) entries.push({ name: `attachments/${f}`, data: attachments.read(f) });
      else missing++;
    }
    entries.push({
      name: 'README.txt',
      data: [
        `六角メモ「${board.name}」の書き出し（${new Date().toLocaleString('ja-JP')}）`,
        '',
        'memos.json … メモ（六角メモのノートと同じ形式。本文・いいね・コメント・周りのメモ・画像やリンクの記録）',
        'attachments/ … 添付した画像・保存したページ（PDF）・リンクの画像。ファイル名は中身から計算した値です',
        ZIP_ATT_NOTE,
        '',
        'memos.json の images[].file・urls[].favicon などの名前が、attachments/ の中のファイルに対応します。',
      ].join('\r\n'),
    });
    fs.writeFileSync(dest, createZip(entries));
    return { path: dest, files: refs.length - missing, missing };
  });
  // メモアプリ全体（すべてのノートとそのツリー・添付ファイル）を1つの zip に。
  // 中身はデータフォルダと同じ並び（boards.json・memos*.json・attachments/）なので、iPad のブラウザ版などでそのまま読み込める
  handle('app:export', async () => {
    const list = boards.list();
    const dest = await pickSavePath({ defaultPath: `${safeFileName(appName)}.hexmemo-app.zip`, filters: [{ name: 'zip ファイル', extensions: ['zip'] }] });
    if (!dest) return { canceled: true };
    const refs = new Set();
    const index = { version: 1, activeId: list.activeId, boards: [] };
    const entries = [];
    for (const b of list.boards) {
      const board = boards.get(b.id);
      const store = boards.store(b.id).current;
      collectStoreRefs(store, refs);
      index.boards.push({ id: board.id, name: board.name, file: board.file, ...(board.parentId ? { parentId: board.parentId } : {}), ...(board.openId ? { openId: board.openId } : {}) });
      entries.push({ name: board.file, data: `${JSON.stringify(store, null, 2)}\n` });
    }
    entries.unshift(
      { name: 'hexmemo-app.json', data: `${JSON.stringify({ format: 'hexmemo-app', version: 1, name: appName, exportedAt: new Date().toISOString(), boards: list.boards.length }, null, 2)}\n` },
      { name: 'boards.json', data: `${JSON.stringify(index, null, 2)}\n` },
    );
    let missing = 0;
    for (const f of [...refs].sort()) {
      if (attachments.has(f)) entries.push({ name: `attachments/${f}`, data: attachments.read(f) });
      else missing++;
    }
    entries.push({
      name: 'README.txt',
      data: [
        `六角メモ「${appName}」全体の書き出し（${new Date().toLocaleString('ja-JP')}・ノート ${list.boards.length} 冊）`,
        '',
        'boards.json … ノートの一覧（名前・タブと子ノートのツリー・それぞれのファイル名）',
        'memos.json・memos-<ID>.json … 各ノートのメモ（六角メモのノートと同じ形式）',
        'attachments/ … 添付した画像・保存したページ（PDF）・リンクの画像。ファイル名は中身から計算した値です',
        ZIP_ATT_NOTE,
        '',
        'iPad などのブラウザ版の六角メモでは、左上のメニューの「データを読み込む」でこの zip を選ぶと、そのまま使えます。',
      ].join('\r\n'),
    });
    fs.writeFileSync(dest, createZip(entries));
    return { path: dest, boards: list.boards.length, files: refs.size - missing, missing };
  });
}

// ---- リンク ----

function registerLinkIpc() {
  const putFile = (buf, kinds) => attachments.put(buf, { kinds }).file;
  handle('link:preview', async (url) => ({ preview: await fetchPreview(String(url), { fetchImpl: net.fetch, putFile }) }));
  handle('link:check', async (urls) => {
    const list = (Array.isArray(urls) ? urls : []).filter((u) => typeof u === 'string' && isWebUrl(u)).slice(0, 1000);
    return { results: await checkLinks(list, { fetchImpl: net.fetch }) };
  });
  handle('link:open', (url) => {
    const u = String(url || '');
    if (!isWebUrl(u) && !/^mailto:[^\s]+$/i.test(u)) throw new Error('開けない種類のリンクです');
    openExternalSafe(u);
    return {};
  });
  handle('link:snapshot', async (url) => ({ snapshot: await snapshotPage(String(url)) }));
  // 別のメモアプリのマスへのリンク：そのアプリを開いてリンクを渡す（同じアプリなら画面側で移動する）
  handle('link:open-memo', (url) => {
    const link = parseInternalLink(String(url));
    if (!link) throw new Error('マスへのリンクの形が正しくありません');
    if ((link.appId || null) === appId) return { local: true };
    const entry = link.appId ? new AppRegistry(root).load().get(link.appId) : null;
    if (link.appId && !entry) throw new Error('リンク先のメモアプリが見つかりません');
    launchApp(entry, [String(url)]);
    return { local: false };
  });
  handle('link:take-pending', () => {
    const url = pendingLink;
    pendingLink = null;
    return { url };
  });
  // hexmemo:// のリンクを、ほかのアプリ（メールなど）から押しても開けるようにする（利用者が選んだときだけ）
  handle('protocol:register', () => {
    const args = [path.resolve(app.getAppPath())];
    const ok = app.setAsDefaultProtocolClient('hexmemo', process.execPath, args);
    return { registered: ok && app.isDefaultProtocolClient('hexmemo', process.execPath, args) };
  });
  // ブラウザのブックマーク（HTML）を読み込み、フォルダごとにノートを作る
  handle('bookmarks:import', async () => {
    const file = await pickOpenFile({ title: 'ブックマークの HTML ファイルを選ぶ', filters: [{ name: 'ブックマーク（HTML）', extensions: ['html', 'htm'] }] });
    if (!file) return { canceled: true };
    if (fs.statSync(file).size > 30 * 1024 * 1024) throw new Error('ファイルが大きすぎます（30MB まで）');
    const plan = planImport(parseBookmarksHtml(fs.readFileSync(file, 'utf8')), {
      rootName: `ブックマーク ${new Date().toLocaleDateString('ja-JP')}`,
      maxDepth: MAX_TREE_DEPTH - 1,
    });
    if (!plan.bookmarks) throw new Error('ブックマークが見つかりませんでした（ブラウザの「ブックマークを HTML にエクスポート」で作ったファイルを選んでください）');
    const ids = [];
    for (const nb of plan.notebooks) {
      const created = boards.create(nb.name, nb.parent === null ? null : ids[nb.parent]);
      ids.push(created.id);
      boards.save(created.id, { version: 2, camera: { x: 0, y: 0 }, memos: nb.memos });
    }
    boards.activate(ids[0]);
    broadcast('boards:changed', boards.list());
    return { rootId: ids[0], notebooks: ids.length, bookmarks: plan.bookmarks, ...boards.list() };
  });
}

// ページの保存に使う閲覧環境：ディスクに残らない専用のもの（アプリを閉じると消える）を使い回す
const SNAPSHOT_PARTITION = 'hexmemo-snapshot';
let snapshotSessionReady = false;
function guardSnapshotSession(ses) {
  if (snapshotSessionReady) return;
  snapshotSessionReady = true;
  ses.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  ses.setPermissionCheckHandler(() => false);
  ses.on('will-download', (event) => event.preventDefault());
}

// ページを見えないウィンドウで開き、PDF として添付フォルダに保存する。
// ほかとは切り離した一時的な場所（セッション）で開き、権限・ポップアップ・ダウンロードはすべて断る
async function snapshotPage(url) {
  if (!isWebUrl(url)) throw new Error('http / https のページだけ保存できます');
  const win = new BrowserWindow({
    show: false,
    width: 1200,
    height: 900,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, partition: SNAPSHOT_PARTITION, spellcheck: false },
  });
  const wc = win.webContents;
  wc.setWindowOpenHandler(() => ({ action: 'deny' }));
  guardSnapshotSession(wc.session);
  wc.on('will-navigate', (event, next) => {
    if (!isWebUrl(next)) event.preventDefault();
  });
  let timer = 0;
  try {
    await Promise.race([
      wc.loadURL(url, { userAgent: UA }).catch((err) => {
        if (!/ERR_ABORTED/.test(String(err && err.message))) throw err; // ページ内の転送で中断された分は続ける
      }),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('ページの読み込みに時間がかかりすぎました')), 25000);
      }),
    ]);
    await new Promise((r) => setTimeout(r, 1500)); // 後から出てくる内容を少し待つ
    const title = wc.getTitle();
    const pdf = await wc.printToPDF({ printBackground: true, pageSize: 'A4' });
    const { file } = attachments.put(pdf, { kinds: ['pdf'] });
    return { file, savedAt: new Date().toISOString(), title: title && title !== url ? title.slice(0, 300) : '' };
  } finally {
    clearTimeout(timer);
    win.destroy();
  }
}

// 変換コマンド（音声の文字起こし）は、本体の確認ダイアログで許したものだけを動かす。許したコマンドは、画面からは書けないファイルに覚える
const VOICE_OK_FILE = path.join(dataDir, 'voice-command-ok.json');
async function confirmVoiceCommand(command) {
  try {
    if (JSON.parse(fs.readFileSync(VOICE_OK_FILE, 'utf8')).command === command) return true;
  } catch {
    // まだ許したコマンドが無い
  }
  const res = await dialog.showMessageBox(activeWindow(), {
    type: 'question',
    buttons: ['実行する', 'やめる'],
    defaultId: 1,
    cancelId: 1,
    title: '変換コマンドの確認',
    message: 'この変換コマンドで文字起こしをしますか？',
    detail: `${command}\n\n録音した WAV を一時フォルダに置いて、このコマンドを実行します。同じコマンドなら、次からは確かめません。`,
  });
  if (res.response !== 0) return false;
  try {
    fs.writeFileSync(VOICE_OK_FILE, JSON.stringify({ command }));
  } catch {
    // 覚えられなくても、今回は動かす
  }
  return true;
}

function registerIpc() {
  // 開くノート：そのウィンドウで開くよう頼まれたノート（新しいウィンドウ）か、前回のノート
  handleFrom('boards:init', (win) => {
    const list = boards.list();
    const want = win.hexInitialBoard;
    const activeId = want && list.boards.some((b) => b.id === want) ? want : list.activeId;
    const view = win.hexMini ? { mini: true, ...win.hexMini } : null; // 小窓なら、最初に見せる場所
    const quickInput = !!win.hexQuickInput; // クイック入力のキーで開いたウィンドウ：読み込みが済んだら書き始める
    win.hexQuickInput = false;
    const capture = win.hexPendingCapture || null; // 六角形スクショのために開いたウィンドウ：読み込みが済んだら棚へ
    win.hexPendingCapture = null;
    return { ...list, activeId, notices: boards.takeNotices(), app: { id: appId, name: appName }, window: view, settings: settings.get(), quickInput, capture };
  });
  // 設定（タグの登録・関連線の種類・クイック入力）。変えたら、ほかのウィンドウにも届ける
  handle('settings:get', () => ({ settings: settings.get() }));
  handleFrom('settings:set', (win, patch) => {
    const before = settings.get();
    const s = settings.update(patch);
    const changedKey = s.quickInput.shortcut !== before.quickInput.shortcut || s.quickInput.global !== before.quickInput.global
      || s.quickInput.hideShortcut !== before.quickInput.hideShortcut;
    const shortcutError = changedKey ? applyQuickShortcut() : null;
    const captureError = s.capture.shortcut !== before.capture.shortcut ? applyCaptureShortcut() : null;
    if (patch && patch.notify) scheduleNotify();
    if (patch && patch.tray) applyTray();
    broadcast('settings:changed', s, win);
    return { settings: s, shortcutError, captureError };
  });
  // クイック入力のキー・最小化するキーを、アプリの中で押したとき（アプリの外では効かない設定のとき）
  handleFrom('quick:key', () => {
    triggerQuickInput();
    return {};
  });
  handleFrom('window:minimize-app', () => {
    minimizeApp();
    return {};
  });
  // 六角形スクショの枠を出す（アプリの中から）
  handle('capture:start', () => {
    startHexCapture();
    return {};
  });
  // 期限の通知を今すぐ（設定の確認用）
  handle('due:notify', () => {
    notifyDue({ force: true });
    return {};
  });
  // 文字のファイルの書き出し・読み込み（AI にタグ付けを頼むファイルと、その結果の読み込み）
  handle('file:save-text', async ({ name, text, filters } = {}) => {
    const dest = await pickSavePath({
      defaultPath: safeFileName(String(name || 'file.txt')),
      filters: Array.isArray(filters) && filters.length ? filters : [{ name: 'JSON', extensions: ['json'] }, { name: 'すべてのファイル', extensions: ['*'] }],
    });
    if (!dest) return { canceled: true };
    fs.writeFileSync(dest, String(text || ''), 'utf8');
    return { path: dest };
  });
  // 書き出した HTML（図と本文の一覧）を PDF に：見えないウィンドウで開いて印刷の形にする。
  // ほかとは切り離した一時的な場所で、スクリプトは動かさず、ほかのページへは移らない
  handle('file:save-pdf', async ({ name, html } = {}) => {
    const dest = await pickSavePath({ defaultPath: safeFileName(String(name || '書き出し.pdf')), filters: [{ name: 'PDF', extensions: ['pdf'] }] });
    if (!dest) return { canceled: true };
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hexmemo-pdf-'));
    const file = path.join(dir, 'export.html');
    fs.writeFileSync(file, String(html || ''), 'utf8');
    const win = new BrowserWindow({
      show: false,
      width: 1000,
      height: 1300,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, javascript: false, partition: SNAPSHOT_PARTITION, spellcheck: false },
    });
    const wc = win.webContents;
    wc.setWindowOpenHandler(() => ({ action: 'deny' }));
    guardSnapshotSession(wc.session);
    wc.on('will-navigate', (event) => event.preventDefault());
    try {
      await wc.loadFile(file);
      const pdf = await wc.printToPDF({ printBackground: true, pageSize: 'A4' });
      fs.writeFileSync(dest, pdf);
      return { path: dest };
    } finally {
      win.destroy();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
  // バイナリのファイルの書き出し（録音した音声の WAV など）
  handle('file:save-binary', async ({ name, bytes, filters } = {}) => {
    const dest = await pickSavePath({
      defaultPath: safeFileName(String(name || 'file.bin')),
      filters: Array.isArray(filters) && filters.length ? filters : [{ name: 'すべてのファイル', extensions: ['*'] }],
    });
    if (!dest) return { canceled: true };
    fs.writeFileSync(dest, Buffer.from(bytes));
    return { path: dest };
  });
  // 音声の文字起こし：録音した WAV を一時フォルダに置き、設定した変換コマンド（Whisper など）を動かして、
  // 結果（そのフォルダに書き出された .txt・.srt・.vtt・.json、無ければ画面に出た文字）を返す
  // 録音を変換コマンドで文字起こしする。コマンドは画面から受け取らず、設定（settings.json）に保存したものを使い、
  // 初めてのコマンド（変えたときも）は、本体の確認ダイアログで「実行する」を押してから動かす
  handle('voice:transcribe', async ({ bytes } = {}) => {
    const v = settings.get().voice;
    const cmdTemplate = String(v.command || '').trim();
    if (!cmdTemplate) throw new Error('変換コマンドが設定されていません');
    if (!(await confirmVoiceCommand(cmdTemplate))) throw new Error('変換コマンドの実行を取りやめました');
    const lang = v.lang;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hexmemo-voice-'));
    const file = path.join(dir, 'voice.wav');
    try {
      fs.writeFileSync(file, Buffer.from(bytes));
      const cmd = Voice.fillCommand(cmdTemplate, { file, dir, base: path.join(dir, 'voice'), lang: String(lang || 'ja').split('-')[0] });
      const { stdout } = await new Promise((resolve, reject) => {
        execCommand(cmd, { cwd: dir, timeout: 15 * 60 * 1000, maxBuffer: 20 * 1024 * 1024, windowsHide: true }, (err, out, errOut) => {
          if (err) reject(new Error(`変換コマンドが失敗しました：${(String(errOut || '').trim().split('\n').pop() || err.message).slice(0, 300)}`));
          else resolve({ stdout: String(out || '') });
        });
      });
      const outFile = fs.readdirSync(dir).filter((f) => /\.(txt|srt|vtt|json)$/i.test(f)).map((f) => path.join(dir, f))
        .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
      const text = outFile ? Voice.parseTranscript(fs.readFileSync(outFile, 'utf8'), outFile) : Voice.parseTranscript(stdout);
      return { text, from: outFile ? path.basename(outFile) : 'stdout' };
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
  handle('file:open-text', async ({ filters } = {}) => {
    const res = await dialog.showOpenDialog(activeWindow(), {
      properties: ['openFile'],
      filters: Array.isArray(filters) && filters.length ? filters : [{ name: 'JSON・テキスト', extensions: ['json', 'txt'] }, { name: 'すべてのファイル', extensions: ['*'] }],
    });
    if (res.canceled || !res.filePaths.length) return { canceled: true };
    const file = res.filePaths[0];
    if (fs.statSync(file).size > 20 * 1024 * 1024) throw new Error('ファイルが大きすぎます（20MB まで）');
    return { path: file, text: fs.readFileSync(file, 'utf8') };
  });
  handleFrom('window:new', (win, boardId, opts) => {
    const mini = miniView(opts);
    createWindow({ boardId: typeof boardId === 'string' ? boardId : null, from: win, mini });
    return { mini: !!mini }; // 小窓で開いたか（画面側は、これが無ければ本体が古いと分かる）
  });
  // 小窓をふつうのウィンドウに戻す。resize なら、右上の位置はそのままで、ふつうの大きさに広げる
  handleFrom('window:exit-mini', (win, opts) => {
    win.hexMini = null;
    if (win.isMaximized() || win.isFullScreen()) {
      win.setMinimumSize(NORMAL_MIN.width, NORMAL_MIN.height);
      return {};
    }
    if (opts && opts.resize) {
      const b = win.getBounds();
      const area = screen.getDisplayMatching(b).workArea;
      const width = Math.min(NORMAL_SIZE.width, area.width);
      const height = Math.min(NORMAL_SIZE.height, area.height);
      win.setBounds({
        x: Math.round(clampTo(b.x + b.width - width, area.x, area.x + area.width - width)),
        y: Math.round(clampTo(b.y, area.y, area.y + area.height - height)),
        width,
        height,
      });
    }
    win.setMinimumSize(NORMAL_MIN.width, NORMAL_MIN.height);
    return {};
  });
  handleFrom('window:set-on-top', (win, flag) => ({ onTop: setOnTop(win, flag) }));
  handle('apps:list', () => listApps());
  handle('apps:create', (name) => {
    const registry = new AppRegistry(root).load();
    const entry = registry.create({ name, launcherDir, appDir: app.getAppPath() });
    launchApp(entry);
    return { app: { id: entry.id, name: entry.name }, launcher: entry.launcher ? path.basename(entry.launcher) : null };
  });
  handleFrom('apps:open', (win, id) => {
    if ((id || null) === appId) {
      createWindow({ from: win }); // このメモアプリ：新しいウィンドウで開く
      return {};
    }
    const entry = id ? new AppRegistry(root).load().get(String(id)) : null;
    if (id && !entry) throw new Error('メモアプリが見つかりません');
    launchApp(entry);
    return {};
  });
  handle('app:open-data-folder', () => {
    shell.openPath(dataDir);
    return {};
  });
  // マスのコピー：本文はテキストとして、マスの中身は HTML 形式に埋め込んで書く
  // text があればそれを（複数のコメントをまとめてコピーしたときなど）、無ければ本文をテキストとして書く
  handle('clip:write', (payload) => {
    const text = payload && typeof payload.text === 'string' ? payload.text
      : payload && payload.record && typeof payload.record.text === 'string' ? payload.record.text : '';
    // 別のメモアプリに貼り付けたとき、添付ファイルを取り込めるよう、このアプリの添付フォルダも載せる
    clipboard.write({ text, html: encodeClipHtml(text, { ...payload, attDir: attachments.dir }) });
    return {};
  });
  // マスへのリンク・URL のコピー（ほかのアプリにはリンクとして貼り付く）
  handle('clip:write-link', ({ url, label }) => {
    const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
    clipboard.write({ text: String(url), html: `<a href="${esc(url)}">${esc(label || url)}</a>` });
    return {};
  });
  // 貼り付け：マスの中身があれば保存時と同じ検査を通して返す。無ければテキスト
  handle('clip:read', () => {
    const payload = decodeClipHtml(clipboard.readHTML());
    if (payload) {
      const now = new Date().toISOString();
      const record = normalizeRecord(payload.record, now);
      // 複数のマス（まとめてコピーしたコメント・複数選択したマス）。1件ずつ同じ検査を通す。
      // 複数選択したマスは、並び（左上のマスからの位置）も持つ
      const { cells, offsets } = clipCells(payload, (r) => normalizeRecord(r, now), MAX_CLIP_CELLS);
      if (record) {
        const missing = importClipAttachments(payload, [record, ...cells]);
        return {
          cell: { record, nonce: String(payload.nonce || ''), cut: payload.cut === true },
          ...(cells.length > 1 ? { cells, ...(offsets ? { offsets } : {}) } : {}),
          ...(missing ? { missing } : {}),
        };
      }
    }
    const text = clipboard.readText();
    // 文字が無く画像だけ（スクリーンショット・ブラウザの「画像をコピー」）なら画像として
    if (!text || !text.trim()) {
      const image = clipboard.readImage();
      if (!image.isEmpty()) return { image: { data: image.toPNG(), name: 'クリップボードの画像.png' } };
      const file = readClipboardImageFile();
      if (file) return { image: file };
    }
    return { text: text || null };
  });
  registerAttachmentIpc();
  registerLinkIpc();
  // parentId を渡すと、そのノートの子ノートを作る
  handleFrom('boards:create', (win, parentId) => {
    const { id, name } = boards.create(undefined, parentId ? String(parentId) : null);
    boardsChanged(win);
    return { board: { id, name }, ...boards.list() };
  });
  handleFrom('boards:move', (win, id, parentId, beforeId) => {
    boards.move(String(id), parentId ? String(parentId) : null, beforeId ? String(beforeId) : null);
    boardsChanged(win);
    return boards.list();
  });
  handleFrom('boards:rename', (win, id, name) => {
    boards.rename(String(id), name);
    boardsChanged(win);
    return boards.list();
  });
  handleFrom('boards:delete', (win, id) => {
    const gone = new Set(boards.subtreeIds(String(id)));
    boards.remove(String(id));
    // 削除したノート（子ノートも）を指す送り先の登録も外す
    try {
      SB.pruneTargets(root, (t) => (t.appId || null) === appId && gone.has(t.boardId));
    } catch (err) {
      console.warn('[hex-memo] 送り先の登録を片付けられませんでした:', err);
    }
    boardsChanged(win);
    return boards.list();
  });
  // ---- コピーして送る ----
  handle('send:targets', () => ({ targets: SB.describeTargets(SB.readTargets(root), sendContext()) }));
  // 登録してあるかを見るだけ（見出しは作らない。右クリックのたびに使うので軽く）
  handle('send:registered', () => ({ targets: SB.readTargets(root) }));
  handle('send:catalog', () => ({ apps: SB.catalog(sendContext()) }));
  handle('send:targets-add', (raw) => {
    const r = SB.addTarget(root, raw);
    return { targets: SB.describeTargets(r.targets, sendContext()), id: r.target.id, existed: r.existed };
  });
  handle('send:targets-remove', (id) => ({ targets: SB.describeTargets(SB.removeTarget(root, String(id)), sendContext()) }));
  handleFrom('send:records', (win, target, payload) => sendRecords(win, target, payload));
  handle('boards:activate', (id) => {
    boards.activate(String(id));
    return {};
  });
  handle('board:load', (id) => {
    const s = boards.store(String(id));
    return { store: s.current, rev: revOf(id), notices: s.takeNotices(), readOnly: s.readOnly };
  });
  handle('board:stats', (id) => boards.stats(String(id)));
  // 中身を読むだけ（サイドバーの作成履歴でほかのノートを見るとき）。開いたときに出す案内（notices）は取らずに残す
  handle('board:peek', (id) => ({ store: boards.store(String(id)).current }));
  // meta.baseRev：どの版をもとにした内容か（古ければ保存せず、最新の内容を返す）。meta.data：中身の変更か（表示位置だけではないか）
  ipcMain.handle('board:save', (event, id, data, meta) => {
    const win = ourWindow(event.sender);
    if (!win) return { ok: false, error: 'unexpected sender' };
    if (meta && Number.isInteger(meta.baseRev) && meta.baseRev !== revOf(id)) {
      try {
        return { ok: false, conflict: true, rev: revOf(id), store: boards.store(String(id)).current };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    }
    const res = trySave(id, data);
    if (res.ok) res.rev = boardSaved(id, win, !meta || meta.data !== false);
    return res;
  });
  // ウィンドウを閉じる直前の書き出し用（レンダラ側で同期的に待つ）
  ipcMain.on('board:save-sync', (event, snapshots) => {
    const win = ourWindow(event.sender);
    if (!win) {
      event.returnValue = { ok: false, error: 'unexpected sender' };
      return;
    }
    const results = (Array.isArray(snapshots) ? snapshots : []).map((s) => {
      const res = trySave(s && s.id, s && s.data);
      if (res.ok) boardSaved(s.id, win);
      return res;
    });
    event.returnValue = { ok: results.every((r) => r.ok), results };
  });
}

// 同じデータファイルを2つのプロセスが書き合わないよう、多重起動は今のプロセスに寄せる。
// もう一度開いたら新しいウィンドウを開く（マスへのリンクから開いたときは、今のウィンドウでそのマスへ）
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // 受け取れる版が動いている印（送る側が、古い版のまま動いているアプリを見分けるのに使う）。
  // 多重起動の印を取ったらすぐに書く（終わった後に残っても、プロセスが無ければ「動いていない」と分かる）
  SB.markInboxAlive(dataDir, process.pid);
  app.on('second-instance', (_event, argv) => {
    // 受け取るためだけに起動して、終わるところだった：その起動は、終わった後にふつうに開き直す
    if (inboxQuitting) {
      app.relaunch({ args: (Array.isArray(argv) ? argv : []).slice(1) });
      return;
    }
    // コピーして送る：ほかのメモアプリから届いた合図。取り込むだけで、ウィンドウは開かない・前にも出さない
    const inbox = Array.isArray(argv) && argv.some(SB.isInboxArg);
    // 受け取るためだけに起動している途中で、ふつうに開かれた（起動ファイル・マスへのリンク）：ふつうに起動を続ける
    if (headless && !inbox) {
      const link = linkFromArgv(argv);
      if (link) pendingLink = link;
      startNormal();
      return;
    }
    if (inbox) runInbox('live');
    const link = linkFromArgv(argv);
    if (link) {
      routeLink(link);
      const win = activeWindow();
      if (win) {
        if (win.isMinimized()) win.restore();
        win.focus();
      }
      return;
    }
    if (inbox) return;
    createWindow({ from: activeWindow() });
  });

  // マスへのリンク：このアプリ宛てなら画面へ渡し、別のメモアプリ宛てならそのアプリを開いて渡す
  function routeLink(url) {
    const link = parseInternalLink(url);
    if (!link) return;
    if ((link.appId || null) !== appId) {
      const entry = link.appId ? new AppRegistry(root).load().get(link.appId) : null;
      if (!link.appId || entry) launchApp(entry, [url]);
      return;
    }
    const win = activeWindow();
    if (win) win.webContents.send('link:navigate', url);
    else pendingLink = url;
  }

  // 受け取るためだけに起動した：届いたものを取り込んで、画面を開かずに終わる。
  // ファイルが使用中などで一時的に取り込めなかったものは、少し待って何度か試してから終わる（その間にふつうに
  // 開かれたら、ふつうに起動を続ける）。読み込みで直したこと（壊れた一覧の作り直し・.bak からの復元など）があれば、
  // 画面を開いて知らせる
  let headless = false;
  let headlessTimer = 0;
  let boardsLoaded = false;
  function startInboxOnly() {
    headless = true;
    try {
      boards.load();
      boardsLoaded = true;
    } catch (err) {
      console.error('[hex-memo] ノートを読み込めませんでした:', err);
      finishInboxOnly();
      return;
    }
    let tries = 0;
    const step = () => {
      headlessTimer = 0;
      if (!headless) return;
      const res = runInbox('headless');
      if (boards.notices.length || [...boards.stores.values()].some((st) => st.notices && st.notices.length)) {
        startNormal();
        return;
      }
      if (res && res.deferred.length && ++tries < 8) {
        headlessTimer = setTimeout(step, 3000);
        return;
      }
      finishInboxOnly();
    };
    step();
  }

  // ここまでで書き込みは終わり。ほかの起動がふつうに始められるよう、先に多重起動の印を外してから終わる
  function finishInboxOnly() {
    headless = false;
    inboxQuitting = true;
    app.releaseSingleInstanceLock();
    app.quit();
  }

  app.whenReady().then(() => {
    // 起動時のリンクが別のメモアプリ宛てなら、そちらを開いてこのプロセスは終わる
    const startLink = pendingLink && parseInternalLink(pendingLink);
    if (startLink && (startLink.appId || null) !== appId) {
      routeLink(pendingLink);
      app.quit();
      return;
    }
    if (inboxLaunch) {
      startInboxOnly();
      return;
    }
    startNormal();
  });

  // ふつうの起動（ウィンドウを開く）。受け取るためだけに起動している途中で、ふつうに開かれたときにも使う
  let started = false;
  function startNormal() {
    if (started) return;
    started = true;
    headless = false;
    clearTimeout(headlessTimer);
    protocol.handle(ATT_SCHEME, async (request) => {
      let name = '';
      try {
        name = decodeURIComponent(new URL(request.url).pathname.replace(/^\//, ''));
      } catch {
        name = '';
      }
      const abs = attachments.resolve(name);
      if (!abs) return new Response('bad request', { status: 400 });
      try {
        const data = await fs.promises.readFile(abs);
        return new Response(data, { headers: { 'Content-Type': attachments.mime(name), 'Cache-Control': 'max-age=31536000, immutable' } });
      } catch {
        return new Response('not found', { status: 404 });
      }
    });
    if (!boardsLoaded) boards.load(); // 受け取るために起動したときは、もう読み込んである
    boardsLoaded = true;
    settings.load();
    const quickErr = applyQuickShortcut();
    if (quickErr) boards.notice('warn', `クイック入力：${quickErr}`);
    const captureErr = applyCaptureShortcut();
    if (captureErr) boards.notice('warn', `六角形スクショ：${captureErr}`);
    registerCaptureIpc();
    applyTray();
    app.on('will-quit', () => globalShortcut.unregisterAll());
    // 期限の通知：起動して少ししてから1回、あとは毎日の設定時刻に
    setTimeout(() => notifyDue(), 8000).unref();
    scheduleNotify();
    // 前に受け取ったときのお知らせと、まだ取り込んでいないもの（このアプリが古い版のまま動いていた間に届いたものなど）
    for (const n of SB.takeInboxNotices(dataDir)) boards.notice(n.level, n.message);
    runInbox('startup');
    // 使われていない添付ファイルの片付け（作ってから 3 日たったものだけ。起動の邪魔をしないよう少し後で）
    setTimeout(() => {
      try {
        const refs = collectDirRefs(dataDir);
        if (refs) attachments.sweep(refs);
      } catch (err) {
        console.warn('[hex-memo] 添付ファイルの片付けに失敗しました:', err);
      }
    }, 15000).unref();
    if (appId) {
      // 起動ファイルの名前・場所が変わっていたら一覧に反映する
      try {
        new AppRegistry(root).load().touch(appId, { name: appName, launcher: process.env.HEX_MEMO_APP_LAUNCHER || null });
      } catch (err) {
        console.warn('[hex-memo] メモアプリ一覧を更新できませんでした:', err);
      }
    }
    registerIpc();
    buildMenu();
    createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  }

  app.on('window-all-closed', () => {
    if (isMac || quitting) return;
    if (tray && settings.get().tray.enabled) return; // トレイに常駐（六角形スクショ・クイック入力のキーが効き続ける）
    app.quit();
  });
}
