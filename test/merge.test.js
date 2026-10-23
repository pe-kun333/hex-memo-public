'use strict';

// ほかのウィンドウ・ほかのメモアプリの変更との合わせ方（renderer.js の mergeStores など）。
// 画面のスクリプトの中にあるので、その部分を取り出してそのまま動かす
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const HS = require('../send.js');
const HP = require('../pocket.js');

function loadMerge() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'renderer.js'), 'utf8');
  const start = src.indexOf('  // 表示位置（camera）は比べない。キーの順番も揃える');
  const end = src.indexOf('  // 関連付け：あちらの一覧に');
  const linksStart = src.indexOf('  function mergeLinks(');
  const linksEnd = src.indexOf('  // 保存を断られた');
  assert.ok(start > 0 && end > start && linksStart > 0 && linksEnd > linksStart, '合わせ方の部分が見つからない');
  const code = src.slice(start, end) + src.slice(linksStart, linksEnd);
  // eslint-disable-next-line no-new-func
  return new Function('HS', 'HP', 'CENTER_KEY', `${code}; return { mergeStores, mergePockets };`)(HS, HP, '0,0');
}

const { mergeStores, mergePockets } = loadMerge();
const rec = (text, createdAt, extra = {}) => ({ text, createdAt, updatedAt: createdAt, likedLevel: 0, liked: false, bookmarked: false, comments: [], ...extra });
const st = (memos) => ({ version: 2, camera: { x: 0, y: 0 }, memos });
const texts = (s) => Object.fromEntries(Object.entries(s.memos).map(([k, r]) => [k, r.text]));

test('合わせ方：片方だけの変更・足したメモ・両方が書き換えたマス（これまでどおり）', () => {
  const base = st({ '1,0': rec('x', 't0') });
  assert.deepEqual(texts(mergeStores(base, st({ '1,0': rec('x2', 't0') }), base)), { '1,0': 'x2' });
  assert.deepEqual(texts(mergeStores(base, base, st({ '1,0': rec('x', 't0'), '0,1': rec('y', 't3') }))), { '1,0': 'x', '0,1': 'y' });
  assert.deepEqual(texts(mergeStores(base, st({ '1,0': rec('L', 't0') }), st({ '1,0': rec('R', 't0') }))), { '1,0': 'L' });
  assert.deepEqual(texts(mergeStores(base, st({}), base)), {}); // こちらが消した
});

test('合わせ方：同じ空きマスに別々の新しいメモ → どちらも残す（あちらを隣へ）。書き続けても消えない・二重にならない', () => {
  const MA = rec('A', 't1');
  const MB = rec('B', 't2');
  const rev6 = st({ '1,0': MA });
  const b1 = mergeStores(st({}), st({ '1,0': MB }), rev6);
  assert.deepEqual(texts(b1), { '1,0': 'B', '2,-1': 'A' });
  // A は MA を書き続けていた：A の側で合わせても、B のメモは消えず、A のメモも1つだけ
  const MA2 = { ...MA, text: 'A more' };
  const a2 = mergeStores(rev6, st({ '1,0': MA2 }), b1);
  assert.equal(texts(a2)['1,0'], 'A more');
  assert.deepEqual(Object.values(texts(a2)).sort(), ['A more', 'B']);
  // B の側（ずらしたのはこちら・まだ保存していない）で、A の続きが届く
  const b2 = mergeStores(rev6, b1, st({ '1,0': MA2 }));
  assert.deepEqual(texts(b2), { '1,0': 'B', '2,-1': 'A more' });
});

