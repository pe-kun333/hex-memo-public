'use strict';

// 関連グラフの「固定」（renderer.js）。画面のスクリプトの中にあるので、印のコメントの間をそのまま取り出して動かす
//（merge.test.js・graphkinds.test.js と同じやり方）
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { buildIndex } = require('../scripts/build-web.js');

const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'renderer.js'), 'utf8');

const between = (from, to) => {
  const start = SRC.indexOf(from);
  const end = SRC.indexOf(to, start + 1);
  assert.ok(start > 0 && end > start, `「${from.trim()}」の部分が見つからない`);
  return SRC.slice(start, end);
};

// 計算だけの関数（DOM にも graph にも触らない）
// eslint-disable-next-line no-new-func
const { gLockShift, gInView, gPlaceNear } = new Function(`${between('  // ---- 固定（グラフ）の計算 ----', '  // ---- 固定（グラフ）の計算 ここまで ----')}; return { gLockShift, gInView, gPlaceNear };`)();

// 「自動で動かしてよいか」の判断（graph だけを見る）
const loadGate = (graph) => new Function('graph', `${between('  // ---- 固定：グラフのカメラ・並びを自動で動かしてよいか', '  // ---- 固定（グラフ）の計算 ----')}; return { graphLocked, gCamFree, gLayoutFree };`)(graph); // eslint-disable-line no-new-func

// 大きさが変わったときの打ち消し（gHoldView）：graphSvg の矩形とカメラの描き直しだけを差し替えて動かす
function loadHoldView(graph, rectRef) {
  const code = between('  // ---- 固定 ----\n', '  // 見える範囲（graphSvg の左上を 0 として');
  const graphSvg = { getBoundingClientRect: () => rectRef.r };
  let drawn = 0;
  const gCam = () => { drawn++; };
  const gate = loadGate(graph);
  // eslint-disable-next-line no-new-func
  const api = new Function('graph', 'graphSvg', 'gCam', 'gLockShift', 'gCamFree', `${code}; return { gHoldView, last: () => gLastRect };`)(graph, graphSvg, gCam, gLockShift, gate.gCamFree);
  return { ...api, drawn: () => drawn };
}
const rect = (left, top, right, bottom) => ({ left, top, right, bottom, width: right - left, height: bottom - top });

test('固定：サイドバーが開いて左端だけ動いたら、丸が画面の同じ場所に残るように x をずらす', () => {
  assert.deepEqual(gLockShift({ left: 100, right: 900 }, { left: 420, right: 900 }, { x: 50, y: 0, k: 1 }), { x: -270, y: 0, k: 1 });
  // 閉じたとき（左へ戻る）も同じ。倍率はそのまま
  assert.deepEqual(gLockShift({ left: 420, right: 900 }, { left: 100, right: 900 }, { x: -270, y: 5, k: 0.6 }), { x: 50, y: 5, k: 0.6 });
});

test('固定：上段の高さが変わって上端だけ動いたら y をずらす。左と上が同時でも両方', () => {
  assert.deepEqual(gLockShift(rect(0, 100, 800, 700), rect(0, 40, 800, 700), { x: 10, y: 20, k: 1 }), { x: 10, y: 80, k: 1 });
  assert.deepEqual(gLockShift(rect(0, 100, 800, 700), rect(300, 140, 800, 700), { x: 10, y: 20, k: 1 }), { x: -290, y: -20, k: 1 });
});

test('固定：窓の大きさが変わった（両端が動いた）・前回が無い・変わらないときは、カメラをそのまま返す', () => {
  const cam = { x: 50, y: 0, k: 1 };
  assert.equal(gLockShift({ left: 100, right: 900 }, { left: 100, right: 1200 }, cam), cam); // 右だけ
  assert.equal(gLockShift({ left: 100, right: 900 }, { left: 0, right: 1200 }, cam), cam); // 両方
  assert.equal(gLockShift(null, { left: 420, right: 900 }, cam), cam);
  assert.equal(gLockShift(rect(0, 0, 800, 600), rect(0, 0, 800, 600), cam), cam);
  // 0.5px 未満のずれ（小数の丸め）は動かさない
  assert.equal(gLockShift(rect(100, 0, 800, 600), rect(100.3, 0, 800, 600), cam), cam);
});

