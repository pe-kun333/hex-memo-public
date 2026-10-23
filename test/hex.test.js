'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('../hex.js');

const SIZE = 132;

test('マス中心 ⇄ 軸座標が往復で一致する（遠方の座標でも）', () => {
  const samples = [];
  for (let q = -30; q <= 30; q += 3) for (let r = -30; r <= 30; r += 3) samples.push([q, r]);
  samples.push([123456, -98765], [-4000000, 2500000]);
  for (const [q, r] of samples) {
    const p = H.hexToPixel(q, r, SIZE);
    assert.deepEqual(H.pixelToHex(p.x, p.y, SIZE), { q, r });
  }
});

test('マスの内側の点はそのマスに丸められる', () => {
  const inner = (SIZE * H.SQRT3) / 2; // 内接円半径
  for (const [q, r] of [[0, 0], [5, -3], [-7, 11]]) {
    const c = H.hexToPixel(q, r, SIZE);
    for (let a = 0; a < 360; a += 15) {
      const t = (a * Math.PI) / 180;
      const x = c.x + Math.cos(t) * inner * 0.95;
      const y = c.y + Math.sin(t) * inner * 0.95;
      assert.deepEqual(H.pixelToHex(x, y, SIZE), { q, r });
    }
  }
});

test('-0 は 0 に正規化される', () => {
  const h = H.pixelToHex(-0.001, -0.001, SIZE);
  assert.ok(Object.is(h.q, 0) && Object.is(h.r, 0));
  assert.equal(H.keyOf(h.q, h.r), '0,0');
  assert.ok(Object.is(H.parseKey('-0,0').q, 0));
});

test('keyOf / parseKey', () => {
  assert.equal(H.keyOf(3, -2), '3,-2');
  assert.deepEqual(H.parseKey('3,-2'), { q: 3, r: -2 });
  assert.equal(H.parseKey('a,b'), null);
  assert.equal(H.parseKey('1, 2'), null);
});

function collect(bounds) {
  const set = new Set();
  H.forEachInBounds(bounds, (q, r) => set.add(H.keyOf(q, r)));
  return set;
}

test('表示範囲に掛かるマスはすべて列挙され、数も過剰にならない', () => {
  const viewports = [
    [-640, -400, 640, 400],
    [10000.5, -3333.3, 11920.5, -2253.3],
    [-5e6, 7e5, -5e6 + 1500, 7e5 + 900],
  ];
  for (const [left, top, right, bottom] of viewports) {
    const set = collect(H.visibleBounds(left, top, right, bottom, SIZE));
    // 矩形内を細かくサンプリングし、どの点が属するマスも列挙に含まれること
    for (let x = left; x <= right; x += 20) {
      for (let y = top; y <= bottom; y += 20) {
        const h = H.pixelToHex(x, y, SIZE);
        assert.ok(set.has(H.keyOf(h.q, h.r)), `(${x}, ${y}) → ${h.q},${h.r} が含まれていない`);
      }
    }
    // 余分に列挙するのは上下左右それぞれ高々1行／1列まで
    const rows = Math.ceil((bottom - top + 2 * SIZE) / (1.5 * SIZE)) + 2;
    const perRow = Math.ceil((right - left + H.SQRT3 * SIZE) / (H.SQRT3 * SIZE)) + 2;
    assert.ok(set.size <= rows * perRow, `列挙数が多すぎる: ${set.size} > ${rows * perRow}`);
  }
});

test('visibleBounds の4値が同じなら列挙結果も同じ（再計算の省略が安全）', () => {
  const a = H.visibleBounds(0, 0, 1280, 800, SIZE);
  const b = H.visibleBounds(3, 2, 1283, 802, SIZE);
  assert.deepEqual(a, b);
  assert.deepEqual([...collect(a)], [...collect(b)]);
});

// ---- 隙間をたどる経路 ----

const vkey = (v) => `${v.i},${v.j}`;

