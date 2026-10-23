'use strict';

// つながりの束（グラフの右クリック「まわりのメモをまとめて開く」。docs/plan-graph-relation-bundle.md の P1）
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'renderer.js'), 'utf8');
const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const between = (from, to) => {
  const start = SRC.indexOf(from);
  const end = SRC.indexOf(to, start + 1);
  assert.ok(start > 0 && end > start, `「${from.trim()}」が見つからない`);
  return SRC.slice(start, end);
};
// eslint-disable-next-line no-new-func
const B = new Function(`const G_BUNDLE_MAX = 8; ${between('  // ---- つながりの束：純粋な関数（ここから', '  // ---- つながりの束：純粋な関数（ここまで')}; return { gBundleNeighbors, gBundleTagText, gBundleSlot, gBundleSegment, gBundlePageCount, gBundlePage };`)();
const ORDER = ['ground', 'counter', 'next', 'same'];
const opts = { order: (k) => (ORDER.includes(k) ? ORDER.indexOf(k) : 99), directed: (k) => k !== 'same' };

test('相手の並び：真ん中に触れる線だけ・種類の順・同じ種類なら新しい線から', () => {
  const links = [
    { a: 'C', b: 'x', kind: 'next' },
    { a: 'y', b: 'C', kind: 'ground', label: '文献あり' },
    { a: 'p', b: 'q', kind: 'ground' }, // 真ん中に触れない
    { a: 'C', b: 'z', kind: 'ground' },
    { a: 'C', b: 'w', kind: 'same' },
  ];
  const r = B.gBundleNeighbors('C', links, opts);
  assert.deepEqual(r.shown.map((n) => n.id), ['z', 'y', 'x', 'w']);
  assert.equal(r.total, 4);
  assert.equal(r.more, 0);
  assert.equal(r.shown[1].tags[0].dir, 'in');
  assert.equal(r.shown[0].tags[0].dir, 'out');
  assert.equal(r.shown[3].tags[0].dir, 'none', '向きの無い種類');
});

test('同じ相手への線が 2 本なら、カードは 1 枚で札が 2 つ', () => {
  const r = B.gBundleNeighbors('C', [{ a: 'C', b: 'x', kind: 'next' }, { a: 'x', b: 'C', kind: 'counter' }], opts);
  assert.equal(r.shown.length, 1);
  assert.deepEqual(r.shown[0].tags.map((t) => t.kind), ['counter', 'next']);
});

test('8 枚まで（残りの数と、全部の並び all も返す）', () => {
  const links = Array.from({ length: 12 }, (_, i) => ({ a: 'C', b: `n${i}`, kind: 'next' }));
  const r = B.gBundleNeighbors('C', links, opts);
  assert.equal(r.shown.length, 8);
  assert.equal(r.more, 4);
  assert.equal(r.all.length, 12);
  assert.deepEqual(r.all.slice(0, 8), r.shown);
  assert.match(SRC, /const G_BUNDLE_MAX = 8;/);
  assert.equal(r.total, 12);
});

test('札の文字：向きの矢印・種類｜ラベル', () => {
  assert.equal(B.gBundleTagText({ dir: 'out', label: '文献あり' }, '根拠'), '→ 根拠｜文献あり');
  assert.equal(B.gBundleTagText({ dir: 'in', label: '' }, '反論'), '← 反論');
  assert.equal(B.gBundleTagText({ dir: 'none', label: '' }, '同じ'), '同じ');
  assert.equal(B.gBundleTagText({ dir: 'none', label: '' }, ''), '関連');
});

test('右クリックのメニューに項目・浮く板・Esc で最初に閉じる・タブを離れたら閉じる', () => {
  assert.match(HTML, /data-cmd="g-bundle"[^>]*><span>まわりのメモをまとめて開く<\/span>/);
  assert.match(HTML, /id="graphBundle" popover="manual" role="dialog"/);
  assert.match(SRC, /else if \(cmd\.dataset\.cmd === 'g-bundle'\) openGraphBundle\(rec\);/);
  assert.match(SRC, /if \(e\.key !== 'Escape'\) return;\s*if \(gBundle\.rec\) \{ closeGraphBundle\(\); return; \}/);
  assert.match(SRC, /if \(tab !== 'graph'\) closeGraphBundle\(\);/);
});

