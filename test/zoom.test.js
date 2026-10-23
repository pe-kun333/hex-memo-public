'use strict';

// 表示倍率の登録と固定（renderer.js）。画面のスクリプトの中にあるので、印のコメントの間や関数をそのまま取り出して動かす
//（merge.test.js・graph-lock.test.js と同じやり方）
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'renderer.js'), 'utf8');

const between = (from, to) => {
  const start = SRC.indexOf(from);
  const end = SRC.indexOf(to, start + 1);
  assert.ok(start > 0 && end > start, `「${from.trim()}」の部分が見つからない`);
  return SRC.slice(start, end);
};
// 字下げ 2 の「function name(」から、同じ字下げの閉じ括弧まで
const fnSrc = (name) => {
  const start = SRC.indexOf(`\n  function ${name}(`);
  assert.ok(start > 0, `function ${name} が見つからない`);
  const end = SRC.indexOf('\n  }\n', start);
  return SRC.slice(start, end + 4);
};

// 計算だけの関数（DOM にも settings にも触らない）
// eslint-disable-next-line no-new-func
const Z = new Function(`${between('  // ---- 表示倍率の計算 ----', '  // ---- 表示倍率の計算ここまで ----')}; return { ZOOM_RANGE, zoomClampPct, zoomPresetIndex, zoomLockTarget, zoomPresetAction, gZoomCam, gFitCam, wheelPanDelta };`)();
const PRESETS = [25, 50, 75, 100, 125, 150];

test('倍率：画面ごとの範囲に収める（ハニカム 4〜150%・グラフ 20〜250%）。整数の % にする', () => {
  assert.equal(Z.zoomClampPct(2, 'grid'), 4);
  assert.equal(Z.zoomClampPct(300, 'grid'), 150);
  assert.equal(Z.zoomClampPct(74.6, 'grid'), 75);
  assert.equal(Z.zoomClampPct(10, 'graph'), 20);
  assert.equal(Z.zoomClampPct(240, 'graph'), 240);
  assert.equal(Z.zoomClampPct(999, 'graph'), 250);
});

test('倍率：いまの倍率と同じ登録を探す（なめらかに動かした後の小数の端数でも合う。グラフでは 20% 未満の登録を 20% として比べる）', () => {
  assert.equal(Z.zoomPresetIndex(PRESETS, 75, 'grid'), 2);
  assert.equal(Z.zoomPresetIndex(PRESETS, 0.7500000001 * 100, 'grid'), 2);
  assert.equal(Z.zoomPresetIndex(PRESETS, 74.6, 'grid'), 2);
  assert.equal(Z.zoomPresetIndex(PRESETS, 72, 'grid'), -1);
  assert.equal(Z.zoomPresetIndex([10, 50, 100, 100, 125, 150], 100, 'grid'), 2); // 同じ値なら前のほう
  assert.equal(Z.zoomPresetIndex([10, 50, 75, 100, 125, 150], 20, 'graph'), 0);
  assert.equal(Z.zoomPresetIndex([10, 50, 75, 100, 125, 150], 10, 'graph'), -1);
});

test('「この倍率で固定する」：登録にある倍率ならそのまま、無ければいちばん近い登録（同じだけ離れていれば前のほう）', () => {
  assert.equal(Z.zoomLockTarget(PRESETS, 75, 'grid'), 75);
  assert.equal(Z.zoomLockTarget(PRESETS, 72, 'grid'), 75);
  assert.equal(Z.zoomLockTarget(PRESETS, 62.5, 'grid'), 75); // 50 と 75 の真ん中は、整数の 63 に丸めてから比べるので 75
  assert.equal(Z.zoomLockTarget(PRESETS, 62.4, 'grid'), 50);
  assert.equal(Z.zoomLockTarget(PRESETS, 4, 'grid'), 25);
  assert.equal(Z.zoomLockTarget(PRESETS, 250, 'graph'), 150);
  assert.equal(Z.zoomLockTarget([10, 30, 60, 90, 120, 150], 12, 'graph'), 20); // グラフでは 10% の登録は 20%
});

