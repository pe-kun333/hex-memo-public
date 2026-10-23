'use strict';

// ブラウザ版（iPad など）の部品：zip の読み書き・SHA-256・保存領域の上のファイル置き場で動く boards.js / store.js
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const vm = require('node:vm');
const Z = require('../web/zipper');
const { createZip: desktopZip, readZip: desktopRead } = require('../zip');
const fs = require('node:fs');
const path = require('node:path');
const { buildModules, buildIndex, COPY, MODULES } = require('../scripts/build-web');

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex');

test('zip：書いたものを読み戻せる（日本語の名前・バイナリ）', async () => {
  const zip = Z.createZip([{ name: 'boards.json', data: '{"a":1}' }, { name: 'attachments/画像.png', data: new Uint8Array(PNG) }, { name: 'メモ.txt', data: '説明' }]);
  const back = await Z.readZip(zip);
  assert.deepEqual(back.map((e) => e.name), ['boards.json', 'attachments/画像.png', 'メモ.txt']);
  assert.deepEqual(Buffer.from(back[1].data), PNG);
  assert.equal(Z.text(back[2].data), '説明');
});

test('zip：デスクトップ版の zip.js と互いに読める', async () => {
  const fromDesktop = desktopZip([{ name: 'memos.json', data: '{"memos":{}}' }, { name: 'attachments/x.png', data: PNG }]);
  const a = await Z.readZip(new Uint8Array(fromDesktop));
  assert.deepEqual(a.map((e) => e.name), ['memos.json', 'attachments/x.png']);
  const fromWeb = Z.createZip([{ name: 'memos.json', data: '{"memos":{}}' }, { name: 'attachments/x.png', data: new Uint8Array(PNG) }]);
  const b = desktopRead(Buffer.from(fromWeb));
  assert.equal(b[1].data.equals(PNG), true);
});

test('zip：ほかのアプリで作り直した（deflate で圧縮した）zip も読める・壊れていれば分かる', async () => {
  // deflate の項目を1つ持つ zip を手で作る
  const name = Buffer.from('boards.json');
  const data = Buffer.from(JSON.stringify({ version: 1, boards: [{ id: 'main', name: 'ノート 1', file: 'memos.json' }] }));
  const comp = zlib.deflateRawSync(data);
  const crc = Z.crc32(data);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0x0800, 6);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(comp.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0x0800, 8);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(comp.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(name.length, 28);
  central.writeUInt32LE(0, 42);
  const body = Buffer.concat([local, name, comp]);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(46 + name.length, 12);
  end.writeUInt32LE(body.length, 16);
  const zip = Buffer.concat([body, central, name, end]);
  const [e] = await Z.readZip(new Uint8Array(zip));
  assert.equal(JSON.parse(Z.text(e.data)).boards[0].name, 'ノート 1');

  const broken = Buffer.from(zip);
  broken[30 + name.length + 2] ^= 0xff; // 中身を壊す
  await assert.rejects(() => Z.readZip(new Uint8Array(broken)));
  await assert.rejects(() => Z.readZip(new Uint8Array(Buffer.from('zip ではない'))), /zip ファイルではない/);
});

