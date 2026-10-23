'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { MemoStore, normalizeStore, normalizeKey, normalizeRecord, isEmptyRecord, countMemos, STORE_VERSION, MAX_DEPTH } = require('../store.js');

const NOW = '2026-01-01T00:00:00.000Z';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'hex-memo-test-'));
}

function writeJson(file, value) {
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
}

const sampleV2 = {
  version: 2,
  camera: { x: 12.5, y: -40 },
  memos: {
    '0,0': {
      text: '本文',
      createdAt: '2025-05-01T10:00:00.000Z',
      updatedAt: '2025-05-02T10:00:00.000Z',
      likedLevel: 2,
      liked: true,
      bookmarked: false,
      comments: [{ id: 'c1', text: 'コメント', createdAt: '2025-05-03T10:00:00.000Z' }],
    },
  },
};

test('v2 はそのまま読み込める', () => {
  const { store, fromVersion, dropped } = normalizeStore(sampleV2, NOW);
  assert.equal(fromVersion, 2);
  assert.deepEqual(dropped, []);
  assert.deepEqual(store, sampleV2);
});

test('v1（liked: boolean）から likedLevel へ移行し、空のマスは捨てる', () => {
  const { store, fromVersion } = normalizeStore({
    version: 1,
    memos: {
      '1,2': { text: 'a', liked: true, updatedAt: '2025-01-01T00:00:00Z' },
      '3,4': { text: 'b', liked: false },
      '5,6': { text: '   ', liked: false },
    },
  }, NOW);
  assert.equal(fromVersion, 1);
  assert.deepEqual(Object.keys(store.memos), ['1,2', '3,4']);
  assert.equal(store.memos['1,2'].likedLevel, 1);
  assert.equal(store.memos['1,2'].liked, true);
  assert.equal(store.memos['1,2'].createdAt, '2025-01-01T00:00:00.000Z');
  assert.equal(store.memos['3,4'].likedLevel, 0);
  assert.equal(store.memos['3,4'].createdAt, NOW);
  assert.deepEqual(store.memos['3,4'].comments, []);
  assert.deepEqual(store.camera, { x: 0, y: 0 });
});

test('v0（座標→本文のマップ／配列）も読める', () => {
  const a = normalizeStore({ '0,0': 'こんにちは', '-1,2': { text: 'x' } }, NOW);
  assert.equal(a.fromVersion, 0);
  assert.equal(a.store.memos['0,0'].text, 'こんにちは');
  assert.equal(a.store.memos['-1,2'].text, 'x');

  const b = normalizeStore([{ q: 2, r: -1, text: '配列' }, { q: 'x', text: 'bad' }], NOW);
  assert.equal(b.fromVersion, 0);
  assert.equal(b.store.memos['2,-1'].text, '配列');
  assert.equal(b.dropped.length, 1);
});

test('いいね段階は 0〜3 の整数に丸める', () => {
  const { store } = normalizeStore({
    version: 2,
    memos: {
      '0,0': { text: 'a', likedLevel: 7 },
      '0,1': { text: 'b', likedLevel: -2 },
      '0,2': { text: 'c', likedLevel: 1.6 },
      '0,3': { text: 'd', likedLevel: 'x', liked: true },
    },
  }, NOW);
  assert.deepEqual(['0,0', '0,1', '0,2', '0,3'].map((k) => store.memos[k].likedLevel), [3, 0, 2, 1]);
});

test('座標キーを正規化し、読めないキーは dropped に入れる', () => {
  assert.equal(normalizeKey(' 01 , -0 '), '1,0');
  assert.equal(normalizeKey('a,b'), null);
  assert.equal(normalizeKey('1.5,2'), null);
  const { store, dropped } = normalizeStore({ version: 2, memos: { ' 3 ,4': { text: 'a' }, 'foo': { text: 'b' } } }, NOW);
  assert.deepEqual(Object.keys(store.memos), ['3,4']);
  assert.deepEqual(dropped, ['foo']);
});

test('コメント：文字列を変換し、空は捨て、重複 ID は振り直す', () => {
  const { store } = normalizeStore({
    version: 2,
    memos: { '0,0': { text: '', comments: ['やあ', { id: 'x', text: 'a' }, { id: 'x', text: 'b' }, { text: '  ' }] } },
  }, NOW);
  const c = store.memos['0,0'].comments;
  assert.equal(c.length, 3);
  assert.equal(c[0].text, 'やあ');
  assert.equal(c[0].createdAt, NOW);
  assert.equal(new Set(c.map((x) => x.id)).size, 3);
  assert.equal(c[1].id, 'x');
});

test('いいね・ブックマーク・コメントだけのマスも残る', () => {
  const { store } = normalizeStore({
    version: 2,
    memos: {
      '0,0': { text: '', likedLevel: 1 },
      '0,1': { text: '', bookmarked: true },
      '0,2': { text: '', comments: [{ text: 'c' }] },
      '0,3': { text: '', likedLevel: 0, bookmarked: false, comments: [] },
    },
  }, NOW);
  assert.deepEqual(Object.keys(store.memos), ['0,0', '0,1', '0,2']);
});

test('下の階層（children）を再帰的に正規化する', () => {
  const { store } = normalizeStore({
    version: 2,
    memos: {
      '0,0': {
        text: '親',
        children: {
          camera: { x: '10', y: null },
          memos: {
            ' 1 ,0': { text: '子', likedLevel: 9, children: { memos: { '0,1': { text: '孫' } } } },
            '2,0': { text: '   ' },
          },
        },
      },
      // 本文が空でも、下の階層に中身があれば残す
      '5,5': { text: '', children: { memos: { '1,1': { text: 'だけ' } } } },
      // 下の階層が空なら、本文も空のマスごと捨てる
      '6,6': { text: '', children: { memos: { '1,1': { text: '' } } } },
      '7,7': { text: 'x', children: { memos: {} } },
    },
  }, NOW);
  const child = store.memos['0,0'].children;
  assert.deepEqual(child.camera, { x: 10, y: 0 });
  assert.deepEqual(Object.keys(child.memos), ['1,0']);
  assert.equal(child.memos['1,0'].likedLevel, 3);
  assert.equal(child.memos['1,0'].children.memos['0,1'].text, '孫');
  assert.equal(store.memos['5,5'].children.memos['1,1'].text, 'だけ');
  assert.ok(!('6,6' in store.memos));
  assert.ok(!('children' in store.memos['7,7']));
  assert.equal(countMemos(store.memos), 6); // 0,0 / 1,0 / 0,1 / 5,5 / 1,1 / 7,7
});