test('固定：見える範囲の判定（画面の位置は cam.x + p.x * k）。右の一覧の下に隠れたメモは外', () => {
  const view = { left: 0, top: 0, right: 600, bottom: 400 }; // 幅 1000 の SVG の右 400 を一覧が覆う
  const cam = { x: 100, y: 50, k: 0.5 };
  assert.equal(gInView({ x: 0, y: 0 }, cam, view), true); // (100, 50)
  assert.equal(gInView({ x: 900, y: 0 }, cam, view), true); // (550, 50)
  assert.equal(gInView({ x: 1100, y: 0 }, cam, view), false); // (650, 50)：一覧の下
  assert.equal(gInView({ x: -300, y: 0 }, cam, view), false); // (-50, 50)：左の外
  assert.equal(gInView({ x: 0, y: 800 }, cam, view), false); // (100, 450)：下の外
});

test('固定：新しく出たメモは、位置のある相手の近く（60〜140px）に置く。相手がいなければ入れない', () => {
  const pos = new Map([['a', [100, 100]], ['b', [400, 0]]]);
  const edges = [{ a: 'a', b: 'n1' }, { a: 'n2', b: 'b' }, { a: 'x', b: 'y' }];
  const out = gPlaceNear(['n1', 'n2', 'lonely'], pos, edges);
  const dist = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]);
  assert.ok(dist(out.get('n1'), pos.get('a')) >= 60 && dist(out.get('n1'), pos.get('a')) <= 140);
  assert.ok(dist(out.get('n2'), pos.get('b')) >= 60 && dist(out.get('n2'), pos.get('b')) <= 140);
  assert.equal(out.has('lonely'), false);
  // 右下へ（gCreateLinkedMemo の置き方と同じ向き）
  assert.ok(out.get('n1')[0] > 100 && out.get('n1')[1] > 100);
});

test('固定：すでに位置のあるメモは動かさない。同じ相手に何件出ても重ならず、新しいメモ同士は置けたほうからたどる', () => {
  const pos = new Map([['a', [0, 0]]]);
  const edges = [{ a: 'a', b: 'n1' }, { a: 'a', b: 'n2' }, { a: 'a', b: 'n3' }, { a: 'n3', b: 'n4' }, { a: 'a', b: 'old' }];
  const out = gPlaceNear(['n4', 'n1', 'n2', 'n3', 'old', 'old'], new Map([...pos, ['old', [5, 5]]]), edges);
  assert.equal(out.has('old'), false);
  assert.deepEqual([...out.keys()].sort(), ['n1', 'n2', 'n3', 'n4']);
  const pts = ['n1', 'n2', 'n3'].map((id) => out.get(id));
  for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) assert.ok(Math.hypot(pts[i][0] - pts[j][0], pts[i][1] - pts[j][1]) > 40);
  // n4 は n3（新しいメモ）の近く
  const d = Math.hypot(out.get('n4')[0] - out.get('n3')[0], out.get('n4')[1] - out.get('n3')[1]);
  assert.ok(d >= 60 && d <= 140);
  assert.equal(gPlaceNear([], pos, edges).size, 0);
});

test('固定：自動でカメラ・並びを動かしてよいかの判断（はじめの一度と、はっきり頼んだ並べ直しは通す）', () => {
  const cases = [
    // [locked, camReady, fitPending] → [camFree, layoutFree]
    [[false, false, false], [true, true]],
    [[false, true, false], [true, true]], // 外していれば、今までどおり
    [[true, false, false], [true, true]], // 固定中でも、はじめて開いたとき・ノートを切り替えたときは一度合わせる
    [[true, true, false], [false, false]], // 固定中：データの変更・タブに戻る・大きさの変化では動かさない
    [[true, true, true], [false, true]], // 力学・流れ・範囲・この関係線のグラフ：並べ直す（全体表示は fitPending を消すときだけ）
  ];
  for (const [[locked, camReady, fitPending], [camFree, layoutFree]] of cases) {
    const g = loadGate({ locked, camReady, fitPending });
    assert.equal(g.graphLocked(), locked);
    assert.equal(g.gCamFree(), camFree, JSON.stringify({ locked, camReady, fitPending }));
    assert.equal(g.gLayoutFree(), layoutFree, JSON.stringify({ locked, camReady, fitPending }));
  }
});