test('SHA-256（crypto.subtle が使えないとき用）は Node の計算と一致する', () => {
  for (const n of [0, 1, 55, 56, 63, 64, 65, 1000, 70000]) {
    const bytes = crypto.randomBytes(n);
    assert.equal(Z.sha256Hex(new Uint8Array(bytes)), crypto.createHash('sha256').update(bytes).digest('hex'), `長さ ${n}`);
  }
  assert.equal(Z.sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

// vm の中で作られた配列は、そのままだと比べられないので、ふつうの値に直す
const plain = (v) => JSON.parse(JSON.stringify(v));

// ブラウザで読み込むのと同じ形で、web-fs.js の上に boards.js などを載せる（IndexedDB は使わない）
function loadWebModules() {
  delete require.cache[require.resolve('../web/web-fs')];
  const webfs = require('../web/web-fs');
  const ctx = vm.createContext({ HexWebFs: webfs, console, TextEncoder, TextDecoder });
  vm.runInContext(buildModules(), ctx);
  return { webfs, req: ctx.HexNode.require };
}

test('ブラウザ版：デスクトップ版と同じ boards.js・store.js が、保存領域の上のファイル置き場で動く', () => {
  const { webfs, req } = loadWebModules();
  const { BoardManager } = req('./boards');
  webfs.fs.mkdirSync('/data');
  const boards = new BoardManager('/data').load();
  assert.deepEqual(plain(boards.list().boards.map((b) => b.name)), ['ノート 1']);
  const main = boards.list().activeId;
  const t = '2026-09-29T00:00:00.000Z';
  boards.save(main, { version: 2, camera: { x: 0, y: 0 }, memos: { '0,0': { text: 'こんにちは', createdAt: t, updatedAt: t } } });
  const child = boards.create('子ノート', main);
  boards.rename(child.id, '子ノート（名前変更）');
  const tab = boards.create('ノート 2');
  boards.move(tab.id, null, main); // ノート 2 を先頭へ

  // 読み直しても同じ（ファイル置き場に書かれている）
  const again = new BoardManager('/data').load();
  assert.deepEqual(plain(again.list().boards.map((b) => [b.name, b.parentId || null])), [['ノート 2', null], ['ノート 1', null], ['子ノート（名前変更）', main]]);
  assert.equal(again.store(main).current.memos['0,0'].text, 'こんにちは');
  assert.equal(again.stats(main).memoCount, 1);
  // 一時ファイル（.tmp）は残らない
  assert.equal([...webfs._files.keys()].some((k) => k.endsWith('.tmp')), false);
  // 削除：子ノートも一緒に
  again.remove(main);
  assert.deepEqual(plain(new BoardManager('/data').load().list().boards.map((b) => b.name)), ['ノート 2']);
});

test('ブラウザ版：デスクトップ版の「メモアプリ全体の書き出し」と同じ並び（boards.json・memos-*.json）を読める', () => {
  const { webfs, req } = loadWebModules();
  const { BoardManager } = req('./boards');
  const t = '2026-09-29T00:00:00.000Z';
  webfs.fs.writeFileSync('/data/boards.json', JSON.stringify({ version: 1, activeId: 'b2', boards: [
    { id: 'main', name: '仕事', file: 'memos.json' },
    { id: 'b2', name: '趣味', file: 'memos-b2.json' },
    { id: 'c3', name: '趣味の子', file: 'memos-c3.json', parentId: 'b2' },
  ] }));
  webfs.fs.writeFileSync('/data/memos.json', JSON.stringify({ version: 2, memos: { '0,0': { text: 'A', createdAt: t, updatedAt: t } } }));
  webfs.fs.writeFileSync('/data/memos-b2.json', JSON.stringify({ version: 2, memos: {} }));
  webfs.fs.writeFileSync('/data/memos-c3.json', JSON.stringify({ version: 2, memos: { '1,0': { text: '子', createdAt: t, updatedAt: t } } }));
  const boards = new BoardManager('/data').load();
  const list = boards.list();
  assert.equal(list.activeId, 'b2');
  assert.deepEqual(plain(list.boards.map((b) => [b.id, b.name, b.parentId || null])), [['main', '仕事', null], ['b2', '趣味', null], ['c3', '趣味の子', 'b2']]);
  assert.equal(boards.store('c3').current.memos['1,0'].text, '子');
});

test('ブラウザ版：コピーして送る（送り先の登録・ほかのノートへ置く）が、保存領域の上で動く', () => {
  const { webfs, req } = loadWebModules();
  // まとめたモジュールは、どれも読み込める（web-api.js が起動時に読む）
  for (const name of MODULES) assert.ok(req(`./${name}`), name);
  const SB = req('./sendbox');
  const { BoardManager } = req('./boards');
  const t = '2026-10-02T00:00:00.000Z';
  webfs.fs.mkdirSync('/data');
  const boards = new BoardManager('/data').load();
  const child = boards.create('子', boards.list().activeId);
  const added = SB.addTarget('/data', { kind: 'board', boardId: child.id });
  assert.match(added.target.id, /^[a-z0-9]{4,32}$/);
  assert.equal(SB.readTargets('/data').length, 1);
  const ctx = { selfAppId: null, boards, apps: [{ id: null, name: 'iPad' }], dataDirOf: () => null };
  assert.equal(SB.describeTargets(SB.readTargets('/data'), ctx)[0].exists, true);
  assert.equal(SB.catalog(ctx)[0].boards.length, 2);
  const r = SB.insertIntoBoards(boards, { kind: 'board', boardId: child.id }, [{ text: 'A', createdAt: t, updatedAt: t }], null, { now: t });
  const again = new BoardManager('/data').load();
  assert.equal(again.store(child.id).current.memos['0,0'].children.memos[r.placed[0]].text, 'A');
  // ノートを削除したときの片付け（web-api.js の deleteBoard と同じ）
  const gone = new Set(again.subtreeIds(child.id));
  again.remove(child.id);
  SB.pruneTargets('/data', (x) => !x.appId && gone.has(x.boardId));
  assert.equal(SB.readTargets('/data').length, 0);
  assert.equal([...webfs._files.keys()].some((k) => k.endsWith('.tmp')), false);
});

test('send.js は、ブラウザ版でもデスクトップ版でも画面の前に読み込む', () => {
  assert.ok(COPY.includes('send.js'));
  assert.ok(MODULES.includes('send') && MODULES.includes('sendbox'));
  for (const html of [buildIndex(), fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8')]) {
    const s = html.indexOf('src="send.js"');
    const r = html.indexOf('src="renderer.js"');
    assert.ok(s > 0 && s < r);
  }
});

test('ブラウザ版：タグボタンのセット（棚の右クリック）の設定が、保存領域の上で保存・読み直しでき、zip の読み込みでも引き継げる', () => {
  const { req } = loadWebModules();
  const { SettingsStore } = req('./settings');
  const store = new SettingsStore('/data');
  store.load();
  store.update({ tags: [{ name: '会議' }] });
  store.update({ tagSets: [{ id: 's0000000a', name: '仕事', tags: ['会議', '', '連絡'] }, { id: 's0000000b', name: '読書', tags: [] }], tagSetActive: 's0000000b' });
  const again = new SettingsStore('/data');
  again.load();
  assert.deepEqual(plain(again.get().tagSets.map((s) => [s.id, s.name, s.tags.length])), [['s0000000a', '仕事', 9], ['s0000000b', '読書', 9]]);
  assert.equal(again.get().tagSetActive, 's0000000b');
  // web-api.js の importData と同じ：今の設定を写し、データを消した後（空の場所）に戻す
  const keep = plain(again.get());
  const fresh = new SettingsStore('/data2');
  assert.deepEqual(plain(fresh.get().tagSets), []);
  fresh.update(keep);
  assert.deepEqual(plain(fresh.get().tagSets), keep.tagSets);
  assert.equal(fresh.get().tagSetActive, 's0000000b');
});

test('ブラウザ版の index.html：棚のタグボタンのメニュー・セットの編集があり、iPad でも出る（デスクトップ版だけにしていない）', () => {
  const html = buildIndex();
  for (const id of ['shelfTagMenu', 'tagSetDialog', 'shelfTagPad', 'tagSetSlots']) assert.match(html, new RegExp(`id="${id}"`), id);
  const items = html.match(/<button[^>]*data-cmd="tag-sets"[^>]*>/g) || [];
  assert.ok(items.length >= 1);
  for (const b of items) assert.doesNotMatch(b, /data-desktop-only/);
});

test('ブラウザ版の index.html：窓口のスクリプトを画面の前に読み込み、blob: の画像・オフライン用を許す', () => {
  const html = buildIndex();
  const order = ['web-fs.js', 'zipper.js', 'node-modules.js', 'web-api.js', 'renderer.js'].map((f) => html.indexOf(`src="${f}"`));
  assert.equal(order.every((v, i) => v > 0 && (i === 0 || v > order[i - 1])), true);
  assert.match(html, /name="viewport"/);
  assert.match(html, /rel="manifest"/);
  assert.match(html, /connect-src 'self' blob:/);
  assert.doesNotMatch(html, /hm-att:/);
});

// ---- 複数タブの同時編集を防ぐ（web-fs.js の claimOwner。本物の navigator.locks の代わりに、同じ動きの偽物を使う） ----

// 同じ名前のロックを、先に取ったものが離す（タブを閉じる）まで、ほかは待つ
function fakeLocks() {
  let held = false;
  const waiters = [];
  return {
    request(name, a, b) {
      const opts = typeof a === 'function' ? {} : a;
      const cb = typeof a === 'function' ? a : b;
      if (!held) {
        held = true;
        return Promise.resolve(cb({ name }));
      }
      if (opts.ifAvailable) return Promise.resolve(cb(null));
      return new Promise((resolve) => waiters.push(() => {
        held = true;
        resolve(cb({ name }));
      }));
    },
    closeHolder() {
      held = false;
      const next = waiters.shift();
      if (next) next();
    },
  };
}
const tick = () => new Promise((resolve) => setImmediate(resolve));

test('ブラウザ版：2つ目のタブは案内を出して待ち、先のタブが閉じられたら続きを開く', async () => {
  const { claimOwner } = require('../web/web-fs');
  const locks = fakeLocks();
  const waits = [];
  assert.equal(await claimOwner(locks, 'x', () => waits.push('first')), 'owner');
  assert.deepEqual(waits, []);

  let second = null;
  const pending = claimOwner(locks, 'x', () => waits.push('second')).then((v) => { second = v; });
  await tick();
  assert.deepEqual(waits, ['second']); // 案内が出て
  assert.equal(second, null); // まだ読み込みに進まない

  locks.closeHolder(); // 先のタブを閉じた
  await pending;
  assert.equal(second, 'waited');
});

test('ブラウザ版：3つ目のタブも順番に待ち、同時に開かない', async () => {
  const { claimOwner } = require('../web/web-fs');
  const locks = fakeLocks();
  await claimOwner(locks, 'x');
  const order = [];
  const b = claimOwner(locks, 'x').then(() => order.push('b'));
  const c = claimOwner(locks, 'x').then(() => order.push('c'));
  await tick();
  assert.deepEqual(order, []);
  locks.closeHolder();
  await b;
  await tick();
  assert.deepEqual(order, ['b']); // b が開いている間、c はまだ待つ
  locks.closeHolder();
  await c;
  assert.deepEqual(order, ['b', 'c']);
});

test('ブラウザ版：Web Locks が使えない環境（http の LAN など）では、待たずにそのまま開く', async () => {
  const { claimOwner } = require('../web/web-fs');
  let waited = false;
  assert.equal(await claimOwner(undefined, 'x', () => { waited = true; }), 'unsupported');
  assert.equal(await claimOwner({}, 'x', () => { waited = true; }), 'unsupported');
  const broken = { request: () => Promise.reject(new Error('SecurityError')) };
  assert.equal(await claimOwner(broken, 'x', () => { waited = true; }), 'unsupported');
  const throwing = { request: () => { throw new Error('SecurityError'); } };
  assert.equal(await claimOwner(throwing, 'x', () => { waited = true; }), 'unsupported');
  assert.equal(waited, false);
});

test('ブラウザ版：web-api.js は、保存領域を開く前にタブの持ち主を決める', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'web', 'web-api.js'), 'utf8');
  const claim = src.indexOf('W.claimOwner(');
  const open = src.indexOf('await W.open()');
  assert.ok(claim > 0 && open > claim);
});

test('ブラウザ版：書き出し・片付けの数え方（まとめた attachments.js）が、未配置の棚とゴミ箱の画像も数える', () => {
  const { req } = loadWebModules();
  const { collectStoreRefs } = req('./attachments');
  const f = (c, ext = 'png') => `${c.repeat(64)}.${ext}`;
  // 片付けは保存領域の生の JSON をそのまま渡すので、その形で確かめる
  const raw = {
    version: 2,
    memos: { '0,0': { text: 'マス', images: [{ file: f('a') }] } },
    shelf: [{ text: '棚', images: [{ file: f('b') }] }],
    trash: [{ id: 't0123456789abcdef', deletedAt: '2026-10-05T00:00:00.000Z', from: 'shelf', rec: { text: 'ゴミ', images: [{ file: f('c') }] } }],
  };
  assert.deepEqual(plain([...collectStoreRefs(raw)].sort()), [f('a'), f('b'), f('c')]);
  // web-api.js の zip の説明文にも、棚・ゴミ箱の画像が入ることを書いてある（ノート1冊と全体の2か所）
  const src = fs.readFileSync(path.join(__dirname, '..', 'web', 'web-api.js'), 'utf8');
  assert.equal((src.match(/\$\{ZIP_ATT_NOTE\}/g) || []).length, 2);
  assert.match(src, /const ZIP_ATT_NOTE = '[^']*未配置の棚のメモと、ゴミ箱（削除から 30 日以内）のメモの画像なども入っています'/);
});

test('ブラウザ版の index.html：画面下の札（削除の［元に戻す］が付く）が1つだけあり、iPad でも出る（デスクトップ版だけにしていない）', () => {
  const html = buildIndex();
  const toasts = html.match(/<[^>]*\bid="toast"[^>]*>/g) || [];
  assert.equal(toasts.length, 1);
  assert.doesNotMatch(toasts[0], /data-desktop-only/);
});

// ---- 区画（写しの作業台） ----

// id の要素を、閉じタグまで切り出す（同じ名前のタグの入れ子を数える）
function elementById(html, id) {
  const at = html.indexOf(`id="${id}"`);
  if (at < 0) return null;
  return elementAt(html, html.lastIndexOf('<', at));
}
const VOID_TAGS = new Set(['input', 'hr', 'br', 'img', 'meta', 'link']);
function elementAt(html, start) {
  const tag = /^<([a-z0-9]+)/i.exec(html.slice(start))[1].toLowerCase();
  if (VOID_TAGS.has(tag)) return html.slice(start, html.indexOf('>', start) + 1);
  const re = new RegExp(`<${tag}\\b|</${tag}>`, 'gi');
  re.lastIndex = start;
  let depth = 0;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    depth += m[0][1] === '/' ? -1 : 1;
    if (depth === 0) return html.slice(start, m.index + m[0].length);
  }
  return null;
}
// その位置が、data-desktop-only の付いた要素（ブラウザ版では隠れる）の中にあるか
function insideDesktopOnly(html, pos) {
  for (const m of html.matchAll(/<[a-z0-9]+\b[^>]*\bdata-desktop-only\b[^>]*>/gi)) {
    const el = elementAt(html, m.index);
    if (el && pos >= m.index && pos < m.index + el.length) return true;
  }
  return false;
}

