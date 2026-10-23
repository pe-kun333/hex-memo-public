'use strict';

// 配置ヒント（AI が書いた、メモの大まかな置き場所）の計算（renderer.js）。
// 画面のスクリプトの中にあるので、印のコメントの間をそのまま取り出して動かす（graph-lock.test.js と同じやり方）。
// 力学・流れの配置そのもの（gStep・gLayoutFlow）は画面の状態に依るので、ここでは見ず、ブラウザで確かめる（docs/plan-layout-hints.md）
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'renderer.js'), 'utf8');
const start = SRC.indexOf('  // ---- 配置ヒント（AI が書いた、メモの大まかな置き場所）の計算 ----');
const end = SRC.indexOf('  // ---- 配置ヒントの計算 ここまで ----');
assert.ok(start > 0 && end > start, '配置ヒントの計算の部分が見つからない');
// eslint-disable-next-line no-new-func
const H = new Function(`${SRC.slice(start, end)}; return { HINT_K, HINT_RING, HINT_BOX, HINT_SMALL_N, HINT_PER_NODE, HINT_SCALE_MAX, HINT_HUB_BOOST, HINT_OUTER_BOOST, HINT_INHERIT_W, HINT_SEED_R, HINT_SEED_GAP, HINT_ALIGN_DEG, hintOf, hintGoal, hintPull, hintCentroids, hintOrder, hintRadius, hintIsHub, hintBoost, hintInherit, hintCells, hintSeed, hintCounts, hintPlaced, hintReportText, hintPlacedText, hintPinFromPos, hintWritePins, hintRequestText };`)();

const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-6, `${actual} は ${expected} ではない`);
const nearPair = (actual, expected) => {
  near(actual[0], expected[0]);
  near(actual[1], expected[1]);
};

test('ヒントの読み取り：ヒントが無ければ null。ID で引く。タグ Grok は grokOuter のとき外側（個別の zone が勝つ）', () => {
  const rec = (id, extra = {}) => ({ id, text: '', ...extra });
  assert.equal(H.hintOf(null, rec('a1')), null);
  assert.equal(H.hintOf({ nodes: { a1: { zone: 'left' } } }, null), null);
  assert.deepEqual(H.hintOf({ nodes: { a1: { zone: 'left' } } }, rec('a1')), { zone: 'left' });
  assert.equal(H.hintOf({ nodes: { a1: { zone: 'left' } } }, rec('a2')), null); // 無い ID
  assert.equal(H.hintOf({ nodes: { a1: { zone: 'left' } } }, rec(undefined)), null); // ID の無いメモ
  // 'constructor' などの名前は、ヒントとして読まない（Object の中の名前を拾わない）
  assert.equal(H.hintOf({ nodes: {} }, rec('constructor')), null);
  // grokOuter：タグ Grok（大文字小文字そのまま）のメモは outer。ヒントの無いメモ（ID 無し）でも
  assert.deepEqual(H.hintOf({ grokOuter: true }, rec(undefined, { tags: ['Grok'] })), { zone: 'outer' });
  assert.deepEqual(H.hintOf({ grokOuter: true, nodes: { a1: { zone: 'left' } } }, rec('a1', { tags: ['Grok'] })), { zone: 'left' });
  assert.deepEqual(H.hintOf({ grokOuter: true, nodes: { a1: { weight: 1 } } }, rec('a1', { tags: ['Grok'] })), { weight: 1, zone: 'outer' });
  assert.equal(H.hintOf({ grokOuter: true }, rec('a1', { tags: ['grok'] })), null);
  assert.equal(H.hintOf({ grokOuter: false }, rec('a1', { tags: ['Grok'] })), null);
});

test('目標点：pin は原点中心の正方形の比率の点（pin が zone より優先）', () => {
  const B = H.HINT_BOX;
  nearPair(H.hintGoal({ pin: { x: 0, y: 0 } }, { x: 999, y: 999 }), [-B, -B]);
  nearPair(H.hintGoal({ pin: { x: 1, y: 1 } }, { x: 0, y: 0 }), [B, B]);
  nearPair(H.hintGoal({ pin: { x: 0.5, y: 0.5 } }, { x: 0, y: 0 }), [0, 0]);
  nearPair(H.hintGoal({ pin: { x: 0.5, y: 0.5 }, zone: 'left' }, { x: 0, y: 0 }), [0, 0]);
});

