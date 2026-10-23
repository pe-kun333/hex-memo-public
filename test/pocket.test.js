'use strict';

// 区画（写しの作業台）：pocket.js の写し方・盤の詰め方・読み込みの整え
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const HP = require('../pocket.js');
const S = require('../store.js');

const { normalizeRecord } = S;
const NOW = '2026-10-06T00:00:00.000Z';
const T0 = '2026-10-01T00:00:00.000Z';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const att = (c, ext = 'png') => `${c.repeat(64)}.${ext}`;
const norm = (list, now = NOW) => HP.normalizePockets(list, now, { normalizeRecord });
// n 番目の紙片：番号札・セル・写した時刻を n から決める（n が大きいほど新しい）
const atOf = (n) => new Date(Date.parse(T0) + n * 1000).toISOString();
const sid = (n) => `s${n.toString(16).padStart(16, '0')}`;
const mkSlip = (n, extra = {}) => ({ id: sid(n), kind: 'memo', ...HP.cellAt(n), at: atOf(n), rec: { text: `紙片${n}`, createdAt: T0, updatedAt: T0 }, ...extra });

// 写すもの・写さないものを全部持つメモ（保存形式）
function fullRec() {
  return normalizeRecord({
    id: 'memo-A',
    text: '元のメモ\n2行目',
    createdAt: '2026-01-02T03:04:05.000Z',
    updatedAt: '2026-02-03T04:05:06.000Z',
    likedLevel: 3,
    likedAt: '2026-03-01T00:00:00.000Z',
    bookmarked: true,
    bookmarkedAt: '2026-03-02T00:00:00.000Z',
    due: '2026-12-31',
    progress: 3,
    seq: { id: 'ab12cd34ef', n: 2 },
    tags: ['仕事', '読書'],
    comments: [
      { id: 'c-root', text: '最初のコメント', createdAt: '2026-01-03T00:00:00.000Z' },
      { id: 'c-reply', text: '返信', parentId: 'c-root', createdAt: '2026-01-04T00:00:00.000Z' },
      { id: 'c-other', text: '別のコメント', createdAt: '2026-01-05T00:00:00.000Z' },
    ],
    images: [{ id: 'img1', file: att('a'), thumb: `${'a'.repeat(64)}.thumb.webp`, width: 10, height: 10 }, { id: 'img2', file: att('b') }],
    cover: 'img2',
    urls: [{ id: 'u1', url: 'https://example.com/', title: '題', favicon: att('c', 'ico'), snapshot: { file: att('d', 'pdf') } }],
    children: { memos: { '1,0': { text: '周りのメモ' } } },
    moreLayers: [{ memos: { '0,1': { text: '重ねた層' } } }],
  }, NOW);
}

// ---- 写す ----

test('紙片に写すとき、いいね・ブックマーク（とその時刻）・期限・進み具合・下の階層・重ねた層・通し番号・番号札が外れる', () => {
  const rec = fullRec();
  for (const k of ['id', 'seq', 'children', 'moreLayers', 'due', 'progress', 'likedAt', 'bookmarkedAt']) assert.ok(k in rec, `元のメモには ${k} がある`);
  const s = HP.slipFromMemo(rec, { board: 'main', memoId: 'memo-A' }, NOW);
  for (const k of ['id', 'seq', 'children', 'moreLayers', 'due', 'progress', 'likedAt', 'bookmarkedAt']) assert.equal(k in s.rec, false, k);
  assert.equal(s.rec.likedLevel, 0);
  assert.equal(s.rec.liked, false);
  assert.equal(s.rec.bookmarked, false);
  // 元のメモは変わらない
  assert.equal(rec.id, 'memo-A');
  assert.equal(rec.likedLevel, 3);
  assert.equal(rec.bookmarked, true);
  assert.ok(rec.children && rec.moreLayers);
  // 写すものが何も残らないメモ（いいね・期限・周りのメモだけ）は紙片にしない
  const only = normalizeRecord({ text: '  ', likedLevel: 2, bookmarked: true, due: '2026-12-31', progress: 2, children: { memos: { '1,0': { text: '周り' } } } }, NOW);
  assert.equal(HP.slipFromMemo(only, { board: 'main' }, NOW), null);
});

test('紙片に写すとき、本文・タグ・コメント（新しい番号札で、返信の親子は保つ）・画像・表紙・リンク・元の作った／直した時刻が残り、写した時刻は別に持つ', () => {
  const rec = fullRec();
  const s = HP.slipFromMemo(rec, null, NOW);
  assert.match(s.id, HP.SLIP_ID_RE);
  assert.equal(s.kind, 'memo');
  assert.equal(s.at, NOW);
  assert.equal('q' in s || 'r' in s, false); // 置く場所は呼ぶ側が決める
  assert.equal('origin' in s, false); // 印が読めなければ持たない
  assert.equal(s.rec.text, '元のメモ\n2行目');
  assert.deepEqual(s.rec.tags, ['仕事', '読書']);
  assert.deepEqual(s.rec.images, rec.images);
  assert.equal(s.rec.cover, 'img2');
  assert.deepEqual(s.rec.urls, rec.urls);
  assert.equal(s.rec.createdAt, '2026-01-02T03:04:05.000Z');
  assert.equal(s.rec.updatedAt, '2026-02-03T04:05:06.000Z');
  // コメント：文と時刻はそのまま、番号札は新しく（元の番号札と1つも重ならない）、返信の親子は対応づける
  assert.deepEqual(s.rec.comments.map((c) => [c.text, c.createdAt]), rec.comments.map((c) => [c.text, c.createdAt]));
  const oldIds = new Set(rec.comments.map((c) => c.id));
  for (const c of s.rec.comments) {
    assert.match(c.id, UUID_RE);
    assert.equal(oldIds.has(c.id), false);
  }
  assert.equal(new Set(s.rec.comments.map((c) => c.id)).size, 3);
  const [root, reply, other] = s.rec.comments;
  assert.equal(reply.parentId, root.id);
  assert.equal('parentId' in root, false);
  assert.equal('parentId' in other, false);
  // 元のメモのコメントの番号札は変わらない
  assert.deepEqual(rec.comments.map((c) => c.id), ['c-root', 'c-reply', 'c-other']);
  // 同じメモをもう一度写すと、紙片の番号札もコメントの番号札も別になる
  const s2 = HP.slipFromMemo(rec, null, NOW);
  assert.notEqual(s2.id, s.id);
  assert.equal(s2.rec.comments.some((c) => s.rec.comments.some((d) => d.id === c.id)), false);
});

test('元の場所の印：マスのメモの紙片は board・memoId・keys・key・where を持つ', () => {
  const origin = { board: 'main', memoId: 'memo-A', keys: ['1,0@2', '3,-1', 'bad step', 5], key: ' 3 , -1 ', where: 'ノート直下（3, -1）', extra: 'x' };
  const s = HP.slipFromMemo(fullRec(), origin, NOW);
  assert.deepEqual(s.origin, { board: 'main', memoId: 'memo-A', keys: ['1,0@2', '3,-1'], key: '3,-1', where: 'ノート直下（3, -1）' });
  // 番号札がまだ無いメモでも、場所の印は持つ。where は 200 字まで
  const s2 = HP.slipFromMemo(fullRec(), { board: 'b2', memoId: 'bad id!', key: '0,1', where: 'あ'.repeat(300) }, NOW);
  assert.equal('memoId' in s2.origin, false);
  assert.equal([...s2.origin.where].length, 200);
  // ノートが読めなければ印を持たない
  assert.equal('origin' in HP.slipFromMemo(fullRec(), { board: 'Bad Board', memoId: 'memo-A' }, NOW), false);
});

