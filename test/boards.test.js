'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { BoardManager, INDEX_FILE, MAIN_ID } = require('../boards.js');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'hex-memo-boards-'));
}

const memoData = (text) => ({
  version: 2,
  camera: { x: 1, y: 2 },
  memos: { '0,0': { text, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', likedLevel: 0, liked: false, bookmarked: false, comments: [] } },
});

const readIndex = (dir) => JSON.parse(fs.readFileSync(path.join(dir, INDEX_FILE), 'utf8'));

test('初回は memos.json を最初のノートとして一覧を作る', () => {
  const dir = tmpDir();
  const m = new BoardManager(dir).load();
  assert.deepEqual(m.list(), { boards: [{ id: MAIN_ID, name: 'ノート 1' }], activeId: MAIN_ID, readOnly: false });
  assert.deepEqual(readIndex(dir).boards, [{ id: MAIN_ID, name: 'ノート 1', file: 'memos.json' }]);
  assert.deepEqual(m.takeNotices(), []);
});

test('単一ファイル版の memos.json はそのまま最初のノートとして読める', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'memos.json'), JSON.stringify(memoData('既存のメモ')));
  const m = new BoardManager(dir).load();
  assert.equal(m.store(MAIN_ID).current.memos['0,0'].text, '既存のメモ');
  assert.deepEqual(m.store(MAIN_ID).current.camera, { x: 1, y: 2 });
});

test('ノートの追加・保存・再読み込み', () => {
  const dir = tmpDir();
  const m = new BoardManager(dir).load();
  const b = m.create();
  assert.match(b.id, /^[0-9a-f]{8}$/);
  assert.equal(b.name, 'ノート 2');
  assert.equal(b.file, `memos-${b.id}.json`);
  assert.equal(m.activeId, b.id);
  m.save(b.id, memoData('二冊目'));
  m.save(MAIN_ID, memoData('一冊目'));

  const again = new BoardManager(dir).load();
  assert.deepEqual(again.list().boards.map((x) => x.name), ['ノート 1', 'ノート 2']);
  assert.equal(again.activeId, b.id);
  assert.equal(again.store(b.id).current.memos['0,0'].text, '二冊目');
  assert.equal(again.store(MAIN_ID).current.memos['0,0'].text, '一冊目');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, b.file), 'utf8')).version, 2);
});

test('ノートのメモ数は下の階層も含めて数える', () => {
  const dir = tmpDir();
  const m = new BoardManager(dir).load();
  const data = memoData('親');
  data.memos['0,0'].children = { camera: { x: 0, y: 0 }, memos: { '1,0': { text: '子' }, '0,1': { text: '子2' } } };
  m.save(MAIN_ID, data);
  assert.deepEqual(m.stats(MAIN_ID), { memoCount: 3, origin: { text: '親' } });
});

test('ノートの原点のメモ（1行目と表紙）を、ノートのハニカムのために返す', () => {
  const dir = tmpDir();
  const m = new BoardManager(dir).load();
  const data = memoData('\n  説明の1行目\n2行目');
  const file = `${'a'.repeat(64)}.png`;
  const thumb = `${'a'.repeat(64)}.thumb.jpg`;
  data.memos['0,0'].images = [{ id: 'i1', file, thumb, addedAt: '2026-01-01T00:00:00.000Z' }];
  data.memos['0,0'].cover = 'i1';
  data.memos['1,0'] = { ...data.memos['0,0'], text: '別のメモ', images: undefined, cover: undefined };
  m.save(MAIN_ID, data);
  const st = m.stats(MAIN_ID);
  assert.equal(st.memoCount, 2);
  assert.equal(st.origin.text, '説明の1行目');
  assert.ok(st.origin.cover === thumb || st.origin.cover === file, JSON.stringify(st.origin));
  // 原点にメモが無いノート
  const b2 = m.create();
  assert.deepEqual(m.stats(b2.id), { memoCount: 0, origin: null });
});

test('新しいノートの既定名は既存の名前と重ならない', () => {
  const dir = tmpDir();
  const m = new BoardManager(dir).load();
  const b2 = m.create();
  m.rename(MAIN_ID, 'ノート 3');
  assert.equal(m.create().name, 'ノート 4');
  assert.equal(b2.name, 'ノート 2');
});

test('名前の変更：空白を詰め、40 文字まで。空は拒否', () => {
  const dir = tmpDir();
  const m = new BoardManager(dir).load();
  m.rename(MAIN_ID, '  仕事\n の  メモ ');
  assert.equal(m.list().boards[0].name, '仕事 の メモ');
  m.rename(MAIN_ID, 'あ'.repeat(60));
  assert.equal([...m.list().boards[0].name].length, 40);
  assert.throws(() => m.rename(MAIN_ID, '   '));
  assert.equal(readIndex(dir).boards[0].name, 'あ'.repeat(40));
});

