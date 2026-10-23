'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../send.js');
const { normalizeStore } = require('../store.js');
const H = require('../hex.js');

const NOW = '2026-10-02T00:00:00.000Z';
const rec = (text, extra = {}) => ({ text, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', likedLevel: 0, liked: false, bookmarked: false, comments: [], ...extra });
const freeExcept = (taken) => (k) => !taken.includes(k);

test('輪のマスは、右上から時計回り（画面の貼り付けと同じ順）', () => {
  assert.deepEqual(S.ringOffsets(1).map(({ dq, dr }) => S.keyOf(dq, dr)), ['1,-1', '1,0', '0,1', '-1,1', '-1,0', '0,-1']);
  assert.equal(S.ringOffsets(2).length, 12);
  assert.equal(S.ringOffsets(3).length, 18);
  for (const { dq, dr } of S.ringOffsets(4)) assert.equal(H.hexDistance({ q: 0, r: 0 }, { q: dq, r: dr }), 4);
});

test('置く場所：中心には置かず、近い空いたマスから順に。埋まっていれば外の輪へ', () => {
  assert.deepEqual(S.pickSpots(() => true, 1), ['1,-1']);
  assert.deepEqual(S.pickSpots(freeExcept(['1,-1']), 1), ['1,0']);
  assert.deepEqual(S.pickSpots(() => true, 3), ['1,-1', '1,0', '0,1']);
  // 1つ目の輪がすべて埋まっていれば、2つ目の輪の最初（右上）から
  const ring1 = S.ringOffsets(1).map(({ dq, dr }) => S.keyOf(dq, dr));
  const spots = S.pickSpots(freeExcept(ring1), 2);
  assert.deepEqual(spots, S.ringOffsets(2).slice(0, 2).map(({ dq, dr }) => S.keyOf(dq, dr)));
  // isFree が中心を空きと言っても、中心は使わない
  assert.ok(!S.pickSpots(() => true, 7).includes('0,0'));
  assert.equal(S.pickSpots(() => false, 1), null);
  assert.equal(S.pickSpots(() => true, 0), null);
});

test('複数のマスは並びを保って、中心の近くに置く（重ならず・中心を避ける）', () => {
  // 横に3つ並んだマス（左上のマスからの位置）
  const offsets = [{ dq: 0, dr: 0 }, { dq: 1, dr: 0 }, { dq: 2, dr: 0 }];
  const spots = S.pickSpots(() => true, 3, offsets);
  const pos = spots.map(S.parseKey);
  assert.ok(!spots.includes('0,0'));
  assert.deepEqual(pos.map((p) => [p.q - pos[0].q, p.r - pos[0].r]), [[0, 0], [1, 0], [2, 0]]); // 並びはそのまま
  assert.ok(pos.every((p) => H.hexDistance({ q: 0, r: 0 }, p) <= 3)); // 近く
  // 埋まっているマスは避ける
  const taken = ['1,-1', '1,0', '0,1', '-1,1'];
  const spots2 = S.pickSpots(freeExcept(taken), 3, offsets);
  assert.ok(spots2.every((k) => !taken.includes(k) && k !== '0,0'));
  const p2 = spots2.map(S.parseKey);
  assert.deepEqual(p2.map((p) => [p.q - p2[0].q, p.r - p2[0].r]), [[0, 0], [1, 0], [2, 0]]);
  // 並びが入る場所が無ければ、1つずつ近い順に
  const onlySingles = (k) => ['1,-1', '0,1', '-1,0'].includes(k);
  assert.deepEqual(S.pickSpots(onlySingles, 3, offsets), ['1,-1', '0,1', '-1,0']);
  // 並びの形がおかしければ（数が合わない・重なる）、1つずつ
  assert.deepEqual(S.pickSpots(() => true, 2, [{ dq: 0, dr: 0 }]), ['1,-1', '1,0']);
  assert.deepEqual(S.pickSpots(() => true, 2, [{ dq: 0, dr: 0 }, { dq: 0, dr: 0 }]), ['1,-1', '1,0']);
});

test('ノートへ送る：原点の下の階層に置く。原点のメモが無ければ作る（保存しても残る）', () => {
  const store = { version: 2, camera: { x: 0, y: 0 }, memos: { '2,0': rec('ほかのメモ') } };
  const sent = rec('送るメモ', { id: 'abc', seq: { id: 'seq1', n: 3 }, likedLevel: 2, liked: true, comments: [{ id: 'c1', text: 'こめんと', createdAt: NOW }],
    children: { camera: { x: 0, y: 0 }, memos: { '1,0': rec('下のメモ', { id: 'def', seq: { id: 'seq1', n: 4 } }) } } });
  const res = S.insertCopies(store, { memoId: null }, [sent], { now: NOW });
  assert.deepEqual(res, { placed: ['1,-1'], depth: 1 });
  const origin = store.memos['0,0'];
  assert.equal(origin.text, '');
  const copy = origin.children.memos['1,-1'];
  assert.equal(copy.text, '送るメモ');
  assert.equal(copy.createdAt, NOW);
  assert.equal(copy.updatedAt, NOW);
  assert.equal(copy.likedLevel, 2); // いいね・コメントは写しにも残る（貼り付けと同じ）
  assert.equal(copy.comments.length, 1);
  assert.equal('id' in copy, false); // ID・通し番号は外す
  assert.equal('seq' in copy, false);
  assert.equal('id' in copy.children.memos['1,0'], false);
  assert.equal('seq' in copy.children.memos['1,0'], false);
  assert.equal(sent.id, 'abc'); // 元のメモはそのまま
  // 保存の形にしても、原点（本文は空）と写しが残る
  const saved = normalizeStore(store, NOW).store;
  assert.equal(saved.memos['0,0'].children.memos['1,-1'].text, '送るメモ');
  assert.equal(saved.memos['2,0'].text, 'ほかのメモ');
});

test('ノートへ送る：今ある原点の下のメモに重ねず、空いた近いマスへ', () => {
  const store = { version: 2, memos: { '0,0': rec('原点', { children: { camera: { x: 0, y: 0 }, memos: { '1,-1': rec('a'), '1,0': rec('b') } } }) } };
  const res = S.insertCopies(store, {}, [rec('x'), rec('y')], { now: NOW });
  assert.deepEqual(res.placed, ['0,1', '-1,1']);
  assert.equal(store.memos['0,0'].text, '原点');
  assert.equal(store.memos['0,0'].children.memos['1,-1'].text, 'a');
  assert.equal(store.memos['0,0'].children.memos['0,1'].text, 'x');
});

test('マスへのリンクへ送る：そのメモ（下の階層・重ねた層の中も探す）の下の階層へ', () => {
  const store = { version: 2, memos: {
    '0,0': rec('原点'),
    '3,0': rec('親', { children: { camera: { x: 0, y: 0 }, memos: {} }, moreLayers: [{ camera: { x: 0, y: 0 }, memos: {
      '1,0': rec('重ねた層のメモ', { id: 'target1', children: { camera: { x: 0, y: 0 }, memos: { '1,-1': rec('先客') } } }),
    } }] }),
  } };
  assert.deepEqual(S.findMemo(store.memos, 'target1').depth, 1);
  const res = S.insertCopies(store, { memoId: 'target1' }, [rec('届いたメモ')], { now: NOW });
  assert.deepEqual(res, { placed: ['1,0'], depth: 2 });
  const target = store.memos['3,0'].moreLayers[0].memos['1,0'];
  assert.equal(target.children.memos['1,0'].text, '届いたメモ');
  assert.equal(target.children.memos['1,-1'].text, '先客');
  assert.equal(store.memos['0,0'].children, undefined); // 原点には何もしない
  assert.throws(() => S.insertCopies(store, { memoId: 'nothere' }, [rec('x')], { now: NOW }), /送り先のマスが見つかりません/);
});

test('送れないとき：深すぎる・多すぎる・送るメモが無い', () => {
  // 深さ 2 のメモの下に、2段の下の階層を持つメモ → 2 + 1 + 2 = 5 > 4
  const deep = rec('d', { id: 'deep' });
  const store = { version: 2, memos: { '1,0': rec('a', { children: { memos: { '1,0': rec('b', { children: { memos: { '1,0': deep } } }) } } }) } };
  const tall = rec('t', { children: { memos: { '1,0': rec('u', { children: { memos: { '1,0': rec('v') } } }) } } });
  assert.equal(S.subtreeHeight(tall), 2);
  assert.throws(() => S.insertCopies(store, { memoId: 'deep' }, [tall], { now: NOW, maxDepth: 4 }), /深すぎる/);
  assert.deepEqual(S.insertCopies(store, { memoId: 'deep' }, [tall], { now: NOW, maxDepth: 5 }).placed, ['1,-1']);
  assert.throws(() => S.insertCopies({ memos: {} }, {}, [], { now: NOW }), /送るメモがありません/);
  assert.throws(() => S.insertCopies({ memos: {} }, {}, Array.from({ length: 201 }, () => rec('x')), { now: NOW }), /200 マスまで/);
});

test('写しにすると空になるメモは送らない（並びも合わせて除く）。画像を組み合わせただけの層も深さに数える', () => {
  assert.equal(S.isBlank(rec('')), true);
  assert.equal(S.isBlank(rec('', { id: 'linked-only' })), true); // 関連付けだけのメモ（ID は写しで外れる）
  assert.equal(S.isBlank(rec('', { likedLevel: 1 })), false);
  assert.equal(S.isBlank(rec('', { images: [{ id: 'i', file: 'x.png' }] })), false);
  assert.equal(S.isBlank(rec('', { children: { memos: { '1,0': rec('') } } })), true);
  assert.equal(S.isBlank(rec('', { children: { memos: {}, combo: { image: 'i' } } })), false);
  const store = { memos: {} };
  const res = S.insertCopies(store, {}, [rec('a'), rec('', { id: 'only-link' }), rec('c')], {
    now: NOW, offsets: [{ dq: 0, dr: 0 }, { dq: 1, dr: 0 }, { dq: 2, dr: 0 }],
  });
  assert.equal(res.placed.length, 2);
  const pos = res.placed.map(S.parseKey);
  assert.deepEqual([pos[1].q - pos[0].q, pos[1].r - pos[0].r], [2, 0]); // a と c の並び（間を1つ空けた横並び）を保つ
  assert.throws(() => S.insertCopies({ memos: {} }, {}, [rec('')], { now: NOW }), /送るメモがありません/);
  assert.equal(S.subtreeHeight(rec('x', { children: { memos: {}, combo: { image: 'i' } } })), 1);
});

test('送るメモと並びを組にする：検査を通らないものは並びも一緒に除く。並びがおかしければ並びなし', () => {
  const norm = (r) => (r && typeof r === 'object' ? r : null);
  const o = (dq, dr) => ({ dq, dr });
  let r = S.pairCells([rec('a'), null, rec('c')], [o(0, 0), o(1, 0), o(2, 0)], norm);
  assert.deepEqual(r.cells.map((x) => x.text), ['a', 'c']);
  assert.deepEqual(r.offsets, [o(0, 0), o(2, 0)]);
  assert.equal(S.pairCells([rec('a'), rec('b')], [o(0, 0), o(0, 0)], norm).offsets, null); // 重なり
  assert.equal(S.pairCells([rec('a'), rec('b')], [o(0, 0)], norm).offsets, null); // 足りない
  assert.equal(S.pairCells([rec('a'), rec('b')], [o(0, 0), o(10001, 0)], norm).offsets, null); // 遠すぎる
  assert.equal(S.pairCells([rec('a'), rec('b')], [o(0, 0), o(0.5, 0)], norm).offsets, null); // 整数でない
  r = S.pairCells([rec('a'), rec('b'), rec('c')], null, norm, 2);
  assert.equal(r.cells.length, 2); // 上限まで
  assert.equal(r.offsets, null);
});

test('メモの見出し：最初の空でない行を、長ければ切る', () => {
  assert.equal(S.memoLabel(rec('\n  一行目  \n二行目')), '一行目');
  assert.equal(S.memoLabel(rec('あ'.repeat(30)), 10), `${'あ'.repeat(10)}…`);
  assert.equal(S.memoLabel(null), '');
});