test('関連付け：ID と links を保ち、実在しない相手・重複・自分自身への関連は捨てる', () => {
  const { store } = normalizeStore({
    version: 2,
    memos: {
      '0,0': { id: 'A', text: 'a' },
      '1,0': { id: 'B', text: 'b', children: { memos: { '1,0': { id: 'C', text: 'c' } } } },
      '2,0': { id: 'bad id!', text: 'x' },
    },
    links: [
      { a: 'A', b: 'B', createdAt: '2026-01-02T00:00:00Z' },
      { a: 'B', b: 'A' }, // 同じ組
      { a: 'A', b: 'C' }, // 下の階層のメモとも関連付けられる
      { a: 'A', b: 'A' },
      { a: 'A', b: 'Z' }, // 実在しない
      { a: 'A' },
      'x',
    ],
  }, NOW);
  assert.equal(store.memos['0,0'].id, 'A');
  assert.equal(store.memos['1,0'].children.memos['1,0'].id, 'C');
  assert.ok(!('id' in store.memos['2,0']));
  assert.deepEqual(store.links, [
    { a: 'A', b: 'B', createdAt: '2026-01-02T00:00:00.000Z' },
    { a: 'A', b: 'C', createdAt: NOW },
  ]);
});

test('関連付けがあるメモは、本文が空でも残す。同じ ID が重なったら後の方を外す', () => {
  const { store } = normalizeStore({
    version: 2,
    memos: { '0,0': { id: 'A', text: '' }, '1,0': { id: 'B', text: 'b' }, '2,0': { id: 'B', text: 'dup' }, '3,0': { id: 'Q', text: '' } },
    links: [{ a: 'A', b: 'B' }],
  }, NOW);
  assert.deepEqual(Object.keys(store.memos), ['0,0', '1,0', '2,0']);
  assert.equal(store.memos['1,0'].id, 'B');
  assert.ok(!('id' in store.memos['2,0']));
  assert.equal(store.links.length, 1);
  assert.ok(!('links' in normalizeStore({ version: 2, memos: {} }, NOW).store), '関連が無ければ links は持たない');
});

test('表示倍率（zoom）は 1 以外のときだけ保存し、範囲に収める', () => {
  const norm = (camera) => normalizeStore({ version: 2, camera, memos: {} }, NOW).store.camera;
  assert.deepEqual(norm({ x: 1, y: 2 }), { x: 1, y: 2 });
  assert.deepEqual(norm({ x: 1, y: 2, zoom: 1 }), { x: 1, y: 2 });
  assert.deepEqual(norm({ x: 1, y: 2, zoom: 0.3 }), { x: 1, y: 2, zoom: 0.3 });
  assert.deepEqual(norm({ x: 0, y: 0, zoom: 0.0001 }), { x: 0, y: 0, zoom: 0.04 });
  assert.deepEqual(norm({ x: 0, y: 0, zoom: 99 }), { x: 0, y: 0, zoom: 1.5 });
  assert.deepEqual(norm({ x: 0, y: 0, zoom: 'x' }), { x: 0, y: 0 });
  const { store } = normalizeStore({ version: 2, memos: { '0,0': { text: 'a', children: { camera: { x: 5, y: 5, zoom: 0.5 }, memos: { '1,0': { text: 'b' } } } } } }, NOW);
  assert.deepEqual(store.memos['0,0'].children.camera, { x: 5, y: 5, zoom: 0.5 });
});

test('階層は上限より深いところを読み飛ばす', () => {
  let rec = { text: '底' };
  for (let i = 0; i < MAX_DEPTH + 5; i++) rec = { text: `L${i}`, children: { memos: { '1,0': rec } } };
  const { store, dropped } = normalizeStore({ version: 2, memos: { '0,0': rec } }, NOW);
  let depth = 0;
  let cur = store.memos['0,0'];
  while (cur.children) {
    cur = cur.children.memos['1,0'];
    depth++;
  }
  assert.equal(depth, MAX_DEPTH);
  assert.equal(dropped.length, 1);
});

test('MemoStore：ファイルが無ければ空で始まり、保存→再読み込みで復元できる', () => {
  const dir = tmpDir();
  const s1 = new MemoStore(dir);
  assert.deepEqual(s1.load().memos, {});
  s1.save(sampleV2);

  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'memos.json'), 'utf8'));
  assert.equal(saved.version, STORE_VERSION);
  assert.deepEqual(saved, sampleV2);
  assert.ok(!fs.existsSync(path.join(dir, 'memos.json.tmp')));
  assert.ok(!fs.existsSync(path.join(dir, 'memos.json.bak')), '元ファイルが無ければ .bak は作らない');

  const s2 = new MemoStore(dir);
  assert.deepEqual(s2.load(), sampleV2);
  assert.deepEqual(s2.takeNotices(), []);
});

test('MemoStore：セッション最初の保存前に .bak を作る', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'memos.json');
  writeJson(file, sampleV2);
  const s = new MemoStore(dir);
  s.load();
  s.save({ version: 2, camera: { x: 0, y: 0 }, memos: {} });
  s.save({ version: 2, camera: { x: 1, y: 1 }, memos: {} });
  assert.deepEqual(JSON.parse(fs.readFileSync(`${file}.bak`, 'utf8')), sampleV2);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).camera, { x: 1, y: 1 });
});

test('MemoStore：壊れたファイルは退避し、.bak から復元する', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'memos.json');
  writeJson(file, '{ "version": 2, "memos": {');
  writeJson(`${file}.bak`, sampleV2);
  const s = new MemoStore(dir);
  assert.deepEqual(s.load(), sampleV2);
  const corrupt = fs.readdirSync(dir).filter((f) => f.startsWith('memos.json.corrupt-'));
  assert.equal(corrupt.length, 1);
  assert.equal(fs.readFileSync(path.join(dir, corrupt[0]), 'utf8'), '{ "version": 2, "memos": {');
  const notices = s.takeNotices();
  assert.equal(notices.length, 1);
  assert.equal(notices[0].level, 'warn');
  assert.deepEqual(s.takeNotices(), [], '通知は一度だけ');
});

test('MemoStore：壊れていて .bak も無ければ空で始め、壊れたファイルは残す', () => {
  const dir = tmpDir();
  writeJson(path.join(dir, 'memos.json'), '');
  const s = new MemoStore(dir);
  assert.deepEqual(s.load().memos, {});
  assert.equal(fs.readdirSync(dir).filter((f) => f.startsWith('memos.json.corrupt-')).length, 1);
  assert.equal(s.readOnly, false);
});