test('合わせ方：下の階層の中では、ずらす先に中心 (0,0) を使わない', () => {
  const layer = (memos) => st({ '5,5': rec('親', 't0', { children: { camera: { x: 0, y: 0 }, memos } }) });
  // (1,-1) がぶつかる。その周りは右上から時計回りに (2,-2)・(2,-1)・(1,0)・(0,0)… の順に探すので、
  // 前の3つを埋めておき、次の候補が中心 (0,0) になるようにする
  const near = { '2,-2': rec('a', 't0'), '2,-1': rec('b', 't0'), '1,0': rec('c', 't0') };
  const base = layer({ ...near });
  const local = layer({ ...near, '1,-1': rec('こちら', 't5') });
  const remote = layer({ ...near, '1,-1': rec('あちら', 't6') });
  const m = mergeStores(base, local, remote).memos['5,5'].children.memos;
  assert.equal(m['1,-1'].text, 'こちら');
  assert.equal(m['0,0'], undefined);
  assert.equal(Object.values(m).filter((r) => r.text === 'あちら').length, 1);
  assert.equal(m['0,-1'].text, 'あちら'); // 中心を飛ばして、その次の空き（時計回りで次の (0,-1)）
  // ノート直下（下の階層ではない）なら、原点 (0,0) もふつうのマス
  const rootBase = st({ ...near });
  const root = mergeStores(rootBase, st({ ...near, '1,-1': rec('こちら', 't5') }), st({ ...near, '1,-1': rec('あちら', 't6') }));
  assert.equal(root.memos['0,0'].text, 'あちら');
});

test('合わせ方：送られてきた写しの入れ物（本文の無い原点）と、こちらで書いた原点は、1つにまとめる', () => {
  const container = rec('', 't9', { children: { camera: { x: 0, y: 0 }, memos: { '1,-1': rec('届いた', 't9') } } });
  const m = mergeStores(st({}), st({ '0,0': rec('原点を書いた', 't8') }), st({ '0,0': container }));
  assert.deepEqual(Object.keys(m.memos), ['0,0']);
  assert.equal(m.memos['0,0'].text, '原点を書いた');
  assert.deepEqual(Object.values(m.memos['0,0'].children.memos).map((r) => r.text), ['届いた']);
});

// ---- 未配置の棚：番号札（shelfKeyOf：ID か「作った時刻＋本文」）で見分ける ----

test('棚：ID の無い2件（作った時刻が同じで本文が違う）は、合わせたあとも別物として2件残る', () => {
  const withShelf = (shelf) => ({ ...st({}), shelf });
  const m = mergeStores(withShelf([]), withShelf([rec('あ', 't1')]), withShelf([rec('い', 't1')]));
  assert.deepEqual(m.shelf.map((r) => r.text).sort(), ['あ', 'い']);
});

test('棚：片方のウィンドウで1件にコメントを足し、もう片方で別の1件を消す → コメントは残り、消した1件は消える', () => {
  const withShelf = (shelf) => ({ ...st({}), shelf });
  const A = rec('あ', 't1');
  const B = rec('い', 't2');
  const A2 = { ...A, comments: [{ id: 'c1', text: 'コメント', createdAt: 't3' }] };
  const m = mergeStores(withShelf([A, B]), withShelf([A2, B]), withShelf([A]));
  assert.deepEqual(m.shelf.map((r) => r.text), ['あ']);
  assert.deepEqual(m.shelf[0].comments.map((c) => c.text), ['コメント']);
});

// ---- 区画（写しの作業台）：区画ごと → 紙片ごと。置いた記録は和、最初の区画の二重は1枚に ----

const slip = (id, q, r, at, text, extra = {}) => ({ id, kind: 'memo', q, r, at, rec: rec(text, 't0'), ...extra });
const pocket = (id, slips, extra = {}) => ({ id, name: '区画', createdAt: 't1', updatedAt: 't1', slips, lines: [], ...extra });
const withPockets = (pockets) => ({ ...st({}), pockets });
const slipTexts = (p) => p.slips.map((s) => s.rec.text).sort();
const S1 = 's0000000000000001';
const S2 = 's0000000000000002';
const S3 = 's0000000000000003';
const P1 = 'p000000000001';
const P2 = 'p000000000002';