test('元の場所の印：棚のコメントの紙片は fromShelf・shelfKey・commentId（memoId は棚の項目に番号札があったときだけ）。長い本文を含む shelfKey も切らない', () => {
  const longText = '長い棚のメモ'.repeat(200);
  const shelfRec = normalizeRecord({ text: longText, createdAt: '2026-09-01T00:00:00.000Z', comments: [{ id: 'sc1', text: '棚のコメント', createdAt: '2026-09-02T00:00:00.000Z' }] }, NOW);
  const shelfKey = `${shelfRec.createdAt}|${shelfRec.text}`; // 番号札の無い棚の項目の見分け（作った時刻＋本文）
  const c = shelfRec.comments[0];
  const s = HP.slipFromComment(c, shelfRec, { board: 'main', fromShelf: true, shelfKey }, NOW);
  assert.equal(s.kind, 'comment');
  assert.equal(s.at, NOW);
  assert.deepEqual(s.origin, { board: 'main', commentId: 'sc1', parentLine: [...longText].slice(0, 200).join(''), fromShelf: true, shelfKey });
  assert.equal(s.origin.shelfKey.length, shelfKey.length);
  assert.equal('memoId' in s.origin, false);
  // 本文はコメントの文、時刻はコメントの時刻。タグ・コメント・画像は持たない
  assert.equal(s.rec.text, '棚のコメント');
  assert.equal(s.rec.createdAt, '2026-09-02T00:00:00.000Z');
  assert.equal(s.rec.updatedAt, '2026-09-02T00:00:00.000Z');
  assert.deepEqual(s.rec.comments, []);
  for (const k of ['tags', 'images', 'urls']) assert.equal(k in s.rec, false, k);
  // 番号札のある棚の項目：memoId も持つ
  const withId = { ...shelfRec, id: 'shelf-memo-1' };
  const s2 = HP.slipFromComment(c, withId, { board: 'main', fromShelf: true, shelfKey: withId.id, memoId: withId.id }, NOW);
  assert.equal(s2.origin.memoId, 'shelf-memo-1');
  assert.equal(s2.origin.shelfKey, 'shelf-memo-1');
  assert.equal(s2.origin.fromShelf, true);
  // 読み込みの整えを通しても切られない
  const [p] = norm([{ id: 'p000000000001', slips: [{ ...s, q: 0, r: 0 }, { ...s2, q: 1, r: 0 }] }]);
  assert.deepEqual(p.slips[0].origin, s.origin);
  assert.deepEqual(p.slips[1].origin, s2.origin);
  // マスのメモのコメント：fromShelf は書かない
  const s3 = HP.slipFromComment(c, shelfRec, { board: 'main', memoId: 'memo-A', key: '1,0', fromShelf: 'yes' }, NOW);
  assert.deepEqual(s3.origin, { board: 'main', memoId: 'memo-A', key: '1,0', commentId: 'sc1', parentLine: s.origin.parentLine });
  // 空のコメントは紙片にしない
  assert.equal(HP.slipFromComment({ id: 'x', text: '   ' }, shelfRec, { board: 'main' }, NOW), null);
});

test('ノートの紙片：本文はノート名＋改行＋原点のメモの1行目。表紙は画像として持ち、元の印はノートだけ', () => {
  const originRec = normalizeRecord({
    id: 'origin-1',
    text: '\n  原点の1行目  \n2行目',
    createdAt: '2026-05-01T00:00:00.000Z',
    updatedAt: '2026-05-02T00:00:00.000Z',
    images: [{ id: 'i1', file: att('a') }, { id: 'i2', file: att('b'), thumb: `${'b'.repeat(64)}.thumb.webp`, width: 4, height: 3 }],
    cover: 'i2',
    tags: ['タグ'],
    comments: [{ id: 'k', text: 'コメント' }],
  }, NOW);
  const s = HP.slipFromBoard({ name: ' 仕事 ', originRec, board: 'b2' }, NOW);
  assert.equal(s.kind, 'note');
  assert.equal(s.at, NOW);
  assert.equal(s.rec.text, '仕事\n原点の1行目');
  assert.deepEqual(s.rec.images, [originRec.images[1]]); // 表紙の画像（の記録ごと）だけ
  assert.equal(s.rec.cover, 'i2');
  assert.equal(s.rec.createdAt, '2026-05-01T00:00:00.000Z');
  assert.deepEqual(s.origin, { board: 'b2' });
  assert.deepEqual(s.rec.comments, []);
  assert.equal('tags' in s.rec, false);
  // 原点のメモが無ければノート名だけ。表紙が無ければ画像も持たない
  const bare = HP.slipFromBoard({ name: '趣味', board: 'main' }, NOW);
  assert.equal(bare.rec.text, '趣味');
  assert.equal('images' in bare.rec, false);
  assert.equal('cover' in bare.rec, false);
  assert.equal(bare.rec.createdAt, NOW);
  // 読み込みの整えでも、ノートの紙片の印はノートだけ（原点のメモの番号札を持たない）
  const [p] = norm([{ slips: [{ ...s, q: 0, r: 0, origin: { board: 'b2', memoId: 'origin-1', key: '0,0', where: 'x' } }] }]);
  assert.deepEqual(p.slips[0].origin, { board: 'b2' });
  assert.deepEqual(p.slips[0].rec.images, s.rec.images);
  assert.equal(p.slips[0].rec.cover, 'i2');
});

// ---- 盤 ----

test('空いたセル：上の行から左→右の順に詰め、埋まっているセルを飛ばす。列数を変えても重ならない', () => {
  assert.deepEqual(HP.nextFreeCells(new Set(), 6), [{ q: 0, r: 0 }, { q: 1, r: 0 }, { q: 0, r: 1 }, { q: 1, r: 1 }, { q: -1, r: 2 }, { q: 0, r: 2 }]);
  assert.deepEqual(HP.nextFreeCells(new Set(['0,0', '0,1']), 3), [{ q: 1, r: 0 }, { q: 1, r: 1 }, { q: -1, r: 2 }]);
  assert.deepEqual(HP.nextFreeCells(new Set(), 4, 3), [{ q: 0, r: 0 }, { q: 1, r: 0 }, { q: 2, r: 0 }, { q: 0, r: 1 }]);
  assert.deepEqual(HP.nextFreeCells(new Set(), 0), []);
  for (const cols of [2, 3]) {
    const cells = HP.nextFreeCells(new Set(), 60, cols);
    assert.equal(new Set(cells.map((c) => HP.keyOf(c.q, c.r))).size, 60, `${cols} 列`);
    cells.forEach((c, i) => {
      assert.equal(c.r, Math.floor(i / cols)); // 1行に cols 個ずつ、上から
      assert.equal(HP.bandIndex(c.q, c.r, cols), i); // 帯の中の順番と一致
    });
    // 1つおきに埋まっていても、残りのセルを上から順に返す（埋まったセルとは重ならない）
    const occupied = new Set(cells.filter((_, i) => i % 2 === 0).map((c) => HP.keyOf(c.q, c.r)));
    assert.deepEqual(HP.nextFreeCells(occupied, 30, cols), cells.filter((_, i) => i % 2 === 1));
  }
});

test('settleSlips：座標が読めない・帯の外・重なる紙片を、写した時刻の早い紙片を残して空いたセルへずらす。重ならなければ同じ配列を返す', () => {
  const s = (id, q, r, at) => ({ id, kind: 'memo', q, r, at, rec: { text: id } });
  const ok = [s('a', 0, 0, atOf(1)), s('b', 1, 0, atOf(2)), s('c', 0, 1, atOf(3))];
  assert.equal(HP.settleSlips(ok), ok);
  const list = [
    s('late', 0, 0, atOf(5)), // 早い紙片と重なる → ずれる
    s('early', 0, 0, atOf(1)), // 早いので残る
    s('nul', null, null, atOf(2)), // 座標が読めない
    s('out', 5, 0, atOf(3)), // 帯の外（右）
    s('neg', 0, -1, atOf(4)), // 帯の外（上）
    s('keep', 1, 0, atOf(6)),
  ];
  const out = HP.settleSlips(list);
  assert.notEqual(out, list);
  assert.deepEqual(out.map((x) => x.id), list.map((x) => x.id)); // 並びは変えない
  const pos = Object.fromEntries(out.map((x) => [x.id, HP.keyOf(x.q, x.r)]));
  // ずらす紙片は写した時刻の早い順に、上の空いたセルから
  assert.deepEqual(pos, { early: '0,0', keep: '1,0', nul: '0,1', out: '1,1', neg: '-1,2', late: '0,2' });
  assert.equal(out[1], list[1]); // ずらしていない紙片は同じオブジェクト
  assert.equal(out[5], list[5]);
  assert.equal(list[0].q, 0); // 渡した紙片は書き換えない
  assert.equal(HP.settleSlips(out), out);
  // 写した時刻が同じなら番号札の小さいほうが残る
  const tie = HP.settleSlips([s('b', 0, 0, atOf(1)), s('a', 0, 0, atOf(1))]);
  assert.deepEqual(tie.map((x) => [x.id, x.q, x.r]), [['b', 1, 0], ['a', 0, 0]]);
  // 列数：3 列なら (2, 0) は帯の中、2 列なら外
  const wide = [s('w', 2, 0, atOf(1))];
  assert.equal(HP.settleSlips(wide, 3), wide);
  assert.deepEqual(HP.settleSlips(wide).map((x) => [x.q, x.r]), [[0, 0]]);
});