test('MemoStore：旧形式は最初の保存前に原本を残す', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'memos.json');
  const v1 = { version: 1, memos: { '0,0': { text: '旧', liked: true } } };
  writeJson(file, v1);
  const s = new MemoStore(dir);
  const loaded = s.load();
  assert.equal(loaded.memos['0,0'].likedLevel, 1);
  assert.equal(s.takeNotices()[0].level, 'info');
  s.save(loaded);
  const backups = fs.readdirSync(dir).filter((f) => f.startsWith('memos.backup-v1-'));
  assert.equal(backups.length, 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, backups[0]), 'utf8')), v1);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).version, 2);
});

test('MemoStore：読み込みエラー（ファイルでない等）では保存を拒否する', () => {
  const dir = tmpDir();
  fs.mkdirSync(path.join(dir, 'memos.json'));
  const s = new MemoStore(dir);
  s.load();
  assert.equal(s.readOnly, true);
  assert.equal(s.takeNotices()[0].level, 'error');
  assert.throws(() => s.save(sampleV2));
});

test('BOM 付きの JSON も読める', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'memos.json'), `﻿${JSON.stringify(sampleV2)}`);
  const s = new MemoStore(dir);
  assert.deepEqual(s.load(), sampleV2);
});

test('いいね・ブックマークした時刻は、付いているときだけ残す', () => {
  const now = '2026-09-26T00:00:00.000Z';
  const s = normalizeStore({
    version: 2,
    memos: {
      '0,0': { text: 'a', likedLevel: 2, likedAt: '2026-09-25T10:00:00Z', bookmarked: true, bookmarkedAt: '2026-09-25T11:00:00.000Z' },
      '1,0': { text: 'b', likedLevel: 0, likedAt: '2026-09-25T10:00:00Z', bookmarked: false, bookmarkedAt: '2026-09-25T11:00:00.000Z' },
      '2,0': { text: 'c', likedLevel: 1, likedAt: 'おかしな日時', bookmarked: true },
    },
  }, now).store;
  assert.equal(s.memos['0,0'].likedAt, '2026-09-25T10:00:00.000Z');
  assert.equal(s.memos['0,0'].bookmarkedAt, '2026-09-25T11:00:00.000Z');
  assert.equal('likedAt' in s.memos['1,0'], false);
  assert.equal('bookmarkedAt' in s.memos['1,0'], false);
  assert.equal('likedAt' in s.memos['2,0'], false);
  assert.equal('bookmarkedAt' in s.memos['2,0'], false);
});

// ---- 添付（画像・リンク） ----

test('画像の添付：正しいファイル名だけ残し、表紙は添付した画像の中からだけ', () => {
  const now = '2026-09-26T00:00:00.000Z';
  const f = `${'a'.repeat(64)}.png`;
  const rec = normalizeRecord({
    text: '',
    images: [
      { id: 'img1', file: f, thumb: `${'a'.repeat(64)}.thumb.webp`, name: ' 画像.png ', width: 800, height: 600, size: 1234, caption: '説明' },
      { file: '../../secret.png' },
      { file: `${'b'.repeat(64)}.pdf` }, // 画像ではない
      { file: `${'c'.repeat(64)}.png`, thumb: `${'c'.repeat(64)}.png` }, // 縮小版の名前ではない → 縮小版なし
    ],
    cover: 'img1',
  }, now);
  assert.equal(rec.images.length, 2);
  assert.deepEqual(rec.images[0], { id: 'img1', file: f, thumb: `${'a'.repeat(64)}.thumb.webp`, name: '画像.png', width: 800, height: 600, size: 1234, caption: '説明', addedAt: now });
  assert.equal(rec.images[1].thumb, undefined);
  assert.equal(rec.cover, 'img1');
  assert.equal(normalizeRecord({ images: [{ file: f }], cover: 'nothere' }, now).cover, undefined);
  assert.equal(isEmptyRecord(rec), false); // 本文が空でも画像があれば残す
});

test('リンクの添付：http(s) だけ。状態・保存したページ・ファビコンの形も確かめる', () => {
  const now = '2026-09-26T00:00:00.000Z';
  const rec = normalizeRecord({
    urls: [
      { id: 'u1', url: 'https://example.com/a', title: ' 題 ', favicon: `${'d'.repeat(64)}.ico`, image: `${'e'.repeat(64)}.jpg`, status: 'broken', statusCode: 404, checkedAt: now, snapshot: { file: `${'f'.repeat(64)}.pdf`, savedAt: now, title: 'ページ' } },
      { url: 'javascript:alert(1)' },
      { url: 'file:///C:/x' },
      { id: 'u1', url: 'http://localhost:3000/', status: 'weird', snapshot: { file: `${'f'.repeat(64)}.png` } },
    ],
  }, now);
  assert.equal(rec.urls.length, 2);
  assert.deepEqual(rec.urls[0], {
    id: 'u1', url: 'https://example.com/a', title: '題', favicon: `${'d'.repeat(64)}.ico`, image: `${'e'.repeat(64)}.jpg`, addedAt: now,
    status: 'broken', statusCode: 404, checkedAt: now, snapshot: { file: `${'f'.repeat(64)}.pdf`, savedAt: now, title: 'ページ' },
  });
  assert.notEqual(rec.urls[1].id, 'u1'); // 重なった ID は付け直す
  assert.equal(rec.urls[1].status, undefined);
  assert.equal(rec.urls[1].snapshot, undefined);
  assert.equal(isEmptyRecord(normalizeRecord({ urls: [{ url: 'https://x.example/' }] }, now)), false);
  assert.equal('urls' in normalizeRecord({ text: 'a', urls: [] }, now), false); // 無いときは項目ごと持たない
});

