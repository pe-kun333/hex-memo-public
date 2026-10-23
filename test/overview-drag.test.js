'use strict';

// 縮小中（全体表示・50% 未満）でもメモを動かせる・クリックで編集を選べる（renderer.js）。
// 画面のスクリプトの中にあるので、zoom.test.js と同じく関数を取り出して確かめる
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'renderer.js'), 'utf8');
const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const fnSrc = (name) => {
  const start = SRC.indexOf(`\n  function ${name}(`);
  assert.ok(start > 0, `function ${name} が見つからない`);
  const end = SRC.indexOf('\n  }\n', start);
  return SRC.slice(start, end + 4);
};

function overviewMemoCellWith(state) {
  // eslint-disable-next-line no-new-func
  return new Function(...Object.keys(state), `${fnSrc('overviewMemoCell')}; return overviewMemoCell;`)(...Object.values(state));
}
const cellEl = (key, ghost = false) => {
  const cell = { _key: key, classList: { contains: (c) => ghost && c === 'drag-ghost' } };
  return { closest: (sel) => (sel === '.cell' ? cell : null), cell };
};
const base = () => ({
  isOverview: true, comboAdjust: null, linking: null, selectMode: false, tplPlacing: null, shelfPlacing: null, reading: null, drag: null,
  getRecord: (k) => (k === 'memo' || k === 'c' ? { text: 'x' } : k === 'empty' ? { text: '' } : undefined),
  isEmptyRecord: (r) => !r.text,
  isCenter: (k) => k === 'c',
});

test('全体表示：メモのマスはつかめる（空いたマス・中心・ゴーストはつかまない）', () => {
  const f = overviewMemoCellWith(base());
  const t = cellEl('memo');
  assert.equal(f(t), t.cell);
  assert.equal(f(cellEl('empty')), null);
  assert.equal(f(cellEl('none')), null);
  assert.equal(f(cellEl('c')), null);
  assert.equal(f(cellEl('memo', true)), null);
  assert.equal(f({ closest: () => null }), null);
});

test('全体表示でないとき・選択モードや関連付けの途中は、今までどおり（つかまない）', () => {
  for (const k of ['isOverview', 'selectMode', 'linking', 'comboAdjust', 'tplPlacing', 'shelfPlacing', 'reading', 'drag']) {
    const s = base();
    s[k] = k === 'isOverview' ? false : {};
    assert.equal(overviewMemoCellWith(s)(cellEl('memo')), null, k);
  }
});

test('全体表示に切り替わっても、ドラッグ中の移動はやめない', () => {
  assert.doesNotMatch(fnSrc('setOverview'), /endDrag\(\)/);
});

test('長押しのまま動かすとメモを移動：全体表示でも使える', () => {
  assert.doesNotMatch(fnSrc('touchLongPress'), /isOverview/);
});

test('全体表示のドラッグ：ゴーストは見失わない大きさを下限にする', () => {
  // eslint-disable-next-line no-new-func
  const scale = (ov) => new Function('isOverview', `${fnSrc('dragGhostScale')}; return dragGhostScale;`)(ov);
  assert.equal(scale(true)(0.04), 0.3);
  assert.ok(Math.abs(scale(true)(0.45) - 0.405) < 1e-9);
  assert.ok(Math.abs(scale(false)(0.6) - 0.54) < 1e-9);
});

test('縮小中のメモのクリック：「編集する」を選べ、既定は「拡大する」', () => {
  assert.match(HTML, /id="zoomOverviewClick"[\s\S]*value="zoom"[\s\S]*value="edit"/);
  assert.match(SRC, /const ovCell = mode !== 'zoom' && overviewMemoCell\(e\.target\);\n\s+if \(ovCell && mode === 'pin'\) pinPeek\(ovCell\);\n\s+else if \(ovCell\) editFromOverview/);
  assert.match(fnSrc('editFromOverview'), /startEdit\(key\)/);
});