// ---- 読み込みの整え ----

test('normalizePockets：知らない種類・空の紙片・端の無い線・両端が同じ線・同じ組の2本目を捨てる', () => {
  const [p] = norm([{
    id: 'p000000000001',
    name: '作業',
    createdAt: T0,
    updatedAt: T0,
    slips: [
      mkSlip(0),
      mkSlip(1, { kind: 'note' }),
      mkSlip(2, { kind: 'comment' }),
      mkSlip(3, { kind: 'picture' }), // 知らない種類
      mkSlip(4, { kind: undefined }),
      // 写すもの（本文・タグ・コメント・画像・リンク）が無い
      mkSlip(5, { rec: { text: '   ', likedLevel: 3, bookmarked: true, due: '2026-12-31', progress: 2, children: { memos: { '1,0': { text: '周り' } } } } }),
      mkSlip(6, { rec: null }),
      mkSlip(7, { rec: [{ text: '配列' }] }),
      null,
      'x',
      [mkSlip(8)],
    ],
    lines: [
      { a: sid(0), b: sid(1), createdAt: T0 },
      { a: sid(1), b: sid(0), createdAt: T0 }, // 同じ組
      { a: sid(0), b: sid(0) }, // 両端が同じ
      { a: sid(0), b: sid(3) }, // 端の紙片が捨てられた
      { a: sid(0), b: sid(99) }, // 無い紙片
      { a: sid(0) }, // 端が無い
      { a: sid(1), b: sid(2), createdAt: 'おかしな日時' },
      null,
      'x',
    ],
  }]);
  assert.deepEqual(p.slips.map((s) => s.id), [sid(0), sid(1), sid(2)]);
  assert.deepEqual(p.slips.map((s) => s.kind), ['memo', 'note', 'comment']);
  assert.deepEqual(p.lines, [{ a: sid(0), b: sid(1), createdAt: T0 }, { a: sid(1), b: sid(2), createdAt: NOW }]);
  // 一覧でないもの・整えの関数が無いときは空
  assert.deepEqual(norm(null), []);
  assert.deepEqual(norm('x'), []);
  assert.deepEqual(norm({ slips: [mkSlip(0)] }), []);
  assert.deepEqual(HP.normalizePockets([{ slips: [mkSlip(0)] }], NOW), []);
});

test('normalizePockets：名前が空なら「区画」。紙片が 0 枚で名前・色が既定の区画は捨て、名前か色があれば残す', () => {
  const out = norm([
    { id: 'p000000000001', name: '   ', createdAt: atOf(1), slips: [mkSlip(0)] },
    { id: 'p000000000002', name: '区画', createdAt: atOf(2), slips: [], lines: [] }, // 捨てる
    { id: 'p000000000003', createdAt: atOf(3), slips: [mkSlip(1, { kind: 'zzz' })] }, // 紙片がすべて捨てられて空 → 捨てる
    { id: 'p000000000004', name: '  あとで \n 読む  ', createdAt: atOf(4), slips: [] },
    { id: 'p000000000005', color: '#ABCDEF', createdAt: atOf(5) },
    { id: 'p000000000006', name: 'x'.repeat(60), createdAt: atOf(6), slips: [mkSlip(2)] },
    { id: 'p000000000007', size: 'read', createdAt: atOf(7) }, // 大きさの予約だけでは残さない
    null,
    'x',
    [],
  ]);
  assert.deepEqual(out.map((p) => [p.id, p.name, p.color || null, p.slips.length]), [
    ['p000000000001', '区画', null, 1],
    ['p000000000004', 'あとで 読む', null, 0],
    ['p000000000005', '区画', '#abcdef', 0],
    ['p000000000006', 'x'.repeat(40), null, 1],
  ]);
  for (const p of out) assert.deepEqual(Object.keys(p).filter((k) => !['color', 'size', 'layout'].includes(k)).sort(), ['createdAt', 'id', 'lines', 'name', 'slips', 'updatedAt']);
  assert.equal(HP.isBlankPocket(HP.newPocket(NOW)), true); // 作ったばかりの区画は、紙片を足すまで保存しない
});

test('normalizePockets：上限（区画 20・紙片 200 は写した時刻の新しいものから落とす・線 2,000・置いた記録 50 は新しいものを残す）', () => {
  // 区画
  const many = Array.from({ length: 25 }, (_, i) => ({ id: `p${String(i).padStart(12, '0')}`, name: `区画${i}`, createdAt: atOf(i) }));
  const ps = norm(many);
  assert.equal(ps.length, HP.MAX_POCKETS);
  assert.deepEqual(ps.map((p) => p.name), many.slice(0, 20).map((p) => p.name));
  // 紙片：新しいものから並べて渡しても、落とすのは写した時刻の新しい 5 枚（並びと座標は変えない）
  const slips = Array.from({ length: 205 }, (_, i) => mkSlip(204 - i));
  const [p] = norm([{ id: 'p000000000001', slips }]);
  assert.equal(p.slips.length, HP.MAX_SLIPS);
  assert.deepEqual(p.slips.map((s) => s.id), slips.slice(5).map((s) => s.id));
  for (const s of p.slips) assert.deepEqual({ q: s.q, r: s.r }, HP.cellAt(parseInt(s.id.slice(1), 16)));
  // 線：65 枚の紙片の組（2,080 通り）から 2,050 本 → 先頭の 2,000 本
  const lines = [];
  for (let i = 0; i < 65 && lines.length < 2050; i++) for (let j = i + 1; j < 65 && lines.length < 2050; j++) lines.push({ a: sid(i), b: sid(j), createdAt: T0 });
  const [pl] = norm([{ slips: Array.from({ length: 65 }, (_, i) => mkSlip(i)), lines }]);
  assert.equal(pl.lines.length, HP.MAX_LINES);
  assert.deepEqual(pl.lines, lines.slice(0, HP.MAX_LINES));
  // 置いた記録：55 件 → 時刻の新しい 50 件を、時刻の順に
  const placed = Array.from({ length: 55 }, (_, i) => ({ board: 'main', memoId: `m${i}`, at: atOf(i) }));
  const [pp] = norm([{ slips: [mkSlip(0, { placed: placed.slice().reverse() })] }]);
  assert.equal(pp.slips[0].placed.length, HP.MAX_PLACED);
  assert.deepEqual(pp.slips[0].placed, placed.slice(5));
});

test('normalizePockets：番号札の形を確かめ、読めない・重なる番号札は付け直す', () => {
  const out = norm([
    { id: 'p000000000001', name: 'A', createdAt: atOf(1), slips: [mkSlip(0), mkSlip(1, { id: 'bad' }), mkSlip(2, { id: sid(0) })] },
    // 区画の番号札が重なる。ほかの区画と紙片の番号札が重なる
    { id: 'p000000000001', name: 'B', createdAt: atOf(2), slips: [mkSlip(3, { id: sid(3) }), mkSlip(4, { id: sid(0) })] },
    { id: 'P000000000001', name: 'C', createdAt: atOf(3) },
    { id: 12, name: 'D', createdAt: atOf(4) },
  ]);
  assert.deepEqual(out.map((p) => p.name), ['A', 'B', 'C', 'D']);
  assert.equal(out[0].id, 'p000000000001');
  for (const p of out.slice(1)) {
    assert.match(p.id, HP.POCKET_ID_RE);
    assert.notEqual(p.id, 'p000000000001');
  }
  assert.equal(new Set(out.map((p) => p.id)).size, 4);
  const ids = out.flatMap((p) => p.slips.map((s) => s.id));
  for (const id of ids) assert.match(id, HP.SLIP_ID_RE);
  assert.equal(new Set(ids).size, 5);
  assert.equal(ids[0], sid(0));
  assert.equal(ids[3], sid(3));
  assert.notEqual(ids[1], 'bad');
  assert.notEqual(ids[2], sid(0));
  assert.notEqual(ids[4], sid(0));
  // 付け直した番号札は次の読み込みで変わらない
  assert.deepEqual(norm(out), out);
});