test('同じメモの周りに重ねた層：第1層は children、第2層以降は moreLayers（後ろの空の層は持たない）', () => {
  const now = '2026-09-27T00:00:00.000Z';
  const m = (text) => ({ text });
  const s = normalizeStore({
    version: 2,
    memos: {
      // 第1層は空、第2層に中身、第3層は空 → 第3層だけ外す（第1層は番号を保つために残す）
      '0,0': { text: 'a', children: { memos: {} }, moreLayers: [{ name: '  反論  ', memos: { '1,0': m('x') } }, { memos: {} }] },
      // 重ねた層がすべて空 → 第1層だけ
      '1,0': { text: 'b', children: { name: '感想', memos: { '1,0': m('y') } }, moreLayers: [{ memos: {} }] },
      // 何もない
      '2,0': { text: 'c', children: { memos: {} }, moreLayers: [] },
      // children が無くても moreLayers があれば読む
      '3,0': { text: 'd', moreLayers: [{ memos: { '0,1': m('z') } }] },
    },
  }, now).store;
  assert.deepEqual(Object.keys(s.memos['0,0'].children.memos), []);
  assert.equal(s.memos['0,0'].moreLayers.length, 1);
  assert.equal(s.memos['0,0'].moreLayers[0].name, '反論');
  assert.equal(s.memos['0,0'].moreLayers[0].memos['1,0'].text, 'x');
  assert.equal(s.memos['1,0'].children.name, '感想');
  assert.equal('moreLayers' in s.memos['1,0'], false);
  assert.equal('children' in s.memos['2,0'], false);
  assert.equal(s.memos['3,0'].moreLayers[0].memos['0,1'].text, 'z');
  assert.deepEqual(Object.keys(s.memos['3,0'].children.memos), []);
  assert.equal(countMemos(s.memos), 4 + 3);
});

test('画像とセルの組み合わせ（層の combo）：中心のメモの画像だけ。メモが無くても層を残し、値は範囲に収める', () => {
  const now = '2026-09-30T00:00:00.000Z';
  const img = (id, c) => ({ id, file: `${c.repeat(64)}.png`, width: 800, height: 600 });
  const s = normalizeStore({
    version: 2,
    memos: {
      // メモの無い層でも、組み合わせがあれば残す
      '0,0': { text: 'a', images: [img('im1', 'a')], children: { memos: {}, combo: { image: 'im1', x: 12.5, y: -3, w: 1600, fade: 'faint', extra: 1 } } },
      // 画像が無い（外された）→ 組み合わせも外す → 空の層も残さない
      '1,0': { text: 'b', images: [img('im2', 'b')], children: { memos: {}, combo: { image: 'gone', x: 0, y: 0, w: 900 } } },
      // 値がおかしい：位置は数値に、幅は範囲に、濃さは知らないものを外す。重ねた層にも付けられる
      '2,0': {
        text: 'c',
        images: [img('im3', 'c')],
        children: { memos: { '1,0': { text: 'x' } } },
        moreLayers: [{ memos: {}, combo: { image: 'im3', x: 'abc', y: 1e99, w: 0.5, fade: 'dark' } }],
      },
      // 中心のメモに画像が無ければ組み合わせられない
      '3,0': { text: 'd', children: { memos: { '0,1': { text: 'y' } }, combo: { image: 'im1', x: 0, y: 0, w: 1000 } } },
    },
  }, now).store;
  assert.deepEqual(s.memos['0,0'].children.combo, { image: 'im1', x: 12.5, y: -3, w: 1600, fade: 'faint' });
  assert.deepEqual(s.memos['0,0'].children.memos, {});
  assert.equal('children' in s.memos['1,0'], false);
  assert.equal('combo' in s.memos['2,0'].children, false);
  assert.deepEqual(s.memos['2,0'].moreLayers[0].combo, { image: 'im3', x: 0, y: 1e7, w: 20 });
  assert.equal('combo' in s.memos['3,0'].children, false);
});

test('分けて並べた文章の通し番号（seq）は、正しい形のときだけ残す', () => {
  const s = normalizeStore({
    version: 2,
    memos: {
      '0,0': { text: 'a', seq: { id: 'ab12cd34ef', n: 1, head: true } },
      '1,0': { text: 'b', seq: { id: 'ab12cd34ef', n: 2, head: 'yes', para: 1 } },
      '5,0': { text: 'f', seq: { id: 'ab12cd34ef', n: 3, para: true } },
      '2,0': { text: 'c', seq: { id: 'BAD ID', n: 3 } },
      '3,0': { text: 'd', seq: { id: 'ab12cd34ef', n: 0 } },
      '4,0': { text: 'e', seq: { id: 'ab12cd34ef', n: 2.5 } },
    },
  }, '2026-09-27T00:00:00.000Z').store;
  assert.deepEqual(s.memos['0,0'].seq, { id: 'ab12cd34ef', n: 1, head: true });
  assert.deepEqual(s.memos['1,0'].seq, { id: 'ab12cd34ef', n: 2 });
  assert.deepEqual(s.memos['5,0'].seq, { id: 'ab12cd34ef', n: 3, para: true }); // 段落の最初のマス
  for (const k of ['2,0', '3,0', '4,0']) assert.equal('seq' in s.memos[k], false, k);
});

test('タグ：# と空白を除いて重複なく持つ。タグだけのマスも残す。読み込み直しても同じ', () => {
  const { store } = normalizeStore({
    version: 2,
    memos: {
      '0,0': { text: 'a', tags: ['#仕事', '仕事', ' 買い物 ', '', 42, '#'] },
      '1,0': { text: '', tags: ['solo'] },
      '2,0': { text: '', tags: [] },
    },
  }, NOW);
  assert.deepEqual(store.memos['0,0'].tags, ['仕事', '買い物']);
  assert.deepEqual(store.memos['1,0'].tags, ['solo']);
  assert.equal('2,0' in store.memos, false);
  assert.equal('tags' in normalizeRecord({ text: 'x' }, NOW), false);
  assert.deepEqual(normalizeStore(store, NOW).store, store);
});

test('コメントの返信（parentId）：相手が無い・自分自身・輪になるものは返信扱いにしない', () => {
  const { store } = normalizeStore({
    version: 2,
    memos: {
      '0,0': {
        text: 'a',
        comments: [
          { id: 'a', text: '1' },
          { id: 'b', text: '2', parentId: 'a' },
          { id: 'c', text: '3', parentId: 'zzz' },
          { id: 'd', text: '4', parentId: 'd' },
          { id: 'e', text: '5', parentId: 'f' },
          { id: 'f', text: '6', parentId: 'e' },
        ],
      },
    },
  }, NOW);
  const byId = Object.fromEntries(store.memos['0,0'].comments.map((c) => [c.id, c.parentId || null]));
  assert.equal(byId.b, 'a');
  assert.equal(byId.c, null);
  assert.equal(byId.d, null);
  // 輪は、どちらか一方の返信扱いが外れて木になる
  assert.equal([byId.e, byId.f].filter(Boolean).length, 1);
});