test('区画：別々に足した紙片は両方残る。こちらで外した紙片は消える。名前はこちらが変えていればこちら', () => {
  const base = pocket(P1, [slip(S1, 0, 0, 't1', 'あ')]);
  const local = pocket(P1, [slip(S2, 1, 0, 't2', 'い')], { name: '考え中' }); // あ を外し、い を足した
  const remote = pocket(P1, [slip(S1, 0, 0, 't1', 'あ'), slip(S3, 0, 1, 't3', 'う')]);
  const [m] = mergeStores(withPockets([base]), withPockets([local]), withPockets([remote])).pockets;
  assert.deepEqual(slipTexts(m), ['い', 'う']);
  assert.equal(m.name, '考え中');
});

test('区画：両方が同じセルに紙片を足した → 両方残り、写した時刻の遅いほうが空いたセルへずれる', () => {
  const base = pocket(P1, [slip(S1, 0, 0, 't1', 'あ')]);
  const local = pocket(P1, [slip(S1, 0, 0, 't1', 'あ'), slip(S2, 1, 0, 't3', 'こちら')]);
  const remote = pocket(P1, [slip(S1, 0, 0, 't1', 'あ'), slip(S3, 1, 0, 't2', 'あちら')]);
  const [m] = mergePockets([base], [local], [remote]);
  const at = (text) => m.slips.find((s) => s.rec.text === text);
  assert.deepEqual([at('あちら').q, at('あちら').r], [1, 0]); // 早く写したほうが残る
  assert.notDeepEqual([at('こちら').q, at('こちら').r], [1, 0]);
  assert.equal(new Set(m.slips.map((s) => `${s.q},${s.r}`)).size, 3);
});

test('区画：同じ紙片の置いた記録（placed）は、こちらとあちらの和になる（重複は1つ）', () => {
  const placed = (memoId, at) => ({ board: 'main', memoId, at });
  const base = pocket(P1, [slip(S1, 0, 0, 't1', 'あ', { placed: [placed('m0', '2026-10-01T00:00:00.000Z')] })]);
  const local = pocket(P1, [slip(S1, 0, 0, 't1', 'あ', { placed: [placed('m0', '2026-10-01T00:00:00.000Z'), placed('mL', '2026-10-02T00:00:00.000Z')] })]);
  const remote = pocket(P1, [slip(S1, 0, 0, 't1', 'あ', { placed: [placed('m0', '2026-10-01T00:00:00.000Z'), placed('mR', '2026-10-03T00:00:00.000Z')] })]);
  const [m] = mergePockets([base], [local], [remote]);
  assert.deepEqual(m.slips[0].placed.map((p) => p.memoId), ['m0', 'mL', 'mR']);
});

test('区画：両方のウィンドウが同時に「最初の区画」を作った → 1枚にまとまり、両方の紙片が残る（早く作ったほうの番号）', () => {
  const local = pocket(P2, [slip(S1, 0, 0, 't2', 'こちら')], { createdAt: '2026-10-02T00:00:00.000Z' });
  const remote = pocket(P1, [slip(S2, 0, 0, 't3', 'あちら')], { createdAt: '2026-10-01T00:00:00.000Z' });
  const m = mergeStores(st({}), withPockets([local]), withPockets([remote])).pockets;
  assert.equal(m.length, 1);
  assert.equal(m[0].id, P1);
  assert.deepEqual(slipTexts(m[0]), ['あちら', 'こちら']);
  assert.equal(new Set(m[0].slips.map((s) => `${s.q},${s.r}`)).size, 2);
});