test('Ctrl+Shift+n・登録のボタン：固定していなければ倍率だけ、固定中は固定し直す、固定中と同じ登録をキーでもう一度押すと解除', () => {
  assert.deepEqual(Z.zoomPresetAction(PRESETS, 3, null, 'grid', true), { pct: 100, lock: undefined });
  assert.deepEqual(Z.zoomPresetAction(PRESETS, 0, 75, 'grid', true), { pct: 25, lock: 25 });
  assert.deepEqual(Z.zoomPresetAction(PRESETS, 2, 75, 'grid', true), { pct: 75, lock: null });
  // メニューのボタン（toggle なし）は、同じ倍率でも外さない
  assert.deepEqual(Z.zoomPresetAction(PRESETS, 2, 75, 'grid', false), { pct: 75, lock: 75 });
  // グラフでは範囲に収めた値で比べる
  assert.deepEqual(Z.zoomPresetAction([10, 50, 75, 100, 125, 150], 0, 20, 'graph', true), { pct: 20, lock: null });
  assert.deepEqual(Z.zoomPresetAction([10, 50, 75, 100, 125, 150], 0, null, 'graph'), { pct: 20, lock: undefined });
});

test('グラフ：倍率を変えても画面上の点は動かない（＋－・ホイール）', () => {
  const cam = { x: 100, y: -40, k: 0.8 };
  const next = Z.gZoomCam(cam, 1, 300, 200);
  assert.equal(next.k, 1);
  // 画面上の (300, 200) に映るグラフの点は同じ
  const world = (c) => [(300 - c.x) / c.k, (200 - c.y) / c.k];
  assert.deepEqual(world(next).map((v) => Math.round(v * 1e9) / 1e9), world(cam).map((v) => Math.round(v * 1e9) / 1e9));
});

test('グラフの全体表示：ふだんは収まる倍率（0.25〜上限）にし、倍率を固定中はその倍率のまま真ん中に寄せる', () => {
  const box = { cx: 100, cy: 50, w: 1000, h: 400 };
  const free = Z.gFitCam(box, 840, 660, 1.1);
  assert.equal(free.k, Math.min((840 - 40) / 1000, (660 - 60) / 400)); // 0.8
  assert.equal(free.x, 420 - 100 * free.k);
  assert.equal(free.y, 330 - 50 * free.k + 10);
  assert.equal(Z.gFitCam({ cx: 0, cy: 0, w: 10, h: 10 }, 800, 600, 1.1).k, 1.1); // 小さなグラフは上限まで
  assert.equal(Z.gFitCam({ cx: 0, cy: 0, w: 1e6, h: 10 }, 800, 600, 1.1).k, 0.25); // 大きなグラフも 0.25 まで
  const locked = Z.gFitCam(box, 840, 660, 1.1, 1.5);
  assert.deepEqual(locked, { x: 420 - 150, y: 330 - 75 + 10, k: 1.5 });
});

test('ホイールで動かす量：行・ページ単位も px に、Shift で縦の回転を横に', () => {
  assert.deepEqual(Z.wheelPanDelta({ deltaX: 0, deltaY: 120, deltaMode: 0, shiftKey: false }, 800, 600), { dx: 0, dy: 120 });
  assert.deepEqual(Z.wheelPanDelta({ deltaX: 0, deltaY: 3, deltaMode: 1, shiftKey: false }, 800, 600), { dx: 0, dy: 120 });
  assert.deepEqual(Z.wheelPanDelta({ deltaX: 0, deltaY: 1, deltaMode: 2, shiftKey: false }, 800, 600), { dx: 0, dy: 600 });
  assert.deepEqual(Z.wheelPanDelta({ deltaX: 0, deltaY: 100, deltaMode: 0, shiftKey: true }, 800, 600), { dx: 100, dy: 0 });
  assert.deepEqual(Z.wheelPanDelta({ deltaX: 30, deltaY: 100, deltaMode: 0, shiftKey: true }, 800, 600), { dx: 30, dy: 100 }); // 横の回転があればそのまま
});