test('目標点：zone は原点から方向へ（center は原点・outer は今の向きの外側。原点にいれば右）', () => {
  const R = H.HINT_RING;
  nearPair(H.hintGoal({ zone: 'center' }, { x: 50, y: 50 }), [0, 0]);
  nearPair(H.hintGoal({ zone: 'left' }, { x: 0, y: 0 }), [-R, 0]);
  nearPair(H.hintGoal({ zone: 'bottom' }, { x: 0, y: 0 }), [0, R]);
  const d = R * Math.SQRT1_2;
  nearPair(H.hintGoal({ zone: 'top-right' }, { x: 0, y: 0 }), [d, -d]);
  nearPair(H.hintGoal({ zone: 'outer' }, { x: 100, y: 0 }), [R * 1.3, 0]);
  nearPair(H.hintGoal({ zone: 'outer' }, { x: 0, y: -10 }), [0, -R * 1.3]);
  nearPair(H.hintGoal({ zone: 'outer' }, { x: 0, y: 0 }), [R * 1.3, 0]);
  assert.equal(H.hintGoal({ zone: 'nowhere' }, { x: 0, y: 0 }), null);
  assert.equal(H.hintGoal({ zone: 'constructor' }, { x: 0, y: 0 }), null);
  assert.equal(H.hintGoal({ weight: 1 }, { x: 0, y: 0 }), null); // 目標の無い項目
  assert.equal(H.hintGoal(null, { x: 0, y: 0 }), null);
});

test('引く力：目標へ「差 × 0.02 × 重さ」。重さが無いときは 0.5。group の重心へは半分の強さ', () => {
  const p = { x: 0, y: 0 };
  const goal = H.hintGoal({ zone: 'left' }, p); // [-280, 0]
  nearPair(H.hintPull(p, { zone: 'left', weight: 1 }, null), [goal[0] * H.HINT_K, 0]);
  nearPair(H.hintPull(p, { zone: 'left' }, null), [goal[0] * H.HINT_K * 0.5, 0]);
  // 重心（右へ 100）へは、group の半分の強さで足す
  nearPair(H.hintPull(p, { group: 'g', weight: 1 }, [100, 0]), [100 * H.HINT_K * 0.5, 0]);
  // 目標が無く、重心も無いときは動かさない
  assert.deepEqual(H.hintPull(p, { weight: 1 }, null), [0, 0]);
  assert.deepEqual(H.hintPull(p, null, null), [0, 0]);
});

test('group の重心：同じ group の、いま位置のあるメモの平均。group の無いものは数えない', () => {
  const c = H.hintCentroids([
    { group: 'a', p: { x: 0, y: 0 } },
    { group: 'a', p: { x: 10, y: 20 } },
    { group: 'b', p: { x: 100, y: 100 } },
    { group: null, p: { x: 999, y: 999 } },
    { p: { x: 999, y: 999 } },
  ]);
  assert.deepEqual([...c.keys()], ['a', 'b']);
  assert.deepEqual(c.get('a'), [5, 10]);
  assert.deepEqual(c.get('b'), [100, 100]);
});

test('流れの並び：group が無ければ、今の位置の順（これまでと同じ）。list は書き換えない', () => {
  const list = [{ id: 'x', k: 3 }, { id: 'y', k: 1 }, { id: 'z', k: 2 }];
  const copy = [...list];
  const keyOf = (n) => n.k;
  const none = () => null;
  assert.deepEqual(H.hintOrder(list, keyOf, none).map((n) => n.id), ['y', 'z', 'x']);
  assert.deepEqual(list, copy); // 元の配列は並べ替えない
  // 同じ位置のときは、今の位置（同点はそのまま）
  assert.deepEqual(H.hintOrder([{ id: 'p', k: 1 }, { id: 'q', k: 1 }], keyOf, none).map((n) => n.id), ['p', 'q']);
});

