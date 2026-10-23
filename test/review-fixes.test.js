'use strict';

// レビューで見つかった不具合の直し（renderer.js）。画面のスクリプトの中なので、該当の部分を取り出して、
// 動かせるものは動かし、置き場所が大事なものは「どの順に書いてあるか」で確かめる
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'renderer.js'), 'utf8');

// 2 字下げの function の本体（次の「\n  }\n」まで）
function fn(name) {
  const start = SRC.indexOf(`\n  function ${name}(`);
  assert.ok(start > 0, `function ${name} が見つからない`);
  const end = SRC.indexOf('\n  }\n', start);
  assert.ok(end > start, `function ${name} の終わりが見つからない`);
  return SRC.slice(start, end + 4);
}
const before = (text, a, b) => {
  const i = text.indexOf(a);
  const j = text.indexOf(b);
  assert.ok(i >= 0, `見つからない：${a}`);
  assert.ok(j >= 0, `見つからない：${b}`);
  assert.ok(i < j, `「${a}」は「${b}」より前にある`);
};

test('F1 流れの配置は fitPending を下ろす（残ると固定が効かなくなる）', () => {
  const body = fn('gLayoutFlow');
  before(body, 'graph.fitPending = false;', 'const nodes = graphNodes();');
  before(body, 'graph.fitPending = false;', 'gFit(true);');
});

test('F2 他のウィンドウの内容を読み直しても、固定中の位置の控えは消えない（足し込む）', () => {
  const body = fn('applyRemoteStore');
  const from = body.indexOf('if (graph.locked) {');
  const to = body.indexOf('graph.pos.clear();');
  assert.ok(from > 0 && to > from);
  const run = (graph) => new Function('graph', `${body.slice(from, to)}; return graph;`)(graph); // eslint-disable-line no-new-func
  const a = { id: 'a' };
  const b = { id: 'b' };
  const noId = {};
  // 1回目：表示中の位置を控える
  const graph = { locked: true, lockPos: null, pos: new Map([[a, { x: 1, y: 2 }], [noId, { x: 9, y: 9 }]]) };
  run(graph);
  assert.deepEqual([...graph.lockPos], [['a', [1, 2]]]);
  // 2回目（別のタブにいて pos が空）：前の控えを消さない
  graph.pos = new Map();
  run(graph);
  assert.deepEqual([...graph.lockPos], [['a', [1, 2]]]);
  // 新しく動いたメモは上書き、増えたメモは足す
  graph.pos = new Map([[a, { x: 5, y: 6 }], [b, { x: 7, y: 8 }]]);
  run(graph);
  assert.deepEqual([...graph.lockPos].sort(), [['a', [5, 6]], ['b', [7, 8]]]);
  // 固定していなければ控えは捨てる
  graph.locked = false;
  run(graph);
  assert.equal(graph.lockPos, null);
});

test('F3 グラフのキー（F・Esc）は、ノートのハニカムを出している間は効かない', () => {
  const at = SRC.indexOf("if (activeTab !== 'graph' || anyDialogOpen()) return;");
  assert.ok(at > 0);
  const listener = SRC.slice(at, SRC.indexOf("if (e.key !== 'Escape') return;", at));
  before(listener, 'if (hive.open', "e.code === 'KeyF'");
});

test('F4 renderGraphView は種類のボタンを gKeepView 越しに描く（上段の高さの変化で飛ばない）', () => {
  const body = fn('renderGraphView');
  // 固定していないときだけ（固定中は gHoldView が打ち消す。ここで先に gLastRect を更新するとタブに戻ったときの左端のずれが残る）
  assert.match(body, /if \(gCamFree\(\)\) gKeepView\(renderGraphKinds\);\n\s*else renderGraphKinds\(\);/);
  // そのあとの fitPending による全体表示は残っている
  before(body, 'gKeepView(renderGraphKinds)', 'graph.fitPending = false; gFit();');
  // グラフのタブでなければ、ただ呼ぶだけ
  const keep = fn('gKeepView');
  before(keep, "activeTab !== 'graph'", 'mutate();');
});

