/* 六角形グリッドの座標計算（pointy-top / 軸座標 q, r）
 * レンダラでは window.HexMath、Node（テスト）では module.exports として使う。 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.HexMath = api;
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  const SQRT3 = Math.sqrt(3);
  const KEY_RE = /^(-?\d+),(-?\d+)$/;

  // 軸座標 → マス中心のワールド座標（size は外接円半径）
  function hexToPixel(q, r, size) {
    return { x: size * SQRT3 * (q + r / 2), y: size * 1.5 * r };
  }

  // 小数の軸座標を最寄りのマスへ丸める（キューブ座標で丸めて誤差の最大成分を補正）
  function roundHex(fq, fr) {
    const fs = -fq - fr;
    let q = Math.round(fq);
    let r = Math.round(fr);
    const s = Math.round(fs);
    const dq = Math.abs(q - fq);
    const dr = Math.abs(r - fr);
    const ds = Math.abs(s - fs);
    if (dq > dr && dq > ds) q = -r - s;
    else if (dr > ds) r = -q - s;
    return { q: q + 0, r: r + 0 }; // -0 を 0 に揃える
  }

  function pixelToHex(x, y, size) {
    return roundHex((SQRT3 / 3 * x - y / 3) / size, (2 / 3 * y) / size);
  }

  function keyOf(q, r) {
    return `${q},${r}`;
  }

  // 画面上の点 → マスのキー。camera はワールド座標の中心 { x, y, zoom }、view はステージの大きさ { w, h }、
  // rect はステージの画面上の位置 { left, top }、size は外接円半径。renderer.js の keyAt はこれを使う。
  function screenToKey(clientX, clientY, camera, view, rect, size) {
    const z = camera.zoom;
    const wx = camera.x + (clientX - rect.left - view.w / 2) / z;
    const wy = camera.y + (clientY - rect.top - view.h / 2) / z;
    const hex = pixelToHex(wx, wy, size);
    return keyOf(hex.q, hex.r);
  }

  function parseKey(key) {
    const m = KEY_RE.exec(key);
    if (!m) return null;
    return { q: Number(m[1]) + 0, r: Number(m[2]) + 0 };
  }

  // ワールド座標の矩形に少しでも掛かるマスの範囲。
  // 行ごとの q 範囲は a2/b2（左右端を半マス単位で量子化した値）から決まるので、
  // この4値が変わらない限り表示すべきマスの集合も変わらない。
  function visibleBounds(left, top, right, bottom, size) {
    const colW = SQRT3 * size;
    const rowH = 1.5 * size;
    return {
      rMin: Math.floor((top - size) / rowH),
      rMax: Math.ceil((bottom + size) / rowH),
      a2: Math.floor((2 * (left - colW / 2)) / colW),
      b2: Math.ceil((2 * (right + colW / 2)) / colW),
    };
  }

  function forEachInBounds(b, cb) {
    for (let r = b.rMin; r <= b.rMax; r++) {
      const qMin = Math.floor((b.a2 - r) / 2);
      const qMax = Math.ceil((b.b2 - r) / 2);
      for (let q = qMin; q <= qMax; q++) cb(q + 0, r + 0);
    }
  }

  function hexDistance(a, b) {
    const dq = a.q - b.q;
    const dr = a.r - b.r;
    return (Math.abs(dq) + Math.abs(dr) + Math.abs(dq + dr)) / 2;
  }

  // ---- マスの隙間（六角形の辺）をたどる経路 ----
  // 頂点（3マスが接する角）を (i, j) で表す。j は六角形の行 r の上辺のジグザグ（= 行 r-1 の下辺）、
  // i は横位置（半マス = R√3/2 単位）。(i+j) が偶数の頂点はマスの上の角、奇数は下の角。
  // 辺は同じジグザグの左右（i±1）と、縦の辺（偶数の頂点は上 j-1 へ、奇数は下 j+1 へ）の3本

  function vertexToPixel(i, j, size) {
    return { x: (size * SQRT3 * i) / 2, y: size * (1.5 * j - 1) + ((i + j) & 1 ? size / 2 : 0) };
  }

  // マスの6つの角：上・右上・右下・下・左下・左上
  function hexCorners(q, r) {
    const c = 2 * q + r;
    return [
      { i: c, j: r }, { i: c + 1, j: r }, { i: c + 1, j: r + 1 },
      { i: c, j: r + 1 }, { i: c - 1, j: r + 1 }, { i: c - 1, j: r },
    ];
  }

  function vertexNeighbors(v) {
    return [
      { i: v.i - 1, j: v.j },
      { i: v.i + 1, j: v.j },
      { i: v.i, j: (v.i + v.j) & 1 ? v.j + 1 : v.j - 1 },
    ];
  }

  // 辺をたどったときの最短の辺の数。
  // 縦の辺は偶奇が合う頂点からしか進めず、同じ向きへ続けて進むには間に横の辺が1本以上いるので、
  // 横の辺の数は「横の距離」と「縦の移動に必要な横の辺の数」の大きいほう（両者の偶奇は必ず一致する）
  function vertexDistance(a, b) {
    const di = Math.abs(b.i - a.i);
    const dj = b.j - a.j;
    if (dj === 0) return di;
    const up = dj < 0;
    const n = Math.abs(dj);
    const startOk = ((a.i + a.j) & 1) === (up ? 0 : 1); // 最初からその向きへ進める
    const endOk = ((b.i + b.j) & 1) === (up ? 1 : 0); // 最後の縦の辺でそのまま着ける
    const hMin = n - 1 + (startOk ? 0 : 1) + (endOk ? 0 : 1);
    return n + Math.max(di, hMin);
  }

  function distToLine(p, a, b) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    if (len < 1e-9) return Math.hypot(p.x - a.x, p.y - a.y);
    return Math.abs(dx * (p.y - a.y) - dy * (p.x - a.x)) / len;
  }

  // マス a から b への、隙間だけを通る最短経路（頂点の列）。同じマスなら null。
  // 隣どうしなら2マスの間の辺。最短の中では、なるべくまっすぐ（端点どうしを結ぶ直線の近く）を通る
  function gapRoute(a, b) {
    const d = hexDistance(a, b);
    if (d === 0) return null;
    const ca = hexCorners(a.q, a.r);
    const cb = hexCorners(b.q, b.r);
    if (d === 1) return ca.filter((v) => cb.some((w) => w.i === v.i && w.j === v.j));

    const pa = hexToPixel(a.q, a.r, 1);
    const pb = hexToPixel(b.q, b.r, 1);
    let best = null;
    for (const s of ca) {
      const ps = vertexToPixel(s.i, s.j, 1);
      for (const t of cb) {
        const pt = vertexToPixel(t.i, t.j, 1);
        const cand = {
          s, t, ps, pt,
          len: vertexDistance(s, t),
          span: Math.hypot(pt.x - ps.x, pt.y - ps.y),
          off: distToLine(ps, pa, pb) + distToLine(pt, pa, pb),
        };
        if (!best || cand.len < best.len
          || (cand.len === best.len && (cand.span < best.span - 1e-9
            || (Math.abs(cand.span - best.span) <= 1e-9 && cand.off < best.off - 1e-9)))) best = cand;
      }
    }

    const route = [best.s];
    let cur = best.s;
    for (let left = best.len; left > 0; left--) {
      let next = null;
      let nextOff = Infinity;
      for (const n of vertexNeighbors(cur)) {
        if (vertexDistance(n, best.t) !== left - 1) continue;
        const off = distToLine(vertexToPixel(n.i, n.j, 1), best.ps, best.pt);
        if (off < nextOff - 1e-9) {
          next = n;
          nextOff = off;
        }
      }
      route.push(next);
      cur = next;
    }
    return route;
  }

  return {
    SQRT3, hexToPixel, pixelToHex, roundHex, keyOf, parseKey, screenToKey, visibleBounds, forEachInBounds,
    hexDistance, vertexToPixel, hexCorners, vertexNeighbors, vertexDistance, gapRoute,
  };
});