test('流れの並び：同じ group は隣に寄る（group の平均の位置で並べる）', () => {
  // a(10, r1) x(30) b(50, r1) c(20)。r1 の平均は 30。x と同じ位置なので、group の名前が無い x が先（名前の順）
  const items = [
    { id: 'a', k: 10, g: 'r1' },
    { id: 'x', k: 30, g: null },
    { id: 'b', k: 50, g: 'r1' },
    { id: 'c', k: 20, g: null },
  ];
  const out = H.hintOrder(items, (n) => n.k, (n) => n.g).map((n) => n.id);
  assert.deepEqual(out, ['c', 'x', 'a', 'b']);
  // group の中は今の位置の順のまま。別の group は名前の順に、まとまりごと
  const two = [
    { id: 'p', k: 1, g: 'zz' }, { id: 'q', k: 2, g: 'aa' }, { id: 'r', k: 3, g: 'zz' }, { id: 's', k: 4, g: 'aa' },
  ];
  const ordered = H.hintOrder(two, (n) => n.k, (n) => n.g).map((n) => n.id);
  // 平均：zz は 2、aa は 3。zz のまとまり（p, r）が先
  assert.deepEqual(ordered, ['p', 'r', 'q', 's']);
});

test('定数：力の強さ・目標の大きさは、計画の数字（k=0.02、半径 280・外側は 1.3 倍）', () => {
  assert.equal(H.HINT_K, 0.02);
  assert.equal(H.HINT_RING, 280);
  assert.equal(H.HINT_BOX, 280);
});

// 13 個以上にそろえる（受け継ぎ・置き始めは 13 個以上のときだけ働く）。ヒントの無い物を後ろに足す
const padItems = (list, n = 13) => {
  const out = [...list];
  while (out.length < n) out.push({ id: `pad${out.length}`, h: null });
  return out;
};

test('目標の半径：表示している丸が 12 以下は 280。13 からは 85 × √丸の数。上限は 280 の 3 倍（840）', () => {
  assert.equal(H.hintRadius(0), 280);
  assert.equal(H.hintRadius(10), 280);
  assert.equal(H.hintRadius(12), 280);
  near(H.hintRadius(13), 85 * Math.sqrt(13));
  near(H.hintRadius(38), 85 * Math.sqrt(38));
  near(H.hintRadius(97), 85 * Math.sqrt(97));
  assert.equal(H.hintRadius(106), 840);
  assert.equal(H.hintRadius(1000), 840);
});

test('目標点の倍率：scale で目標の大きさが変わる。省くと今と同じ', () => {
  const R = H.HINT_RING;
  const B = H.HINT_BOX;
  nearPair(H.hintGoal({ zone: 'left' }, { x: 0, y: 0 }, 2), [-2 * R, 0]);
  nearPair(H.hintGoal({ zone: 'outer' }, { x: 0, y: 5 }, 2), [0, 2 * R * 1.3]);
  nearPair(H.hintGoal({ pin: { x: 1, y: 0 } }, { x: 0, y: 0 }, 2), [2 * B, -2 * B]);
  nearPair(H.hintGoal({ zone: 'center' }, { x: 0, y: 0 }, 2), [0, 0]);
  nearPair(H.hintGoal({ zone: 'left' }, { x: 0, y: 0 }), [-R, 0]);
  nearPair(H.hintGoal({ pin: { x: 1, y: 0 } }, { x: 0, y: 0 }), [B, -B]);
});

test('引く力の倍率：boost は目標への引きだけに掛かる（重心への引きは変わらない）', () => {
  const p = { x: 0, y: 0 };
  const hint = { zone: 'left', group: 'g', weight: 1 };
  const centroid = [100, 0];
  // 目標へ -280 × 0.02 × 1 × 1.5、重心へ 100 × 0.02 × 0.5 × 1
  nearPair(H.hintPull(p, hint, centroid, 1, 1.5), [-280 * 0.02 * 1.5 + 100 * 0.02 * 0.5, 0]);
  nearPair(H.hintPull(p, hint, centroid), [-280 * 0.02 + 100 * 0.02 * 0.5, 0]);
  // 省いた場合と、1 を並べた場合は同じ値
  assert.deepEqual(H.hintPull(p, hint, centroid, 1, 1), H.hintPull(p, hint, centroid));
});

test('引く力：受け継いだ物は、目標へは重さ 0.2、重心へは自分の重さ（ownWeight）で引く', () => {
  const p = { x: 0, y: 0 };
  const centroid = [100, 0];
  const inh = { zone: 'left', group: 'g', weight: 0.2, ownWeight: 0.9, inherited: true };
  nearPair(H.hintPull(p, inh, centroid), [-280 * 0.02 * 0.2 + 100 * 0.02 * 0.5 * 0.9, 0]);
  // ownWeight が無ければ、重心へは 0.5
  const noOwn = { zone: 'left', group: 'g', weight: 0.2, inherited: true };
  nearPair(H.hintPull(p, noOwn, centroid), [-280 * 0.02 * 0.2 + 100 * 0.02 * 0.5 * 0.5, 0]);
});

