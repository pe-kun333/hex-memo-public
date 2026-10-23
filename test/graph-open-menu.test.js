'use strict';

// 関係線のグラフを開く項目（マスの右クリック・左上の六角メモのメニュー）
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'renderer.js'), 'utf8');
const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const fnSrc = (name) => {
  const start = SRC.indexOf(`  function ${name}(`);
  const end = SRC.indexOf('\n  }\n', start);
  assert.ok(start > 0 && end > start, `${name} が見つからない`);
  return SRC.slice(start, end + 4);
};

test('マスの右クリック：「Dendritic Extension…」のすぐ上に「この関係線のグラフを表示」', () => {
  const at = HTML.indexOf('data-cmd="graph-open" id="cellMenuGraph"');
  const dend = HTML.indexOf('data-cmd="dend"><span>Dendritic Extension…');
  assert.ok(at > 0 && dend > at, '項目が見つからない');
  assert.equal(HTML.slice(at, dend).split('<button').length, 2, 'すぐ上（間にほかの項目が無い）');
  assert.match(SRC, /\} else if \(cmd === 'graph-open'\) openLinkGraph\(getRecord\(key\)\);/);
});

test('関係線が無いメモ・空のマスでは押せない（理由を title に）', () => {
  // eslint-disable-next-line no-new-func
  const graphOpenTarget = new Function('isEmptyRecord', 'linkGroup', `${fnSrc('graphOpenTarget')} return graphOpenTarget;`)(
    (r) => !r.text,
    (id) => new Set(id === 'linked' ? ['linked', 'other'] : [id]),
  );
  const linked = { id: 'linked', text: 'あ' };
  assert.equal(graphOpenTarget(linked), linked);
  assert.equal(graphOpenTarget({ id: 'alone', text: 'あ' }), null);
  assert.equal(graphOpenTarget({ id: 'linked', text: '' }), null);
  assert.equal(graphOpenTarget(null), null);
  assert.match(SRC, /graphBtn\.disabled = !graphTarget;/);
  assert.match(SRC, /このメモには、関係線でつながる相手がありません/);
});

test('左上のメニュー：サイドバーのメモに関係線があればそのグラフ、無ければ「グラフ」のタブ', () => {
  assert.match(HTML, /data-cmd="graph-open" id="appMenuGraph"><span id="appMenuGraphLabel">/);
  const choice = fnSrc('appMenuGraphChoice');
  assert.match(choice, /graphOpenTarget\(sideRecord\(\)\)/);
  assert.match(choice, /関係線のグラフを表示（この階層のぜんぶ）/);
  const open = fnSrc('openGraphFromAppMenu');
  assert.match(open, /if \(rec\) openLinkGraph\(rec\);/);
  assert.match(open, /if \(graph\.focus\) closeLinkGraph\(\);\s*setTab\('graph'\);/);
  assert.match(SRC, /if \(e\.newState === 'open'\) syncAppMenuGraph\(\);/);
});