// 設定の読み方（settings・小窓・タブだけを見る）
function loadPrefs({ settings, miniMode = false, activeTab = 'grid' }) {
  const code = between('  const ZOOM_DEFAULT = ', '  const currentZoom = ');
  // eslint-disable-next-line no-new-func
  return new Function('$', 'settings', 'miniMode', 'activeTab', `${code}; return { zoomPrefs, zoomLockPct, lockedZoom, zoomView };`)(() => ({}), settings, miniMode, activeTab);
}

test('固定の読み方：画面（タブ）ごとの固定、古い本体（zoom が無い）は既定、小窓は固定に従わない', () => {
  const settings = { zoom: { presets: [10, 20, 30, 40, 50, 60], lock: { grid: 75, graph: null } } };
  let P = loadPrefs({ settings });
  assert.equal(P.zoomView(), 'grid');
  assert.equal(P.zoomLockPct(), 75);
  assert.equal(P.lockedZoom(), 0.75);
  assert.equal(P.lockedZoom('graph'), null);
  assert.deepEqual(P.zoomPrefs().presets, [10, 20, 30, 40, 50, 60]);
  P = loadPrefs({ settings, activeTab: 'graph' });
  assert.equal(P.zoomView(), 'graph');
  assert.equal(P.lockedZoom(), null);
  assert.equal(P.lockedZoom('grid'), 0.75);
  P = loadPrefs({ settings, activeTab: 'like1' }); // いいねの一覧などはハニカムの倍率
  assert.equal(P.zoomView(), 'grid');
  P = loadPrefs({ settings, miniMode: true });
  assert.equal(P.lockedZoom('grid'), null);
  P = loadPrefs({ settings: { version: 1, tags: [] } });
  assert.deepEqual(P.zoomPrefs(), { presets: [25, 50, 75, 100, 125, 150], lock: { grid: null, graph: null }, overviewClick: 'zoom' });
  assert.equal(P.lockedZoom(), null);
  // zoomPrefs は写しを返す（書き換えても settings は変わらない）
  P = loadPrefs({ settings });
  P.zoomPrefs().presets[0] = 99;
  P.zoomPrefs().lock.grid = 1;
  assert.equal(settings.zoom.presets[0], 10);
  assert.equal(settings.zoom.lock.grid, 75);
});

// ハニカムの関所 animateCameraTo を、カメラと描き直しだけ差し替えて動かす（動きを減らす設定にして、すぐ終わらせる）
function loadAnimate(camera, lock) {
  const calls = { notify: 0, saves: 0, renders: 0 };
  // eslint-disable-next-line no-new-func
  const fn = new Function('camera', 'clampZoom', 'lockedZoom', 'notifyZoomLocked', 'stopCameraAnimation', 'render', 'scheduleSave', 'matchMedia', 'view',
    `let cameraAnim = 0; ${fnSrc('animateCameraTo')}; return animateCameraTo;`)(
    camera, (z) => Math.min(1.5, Math.max(0.04, z)), () => lock, () => { calls.notify++; }, () => {}, () => { calls.renders++; }, () => { calls.saves++; },
    () => ({ matches: true }), { w: 800, h: 600 });
  return { animateCameraTo: fn, calls };
}