test('まとまりの中心の判定：方向の zone と group があり、pin が無い物だけ（重さは見ない）', () => {
  assert.equal(H.hintIsHub({ zone: 'left', group: 'g' }), true);
  assert.equal(H.hintIsHub({ zone: 'left', group: 'g', weight: 0.1 }), true);
  assert.equal(H.hintIsHub({ zone: 'left', group: 'g', pin: { x: 0, y: 0 } }), false);
  assert.equal(H.hintIsHub({ zone: 'left' }), false);
  assert.equal(H.hintIsHub({ zone: 'outer', group: 'g' }), false);
  assert.equal(H.hintIsHub({ zone: 'center', group: 'g' }), false);
  assert.equal(H.hintIsHub({ zone: 'constructor', group: 'g' }), false);
  assert.equal(H.hintIsHub(null), false);
  // 受け継いだ物は中心にしない
  assert.equal(H.hintIsHub({ zone: 'left', group: 'g', weight: 0.2, inherited: true }), false);
});

test('引く力の倍率：丸が 13 以上のとき、中心は 1.5 倍、外側（pin なし）は 2 倍。ほかは 1 倍', () => {
  const hub = { zone: 'left', group: 'g' };
  const outer = { zone: 'outer' };
  assert.equal(H.hintBoost(hub, 38), 1.5);
  assert.equal(H.hintBoost(outer, 38), 2);
  assert.equal(H.hintBoost({ zone: 'outer', pin: { x: 0, y: 0 } }, 38), 1);
  assert.equal(H.hintBoost({ zone: 'left', group: 'g', inherited: true }, 38), 1);
  assert.equal(H.hintBoost({ group: 'g' }, 38), 1);
  assert.equal(H.hintBoost(null, 38), 1);
  // 12 以下は、どれも 1
  for (const h of [hub, outer, { zone: 'outer', pin: { x: 0, y: 0 } }, { group: 'g' }, null]) {
    assert.equal(H.hintBoost(h, 12), 1);
  }
});

test('受け継ぎ：同じ group の節が二つなら、重さが大きい節の向き', () => {
  const items = padItems([
    { id: 'a', h: { zone: 'left', group: 'g', weight: 0.5 } },
    { id: 'b', h: { zone: 'right', group: 'g', weight: 0.9 } },
    { id: 'm', h: { group: 'g' } },
  ]);
  const out = H.hintInherit(items);
  assert.equal(out[2].zone, 'right');
  assert.equal(out[2].weight, 0.2);
});

test('受け継ぎ：重さも同じなら、ID の小さい節の向き（並びの順には従わない）', () => {
  const items = padItems([
    { id: 'b', h: { zone: 'right', group: 'g', weight: 0.9 } },
    { id: 'a', h: { zone: 'left', group: 'g', weight: 0.9 } },
    { id: 'm', h: { group: 'g' } },
  ]);
  const out = H.hintInherit(items);
  assert.equal(out[2].zone, 'left');
});

test('受け継ぎ：outer・pin のある物・自分の zone がある物は受け継がない。中心の無い group も変わらない', () => {
  const items = padItems([
    { id: 'h1', h: { zone: 'left', group: 'g', weight: 0.9 } },
    { id: 'o', h: { zone: 'outer', group: 'g' } },
    { id: 'p', h: { group: 'g', pin: { x: 0.5, y: 0.5 } } },
    { id: 'z', h: { zone: 'top', group: 'g' } },
    { id: 'k', h: { group: 'k' } },
  ]);
  const out = H.hintInherit(items);
  for (let i = 1; i <= 4; i++) assert.equal(out[i], items[i].h); // 同じ物が返る
});

