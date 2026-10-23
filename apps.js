'use strict';

/* 別のメモアプリ（データを分けた六角メモ）の管理。
 * 作成すると、アプリのフォルダに「名前.cmd」（起動ファイル）ができ、データは
 * <データフォルダ>/apps/<ID>/ に保存される。一覧は <データフォルダ>/apps.json。
 * Electron に依存しないので Node 単体でテストできる。 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { readJsonFile, writeFileAtomic, stamp } = require('./store');

const REGISTRY_FILE = 'apps.json';
const APPS_DIR = 'apps';
const MAIN_NAME = '六角メモ';
const MAIN_LAUNCHER = '六角メモ.cmd';
const ID_RE = /^[0-9a-f]{8}$/;
const NAME_MAX = 60;
// Windows のファイル名に使えない文字に加え、起動ファイル（.cmd）で意味を持つ % ^ & ! も避ける
const BAD_CHARS = /[\\/:*?"<>|%^&!\u0000-\u001f]/;
const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;

function validateAppName(raw) {
  const name = typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim() : '';
  if (!name) return { ok: false, error: '名前を入力してください' };
  if ([...name].length > NAME_MAX) return { ok: false, error: `名前は ${NAME_MAX} 文字までです` };
  if (BAD_CHARS.test(name)) return { ok: false, error: '次の文字は使えません：\\ / : * ? " < > | % ^ & !' };
  if (name.endsWith('.')) return { ok: false, error: '名前の最後に「.」は使えません' };
  if (RESERVED.test(name)) return { ok: false, error: 'この名前は Windows で使えません' };
  if (name === MAIN_NAME) return { ok: false, error: `「${MAIN_NAME}」は元のアプリの名前です。別の名前にしてください` };
  return { ok: true, name };
}

/**
 * 起動ファイルの中身。同じフォルダの 六角メモ.cmd（無ければ作成時のアプリの場所）を、
 * このアプリの ID と名前（＝このファイルの名前）を付けて呼ぶ。
 */
function launcherScript(id, appDir) {
  const fallback = path.win32.join(appDir, MAIN_LAUNCHER); // Windows 用の起動ファイルなので、区切りは常に \
  return [
    '@echo off',
    'chcp 65001 >nul',
    'rem 六角メモ：別のメモアプリの起動ファイル。ファイル名がアプリの名前になります。',
    `set "HEX_MEMO_APP_ID=${id}"`,
    'set "HEX_MEMO_APP_NAME=%~n0"',
    'set "HEX_MEMO_APP_LAUNCHER=%~f0"',
    `if exist "%~dp0${MAIN_LAUNCHER}" (`,
    `  call "%~dp0${MAIN_LAUNCHER}" %*`,
    ') else (',
    `  call "${fallback}" %*`,
    ')',
    '',
  ].join('\r\n');
}

class AppRegistry {
  constructor(root) {
    this.root = root;
    this.file = path.join(root, REGISTRY_FILE);
    this.apps = []; // { id, name, launcher, createdAt }
  }

  load(now = new Date()) {
    const res = readJsonFile(this.file);
    if (res.status === 'ok' && Array.isArray(res.value.apps)) {
      const seen = new Set();
      this.apps = res.value.apps
        .filter((a) => a && typeof a === 'object' && ID_RE.test(a.id) && !seen.has(a.id) && seen.add(a.id))
        .map((a) => ({
          id: a.id,
          name: validateAppName(a.name).ok ? validateAppName(a.name).name : `メモアプリ（${a.id}）`,
          launcher: typeof a.launcher === 'string' ? a.launcher : null,
          createdAt: typeof a.createdAt === 'string' ? a.createdAt : null,
        }));
      return this;
    }
    if (res.status === 'corrupt' || res.status === 'ok') {
      try {
        fs.renameSync(this.file, `${this.file}.corrupt-${stamp(now)}`);
      } catch {
        // 一覧はデータフォルダから作り直せる
      }
    }
    this.rebuild();
    return this;
  }

  // 一覧が無い・壊れているときは、apps/ の中のフォルダから作り直す（名前は仮）
  rebuild() {
    let dirs = [];
    try {
      dirs = fs.readdirSync(path.join(this.root, APPS_DIR), { withFileTypes: true })
        .filter((d) => d.isDirectory() && ID_RE.test(d.name))
        .map((d) => d.name);
    } catch {
      dirs = [];
    }
    this.apps = dirs.map((id) => ({ id, name: `メモアプリ（${id}）`, launcher: null, createdAt: null }));
  }

  save() {
    fs.mkdirSync(this.root, { recursive: true });
    writeFileAtomic(this.file, `${JSON.stringify({ version: 1, apps: this.apps }, null, 2)}\n`);
  }

  get(id) {
    return this.apps.find((a) => a.id === id) || null;
  }

  dataDir(id) {
    return path.join(this.root, APPS_DIR, id);
  }

  /**
   * 新しいメモアプリを作る。launcherDir に「名前.cmd」を置く（Windows のみ。それ以外は null）。
   */
  create({ name, launcherDir, appDir, withLauncher = process.platform === 'win32', now = new Date() }) {
    const v = validateAppName(name);
    if (!v.ok) throw new Error(v.error);
    const launcher = withLauncher ? path.join(launcherDir, `${v.name}.cmd`) : null;
    if (launcher && fs.existsSync(launcher)) throw new Error(`「${v.name}.cmd」はすでにあります。別の名前にしてください`);
    if (this.apps.some((a) => a.name === v.name)) throw new Error(`「${v.name}」という名前のメモアプリはすでにあります`);

    let id;
    do {
      id = crypto.randomBytes(4).toString('hex');
    } while (this.get(id) || fs.existsSync(this.dataDir(id)));

    fs.mkdirSync(this.dataDir(id), { recursive: true });
    if (launcher) fs.writeFileSync(launcher, launcherScript(id, appDir), { encoding: 'utf8', flag: 'wx' });
    const entry = { id, name: v.name, launcher, createdAt: now.toISOString() };
    this.apps.push(entry);
    this.save();
    return entry;
  }

  // 起動ファイルの名前を変えた・移動したときに、一覧の名前と場所を追いかける
  touch(id, { name, launcher }) {
    let entry = this.get(id);
    if (!entry) {
      entry = { id, name: name || `メモアプリ（${id}）`, launcher: launcher || null, createdAt: null };
      this.apps.push(entry);
    } else if ((!name || entry.name === name) && (!launcher || entry.launcher === launcher)) {
      return entry;
    } else {
      if (name) entry.name = name;
      if (launcher) entry.launcher = launcher;
    }
    this.save();
    return entry;
  }
}

module.exports = { AppRegistry, validateAppName, launcherScript, MAIN_NAME, MAIN_LAUNCHER, ID_RE, APPS_DIR, REGISTRY_FILE };