test('関連付けの種類とラベル：読める形だけ残す', () => {
  const memos = {
    '0,0': { id: 'A', text: 'a' },
    '1,0': { id: 'B', text: 'b' },
    '2,0': { id: 'C', text: 'c' },
  };
  const { store } = normalizeStore({
    version: 2,
    memos,
    links: [
      { a: 'A', b: 'B', kind: 'support', label: '  根拠 の 1  ' },
      { a: 'B', b: 'C', kind: 'Bad Kind!', label: 'x'.repeat(100) },
    ],
  }, NOW);
  assert.equal(store.links[0].kind, 'support');
  assert.equal(store.links[0].label, '根拠 の 1');
  assert.equal('kind' in store.links[1], false);
  assert.equal([...store.links[1].label].length, 40);
});

test('領域：名前とマスのキーの一覧。下の階層の領域も残り、領域だけの層も残る', () => {
  const { store } = normalizeStore({
    version: 2,
    memos: {
      '0,0': {
        text: 'a',
        children: { memos: {}, regions: [{ id: 'r1', name: '感想', keys: ['1,0', '1, 0', '0,1'] }] },
      },
    },
    regions: [
      { name: ' 仕事 の島 ', keys: ['0,0', '1,0'], color: '#ABCDEF' },
      { name: '', keys: ['0,0'] },
      { name: 'キー無し', keys: [] },
      { id: 'dup', name: 'x', keys: ['3,3'] },
      { id: 'dup', name: 'y', keys: ['4,4'] },
    ],
  }, NOW);
  assert.equal(store.regions.length, 3);
  assert.deepEqual(store.regions[0], { id: store.regions[0].id, name: '仕事 の島', keys: ['0,0', '1,0'], color: '#abcdef' });
  assert.equal(store.regions[1].id, 'dup');
  assert.notEqual(store.regions[2].id, 'dup');
  assert.deepEqual(store.memos['0,0'].children.regions, [{ id: 'r1', name: '感想', keys: ['1,0', '0,1'] }]);
  assert.deepEqual(normalizeStore(store, NOW).store, store);
});

test('期限と進み具合：日付だけを持ち、進み具合は 0〜6。期限だけのマスも残る', () => {
  const { store } = normalizeStore({
    version: 2,
    memos: {
      '0,0': { text: 'a', due: '2026-10-05T12:00:00Z', progress: 9 },
      '1,0': { text: '', due: '2026-10-06' },
      '2,0': { text: 'b', due: 'いつか', progress: 0 },
      '3,0': { text: '', progress: 2 },
    },
  }, NOW);
  assert.equal(store.memos['0,0'].due, '2026-10-05');
  assert.equal(store.memos['0,0'].progress, 6);
  assert.equal(store.memos['1,0'].due, '2026-10-06');
  assert.equal('due' in store.memos['2,0'], false);
  assert.equal('progress' in store.memos['2,0'], false);
  assert.equal(store.memos['3,0'].progress, 2);
  assert.deepEqual(normalizeStore(store, NOW).store, store);
});

test('Dendritic Extension：メモの ID の列。無いメモは外し、親の無い枝はふつうの順路に。使われているメモは本文が空でも残る', () => {
  const { store } = normalizeStore({
    version: 2,
    memos: {
      '0,0': { id: 'A', text: 'a' },
      '1,0': { id: 'B', text: 'b' },
      '2,0': { id: 'C', text: '' },
    },
    dendrites: [
      { id: 'd1', name: ' 考えの筋 ', steps: ['A', 'B', 'zzz', 'B', 'C'], color: '#ABCDEF' },
      { id: 'd2', name: '枝', steps: ['B'], parentId: 'd1', at: 1 },
      { id: 'd3', name: '迷子の枝', steps: ['A'], parentId: 'nope', at: 0 },
      { name: '', steps: ['A'] },
      { name: '空', steps: ['zzz'] },
    ],
  }, NOW);
  assert.equal('2,0' in store.memos, true); // 順路で使われているので残る
  assert.deepEqual(store.dendrites.map((d) => [d.id, d.name, d.steps, d.parentId || null, d.at ?? null]), [
    ['d1', '考えの筋', ['A', 'B', 'C'], null, null],
    ['d2', '枝', ['B'], 'd1', 1],
    ['d3', '迷子の枝', ['A'], null, null],
  ]);
  assert.equal(store.dendrites[0].color, '#abcdef');
  assert.deepEqual(normalizeStore(store, NOW).store, store);
});

test('未配置の棚：レコードをそのまま持つ。空のものは捨て、メモと同じ ID は外す。棚のメモへの関連付けも残る', () => {
  const { store } = normalizeStore({
    version: 2,
    memos: { '0,0': { id: 'A', text: 'a' } },
    shelf: [
      { id: 'S', text: '棚のメモ', tags: ['x'] },
      { id: 'A', text: 'ID が重なる' },
      { text: '' },
      '文字だけ',
    ],
    links: [{ a: 'A', b: 'S' }],
  }, NOW);
  assert.deepEqual(store.shelf.map((r) => [r.id || null, r.text]), [['S', '棚のメモ'], [null, 'ID が重なる'], [null, '文字だけ']]);
  assert.equal(store.links.length, 1);
  assert.deepEqual(normalizeStore(store, NOW).store, store);
});

test('足あとと活動：マスごとの回数（多い順に上限まで）と、日ごとの回数', () => {
  const { store } = normalizeStore({
    version: 2,
    memos: { '0,0': { text: 'a', children: { memos: { '1,0': { text: 'b' } }, footprints: { '1,0': { n: 2, at: '2026-01-01T00:00:00Z' } } } } },
    footprints: { '0,0': { n: 3, at: 'bad' }, '1, 0': 5, 'x': 1, '2,0': { n: 0 } },
    activity: { '2026-01-01': { v: 3, e: 1 }, '2026-01-02': { v: 0, e: 0 }, 'not-a-day': { v: 1 } },
  }, NOW);
  assert.deepEqual(store.footprints, { '1,0': { n: 5 }, '0,0': { n: 3 } });
  assert.deepEqual(store.memos['0,0'].children.footprints, { '1,0': { n: 2, at: '2026-01-01T00:00:00.000Z' } });
  assert.deepEqual(store.activity, { '2026-01-01': { v: 3, e: 1 } });
  assert.deepEqual(normalizeStore(store, NOW).store, store);
});

