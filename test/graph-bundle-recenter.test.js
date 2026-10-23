'use strict';

// つながりの束：まわりのカードの右クリック（そのメモを真ん中に・線の印の全文／束）と「← 戻る」
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'renderer.js'), 'utf8');
const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const CSS = fs.readFileSync(path.join(ROOT, 'styles.css'), 'utf8');
const between = (from, to) => {
  const start = SRC.indexOf(from);
  const end = SRC.indexOf(to, start + 1);
  assert.ok(start > 0 && end > start, `「${from.trim()}」が見つからない`);
  return SRC.slice(start, end);
};
// eslint-disable-next-line no-new-func
const B = new Function(`const G_BUNDLE_MAX = 8; const G_BUNDLE_BACK_MAX = 20; ${between('  // ---- つながりの束：純粋な関数（ここから', '  // ---- つながりの束：純粋な関数（ここまで')}; return { gBundleBackNext, gBundleBackPop };`)();

test('戻るの積み方：束の中からの入れ替え（nav）だけ今の真ん中を積む', () => {
  assert.deepEqual(B.gBundleBackNext([], 'a', 'b', 'nav'), ['a']);
  assert.deepEqual(B.gBundleBackNext(['a'], 'b', 'c', 'nav'), ['a', 'b']);
  assert.deepEqual(B.gBundleBackNext(['a'], 'b', 'b', 'nav'), ['a'], '同じ真ん中への入れ替えは積まない');
  assert.deepEqual(B.gBundleBackNext([], null, 'b', 'nav'), [], '束が閉じていれば積まない');
  assert.deepEqual(B.gBundleBackNext(['a', 'b'], 'c', 'b', 'back'), ['a', 'b'], '戻るは積まない');
  assert.deepEqual(B.gBundleBackNext(['a', 'b'], 'c', 'd', ''), [], '外（グラフの右クリック）から開いたら空に');
});

test('戻るの積み方：多すぎれば古い方から捨てる・元の配列は変えない', () => {
  const s = ['a', 'b', 'c'];
  assert.deepEqual(B.gBundleBackNext(s, 'd', 'e', 'nav', 3), ['b', 'c', 'd']);
  assert.deepEqual(s, ['a', 'b', 'c']);
});

test('戻る先：上から、まだあって今の真ん中でないもの', () => {
  assert.deepEqual(B.gBundleBackPop(['a', 'b'], 'c', () => true), { id: 'b', rest: ['a'] });
  assert.deepEqual(B.gBundleBackPop(['a', 'gone'], 'c', (x) => x !== 'gone'), { id: 'a', rest: [] });
  assert.deepEqual(B.gBundleBackPop(['a', 'c'], 'c', () => true), { id: 'a', rest: [] });
  assert.deepEqual(B.gBundleBackPop([], 'c', () => true), { id: null, rest: [] });
});

test('openGraphBundle：via で戻るを決め、閉じ直す前に計算する。本当に閉じたら戻るを忘れる', () => {
  const open = between('  function openGraphBundle(rec, { via = \'\' } = {}) {', '  // タブのページを出す');
  assert.ok(open.indexOf('gBundleBackNext(') < open.indexOf('closeGraphBundle({ keepList: true })'));
  assert.match(open, /gBundle\.back = back;/);
  assert.match(open, /el\('button', 'g-bundle-back', '← 戻る'\)/);
  assert.match(open, /backBtn\.hidden = !back\.length;/);
  const close = between('  function closeGraphBundle(', '  // ---- 束のまわりのカードの右クリック');
  assert.match(close, /if \(!keepList\) \{ gBundleRestoreList\(\); gBundle\.back = \[\]; \}/);
  assert.match(close, /hideGraphBundleMenu\(\);/);
});

test('戻る：積まずに開き直す', () => {
  const back = between('  function backGraphBundle() {', '  function closeGraphBundle(');
  assert.match(back, /gBundleBackPop\(gBundle\.back,/);
  assert.match(back, /openGraphBundle\(found\.rec, \{ via: 'back' \}\)/);
});

test('右の一覧の「束」は nav（戻るに積む）、グラフの右クリックは外から（戻るを空に）', () => {
  assert.match(SRC, /if \(found\) openGraphBundle\(found\.rec, \{ via: 'nav' \}\);/);
  assert.match(SRC, /cmd\.dataset\.cmd === 'g-bundle'\) openGraphBundle\(rec\);/);
});

test('まわりのカードだけに右クリックのメニュー（真ん中には出さない）・クリックやダブルクリックは付けない', () => {
  const menu = between('  // ---- 束のまわりのカードの右クリック', '  function hideGraphHover() {');
  assert.match(menu, /graphBundleBox\.addEventListener\('contextmenu'/);
  assert.match(menu, /if \(!card\.dataset\.id\) \{ hideGraphBundleMenu\(\); return; \}/);
  assert.match(menu, /afterRightRelease\(e, \(\) => openGraphBundleMenu\(card,/);
  assert.doesNotMatch(menu, /graphBundleBox\.addEventListener\('(click|dblclick)'/);
  assert.match(menu, /'このメモを真ん中にまとめて開く'/);
  assert.match(menu, /buildGraphRelRow\(at\.rec, byId, edges\)/);
  assert.match(menu, /openGraphBundle\(found\.rec, \{ via: 'nav' \}\)/);
  assert.match(menu, /showGraphPeek\(chip, \{ pinned: true \}\)/);
});

test('Esc の順：全文の吹き出し → カードのメニュー → 束', () => {
  const menu = between('  // ---- 束のまわりのカードの右クリック', '  function hideGraphHover() {');
  assert.match(menu, /e\.key !== 'Escape' \|\| e\.isComposing \|\| e\.defaultPrevented \|\| !gBundleMenuOpen\(\)/);
  assert.match(menu, /e\.stopPropagation\(\);\n    hideGraphBundleMenu\(\);\n  \}, true\);/);
  // 全文の吹き出しの Esc はメニューより先に登録（同じ window の capture で先に動く）
  assert.ok(SRC.indexOf("if (e.key !== 'Escape' || e.isComposing || !gPeek.anchor) return;") < SRC.indexOf('!gBundleMenuOpen()) return;'));
});

test('一覧と束のメニューで線の印の並びを共通にする', () => {
  const item = between('  function buildGraphListItem(', '  function buildGraphRelRow(');
  assert.match(item, /const row = buildGraphRelRow\(rec, byId, edges\);/);
});

test('HTML・CSS：メニューの器と戻るボタンの見た目', () => {
  assert.match(HTML, /<div class="g-bundle-menu" id="graphBundleMenu" popover="manual"/);
  assert.match(CSS, /\.g-bundle-back\[hidden\] \{ display: none; \}/);
  assert.match(CSS, /\.g-bundle-menu:popover-open/);
});
