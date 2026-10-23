'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const A = require('../attachments.js');
const { createZip, readZip } = require('../zip.js');

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hex-memo-att-'));
// 1x1 の PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const RIFF_WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 '), Buffer.alloc(8)]);

test('中身で種類を見分ける（拡張子は信用しない）', () => {
  assert.equal(A.sniff(PNG), 'png');
  assert.equal(A.sniff(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0])), 'jpg');
  assert.equal(A.sniff(Buffer.from('GIF89a......')), 'gif');
  assert.equal(A.sniff(RIFF_WEBP), 'webp');
  assert.equal(A.sniff(Buffer.from([0, 0, 1, 0, 1, 0])), 'ico');
  assert.equal(A.sniff(Buffer.from('%PDF-1.7\n')), 'pdf');
  assert.equal(A.sniff(Buffer.from('<svg xmlns=...>')), null);
  assert.equal(A.sniff(Buffer.from('MZ\x90\x00')), null);
});

test('中身のハッシュを名前にして保存（同じ画像は1つ）・縮小版', () => {
  const dir = tmpDir();
  const store = new A.AttachmentStore(dir);
  const a = store.put(PNG);
  const b = store.put(PNG);
  assert.equal(a.file, `${A.sha256(PNG)}.png`);
  assert.equal(a.type, 'image/png');
  assert.equal(b.file, a.file);
  assert.deepEqual(fs.readdirSync(path.join(dir, 'attachments')), [a.file]);
  const thumb = store.putThumb(a.file, RIFF_WEBP);
  assert.equal(thumb, `${A.sha256(PNG)}.thumb.webp`);
  assert.equal(store.has(thumb), true);
  assert.equal(store.mime(thumb), 'image/webp');
  assert.throws(() => store.put(Buffer.from('<svg/>')), /対応していない/);
  assert.throws(() => store.put(Buffer.from('%PDF-1.4')), /対応していない/); // 画像の添付では PDF は受け付けない
  assert.equal(store.put(Buffer.from('%PDF-1.4 x'), { kinds: ['pdf'] }).type, 'application/pdf');
  assert.throws(() => store.putThumb('../x.png', RIFF_WEBP));
});

test('正しい名前のファイルだけフォルダの中の場所にする', () => {
  const store = new A.AttachmentStore(tmpDir());
  const good = `${'a'.repeat(64)}.png`;
  assert.equal(store.resolve(good), path.join(store.dir, good));
  for (const bad of ['../secret.png', `${'a'.repeat(64)}.exe`, `${'A'.repeat(64)}.png`, `x/${good}`, '', null]) assert.equal(store.resolve(bad), null);
});

test('使っている添付ファイルを記録から集める（下の階層・リンクのファビコン・保存したページも）', () => {
  const f = (c, ext = 'png') => `${c.repeat(64)}.${ext}`;
  const store = {
    memos: {
      '0,0': {
        images: [{ file: f('a'), thumb: `${'a'.repeat(64)}.thumb.webp` }],
        urls: [{ url: 'https://x', favicon: f('b', 'ico'), image: f('c', 'jpg'), snapshot: { file: f('d', 'pdf') } }],
        children: { memos: { '1,0': { images: [{ file: f('e') }] } } },
      },
    },
  };
  assert.deepEqual([...A.collectStoreRefs(store)].sort(), [f('a'), `${'a'.repeat(64)}.thumb.webp`, f('b', 'ico'), f('c', 'jpg'), f('d', 'pdf'), f('e')].sort());
});

test('重ねた層（第2層以降 moreLayers）のメモの添付ファイルも集める（片付けで消さない・書き出しに入れる）', () => {
  const f = (c) => `${c.repeat(64)}.png`;
  const store = {
    memos: {
      '0,0': {
        children: { memos: { '1,0': { images: [{ file: f('a') }] } } },
        moreLayers: [
          { memos: { '0,1': { images: [{ file: f('b') }], moreLayers: [{ memos: { '1,0': { images: [{ file: f('c') }] } } }] } } },
          { name: '第3層', memos: { '-1,0': { urls: [{ url: 'https://x', favicon: f('d') }] } } },
        ],
      },
    },
  };
  assert.deepEqual([...A.collectStoreRefs(store)].sort(), [f('a'), f('b'), f('c'), f('d')]);
});

