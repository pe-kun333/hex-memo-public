'use strict';

// 縮小中の浮かび上がりを固定する（「浮かせて固定」）・マスの無いところの右クリックで強調をやめる（renderer.js）
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'renderer.js'), 'utf8');
const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const CSS = fs.readFileSync(path.join(ROOT, 'styles.css'), 'utf8');
const S = require('../settings');
const fnSrc = (name) => {
  const start = SRC.indexOf(`\n  function ${name}(`);
  assert.ok(start > 0, `function ${name} が見つからない`);
  const end = SRC.indexOf('\n  }\n', start);
  return SRC.slice(start, end + 4);
};
const make = (name, state) => new Function(...Object.keys(state), `${fnSrc(name)}; return ${name};`)(...Object.values(state)); // eslint-disable-line no-new-func

test('設定：縮小中のクリックに「浮かせて固定」（pin）を選べる。既定は拡大のまま', () => {
  assert.equal(S.normalizeZoom({ overviewClick: 'pin' }).overviewClick, 'pin');
  assert.equal(S.normalizeZoom({}).overviewClick, 'zoom');
  assert.equal(S.normalizeZoom({ overviewClick: 'PIN' }).overviewClick, 'zoom');
  assert.match(HTML, /<option value="pin">浮かせて固定/);
  assert.match(SRC, /const OVERVIEW_CLICK_MODES = \['zoom', 'edit', 'pin'\]/);
});

test('固定はカメラが動いたら外す（動かした・拡大縮小した）', () => {
  const moved = make('peekCameraMoved', {});
  const pin = { x: 1, y: 2, zoom: 0.3 };
  assert.equal(moved({ x: 1, y: 2, zoom: 0.3 }, pin), false);
  assert.equal(moved({ x: 5, y: 2, zoom: 0.3 }, pin), true);
  assert.equal(moved({ x: 1, y: 2, zoom: 0.31 }, pin), true);
  assert.equal(moved({ x: 9, y: 9, zoom: 1 }, null), false);
  assert.match(SRC, /if \(peekPinned && peekCameraMoved\(camera, peekPinCam\)\) unpinPeek\(\)/);
});

function peekClick(target, extra = {}) {
  const log = [];
  const state = {
    peekPinned: 'k1',
    unpinPeek: () => log.push('unpin'),
    editFromOverview: (k) => log.push(`edit:${k}`),
    openAnyUrl: (u) => log.push(`url:${u}`),
    handleAction: (a, k) => log.push(`act:${a}:${k}`),
    refreshPinnedPeek: (k) => log.push(`refresh:${k}`),
    PEEK_SKIP_ACTIONS: new Set(['select']),
    ...extra,
  };
  const f = make('onPinnedPeekClick', state);
  const e = { target, stopPropagation: () => log.push('stop'), preventDefault: () => {} };
  return { result: f(e), log };
}
const target = (map) => ({ closest: (sel) => { for (const [k, v] of Object.entries(map)) if (sel.split(',').map((s) => s.trim()).includes(k)) return v; return null; } });

test('固定した写し：♡ などは handleAction に回して作り直す。× は外す・✎ と本文は拡大して書く', () => {
  let r = peekClick(target({ 'button[data-action]': { dataset: { action: 'like' } } }));
  assert.equal(r.result, 'like');
  assert.deepEqual(r.log, ['stop', 'act:like:k1', 'refresh:k1']);
  r = peekClick(target({ '[data-peek]': { dataset: { peek: 'close' } } }));
  assert.deepEqual([r.result, r.log], ['close', ['stop', 'unpin']]);
  r = peekClick(target({ '[data-peek]': { dataset: { peek: 'edit' } } }));
  assert.deepEqual([r.result, r.log], ['edit', ['stop', 'unpin', 'edit:k1']]);
  r = peekClick(target({ '.body-text': {} }));
  assert.deepEqual([r.result, r.log], ['edit', ['stop', 'unpin', 'edit:k1']]);
  r = peekClick(target({ '.body-url': { dataset: { url: 'https://x' } } }));
  assert.deepEqual([r.result, r.log], ['url', ['stop', 'url:https://x']]);
  r = peekClick(target({ 'button[data-action]': { dataset: { action: 'select' } } }));
  assert.equal(r.result, null);
  r = peekClick(target({}), { peekPinned: null });
  assert.deepEqual([r.result, r.log], [null, []]);
});

test('固定：Esc がいちばん先・外のクリックは外すだけ（拡大しない）・マウスを動かしても外さない', () => {
  const esc = SRC.indexOf("if (e.key === 'Escape' && peekPinned)");
  const escEdit = SRC.indexOf('// Esc：編集を終える');
  assert.ok(esc > 0 && esc < escEdit);
  assert.match(SRC, /if \(unpinPeek\(\)\) return; \/\/ 固定中に外をクリック/);
  assert.match(SRC, /if \(peekPinned\) \{\n\s+if \(!isOverview \|\| pan \|\| drag\) hidePeek\(\);/);
  assert.match(fnSrc('hidePeek'), /if \(peekPinned\) setPeekPinned\(null\)/);
  assert.match(fnSrc('refreshCell'), /refreshPinnedPeek\(key\)/);
  assert.match(CSS, /\.hex-peek\.is-pinned, \.hex-peek\.is-pinned \* \{ pointer-events: auto !important; \}/);
});

function ctx(extra = {}) {
  const log = [];
  const state = { editingKey: null, selectMode: false, selectedKey: 'a', linking: null, cancelLinking: () => log.push('cancel'), clearSelection: () => log.push('clear'), ...extra };
  const f = make('clearOnEmptyContext', state);
  let prevented = false;
  const e = { defaultPrevented: false, target: { closest: () => null }, preventDefault: () => { prevented = true; }, ...(extra.e || {}) };
  return { r: f(e), log, prevented: () => prevented };
}

test('マスの無いところの右クリック：選んでいれば外し（関連付けの途中もやめ）、メニューは出さない', () => {
  let c = ctx();
  assert.deepEqual([c.r, c.log, c.prevented()], [true, ['clear'], true]);
  c = ctx({ linking: { rec: {} } });
  assert.deepEqual([c.r, c.log], [true, ['cancel', 'clear']]);
  c = ctx({ selectedKey: null, linking: { rec: {} } });
  assert.deepEqual([c.r, c.log], [true, ['cancel']]);
});

test('マスの無いところの右クリック：何も選んでいない・書いている途中・選択モード・ほかが受けたときは今までどおり', () => {
  for (const extra of [{ selectedKey: null }, { editingKey: 'a' }, { selectMode: true }, { e: { defaultPrevented: true } }, { e: { target: { closest: () => ({}) } } }]) {
    const c = ctx(extra);
    assert.equal(c.r, false);
    assert.deepEqual(c.log, []);
    assert.equal(c.prevented(), false);
  }
  assert.match(SRC, /if \(!cell && clearOnEmptyContext\(e\)\) return;/);
});

test('固定中は、写しの上へ出た・ステージを押しただけでは消さない（固定した写しはステージの外にあるため）', () => {
  assert.match(SRC, /stage\.addEventListener\('pointerleave', \(\) => \{\n\s+if \(!peekPinned\) hidePeek\(\);/);
  assert.match(SRC, /stage\.addEventListener\('pointerdown', \(\) => \{\n\s+if \(!peekPinned\) hidePeek\(\);\n\s+\}, true\);/);
});