test('ハニカムを固定中：どこから頼まれても（ジャンプ・全体・100% へ）倍率は固定した値で、位置だけ動かす。違う倍率を頼まれたら知らせる', () => {
  let camera = { x: 0, y: 0, zoom: 0.75 };
  let A = loadAnimate(camera, 0.75);
  let done = false;
  A.animateCameraTo(300, -120, () => { done = true; }, 1); // jumpTo・zoomInAt の 100%
  assert.deepEqual(camera, { x: 300, y: -120, zoom: 0.75 });
  assert.equal(done, true);
  assert.equal(A.calls.notify, 1);
  // 倍率を渡さない（今の倍率のまま）・固定と同じ倍率：知らせない
  A.animateCameraTo(10, 10);
  A.animateCameraTo(20, 20, null, 0.7500000001);
  assert.equal(A.calls.notify, 1);
  assert.equal(camera.zoom, 0.75);
  // 今の倍率が固定と違う（小窓から戻った直後など）：知らせずに固定した倍率へ
  camera = { x: 0, y: 0, zoom: 1 };
  A = loadAnimate(camera, 0.5);
  A.animateCameraTo(5, 5);
  assert.deepEqual(camera, { x: 5, y: 5, zoom: 0.5 });
  assert.equal(A.calls.notify, 0);
  // 固定していなければ、これまでどおり頼まれた倍率（範囲に収める）
  camera = { x: 0, y: 0, zoom: 0.75 };
  A = loadAnimate(camera, null);
  A.animateCameraTo(1, 2, null, 3);
  assert.deepEqual(camera, { x: 1, y: 2, zoom: 1.5 });
  assert.equal(A.calls.notify, 0);
  assert.ok(A.calls.saves >= 1);
});

// Ctrl+ホイール・ピンチの zoomAt
function loadZoomAt(camera, lock) {
  const calls = { notify: 0, renders: 0 };
  // eslint-disable-next-line no-new-func
  const fn = new Function('camera', 'clampZoom', 'lockedZoom', 'notifyZoomLocked', 'stopCameraAnimation', 'requestRender', 'scheduleSave', 'stage', 'view',
    `${fnSrc('zoomAt')}; return zoomAt;`)(
    camera, (z) => Math.min(1.5, Math.max(0.04, z)), () => lock, () => { calls.notify++; }, () => {}, () => { calls.renders++; }, () => {},
    { getBoundingClientRect: () => ({ left: 0, top: 0 }) }, { w: 800, h: 600 });
  return { zoomAt: fn, calls };
}

test('ハニカムを固定中：Ctrl+ホイール・ピンチは倍率を変えずに知らせる。固定していなければ指の位置を中心に拡大縮小', () => {
  const camera = { x: 0, y: 0, zoom: 0.75 };
  let Zm = loadZoomAt(camera, 0.75);
  Zm.zoomAt(600, 450, 1.3);
  assert.deepEqual(camera, { x: 0, y: 0, zoom: 0.75 });
  assert.equal(Zm.calls.notify, 1);
  assert.equal(Zm.calls.renders, 0);
  Zm = loadZoomAt(camera, null);
  Zm.zoomAt(600, 450, 1.2);
  assert.equal(Math.round(camera.zoom * 100), 90);
  // 指の下（画面の中央から 200, 150 px）のワールド座標は同じ
  assert.ok(Math.abs((0 + 200 / 0.75) - (camera.x + 200 / camera.zoom)) < 1e-9);
  assert.equal(Zm.calls.notify, 0);
});

// 登録の i 番目（キー・メニュー）：固定の書き換えと倍率の動かし方を記録する
function loadPreset({ lock, view = 'grid', presets = PRESETS }) {
  const log = [];
  // eslint-disable-next-line no-new-func
  const fn = new Function('zoomView', 'zoomPresetAction', 'zoomPrefs', 'zoomLockPct', 'setZoomLock', 'toast', 'zoomToPct', 'zoomViewName',
    `${fnSrc('applyZoomPreset')}; return applyZoomPreset;`)(
    () => view, Z.zoomPresetAction, () => ({ presets, lock: {} }), () => lock,
    (v, p) => log.push(['lock', v, p]), (m) => log.push(['toast', m]), (v, p) => log.push(['zoom', v, p]), (v) => (v === 'graph' ? 'グラフ' : 'ハニカム'));
  return { applyZoomPreset: fn, log };
}