// マス・未配置の棚・ゴミ箱（削除から 30 日以内）にそれぞれ画像などを持つノート（保存形式のまま）
const NOW = '2026-10-06T00:00:00.000Z';
const attName = (c, ext = 'png') => `${c.repeat(64)}.${ext}`;
const shelfTrashStore = () => ({
  version: 2,
  memos: { '0,0': { text: 'マス', images: [{ file: attName('a') }] } },
  shelf: [
    {
      text: '棚',
      images: [{ file: attName('b'), thumb: `${'b'.repeat(64)}.thumb.webp` }],
      children: { memos: { '1,0': { text: '棚のメモの周り', images: [{ file: attName('c') }] } } },
    },
  ],
  trash: [
    {
      id: 't0123456789abcdef',
      deletedAt: '2026-10-05T00:00:00.000Z',
      from: 'cell',
      keys: [],
      key: '1,0',
      rec: {
        text: 'マスから消した',
        urls: [{ url: 'https://example.com/', favicon: attName('d', 'ico'), snapshot: { file: attName('e', 'pdf') } }],
        moreLayers: [{ memos: { '0,1': { text: '重ねた層', images: [{ file: attName('f', 'jpg') }] } } }],
      },
    },
    { id: 't1123456789abcdef', deletedAt: '2026-10-05T00:00:00.000Z', from: 'shelf', rec: { text: '棚から消した', urls: [{ url: 'https://example.org/', image: attName('0', 'gif') }] } },
  ],
});
const SHELF_TRASH_REFS = [
  attName('a'), attName('b'), `${'b'.repeat(64)}.thumb.webp`, attName('c'), attName('d', 'ico'), attName('e', 'pdf'), attName('f', 'jpg'), attName('0', 'gif'),
].sort();

test('未配置の棚・ゴミ箱のメモの添付ファイルも集める（書き出しに入れる・ブラウザ版の片付けで消さない）', () => {
  assert.deepEqual([...A.collectStoreRefs(shelfTrashStore())].sort(), SHELF_TRASH_REFS);
  // 回るのは マス1・棚1・ゴミ箱2 の記録（周りのメモ・重ねた層は collectRecordRefs が中を見る）
  const texts = [];
  A.forEachStoreRecord(shelfTrashStore(), (rec) => texts.push(rec.text));
  assert.deepEqual(texts, ['マス', '棚', 'マスから消した', '棚から消した']);
});

test('棚・ゴミ箱の形がおかしくても止まらない。マスのメモが無くても棚・ゴミ箱は数える', () => {
  assert.deepEqual([...A.collectStoreRefs(null)], []);
  assert.deepEqual([...A.collectStoreRefs({ memos: null, shelf: 'x', trash: [null, 1, { rec: null }, { rec: 'x' }, {}] })], []);
  assert.deepEqual([...A.collectStoreRefs({ shelf: [null, 'x', { images: [{ file: attName('b') }] }] })], [attName('b')]);
  assert.deepEqual([...A.collectStoreRefs({ trash: [{ rec: { images: [{ file: attName('c') }] } }] })], [attName('c')]);
  // 画面の形（memos が Map）でも回れる
  assert.deepEqual([...A.collectStoreRefs({ memos: new Map([['0,0', { images: [{ file: attName('a') }] }]]) })], [attName('a')]);
});

test('2つの数え方（記録から：書き出し・ブラウザ版／ファイルの全文から：PC の片付け）がそろう', () => {
  const dir = tmpDir();
  const store = shelfTrashStore();
  fs.writeFileSync(path.join(dir, 'memos.json'), JSON.stringify(store));
  assert.deepEqual([...A.collectStoreRefs(store)].sort(), [...A.collectDirRefs(dir)].sort());
});

// 上のノートに、区画（写しの作業台）の紙片（画像・表紙・リンクのファビコンと代表画像・保存したページ）を足したもの。
// shelfTrashStore はほかの試験が中身を決めているので、変えずに足す
const pocketSlipStore = () => ({
  ...shelfTrashStore(),
  pockets: [{
    id: 'p0123456789ab',
    name: '区画',
    createdAt: NOW,
    updatedAt: NOW,
    slips: [
      {
        id: 's0000000000000001',
        kind: 'memo',
        q: 0,
        r: 0,
        at: NOW,
        rec: {
          text: '紙片',
          images: [{ id: 'i1', file: attName('1'), thumb: `${'1'.repeat(64)}.thumb.webp` }, { id: 'i2', file: attName('2', 'jpg') }],
          cover: 'i2',
          urls: [{ url: 'https://example.net/', favicon: attName('3', 'ico'), image: attName('4', 'gif'), snapshot: { file: attName('5', 'pdf') } }],
        },
        origin: { board: 'main' },
      },
      // ノートの紙片：表紙を画像として持つ
      { id: 's0000000000000002', kind: 'note', q: 1, r: 0, at: NOW, rec: { text: 'ノート\n原点', images: [{ id: 'cv', file: attName('6', 'webp') }], cover: 'cv' }, origin: { board: 'main' } },
    ],
    lines: [],
  }],
});
const SLIP_REFS = [attName('1'), `${'1'.repeat(64)}.thumb.webp`, attName('2', 'jpg'), attName('3', 'ico'), attName('4', 'gif'), attName('5', 'pdf'), attName('6', 'webp')];