test('区画：こちらで紙片を全部外した（空の区画は保存に書かれない）間に、あちらが1枚足した → あちらの1枚だけ残る', () => {
  const base = pocket(P1, [slip(S1, 0, 0, 't1', 'あ')]);
  const remote = pocket(P1, [slip(S1, 0, 0, 't1', 'あ'), slip(S2, 1, 0, 't2', 'い')]);
  const m = mergeStores(withPockets([base]), st({}), withPockets([remote])).pockets;
  assert.deepEqual(m.map(slipTexts), [['い']]);
  // 逆：あちらが全部外した間に、こちらが1枚足した → こちらの1枚だけ
  const m2 = mergeStores(withPockets([base]), withPockets([pocket(P1, [slip(S1, 0, 0, 't1', 'あ'), slip(S3, 1, 0, 't3', 'う')])]), st({})).pockets;
  assert.deepEqual(m2.map(slipTexts), [['う']]);
});

test('区画：線は両端の組ごと。外した紙片の線は残らない', () => {
  const line = (a, b) => ({ a, b, createdAt: 't1' });
  const base = pocket(P1, [slip(S1, 0, 0, 't1', 'あ'), slip(S2, 1, 0, 't1', 'い')], { lines: [line(S1, S2)] });
  const local = pocket(P1, [slip(S1, 0, 0, 't1', 'あ')], { lines: [] }); // い を外した（線も一緒に）
  const remote = pocket(P1, [slip(S1, 0, 0, 't1', 'あ'), slip(S2, 1, 0, 't1', 'い'), slip(S3, 0, 1, 't2', 'う')], { lines: [line(S1, S2), line(S3, S1)] });
  const [m] = mergePockets([base], [local], [remote]);
  assert.deepEqual(slipTexts(m), ['あ', 'う']);
  assert.deepEqual(m.lines.map((x) => [x.a, x.b]), [[S3, S1]]);
});

test('区画：どちらにも区画が無ければ pockets を付けない（今までのファイルと同じ形）', () => {
  assert.equal('pockets' in mergeStores(st({}), st({}), st({})), false);
  assert.deepEqual(mergePockets(undefined, undefined, undefined), []);
});

test('ほかのウィンドウの内容を合わせる形（rendererForm）は、ノート直下だけが持つもの（棚・ゴミ箱・区画など）も通す', () => {
  // rendererForm は画面の多くの部品に頼るので切り出さない。通していないと、あちらの棚・区画が合わせた結果から落ちる（04 で直した穴）
  const src = fs.readFileSync(path.join(__dirname, '..', 'renderer.js'), 'utf8');
  const body = src.slice(src.indexOf('  function rendererForm('), src.indexOf('  // 表示位置（camera）は比べない。キーの順番も揃える'));
  assert.match(body, /attachRootExtras\(root, copy\)/);
  // あちらにだけ棚・区画があり、こちらは触っていない → 残る
  const remote = { ...st({}), shelf: [rec('棚', 't1')], pockets: [pocket(P1, [slip(S1, 0, 0, 't1', 'あ')])] };
  const m = mergeStores(st({}), st({}), remote);
  assert.deepEqual(m.shelf.map((r) => r.text), ['棚']);
  assert.deepEqual(m.pockets.map(slipTexts), [['あ']]);
});

test('区画：二重をまとめた直後に、まとめられた側のウィンドウが紙片を足していても、区画は1枚のまま（どの紙片も残る）', () => {
  // A が PA（早く作った）・B が PB を作り、A の合わせ方で PA{SA,SB} の1枚になった。B は PB{SB} を前の内容として覚えたまま SB2 を足していた
  const PA = pocket(P1, [slip(S1, 0, 0, 't1', 'あ'), slip(S2, 1, 0, 't2', 'い')], { createdAt: '2026-10-01T00:00:00.000Z' });
  const baseB = pocket(P2, [slip(S2, 0, 0, 't2', 'い')], { createdAt: '2026-10-02T00:00:00.000Z' });
  const localB = pocket(P2, [slip(S2, 0, 0, 't2', 'い'), slip(S3, 1, 0, 't3', 'う')], { createdAt: '2026-10-02T00:00:00.000Z' });
  const m = mergePockets([baseB], [localB], [PA]);
  assert.equal(m.length, 1);
  assert.equal(m[0].id, P1);
  assert.deepEqual(slipTexts(m[0]), ['あ', 'い', 'う']);
  assert.equal(new Set(m[0].slips.map((s) => `${s.q},${s.r}`)).size, 3);
  // 名前を付けた区画（段階3）は、勝手にまとめない
  const named = mergePockets([baseB], [localB], [{ ...PA, name: '考え中' }]);
  assert.equal(named.length, 2);
});

