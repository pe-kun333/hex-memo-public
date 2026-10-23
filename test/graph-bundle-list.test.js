// つながりの束：開くとき右の一覧をたたみ、閉じたら（束のためにたたんだときだけ）開き直す
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'renderer.js'), 'utf8');
function between(a, b) {
  const i = SRC.indexOf(a);
  const j = SRC.indexOf(b, i + 1);
  assert.ok(i >= 0 && j > i, `${a} … ${b}`);
  return SRC.slice(i, j);
}
const B = new Function(`const G_BUNDLE_MAX = 8; ${between('  // ---- つながりの束：純粋な関数（ここから', '  // ---- つながりの束：純粋な関数（ここまで')}; return { gBundleShouldCollapseList, gBundleShouldRestoreList, gBundlePrefFrom };`)();

test('設定は既定で入。"0"/"false" だけ切', () => {
  assert.equal(B.gBundlePrefFrom(null), true);
  assert.equal(B.gBundlePrefFrom('1'), true);
  assert.equal(B.gBundlePrefFrom('0'), false);
  assert.equal(B.gBundlePrefFrom('false'), false);
});

test('たたむのは：設定が入で、一覧が開いているときだけ', () => {
  assert.equal(B.gBundleShouldCollapseList(true, true), true);
  assert.equal(B.gBundleShouldCollapseList(true, false), false, 'もう閉じていれば何もしない');
  assert.equal(B.gBundleShouldCollapseList(false, true), false);
});

test('開き直すのは：束のためにたたんで、いまも閉じているときだけ', () => {
  assert.equal(B.gBundleShouldRestoreList(true, false), true);
  assert.equal(B.gBundleShouldRestoreList(false, false), false, '自分でたたんでいた一覧は開かない');
  assert.equal(B.gBundleShouldRestoreList(true, true), false);
});

test('つなぎ：開くときにたたみ、閉じるときに戻し、開き直し・手動の開け閉めでは引き継がない', () => {
  const open = between('  function openGraphBundle(rec, ', '  // 板の中の線');
  assert.match(open, /closeGraphBundle\(\{ keepList: true \}\)/);
  assert.match(open, /gBundleCollapseList\(\);\n    graphBundleBox\.showPopover\(\);/);
  assert.match(open, /まとめて開くとき一覧をたたむ/);
  const close = between('  function closeGraphBundle(', '  function hideGraphHover()');
  assert.match(close, /if \(!keepList\) \{ gBundleRestoreList\(\);/);
  const toggle = between('  function toggleGraphPanel() {', "  $('gPanelToggle')");
  assert.match(toggle, /gBundle\.collapsedList = false;/);
  assert.match(SRC, /const G_BUNDLE_LIST_PREF = 'hexMemo\.bundleCollapseList';/);
});