test('ノートの削除：最後の1冊は消せない。ファイルは .deleted を付けて残す', () => {
  const dir = tmpDir();
  const m = new BoardManager(dir).load();
  assert.throws(() => m.remove(MAIN_ID));
  const b2 = m.create();
  const b3 = m.create();
  m.save(b2.id, memoData('消すノート'));
  m.activate(b2.id);
  const next = m.remove(b2.id);
  assert.equal(next, b3.id, '右隣のノートに移る');
  assert.deepEqual(m.list().boards.map((b) => b.id), [MAIN_ID, b3.id]);
  const files = fs.readdirSync(dir);
  assert.ok(!files.includes(b2.file));
  assert.equal(files.filter((f) => f.startsWith(`${b2.file}.deleted-`)).length, 1);
  assert.throws(() => m.store(b2.id));
  assert.throws(() => m.save(b2.id, memoData('x')));

  // 作り直し（一覧の破損時）でも削除したノートは復活しない
  fs.writeFileSync(path.join(dir, INDEX_FILE), '{ broken');
  const rebuilt = new BoardManager(dir).load();
  assert.deepEqual(rebuilt.list().boards.map((b) => b.id), [MAIN_ID, b3.id]);
});

test('一覧が壊れていたら退避して、保存ファイルから作り直す', () => {
  const dir = tmpDir();
  const m = new BoardManager(dir).load();
  const b2 = m.create();
  m.save(MAIN_ID, memoData('a'));
  m.save(b2.id, memoData('b'));
  fs.writeFileSync(path.join(dir, INDEX_FILE), 'not json');

  const r = new BoardManager(dir).load();
  assert.deepEqual(r.list().boards.map((b) => b.id), [MAIN_ID, b2.id]);
  assert.equal(r.store(b2.id).current.memos['0,0'].text, 'b');
  assert.equal(r.takeNotices()[0].level, 'warn');
  assert.equal(fs.readdirSync(dir).filter((f) => f.startsWith(`${INDEX_FILE}.corrupt-`)).length, 1);
  assert.equal(readIndex(dir).boards.length, 2);
});

test('一覧の不正な項目（ID・ファイル名・重複）は無視する', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, INDEX_FILE), JSON.stringify({
    version: 1,
    activeId: 'nope',
    boards: [
      { id: 'main', name: 'メイン', file: 'memos.json' },
      { id: 'evil', name: 'x', file: '../outside.json' },
      { id: 'Bad-ID', name: 'x', file: 'memos-bad.json' },
      { id: 'dup', name: 'x', file: 'memos.json' },
      { id: 'main', name: 'x', file: 'memos-main2.json' },
      { id: 'abc123', name: '', file: 'memos-abc123.json' },
    ],
  }));
  const m = new BoardManager(dir).load();
  assert.deepEqual(m.list(), {
    boards: [{ id: 'main', name: 'メイン' }, { id: 'abc123', name: 'ノート 2' }],
    activeId: 'main',
    readOnly: false,
  });
});

test('一覧が読めない（ファイルでない等）ときは書き換えを止める', () => {
  const dir = tmpDir();
  fs.mkdirSync(path.join(dir, INDEX_FILE));
  const m = new BoardManager(dir).load();
  assert.equal(m.readOnly, true);
  assert.equal(m.list().boards[0].id, MAIN_ID);
  assert.throws(() => m.create());
  assert.throws(() => m.rename(MAIN_ID, 'x'));
  assert.equal(m.takeNotices()[0].level, 'error');
});

// ---- ノートのツリー（タブの中の子ノート） ----

const tree = (m) => m.list().boards.map((b) => `${b.name}${b.parentId ? `<${m.get(b.parentId).name}` : ''}`);

test('子ノートを作る：親を覚え、表示中になり、タブは最後に開いた子ノートを覚える', () => {
  const dir = tmpDir();
  const m = new BoardManager(dir).load();
  const a = m.create('章1', MAIN_ID);
  const b = m.create('場面A', a.id);
  assert.deepEqual(tree(m), ['ノート 1', '章1<ノート 1', '場面A<章1']);
  assert.equal(m.activeId, b.id);
  assert.equal(m.list().boards[0].openId, b.id);
  assert.equal(m.rootOf(b.id), MAIN_ID);
  assert.equal(m.depthOf(b.id), 2);
  m.activate(MAIN_ID);
  assert.equal(m.list().boards[0].openId, undefined); // タブそのものを開いたら覚えなくてよい
  // 再読み込みしても同じ
  m.activate(a.id);
  const m2 = new BoardManager(dir).load();
  assert.deepEqual(tree(m2), ['ノート 1', '章1<ノート 1', '場面A<章1']);
  assert.equal(m2.activeId, a.id);
  assert.equal(m2.list().boards[0].openId, a.id);
  const idx = readIndex(dir).boards;
  assert.equal(idx[1].parentId, MAIN_ID);
  assert.equal('parentId' in idx[0], false);
  assert.throws(() => m.create('x', 'nothere'));
});

