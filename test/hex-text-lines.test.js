'use strict';

// 六角形の文字量（renderer.js の textLinesParse・gNodeLabelLines・overviewLines、index.html のメニュー、styles.css）
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
const T = new Function(`${between('  // ---- 六角形の文字量（ここから', '  // ---- 六角形の文字量（ここまで')}; return { TEXT_LINES_PREF, TEXT_LINES_DEFAULT, textLinesParse, gNodeLabelLines, overviewLines, gPlainLabel, G_NO_START };`)();

test('覚える場所とはじめの値（今までと同じ見た目）', () => {
  assert.deepEqual(T.TEXT_LINES_PREF, { graph: 'hexMemo.graphLines', honey: 'hexMemo.honeyLines' });
  assert.deepEqual(T.TEXT_LINES_DEFAULT, { graph: 2, honey: 6 });
  assert.equal(T.textLinesParse('graph', null), 2);
  assert.equal(T.textLinesParse('graph', '3'), 3);
  assert.equal(T.textLinesParse('graph', '6'), 2, 'グラフに 6 は無い');
  assert.equal(T.textLinesParse('honey', '6'), 6);
  assert.equal(T.textLinesParse('honey', '1'), 1);
  assert.equal(T.textLinesParse('honey', 'x'), 6);
});

test('グラフ：幅を測って折り返す（測れないときは目安の幅。全角 1 文字＝文字の大きさ）', () => {
  const s = '主張：朝の散歩は午前の集中力を上げる';
  assert.deepEqual(T.gNodeLabelLines(s, 2), ['主張：朝の散歩', 'は午前の集中…'], '2 行は今まで通りの見た目');
  assert.deepEqual(T.gNodeLabelLines(s, 1), ['主張：朝の散歩は午…']);
  assert.deepEqual(T.gNodeLabelLines(s, 3), ['主張：朝の散歩', 'は午前の集中力を', '上げる'], '3 行は真ん中が広い');
  assert.deepEqual(T.gNodeLabelLines('短い', 2), ['短い']);
  assert.deepEqual(T.gNodeLabelLines('', 2), ['（本文なし）']);
});

test('グラフ：半角は狭いので多く入る・測る関数を渡せる', () => {
  assert.deepEqual(T.gNodeLabelLines('Meeting notes about the API', 2), ['Meeting', 'notes about…'], '英単語の途中では切らない');
  const wide = (str) => [...str].length * 20; // 1 文字 20px
  assert.deepEqual(T.gNodeLabelLines('あいうえおかきくけこ', 2, wide), ['あいう', 'えお…']);
});

test('グラフ：句読点は行の頭に来ない・開きかっこは行の終わりに来ない', () => {
  const l = T.gNodeLabelLines('あいうえおかき。くけこさしすせそ', 2);
  assert.equal(l[0], 'あいうえおかき。', '「。」は前の行にぶら下げる');
  assert.ok(!T.G_NO_START.has([...l[1]][0]));
  const k = T.gNodeLabelLines('あいうえおか「きく」けこさし', 2);
  assert.equal(k[0], 'あいうえおか', '「「」は次の行へ');
  assert.ok(k[1].startsWith('「きく」'));
});

test('グラフ：**太字** や `コード` の印は出さない', () => {
  assert.equal(T.gPlainLabel('**覚える**ことと`code`'), '覚えることとcode');
  assert.equal(T.gPlainLabel('## 見出し'), '見出し');
  assert.equal(T.gPlainLabel('- 箇条の**途中'), '箇条の途中');
  assert.deepEqual(T.gNodeLabelLines('**覚える**', 2), ['覚える']);
});

test('全体表示：選んだ行数より多くは出さない（今まで通りなら自動のまま）', () => {
  assert.equal(T.overviewLines(5, 6), 5);
  assert.equal(T.overviewLines(5, 2), 2);
  assert.equal(T.overviewLines(1, 3), 1);
});

test('メニュー：左上の六角メモのメニューに、グラフ 1/2/3 とハニカム 1/2/3/今まで通り', () => {
  for (const n of [1, 2, 3]) assert.match(HTML, new RegExp(`data-text-lines="graph" data-lines="${n}"`));
  for (const n of [1, 2, 3, 6]) assert.match(HTML, new RegExp(`data-text-lines="honey" data-lines="${n}"`));
  const menu = between("  appMenu.addEventListener('click', async (e) => {", '    appMenu.hidePopover();');
  assert.match(menu, /setTextLines\(btn\.dataset\.textLines, Number\(btn\.dataset\.lines\)\);\s*return;/, '押してもメニューは閉じない');
  assert.match(between('  function setTextLines(', '  async function openAppMenu('), /localStorage\.setItem\(TEXT_LINES_PREF\[kind\]/);
});

test('CSS：ハニカムの行数・全体表示・グラフの 3 行の小さい文字', () => {
  for (const n of [1, 2, 3]) assert.match(CSS, new RegExp(`\\.stage\\[data-body-lines="${n}"\\] \\.cell \\.body-text \\{ -webkit-line-clamp: ${n}; \\}`));
  assert.match(CSS, /\.stage\.is-overview\[data-body-lines\] \.cell \.body-text \{ -webkit-line-clamp: var\(--ov-lines, 3\); \}/);
  assert.match(CSS, /#graphSvg\.is-lines-3 .*font-size: 9\.5px;/);
});