test('pocket.js は、ブラウザ版のまとめ（store.js が使う）と画面の両方に入り、send.js の後・renderer.js の前に読み込む', () => {
  assert.ok(COPY.includes('pocket.js'));
  assert.ok(MODULES.includes('pocket'));
  assert.ok(MODULES.indexOf('pocket') < MODULES.indexOf('store'));
  for (const html of [buildIndex(), fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8')]) {
    const s = html.indexOf('src="send.js"');
    const p = html.indexOf('src="pocket.js"');
    const r = html.indexOf('src="renderer.js"');
    assert.ok(s > 0 && s < p && p < r);
    assert.equal(html.split('src="pocket.js"').length, 2); // 1回だけ
  }
});

test('区画の入口（マス・コメント・左上メニューの「区画」、下のバーの「区画へ」）と紙片のメニュー・絞り込み欄・本文の枠があり、iPad でも出る（デスクトップ版だけにしていない）', () => {
  for (const html of [buildIndex(), fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8')]) {
    for (const [box, attr] of [['cellMenu', 'data-cmd="pocket"'], ['commentMenu', 'data-cmd="pocket"'], ['appMenu', 'data-cmd="pocket"'], ['multiBar', 'data-multi="pocket"']]) {
      const el = elementById(html, box);
      assert.ok(el, box);
      const buttons = el.match(new RegExp(`<button[^>]*${attr}[^>]*>`, 'g')) || [];
      assert.equal(buttons.length, 1, box);
      assert.doesNotMatch(buttons[0], /data-desktop-only/, box);
      assert.equal(insideDesktopOnly(html, html.indexOf(buttons[0])), false, box);
    }
    for (const id of ['pocketSlipMenu', 'sidePocketCtl', 'sidePocketFilter', 'pocketCopyBox', 'pocketCopyText', 'pocketCopyClose']) {
      const el = elementById(html, id);
      assert.ok(el, id);
      assert.doesNotMatch(el, /data-desktop-only/, id);
      assert.equal(insideDesktopOnly(html, html.indexOf(`id="${id}"`)), false, id);
    }
    // 紙片のメニュー：元へ戻る・本文をコピー・区画から外す
    const menu = elementById(html, 'pocketSlipMenu');
    for (const cmd of ['go', 'copy-text', 'remove']) assert.match(menu, new RegExp(`data-cmd="${cmd}"`), cmd);
    // 絞り込み欄は区画の欄の中（描き直しで作り直されない固定の HTML）
    assert.match(elementById(html, 'sidePocketCtl'), /id="sidePocketFilter"/);
  }
});

test('zip の説明文：区画の紙片の画像も入ることを書き、デスクトップ版（main.js）とブラウザ版（web-api.js）で同じ文', () => {
  const noteOf = (file) => {
    const m = /const ZIP_ATT_NOTE = '([^']*)';/.exec(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'));
    assert.ok(m, file);
    return m[1];
  };
  const desktop = noteOf('main.js');
  assert.equal(noteOf(path.join('web', 'web-api.js')), desktop);
  assert.match(desktop, /区画の紙片/);
});