test('区画の紙片の添付ファイル（画像・表紙・リンクのファビコン・保存したページ）も、2つの数え方でそろって数える', () => {
  const dir = tmpDir();
  const store = pocketSlipStore();
  fs.writeFileSync(path.join(dir, 'memos.json'), JSON.stringify(store));
  const fromStore = [...A.collectStoreRefs(store)].sort();
  assert.deepEqual(fromStore, [...A.collectDirRefs(dir)].sort());
  assert.deepEqual(fromStore, [...SHELF_TRASH_REFS, ...SLIP_REFS].sort());
  // 読み込みの整え（normalizeStore）を通したあとでも同じ（項目名がそろっている）
  const { normalizeStore } = require('../store.js');
  const norm = normalizeStore(store, NOW).store;
  assert.equal(norm.pockets[0].slips.length, 2);
  assert.deepEqual([...A.collectStoreRefs(norm)].sort(), fromStore);
});

test('区画の紙片の記録も回る。区画・紙片の形がおかしくても止まらない', () => {
  const texts = [];
  A.forEachStoreRecord(pocketSlipStore(), (rec) => texts.push(rec.text));
  assert.deepEqual(texts, ['マス', '棚', 'マスから消した', '棚から消した', '紙片', 'ノート\n原点']);
  assert.deepEqual([...A.collectStoreRefs({ pockets: 'x' })], []);
  assert.deepEqual([...A.collectStoreRefs({ pockets: { slips: [{ rec: { images: [{ file: attName('1') }] } }] } })], []);
  const bad = { pockets: [null, 'x', 5, {}, { slips: 'x' }, { slips: [null, 1, 'x', {}, { rec: null }, { rec: 'x' }, { rec: { images: [{ file: attName('1') }] } }] }] };
  assert.deepEqual([...A.collectStoreRefs(bad)], [attName('1')]);
});

test('読み込みの整え（normalizeStore）を通したあとの棚・ゴミ箱でも拾う（項目名がそろっている）', () => {
  const { normalizeStore } = require('../store.js');
  const { store } = normalizeStore(shelfTrashStore(), NOW);
  assert.equal(store.shelf.length, 1);
  assert.equal(store.trash.length, 2);
  assert.deepEqual([...A.collectStoreRefs(store)].sort(), SHELF_TRASH_REFS);
});

test('片付け：どこからも使われず、猶予を過ぎたファイルだけ消す。バックアップ・削除したノートの参照も残す', () => {
  const dir = tmpDir();
  const store = new A.AttachmentStore(dir);
  const used = store.put(PNG).file;
  const orphan = store.put(Buffer.concat([PNG, Buffer.from([1])])).file; // 末尾だけ違う別の中身
  const inBak = store.put(Buffer.concat([PNG, Buffer.from([2])])).file;
  const fresh = store.put(Buffer.concat([PNG, Buffer.from([3])])).file;
  fs.writeFileSync(path.join(dir, 'memos.json'), JSON.stringify({ memos: { '0,0': { images: [{ file: used }] } } }));
  fs.writeFileSync(path.join(dir, 'memos-abc.json.deleted-2026'), `壊れていても名前は拾う ${inBak}`);
  const old = Date.now() - 10 * 24 * 3600 * 1000;
  for (const f of [used, orphan, inBak]) fs.utimesSync(path.join(store.dir, f), old / 1000, old / 1000);
  const refs = A.collectDirRefs(dir);
  const res = store.sweep(refs);
  assert.equal(res.removed, 1);
  assert.equal(store.has(orphan), false);
  assert.equal(store.has(used), true);
  assert.equal(store.has(inBak), true);
  assert.equal(store.has(fresh), true); // 作ったばかり（猶予の中）
});

test('別のデータフォルダからの取り込みは、中身がファイル名と一致するものだけ', () => {
  const src = new A.AttachmentStore(tmpDir());
  const dst = new A.AttachmentStore(tmpDir());
  const { file } = src.put(PNG);
  assert.equal(dst.importFrom(src.dir, file), true);
  assert.equal(dst.has(file), true);
  const fake = `${'b'.repeat(64)}.png`;
  fs.writeFileSync(path.join(src.dir, fake), PNG); // 名前と中身が合わない
  assert.equal(dst.importFrom(src.dir, fake), false);
  assert.equal(dst.importFrom(src.dir, '../x.png'), false);
});

test('zip：書いたものを読み戻せる（日本語のファイル名・CRC）', () => {
  const zip = createZip([{ name: 'memos.json', data: '{"a":1}' }, { name: 'attachments/画像.png', data: PNG }, { name: 'README.txt', data: '説明' }]);
  const back = readZip(zip);
  assert.deepEqual(back.map((e) => e.name), ['memos.json', 'attachments/画像.png', 'README.txt']);
  assert.equal(back[1].data.equals(PNG), true);
  assert.equal(back[2].data.toString('utf8'), '説明');
});