test('区画：合わせて 200 枚を超えたら、写した時刻の新しいものから落として 200 枚（保存のときの整えと同じ）', () => {
  const at = (i) => `2026-10-01T00:00:${String(i).padStart(2, '0')}.${String(i).padStart(3, '0')}Z`;
  const many = Array.from({ length: 199 }, (_, i) => slip(`s${String(i + 10).padStart(16, '0')}`, null, null, `2026-09-01T00:00:00.${String(i).padStart(3, '0')}Z`, `紙片${i}`));
  const base = pocket(P1, HP.settleSlips(many));
  const local = pocket(P1, [...base.slips, slip(S1, 0, 200, at(1), 'こちら')]);
  const remote = pocket(P1, [...base.slips, slip(S2, 0, 201, at(2), 'あちら')]);
  const [m] = mergePockets([base], [local], [remote]);
  assert.equal(m.slips.length, HP.MAX_SLIPS);
  assert.ok(m.slips.some((s) => s.rec.text === 'こちら'));
  assert.ok(!m.slips.some((s) => s.rec.text === 'あちら')); // いちばん新しく写した1枚が落ちる
});

test('区画 段階3：片方で紙片の本文を直し、もう片方で同じ紙片を動かした → 直した文も動いた位置も残る（どちらの側で合わせても）', () => {
  const base = pocket(P1, [slip(S1, 0, 0, 't1', 'あ'), slip(S2, 1, 0, 't2', 'い')]);
  const edited = pocket(P1, [slip(S1, 0, 0, 't1', 'あ（直した）'), slip(S2, 1, 0, 't2', 'い')]);
  const moved = pocket(P1, [slip(S1, 1, 1, 't1', 'あ'), slip(S2, 1, 0, 't2', 'い')]);
  for (const [local, remote] of [[edited, moved], [moved, edited]]) {
    const [m] = mergePockets([base], [local], [remote]);
    const s = m.slips.find((x) => x.id === S1);
    assert.equal(s.rec.text, 'あ（直した）');
    assert.deepEqual([s.q, s.r], [1, 1]);
  }
});

test('区画 段階3：本文はこちらだけ直した → こちら、あちらだけ → あちら、両方 → こちら（今までどおり）。入れ替えた2枚の位置も合う', () => {
  const base = pocket(P1, [slip(S1, 0, 0, 't1', 'あ'), slip(S2, 1, 0, 't2', 'い')]);
  const mine = pocket(P1, [slip(S1, 0, 0, 't1', 'こちら'), slip(S2, 1, 0, 't2', 'い')]);
  const theirs = pocket(P1, [slip(S1, 0, 0, 't1', 'あちら'), slip(S2, 1, 0, 't2', 'い')]);
  const text = (m) => m.slips.find((x) => x.id === S1).rec.text;
  assert.equal(text(mergePockets([base], [mine], [base])[0]), 'こちら');
  assert.equal(text(mergePockets([base], [base], [theirs])[0]), 'あちら');
  assert.equal(text(mergePockets([base], [mine], [theirs])[0]), 'こちら');
  // あちらで2枚を入れ替え、こちらで い の本文を直した → 入れ替えた位置で、い は直した文
  const swapped = pocket(P1, [slip(S1, 1, 0, 't1', 'あ'), slip(S2, 0, 0, 't2', 'い')]);
  const editedI = pocket(P1, [slip(S1, 0, 0, 't1', 'あ'), slip(S2, 1, 0, 't2', 'い（直した）')]);
  const [m] = mergePockets([base], [editedI], [swapped]);
  const at = (id) => m.slips.find((x) => x.id === id);
  assert.deepEqual([at(S1).q, at(S1).r], [1, 0]);
  assert.deepEqual([at(S2).q, at(S2).r], [0, 0]);
  assert.equal(at(S2).rec.text, 'い（直した）');
});

