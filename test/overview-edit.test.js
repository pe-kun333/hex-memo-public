'use strict';

// 全体表示（50% 未満）で足した操作の計算（renderer.js）。画面のスクリプトの中なので、印の間を取り出して動かす。
// 画面の点 → マスは test/hex.test.js（screenToKey。26%・33%・41%）。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'renderer.js'), 'utf8');
const between = (from, to) => {
  const start = SRC.indexOf(from);
  const end = SRC.indexOf(to, start + 1);
  assert.ok(start > 0 && end > start, `「${from.trim()}」の部分が見つからない`);
  return SRC.slice(start, end);
};

const api = new Function(`${between('  // ---- 全体表示の操作（計算だけ） ----', '  // ---- 全体表示の操作（計算だけ）ここまで ----')}; return { slipDropAction, shelfDropAction, emptyOverviewClick, overviewLinkGesture, emptyLinkRelease, overviewFilledAction, overviewEditResult };`)();

test('紙片を離したとき：全体表示でハニカムの上なら写しを置く（紙片は動かさない）。見るだけ・盤の上は並べ替え', () => {
  assert.deepEqual(
    api.slipDropAction({ honey: true, honeyKey: '2,1', boardTarget: null, viewOnly: false, overview: true }),
    { kind: 'place-copy', key: '2,1' },
  );
  // 盤の落とし先があっても、ハニカムの上が優先（写し。並べ替えない）
  assert.deepEqual(
    api.slipDropAction({ honey: true, honeyKey: '2,1', boardTarget: { q: 0, r: 1 }, viewOnly: false, overview: true }),
    { kind: 'place-copy', key: '2,1' },
  );
  // 見るだけ：ハニカムへは置かず、盤の落とし先があれば並べ替え
  assert.deepEqual(
    api.slipDropAction({ honey: true, honeyKey: '2,1', boardTarget: { q: 0, r: 1 }, viewOnly: true, overview: true }),
    { kind: 'reorder', target: { q: 0, r: 1 } },
  );
  assert.deepEqual(
    api.slipDropAction({ honey: true, honeyKey: '2,1', boardTarget: null, viewOnly: true, overview: true }),
    { kind: 'cancel' },
  );
  // 盤の中（どの倍率でも）は今までの並べ替え
  assert.deepEqual(
    api.slipDropAction({ honey: false, honeyKey: null, boardTarget: { q: 1, r: 2 }, viewOnly: false, overview: true }),
    { kind: 'reorder', target: { q: 1, r: 2 } },
  );
  // 全体表示でないときは、ハニカム側の印が付いていても並べ替え（この操作は全体表示だけ）
  assert.deepEqual(
    api.slipDropAction({ honey: true, honeyKey: '2,1', boardTarget: { q: 1, r: 0 }, viewOnly: false, overview: false }),
    { kind: 'reorder', target: { q: 1, r: 0 } },
  );
  assert.deepEqual(
    api.slipDropAction({ honey: false, honeyKey: null, boardTarget: null, viewOnly: false, overview: true }),
    { kind: 'cancel' },
  );
  // 空いたマスが無い
  assert.deepEqual(
    api.slipDropAction({ honey: true, honeyKey: null, boardTarget: null, viewOnly: false, overview: true }),
    { kind: 'cancel' },
  );
});

test('棚のメモを離したとき：全体表示でも置く。見るだけなら何もしない', () => {
  assert.deepEqual(api.shelfDropAction({ overview: true, viewOnly: false, key: '1,0' }), { kind: 'place', key: '1,0' });
  assert.deepEqual(api.shelfDropAction({ overview: false, viewOnly: false, key: '1,0' }), { kind: 'place', key: '1,0' });
  assert.deepEqual(api.shelfDropAction({ overview: true, viewOnly: true, key: '1,0' }), { kind: 'ignore' });
  assert.deepEqual(api.shelfDropAction({ overview: false, viewOnly: true, key: '3,-1' }), { kind: 'place', key: '3,-1' });
  assert.deepEqual(api.shelfDropAction({ overview: true, viewOnly: false, key: '' }), { kind: 'ignore' });
});

test('空いたマスをクリックしたとき：全体表示なら一行で書く。見るだけ・メモのあるマス・中心は拡大', () => {
  assert.equal(api.emptyOverviewClick({ overview: true, viewOnly: false, filled: false, center: false }), 'write');
  assert.equal(api.emptyOverviewClick({ overview: true, viewOnly: undefined, filled: false, center: false }), 'write');
  assert.equal(api.emptyOverviewClick({ overview: true, viewOnly: true, filled: false, center: false }), 'zoom');
  assert.equal(api.emptyOverviewClick({ overview: true, viewOnly: false, filled: true, center: false }), 'zoom');
  assert.equal(api.emptyOverviewClick({ overview: true, viewOnly: false, filled: false, center: true }), 'zoom');
  assert.equal(api.emptyOverviewClick({ overview: false, viewOnly: false, filled: false, center: false }), 'zoom');
});

