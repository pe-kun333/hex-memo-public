'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { encodeClipHtml, decodeClipHtml, clipCells } = require('../clip.js');

test('マスの中身を HTML に埋め込んで取り出せる（本文は表示用にエスケープ）', () => {
  const payload = { v: 1, nonce: 'n1', cut: false, record: { text: '<b>A & B</b>\n2行目', likedLevel: 2, children: { camera: { x: 0, y: 0 }, memos: { '1,0': { text: '子' } } } } };
  const html = encodeClipHtml(payload.record.text, payload);
  assert.ok(html.includes('&lt;b&gt;A &amp; B&lt;/b&gt;<br>2行目'));
  assert.deepEqual(decodeClipHtml(`<meta charset="utf-8">${html}`), payload);
});

test('ふつうの HTML や壊れたデータは null', () => {
  assert.equal(decodeClipHtml('<p>hello</p>'), null);
  assert.equal(decodeClipHtml('<div data-hex-memo="!!!"></div>'), null);
  assert.equal(decodeClipHtml(`<div data-hex-memo="${Buffer.from('{"v":1}').toString('base64')}"></div>`), null);
  assert.equal(decodeClipHtml(''), null);
});

test('複数のマス：検査を通ったものだけ、並び（左上からの位置）と組にする', () => {
  const norm = (r) => (r && typeof r.text === 'string' ? { text: r.text } : null);
  const payload = { records: [{ text: 'A' }, { text: 'B' }, { text: 'C' }], offsets: [{ dq: 0, dr: 0 }, { dq: 1, dr: 0 }, { dq: -1, dr: 3 }] };
  assert.deepEqual(clipCells(payload, norm, 200), { cells: [{ text: 'A' }, { text: 'B' }, { text: 'C' }], offsets: [{ dq: 0, dr: 0 }, { dq: 1, dr: 0 }, { dq: -1, dr: 3 }] });
  // 検査で落ちたマスは、その位置ごと外す
  const bad = clipCells({ records: [{ text: 'A' }, 5, { text: 'C' }], offsets: payload.offsets }, norm, 200);
  assert.deepEqual(bad, { cells: [{ text: 'A' }, { text: 'C' }], offsets: [{ dq: 0, dr: 0 }, { dq: -1, dr: 3 }] });
  // 位置が無い・足りない・おかしい・重なる → 位置なし（近くの空いているマスへ1件ずつ）
  assert.equal(clipCells({ records: payload.records }, norm, 200).offsets, null);
  assert.equal(clipCells({ records: payload.records, offsets: payload.offsets.slice(0, 2) }, norm, 200).offsets, null);
  assert.equal(clipCells({ records: payload.records, offsets: [{ dq: 0, dr: 0 }, { dq: 0.5, dr: 0 }, { dq: 1, dr: 1 }] }, norm, 200).offsets, null);
  assert.equal(clipCells({ records: payload.records, offsets: [{ dq: 0, dr: 0 }, { dq: 0, dr: 0 }, { dq: 1, dr: 1 }] }, norm, 200).offsets, null);
  assert.equal(clipCells({ records: payload.records, offsets: [{ dq: 0, dr: 0 }, { dq: 99999, dr: 0 }, { dq: 1, dr: 1 }] }, norm, 200).offsets, null);
  // 上限
  assert.equal(clipCells({ records: payload.records, offsets: payload.offsets }, norm, 2).cells.length, 2);
  assert.deepEqual(clipCells({}, norm, 200), { cells: [], offsets: null });
});
