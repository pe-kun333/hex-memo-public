'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { AppRegistry, validateAppName, launcherScript, REGISTRY_FILE } = require('../apps.js');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'hex-memo-apps-'));
}

test('メモアプリ名の検査', () => {
  assert.deepEqual(validateAppName('  仕事  メモ '), { ok: true, name: '仕事 メモ' });
  for (const bad of ['', '   ', 'a/b', 'a:b', 'a?b', 'a|b', '50%', 'a&b', 'a!b', 'a^b', 'x.', 'CON', 'lpt1', '六角メモ', 'あ'.repeat(61)]) {
    assert.equal(validateAppName(bad).ok, false, bad);
  }
  assert.equal(validateAppName('Report (2026)').ok, true);
});

test('起動ファイルの中身：ID・ファイル名＝アプリ名・同じフォルダの 六角メモ.cmd を優先', () => {
  const s = launcherScript('0a1b2c3d', 'C:\\Apps\\hex-memo');
  assert.ok(s.includes('\r\n') && !/[^\r]\n/.test(s), 'CRLF');
  assert.match(s, /^@echo off\r\nchcp 65001 >nul\r\n/);
  assert.ok(s.includes('set "HEX_MEMO_APP_ID=0a1b2c3d"'));
  assert.ok(s.includes('set "HEX_MEMO_APP_NAME=%~n0"'));
  assert.ok(s.includes('if exist "%~dp0六角メモ.cmd" ('));
  assert.ok(s.includes('call "C:\\Apps\\hex-memo\\六角メモ.cmd" %*'));
});

test('作成：起動ファイル・データフォルダ・一覧', () => {
  const root = tmpDir();
  const launchers = tmpDir();
  const reg = new AppRegistry(root).load();
  const entry = reg.create({ name: '仕事メモ', launcherDir: launchers, appDir: 'C:\\app', withLauncher: true });
  assert.match(entry.id, /^[0-9a-f]{8}$/);
  assert.equal(entry.launcher, path.join(launchers, '仕事メモ.cmd'));
  assert.ok(fs.readFileSync(entry.launcher, 'utf8').includes(entry.id));
  assert.ok(fs.statSync(path.join(root, 'apps', entry.id)).isDirectory());

  const again = new AppRegistry(root).load();
  assert.deepEqual(again.apps.map((a) => a.name), ['仕事メモ']);
  assert.throws(() => again.create({ name: '仕事メモ', launcherDir: launchers, appDir: 'C:\\app', withLauncher: true }), /すでにあります/);
  assert.throws(() => again.create({ name: 'a/b', launcherDir: launchers, appDir: 'C:\\app', withLauncher: true }), /使えません/);
});

test('起動ファイルの名前を変えたら一覧も追いかける', () => {
  const root = tmpDir();
  const reg = new AppRegistry(root).load();
  const entry = reg.create({ name: '日記', launcherDir: root, appDir: 'C:\\app', withLauncher: false });
  new AppRegistry(root).load().touch(entry.id, { name: '日記2026', launcher: 'D:\\x\\日記2026.cmd' });
  const a = new AppRegistry(root).load().get(entry.id);
  assert.equal(a.name, '日記2026');
  assert.equal(a.launcher, 'D:\\x\\日記2026.cmd');
});

test('一覧が壊れていたら、データフォルダから作り直す', () => {
  const root = tmpDir();
  const entry = new AppRegistry(root).load().create({ name: '読書', launcherDir: root, appDir: 'C:\\app', withLauncher: false });
  fs.writeFileSync(path.join(root, REGISTRY_FILE), '{ broken');
  const reg = new AppRegistry(root).load();
  assert.deepEqual(reg.apps.map((a) => a.id), [entry.id]);
  assert.equal(fs.readdirSync(root).filter((f) => f.startsWith(`${REGISTRY_FILE}.corrupt-`)).length, 1);
});