test('ブラウザ版：区画（写しの作業台）のあるノートを保存→読み直しても区画が残る（crypto の無い環境でも番号札を作れる）', () => {
  const { webfs, req } = loadWebModules();
  const HP = req('./pocket');
  assert.match(HP.newSlipId(), /^s[0-9a-f]{16}$/);
  assert.match(HP.newPocketId(), /^p[0-9a-f]{12}$/);
  const { BoardManager } = req('./boards');
  webfs.fs.mkdirSync('/data');
  const boards = new BoardManager('/data').load();
  const main = boards.list().activeId;
  const t = '2026-10-06T00:00:00.000Z';
  const memo = { id: 'm1', text: '写すメモ', createdAt: t, updatedAt: t, comments: [{ id: 'c1', text: 'コメント', createdAt: t }] };
  const a = HP.slipFromMemo(memo, { board: main, memoId: 'm1', key: '0,0' }, t);
  const b = HP.slipFromComment(memo.comments[0], memo, { board: main, memoId: 'm1' }, t);
  const cells = HP.nextFreeCells(new Set(), 2);
  const pocket = { ...HP.newPocket(t), slips: [{ ...a, ...cells[0] }, { ...b, ...cells[1] }], lines: [{ a: a.id, b: b.id, createdAt: t }] };
  boards.save(main, { version: 2, camera: { x: 0, y: 0 }, memos: { '0,0': memo }, pockets: [pocket] });
  const saved = plain(boards.store(main).current.pockets);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].id, pocket.id);
  assert.deepEqual(saved[0].slips.map((s) => [s.id, s.kind, s.q, s.r]), [[a.id, 'memo', 0, 0], [b.id, 'comment', 1, 0]]);
  assert.deepEqual(saved[0].slips[0].origin, { board: main, memoId: 'm1', key: '0,0' });
  assert.notEqual(saved[0].slips[0].rec.comments[0].id, 'c1'); // 写したときにコメントの番号札を付け直す
  // 読み直しても同じ（ファイル置き場に書かれている）
  const again = new BoardManager('/data').load();
  assert.deepEqual(plain(again.store(main).current.pockets), saved);
  assert.equal(again.store(main).current.memos['0,0'].comments[0].id, 'c1'); // 元のメモはそのまま
});

