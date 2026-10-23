'use strict';

// グラフのノードに重ねたときのカード（renderer.js の gHoverModel・gHoverPlace、index.html、styles.css）
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
const H = new Function(`${between('  // ---- ノードのカード：純粋な関数（ここから', '  // ---- ノードのカード：純粋な関数（ここまで')}; return { gHoverModel, gHoverPlace, gInlineSegments };`)();
const deps = { title: (r) => (r.text.split('\n').find((l) => l.trim()) || '').trim(), tags: (r) => r.tags || [], tagLabel: (n) => n.toUpperCase() };

test('中身：題名・その後の本文は 3 行まで（続きがあれば more）・タグ・コメント数', () => {
  const m = H.gHoverModel({ text: '\n題名の行\n\n本文1\n本文2', tags: ['a', 'b'], comments: [{}, {}] }, '(1, 2)', deps);
  assert.equal(m.title, '題名の行');
  assert.deepEqual(m.body, ['本文1', '本文2']);
  assert.equal(m.more, false);
  assert.deepEqual(m.tags, ['A', 'B']);
  assert.equal(m.comments, 2);
  assert.equal(m.where, '(1, 2)');
  const long = { text: '題\n1\n2\n3\n4\n5' };
  const short = H.gHoverModel(long, '', deps);
  assert.deepEqual(short.body, ['1', '2', '3']);
  assert.equal(short.more, true);
  const full = H.gHoverModel(long, '', deps, { full: true });
  assert.deepEqual(full.body, ['1', '2', '3', '4', '5'], '左クリックで開いたときは本文ぜんぶ');
  assert.equal(full.more, false);
  assert.equal(H.gHoverModel({ text: '  ' }, '', deps).empty, true);
  assert.deepEqual(H.gHoverModel({ text: '題名だけ' }, '', deps).body, []);
});

test('書き方：**太字** と `コード` を区切る（閉じていない印はそのまま）', () => {
  assert.deepEqual(H.gInlineSegments('**覚える**'), [{ text: '覚える', bold: true, code: false }]);
  assert.deepEqual(H.gInlineSegments('- 間隔を**空けて**復習 `npm`'), [
    { text: '- 間隔を', bold: false, code: false },
    { text: '空けて', bold: true, code: false },
    { text: '復習 ', bold: false, code: false },
    { text: 'npm', bold: false, code: true },
  ]);
  assert.deepEqual(H.gInlineSegments('2 * 3 と **閉じない'), [{ text: '2 * 3 と **閉じない', bold: false, code: false }]);
  assert.deepEqual(H.gInlineSegments(''), []);
});

test('左クリック：今まで通り選ぶ＋カードを開く（本文ぜんぶ）。Alt・線を引く途中はカードを開かない', () => {
  const click = between('  function gNodeClick(', '  function gSelect(');
  const linkAt = click.indexOf('gCompleteLinking(rec)');
  const altAt = click.indexOf('gStartLinking(rec)');
  const pinAt = click.indexOf("showGraphHover(gNodeEls.get(next), { pinned: true })");
  assert.ok(linkAt > 0 && altAt > linkAt && pinAt > altAt, '線を引く・Alt の判断が先');
  assert.match(click, /gSelect\(next\);/);
  assert.match(click, /else hideGraphHover\(\);/, 'もう一度押して選ぶのをやめたら閉じる');
});

test('開いたカード：Esc でまず閉じる・外を押すと閉じる・ほかに重ねても入れ替えない・ホイールで付いていく', () => {
  assert.match(SRC, /if \(gHover\.pinned\) \{ hideGraphHover\(\); return; \}/);
  const esc = SRC.indexOf('if (gHover.pinned) { hideGraphHover(); return; }');
  assert.ok(esc > 0 && esc < SRC.indexOf('const step = graphEscStep(graph);'), 'Esc はほかの段より先');
  assert.match(SRC, /if \(!pinned && gHover\.pinned\) return;/);
  assert.match(SRC, /graphHoverBox\.contains\(e\.target\) \|\| \(e\.target\.closest && e\.target\.closest\('\.g-node'\)\)/);
  assert.match(SRC, /if \(gHover\.pinned\) requestAnimationFrame\(placeGraphHover\);/);
  assert.match(CSS, /\.g-hover-card\.is-pinned \{[^}]*pointer-events: auto;[^}]*overflow-y: auto;/);
  assert.doesNotMatch(between('  function gRichLine(', '  function showGraphHover('), /innerHTML/);
});

test('置き場所：ノードの右 → 右の欄にかかるなら左 → どちらも無理なら下', () => {
  const view = { w: 1200, h: 800 };
  const size = { w: 320, h: 160 };
  const a = { left: 100, right: 140, top: 200, bottom: 240 };
  assert.equal(H.gHoverPlace(a, size, view, null).side, 'right');
  const nearPanel = { left: 600, right: 640, top: 200, bottom: 240 };
  assert.equal(H.gHoverPlace(nearPanel, size, view, { left: 800 }).side, 'left', '右の欄に重ねない');
  assert.equal(H.gHoverPlace({ left: 300, right: 340, top: 200, bottom: 240 }, size, { w: 640, h: 800 }, null).side, 'below');
  assert.ok(H.gHoverPlace({ ...a, top: 780, bottom: 800 }, size, view, null).y <= 800 - 160 - 8, '画面の下からはみ出さない');
  const low = H.gHoverPlace({ left: 300, right: 340, top: 700, bottom: 740 }, size, { w: 640, h: 800 }, null);
  assert.equal(low.side, 'above', '下に入らなければノードの上（ノードを隠さない）');
  assert.equal(low.y, 700 - 10 - 160);
});

test('ブラウザの title はやめ、300ms 待ってカードを出す・一覧の吹き出しとは同時に出さない', () => {
  assert.doesNotMatch(between("        g = svgEl('g', { class: 'g-node'", "        g.addEventListener('dblclick'"), /svgEl\('title'\)/);
  assert.match(SRC, /const G_HOVER_DELAY = 300;/);
  assert.match(between('  function showGraphPeek(', '  function hideGraphPeek('), /hideGraphHover\(\);/);
  assert.match(between('  function showGraphHover(', '  function hideGraphHover('), /gPeek\.pinned \|\| gPeekOpen\(\)/);
  assert.match(HTML, /id="graphHoverCard" popover="manual"/);
  assert.match(CSS, /\.g-hover-card \{ position: fixed;/);
});