test('normalizePockets：大きさは read／small だけ、色は #rrggbb だけ（小文字に）、線の種類・ラベルは関連付けと同じ形', () => {
  const out = norm([
    {
      id: 'p000000000001',
      createdAt: atOf(1),
      size: 'read',
      color: ' #ABCDEF ',
      slips: [mkSlip(0), mkSlip(1), mkSlip(2)],
      lines: [
        { a: sid(0), b: sid(1), kind: 'support', label: '  根拠 の\n 1  ' },
        { a: sid(1), b: sid(2), kind: 'Bad Kind!', label: 'x'.repeat(100) },
        { a: sid(0), b: sid(2), kind: 5, label: '   ' },
      ],
    },
    { id: 'p000000000002', createdAt: atOf(2), size: 'small', color: '#abc', slips: [mkSlip(3)] },
    { id: 'p000000000003', createdAt: atOf(3), size: 'huge', color: 'red', slips: [mkSlip(4)] },
    { id: 'p000000000004', createdAt: atOf(4), size: 1, color: 0x336699, slips: [mkSlip(5)] },
  ]);
  assert.deepEqual(out.map((p) => [p.size || null, p.color || null]), [['read', '#abcdef'], ['small', null], [null, null], [null, null]]);
  const [l1, l2, l3] = out[0].lines;
  assert.equal(l1.kind, 'support');
  assert.equal(l1.label, '根拠 の 1');
  assert.equal('kind' in l2, false);
  assert.equal([...l2.label].length, HP.LINK_LABEL_MAX);
  assert.equal('kind' in l3, false);
  assert.equal('label' in l3, false);
  assert.equal(l3.createdAt, NOW);
});

test('normalizePockets：置いた記録・元の場所の印・グラフの並びは、元のメモがどこにも無くても残る。置いた記録はメモの番号札ごとに新しいものを残す', () => {
  const [p] = norm([{
    id: 'p000000000001',
    createdAt: T0,
    slips: [
      mkSlip(0, {
        origin: { board: 'main', memoId: 'gone-memo', keys: ['1,0'], key: '2,0', where: '消えた場所' },
        placed: [
          { board: 'main', memoId: 'm1', at: '2026-10-02T00:00:00Z' },
          { board: 'b2', memoId: 'm1', at: '2026-10-03T00:00:00Z' }, // 同じメモ：新しいほう
          { board: 'main', memoId: 'm1', at: '2026-10-01T00:00:00Z' },
          { board: 'main', memoId: 'm2', at: 'おかしな日時' }, // 時刻が読めない → 今の時刻で残す
          { board: 'BAD', memoId: 'm3', at: T0 },
          { board: 'main', memoId: 'bad id!', at: T0 },
          null,
          'x',
        ],
      }),
      mkSlip(1, { placed: 'x', origin: 'x' }),
    ],
    layout: { [sid(0)]: { x: 10.4, y: -20.6 }, [sid(1)]: { x: 5e9, y: 3 }, [sid(9)]: { x: 0, y: 0 }, bad: { x: 1, y: 1 } },
  }]);
  assert.deepEqual(p.slips[0].origin, { board: 'main', memoId: 'gone-memo', keys: ['1,0'], key: '2,0', where: '消えた場所' });
  assert.deepEqual(p.slips[0].placed, [{ board: 'b2', memoId: 'm1', at: '2026-10-03T00:00:00.000Z' }, { board: 'main', memoId: 'm2', at: NOW }]);
  assert.equal('placed' in p.slips[1], false);
  assert.equal('origin' in p.slips[1], false);
  // その区画にある紙片の位置だけ、整数に丸めて範囲に収める
  assert.deepEqual(p.layout, { [sid(0)]: { x: 10, y: -21 }, [sid(1)]: { x: 1e6, y: 3 } });
  const [noLayout] = norm([{ slips: [mkSlip(0)], layout: { [sid(0)]: { x: null, y: 1 }, [sid(9)]: { x: 1, y: 1 } } }]);
  assert.equal('layout' in noLayout, false);
  // 2つのウィンドウの合わせ方でも使う：いくつかの一覧をまとめると和（同じメモは新しいほう）
  assert.deepEqual(HP.mergePlaced([{ board: 'main', memoId: 'a', at: T0 }], [{ board: 'main', memoId: 'b', at: T0 }, { board: 'b2', memoId: 'a', at: NOW }]), [
    { board: 'main', memoId: 'b', at: T0 },
    { board: 'b2', memoId: 'a', at: NOW },
  ]);
});

test('normalizePockets：区画は作った時刻の順（同じなら番号札の順）に並ぶ', () => {
  const out = norm([
    { id: 'p000000000003', name: 'C', createdAt: atOf(3) },
    { id: 'p000000000002', name: 'B', createdAt: atOf(1) },
    { id: 'p000000000001', name: 'A', createdAt: atOf(3) },
    { id: 'p000000000004', name: 'D', updatedAt: atOf(2) }, // 作った時刻が無ければ直した時刻
  ]);
  assert.deepEqual(out.map((p) => p.name), ['B', 'D', 'A', 'C']);
  assert.equal(out[1].createdAt, atOf(2));
  assert.equal(out[1].updatedAt, atOf(2));
});

test('normalizePockets：紙片の種類で削るものは変えない（コメントの紙片にタグ・画像があっても残る）。children・due などを混ぜても整えたあとには無い', () => {
  const rec = {
    text: 'コメントの文',
    createdAt: T0,
    updatedAt: T0,
    tags: ['あとで'],
    images: [{ id: 'i1', file: att('a') }],
    cover: 'i1',
    urls: [{ id: 'u1', url: 'https://example.com/' }],
    comments: [{ id: 'k1', text: '返事', createdAt: T0 }],
  };
  const extra = {
    id: 'memo-x',
    seq: { id: 'ab12cd34ef', n: 1 },
    likedLevel: 2,
    likedAt: T0,
    bookmarked: true,
    bookmarkedAt: T0,
    due: '2026-12-31',
    progress: 4,
    children: { memos: { '1,0': { text: '周り', images: [{ file: att('z') }] } } },
    moreLayers: [{ memos: { '0,1': { text: '層' } } }],
  };
  const [p] = norm([{ id: 'p000000000001', slips: ['memo', 'note', 'comment'].map((kind, i) => mkSlip(i, { kind, rec: { ...rec, ...extra } })) }]);
  const recs = p.slips.map((s) => s.rec);
  for (const r of recs) {
    assert.deepEqual(r.tags, ['あとで']);
    assert.deepEqual(r.images.map((img) => img.file), [att('a')]);
    assert.equal(r.cover, 'i1');
    assert.deepEqual(r.urls.map((u) => u.url), ['https://example.com/']);
    assert.deepEqual(r.comments, [{ id: 'k1', text: '返事', createdAt: T0 }]);
    for (const k of ['id', 'seq', 'likedAt', 'bookmarkedAt', 'due', 'progress', 'children', 'moreLayers']) assert.equal(k in r, false, k);
    assert.equal(r.likedLevel, 0);
    assert.equal(r.liked, false);
    assert.equal(r.bookmarked, false);
  }
  assert.deepEqual(recs[0], recs[1]);
  assert.deepEqual(recs[1], recs[2]);
});

test('normalizePockets：2回通しても同じ（別の時刻で通しても）。コメントの番号札と返信の親子は変えない', () => {
  const memoSlip = HP.slipFromMemo(fullRec(), { board: 'main', memoId: 'memo-A', keys: ['1,0@2'], key: '3,-1', where: '場所' }, T0);
  const raw = [
    {
      id: 'p000000000002',
      name: '  考え ごと ',
      color: '#ABCDEF',
      size: 'small',
      createdAt: T0,
      slips: [
        { ...memoSlip, placed: [{ board: 'main', memoId: 'm1', at: 'おかしな日時' }, { board: 'main', memoId: 'm2', at: T0 }] },
        mkSlip(1, { q: 0, r: 0, kind: 'comment', origin: { board: 'main', commentId: 'c1', parentLine: '親', fromShelf: true, shelfKey: `${T0}|棚` } }), // 重なる
        mkSlip(2, { q: 'x', kind: 'note', origin: { board: 'b2' } }),
      ],
      lines: [{ a: memoSlip.id, b: sid(1), kind: 'support', label: ' ラベル ' }, { a: sid(2), b: sid(1) }],
      layout: { [memoSlip.id]: { x: 1.5, y: 2.5 } },
    },
    { name: '名前だけ', createdAt: 'おかしな日時' },
  ];
  const once = norm(raw);
  const twice = norm(once, '2026-12-01T00:00:00.000Z');
  assert.deepEqual(twice, once);
  assert.deepEqual(norm(JSON.parse(JSON.stringify(once)), '2027-01-01T00:00:00.000Z'), once);
  // コメントの番号札は、写したとき（slipFrom*）のままで、整えでは付け直さない
  const before = memoSlip.rec.comments.map((c) => [c.id, c.parentId || null]);
  const slip = once.find((p) => p.id === 'p000000000002').slips.find((s) => s.id === memoSlip.id);
  assert.deepEqual(slip.rec.comments.map((c) => [c.id, c.parentId || null]), before);
  assert.deepEqual(twice.find((p) => p.id === 'p000000000002').slips.find((s) => s.id === memoSlip.id).rec.comments.map((c) => [c.id, c.parentId || null]), before);
  // 重なった紙片は空いたセルへずれて、ほかと重ならない
  const cells = once[0].slips.map((s) => HP.keyOf(s.q, s.r));
  assert.equal(new Set(cells).size, cells.length);
});