test('ゴミ箱：30 日たったもの・中身の無いものは捨て、元の場所・関連付けを持つ。棚から来たものは場所を持たない', () => {
  const now = '2026-10-04T00:00:00.000Z';
  const { store } = normalizeStore({
    version: 2,
    memos: { '1,0': { text: 'のこっているメモ', id: 'm1' } },
    trash: [
      { id: 'tabc123', deletedAt: '2026-10-01T00:00:00Z', rec: { text: '消したメモ', id: 'm2', children: { memos: { '1,0': { text: '子' } } } }, keys: ['1,0@2', 'bad step'], key: '3,-1', where: 'ノート直下（3, -1）', links: [{ a: 'm1', b: 'm2', kind: 'support', label: '  根拠  ' }, { a: 'm1', b: 'm1' }] },
      { id: 'told000', deletedAt: '2026-08-01T00:00:00Z', rec: { text: '古い' } },
      { deletedAt: '2026-10-02T00:00:00Z', rec: { text: '' } },
      { deletedAt: '2026-10-03T00:00:00Z', rec: { text: '棚から' }, from: 'shelf', keys: ['1,0'], key: '1,0' },
    ],
  }, now);
  assert.equal(store.trash.length, 2);
  const [a, b] = store.trash;
  assert.equal(a.id, 'tabc123');
  assert.equal(a.from, 'cell');
  assert.deepEqual(a.keys, ['1,0@2']);
  assert.equal(a.key, '3,-1');
  assert.equal(a.rec.id, 'm2');
  assert.equal(a.rec.children.memos['1,0'].text, '子');
  assert.deepEqual(a.links, [{ a: 'm1', b: 'm2', createdAt: now, kind: 'support', label: '根拠' }]);
  assert.equal(b.from, 'shelf');
  assert.equal(b.keys, undefined);
  assert.match(b.id, /^t[0-9a-f]{16}$/);
  // ゴミ箱のメモの ID は、のこっているメモの関連付けには数えない（関連付けは外れたまま）
  assert.equal(store.links, undefined);
});

test('関連グラフの並び：名前・範囲・絞り込み・メモの ID ごとの位置。位置の無いもの・読めない位置は捨てる', () => {
  const { store } = normalizeStore({
    version: 2,
    memos: { '1,0': { text: 'a', id: 'm1' } },
    graphLayouts: [
      { id: 'gabc1234', name: '  散歩の  根拠 ', savedAt: '2026-10-01T00:00:00Z', scope: 'layer', keys: ['1,0@2', 'x'], focus: { id: 'm1', depth: 1 }, pos: { m1: [10.4, -20.6], m2: [1, 'a'], 'bad id!': [0, 0], m3: [5e9, 0] } },
      { id: 'gabc1234', pos: { m1: [0, 0] } },
      { name: '位置なし', pos: {} },
    ],
  }, NOW);
  assert.equal(store.graphLayouts.length, 2);
  const [a, b] = store.graphLayouts;
  assert.equal(a.name, '散歩の 根拠');
  assert.equal(a.scope, 'layer');
  assert.deepEqual(a.keys, ['1,0@2']);
  assert.deepEqual(a.focus, { id: 'm1', depth: 1 });
  assert.deepEqual(a.pos, { m1: [10, -21], m3: [1e6, 0] });
  assert.notEqual(b.id, 'gabc1234');
  assert.equal(b.scope, 'all');
  assert.equal(b.name, '並び 2');
  assert.equal(b.focus, undefined);
});

// ---- 区画（写しの作業台） ----

// 区画を持つノート：元のメモ A はマスに、B はゴミ箱に、C はどこにも無い
const S1 = 's0000000000000001';
const S2 = 's0000000000000002';
const S3 = 's0000000000000003';
const pocketStore = () => ({
  version: 2,
  camera: { x: 0, y: 0 },
  memos: {
    '0,0': { id: 'A', text: '元のメモ', createdAt: NOW, updatedAt: NOW, likedLevel: 0, liked: false, bookmarked: false, comments: [] },
    '1,0': { id: 'D', text: 'もう1つ', createdAt: NOW, updatedAt: NOW, likedLevel: 0, liked: false, bookmarked: false, comments: [] },
  },
  links: [{ a: 'A', b: 'D', createdAt: NOW }],
  trash: [{ id: 'tabc123', deletedAt: '2025-12-31T00:00:00.000Z', from: 'cell', keys: [], key: '2,0', rec: { id: 'B', text: '消したメモ', createdAt: NOW, updatedAt: NOW } }],
  pockets: [{
    id: 'p0123456789ab',
    name: '考えごと',
    color: '#336699',
    createdAt: '2025-12-01T00:00:00.000Z',
    updatedAt: '2025-12-02T00:00:00.000Z',
    size: 'small',
    layout: { [S1]: { x: 10, y: -20 }, [S3]: { x: 0, y: 5 } },
    slips: [
      {
        id: S1,
        kind: 'memo',
        q: 0,
        r: 0,
        at: '2025-12-01T00:00:00.000Z',
        rec: {
          text: '元のメモ', createdAt: NOW, updatedAt: NOW, likedLevel: 0, liked: false, bookmarked: false, tags: ['考え'],
          comments: [{ id: 'k1', text: 'コメント', createdAt: NOW }, { id: 'k2', text: '返信', createdAt: NOW, parentId: 'k1' }],
        },
        origin: { board: 'main', memoId: 'A', key: '0,0', where: 'ノート直下（0, 0）' },
        placed: [{ board: 'main', memoId: 'D', at: '2025-12-03T00:00:00.000Z' }, { board: 'main', memoId: 'C', at: '2025-12-04T00:00:00.000Z' }],
      },
      {
        id: S2,
        kind: 'comment',
        q: 1,
        r: 0,
        at: '2025-12-02T00:00:00.000Z',
        rec: { text: 'ゴミ箱のメモのコメント', createdAt: NOW, updatedAt: NOW, likedLevel: 0, liked: false, bookmarked: false, comments: [] },
        origin: { board: 'main', memoId: 'B', commentId: 'c1', keys: ['2,0@1'], parentLine: '消したメモ' },
      },
      {
        id: S3,
        kind: 'note',
        q: 0,
        r: 1,
        at: '2025-12-03T00:00:00.000Z',
        rec: { text: 'ノート 2\n原点', createdAt: NOW, updatedAt: NOW, likedLevel: 0, liked: false, bookmarked: false, comments: [] },
        origin: { board: 'b2' },
      },
    ],
    lines: [{ a: S1, b: S2, createdAt: NOW, kind: 'support', label: '根拠' }, { a: S2, b: S3, createdAt: NOW }],
  }],
});

