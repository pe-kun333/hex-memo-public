/* 「コピーして送る」：マスの写しを、送り先（ノートの原点・マスへのリンクのマス）の下の階層の、
 * 中心に近い空いたマスに置く（今あるメモには重ねない）。
 * デスクトップ版の本体（main.js）・ブラウザ版（web-api.js）・画面（renderer.js：開いているノートへ送るとき）で共有する。
 * レンダラでは window.HexSend、Node（本体・テスト）では module.exports として使う。 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.HexSend = api;
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  const CENTER = '0,0'; // 下の階層の中心（＝親のメモ自身）。ここには置かない
  const MAX_SEND = 200; // 一度に送れるマスの数（まとめて貼り付けと同じ）
  const MAX_RING = 60; // 1つずつ置くときに探す範囲（中心からのマスの数）
  const SHAPE_RING = 12; // 並びを保って置くときに探す範囲
  const KEY_RE = /^(-?\d+),(-?\d+)$/;

  const keyOf = (q, r) => `${q + 0},${r + 0}`; // -0 を 0 に
  function parseKey(key) {
    const m = KEY_RE.exec(String(key));
    return m ? { q: Number(m[1]), r: Number(m[2]) } : null;
  }
  const distance = (q, r) => (Math.abs(q) + Math.abs(r) + Math.abs(q + r)) / 2;

  // 中心から ring マス離れた輪のマス。右上から時計回り（画面の貼り付けと同じ順）
  const rings = new Map();
  function ringOffsets(ring) {
    if (rings.has(ring)) return rings.get(ring);
    const cells = [];
    for (let dq = -ring; dq <= ring; dq++) {
      for (let dr = Math.max(-ring, -dq - ring); dr <= Math.min(ring, -dq + ring); dr++) {
        if (distance(dq, dr) !== ring) continue;
        const x = Math.sqrt(3) * (dq + dr / 2);
        const y = 1.5 * dr;
        cells.push({ dq: dq + 0, dr: dr + 0, angle: (Math.atan2(x, -y) + 2 * Math.PI) % (2 * Math.PI) });
      }
    }
    const out = cells.sort((a, b) => a.angle - b.angle).map(({ dq, dr }) => ({ dq, dr }));
    rings.set(ring, out);
    return out;
  }

  // 軸座標の小数を、いちばん近いマスに丸める
  function roundAxial(q, r) {
    let rq = Math.round(q);
    let rr = Math.round(r);
    const rs = Math.round(-q - r);
    const dq = Math.abs(rq - q);
    const dr = Math.abs(rr - r);
    const ds = Math.abs(rs - (-q - r));
    if (dq > dr && dq > ds) rq = -rr - rs;
    else if (dr > ds) rr = -rq - rs;
    return { q: rq + 0, r: rr + 0 };
  }

  // 中心に近い順に、空いたマスを count 個（足りなければ null）
  function nearestFree(isFree, count, maxRing = MAX_RING) {
    const out = [];
    for (let ring = 1; ring <= maxRing && out.length < count; ring++) {
      for (const { dq, dr } of ringOffsets(ring)) {
        const key = keyOf(dq, dr);
        if (key !== CENTER && isFree(key)) {
          out.push(key);
          if (out.length === count) break;
        }
      }
    }
    return out.length === count ? out : null;
  }

  // 並び（offsets：マスどうしの位置）を保って置く。並びの真ん中あたりを中心に合わせ、
  // そこから外へ順にずらして、すべてのマスが空いている最初の場所に置く（無ければ null）
  function shapeSpots(isFree, offsets, maxRing = SHAPE_RING) {
    const n = offsets.length;
    let sq = 0;
    let sr = 0;
    for (const o of offsets) {
      sq += o.dq;
      sr += o.dr;
    }
    const c = roundAxial(sq / n, sr / n);
    const rel = offsets.map((o) => ({ q: o.dq - c.q, r: o.dr - c.r }));
    for (let ring = 0; ring <= maxRing; ring++) {
      for (const a of ring ? ringOffsets(ring) : [{ dq: 0, dr: 0 }]) {
        const keys = rel.map((p) => keyOf(a.dq + p.q, a.dr + p.r));
        if (keys.every((k) => k !== CENTER && isFree(k))) return keys;
      }
    }
    return null;
  }

  const validOffsets = (offsets, count) => Array.isArray(offsets) && offsets.length === count
    && offsets.every((o) => o && Number.isInteger(o.dq) && Number.isInteger(o.dr))
    && new Set(offsets.map((o) => keyOf(o.dq, o.dr))).size === count;

  // 置く場所を決める：isFree(key) が true のマスだけを使い、中心 (0,0) には置かない。
  // 複数のマスで並び（offsets）があれば、まず並びを保てる場所を探し、無ければ1つずつ近い順に
  function pickSpots(isFree, count, offsets = null) {
    if (!Number.isInteger(count) || count < 1) return null;
    if (count > 1 && validOffsets(offsets, count)) {
      const keys = shapeSpots(isFree, offsets);
      if (keys) return keys;
    }
    return nearestFree(isFree, count);
  }

  // ---- 保存形式のノート（プレーンなオブジェクト）を扱う ----

  const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
  const layersOf = (rec) => (isObj(rec) && isObj(rec.children) ? [rec.children, ...(Array.isArray(rec.moreLayers) ? rec.moreLayers.filter(isObj) : [])] : []);
  const childrenOf = (layer) => (isObj(layer) && isObj(layer.memos) ? Object.values(layer.memos).filter(isObj) : []);

  // memoId のメモを探す（下の階層・重ねた層もたどる）。{ rec, depth }（ノート直下のメモが depth 0）
  function findMemo(memos, memoId) {
    if (!memoId || !isObj(memos)) return null;
    const walk = (list, depth) => {
      for (const rec of list) {
        if (rec.id === memoId) return { rec, depth };
        for (const layer of layersOf(rec)) {
          const found = walk(childrenOf(layer), depth + 1);
          if (found) return found;
        }
      }
      return null;
    };
    return walk(Object.values(memos).filter(isObj), 0);
  }

  // そのメモの下に何段の階層があるか（下が無ければ 0）。メモの無い層でも、画像を組み合わせてあれば1段に数える
  // （保存のときは、深すぎるメモの下の層が、組み合わせごと切り捨てられるため）
  function subtreeHeight(rec) {
    let h = 0;
    for (const layer of layersOf(rec)) {
      if (isObj(layer.combo)) h = Math.max(h, 1);
      for (const child of childrenOf(layer)) h = Math.max(h, 1 + subtreeHeight(child));
    }
    return h;
  }

  // 写しにしたとき空になるメモ（本文・いいね・ブックマーク・コメント・画像・リンク・下の階層のどれも無い）。
  // 関連付けだけがあるメモは、ID を外すと空になる（保存されない）ので送らない
  function isBlank(rec) {
    if (!isObj(rec)) return true;
    const has = (v) => Array.isArray(v) && v.length > 0;
    if (typeof rec.text === 'string' && rec.text.trim()) return false;
    if (rec.likedLevel > 0 || rec.bookmarked === true || has(rec.comments) || has(rec.images) || has(rec.urls)) return false;
    return !layersOf(rec).some((layer) => isObj(layer.combo) || childrenOf(layer).some((c) => !isBlank(c)));
  }

  // 写し：別のメモになるので ID と文章の通し番号を外し（関連付け・文章の並びは引き継がない）、
  // 作った・更新した時刻を now に（画面の貼り付けと同じ）
  function stripCopy(raw, now) {
    const rec = JSON.parse(JSON.stringify(raw));
    const strip = (r) => {
      delete r.id;
      delete r.seq;
      for (const layer of layersOf(r)) for (const child of childrenOf(layer)) strip(child);
    };
    strip(rec);
    rec.createdAt = now;
    rec.updatedAt = now;
    if (!Array.isArray(rec.comments)) rec.comments = [];
    return rec;
  }

  const emptyRecord = (now) => ({ text: '', createdAt: now, updatedAt: now, likedLevel: 0, liked: false, bookmarked: false, comments: [] });

  // 保存形式のノート store に写しを置く（store を書き換える）。
  // target.memoId があればそのメモ、無ければノート直下の原点 (0,0)（無ければ空のメモを作る）の、下の階層（第1層）へ。
  // 返り値 { placed: [置いたマスのキー], depth: 置いた階層の深さ }
  function insertCopies(store, target, records, { offsets = null, now = new Date().toISOString(), maxDepth = 50 } = {}) {
    if (!isObj(store)) throw new Error('ノートの中身が読めません');
    if (!Array.isArray(records) || records.length > MAX_SEND * 5) throw new Error('送るメモがありません');
    // 写しにすると空になるメモは除く（並びも合わせて除く）
    const keep = records.map((r) => !isBlank(r));
    const offs = Array.isArray(offsets) && offsets.length === records.length ? offsets.filter((_, i) => keep[i]) : null;
    records = records.filter((_, i) => keep[i]);
    if (!records.length) throw new Error('送るメモがありません');
    if (records.length > MAX_SEND) throw new Error(`一度に送れるのは ${MAX_SEND} マスまでです`);
    if (!isObj(store.memos)) store.memos = {};
    let parent;
    let depth;
    if (target && target.memoId) {
      const found = findMemo(store.memos, target.memoId);
      if (!found) throw new Error('送り先のマスが見つかりません（削除された可能性があります）');
      parent = found.rec;
      depth = found.depth;
    } else {
      if (!isObj(store.memos[CENTER])) store.memos[CENTER] = emptyRecord(now);
      parent = store.memos[CENTER];
      depth = 0;
    }
    // 保存のときに深すぎる階層は切り捨てられるので、収まらなければ送らない
    const height = Math.max(...records.map(subtreeHeight));
    if (depth + 1 + height > maxDepth) throw new Error(`送り先の階層が深すぎるため送れません（${maxDepth} 階層まで）`);
    if (!isObj(parent.children)) parent.children = { camera: { x: 0, y: 0 }, memos: {} };
    if (!isObj(parent.children.memos)) parent.children.memos = {};
    const memos = parent.children.memos;
    const keys = pickSpots((k) => !Object.prototype.hasOwnProperty.call(memos, k), records.length, offs);
    if (!keys) throw new Error('送り先に空いたマスが見つかりません');
    keys.forEach((k, i) => {
      memos[k] = stripCopy(records[i], now);
    });
    return { placed: keys, depth: depth + 1 };
  }

  // 送るメモ（records）と並び（offsets）を、検査（normalize）を通ったものだけ組にする。
  // 並びは、全部そろっていて重なりが無いときだけ返す（無ければ null：近い空きマスへ1つずつ）
  const OFFSET_MAX = 10000;
  function pairCells(records, offsets, normalize = null, max = MAX_SEND) {
    const raws = Array.isArray(records) ? records.slice(0, max) : [];
    const offs = Array.isArray(offsets) && offsets.length >= raws.length ? offsets : null;
    const okOffset = (o) => !!o && Number.isInteger(o.dq) && Number.isInteger(o.dr) && Math.abs(o.dq) <= OFFSET_MAX && Math.abs(o.dr) <= OFFSET_MAX;
    const cells = [];
    const out = [];
    raws.forEach((raw, i) => {
      const rec = normalize ? normalize(raw) : raw;
      if (!isObj(rec)) return;
      cells.push(rec);
      out.push(offs && okOffset(offs[i]) ? { dq: offs[i].dq, dr: offs[i].dr } : null);
    });
    const keep = out.length > 0 && out.every(Boolean) && new Set(out.map((o) => keyOf(o.dq, o.dr))).size === out.length;
    return { cells, offsets: keep ? out : null };
  }

  // メモの見出し（最初の空でない行。長ければ切る）
  function memoLabel(rec, max = 24) {
    const text = isObj(rec) && typeof rec.text === 'string' ? rec.text : '';
    const line = (text.split('\n').find((l) => l.trim()) || '').trim();
    const chars = [...line];
    return chars.length > max ? `${chars.slice(0, max).join('')}…` : line;
  }

  return {
    CENTER, MAX_SEND, keyOf, parseKey, ringOffsets, pickSpots, findMemo, subtreeHeight, isBlank, stripCopy, insertCopies, pairCells, memoLabel,
  };
});