test('stripForSlip：外すだけ。2回通しても同じで、コメントの番号札には触らず、元のメモも変えない', () => {
  const rec = fullRec();
  const once = HP.stripForSlip(rec);
  assert.deepEqual(HP.stripForSlip(once), once);
  assert.deepEqual(once.comments, rec.comments);
  assert.notEqual(once, rec);
  assert.equal(rec.id, 'memo-A');
  assert.equal(rec.due, '2026-12-31');
  // 空の一覧は持たない。表紙の画像が無ければ表紙も外す。コメントが無ければ空の一覧
  assert.deepEqual(HP.stripForSlip({ text: 'a', tags: [], images: [], urls: [], cover: 'x' }), { text: 'a', likedLevel: 0, liked: false, bookmarked: false, comments: [] });
});

// ---- store.js・boards.js との決まりの一致 ----

test('pocket.js の決まり（番号札の形・種類・色・ラベルの長さ・座標の上限・階層の深さ）は store.js・boards.js と同じ', () => {
  const src = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
  // 「const 名前 = 値;」の値を読む（正規表現か数）。多くは公開していないので、ファイルの文字から読む
  const valueOf = (text, name) => {
    const m = new RegExp(`^const ${name} = (.+?);`, 'm').exec(text);
    assert.ok(m, `${name} が見つかりません`);
    const re = /^\/(.+)\/([a-z]*)$/.exec(m[1]);
    return re ? new RegExp(re[1], re[2]) : Number(m[1]);
  };
  const store = src('store.js');
  for (const name of ['MEMO_ID_RE', 'STEP_RE', 'KIND_RE', 'COLOR_RE']) {
    const re = valueOf(store, name);
    assert.equal(HP[name].source, re.source, name);
    assert.equal(HP[name].flags, re.flags, name);
  }
  for (const name of ['LINK_LABEL_MAX', 'LAYOUT_COORD_MAX', 'MAX_DEPTH']) assert.equal(HP[name], valueOf(store, name), name);
  const boardId = valueOf(src('boards.js'), 'ID_RE');
  assert.equal(HP.BOARD_ID_RE.source, boardId.source);
  assert.equal(HP.BOARD_ID_RE.flags, boardId.flags);
  // 公開しているものは値でも比べる
  assert.equal(HP.KIND_RE.source, S.KIND_RE.source);
  assert.equal(HP.COLOR_RE.source, S.COLOR_RE.source);
  assert.equal(HP.MAX_DEPTH, S.MAX_DEPTH);
});

test('番号札は crypto が無い環境（iPad を http で開いたときなど）でも作れる', () => {
  const code = fs.readFileSync(path.join(__dirname, '..', 'pocket.js'), 'utf8');
  for (const sandbox of [{}, { crypto: {} }]) {
    const ctx = vm.createContext(sandbox);
    vm.runInContext(code, ctx); // 読み込んだだけでは crypto に触らない
    const P = ctx.HexPocket;
    assert.ok(P, '画面と同じく HexPocket として読める');
    const slips = new Set();
    for (let i = 0; i < 50; i++) {
      const id = P.newSlipId();
      assert.match(id, /^s[0-9a-f]{16}$/);
      slips.add(id);
      assert.match(P.newPocketId(), /^p[0-9a-f]{12}$/);
      assert.match(P.newCommentId(), UUID_RE);
    }
    assert.equal(slips.size, 50);
    // 写す処理（コメントの番号札の付け直し）も動く
    const s = P.slipFromMemo({ text: 'a', comments: [{ id: 'c1', text: 'x' }, { id: 'c2', text: 'y', parentId: 'c1' }] }, { board: 'main' }, NOW);
    assert.match(s.id, /^s[0-9a-f]{16}$/);
    assert.match(s.rec.comments[0].id, UUID_RE);
    assert.equal(s.rec.comments[1].parentId, s.rec.comments[0].id);
  }
  // crypto がある環境（Node・Electron）でも同じ形
  assert.match(HP.newSlipId(), HP.SLIP_ID_RE);
  assert.match(HP.newPocketId(), HP.POCKET_ID_RE);
  assert.match(HP.newCommentId(), UUID_RE);
});

// ---- 絞り込み ----

test('絞り込み：空白で区切った言葉をすべて含む紙片だけ（大文字小文字・全角半角を問わず、コメントとタグも見る）', () => {
  const s = { kind: 'memo', rec: { text: 'Hello 世界', tags: ['ReadLater'], comments: [{ id: 'c', text: 'ｶﾀｶﾅ のコメント' }] } };
  assert.equal(HP.slipMatches(s, ''), true);
  assert.equal(HP.slipMatches(s, '   '), true);
  assert.equal(HP.slipMatches(s, 'hello'), true);
  assert.equal(HP.slipMatches(s, 'ＨＥＬＬＯ'), true);
  assert.equal(HP.slipMatches(s, 'hello　世界'), true); // 全角の空白で区切っても
  assert.equal(HP.slipMatches(s, '世界 hello'), true);
  assert.equal(HP.slipMatches(s, 'hello 宇宙'), false); // すべて含むときだけ
  assert.equal(HP.slipMatches(s, 'カタカナ'), true); // コメント（半角カナ）
  assert.equal(HP.slipMatches(s, 'readlater'), true); // タグ
  assert.equal(HP.slipMatches(s, '#readlater'), true);
  assert.equal(HP.slipMatches(s, '＃ReadLater'), true);
  assert.equal(HP.slipMatches(s, 'nothing'), false);
  // コメントの紙片は、親のメモの1行目でも見つかる
  const c = { kind: 'comment', rec: { text: 'コメント' }, origin: { board: 'main', parentLine: '親のメモ' } };
  assert.equal(HP.slipMatches(c, '親の'), true);
  assert.equal(HP.slipMatches(c, 'コメント 親'), true);
  assert.equal(HP.slipMatches({ kind: 'memo', rec: null }, 'x'), false);
});

// ---- 写しは参照でない・空の見分け・座標の読み方 ----

test('紙片は写し：紙片の中身（画像・リンク・タグ・コメント）を直しても元のメモは変わらず、元のメモを直しても紙片は変わらない', () => {
  const rec = fullRec();
  const before = JSON.parse(JSON.stringify(rec));
  const s = HP.slipFromMemo(rec, { board: 'main', memoId: 'memo-A' }, NOW);
  const copied = JSON.parse(JSON.stringify(s.rec));
  // 同じオブジェクトを指していない
  assert.notEqual(s.rec.images, rec.images);
  assert.notEqual(s.rec.images[0], rec.images[0]);
  assert.notEqual(s.rec.urls[0], rec.urls[0]);
  assert.notEqual(s.rec.urls[0].snapshot, rec.urls[0].snapshot);
  assert.notEqual(s.rec.tags, rec.tags);
  // 紙片を直す → 元のメモはそのまま
  s.rec.images[0].width = 999;
  s.rec.urls[0].title = '紙片で直した題';
  s.rec.urls[0].snapshot.file = 'x';
  s.rec.tags.push('紙片だけ');
  s.rec.comments[0].text = '紙片で直したコメント';
  assert.deepEqual(rec, before);
  // 元のメモを直す → 写したあとの紙片はそのまま
  const s2 = HP.slipFromMemo(rec, { board: 'main', memoId: 'memo-A' }, NOW);
  const copied2 = JSON.parse(JSON.stringify(s2.rec));
  rec.images[1].file = att('z');
  rec.urls[0].favicon = att('y', 'ico');
  rec.tags.length = 0;
  rec.comments[1].text = '元で直した返信';
  assert.deepEqual(JSON.parse(JSON.stringify(s2.rec)), copied2);
  assert.notDeepEqual(JSON.parse(JSON.stringify(s.rec)), copied); // 1枚目は上で直したので変わっている（確かめ方が効いている）
  // ノートの紙片の表紙も写し
  const originRec = normalizeRecord({ text: '原点', images: [{ id: 'i1', file: att('a'), width: 4, height: 3 }], cover: 'i1' }, NOW);
  const b = HP.slipFromBoard({ name: 'ノート', originRec, board: 'main' }, NOW);
  assert.notEqual(b.rec.images[0], originRec.images[0]);
  b.rec.images[0].width = 1;
  assert.equal(originRec.images[0].width, 4);
});

