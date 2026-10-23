'use strict';

// グラフ最大化の PR2：右の欄の自動でたたむ・全体表示の余白・欄の幅をいつもあける（renderer.js）。
// 目印のコメントの間を取り出して動かす（zoom.test.js と同じやり方）
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
const Z = new Function(`${between('  // ---- 表示倍率の計算 ----', '  // ---- 表示倍率の計算ここまで ----')}; return { gFitPad, gPanelAutoStep };`)();
const fnSrc = (name) => between(`  function ${name}(`, '\n  }\n');

test('全体表示の余白：狭い区画では小さく', () => {
  assert.deepEqual(Z.gFitPad(1200), { x: 160, y: 120 });
  assert.deepEqual(Z.gFitPad(599), { x: 60, y: 50 });
});

test('右の欄：狭いと自動でたたみ、広くなれば（自動でたたんだときだけ）開き直す', () => {
  // 一覧（420）：840 未満は狭い
  assert.equal(Z.gPanelAutoStep(700, 420, true, false, false), 'close');
  assert.equal(Z.gPanelAutoStep(700, 420, true, false, true), null, '狭いのに自分で開けたら、たたまない');
  assert.equal(Z.gPanelAutoStep(1000, 420, false, true, false), 'open');
  assert.equal(Z.gPanelAutoStep(1000, 420, false, false, false), null, '自分で閉じたなら開き直さない');
  assert.equal(Z.gPanelAutoStep(1000, 420, true, false, false), null);
  assert.equal(Z.gPanelAutoStep(0, 420, true, false, false), null, '見えていない（幅 0）なら何もしない');
});

test('gFit：860px の条件をやめ、欄が開いていればいつもその幅をあける', () => {
  const fit = fnSrc('gFit');
  assert.doesNotMatch(fit, /860/);
  assert.match(fit, /const pw = !panel\.hidden \? panel\.offsetWidth \+ 24 : 0;/);
  assert.match(fit, /gFitPad\(r\.width - panelW\)/);
});

test('欄の開け閉めは graph.panelOpen ひとつ（道具の列・「›」・「‹ 一覧」が同じ関数）、最大化では変えない', () => {
  for (const id of ['gPanelToggle', 'gPanelCollapse', 'gPanelOpenTab']) {
    assert.match(SRC, new RegExp(`\\$\\('${id}'\\)\\.addEventListener\\('click', toggleGraphPanel\\)`));
    assert.match(HTML, new RegExp(`id="${id}"`));
  }
  assert.doesNotMatch(fnSrc('setGraphMax'), /panelOpen/, '最大化の前の欄の状態をそのまま使う');
  assert.match(CSS, /body\.graph-maxed \.graph-panel-open-tab:not\(\[hidden\]\) \{ display: block; \}/);
});

test('区画の大きさが変わったら、まず自動でたたむかを見る', () => {
  const ro = between('  new ResizeObserver(() => {\n    if (activeTab !== \'graph\' || gDrag || gPan) return;', '}).observe(graphSvg);');
  assert.match(ro, /applyGraphPanelAuto\(\);/);
});