test('受け継ぎ：受け継いだ物は { ...元, zone, weight 0.2, ownWeight 元の重さ, inherited }。元の物は書き換えない', () => {
  const hub = { zone: 'left', group: 'g', weight: 0.9 };
  const m = { group: 'g', weight: 0.3 };
  const items = padItems([{ id: 'h1', h: hub }, { id: 'm', h: m }]);
  const out = H.hintInherit(items);
  assert.deepEqual(out[1], { group: 'g', weight: 0.2, zone: 'left', ownWeight: 0.3, inherited: true });
  assert.notEqual(out[1], m);
  assert.equal(m.zone, undefined); // 元の物は変わらない
  assert.equal(m.inherited, undefined);
});

test('受け継ぎ：入力を Object.freeze しても動き、元は変わらない', () => {
  const hub = Object.freeze({ zone: 'left', group: 'g', weight: 0.9 });
  const m = Object.freeze({ group: 'g', weight: 0.3 });
  const items = Object.freeze(padItems([Object.freeze({ id: 'h1', h: hub }), Object.freeze({ id: 'm', h: m })]));
  const out = H.hintInherit(items);
  assert.equal(out[1].zone, 'left');
  assert.equal(out[1].inherited, true);
  assert.equal(m.zone, undefined);
});

test('受け継ぎ：12 個以下なら、もとのヒントをそのまま同じ物で返す', () => {
  const items = [
    { id: 'a', h: { zone: 'left', group: 'g', weight: 0.9 } },
    { id: 'm', h: { group: 'g' } },
  ];
  const out = H.hintInherit(items);
  assert.equal(out.length, 2);
  assert.equal(out[0], items[0].h);
  assert.equal(out[1], items[1].h);
});

test('置き始めのマス：原点から輪の順に並ぶ（最初の 7 個は、原点と最初の輪の 6 個）', () => {
  assert.deepEqual(H.hintCells(7), [[0, 0], [-1, 1], [0, 1], [1, 0], [1, -1], [0, -1], [-1, 0]]);
  assert.deepEqual(H.hintCells(1), [[0, 0]]);
  assert.deepEqual(H.hintCells(0), []);
});

test('置き始め：38 マスの形で、ハブは置かず、節（右）のまとまりは 0.8R の所に置く。置いた数は 37', () => {
  const zones = ['right', 'top-right', 'top-left', 'left', 'bottom-left', 'bottom-right'];
  const items = [{ id: 'hub', h: { pin: { x: 0.5, y: 0.5 }, weight: 1 } }];
  const edges = [];
  zones.forEach((zone, s) => {
    items.push({ id: `s${s}`, h: { zone, group: `g${s}`, weight: 0.9 } });
    edges.push({ a: 'hub', b: `s${s}` });
  });
  for (let s = 0; s < 6; s++) {
    for (let i = 0; i < 4; i++) {
      items.push({ id: `s${s}i${i}`, h: { group: `g${s}` } });
      edges.push({ a: `s${s}`, b: `s${s}i${i}` });
    }
  }
  for (let g = 0; g < 7; g++) {
    items.push({ id: `k${g}`, h: { zone: 'outer' } });
    edges.push({ a: `s${g % 6}`, b: `k${g}` });
  }
  assert.equal(items.length, 38);
  const inh = H.hintInherit(items);
  const withH = items.map((x, i) => ({ id: x.id, h: inh[i] }));
  const seed = H.hintSeed(withH, edges);
  const R = 85 * Math.sqrt(38);
  // ハニカムの座標 [q, r] の位置（中心 cx, cy からの、間隔 0.6 倍）
  const at = (cx, cy, q, r) => [cx + 0.6 * 150 * Math.sqrt(3) * (q + r / 2), cy + 0.6 * 150 * 1.5 * r];
  assert.equal(seed.has(0), false); // ハブは置かない
  assert.equal(seed.size, 37);
  nearPair(seed.get(1), [0.8 * R, 0]); // 節 s0（right）
  nearPair(seed.get(31), at(0.8 * R, 0, 0, -1)); // Grok k0：s0 のまとまりの 6 番目
  nearPair(seed.get(37), at(0.8 * R, 0, -1, 0)); // Grok k6：s0 のまとまりの 7 番目
  nearPair(seed.get(7), at(0.8 * R, 0, -1, 1)); // s0 の項目 1 つめ：2 番目のマス
  nearPair(seed.get(10), at(0.8 * R, 0, 1, -1)); // s0 の項目 4 つめ：5 番目のマス（節と同じ所には置かない）
  // どの二つも同じ所に置かない（受け継いだ項目を中心にすると、節と重なる）
  const keys = [...seed.values()].map(([x, y]) => `${x.toFixed(3)},${y.toFixed(3)}`);
  assert.equal(new Set(keys).size, keys.length);
  assert.equal(H.hintSeed(withH.slice(0, 12), edges).size, 0); // 12 個以下は空
});

