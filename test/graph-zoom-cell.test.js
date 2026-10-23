'use strict';

// グラフの右クリック「このセルを拡大表示」「拡大表示を戻す」（renderer.js の gZoomCellCam・gCamLerp・gZoomCell・gZoomCellBack）
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'renderer.js'), 'utf8');
const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const between = (from, to) => {
  const start = SRC.indexOf(from);
  const end = SRC.indexOf(to, start + 1);
  assert.ok(start > 0 && end > start, `「${from.trim()}」の部分が見つからない`);
  return SRC.slice(start, end);
};
// eslint-disable-next-line no-new-func
const Z = new Function(`${between('  // ---- 表示倍率の計算 ----', '  // ---- 表示倍率の計算ここまで ----')}; return { gZoomCellCam, gCamLerp, gZoomStepK, G_ZOOM_STEPS, gZoomMenuStays, gZoomMenuLabel, gZoomMenuPlace };`)();
const fnSrc = (name) => between(`  function ${name}(`, '\n  }\n');

test('拡大表示：丸を見える範囲の真ん中に、六角形の半径が画面で 64〜110px くらい（倍率の上限・下限の中）', () => {
  const v = { left: 0, top: 0, right: 700, bottom: 500 };
  const cam = Z.gZoomCellCam({ x: 100, y: -50 }, v, 32, 0.2, 2.5);
  assert.equal(cam.k, 2.5); // 500 × 0.18 = 90px → 2.81 倍だが上限 2.5 で止まる
  assert.equal(cam.x + 100 * cam.k, 350); // 真ん中
  assert.equal(cam.y + -50 * cam.k, 250);
  const small = Z.gZoomCellCam({ x: 0, y: 0 }, { left: 0, top: 0, right: 300, bottom: 200 }, 32, 0.2, 5);
  assert.equal(small.k, 64 / 32, '狭くても半径 64px');
  const big = Z.gZoomCellCam({ x: 0, y: 0 }, { left: 0, top: 0, right: 2000, bottom: 1400 }, 32, 0.2, 5);
  assert.equal(big.k, 110 / 32, '広くても半径 110px まで');
  const off = Z.gZoomCellCam({ x: 10, y: 10 }, { left: 40, top: 20, right: 440, bottom: 420 }, 32, 0.2, 2.5);
  assert.equal(off.x + 10 * off.k, 240, '右の一覧を除いた範囲の真ん中');
});

test('拡大表示：倍率を固定中（lockK）は倍率を変えず、真ん中に寄せるだけ', () => {
  const cam = Z.gZoomCellCam({ x: 100, y: 100 }, { left: 0, top: 0, right: 800, bottom: 600 }, 32, 0.2, 2.5, 0.75);
  assert.equal(cam.k, 0.75);
  assert.equal(cam.x + 100 * 0.75, 400);
});

test('動かし方：はじめと終わりは指定どおり、途中はゆっくり止まる', () => {
  const a = { x: 0, y: 0, k: 1 };
  const b = { x: 100, y: -100, k: 2 };
  assert.deepEqual(Z.gCamLerp(a, b, 0), a);
  assert.deepEqual(Z.gCamLerp(a, b, 1), b);
  assert.ok(Z.gCamLerp(a, b, 0.5).x > 50, 'はじめ速く、あとゆっくり');
  assert.deepEqual(Z.gCamLerp(a, b, 2), b);
});

test('戻す：はじめの見え方を覚え（続けて拡大しても上書きしない）、戻したら消す。覚えていなければ全体表示', () => {
  assert.match(fnSrc('gZoomCell'), /if \(!graph\.zoomSaved\) \{ graph\.zoomSaved = \{ \.\.\.graph\.cam \}; graph\.zoomStep = 0; \}/);
  assert.match(fnSrc('gZoomCell'), /gZoomLocked\(\)/);
  assert.doesNotMatch(fnSrc('gZoomCell'), /gCamFree|graphLocked/, '「固定」中でも、はっきり頼まれたので動かす');
  const back = fnSrc('gZoomCellBack');
  assert.match(back, /graph\.zoomSaved = null;/);
  assert.match(back, /if \(saved\) gAnimateCam\(saved\);\s*else gFit\(/);
});

test('メニュー：2つの項目・「戻す」は拡大表示しているときだけ押せる', () => {
  assert.match(HTML, /data-cmd="g-zoom"[^>]*><span id="gZoomCellLabel">このセルを拡大表示（1\/3）<\/span>/);
  assert.match(HTML, /data-cmd="g-zoom-back" id="gZoomBack"[^>]*disabled><span>拡大表示を戻す<\/span>/);
  assert.match(fnSrc('syncGraphZoomMenu'), /\$\('gZoomBack'\)\.disabled = !graph\.zoomSaved;/);
  assert.match(fnSrc('openGraphNodeMenu'), /syncGraphZoomMenu\(\);/);
  assert.match(SRC, /gZoomCell\(rec, stay \? \(\) => placeGraphNodeMenuAt\(rec\) : null\);/);
  assert.match(SRC, /cmd\.dataset\.cmd === 'g-zoom-back'\) gZoomCellBack\(\);/);
});