test('全体表示で線を引き始める：メモの上の Alt+左ドラッグと右ドラッグ。見るだけ・空のマスは無し', () => {
  const base = { overview: true, viewOnly: false, fromMemo: true };
  assert.equal(api.overviewLinkGesture({ ...base, button: 0, alt: true }), 'alt-drag');
  assert.equal(api.overviewLinkGesture({ ...base, button: 2, alt: false }), 'right-drag');
  assert.equal(api.overviewLinkGesture({ ...base, button: 2, alt: true }), 'right-drag');
  assert.equal(api.overviewLinkGesture({ ...base, button: 0, alt: false }), 'none');
  assert.equal(api.overviewLinkGesture({ ...base, button: 1, alt: true }), 'none');
  assert.equal(api.overviewLinkGesture({ ...base, viewOnly: true, button: 0, alt: true }), 'none');
  assert.equal(api.overviewLinkGesture({ ...base, fromMemo: false, button: 2, alt: false }), 'none');
  assert.equal(api.overviewLinkGesture({ ...base, overview: false, button: 0, alt: true }), 'none');
});

test('線を空いたマスで離したとき：一行で書く。見るだけ・メモのあるマス・中心は今までどおり', () => {
  const ok = { viewOnly: false, filled: false, center: false, linking: true, readOnly: false };
  assert.equal(api.emptyLinkRelease(ok), 'write');
  assert.equal(api.emptyLinkRelease({ ...ok, viewOnly: true }), 'reject');
  assert.equal(api.emptyLinkRelease({ ...ok, filled: true }), 'reject');
  assert.equal(api.emptyLinkRelease({ ...ok, center: true }), 'reject');
  assert.equal(api.emptyLinkRelease({ ...ok, linking: false }), 'reject');
  assert.equal(api.emptyLinkRelease({ ...ok, readOnly: true }), 'reject');
});

test('メモのあるマス：ダブルクリック・メニュー・Enter/F2 は本文を直す。1回のクリックは拡大を待つ。見るだけ・空・中心は拡大', () => {
  const base = { overview: true, viewOnly: false, filled: true, center: false, readOnly: false };
  assert.equal(api.overviewFilledAction({ ...base, gesture: 'click' }), 'wait');
  assert.equal(api.overviewFilledAction({ ...base, gesture: 'dblclick' }), 'edit');
  assert.equal(api.overviewFilledAction({ ...base, gesture: 'menu' }), 'edit');
  assert.equal(api.overviewFilledAction({ ...base, gesture: 'key' }), 'edit');
  assert.equal(api.overviewFilledAction({ ...base, viewOnly: true, gesture: 'dblclick' }), 'zoom');
  assert.equal(api.overviewFilledAction({ ...base, viewOnly: undefined, gesture: 'dblclick' }), 'edit');
  assert.equal(api.overviewFilledAction({ ...base, filled: false, gesture: 'dblclick' }), 'zoom');
  assert.equal(api.overviewFilledAction({ ...base, center: true, gesture: 'dblclick' }), 'zoom');
  assert.equal(api.overviewFilledAction({ ...base, readOnly: true, gesture: 'key' }), 'zoom');
  assert.equal(api.overviewFilledAction({ ...base, overview: false, gesture: 'dblclick' }), 'zoom');
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  assert.match(html, /data-cmd="edit-here"[\s\S]*ここで編集/);
  assert.match(SRC, /cmd === 'edit-here'/);
});

test('直した本文：変わった文だけ保存する。空や同じ文はメモを残す', () => {
  assert.deepEqual(api.overviewEditResult('もとの文', '直した'), { kind: 'save', text: '直した' });
  assert.deepEqual(api.overviewEditResult('1行目\n2行目', '1行目\n直した'), { kind: 'save', text: '1行目\n直した' });
  assert.deepEqual(api.overviewEditResult('もとの文', ' 前後 '), { kind: 'save', text: ' 前後 ' });
  assert.deepEqual(api.overviewEditResult('もとの文', ''), { kind: 'keep' });
  assert.deepEqual(api.overviewEditResult('もとの文', '   \n'), { kind: 'keep' });
  assert.deepEqual(api.overviewEditResult('もとの文', 'もとの文'), { kind: 'keep' });
  assert.deepEqual(api.overviewEditResult('', '   '), { kind: 'keep' });
});