test('概観の件数：ヒントを使っている数・手で動かした数・出ていないヒントの数', () => {
  const items = [
    { id: 'a', h: { zone: 'left' }, moved: false },
    { id: 'b', h: { zone: 'right' }, moved: true },
    { id: 'c', h: null, moved: false },
    { id: 'd', h: null, moved: false },
  ];
  assert.deepEqual(H.hintCounts(items, ['a', 'b', 'e']), { used: 1, hidden: 1, moved: 1 });
});

test('概観の向き：方向の物は、向きから 30 度以内なら揃う。原点・手で動かした物・pin の物は数えない', () => {
  const one = (zone, p, extra = {}) => H.hintPlaced([{ id: 'a', h: { zone }, p, ...extra }], []);
  assert.deepEqual(one('left', { x: -100, y: 10 }), { dirOk: 1, dirAll: 1, outOk: 0, outAll: 0 }); // 揃う
  assert.deepEqual(one('left', { x: -100, y: 100 }), { dirOk: 0, dirAll: 1, outOk: 0, outAll: 0 }); // 45 度は揃わない
  assert.deepEqual(one('left', { x: 100, y: 0 }), { dirOk: 0, dirAll: 1, outOk: 0, outAll: 0 }); // 逆向き
  assert.deepEqual(one('left', { x: 0, y: 0 }), { dirOk: 0, dirAll: 1, outOk: 0, outAll: 0 }); // 原点
  assert.deepEqual(one('left', { x: -100, y: 0 }, { moved: true }), { dirOk: 0, dirAll: 0, outOk: 0, outAll: 0 }); // 手で動かした
  assert.deepEqual(H.hintPlaced([{ id: 'a', h: { zone: 'left', pin: { x: 0, y: 0 } }, p: { x: -100, y: 0 } }], []),
    { dirOk: 0, dirAll: 0, outOk: 0, outAll: 0 }); // pin
});

test('概観の外側：線で結ばれた方向の物と、その group の物より外なら数える（内は数えない）', () => {
  const edges = [{ a: 'o', b: 'l' }];
  const scene = (d) => [
    { id: 'o', h: { zone: 'outer' }, p: { x: d, y: 0 } },
    { id: 'l', h: { zone: 'left', group: 'x' }, p: { x: -300, y: 0 } }, // 線で結ばれた方向の物（距離 300）
    { id: 'm', h: { group: 'x' }, p: { x: 0, y: 350 } }, // その group の物（距離 350）
  ];
  const far = H.hintPlaced(scene(400), edges);
  assert.equal(far.outAll, 1);
  assert.equal(far.outOk, 1);
  const near350 = H.hintPlaced(scene(320), edges);
  assert.equal(near350.outOk, 0);
});

test('概観の外側：線が無ければ、outer でない丸すべて（h が無い物を含む）と比べる。基準が無ければ数える', () => {
  const scene = [
    { id: 'o', h: { zone: 'outer' }, p: { x: 370, y: 0 } },
    { id: 'a', h: { zone: 'left' }, p: { x: -300, y: 0 } }, // 距離 300
    { id: 'b', h: null, p: { x: 0, y: 380 } }, // h が無い物（距離 380）
    { id: 'g', h: { zone: 'outer' }, p: { x: 0, y: 500 } }, // 別の outer は基準に入らない
  ];
  const r = H.hintPlaced(scene, []);
  assert.equal(r.outAll, 2);
  assert.equal(r.outOk, 1); // 370 は 380 より内。500 は外
  // 基準になる丸が無ければ、数える
  const alone = H.hintPlaced([{ id: 'o', h: { zone: 'outer' }, p: { x: 10, y: 0 } }], []);
  assert.equal(alone.outOk, 1);
});

