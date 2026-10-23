'use strict';

// グラフ最大化の PR3：最大化したときに隠すもの（renderer.js の gmHideParse・gmInset、index.html、styles.css）
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
  assert.ok(start > 0 && end > start, `「${from.trim()}」の部分が見つからない`);
  return SRC.slice(start, end);
};
// eslint-disable-next-line no-new-func
const G = new Function(`${between('  // ---- 最大化で隠すもの（ここから）', '  // ---- 最大化で隠すもの（ここまで）')}; return { GM_HIDE_PREF, GM_HIDE_ITEMS, gmHideParse, gmInset };`)();
const ALL = ['topbar', 'tabs', 'side', 'tools', 'legend', 'hint'];

test('隠すものは6つ・はじめは全部隠す（覚えていない・壊れているときも）', () => {
  assert.deepEqual(G.GM_HIDE_ITEMS.map((i) => i.key), ALL);
  for (const raw of [null, '', '{壊れた', '[]']) {
    assert.deepEqual(Object.values(G.gmHideParse(raw)), ALL.map(() => true), String(raw));
  }
});

test('覚えた選び方を読む（知らない項目・真偽でない値は無視）', () => {
  const h = G.gmHideParse(JSON.stringify({ tools: false, legend: false, junk: true, hint: 'x' }));
  assert.equal(h.tools, false);
  assert.equal(h.legend, false);
  assert.equal(h.hint, true);
  assert.equal('junk' in h, false);
  assert.equal(G.GM_HIDE_PREF, 'hexMemo.graphMaxHide');
});

test('見せるものの下・右からグラフを広げる', () => {
  const rects = { topbar: { bottom: 44 }, tabs: { bottom: 80 }, side: { right: 300 } };
  const hideAll = G.gmHideParse(null);
  assert.deepEqual(G.gmInset(hideAll, rects), { top: 0, left: 0 });
  assert.deepEqual(G.gmInset({ ...hideAll, topbar: false }, rects), { top: 44, left: 0 });
  assert.deepEqual(G.gmInset({ ...hideAll, tabs: false }, rects), { top: 80, left: 0 });
  assert.deepEqual(G.gmInset({ ...hideAll, side: false }, rects), { top: 0, left: 300 });
  assert.deepEqual(G.gmInset({ ...hideAll, side: false }, { ...rects, side: null }), { top: 0, left: 0 }, 'サイドバーが閉じていれば左はあけない');
});

test('画面：▾ のメニュー・戻すボタンはいつも残る・CSS で隠す', () => {
  for (const id of ['gMaxOpts', 'gMaxMenu', 'gMaxList', 'gMaxFloat', 'gMaxRestore', 'gMaxOptsFloat']) assert.match(HTML, new RegExp(`id="${id}"`));
  assert.match(SRC, /\$\('gMaxFloat'\)\.hidden = !\(on && gmHide\.tools\);/);
  assert.match(SRC, /\$\('gMaxRestore'\)\.addEventListener\('click', \(\) => setGraphMax\(false\)\);/);
  assert.match(CSS, /body\.gm-hide-tools \.graph-tools/);
  assert.match(CSS, /top: var\(--gm-top, 0px\); left: var\(--gm-left, 0px\);/);
  assert.match(between('  function setGraphMax(', '  const toggleGraphMax'), /syncGraphMaxLayout\(\);/);
});

test('道具の列を隠しても、グラフの区画は 2 行目（1fr）のまま（最大化で縦が 150px に縮む不具合）', () => {
  assert.match(CSS, /\.graph-view \{[^}]*grid-template-rows: auto minmax\(0, 1fr\);/);
  assert.match(CSS, /\.graph-tools \{ grid-row: 1; \}/);
  assert.match(CSS, /\.graph-stage \{ grid-row: 2;/);
});