test('真ん中の丸を留め、閉じたら元に戻す（ドラッグしても留めたまま）', () => {
  const open = between('  function openGraphBundle(rec, ', '  // 置き場所：グラフの区画の左上');
  assert.match(open, /if \(p\) \{ p\.fx = p\.x; p\.fy = p\.y; \}/);
  assert.match(open, /full: true, center: true/);
  const close = between('  function closeGraphBundle(', '  function hideGraphHover() {');
  assert.match(close, /p\.fx = gBundle\.pinned \? gBundle\.pinned\.fx : null/);
  assert.match(SRC, /if \(p && gBundle\.rec === gDrag\.rec\) \{ p\.fx = p\.x; p\.fy = p\.y; \}/);
});

test('置き場所：真ん中は 3×3 の真ん中、相手は上・下・左・右・四隅の順で 8 マス', () => {
  const slots = Array.from({ length: 8 }, (_, i) => B.gBundleSlot(i));
  assert.deepEqual(slots, [[1, 2], [3, 2], [2, 1], [2, 3], [1, 1], [1, 3], [3, 1], [3, 3]]);
  assert.ok(!slots.some(([r, c]) => r === 2 && c === 2), '真ん中は真ん中のカード');
  assert.equal(B.gBundleSlot(8), null);
  assert.match(SRC, /centerCard\.style\.gridArea = '2 \/ 2';/);
});

test('線はカードの縁から縁へ（右・下・斜め）', () => {
  const c = { x: 100, y: 100, w: 100, h: 50 };
  assert.deepEqual(B.gBundleSegment(c, { x: 300, y: 100, w: 100, h: 50 }), { x1: 200, y1: 125, x2: 300, y2: 125 });
  assert.deepEqual(B.gBundleSegment(c, { x: 100, y: 200, w: 100, h: 50 }), { x1: 150, y1: 150, x2: 150, y2: 200 });
  const d = B.gBundleSegment(c, { x: 300, y: 300, w: 100, h: 50 });
  assert.ok(Math.abs(d.y1 - 150) < 1e-9 && d.x1 > 150 && d.x1 <= 200, '真ん中のカードの下の縁で切る');
  assert.ok(Math.abs(d.y2 - 300) < 1e-9, '相手のカードの上の縁で切る');
});

test('線：種類の色・向きのある線は矢じり・相手 → 真ん中なら逆向き', () => {
  const draw = between('  function drawGraphBundleLines() {', '  // 置き場所：グラフの区画の左上');
  assert.match(draw, /const back = card\.dataset\.dir === 'in';/);
  assert.match(draw, /if \(card\.dataset\.dir !== 'none'\)/);
  assert.match(draw, /marker-end/);
});

test('タブ：8 件ずつのページ（はみ出したページ番号は端に寄せる）', () => {
  assert.equal(B.gBundlePageCount(0), 1);
  assert.equal(B.gBundlePageCount(8), 1);
  assert.equal(B.gBundlePageCount(9), 2);
  assert.equal(B.gBundlePageCount(17), 3);
  const list = Array.from({ length: 12 }, (_, i) => i);
  assert.deepEqual(B.gBundlePage(list, 0), { page: 0, items: [0, 1, 2, 3, 4, 5, 6, 7] });
  assert.deepEqual(B.gBundlePage(list, 1), { page: 1, items: [8, 9, 10, 11] });
  assert.equal(B.gBundlePage(list, 5).page, 1);
  assert.equal(B.gBundlePage(list, -1).page, 0);
});

test('タブ：8 件を超えたときだけ出し、押すと相手だけ入れ替えて線を引き直す（「ほか N 件」は出さない）', () => {
  const open = between('  function openGraphBundle(rec, ', '  // タブのページを出す');
  assert.match(open, /tabs\.hidden = total <= G_BUNDLE_MAX;/);
  assert.match(open, /`タブ\$\{i \+ 1\}`/);
  assert.doesNotMatch(open, /ほか \$\{more\} 件/);
  const page = between('  function showGraphBundlePage(', '  // 板の中の線');
  assert.match(page, /querySelectorAll\('\.g-bundle-card\[data-id\]'\)\.forEach\(\(c\) => c\.remove\(\)\)/);
  assert.match(page, /requestAnimationFrame\(drawGraphBundleLines\)/);
  assert.doesNotMatch(page, /is-center/, '真ん中のカードには触らない');
});