test('区画：保存→読み込み→保存で同じ（置いた記録・元の場所の印・グラフの並びも）', () => {
  const first = normalizeStore(pocketStore(), NOW).store;
  assert.equal(first.pockets.length, 1);
  const p = first.pockets[0];
  assert.equal(p.id, 'p0123456789ab');
  assert.equal(p.name, '考えごと');
  assert.equal(p.color, '#336699');
  assert.equal(p.size, 'small');
  assert.deepEqual(p.layout, { [S1]: { x: 10, y: -20 }, [S3]: { x: 0, y: 5 } });
  assert.deepEqual(p.slips.map((s) => [s.id, s.kind, s.q, s.r]), [[S1, 'memo', 0, 0], [S2, 'comment', 1, 0], [S3, 'note', 0, 1]]);
  assert.deepEqual(p.slips[0].origin, { board: 'main', memoId: 'A', key: '0,0', where: 'ノート直下（0, 0）' });
  assert.deepEqual(p.slips[0].placed.map((x) => x.memoId), ['D', 'C']);
  assert.deepEqual(p.slips[0].rec.comments.map((c) => [c.id, c.parentId || null]), [['k1', null], ['k2', 'k1']]);
  assert.equal(p.lines.length, 2);
  // 保存（JSON にして）→ 読み込み → 保存
  const second = normalizeStore(JSON.parse(JSON.stringify(first)), NOW).store;
  assert.deepEqual(second, first);
  assert.deepEqual(normalizeStore(JSON.parse(JSON.stringify(second)), NOW).store, second);
  // 区画のほかの部分は、区画が無いときと同じ
  const { pockets, ...rest } = pocketStore();
  assert.equal(pockets.length, 1);
  const without = normalizeStore(rest, NOW).store;
  const { pockets: kept, ...firstRest } = first;
  assert.equal(kept.length, 1);
  assert.deepEqual(firstRest, without);
  assert.equal('pockets' in without, false);
});

test('区画：pockets の無い古いファイル（v2・v1・v0）はそのまま読め、pockets の項目を作らない', () => {
  const v2 = normalizeStore(sampleV2, NOW);
  assert.deepEqual(v2.store, sampleV2);
  const v1 = normalizeStore({ version: 1, memos: { '0,0': { text: '旧', liked: true } } }, NOW);
  assert.equal(v1.fromVersion, 1);
  assert.equal(v1.store.memos['0,0'].likedLevel, 1);
  const v0 = normalizeStore({ '0,0': 'こんにちは' }, NOW);
  assert.equal(v0.fromVersion, 0);
  assert.equal(v0.store.memos['0,0'].text, 'こんにちは');
  for (const { store } of [v2, v1, v0]) assert.equal('pockets' in store, false);
});

test('区画：pockets が null・文字列・数値・オブジェクトなどでも、ほかの項目は壊れない', () => {
  const base = {
    version: 2,
    camera: { x: 3, y: 4 },
    memos: { '0,0': { id: 'A', text: 'a' }, '1,0': { id: 'B', text: 'b', comments: [{ id: 'c1', text: 'コメント' }] } },
    links: [{ a: 'A', b: 'B' }],
    shelf: [{ text: '棚' }],
    dendrites: [{ id: 'd1', name: '筋', steps: ['A', 'B'] }],
  };
  const expected = normalizeStore(base, NOW).store;
  const objectNotList = { id: 'p0123456789ab', slips: [{ id: S1, kind: 'memo', q: 0, r: 0, rec: { text: 'x' } }] };
  for (const pockets of [null, 'x', 42, true, objectNotList, [], [null, 'x', 5, [], {}]]) {
    const { store } = normalizeStore({ ...base, pockets }, NOW);
    assert.deepEqual(store, expected, JSON.stringify(pockets));
  }
});

test('区画：壊れた値（紙片の中身が文字列・線の端がメモの番号札・座標が文字）でも、ほかの紙片・メモ・関連付けは消えない', () => {
  const S4 = 's0000000000000004';
  const S5 = 's0000000000000005';
  const { store } = normalizeStore({
    version: 2,
    memos: { '0,0': { id: 'A', text: 'a' }, '1,0': { id: 'B', text: 'b' } },
    links: [{ a: 'A', b: 'B', createdAt: NOW }],
    pockets: [{
      id: 'p0123456789ab',
      createdAt: NOW,
      slips: [
        { id: S1, kind: 'memo', q: 0, r: 0, at: NOW, rec: { text: '残る紙片' } },
        { id: S2, kind: 'memo', q: 1, r: 1, at: NOW, rec: '文字だけの中身' },
        { id: S4, kind: 'memo', q: 1, r: 0, at: NOW, rec: 12345 },
        { id: S3, kind: 'memo', q: '0', r: '1', at: NOW, rec: { text: '座標が文字' } },
        { id: S5, kind: 'memo', q: 1.5, r: {}, at: 'おかしな日時', rec: { text: '座標が小数' } },
      ],
      lines: [{ a: 'A', b: 'B' }, { a: 'A', b: S1 }, { a: S1, b: S3 }],
    }],
  }, NOW);
  assert.deepEqual(Object.keys(store.memos), ['0,0', '1,0']);
  assert.deepEqual(store.links, [{ a: 'A', b: 'B', createdAt: NOW }]);
  const p = store.pockets[0];
  const byId = Object.fromEntries(p.slips.map((s) => [s.id, s]));
  assert.equal(byId[S1].rec.text, '残る紙片');
  assert.deepEqual([byId[S1].q, byId[S1].r], [0, 0]);
  assert.equal(byId[S4], undefined); // 中身が読めない紙片だけ捨てる
  // 座標が読めない紙片は捨てずに、空いたセルへ（写した時刻が同じなら番号札の順）
  assert.deepEqual([byId[S3].q, byId[S3].r], [1, 0]);
  assert.deepEqual([byId[S5].q, byId[S5].r], [0, 1]);
  const cells = p.slips.map((s) => `${s.q},${s.r}`);
  assert.equal(new Set(cells).size, cells.length);
  // 線は紙片どうしのものだけ
  assert.deepEqual(p.lines.map((l) => [l.a, l.b]), [[S1, S3]]);
  assert.deepEqual(normalizeStore(store, NOW).store, store);
});