test('空の紙片の見分け：本文が無くても、タグ・コメント・画像・リンクのどれか1つがあれば紙片にでき、読み込みでも捨てない', () => {
  const only = {
    tags: { text: '', tags: ['タグだけ'] },
    comments: { text: '  ', comments: [{ id: 'k1', text: 'コメントだけ', createdAt: T0 }] },
    images: { text: '', images: [{ id: 'i1', file: att('a') }] },
    urls: { text: '', urls: [{ id: 'u1', url: 'https://example.com/only-link' }] },
  };
  for (const [name, raw] of Object.entries(only)) {
    const rec = normalizeRecord({ ...raw, createdAt: T0 }, NOW);
    assert.equal(HP.isBlankSlip(rec), false, name);
    const s = HP.slipFromMemo(rec, { board: 'main' }, NOW);
    assert.ok(s, name);
    const [p] = norm([{ id: 'p000000000001', slips: [{ ...s, q: 0, r: 0 }] }]);
    assert.ok(p, name);
    assert.deepEqual(p.slips.map((x) => x.id), [s.id], name);
  }
  // どれも無ければ空（写さない・読み込みで捨てる）
  assert.equal(HP.isBlankSlip(normalizeRecord({ text: ' \n ', tags: [], comments: [], images: [], urls: [] }, NOW)), true);
  assert.equal(HP.isBlankSlip(null), true);
  assert.equal(HP.isBlankSlip('文字'), true);
});

test('normalizePockets：座標は整数だけ読む（文字・真偽値・小数・無限大は読めない座標として、上の空いたセルへ）', () => {
  // 1枚ずつ渡す：読めない座標なら (0, 0) へ。数に直して読んでしまうと、書かれたセルに残ってしまう
  for (const [q, r] of [['1', 0], [0, '1'], [true, 1], [1, true], [1.5, 0], [0, 1.5], [Infinity, 0], [1, NaN], [1, null], [[1], 0], [1, undefined]]) {
    const [p] = norm([{ id: 'p000000000001', slips: [mkSlip(0, { q, r })] }]);
    assert.deepEqual([p.slips[0].q, p.slips[0].r], [0, 0], JSON.stringify([q, r]));
  }
  // 整数ならそのまま（帯の中の空いたセルでも動かさない）
  for (const [q, r] of [[1, 0], [0, 1], [1, 1], [-1, 2], [-2, 5]]) {
    const [p] = norm([{ id: 'p000000000001', slips: [mkSlip(0, { q, r })] }]);
    assert.deepEqual([p.slips[0].q, p.slips[0].r], [q, r]);
  }
});

test('元の場所の印：階層の鍵（keys）は「周りに書く」の深さの上限まで', () => {
  const keys = Array.from({ length: HP.MAX_DEPTH + 10 }, (_, i) => `${i},0@1`);
  const s = HP.slipFromMemo(fullRec(), { board: 'main', memoId: 'memo-A', keys }, NOW);
  assert.deepEqual(s.origin.keys, keys.slice(0, HP.MAX_DEPTH));
  const [p] = norm([{ id: 'p000000000001', slips: [{ ...s, q: 0, r: 0, origin: { board: 'main', memoId: 'memo-A', keys } }] }]);
  assert.deepEqual(p.slips[0].origin.keys, keys.slice(0, HP.MAX_DEPTH));
});

test('capSlips：上限を超えた分は、写した時刻の新しいものから落とす（並びは変えない）', () => {
  const s = (id, at) => ({ id, at });
  const list = [s('a', '2026-10-03'), s('b', '2026-10-01'), s('c', '2026-10-02')];
  assert.deepEqual(HP.capSlips(list, 2).map((x) => x.id), ['b', 'c']);
  assert.equal(HP.capSlips(list, 3), list);
});

// ---- 段階2：写しの表・置いた写しの数・置くときのメモ・元がどこにあるか・ほかのノートを覗く ----

test('写しの表（buildCopyIndex）：元の場所の印と置いた記録の両方を数え、同じ紙片は1回。ほかのノート・ノートの紙片は除く。区画が2枚でも集める', () => {
  const pockets = [
    { id: 'p1', slips: [
      { id: 's1', kind: 'memo', origin: { board: 'main', memoId: 'm1' }, placed: [{ board: 'main', memoId: 'm2', at: T0 }, { board: 'main', memoId: 'm1', at: T0 }] },
      { id: 's2', kind: 'comment', origin: { board: 'main', memoId: 'm1', commentId: 'c1' } }, // コメントの紙片は親のメモに数える
      { id: 's3', kind: 'note', origin: { board: 'main' } }, // ノートの紙片は元のマスを持たない
      { id: 's4', kind: 'memo', origin: { board: 'other', memoId: 'm1' }, placed: [{ board: 'other', memoId: 'm9', at: T0 }] },
    ] },
    { id: 'p2', slips: [{ id: 's5', kind: 'memo', origin: { board: 'main', memoId: 'm2' } }] },
  ];
  const idx = HP.buildCopyIndex(pockets, 'main');
  assert.deepEqual(idx.get('m1'), [{ pocketId: 'p1', slipId: 's1' }, { pocketId: 'p1', slipId: 's2' }]);
  assert.deepEqual(idx.get('m2'), [{ pocketId: 'p1', slipId: 's1' }, { pocketId: 'p2', slipId: 's5' }]);
  assert.equal(idx.has('m9'), false);
  assert.equal([...idx.keys()].length, 2);
  assert.equal(HP.buildCopyIndex(undefined, 'main').size, 0);
  assert.equal(HP.buildCopyIndex([{ id: 'p', slips: null }], 'main').size, 0);
});

test('置いた写しの数（placedCount・livePlaced）：今このノートのハニカムにあるものだけ（新しい順）。記録は消さない', () => {
  const slip = { id: 's1', placed: [{ board: 'main', memoId: 'a', at: atOf(1) }, { board: 'main', memoId: 'b', at: atOf(2) }, { board: 'other', memoId: 'c', at: atOf(3) }, { board: 'main', memoId: 'd', at: atOf(4) }] };
  const ctx = { boardId: 'main', liveIds: new Set(['a', 'c', 'd']) }; // b はゴミ箱など
  assert.equal(HP.placedCount(slip, ctx), 2);
  assert.deepEqual(HP.livePlaced(slip, ctx).map((p) => p.memoId), ['d', 'a']);
  assert.equal(slip.placed.length, 4);
  assert.equal(HP.placedCount({ id: 's2' }, ctx), 0);
});

test('置くときのメモ（recordForPlacing）：番号札・いいね・期限などは無く、コメントの番号札は付け直し（返信の親子は保つ）、時刻は置いた時刻', () => {
  const slip = HP.slipFromMemo(fullRec(), { board: 'main', memoId: 'memo-A' }, NOW);
  const rec = HP.recordForPlacing(slip, '2026-10-07T00:00:00.000Z');
  for (const k of ['id', 'seq', 'children', 'moreLayers', 'due', 'progress', 'likedAt', 'bookmarkedAt']) assert.equal(k in rec, false, k);
  assert.equal(rec.likedLevel, 0);
  assert.equal(rec.bookmarked, false);
  assert.equal(rec.createdAt, '2026-10-07T00:00:00.000Z');
  assert.equal(rec.updatedAt, '2026-10-07T00:00:00.000Z');
  assert.equal(rec.text, slip.rec.text);
  assert.deepEqual(rec.tags, slip.rec.tags);
  assert.deepEqual(rec.images, slip.rec.images);
  assert.equal(rec.cover, slip.rec.cover);
  assert.deepEqual(rec.urls, slip.rec.urls);
  const oldIds = new Set(slip.rec.comments.map((c) => c.id));
  for (const c of rec.comments) assert.equal(oldIds.has(c.id), false);
  const reply = rec.comments.find((c) => c.text === '返信');
  assert.equal(reply.parentId, rec.comments.find((c) => c.text === '最初のコメント').id);
  // 紙片はそのまま（写しなので、置いたメモと中身を共有しない）
  rec.tags.push('足した');
  assert.ok(!slip.rec.tags.includes('足した'));
});