test('概観の一行の文言：「効く・出ていない・手で動かした」の件数。切っている・固定中・保存した並びは、それぞれの文言（「節」の語は出ない）', () => {
  assert.equal(H.hintReportText('on', { used: 37, hidden: 0, moved: 1 }), 'AI のヒント：37 件に効く（出ていない 0・手で動かした 1）');
  assert.equal(H.hintReportText('off', { used: 0, hidden: 0, moved: 0 }), 'AI のヒント：使っていません（「AI のヒント」で入れると効きます）');
  assert.equal(H.hintReportText('locked', { used: 0, hidden: 0, moved: 0 }), 'AI のヒント：固定中は使いません');
  assert.equal(H.hintReportText('saved', { used: 0, hidden: 0, moved: 0 }), 'AI のヒント：保存した並びでは使いません');
  for (const s of ['on', 'off', 'locked', 'saved']) assert.ok(!H.hintReportText(s, { used: 1, hidden: 1, moved: 1 }).includes('節'));
});

test('概観の位置の数の文言：「方向が揃った a／b・外側に出た c／d」。0 の分（無い分）は書かず、両方無ければ空', () => {
  assert.equal(H.hintPlacedText({ dirOk: 5, dirAll: 6, outOk: 7, outAll: 7 }), '方向が揃った 5／6・外側に出た 7／7');
  assert.equal(H.hintPlacedText({ dirOk: 2, dirAll: 3, outOk: 0, outAll: 0 }), '方向が揃った 2／3');
  assert.equal(H.hintPlacedText({ dirOk: 0, dirAll: 0, outOk: 1, outAll: 2 }), '外側に出た 1／2');
  assert.equal(H.hintPlacedText({ dirOk: 0, dirAll: 0, outOk: 0, outAll: 0 }), '');
});

// 読み込み・保存・2つのウィンドウの合わせ方（renderer.js の attachRootExtras・serializeFrom・mergeStores）。
// 画面の中の関数なので、その部分だけを取り出す。周りの名前は、ここで決まった形の代わりを渡す
const cut = (from, to) => {
  const a = SRC.indexOf(from);
  const b = SRC.indexOf(to, a + 1);
  assert.ok(a > 0 && b > a, `「${from.trim()}」の部分が見つからない`);
  return SRC.slice(a, b);
};
const attach = new Function('toLayer', 'TRASH_DAYS', `${cut('  function attachRootExtras(root, store) {', '  const serializeLink = ')}; return attachRootExtras;`)(
  (x) => x, 30,
);
const serializeFrom = new Function('isEmptyRecord', 'serializeRecord', 'serializeCamera', 'serializeLink', 'serializeRegion', 'serializeDendrite', 'HP',
  `${cut('  function serializeFrom(root, linkList) {', '  // ---- ほかのウィンドウとの内容の合わせ方 ----')}; return serializeFrom;`)(
  () => false, (r) => r, (c) => c, (l) => l, (r) => r, (d) => d, { isBlankPocket: () => false },
);
const { mergeStores } = new Function('HS', 'HP', 'CENTER_KEY', `${cut('  // 表示位置（camera）は比べない。キーの順番も揃える', '  // 関連付け：あちらの一覧に')}${cut('  function mergeLinks(', '  // 保存を断られた')}; return { mergeStores };`)(
  { mergeLinks: () => [] }, { mergePockets: () => [] }, '0,0',
);

const HA = { v: 1, createdAt: '2026-10-15T00:00:00.000Z', nodes: { a1: { zone: 'left' } } };
const HB = { v: 1, createdAt: '2026-10-15T00:00:00.000Z', nodes: { a1: { zone: 'right' } } };

test('読み込み：ヒントは保存された内容の写しを持つ。無ければ null（今と同じ）', () => {
  const root = {};
  attach(root, { layoutHints: HA });
  assert.deepEqual(root.layoutHints, HA);
  assert.notEqual(root.layoutHints, HA); // 保存された内容とは別の物（編集しても元は変わらない）
  attach(root, {});
  assert.equal(root.layoutHints, null);
});

test('保存：ヒントがあれば書き出す。無ければ項目ごと書かない（これまでの形と同じ）', () => {
  const data = serializeFrom({ memos: new Map(), layoutHints: HA }, null);
  assert.deepEqual(data.layoutHints, HA);
  assert.equal('layoutHints' in serializeFrom({ memos: new Map(), layoutHints: null }, null), false);
});

