'use strict';

/* 六角形スクショの枠（capture.html）と本体の橋渡し。撮った静止画を受け取り、切り取った画像とコメントを返す */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('hexCapture', {
  onFrame: (callback) => ipcRenderer.on('capture:frame', (_event, payload) => callback(payload)),
  done: (payload) => ipcRenderer.invoke('capture:done', payload),
  cancel: () => ipcRenderer.invoke('capture:cancel'),
  saveSize: (r) => ipcRenderer.invoke('capture:save-size', r),
});