test('F5 Tab で行にフォーカスして出した吹き出しは、フォーカスのスクロールでは消さず置き直す', () => {
  const at = SRC.indexOf("graphPanelBody.addEventListener('scroll'");
  assert.ok(at > 0);
  const listener = SRC.slice(at, SRC.indexOf('}, { passive: true });', at));
  assert.match(listener, /document\.activeElement/);
  assert.match(listener, /:focus-visible/);
  assert.match(listener, /!gPeek\.pinned/);
  before(listener, 'layoutGraphPeek()', 'hideGraphPeek()');
  // ホイールは今までどおり消す
  assert.match(SRC, /graphPanelBody\.addEventListener\('wheel', hideGraphPeek/);
});

test('F6 長押しで止めた直後に遅れて来るクリックでは、止めた吹き出しを閉じない', () => {
  assert.match(fn('showGraphPeek'), /if \(pinned\) gPeek\.pinnedAt = performance\.now\(\)/);
  const at = SRC.indexOf("document.addEventListener('click', (e) => {\n    // 長押しで止めた直後");
  assert.ok(at > 0);
  const listener = SRC.slice(at, SRC.indexOf('}, true);', at));
  before(listener, 'gPeek.pinned', 'hideGraphPeek()');
  assert.match(listener, /gPeek\.anchor\.contains\(e\.target\)/);
  assert.match(listener, /gPeek\.pinnedAt < 1500/);
  // 全体の swallowClick は変えていない
  assert.match(SRC, /swallowClick = \{ target: p\.target, until: performance\.now\(\) \+ 1500 \}/);
});

test('F7 50% 未満で固定中は、書き始められないことを知らせる（固定は破らない）', () => {
  const msg = '倍率を 50% 未満で固定しているため、書き始められません（右上の倍率から解除）';
  assert.ok(SRC.includes(msg));
  // 判断だけを動かす
  const warn = fn('warnOverviewLocked');
  const run = (state) => {
    const toasts = [];
    const f = new Function('state', 'toast', 'lockedZoom', 'OVERVIEW_LOCKED_MSG', `let isOverview = state.overview; ${warn}; return warnOverviewLocked();`); // eslint-disable-line no-new-func
    const r = f(state, (m, k) => toasts.push([m, k]), () => state.lock, msg);
    return { r, toasts };
  };
  assert.deepEqual(run({ overview: true, lock: 0.25 }).toasts, [[msg, 'warn']]);
  assert.equal(run({ overview: true, lock: null }).r, false); // 固定していない
  assert.equal(run({ overview: false, lock: 0.75 }).r, false); // 50% 以上
  // 使っている場所：すぐ書き始める・関連付けて新しいメモ（全体表示）
  assert.match(fn('focusEmptyCell'), /else warnOverviewLocked\(\)/);
  const at = SRC.indexOf('if (linking.create) {\n        if (isOverview) {');
  assert.ok(at > 0);
  assert.match(SRC.slice(at, at + 300), /warnOverviewLocked\(\)/);
});

test('F8 グラフを見ている間に変わったハニカムの倍率の固定を、ハニカムのタブに戻ったとき合わせる', () => {
  const body = fn('setTab');
  const at = body.indexOf('if (grid) {');
  const grid = body.slice(at, body.indexOf('} else if (isGraph) {', at));
  before(grid, 'measureView()', 'enforceGridZoomLock()');
  before(grid, 'enforceGridZoomLock()', 'render()');
});

test('F9 小窓では倍率のメニューを出さず、Ctrl+Shift+1〜6 は固定を付けも外しもしない', () => {
  assert.match(SRC, /cmd === 'zoom-menu'\) \{ if \(!miniMode\) openZoomMenu\(\); \}/);
  assert.match(SRC, /btn\.dataset\.cmd === 'zoom-menu'\) \{\n\s+if \(!miniMode\) openZoomMenu\(\);/);
  // 小窓では固定の倍率が無い（null）ので、登録の動作は「倍率だけ合わせる」になる
  assert.match(fn('zoomLockPct'), /if \(miniMode\) return null;/);
  const f = new Function(`const ZOOM_RANGE = { grid: [4, 150], graph: [20, 250] }; ${fn('zoomClampPct')}; ${fn('zoomPresetAction')}; return zoomPresetAction;`)(); // eslint-disable-line no-new-func
  assert.deepEqual(f([25, 50, 75, 100, 125, 150], 3, null, 'grid', true), { pct: 100, lock: undefined }); // 固定が無い（小窓）→ 付けも外しもしない
});

test('F10 開いている凡例の下に隠れたノードも、画面の外と同じに知らせる', () => {
  const body = fn('gUnderLegend');
  const rects = { legend: { left: 20, top: 400, right: 220, bottom: 480, width: 200, height: 80 }, svg: { left: 10, top: 100 } };
  const make = (closed, legendRect) => new Function('legendClosed', '$', 'graphSvg', 'graph', 'gInView', `${body}; return gUnderLegend;`)( // eslint-disable-line no-new-func
    closed,
    () => ({ getBoundingClientRect: () => legendRect }),
    { getBoundingClientRect: () => rects.svg },
    { cam: { x: 0, y: 0, k: 1 } },
    (p, cam, v) => { const sx = cam.x + p.x * cam.k; const sy = cam.y + p.y * cam.k; return sx >= v.left && sx <= v.right && sy >= v.top && sy <= v.bottom; },
  );
  const under = make(false, rects.legend);
  assert.equal(under({ x: 50, y: 350 }), true); // 画面 (60, 450)：凡例の中
  assert.equal(under({ x: 50, y: 100 }), false);
  assert.equal(make(true, rects.legend)({ x: 50, y: 350 }), false); // たたんでいる凡例は見ない
  assert.equal(make(false, { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 })({ x: 0, y: 0 }), false); // 隠れている
  assert.match(fn('gPing'), /!gInView\(p, graph\.cam, gViewBox\(\)\) \|\| gUnderLegend\(p\)/);
});

test('F11 種類の見出しボタンは自分の親を aria-controls で指さない（aria-expanded は残す）', () => {
  const body = fn('renderGraphKinds');
  assert.doesNotMatch(body, /aria-controls/);
  assert.match(body, /head\.setAttribute\('aria-expanded'/);
});
