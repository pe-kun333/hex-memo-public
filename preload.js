'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('hexMemo', {
  init: () => ipcRenderer.invoke('boards:init'),
  createBoard: (parentId = null) => ipcRenderer.invoke('boards:create', parentId),
  moveBoard: (id, parentId = null, beforeId = null) => ipcRenderer.invoke('boards:move', id, parentId, beforeId),
  renameBoard: (id, name) => ipcRenderer.invoke('boards:rename', id, name),
  deleteBoard: (id) => ipcRenderer.invoke('boards:delete', id),
  activateBoard: (id) => ipcRenderer.invoke('boards:activate', id),
  loadBoard: (id) => ipcRenderer.invoke('board:load', id),
  boardStats: (id) => ipcRenderer.invoke('board:stats', id),
  peekBoard: (id) => ipcRenderer.invoke('board:peek', id),
  saveBoard: (id, data, meta) => ipcRenderer.invoke('board:save', id, data, meta),
  saveSync: (snapshots) => ipcRenderer.sendSync('board:save-sync', snapshots),
  listApps: () => ipcRenderer.invoke('apps:list'),
  createApp: (name) => ipcRenderer.invoke('apps:create', name),
  openApp: (id) => ipcRenderer.invoke('apps:open', id),
  openDataFolder: () => ipcRenderer.invoke('app:open-data-folder'),
  writeClip: (payload) => ipcRenderer.invoke('clip:write', payload),
  readClip: () => ipcRenderer.invoke('clip:read'),
  writeLink: (payload) => ipcRenderer.invoke('clip:write-link', payload),
  // 添付（画像・保存したページ）
  putImage: (payload) => ipcRenderer.invoke('att:put-image', payload),
  openAttachment: (file) => ipcRenderer.invoke('att:open', file),
  revealAttachment: (file) => ipcRenderer.invoke('att:reveal', file),
  saveAttachmentAs: (file, name) => ipcRenderer.invoke('att:save-as', file, name),
  sweepAttachments: (options) => ipcRenderer.invoke('att:sweep', options),
  exportBoard: (id) => ipcRenderer.invoke('board:export', id),
  exportApp: () => ipcRenderer.invoke('app:export'),
  // リンク
  previewLink: (url) => ipcRenderer.invoke('link:preview', url),
  checkLinks: (urls) => ipcRenderer.invoke('link:check', urls),
  openLink: (url) => ipcRenderer.invoke('link:open', url),
  snapshotLink: (url) => ipcRenderer.invoke('link:snapshot', url),
  openMemoLink: (url) => ipcRenderer.invoke('link:open-memo', url),
  takePendingLink: () => ipcRenderer.invoke('link:take-pending'),
  onNavigate: (callback) => ipcRenderer.on('link:navigate', (_event, url) => callback(String(url))),
  registerProtocol: () => ipcRenderer.invoke('protocol:register'),
  importBookmarks: () => ipcRenderer.invoke('bookmarks:import'),
  onCommand: (callback) => ipcRenderer.on('view:command', (_event, cmd) => callback(String(cmd))),
  // ウィンドウ（同じメモアプリを複数のウィンドウで開く・常に最前面）
  // opts.mini なら小窓（常に最前面・セル1個分ほど）。keys・key は最初に見せる階層とマス
  newWindow: (boardId = null, opts = null) => ipcRenderer.invoke('window:new', boardId, opts),
  exitMini: (opts = null) => ipcRenderer.invoke('window:exit-mini', opts),
  setOnTop: (flag) => ipcRenderer.invoke('window:set-on-top', !!flag),
  // コピーして送る：送り先の登録（すべてのメモアプリで共通）・送る・ほかのメモアプリから届いたお知らせ
  sendTargets: () => ipcRenderer.invoke('send:targets'),
  sendRegistered: () => ipcRenderer.invoke('send:registered'),
  sendCatalog: () => ipcRenderer.invoke('send:catalog'),
  addSendTarget: (target) => ipcRenderer.invoke('send:targets-add', target),
  removeSendTarget: (id) => ipcRenderer.invoke('send:targets-remove', id),
  sendRecords: (target, payload) => ipcRenderer.invoke('send:records', target, payload),
  onAppNotice: (callback) => ipcRenderer.on('app:notice', (_event, notice) => callback(notice)),
  onOnTop: (callback) => ipcRenderer.on('window:on-top', (_event, on) => callback(!!on)),
  // ほかのウィンドウでの変更（ノートの中身・ノート一覧）
  onBoardChanged: (callback) => ipcRenderer.on('board:changed', (_event, payload) => callback(payload)),
  onBoardsChanged: (callback) => ipcRenderer.on('boards:changed', (_event, list) => callback(list)),
  // 設定（タグの登録・関連線の種類・クイック入力）。ほかのウィンドウで変えたときも届く
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  onSettingsChanged: (callback) => ipcRenderer.on('settings:changed', (_event, s) => callback(s)),
  // 文字のファイルの書き出し・読み込み（AI にタグ付けを頼むファイルと、その結果）
  saveTextFile: (payload) => ipcRenderer.invoke('file:save-text', payload),
  saveBinaryFile: (payload) => ipcRenderer.invoke('file:save-binary', payload),
  transcribeVoice: (payload) => ipcRenderer.invoke('voice:transcribe', payload),
  saveHtmlAsPdf: (payload) => ipcRenderer.invoke('file:save-pdf', payload),
  quickKey: () => ipcRenderer.invoke('quick:key'),
  minimizeApp: () => ipcRenderer.invoke('window:minimize-app'),
  openTextFile: (payload) => ipcRenderer.invoke('file:open-text', payload),
  // 期限の通知を今すぐ出す（設定の確認用）
  notifyDue: () => ipcRenderer.invoke('due:notify'),
  // 六角形スクショ：枠を出す／撮った画像が棚へ届く
  startCapture: () => ipcRenderer.invoke('capture:start'),
  onCapture: (callback) => ipcRenderer.on('capture:shelf', (_event, payload) => callback(payload)),
});