test('元がどこにあるか（originState）：ノートの紙片を先に（ほかのノートでも）・ハニカム・棚（番号札・項目の中）・ゴミ箱・無い・ほかのノート', () => {
  const ctx = {
    boardId: 'main', liveIds: new Set(['hive']), shelfIds: new Set(['onShelf', 'both']), shelfKeys: new Set(['T|棚の項目']),
    trashIds: new Set(['inTrash']), trashShelfKeys: new Set(['T|消した棚の項目']), boardIds: new Set(['main', 'b2']),
  };
  const memo = (memoId, extra = {}) => ({ kind: 'memo', origin: { board: 'main', memoId, where: 'ノート直下（1, 0）', ...extra } });
  // ノートの紙片：そのノートがあれば 'note'（今開いていない別のノートでも。'other' より先）、無ければ 'note-missing'
  assert.equal(HP.originState({ kind: 'note', origin: { board: 'b2' } }, ctx).state, 'note');
  const nm = HP.originState({ kind: 'note', origin: { board: 'gone' } }, ctx);
  assert.equal(nm.state, 'note-missing');
  assert.match(nm.label, /ノートは見つかりません/);
  assert.equal(HP.originState(memo('hive'), ctx).state, 'ok');
  assert.equal(HP.originState(memo('onShelf'), ctx).state, 'shelf');
  assert.equal(HP.originState(memo('both'), { ...ctx, liveIds: new Set(['both']) }).state, 'shelf'); // 棚にもハニカムにもあるときは棚が先
  const tr = HP.originState(memo('inTrash'), ctx);
  assert.equal(tr.state, 'trash');
  assert.match(tr.label, /ゴミ箱にあります/);
  const ms = HP.originState(memo('nowhere'), ctx);
  assert.equal(ms.state, 'missing');
  assert.match(ms.label, /見つかりません（場所：ノート直下（1, 0））/);
  // コメントの紙片は親のメモで判定（コメントだけ消えていても、親があれば灰色にしない）
  assert.equal(HP.originState({ kind: 'comment', origin: { board: 'main', memoId: 'hive', commentId: 'x' } }, ctx).state, 'ok');
  // ほかのノートの紙片：描くときは見ない（'other'）。ノートが無ければ見つからない
  assert.equal(HP.originState({ kind: 'memo', origin: { board: 'b2', memoId: 'z' } }, ctx).state, 'other');
  assert.equal(HP.originState({ kind: 'memo', origin: { board: 'gone', memoId: 'z' } }, ctx).state, 'missing');
  // 元の場所の印が無い紙片
  assert.equal(HP.originState({ kind: 'memo' }, ctx).state, 'missing');
  // 棚のコメントの紙片：棚の項目の番号札で見つかる → 'shelf'、棚から削除した → 'trash'、どこにも無い → 'missing'
  const shelfC = (shelfKey, memoId) => ({ kind: 'comment', origin: { board: 'main', fromShelf: true, shelfKey, ...(memoId ? { memoId } : {}), where: '未配置の棚' } });
  assert.equal(HP.originState(shelfC('T|棚の項目'), ctx).state, 'shelf');
  assert.equal(HP.originState(shelfC('T|消した棚の項目'), ctx).state, 'trash');
  assert.equal(HP.originState(shelfC('T|無い'), ctx).state, 'missing');
  assert.equal(HP.originState(shelfC('T|無い', 'hive'), ctx).state, 'ok'); // 番号札つきでハニカムに置かれた
});

test('ほかのノートを覗いて探す（findMemoInStore）：下の階層・重ねた層・棚（項目の中も）・ゴミ箱。無ければ null', () => {
  const store = {
    memos: {
      '1,0': { id: 'top', text: 'a', children: { memos: { '0,1': { id: 'kid', text: 'b' } } }, moreLayers: [{ memos: { '1,1': { id: 'layer2', text: 'c' } } }] },
    },
    shelf: [{ id: 'shelfTop', text: 'd', children: { memos: { '1,0': { id: 'shelfKid', text: 'e' } } } }],
    trash: [{ id: 't1', from: 'cell', rec: { id: 'gone', text: 'f', children: { memos: { '0,1': { id: 'goneKid', text: 'g' } } } } }],
  };
  assert.deepEqual(HP.findMemoInStore(store, 'top'), { where: 'hive' });
  assert.deepEqual(HP.findMemoInStore(store, 'kid'), { where: 'hive' });
  assert.deepEqual(HP.findMemoInStore(store, 'layer2'), { where: 'hive' });
  assert.deepEqual(HP.findMemoInStore(store, 'shelfKid'), { where: 'shelf' });
  assert.deepEqual(HP.findMemoInStore(store, 'gone'), { where: 'trash' }); // ゴミ箱（切り替えずに言い分ける）
  assert.deepEqual(HP.findMemoInStore(store, 'goneKid'), { where: 'trash' });
  assert.equal(HP.findMemoInStore(store, 'nope'), null);
  assert.equal(HP.findMemoInStore(null, 'top'), null);
  assert.deepEqual([...HP.collectStoredIds(store.memos['1,0'])].sort(), ['kid', 'layer2', 'top']);
});

// ---- 段階3：紙片を直す・並べ替え・名前と色 ----

test('直した紙片（slipEdited）：本文を直した時刻が写した時刻より新しいときだけ。写した直後（メモ・コメント・ノート）は false', () => {
  const memo = HP.slipFromMemo({ text: 'あ', createdAt: T0, updatedAt: T0, comments: [] }, { board: 'main', memoId: 'm1' }, NOW);
  const comment = HP.slipFromComment({ id: 'c1', text: 'こめ', createdAt: T0 }, { text: '親' }, { board: 'main', memoId: 'm1' }, NOW);
  const note = HP.slipFromBoard({ name: 'ノートA', originRec: { text: '原点', createdAt: T0, updatedAt: T0 }, board: 'main' }, NOW);
  for (const s of [memo, comment, note]) assert.equal(HP.slipEdited(s), false, s.kind);
  // 直した：rec.updatedAt を今に（保存の項目は増やさない）
  const later = '2026-10-07T00:00:00.000Z';
  assert.equal(HP.slipEdited({ ...memo, rec: { ...memo.rec, updatedAt: later } }), true);
  assert.equal(HP.slipEdited({ ...memo, rec: { ...memo.rec, updatedAt: NOW } }), false); // 同じ時刻は直していない
  // 読めない時刻・中身が無い
  assert.equal(HP.slipEdited({ ...memo, at: 'x', rec: { ...memo.rec, updatedAt: later } }), false);
  assert.equal(HP.slipEdited({ ...memo, rec: { ...memo.rec, updatedAt: undefined } }), false);
  assert.equal(HP.slipEdited(null), false);
  assert.equal(HP.slipEdited({ at: NOW }), false);
  // 読み込みの整えを通っても、直した印は残る（項目を増やさないので、古い版で保存しても消えない）
  const edited = { ...memo, q: 0, r: 0, rec: { ...memo.rec, text: 'あ（直した）', updatedAt: later } };
  const [p] = norm([{ id: 'p000000000001', name: '区画', slips: [edited], lines: [] }]);
  assert.equal(p.slips[0].rec.text, 'あ（直した）');
  assert.equal(HP.slipEdited(p.slips[0]), true);
});