test('ブラウザ版：片付け・書き出しの数え方（まとめた attachments.js）が、区画の紙片の画像・表紙・リンクの画像・保存したページも数える', () => {
  const { req } = loadWebModules();
  const { collectStoreRefs } = req('./attachments');
  const f = (c, ext = 'png') => `${c.repeat(64)}.${ext}`;
  // 片付けは保存領域の生の JSON をそのまま渡すので、その形で確かめる（元のメモはもう無い紙片も）
  const raw = {
    version: 2,
    memos: { '0,0': { text: 'マス', images: [{ file: f('a') }] } },
    pockets: [{
      id: 'p0123456789ab',
      name: '区画',
      slips: [
        { id: 's0000000000000001', kind: 'memo', q: 0, r: 0, rec: { text: '紙片', images: [{ id: 'i1', file: f('b'), thumb: `${'b'.repeat(64)}.thumb.webp` }], urls: [{ url: 'https://example.com/', favicon: f('c', 'ico'), image: f('d', 'gif'), snapshot: { file: f('e', 'pdf') } }] }, origin: { board: 'main', memoId: 'gone' } },
        { id: 's0000000000000002', kind: 'note', q: 1, r: 0, rec: { text: 'ノート', images: [{ id: 'cv', file: f('0', 'webp') }], cover: 'cv' }, origin: { board: 'main' } },
      ],
      lines: [],
    }],
  };
  assert.deepEqual(plain([...collectStoreRefs(raw)].sort()), [f('0', 'webp'), f('a'), f('b'), `${'b'.repeat(64)}.thumb.webp`, f('c', 'ico'), f('d', 'gif'), f('e', 'pdf')].sort());
});