test('区画 段階3：位置と中身を分けても、置いた記録は和のまま・こちらで外した紙片は消える・名前と色は別々のウィンドウで変えても両方残る', () => {
  const placed = (memoId, at) => ({ board: 'main', memoId, at });
  const base = pocket(P1, [slip(S1, 0, 0, 't1', 'あ'), slip(S2, 1, 0, 't2', 'い')]);
  const local = pocket(P1, [slip(S1, 0, 1, 't1', 'あ', { placed: [placed('mL', '2026-10-02T00:00:00.000Z')] })], { name: '企画B' }); // い を外し、あ を動かした
  const remote = pocket(P1, [slip(S1, 0, 0, 't1', 'あ（直した）', { placed: [placed('mR', '2026-10-03T00:00:00.000Z')] }), slip(S2, 1, 0, 't2', 'い')], { color: '#1d9bf0' });
  const [m] = mergePockets([base], [local], [remote]);
  assert.deepEqual(m.slips.map((s) => s.id), [S1]);
  assert.equal(m.slips[0].rec.text, 'あ（直した）');
  assert.deepEqual([m.slips[0].q, m.slips[0].r], [0, 1]);
  assert.deepEqual(m.slips[0].placed.map((p) => p.memoId), ['mL', 'mR']);
  assert.equal(m.name, '企画B');
  assert.equal(m.color, '#1d9bf0');
});

test('区画 段階3：同じ紙片を両方のウィンドウで別のセルへ動かした → こちらの位置（中身はそのまま）', () => {
  const base = pocket(P1, [slip(S1, 0, 0, 't1', 'あ'), slip(S2, 1, 0, 't2', 'い')]);
  const local = pocket(P1, [slip(S1, 1, 1, 't1', 'あ'), slip(S2, 1, 0, 't2', 'い')]);
  const remote = pocket(P1, [slip(S1, 0, 1, 't1', 'あ'), slip(S2, 1, 0, 't2', 'い')]);
  const [m] = mergePockets([base], [local], [remote]);
  const s = m.slips.find((x) => x.id === S1);
  assert.deepEqual([s.q, s.r], [1, 1]);
  assert.equal(s.rec.text, 'あ');
  assert.equal(new Set(m.slips.map((x) => `${x.q},${x.r}`)).size, 2);
});

test('区画 段階3：あちらで外した紙片を、こちらで直していた → 直した文のまま残る（直していなければ消える）', () => {
  const base = pocket(P1, [slip(S1, 0, 0, 't1', 'あ'), slip(S2, 1, 0, 't2', 'い')]);
  const local = pocket(P1, [slip(S1, 0, 0, 't1', 'あ（直した）'), slip(S2, 1, 0, 't2', 'い')]);
  const remote = pocket(P1, [slip(S2, 1, 0, 't2', 'い')]);
  const [m] = mergePockets([base], [local], [remote]);
  assert.deepEqual(m.slips.map((x) => x.rec.text).sort(), ['あ（直した）', 'い']);
  const [m2] = mergePockets([base], [base], [remote]);
  assert.deepEqual(m2.slips.map((x) => x.rec.text), ['い']);
});

// ---- 07：紙片のコメントは番号札ごとに合わせる ----
const cm = (id, text, extra = {}) => ({ id, text, createdAt: 't5', ...extra });
const withComments = (sl, comments) => ({ ...sl, rec: { ...sl.rec, comments } });
const commentTexts = (m, id) => m.slips.find((x) => x.id === id).rec.comments.map((c) => c.text).sort();