test('固定：ResizeObserver の打ち消し（gHoldView）は固定中だけカメラをずらし、外しているときは位置を覚えるだけ', () => {
  const ref = { r: rect(0, 100, 1000, 700) };
  const graph = { locked: true, camReady: true, fitPending: false, cam: { x: 50, y: 20, k: 1 } };
  const hv = loadHoldView(graph, ref);
  hv.gHoldView(); // 前回が無い：覚えるだけ
  assert.deepEqual(graph.cam, { x: 50, y: 20, k: 1 });
  ref.r = rect(320, 100, 1000, 700); // サイドバーが開いた
  hv.gHoldView();
  assert.deepEqual(graph.cam, { x: -270, y: 20, k: 1 });
  assert.equal(hv.drawn(), 1);
  hv.gHoldView(); // 同じ大きさでもう一度（gPing の後の ResizeObserver）：二重にずらさない
  assert.deepEqual(graph.cam, { x: -270, y: 20, k: 1 });
  ref.r = rect(0, 0, 0, 0); // 隠れた（ハニカムのタブ）：覚えている矩形を壊さない
  hv.gHoldView();
  assert.equal(hv.last().left, 320);
  // 外しているとき：ずらさない（全体表示は ResizeObserver の gFit がこれまでどおりする）が、位置は覚え直す
  graph.locked = false;
  ref.r = rect(0, 100, 1000, 700);
  hv.gHoldView();
  assert.deepEqual(graph.cam, { x: -270, y: 20, k: 1 });
  assert.equal(hv.last().left, 0);
});