test('区画 段階2：元のマスの印のメニュー・紙片の ↩ のメニュー・置いた写しの一覧があり、iPad でも出る（デスクトップ版だけにしていない）', () => {
  for (const html of [buildIndex(), fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8')]) {
    for (const id of ['copyMenu', 'originMenu', 'slipCopyMenu']) {
      const el = elementById(html, id);
      assert.ok(el, id);
      assert.doesNotMatch(el, /data-desktop-only/, id);
      assert.equal(insideDesktopOnly(html, html.indexOf(`id="${id}"`)), false, id);
    }
    assert.match(elementById(html, 'copyMenu'), /data-cmd="copy-more"/);
    for (const cmd of ['origin-go', 'origin-place']) assert.match(elementById(html, 'originMenu'), new RegExp(`data-cmd="${cmd}"`), cmd);
    assert.match(elementById(html, 'slipCopyMenu'), /data-cmd="origin-place"/);
    // 紙片の右クリックにも「ハニカムに写しを置く」（本文をコピーの次、線の上）
    const menu = elementById(html, 'pocketSlipMenu');
    assert.ok(menu.indexOf('data-cmd="copy-text"') < menu.indexOf('data-cmd="place"'));
    assert.ok(menu.indexOf('data-cmd="place"') < menu.indexOf('<hr'));
  }
});

test('区画 段階3：紙片のメニューの先頭に「本文を直す」・見出し（名前と色）・書いていた文の枠・右上の「区画」ボタンがあり、iPad でも出る（デスクトップ版だけにしていない）', () => {
  for (const html of [buildIndex(), fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8')]) {
    for (const id of ['pocketHead', 'pocketHeadName', 'pocketDraftBox', 'pocketDraftText', 'pocketDraftClose', 'pocketBtn']) {
      const el = elementById(html, id);
      assert.ok(el, id);
      assert.doesNotMatch(el, /data-desktop-only/, id);
      assert.equal(insideDesktopOnly(html, html.indexOf(`id="${id}"`)), false, id);
    }
    // 紙片のメニュー：「本文を直す」が先頭。今ある行の並び（元へ → 本文をコピー → 写しを置く → 線 → 外す）は変えない
    const menu = elementById(html, 'pocketSlipMenu');
    const at = (cmd) => menu.indexOf(`data-cmd="${cmd}"`);
    assert.ok(at('edit') > 0);
    assert.equal(menu.indexOf('data-cmd="'), at('edit'));
    assert.ok(at('edit') < at('go') && at('go') < at('copy-text') && at('copy-text') < at('place') && at('place') < menu.indexOf('<hr') && menu.indexOf('<hr') < at('remove'));
    // 見出しは区画の欄の中（描き直しで作り直されない固定の HTML）、帯の一言より上
    const ctl = elementById(html, 'sidePocketCtl');
    assert.ok(ctl.indexOf('id="pocketHead"') > 0 && ctl.indexOf('id="pocketHead"') < ctl.indexOf('pocket-band'));
    // 書いていた文の枠は「閉じる」でだけ消える（manual）。class "menu" は付けない（開いている間、全体の Esc の判定に当たらないように）
    const box = elementById(html, 'pocketDraftBox');
    assert.match(box, /popover="manual"/);
    assert.doesNotMatch(/^<[^>]*>/.exec(box)[0], /class="[^"]*\bmenu\b/);
    // 右上の「区画」は「棚」のすぐ隣（絵は元のマスの写しの印と同じ二重の六角形）
    const shelf = html.indexOf('id="shelfBtn"');
    const pocketBtn = html.indexOf('id="pocketBtn"');
    assert.ok(shelf > 0 && pocketBtn > shelf);
    assert.equal(html.slice(shelf, pocketBtn).match(/<button\b/g).length, 1); // あいだにほかのボタンが無い（数えるのは区画のボタン自身の開きタグだけ）
    assert.match(elementById(html, 'pocketBtn'), /data-icon="hexcopy"/);
  }
});

test('区画 07：紙片のメニューの「本文を直す」の次に「コメントを書く」があり、iPad でも出る。今ある行の並びは変えない', () => {
  for (const html of [buildIndex(), fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8')]) {
    const menu = elementById(html, 'pocketSlipMenu');
    const at = (cmd) => menu.indexOf(`data-cmd="${cmd}"`);
    assert.ok(at('comment') > 0);
    assert.equal(menu.indexOf('data-cmd="'), at('edit'));
    assert.ok(at('edit') < at('comment') && at('comment') < at('go') && at('go') < at('copy-text') && at('copy-text') < at('place') && at('place') < menu.indexOf('<hr') && menu.indexOf('<hr') < at('remove'));
    const btn = menu.match(/<button[^>]*data-cmd="comment"[^>]*>/)[0];
    assert.doesNotMatch(btn, /data-desktop-only/);
    assert.equal(insideDesktopOnly(html, html.indexOf('data-cmd="comment"')), false);
  }
});

test('ブラウザ版：表示倍率の登録と固定（settings.json の zoom）が、保存領域の上で保存・読み直しでき、zip の読み込みでも引き継げる', () => {
  const { req } = loadWebModules();
  const { SettingsStore } = req('./settings');
  const store = new SettingsStore('/data');
  store.load();
  store.update({ zoom: { presets: [20, 40, 60, 80, 100, 120], lock: { grid: 60 } } });
  store.update({ tags: [{ name: '会議' }] }); // ほかの設定を保存しても消えない
  store.update({ zoom: { lock: { graph: 200 } } });
  const again = new SettingsStore('/data');
  again.load();
  assert.deepEqual(plain(again.get().zoom), { presets: [20, 40, 60, 80, 100, 120], lock: { grid: 60, graph: 200 }, overviewClick: 'zoom' });
  // web-api.js の importData と同じ：今の設定を写し、データを消した後（空の場所）に戻す
  const keep = plain(again.get());
  const fresh = new SettingsStore('/data2');
  assert.deepEqual(plain(fresh.get().zoom), { presets: [25, 50, 75, 100, 125, 150], lock: { grid: null, graph: null }, overviewClick: 'zoom' });
  fresh.update(keep);
  assert.deepEqual(plain(fresh.get().zoom), keep.zoom);
});

test('index.html：右上の倍率を押すと開く「表示倍率」のメニュー（登録 6 つ・固定・登録の編集）があり、iPad でも出る', () => {
  for (const html of [buildIndex(), fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8')]) {
    const label = elementById(html, 'zoomLabel');
    assert.match(label, /aria-haspopup="dialog"/);
    assert.match(label, /title="倍率の登録と固定（クリック）／100% に戻す：Ctrl\+0"/);
    const menu = elementById(html, 'zoomMenu');
    assert.ok(menu, 'zoomMenu が無い');
    assert.match(menu.slice(0, menu.indexOf('>')), /\bpopover\b/);
    assert.match(menu.slice(0, menu.indexOf('>')), /class="menu zoom-menu"/); // 自動の popover（外側・Esc で閉じる）。Esc は全体の .menu:popover-open の確かめで先に閉じる
    assert.match(menu, /id="zoomMenuTitle">表示倍率</);
    assert.equal((menu.match(/data-zoom-preset="\d"/g) || []).length, 6);
    assert.deepEqual([...menu.matchAll(/data-zoom-preset="(\d)"[^>]*>(\d+)%</g)].map((m) => [Number(m[1]), Number(m[2])]), [[0, 25], [1, 50], [2, 75], [3, 100], [4, 125], [5, 150]]);
    const slots = [...menu.matchAll(/<input[^>]*data-zoom-slot="(\d)"[^>]*>/g)];
    assert.equal(slots.length, 6);
    for (const [input] of slots) {
      assert.match(input, /type="number"/);
      assert.match(input, /min="4" max="150"/);
      assert.match(input, /inputmode="numeric"/);
    }
    assert.equal((menu.match(/data-zoom-now="\d"/g) || []).length, 6);
    for (const id of ['zoomLock', 'zoomMenuTarget', 'zoomMenuStatus', 'zoomMenuWarn', 'zoomPresetReset', 'zoomMenu100', 'zoomMenuClose']) assert.ok(menu.includes(`id="${id}"`), id);
    assert.match(menu, /この倍率で固定する/);
    assert.match(menu, /<details[^>]*>\s*<summary>登録を編集<\/summary>/);
    assert.match(elementById(html, 'zoomMenuStatus'), /role="status"/);
    assert.equal(insideDesktopOnly(html, html.indexOf('id="zoomMenu"')), false);
    // アプリのメニュー（ブラウザ版のメニューバーの代わり）からも開ける
    const item = html.match(/<button[^>]*data-cmd="zoom-menu"[^>]*>[\s\S]*?<\/button>/);
    assert.ok(item, 'アプリのメニューに「倍率の登録と固定…」が無い');
    assert.match(item[0], /倍率の登録と固定…/);
    assert.equal(insideDesktopOnly(html, item.index), false);
  }
});

test('グラフの一覧の全文の吹き出し（#graphPeek）は、iPad でも出る（デスクトップ版だけにしていない）。popover="manual"・class "menu" なし', () => {
  for (const html of [buildIndex(), fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8')]) {
    assert.equal((html.match(/id="graphPeek"/g) || []).length, 1);
    const el = elementById(html, 'graphPeek');
    assert.ok(el);
    assert.doesNotMatch(el, /data-desktop-only/);
    assert.equal(insideDesktopOnly(html, html.indexOf('id="graphPeek"')), false);
    const open = /^<[^>]*>/.exec(el)[0];
    assert.match(open, /popover="manual"/); // 止めているとき、外を押しても閉じない。ほかのメニューも閉じない
    assert.doesNotMatch(open, /class="[^"]*\bmenu\b/); // 開いている間、全体・グラフの Esc の判定に当たらないように
  }
});