test('段階の拡大：押すたびに倍率の比で 3 等分、3 段目で寄せきる。そのあとも寄せきったまま', () => {
  assert.equal(Z.G_ZOOM_STEPS, 3);
  const k0 = 0.5;
  const kT = 2.5;
  const k1 = Z.gZoomStepK(k0, kT, 1);
  const k2 = Z.gZoomStepK(k0, kT, 2);
  assert.ok(Math.abs(k1 - k0 * Math.pow(5, 1 / 3)) < 1e-12);
  assert.ok(Math.abs(k2 - k0 * Math.pow(5, 2 / 3)) < 1e-12);
  assert.ok(Math.abs(k2 / k1 - k1 / k0) < 1e-12, '1 段ごとの倍率の比は同じ');
  assert.equal(Z.gZoomStepK(k0, kT, 3), kT);
  assert.equal(Z.gZoomStepK(k0, kT, 7), kT);
  assert.equal(Z.gZoomStepK(k0, kT, 0), k0);
});

test('段階の拡大：寄せきった倍率がはじめ以下なら、倍率はそのまま（真ん中に寄せるだけ）', () => {
  assert.equal(Z.gZoomStepK(2, 1.5, 1), 2);
  assert.equal(Z.gZoomStepK(2, 2, 3), 2);
});

test('段階の拡大：段は続く（別のセルでも）・戻す／別のグラフで 0 に。メニューに次の段を出す', () => {
  const cell = fnSrc('gZoomCell');
  assert.match(cell, /graph\.zoomStep = Math\.min\(G_ZOOM_STEPS, graph\.zoomStep \+ 1\);/);
  assert.match(cell, /lk \?\? gZoomStepK\(graph\.zoomSaved\.k, kT, graph\.zoomStep\)/);
  assert.match(fnSrc('gZoomCellBack'), /graph\.zoomStep = 0;/);
  assert.match(fnSrc('openLinkGraph'), /graph\.zoomStep = 0;/);
  assert.equal(Z.gZoomMenuLabel(1), 'このセルを拡大表示（1/3）');
  assert.equal(Z.gZoomMenuLabel(3), 'このセルを拡大表示（3/3）');
  assert.equal(Z.gZoomMenuLabel(4), 'このセルを真ん中に（拡大は最大）');
});

test('メニューを開いたまま：1・2 段目は開いたまま、3 段目と「真ん中に」は閉じる', () => {
  assert.equal(Z.gZoomMenuStays(0), true); // 1 段目を押す
  assert.equal(Z.gZoomMenuStays(1), true); // 2 段目
  assert.equal(Z.gZoomMenuStays(2), false); // 3 段目（寄せきる）
  assert.equal(Z.gZoomMenuStays(3), false); // 寄せきったあとの「真ん中に」
  const click = between("    if (cmd.dataset.cmd === 'g-zoom') {", "    graphNodeMenu.hidePopover();\n    if (cmd.dataset.cmd === 'g-comment')");
  assert.match(click, /if \(!stay\) graphNodeMenu\.hidePopover\(\);/);
  assert.match(click, /if \(stay\) syncGraphZoomMenu\(\);/);
  assert.match(click, /return;/, 'ほかの項目の処理（メニューを閉じる）へは進まない');
});

test('開いたままのメニューの置き場所：寄ったセルの右、入らなければ左。縦は画面の中', () => {
  const view = { w: 1024, h: 610 };
  const size = { w: 440, h: 500 };
  const right = Z.gZoomMenuPlace({ left: 100, right: 240, top: 200, bottom: 340 }, size, view);
  assert.deepEqual(right, { x: 250, y: 102 }); // 610 - 500 - 8 まで上へ
  const left = Z.gZoomMenuPlace({ left: 600, right: 740, top: 50, bottom: 190 }, size, view);
  assert.deepEqual(left, { x: 150, y: 50 });
  const none = Z.gZoomMenuPlace({ left: 300, right: 440, top: 50, bottom: 190 }, { w: 900, h: 100 }, view);
  assert.ok(none.x >= 8 && none.x + 900 <= 1016);
});