test('固定：ボタンは「関連の無いメモも出す」の後・「全体」の前にあり、ブラウザ版（buildIndex）にも入る', () => {
  for (const html of [fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8'), buildIndex()]) {
    const tools = html.slice(html.indexOf('<div class="graph-tools">'), html.indexOf('<div class="graph-stage"'));
    const btn = tools.match(/<button[^>]*id="gLockBtn"[^>]*>([^<]*)<\/button>/);
    assert.ok(btn, '固定のボタンが .graph-tools に無い');
    assert.equal(btn[1], '固定');
    assert.match(btn[0], /class="btn small"/);
    assert.match(btn[0], /aria-pressed="false"/);
    assert.match(btn[0], /data-icon="lock"/);
    assert.match(btn[0], /title="[^"]*固定[^"]*（F）"/);
    assert.ok(tools.indexOf('id="gIsolatedWrap"') < tools.indexOf('id="gLockBtn"') && tools.indexOf('id="gLockBtn"') < tools.indexOf('id="gFit"'));
    assert.match(html, /class="graph-hint">[^<]*<br>[^<]*「固定」（F）/);
  }
  assert.match(SRC, /\n {4}lock: '<rect /); // ICONS に南京錠
});

test('固定：一覧・線の印・概観で押しても、固定中は真ん中へ寄せずに光らせるだけ', () => {
  const list = SRC.slice(SRC.indexOf("graphPanelBody.addEventListener('click'"));
  assert.match(list.slice(0, 3000), /gSelect\(target\);\s*if \(graphLocked\(\)\) gPing\(target\);[^\n]*\n\s*else gCenterOn\(target\);/);
  assert.match(SRC, /gSelect\(n\.rec\);\s*if \(graphLocked\(\)\) gPing\(n\.rec\);[^\n]*\n\s*else gCenterOn\(n\.rec\);/);
  // gCenterOn を条件なしで呼ぶ所は残っていない
  assert.equal((SRC.match(/^\s*gCenterOn\(/gm) || []).length, 0);
  // 光らせる印は drawGraph の class の組み立てに入れる（classList.add では次の描画で消える）
  assert.ok(SRC.includes("${graph.flash && graph.flash.rec === rec ? ' is-flash' : ''}"));
  const css = fs.readFileSync(path.join(ROOT, 'styles.css'), 'utf8');
  assert.match(css, /\.g-node\.is-flash polygon \{ animation: g-node-flash/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{\s*\.g-node\.is-flash polygon \{ animation: none/);
});

test('固定：自動の全体表示・並べ直しの経路が、どれも判断の関数を通る', () => {
  // ResizeObserver：固定中は gFit せず、ずれを打ち消す
  const ro = SRC.slice(SRC.indexOf("new ResizeObserver(() => {\n    if (activeTab !== 'graph' || gDrag || gPan) return;"));
  assert.match(ro.slice(0, 900), /if \(!gCamFree\(\)\) \{\s*gHoldView\(\);\s*return;\s*\}[\s\S]*gFit\(graph\.layout === 'flow'\);/);
  // ハニカムから戻る・深さ・関連の無いメモ：固定中は fitPending を立てない
  assert.match(SRC, /stopCameraAnimation\(\);\n[^\n]*\n\s*if \(gCamFree\(\)\) graph\.fitPending = true;\n\s*renderGraphView\(\);/);
  assert.match(SRC, /graph\.focus\.depth = [^\n]*\n\s*if \(gCamFree\(\)\) graph\.fitPending = true;/);
  assert.match(SRC, /graph\.isolated = e\.target\.checked;\n\s*if \(gCamFree\(\)\) graph\.fitPending = true;\n\s*if \(!gLayoutFree\(\)\) gPlaceNew\(\);/);
  // 一覧・概観の出し入れ
  assert.match(SRC, /if \(gCamFree\(\)\) gFit\(graph\.layout === 'flow'\); \/\/ 固定中は動かさない/);
  // データの変更：固定中は並べ直さず（流れの gLayoutFlow も通らない）、新しいメモだけ置く
  const rv = SRC.slice(SRC.indexOf('  function renderGraphView() {'));
  assert.ok(rv.indexOf('if (!gLayoutFree()) {') < rv.indexOf('gPlaceNew();') && rv.indexOf('gPlaceNew();') < rv.indexOf('gLayoutFlow()'));
  // 種類のボタン
  assert.match(SRC, /function applyGraphKinds\(\) \{\s*gKeepView\(renderGraphKinds\);\s*if \(!gLayoutFree\(\)\) gPlaceNew\(\);/);
  // gRestart は、はっきり頼まれた並べ直し（force）以外は固定中に止まる。丸のドラッグはほかの丸を動かさない
  assert.match(SRC, /function gRestart\(a = 0\.6, \{ force = false \} = \{\}\) \{[^}]*if \(!force && !gLayoutFree\(\)\) return;/);
  assert.match(SRC, /if \(graph\.layout === 'force' && !graphLocked\(\)\) gRestart\(0\.3\);/);
  assert.match(SRC, /if \(moved && graph\.layout === 'force' && !graphLocked\(\)\) gRestart\(0\.2\);/);
  // 全体表示したことを覚え、ノートの切り替えで忘れる。元に戻す・ほかのウィンドウでは位置を ID で控える
  assert.match(SRC, /gCam\(\);\n\s*graph\.camReady = true;\n\s*\}/);
  assert.match(SRC, /graph\.camReady = false;[^\n]*\n\s*graph\.lockPos = null;\n\s*if \(graph\.locked\) graph\.fitPending = true;/);
  assert.match(SRC, /if \(graph\.locked\) \{\n\s*const keep = new Map\(graph\.lockPos \|\| \[\]\);/); // 控えは足し込む（test/review-fixes.test.js）
});

test('固定：F キー（修飾キー無し・書く欄やメニューでは効かない）と、localStorage で覚える', () => {
  assert.ok(SRC.includes("const LOCK_PREF = 'hexMemo.graphLocked';"));
  assert.match(SRC, /locked: readPref\(LOCK_PREF, false\)/);
  assert.match(SRC, /writePref\(LOCK_PREF, on\)/);
  const key = SRC.slice(SRC.indexOf("    if (activeTab !== 'graph' || anyDialogOpen()) return;"));
  assert.ok(key.length > 0);
  const head = key.slice(0, 700);
  assert.ok(head.indexOf(".menu:popover-open") < head.indexOf("e.code === 'KeyF'"));
  assert.match(head, /e\.code === 'KeyF' && !e\.ctrlKey && !e\.metaKey && !e\.altKey && !e\.shiftKey/);
  assert.match(head, /isTypingTarget\(e\.target\) \|\| graph\.linking\) return;\s*e\.preventDefault\(\);\s*toggleGraphLock\(\);/);
});

test('固定：README の「関連グラフ」の表に「固定」と F の行がある', () => {
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  const sec = readme.slice(readme.indexOf('### 関連グラフ（「グラフ」タブ）'), readme.indexOf('### 期限と通知'));
  assert.match(sec, /\| 「固定」／ `F` \| グラフを \*\*固定\*\*/);
  assert.ok(sec.includes('（固定中は画面を動かさず、そのメモを光らせるだけ）'));
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.ok(pkg.scripts.test.includes('test/graph-lock.test.js'));
});