test('Ctrl+Shift+n：固定していなければ倍率だけ・固定中は固定し直してから動かす・同じ倍率でもう一度なら固定を外して倍率はそのまま', () => {
  let P = loadPreset({ lock: null });
  P.applyZoomPreset(3, { toggle: true });
  assert.deepEqual(P.log, [['zoom', 'grid', 100]]);
  P = loadPreset({ lock: 75 });
  P.applyZoomPreset(0, { toggle: true });
  assert.deepEqual(P.log.slice(0, 2), [['lock', 'grid', 25], ['zoom', 'grid', 25]]); // 固定を先に変える（関所が新しい倍率を通す）
  assert.match(P.log[2][1], /^ハニカムを 25% で固定しました/);
  P = loadPreset({ lock: 75 });
  P.applyZoomPreset(2, { toggle: true });
  assert.deepEqual(P.log, [['lock', 'grid', null], ['toast', '倍率の固定を解除しました']]);
  // メニューのボタンは同じ倍率でも外さない・知らせない
  P = loadPreset({ lock: 75 });
  P.applyZoomPreset(2);
  assert.deepEqual(P.log, [['lock', 'grid', 75], ['zoom', 'grid', 75]]);
  P = loadPreset({ lock: 50, view: 'graph' });
  P.applyZoomPreset(1, { toggle: true });
  assert.deepEqual(P.log, [['lock', 'graph', null], ['toast', '倍率の固定を解除しました']]);
});

// ほかのウィンドウから届いた設定（applySettings）：表示中の画面の固定が変わったときだけ、その倍率へ動かす
function loadApplyZoom({ lock, cur, ready = true, miniMode = false, view = 'grid' }) {
  const log = [];
  // eslint-disable-next-line no-new-func
  const fn = new Function('ZOOM_DEFAULT', 'zoomView', 'zoomLockPct', 'currentZoom', 'zoomToPct', 'updateZoomUi', 'ready', 'miniMode',
    `let zoomUiKey = 'x'; ${fnSrc('applyZoomSettings')}; return applyZoomSettings;`)(
    { lock: { grid: null, graph: null } }, () => view, () => lock, () => cur, (v, p) => log.push([v, p]), () => log.push('ui'), ready, miniMode);
  return { applyZoomSettings: fn, log };
}

test('ほかのウィンドウで固定した：表示中の画面の固定が新しくなったら、その倍率へ動かす（同じ固定・起動中・小窓では動かさない）', () => {
  let A = loadApplyZoom({ lock: 75, cur: 1 });
  A.applyZoomSettings({ zoom: { lock: { grid: null, graph: null } } });
  assert.deepEqual(A.log, [['grid', 75], 'ui']);
  A = loadApplyZoom({ lock: 75, cur: 1 });
  A.applyZoomSettings({ zoom: { lock: { grid: 75, graph: null } } }); // 自分の保存の返事（もう固定済み）
  assert.deepEqual(A.log, ['ui']);
  A = loadApplyZoom({ lock: 75, cur: 0.75 });
  A.applyZoomSettings({ version: 1 }); // 古い設定（zoom 無し）から：もう 75% なので動かさない
  assert.deepEqual(A.log, ['ui']);
  A = loadApplyZoom({ lock: 75, cur: 1, ready: false }); // 起動中（ノートを読む前）
  A.applyZoomSettings({});
  assert.deepEqual(A.log, ['ui']);
  A = loadApplyZoom({ lock: 75, cur: 1, miniMode: true });
  A.applyZoomSettings({});
  assert.deepEqual(A.log, ['ui']);
  A = loadApplyZoom({ lock: 120, cur: 0.5, view: 'graph' });
  A.applyZoomSettings({ zoom: { lock: { grid: 75, graph: null } } });
  assert.deepEqual(A.log, [['graph', 120], 'ui']);
  assert.match(fnSrc('applySettings'), /const prev = settings;\s*settings = next;\s*applyZoomSettings\(prev\);/);
});