test('区画 07：同じ紙片に、こちらとあちらで別々にコメントを足した → 両方残る（どちらの側で合わせても）', () => {
  const base = pocket(P1, [slip(S1, 0, 0, 't1', 'あ')]);
  const mine = pocket(P1, [withComments(slip(S1, 0, 0, 't1', 'あ'), [cm('cL', 'こちら')])]);
  const theirs = pocket(P1, [withComments(slip(S1, 0, 0, 't1', 'あ'), [cm('cR', 'あちら')])]);
  for (const [l, r] of [[mine, theirs], [theirs, mine]]) {
    const [m] = mergePockets([base], [l], [r]);
    assert.deepEqual(commentTexts(m, S1), ['あちら', 'こちら']);
  }
});

test('区画 07：こちらで写したコメントを消し、あちらが別のコメントを足した → 消したものは消え、足したものは残る。両方が同じコメントを消したら消える', () => {
  const base = pocket(P1, [withComments(slip(S1, 0, 0, 't1', 'あ'), [cm('c0', '写した')])]);
  const mine = pocket(P1, [withComments(slip(S1, 0, 0, 't1', 'あ'), [])]);
  const theirs = pocket(P1, [withComments(slip(S1, 0, 0, 't1', 'あ'), [cm('c0', '写した'), cm('cR', 'あちら')])]);
  const [m] = mergePockets([base], [mine], [theirs]);
  assert.deepEqual(commentTexts(m, S1), ['あちら']);
  const [m2] = mergePockets([base], [mine], [mine]);
  assert.deepEqual(commentTexts(m2, S1), []);
});

test('区画 07：こちらで本文を直し、あちらでコメントを足した → 直した文もコメントも残る（逆も）', () => {
  const base = pocket(P1, [slip(S1, 0, 0, 't1', 'あ')]);
  const edited = pocket(P1, [slip(S1, 0, 0, 't1', 'あ（直した）')]);
  const commented = pocket(P1, [withComments(slip(S1, 0, 0, 't1', 'あ'), [cm('cR', 'あちら')])]);
  for (const [l, r] of [[edited, commented], [commented, edited]]) {
    const [m] = mergePockets([base], [l], [r]);
    const s = m.slips.find((x) => x.id === S1);
    assert.equal(s.rec.text, 'あ（直した）');
    assert.deepEqual(s.rec.comments.map((c) => c.text), ['あちら']);
  }
});

test('区画 07：こちらで親のコメントを消し、あちらがその親に返信を足した → 返信は残り、親の番号札は外れる', () => {
  const base = pocket(P1, [withComments(slip(S1, 0, 0, 't1', 'あ'), [cm('p1', '親')])]);
  const mine = pocket(P1, [withComments(slip(S1, 0, 0, 't1', 'あ'), [])]);
  const theirs = pocket(P1, [withComments(slip(S1, 0, 0, 't1', 'あ'), [cm('p1', '親'), cm('k1', '返信', { parentId: 'p1' })])]);
  const [m] = mergePockets([base], [mine], [theirs]);
  const list = m.slips.find((x) => x.id === S1).rec.comments;
  assert.deepEqual(list.map((c) => c.text), ['返信']);
  assert.equal('parentId' in list[0], false);
});

test('区画 07：あちらで紙片ごと外し、こちらでコメントを足した → 紙片は残る（今までどおり）', () => {
  const base = pocket(P1, [slip(S1, 0, 0, 't1', 'あ'), slip(S2, 1, 0, 't2', 'い')]);
  const mine = pocket(P1, [withComments(slip(S1, 0, 0, 't1', 'あ'), [cm('cL', 'こちら')]), slip(S2, 1, 0, 't2', 'い')]);
  const theirs = pocket(P1, [slip(S2, 1, 0, 't2', 'い')]);
  const [m] = mergePockets([base], [mine], [theirs]);
  assert.deepEqual(commentTexts(m, S1), ['こちら']);
});
