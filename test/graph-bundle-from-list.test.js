// 右の一覧の線の印から：相手の全文を浮く窓で開く・相手を真ん中にまとめて開く
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

test('線の印のとなりに「全文」「束」のボタン（相手の id を持つ）', () => {
  const acts = between('  function gListRelActions(otherId, who) {', '  const graphPanelBody');
  assert.match(acts, /el\('button', 'g-item-rel-act', '全文'\)/);
  assert.match(acts, /peek\.dataset\.gRelPeek = otherId;/);
  assert.match(acts, /el\('button', 'g-item-rel-act', '束'\)/);
  assert.match(acts, /bundle\.dataset\.gRelBundle = otherId;/);
  const item = between('  function buildGraphListItem(', '  function gListRelActions(');
  assert.match(item, /group\.append\(b, \.\.\.gListRelActions\(otherId, /);
});

test('「全文」は線の印を起点に止めた吹き出し、「束」は相手を真ん中に開き直す（ノードは選び直さない）', () => {
  const click = between("  graphPanelBody.addEventListener('click', (e) => {", "    if (e.target.closest('[data-g-read]'))");
  assert.match(click, /showGraphPeek\(chip, \{ pinned: true \}\);\n      return;/);
  assert.match(click, /openGraphBundle\(found\.rec, \{ via: 'nav' \}\);[^\n]*\n      return;/);
  assert.ok(click.indexOf('data-g-rel-peek') < click.indexOf('data-g-rel-bundle'));
});

test('束は開き直すと真ん中が入れ替わる（前の束を閉じ、一覧のたたみは引き継ぐ）', () => {
  const open = between('  function openGraphBundle(rec, ', '  // タブのページを出す');
  assert.match(open, /closeGraphBundle\(\{ keepList: true \}\)/);
});