test('子ノートの深さには上限がある', () => {
  const m = new BoardManager(tmpDir()).load();
  const { MAX_TREE_DEPTH } = require('../boards.js');
  let parent = MAIN_ID;
  for (let d = 1; d < MAX_TREE_DEPTH; d++) parent = m.create(`d${d}`, parent).id;
  assert.throws(() => m.create('深すぎる', parent), /深い/);
});

test('移動：並べ替え・親の付け替え・タブにする。自分の子孫へは移せない', () => {
  const m = new BoardManager(tmpDir()).load();
  const a = m.create('A', MAIN_ID);
  const b = m.create('B', MAIN_ID);
  const c = m.create('C', MAIN_ID);
  const a1 = m.create('A1', a.id);
  m.move(c.id, MAIN_ID, a.id); // A の前へ
  assert.deepEqual(tree(m).filter((s) => s.endsWith('<ノート 1')), ['C<ノート 1', 'A<ノート 1', 'B<ノート 1']);
  m.move(b.id, a.id); // A の子の最後へ
  assert.deepEqual(tree(m).filter((s) => s.endsWith('<A')), ['A1<A', 'B<A']);
  assert.throws(() => m.move(a.id, a1.id), /自分の中/);
  assert.throws(() => m.move(a.id, a.id), /自分の中/);
  assert.throws(() => m.move(a.id, null, a1.id), /位置/); // before は新しい兄弟でなければならない
  m.move(a.id, null); // タブにする（子ノートごと）
  const roots = m.list().boards.filter((x) => !x.parentId).map((x) => x.name);
  assert.deepEqual(roots, ['ノート 1', 'A']);
  assert.equal(m.rootOf(a1.id), a.id);
  assert.equal(m.rootOf(b.id), a.id);
});

test('移動でタブが変わったら「最後に開いたノート」を付け替える', () => {
  const m = new BoardManager(tmpDir()).load();
  const t2 = m.create('タブ2');
  const a = m.create('A', MAIN_ID);
  assert.equal(m.list().boards.find((x) => x.id === MAIN_ID).openId, a.id);
  m.move(a.id, t2.id); // 表示中の A をタブ2 へ
  const list = m.list().boards;
  assert.equal(list.find((x) => x.id === MAIN_ID).openId, undefined);
  assert.equal(list.find((x) => x.id === t2.id).openId, a.id);
});

test('削除：子ノートも一緒に消え、ファイルは残す。表示中なら親へ、タブごとなら隣のタブへ', () => {
  const dir = tmpDir();
  const m = new BoardManager(dir).load();
  const a = m.create('A', MAIN_ID);
  const a1 = m.create('A1', a.id);
  m.save(a1.id, memoData('孫のメモ'));
  const t2 = m.create('タブ2');
  m.activate(a1.id);
  assert.equal(m.remove(a.id), MAIN_ID); // A の中を見ていた → 親（ノート 1）へ
  assert.deepEqual(tree(m), ['ノート 1', 'タブ2']);
  const files = fs.readdirSync(dir);
  assert.ok(files.some((f) => f.startsWith(`${a1.file}.deleted-`)) && files.some((f) => f.startsWith(`${a.file}.deleted-`)));
  // タブごと削除 → 右隣のタブ（その最後に開いた子ノート）へ
  const t2c = m.create('タブ2の子', t2.id);
  m.activate(MAIN_ID);
  m.create('ノート1の子', MAIN_ID);
  assert.equal(m.remove(MAIN_ID), t2c.id);
  assert.deepEqual(tree(m), ['タブ2', 'タブ2の子<タブ2']);
  assert.throws(() => m.remove(t2.id), /最後/); // 残りが全部消えてしまう
  m.remove(t2c.id);
  assert.equal(m.activeId, t2.id);
});

test('一覧の親の指定が壊れていても読める（無い親・循環はタブにする）', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, INDEX_FILE), JSON.stringify({
    version: 1,
    activeId: 'bb',
    boards: [
      { id: MAIN_ID, name: 'ノート 1', file: 'memos.json', openId: 'cc' },
      { id: 'aa', name: 'A', file: 'memos-aa.json', parentId: 'bb' },
      { id: 'bb', name: 'B', file: 'memos-bb.json', parentId: 'aa' }, // A と B で循環
      { id: 'cc', name: 'C', file: 'memos-cc.json', parentId: 'zz' }, // 無い親
      { id: 'dd', name: 'D', file: 'memos-dd.json', parentId: 'dd' }, // 自分が親
      { id: 'ee', name: 'E', file: 'memos-ee.json', parentId: MAIN_ID },
    ],
  }));
  const m = new BoardManager(dir).load();
  const t = tree(m);
  assert.deepEqual(t.filter((s) => !s.includes('<')).sort(), ['A', 'C', 'D', 'ノート 1'].sort());
  assert.ok(t.includes('B<A') && t.includes('E<ノート 1'));
  assert.equal(m.list().boards[0].openId, undefined); // C はノート 1 のタブの中ではない
});