test('区画：元のメモがゴミ箱にある・どこにも無いときも、紙片の元の場所の印と置いた記録の番号札は残る', () => {
  const once = normalizeStore(pocketStore(), NOW).store;
  assert.equal(once.trash[0].rec.id, 'B');
  const slips = once.pockets[0].slips;
  assert.equal(slips[1].origin.memoId, 'B'); // ゴミ箱にある
  assert.deepEqual(slips[0].placed.map((x) => x.memoId), ['D', 'C']); // C はどこにも無い
  // ゴミ箱からも消えたあと（元のメモがどこにも無い）でも
  const gone = normalizeStore({ ...once, memos: {}, links: [], trash: [] }, NOW).store;
  assert.deepEqual(gone.pockets, once.pockets);
  assert.equal(gone.pockets[0].slips[0].origin.memoId, 'A');
  assert.equal(gone.pockets[0].slips[1].origin.memoId, 'B');
  assert.deepEqual(gone.pockets[0].slips[0].placed.map((x) => x.memoId), ['D', 'C']);
});

test('区画：紙片の番号札はメモの番号札の一覧に混ざらない（関連付け・順路の端に書いても捨てられる）', () => {
  const raw = pocketStore();
  raw.links.push({ a: 'A', b: S1 }, { a: S1, b: S2 });
  raw.dendrites = [{ id: 'd1', name: '筋', steps: ['A', S1, 'D'] }];
  const { store } = normalizeStore(raw, NOW);
  assert.deepEqual(store.links, [{ a: 'A', b: 'D', createdAt: NOW }]);
  assert.deepEqual(store.dendrites[0].steps, ['A', 'D']);
  assert.equal(store.pockets[0].slips.length, 3);
  assert.deepEqual(Object.keys(store.memos), ['0,0', '1,0']);
});

test('MemoStore：区画のあるノートを保存→再読み込みで区画が残る', () => {
  const dir = tmpDir();
  const s1 = new MemoStore(dir);
  s1.load();
  const saved = s1.save(pocketStore());
  assert.equal(saved.pockets.length, 1);
  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'memos.json'), 'utf8'));
  assert.deepEqual(onDisk.pockets, saved.pockets);
  const s2 = new MemoStore(dir);
  const loaded = s2.load();
  assert.deepEqual(loaded.pockets, saved.pockets);
  assert.deepEqual(loaded.pockets[0].slips.map((s) => s.id), [S1, S2, S3]);
  assert.deepEqual(s2.takeNotices(), []);
  // もう一度保存しても同じ
  assert.deepEqual(s2.save(loaded).pockets, saved.pockets);
});

test('配置ヒント：実在するメモの ID だけ残し、読めない項目は捨てる（pin は 0〜1 に丸める・weight は 0〜1）', () => {
  const memos = { '0,0': { text: 'a', id: 'hx001' }, '1,0': { text: 'b', id: 'hx002' } };
  const hints = {
    v: 1, source: 'grok', createdAt: '2026-10-15T03:00:00.000Z', flow: { dir: 'TB' }, grokOuter: true,
    nodes: {
      hx001: { pin: { x: 0.5, y: 1.7 }, zone: 'top-right', group: 'r1', rank: 3, weight: 1 },
      hx002: { zone: 'nowhere', group: 'Bad Group', rank: 100, weight: 'x' }, // 読めない項目だけ → 項目ごと捨てる
      hx009: { zone: 'left' }, // ノートに無い ID
      'bad id!': { zone: 'left' }, // ID の形が違う
      hx001b: null,
    },
  };
  const { store } = normalizeStore({ version: 2, memos, layoutHints: hints }, NOW);
  assert.deepEqual(store.layoutHints, {
    v: 1, source: 'grok', createdAt: '2026-10-15T03:00:00.000Z', flow: { dir: 'TB' }, grokOuter: true,
    nodes: { hx001: { pin: { x: 0.5, y: 1 }, zone: 'top-right', group: 'r1', rank: 3, weight: 1 } },
  });
  // pin は x・y のそろったものだけ。weight は範囲の外を丸める
  const more = normalizeStore({ version: 2, memos, layoutHints: { nodes: { hx001: { pin: { x: null, y: 0.5 }, weight: 2 }, hx002: { pin: { x: 0.25, y: 0.75 }, weight: -1 } } } }, NOW).store;
  assert.deepEqual(more.layoutHints.nodes, { hx001: { weight: 1 }, hx002: { pin: { x: 0.25, y: 0.75 }, weight: 0 } });
});

test('配置ヒント：中身が空なら layoutHints ごと省く。flow・grokOuter だけなら残す。無いノートは今と同じ', () => {
  const memos = { '0,0': { text: 'a', id: 'hx001' } };
  assert.ok(!('layoutHints' in normalizeStore({ version: 2, memos, layoutHints: { nodes: { hx001: { zone: 'bad' } } } }, NOW).store));
  assert.ok(!('layoutHints' in normalizeStore({ version: 2, memos, layoutHints: 'x' }, NOW).store));
  assert.ok(!('layoutHints' in normalizeStore({ version: 2, memos: {} }, NOW).store));
  // 読めない flow は LR、読めない source は捨てる。createdAt が無ければ読んだ時刻
  assert.deepEqual(normalizeStore({ version: 2, memos, layoutHints: { flow: { dir: 'sideways' }, source: 'A B' } }, NOW).store.layoutHints, { v: 1, createdAt: NOW, flow: { dir: 'LR' } });
  assert.deepEqual(normalizeStore({ version: 2, memos, layoutHints: { grokOuter: true } }, NOW).store.layoutHints, { v: 1, createdAt: NOW, grokOuter: true });
});

test('配置ヒント：正規化は二度かけても同じ。保存して読み直しても残り、消えたメモのヒントは次の保存で外れる', () => {
  const dir = tmpDir();
  const s1 = new MemoStore(dir);
  s1.load();
  const memos = { '0,0': { text: 'a', id: 'hx001' }, '1,0': { text: 'b', id: 'hx002' } };
  const saved = s1.save({ version: 2, memos, layoutHints: { grokOuter: true, nodes: { hx001: { zone: 'left', group: 'r1' }, hx002: { rank: 2 } } } });
  assert.deepEqual(saved.layoutHints.nodes, { hx001: { zone: 'left', group: 'r1' }, hx002: { rank: 2 } });
  assert.deepEqual(normalizeStore(JSON.parse(JSON.stringify(saved)), NOW).store, saved);
  const s2 = new MemoStore(dir);
  const loaded = s2.load();
  assert.deepEqual(loaded.layoutHints, saved.layoutHints);
  assert.deepEqual(s2.save(loaded).layoutHints, saved.layoutHints);
  // 1 つのメモを消すと、そのヒントは次の保存で外れる（ID で指しているため）
  const without = { ...loaded, memos: { '0,0': loaded.memos['0,0'] } };
  assert.deepEqual(s2.save(without).layoutHints.nodes, { hx001: { zone: 'left', group: 'r1' } });
});