test('落とし先のセル（cellAtPoint）：セルの中心ならそのセル・遠ければ null・下に1段分の空きまで・帯の外は返さない', () => {
  const W = 100;
  const H = (W * 2) / Math.sqrt(3);
  const center = (q, r) => [(q + r / 2 + 0.5) * W, (0.75 * r + 0.5) * H];
  // 2列・3段（0〜2）＋下の1段（3）：どのセルも中心でそのセル
  for (let r = 0; r <= 3; r++) {
    for (let i = 0; i < HP.COLS; i++) {
      const q = i - Math.floor(r / 2);
      assert.deepEqual(HP.cellAtPoint(...center(q, r), W, HP.COLS, 2), { q, r }, `${q},${r}`);
    }
  }
  // maxRow + 2 の段は返さない（その段の中心は、どのセルからも遠い）
  assert.equal(HP.cellAtPoint(...center(0, 4), W, HP.COLS, 2), null);
  // 中心から少しずれても同じセル。盤の左右の外・上の外は null
  const [x, y] = center(1, 0);
  assert.deepEqual(HP.cellAtPoint(x + 20, y - 15, W, HP.COLS, 0), { q: 1, r: 0 });
  assert.equal(HP.cellAtPoint(-60, y, W, HP.COLS, 0), null);
  assert.equal(HP.cellAtPoint(x + 120, y, W, HP.COLS, 0), null);
  assert.equal(HP.cellAtPoint(x, -70, W, HP.COLS, 0), null);
  // 列数を変えても帯の中だけ
  for (let i = 0; i < 3; i++) assert.deepEqual(HP.cellAtPoint(...center(i, 0), W, 3, 0), { q: i, r: 0 });
  assert.equal(HP.cellAtPoint(...center(3, 0), W, 3, 0), null);
  // 読めない値
  assert.equal(HP.cellAtPoint(NaN, 10, W), null);
  assert.equal(HP.cellAtPoint(10, 10, 0), null);
});

test('並べ替え（moveSlip）：空いたセルへ移動・紙片の上なら入れ替え・同じ場所・無い紙片や帯の外。時刻と中身は変えず、元の配列も変えない', () => {
  const a = { id: sid(1), kind: 'memo', q: 0, r: 0, at: atOf(1), rec: { text: 'あ', updatedAt: T0 } };
  const b = { id: sid(2), kind: 'memo', q: 1, r: 0, at: atOf(2), rec: { text: 'い', updatedAt: T0 } };
  const c = { id: sid(3), kind: 'note', q: 0, r: 1, at: atOf(3), rec: { text: 'う', updatedAt: T0 } };
  const list = [a, b, c];
  const snapshot = JSON.stringify(list);
  // 移動
  const moved = HP.moveSlip(list, a.id, { q: 1, r: 1 });
  assert.equal(moved.kind, 'move');
  assert.deepEqual(moved.slips.map((s) => [s.q, s.r]), [[1, 1], [1, 0], [0, 1]]);
  assert.equal(moved.slips[1], b); // 動かしていない紙片は同じもの
  // 入れ替え
  const swapped = HP.moveSlip(list, a.id, { q: 0, r: 1 });
  assert.equal(swapped.kind, 'swap');
  assert.deepEqual(swapped.slips.map((s) => [s.q, s.r]), [[0, 1], [1, 0], [0, 0]]);
  // どれも時刻・中身は変えない・重ならない
  for (const res of [moved, swapped]) {
    res.slips.forEach((s, n) => {
      assert.equal(s.at, list[n].at);
      assert.equal(s.rec, list[n].rec);
      assert.equal(s.id, list[n].id);
    });
    assert.equal(new Set(res.slips.map((s) => `${s.q},${s.r}`)).size, list.length);
  }
  // 同じ場所・無い紙片・帯の外（列の外・上の外・読めない座標）は、渡した配列のまま
  assert.deepEqual(HP.moveSlip(list, a.id, { q: 0, r: 0 }), { kind: 'same', slips: list });
  assert.equal(HP.moveSlip(list, 'nope', { q: 1, r: 1 }).kind, 'invalid');
  for (const to of [{ q: 2, r: 0 }, { q: 0, r: -1 }, { q: -1, r: 1 }, { q: 0.5, r: 0 }, null]) assert.equal(HP.moveSlip(list, a.id, to).kind, 'invalid', JSON.stringify(to));
  // 元の配列は変わっていない
  assert.equal(JSON.stringify(list), snapshot);
});

test('区画の名前と色の整え（normalizeName・normalizeColor）：空・空白だけは「区画」・40字まで・空白はつめる／色は #rrggbb だけ（小文字に）', () => {
  assert.equal(HP.normalizeName(''), '区画');
  assert.equal(HP.normalizeName('   '), '区画');
  assert.equal(HP.normalizeName(null), '区画');
  assert.equal(HP.normalizeName('  企画  A  '), '企画 A');
  assert.equal(HP.normalizeName('あ'.repeat(41)), 'あ'.repeat(40));
  assert.equal(HP.normalizeColor('#A78BFA'), '#a78bfa');
  assert.equal(HP.normalizeColor(' #00ba7c '), '#00ba7c');
  for (const bad of ['#fff', 'red', 123, null, '', '#12345g']) assert.equal(HP.normalizeColor(bad), null, String(bad));
});

test('落とし先のセル（cellAtPoint）：角の先の近く（中心から 0.56·cellW）も、そのセル', () => {
  const W = 100;
  const H = (W * 2) / Math.sqrt(3);
  // (0,0) の上の角の少し内側（中心の真上 0.56·cellW）・下の角の少し内側
  const cx = 0.5 * W;
  const cy = 0.5 * H;
  assert.deepEqual(HP.cellAtPoint(cx, cy - 0.56 * W, W, HP.COLS, 0), { q: 0, r: 0 });
  assert.deepEqual(HP.cellAtPoint(cx, cy + 0.56 * W, W, HP.COLS, 1), { q: 0, r: 0 });
});

// ---- 07：紙片に足したコメント ----

test('写したあとに書いたコメント（slipCommentAdded・slipAddedComments）：写した直後は 0。写した時刻より新しいコメントだけ数える', () => {
  const memo = HP.slipFromMemo({ text: 'あ', createdAt: T0, updatedAt: T0, comments: [{ id: 'c0', text: '元', createdAt: T0 }] }, { board: 'main', memoId: 'm1' }, NOW);
  const comment = HP.slipFromComment({ id: 'c1', text: 'こめ', createdAt: T0 }, { text: '親' }, { board: 'main', memoId: 'm1' }, NOW);
  const note = HP.slipFromBoard({ name: 'ノートA', originRec: { text: '原点', createdAt: T0, updatedAt: T0 }, board: 'main' }, NOW);
  for (const s of [memo, comment, note]) assert.equal(HP.slipAddedComments(s), 0, s.kind);
  const later = '2026-10-07T00:00:00.000Z';
  const added = (s, list) => ({ ...s, rec: { ...s.rec, comments: [...s.rec.comments, ...list] } });
  const m2 = added(memo, [{ id: 'n1', text: '足した', createdAt: later }, { id: 'n2', text: '同じ時刻', createdAt: NOW }, { id: 'n3', text: '読めない', createdAt: 'x' }]);
  assert.equal(HP.slipAddedComments(m2), 1); // 写した時刻と同じ・読めない時刻は数えない
  assert.equal(HP.slipCommentAdded(m2, m2.rec.comments[0]), false); // 写してきたコメント
  assert.equal(HP.slipCommentAdded(m2, m2.rec.comments[1]), true);
  assert.equal(HP.slipCommentAdded({ ...m2, at: 'x' }, m2.rec.comments[1]), false);
  assert.equal(HP.slipAddedComments({ at: NOW, rec: {} }), 0);
  assert.equal(HP.slipAddedComments(null), 0);
  // 足したコメントでは「直した紙片」にならない（rec.updatedAt は変えない）
  assert.equal(HP.slipEdited(m2), false);
  // 読み込みの整えを通しても、足したコメントは残り、数も同じ（項目を増やしていないので、古い版で保存しても消えない）
  const [p] = norm([{ id: 'p000000000001', name: '区画', slips: [{ ...m2, q: 0, r: 0 }], lines: [] }]);
  assert.deepEqual(p.slips[0].rec.comments.map((c) => c.text), ['元', '足した', '同じ時刻', '読めない']);
  assert.equal(HP.slipAddedComments(p.slips[0]), 1); // 読めない時刻は読み込んだ時刻（ここでは写した時刻と同じ）になるので数えない
});

test('本文が空でコメントだけの紙片は空ではなく、最後のコメントを除くと空になる（消すときに「紙片を外しますか？」と聞く根拠）', () => {
  const rec = { text: '', comments: [{ id: 'c1', text: 'のこり', createdAt: NOW }] };
  assert.equal(HP.isBlankSlip(rec), false);
  assert.equal(HP.isBlankSlip({ ...rec, comments: [] }), true);
  assert.equal(HP.isBlankSlip({ ...rec, comments: [], tags: ['a'] }), false); // タグがあれば空ではない
});