test('マスの角：6つとも中心から外接円半径の位置にあり、隣のマスと角を共有する', () => {
  for (const [q, r] of [[0, 0], [3, -2], [-5, 7]]) {
    const c = H.hexToPixel(q, r, SIZE);
    const corners = H.hexCorners(q, r);
    assert.equal(new Set(corners.map(vkey)).size, 6);
    corners.forEach((v, k) => {
      const p = H.vertexToPixel(v.i, v.j, SIZE);
      const ang = (Math.PI / 3) * k - Math.PI / 2; // 上から時計回り
      assert.ok(Math.abs(p.x - (c.x + SIZE * Math.cos(ang))) < 1e-6 && Math.abs(p.y - (c.y + SIZE * Math.sin(ang))) < 1e-6, `${q},${r} 角${k}`);
    });
    // 6つの隣のマスとはちょうど2つの角（= 間の辺）を共有する
    for (const [dq, dr] of [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]]) {
      const other = new Set(H.hexCorners(q + dq, r + dr).map(vkey));
      assert.equal(corners.filter((v) => other.has(vkey(v))).length, 2);
    }
  }
});

test('頂点の辺：3本とも長さは外接円半径で、双方向', () => {
  for (let i = -6; i <= 6; i++) {
    for (let j = -6; j <= 6; j++) {
      const p = H.vertexToPixel(i, j, SIZE);
      for (const n of H.vertexNeighbors({ i, j })) {
        const pn = H.vertexToPixel(n.i, n.j, SIZE);
        assert.ok(Math.abs(Math.hypot(pn.x - p.x, pn.y - p.y) - SIZE) < 1e-6);
        assert.ok(H.vertexNeighbors(n).some((m) => m.i === i && m.j === j));
      }
    }
  }
});

test('vertexDistance は幅優先探索の最短距離と一致する', () => {
  const R = 9;
  for (const start of [{ i: 0, j: 0 }, { i: 1, j: 0 }, { i: -3, j: 2 }, { i: 4, j: -1 }]) {
    // 範囲の外を回り込むほうが近いことはないので、十分広い範囲で探索する
    const dist = new Map([[vkey(start), 0]]);
    const queue = [start];
    for (let k = 0; k < queue.length; k++) {
      const v = queue[k];
      for (const n of H.vertexNeighbors(v)) {
        if (Math.abs(n.i - start.i) > 3 * R || Math.abs(n.j - start.j) > 2 * R || dist.has(vkey(n))) continue;
        dist.set(vkey(n), dist.get(vkey(v)) + 1);
        queue.push(n);
      }
    }
    for (let i = start.i - R; i <= start.i + R; i++) {
      for (let j = start.j - R; j <= start.j + R; j++) {
        assert.equal(H.vertexDistance(start, { i, j }), dist.get(`${i},${j}`), `${vkey(start)} → ${i},${j}`);
      }
    }
  }
});

test('gapRoute：角から角へ辺だけをたどる最短経路で、途中で両端のマスの角に触れない', () => {
  const cases = [];
  for (let q = -7; q <= 7; q++) for (let r = -7; r <= 7; r++) cases.push([{ q: 0, r: 0 }, { q, r }]);
  cases.push([{ q: 3, r: -2 }, { q: -40, r: 25 }], [{ q: -100, r: 60 }, { q: 120, r: -90 }]);
  for (const [a, b] of cases) {
    const route = H.gapRoute(a, b);
    const d = H.hexDistance(a, b);
    if (d === 0) {
      assert.equal(route, null);
      continue;
    }
    const ca = new Set(H.hexCorners(a.q, a.r).map(vkey));
    const cb = new Set(H.hexCorners(b.q, b.r).map(vkey));
    const label = `${a.q},${a.r} → ${b.q},${b.r}`;
    assert.ok(ca.has(vkey(route[0])) && cb.has(vkey(route[route.length - 1])), label);
    for (let k = 1; k < route.length; k++) {
      assert.ok(H.vertexNeighbors(route[k - 1]).some((n) => vkey(n) === vkey(route[k])), `${label} 辺 ${k}`);
    }
    if (d === 1) {
      assert.equal(route.length, 2, label); // 2マスの間の辺
      assert.ok(cb.has(vkey(route[0])) && ca.has(vkey(route[1])), label);
      continue;
    }
    let shortest = Infinity;
    for (const s of H.hexCorners(a.q, a.r)) for (const t of H.hexCorners(b.q, b.r)) shortest = Math.min(shortest, H.vertexDistance(s, t));
    assert.equal(route.length - 1, shortest, label);
    assert.ok(route.slice(1).every((v) => !ca.has(vkey(v))) && route.slice(0, -1).every((v) => !cb.has(vkey(v))), label);
  }
});

