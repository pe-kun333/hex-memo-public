'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('../ribbon.js');

const len = (s) => [...s].length;

test('文に分ける：句点・感嘆符と閉じかっこ、英文のピリオド', () => {
  assert.deepEqual(R.sentences('今日は晴れ。「散歩しよう！」と言った。本当？はい'), ['今日は晴れ。', '「散歩しよう！」', 'と言った。', '本当？', 'はい']);
  assert.deepEqual(R.sentences('Hello world. This is 3.14 ok! Next'), ['Hello world.', 'This is 3.14 ok!', 'Next']);
});

test('段落・文の区切りでマスの大きさ（目安）にまとめ、1文が長ければ読点で分ける', () => {
  const long = 'あ'.repeat(30) + '、' + 'い'.repeat(30) + '、' + 'う'.repeat(30) + '。';
  const text = `一つ目の文です。二つ目の文です。\n\n${long}`;
  const chunks = R.splitText(text, { size: 40 });
  assert.equal(chunks[0].text, '一つ目の文です。二つ目の文です。');
  assert.equal(chunks[0].para, true);
  assert.ok(chunks.slice(1).every((c) => len(c.text) <= 40), JSON.stringify(chunks));
  assert.equal(chunks[1].para, true); // 次の段落の最初のマス
  assert.equal(chunks[2].para, false);
  assert.ok(chunks[1].text.endsWith('、'));
  assert.equal(chunks.map((c) => c.text).join(''), `一つ目の文です。二つ目の文です。${long}`);
});

test('見出し（# や句点で終わらない短い行）は1マス。最後の短い行は見出しにしない', () => {
  const chunks = R.splitText('# はじめに\n本文の一文目。本文の二文目。\n\n第2章 使い方\n\n使い方の本文。\n\nおしまい');
  assert.deepEqual(chunks.map((c) => [c.text, c.head]), [
    ['はじめに', true], ['本文の一文目。本文の二文目。', false], ['第2章 使い方', true], ['使い方の本文。', false], ['おしまい', false],
  ]);
});

test('段落の中の改行：文の途中の折り返しはつなぎ、文の終わりの改行は段落の区切り', () => {
  const chunks = R.splitText('これは途中で折り返された長めの文の前半部分で\n後半はここで終わります。\n次の段落です。', { size: 70 });
  assert.deepEqual(chunks.map((c) => [c.text, c.para]), [['これは途中で折り返された長めの文の前半部分で後半はここで終わります。', true], ['次の段落です。', true]]);
  const en = R.splitText('This is a fairly long line that was\nwrapped by the source.', { size: 70 });
  assert.equal(en[0].text, 'This is a fairly long line that was wrapped by the source.');
  // 短い行（見出し）のあとに本文が続くときはつながない
  const h = R.splitText('はじめに\n本文の一文目です。', { size: 70 });
  assert.deepEqual(h.map((c) => [c.text, c.head]), [['はじめに', true], ['本文の一文目です。', false]]);
});

test('箇条書きは項目ごとに改行を保ってまとめる', () => {
  const chunks = R.splitText('準備するもの\n・ノート\n・ペン\n・時間', { size: 70 });
  assert.deepEqual(chunks.map((c) => [c.text, c.head]), [['準備するもの', true], ['・ノート\n・ペン\n・時間', false]]);
});

test('帯の配置：perLine で折り返し、行の間は2行あける。段落は行の頭から、見出しは前を3行あけて1行を使う', () => {
  const c = (text, head = false, para = false) => ({ text, head, para });
  const chunks = [c('題', true, true), c('a', false, true), c('b'), c('c'), c('d'), c('e', false, true), c('見出し', true, true), c('f', false, true)];
  const pos = R.layout(chunks, 3);
  assert.deepEqual(pos, [
    { dr: 0, c: 0 }, // 題（見出し）
    { dr: 3, c: 0 }, { dr: 3, c: 1 }, { dr: 3, c: 2 }, // a b c
    { dr: 6, c: 0 }, // d（折り返し）
    { dr: 9, c: 0 }, // e（新しい段落は行の頭から）
    { dr: 13, c: 0 }, // 見出し（前を3行あける）
    { dr: 16, c: 0 }, // f
  ]);
});

test('軸座標：行の頭がそろい、2行あけの行は半マスずれる', () => {
  const x = ({ q, r }) => q + r / 2; // マス中心の横位置（マス幅単位）
  const a = R.toAxial({ dr: 0, c: 0 }, 2, 1);
  const b = R.toAxial({ dr: 3, c: 0 }, 2, 1);
  const d = R.toAxial({ dr: 6, c: 0 }, 2, 1);
  assert.deepEqual([a.r, b.r, d.r], [1, 4, 7]);
  assert.equal(x(b) - x(a), 0.5);
  assert.equal(x(d) - x(a), 0);
});

test('分けたマスのつなぎ直し：箇条書きどうしは改行、英文どうしは空白、日本語はそのまま', () => {
  const chunks = R.splitText('準備するもの\n・ノート\n・ペン\n・時間', { size: 8 });
  const items = chunks.filter((c) => !c.head);
  assert.ok(items.length >= 2);
  const joined = items.map((c, i) => (i ? R.seam(items[i - 1].text, c.text) : '') + c.text).join('');
  assert.equal(joined, '・ノート\n・ペン\n・時間');
  assert.equal(R.seam('This is one.', 'That is two.'), ' ');
  assert.equal(R.seam('一文目。', '二文目。'), '');
  // 1段落を分けたマスをつなぎ直すと、元の段落に戻る
  const text = 'これは一文目です。これは二文目で、少し長めに書いてあります。三文目もあります。';
  const parts = R.splitText(text, { size: 20 });
  assert.ok(parts.length > 1 && parts[0].para && parts.slice(1).every((c) => !c.para));
  assert.equal(parts.map((c, i) => (i ? R.seam(parts[i - 1].text, c.text) : '') + c.text).join(''), text);
});
