'use strict';

// グラフの最大化（renderer.js の setGraphMax・graphEscStep、index.html のボタン、styles.css）。
// 画面のスクリプトの中にあるので、目印のコメントの間を取り出して動かす（graph-lock.test.js と同じやり方）
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
const { graphEscStep } = new Function(`${between('  // ---- Esc の順番（ここから）', '  // ---- Esc の順番（ここまで）')}; return { graphEscStep };`)();

test('Esc の順番：線を引く途中 → 選択 → 最大化 → 絞り込み', () => {
  const all = { linking: {}, selected: {}, maxed: true, focus: {} };
  assert.equal(graphEscStep(all), 'linking');
  assert.equal(graphEscStep({ ...all, linking: null }), 'select');
  assert.equal(graphEscStep({ ...all, linking: null, selected: null }), 'max');
  assert.equal(graphEscStep({ linking: null, selected: null, maxed: false, focus: {} }), 'focus');
  assert.equal(graphEscStep({ linking: null, selected: null, maxed: false, focus: null }), null);
});

test('最大化ボタンは「全体」「一覧・概観」の隣にある', () => {
  const i = HTML.indexOf('id="gPanelToggle"');
  const j = HTML.indexOf('id="gMaxToggle"');
  assert.ok(HTML.indexOf('id="gFit"') > 0 && i > 0 && j > i, 'gMaxToggle が gPanelToggle の後ろに無い');
  assert.match(HTML, /id="gMaxToggle"[^>]*aria-pressed="false"/);
});

test('最大化は覚えない（localStorage に書かない）・はじめは最大化していない', () => {
  assert.match(SRC, /panelOpen: true, [^\n]*maxed: false,/);
  const fn = between('  function setGraphMax(', '  const toggleGraphMax');
  assert.doesNotMatch(fn, /localStorage/);
  assert.match(fn, /gFit\(/, '切り替えたら収め直す');
});

test('M キーは書いている間・線を引いている途中は効かない', () => {
  const key = between("    // M：最大化の切り替え", "    if (e.key !== 'Escape') return;");
  assert.match(key, /isTypingTarget\(e\.target\)/);
  assert.match(key, /graph\.linking/);
  assert.match(key, /e\.isComposing/);
});

test('CSS：最大化中はグラフをアプリの窓いっぱいに（fixed）', () => {
  assert.match(CSS, /body\.graph-maxed \.graph-view \{[^}]*position: fixed;[^}]*inset: 0;/);
});