test('画面の点 → マス：26%・33%・41% で中心と、平らな辺のすぐ内側・外側が往復する', () => {
  const view = { w: 1440, h: 900 };
  const rect = { left: 320, top: 72 }; // サイドバーの分だけステージが右にずれている
  const cells = [[0, 0], [2, -1], [-3, 4], [1, 0], [0, -1], [8, 5]];
  const zooms = [0.26, 0.33, 0.8 ** 5, 0.41]; // 0.8^5 は 100% から Ctrl+- を 5 回（表示は 33%）
  assert.equal(Math.round(0.8 ** 5 * 100), 33);
  // 横幅（平らな辺から平らな辺）は 26% で約 59px、41% で約 94px
  assert.ok(H.SQRT3 * SIZE * 0.26 > 58 && H.SQRT3 * SIZE * 0.26 < 61);
  assert.ok(H.SQRT3 * SIZE * 0.33 > 74 && H.SQRT3 * SIZE * 0.33 < 77);
  assert.ok(H.SQRT3 * SIZE * 0.41 > 92 && H.SQRT3 * SIZE * 0.41 < 96);
  const clientOf = (wx, wy, camera) => {
    const z = camera.zoom;
    return {
      x: rect.left + view.w / 2 + (wx - camera.x) * z,
      y: rect.top + view.h / 2 + (wy - camera.y) * z,
    };
  };
  const edge = (SIZE * H.SQRT3) / 2; // 中心から右の平らな辺まで
  for (const zoom of zooms) {
    const camera = { x: 480, y: -220, zoom };
    for (const [q, r] of cells) {
      const c = H.hexToPixel(q, r, SIZE);
      const mid = clientOf(c.x, c.y, camera);
      assert.equal(H.screenToKey(mid.x, mid.y, camera, view, rect, SIZE), H.keyOf(q, r), `center ${zoom} ${q},${r}`);
      const inside = clientOf(c.x + edge - 2 / zoom, c.y, camera); // 辺の 2 画面px 内側
      const outside = clientOf(c.x + edge + 2 / zoom, c.y, camera); // 2 画面px 外側 → 右隣
      assert.equal(H.screenToKey(inside.x, inside.y, camera, view, rect, SIZE), H.keyOf(q, r), `inside ${zoom} ${q},${r}`);
      assert.equal(H.screenToKey(outside.x, outside.y, camera, view, rect, SIZE), H.keyOf(q + 1, r), `outside ${zoom} ${q},${r}`);
    }
  }
});

test('gapRoute：遠くのマスへは直線の近くを通る', () => {
  const a = { q: 0, r: 0 };
  const b = { q: 30, r: -12 };
  const pa = H.hexToPixel(a.q, a.r, 1);
  const pb = H.hexToPixel(b.q, b.r, 1);
  const len = Math.hypot(pb.x - pa.x, pb.y - pa.y);
  for (const v of H.gapRoute(a, b)) {
    const p = H.vertexToPixel(v.i, v.j, 1);
    const off = Math.abs((pb.x - pa.x) * (p.y - pa.y) - (pb.y - pa.y) * (p.x - pa.x)) / len;
    assert.ok(off < 2, `直線から ${off.toFixed(2)} マス`);
  }
});