test('右上の倍率は見ている画面に合わせる：グラフのタブでは ＋－・Ctrl+0・全体がグラフに効き、ハニカムに切り替えない', () => {
  const zoomBy = fnSrc('zoomBy');
  assert.match(zoomBy, /if \(activeTab === 'graph'\) \{\s*gZoomBy\(factor\);\s*return;/);
  assert.ok(zoomBy.indexOf("activeTab === 'graph'") < zoomBy.indexOf("setTab('grid')"));
  assert.match(zoomBy, /lockedZoom\('grid'\) != null\) \{\s*notifyZoomLocked\('grid'\);\s*return;/);
  const zoomReset = fnSrc('zoomReset');
  assert.match(zoomReset, /if \(activeTab === 'graph'\) \{\s*gZoomTo\(1\);\s*return;/);
  const fitAll = fnSrc('fitAll');
  assert.match(fitAll, /if \(activeTab === 'graph'\) \{\s*gFit\(graph\.layout === 'flow'\);\s*return;/);
  // 右上の数字はグラフのカメラが動くたびに追いかけ、タブを切り替えたら出し直す
  assert.match(between('  const gCam = () => {', '\n  };\n'), /if \(activeTab === 'graph'\) updateZoomUi\(\);/);
  assert.match(fnSrc('setTab'), /zoomUiKey = '';\s*updateZoomUi\(\);[^\n]*\n {2}\}$/); // いちばん最後に
  assert.match(fnSrc('applyZoomStyles'), /updateZoomUi\(\);/);
});

test('グラフの倍率の固定：全体表示（自動も「全体」も）は倍率を変えず、ホイールは画面を動かす（②の判断の隣の gZoomLocked だけを見る）', () => {
  const gate = between('  // ---- 固定：グラフのカメラ・並びを自動で動かしてよいか', '  // ---- 固定（グラフ）の計算 ----');
  assert.match(gate, /function gZoomLocked\(\) \{\s*return lockedZoom\('graph'\);\s*\}/);
  assert.match(fnSrc('gFit'), /graph\.cam = gFitCam\(\{[^}]*\}, r\.width - panelW, r\.height, kMax, gZoomLocked\(\)\);/);
  const wheel = between("  graphSvg.addEventListener('wheel'", '  function gZoomTo(');
  const lockAt = wheel.indexOf('if (gZoomLocked() != null)');
  assert.ok(lockAt > 0 && lockAt < wheel.indexOf('gZoomCam('), '固定の確かめが倍率の計算より先');
  assert.match(wheel, /wheelPanDelta\(ev, r\.width, r\.height\)/);
  assert.match(wheel, /Math\.min\(G_ZOOM_MAX, Math\.max\(G_ZOOM_MIN,/);
  const gZoomTo = fnSrc('gZoomTo');
  assert.match(gZoomTo, /lk \?\? k/);
  assert.match(gZoomTo, /gViewBox\(\)/); // 見える範囲（右の一覧・概観を除く）の真ん中を中心に
  assert.match(fnSrc('gZoomBy'), /gZoomLocked\(\) != null\) \{\s*notifyZoomLocked\('graph'\);\s*return;/);
});

test('ハニカムの固定：Ctrl+ホイールは先に断り、階層・ノートの切り替えと小窓から戻ったときは固定した倍率に合わせる', () => {
  assert.match(fnSrc('zoomAt'), /^\n  function zoomAt\([^)]*\) \{\s*if \(lockedZoom\('grid'\) != null\) \{\s*notifyZoomLocked\('grid'\);[^\n]*\n\s*return;/);
  assert.match(fnSrc('animateCameraTo'), /const z1 = clampZoom\(lz \?\? zoom\);/);
  assert.match(fnSrc('activateLayer'), /camera = layer\.camera;\s*enforceGridZoomLock\(\);/);
  assert.match(SRC, /camera = rootLayer\.camera;\s*enforceGridZoomLock\(\);/);
  assert.match(fnSrc('applyRemoteStore'), /else \{\s*enforceGridZoomLock\(\);/);
  assert.match(fnSrc('setMiniMode'), /if \(!on\) enforceGridZoomLock\(\);/);
  // 小窓は 100% のまま（startMini は固定を見ない。lockedZoom が小窓では null）
  assert.match(fnSrc('startMini'), /camera\.zoom = 1;/);
  assert.match(fnSrc('zoomLockPct'), /if \(miniMode\) return null;/);
});

test('キー：Ctrl+Shift+1〜6 は関連付けの数字・Ctrl+1〜9（タブ）の後、Ctrl だけ（⌘・Alt は除く）で e.code を見る', () => {
  const linkDigits = SRC.indexOf('// 関連付けの途中：1〜9 で線の種類を選ぶ');
  const tabs = SRC.indexOf('if (mod && !e.shiftKey && /^Digit[1-9]$/.test(e.code))');
  const preset = SRC.indexOf('if (e.ctrlKey && e.shiftKey && !e.metaKey && !e.altKey && /^Digit[1-6]$/.test(e.code))');
  assert.ok(linkDigits > 0 && tabs > linkDigits && preset > tabs, '順番');
  assert.match(SRC.slice(preset, preset + 300), /applyZoomPreset\(Number\(e\.code\.slice\(5\)\) - 1, \{ toggle: true \}\)/);
  // 倍率を押すとメニュー（100% には戻さない）。メニューバー・アプリのメニューからも
  assert.doesNotMatch(SRC, /\$\('zoomLabel'\)\.addEventListener\('click', zoomReset\)/);
  assert.match(SRC, /else if \(cmd === 'zoom-menu'\) \{ if \(!miniMode\) openZoomMenu\(\); \}/);
  assert.match(SRC, /btn\.dataset\.cmd === 'zoom-menu'\) \{\s*if \(!miniMode\) openZoomMenu\(\);/);
  const main = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
  assert.match(main, /\{ label: '倍率の登録と固定…', click: \(_item, win\) => sendCommand\('zoom-menu', win\) \}/);
  assert.ok(main.indexOf("sendCommand('zoom-menu'") > main.indexOf("sendCommand('zoom-reset')"));
});

test('見た目：固定中は枠を青く・＋－ を薄く、弾む動きは動きを減らす設定で止める', () => {
  const css = fs.readFileSync(path.join(ROOT, 'styles.css'), 'utf8');
  assert.match(css, /\.zoom-ctl\.is-locked \{ border-color: var\(--accent\); \}/);
  assert.match(css, /\.zoom-btn\[aria-disabled="true"\] \{ opacity: \.35; cursor: not-allowed; \}/);
  assert.match(css, /\.zoom-label\.is-bump \{ animation: zoom-bump/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{\s*\.zoom-label\.is-bump/);
  const ui = fnSrc('updateZoomUi');
  assert.match(ui, /`\$\{what\}表示倍率 \$\{pct\}%\$\{locked \? '（固定中）' : ''\}`/);
  assert.match(ui, /svgIcon\('lock'\)/);
  assert.match(ui, /setAttribute\('aria-disabled', 'true'\)/);
  assert.match(ui, /倍率を固定中（\$\{lock\}%）。解除は倍率のメニューから/);
});

test('README：倍率の登録と固定・操作の表・グラフ・settings.json の説明', () => {
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  assert.match(readme, /#### 倍率の登録と固定/);
  assert.match(readme, /\| `Ctrl`\+`Shift`\+`1`〜`6` \|/);
  assert.match(readme, /右上の倍率（`100%`）をクリック/);
  assert.match(readme, /zoom: \{ presets/);
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.match(pkg.scripts.test, /test\/zoom\.test\.js/);
});