test('2つのウィンドウの合わせ方：ヒントは1かたまり。こちらが変えていればこちら、変えていなければあちら', () => {
  const st = (layoutHints) => ({ version: 2, camera: { x: 0, y: 0 }, memos: {}, ...(layoutHints ? { layoutHints } : {}) });
  // こちらは変えていない → あちら（別のウィンドウで変えた内容）
  assert.deepEqual(mergeStores(st(HA), st(HA), st(HB)).layoutHints, HB);
  // こちらが変えた → こちら
  assert.deepEqual(mergeStores(st(HA), st(HB), st(HA)).layoutHints, HB);
  // こちらが外した → あちらが変えていても外れたまま
  assert.equal('layoutHints' in mergeStores(st(HA), st(null), st(HB)), false);
  // あちらで足された（基準に無い）→ 持つ
  assert.deepEqual(mergeStores(st(null), st(null), st(HB)).layoutHints, HB);
});

test('書き戻し：今の位置は pin の読み方の逆。箱の外は 0 か 1。小数 3 桁', () => {
  const B = H.HINT_BOX;
  const back = (pin, scale = 1) => {
    const [x, y] = H.hintGoal({ pin }, { x: 0, y: 0 }, scale);
    return H.hintPinFromPos(x, y, scale);
  };
  assert.deepEqual(back({ x: 0, y: 0 }), { x: 0, y: 0 });
  assert.deepEqual(back({ x: 1, y: 1 }), { x: 1, y: 1 });
  assert.deepEqual(back({ x: 0.5, y: 0.5 }), { x: 0.5, y: 0.5 });
  assert.deepEqual(back({ x: 0.25, y: 0.75 }, 2), { x: 0.25, y: 0.75 });
  assert.deepEqual(H.hintPinFromPos(B + 10, -B - 10, 1), { x: 1, y: 0 });
  assert.equal(H.hintPinFromPos(NaN, 0), null);
});

test('書き戻し：pin だけ置き、zone・group・rank・weight と見えていない項目は残す。元のオブジェクトは変えない', () => {
  const existing = {
    v: 1,
    source: 'grok',
    createdAt: '2026-10-15T00:00:00.000Z',
    flow: { dir: 'TB' },
    grokOuter: true,
    nodes: {
      a1: { zone: 'left', group: 'hub', rank: 1, weight: 1, pin: { x: 0.5, y: 0.5 } },
      hidden: { zone: 'right', group: 'side' },
    },
  };
  const { hints, wrote } = H.hintWritePins([{ id: 'a1', x: H.HINT_BOX, y: -H.HINT_BOX }, { id: '', x: 0, y: 0 }, { x: 0, y: 0 }], existing, 1);
  assert.equal(wrote, 1);
  assert.equal(existing.nodes.a1.pin.x, 0.5); // 引数は変えない
  assert.deepEqual(hints.nodes.a1, { pin: { x: 1, y: 0 }, zone: 'left', group: 'hub', rank: 1, weight: 1 });
  assert.deepEqual(hints.nodes.hidden, { zone: 'right', group: 'side' });
  assert.equal(hints.source, 'grok');
  assert.equal(hints.createdAt, existing.createdAt);
  assert.deepEqual(hints.flow, { dir: 'TB' });
  assert.equal(hints.grokOuter, true);
  const fresh = H.hintWritePins([{ id: 'b2', x: 0, y: 0 }], null, 1);
  assert.equal(fresh.wrote, 1);
  assert.equal(fresh.hints.source, 'hand');
  assert.deepEqual(fresh.hints.nodes.b2, { pin: { x: 0.5, y: 0.5 } });
  assert.equal(H.hintWritePins([], null).hints, null);
});

test('依頼文：ID・最初の行・線・group・pin と書き方の手引き。送信先は書かない', () => {
  const text = H.hintRequestText({
    title: '見本',
    nodes: [{ id: 'hx001', first: 'まとめ', group: 'hub', pin: { x: 0.5, y: 0.5 } }, { id: '', first: 'ID 無し' }],
    edges: [{ a: 'hx001', b: 'hx002', dir: '→', kind: '続き' }],
  });
  assert.match(text, /hx001｜まとめ｜group:hub｜pin:0\.500,0\.500/);
  assert.match(text, /（id なし）｜ID 無し/);
  assert.match(text, /hx001 → hx002（続き）/);
  assert.match(text, /pin はハブ/);
  assert.match(text, /grokOuter: true/);
  assert.equal(text.includes('http'), false);
});
