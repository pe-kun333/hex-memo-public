'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const V = require('../voice.js');

test('文字起こしの読み取り：srt は番号と時刻の行を除き、同じ行が続けば1つに', () => {
  const srt = '1\n00:00:00,000 --> 00:00:02,500\n朝の散歩は\n\n2\n00:00:02,500 --> 00:00:05,000\n集中力を上げる\n\n3\n00:00:05,000 --> 00:00:06,000\n集中力を上げる\n';
  assert.equal(V.parseTranscript(srt, 'voice.srt'), '朝の散歩は\n集中力を上げる');
});

test('文字起こしの読み取り：vtt は WEBVTT・NOTE・cue の名前・時刻・話者の印を除く（名前が無くても中身で分かる）', () => {
  const vtt = 'WEBVTT\n\nNOTE メモ\nこれは除く\n\ncue-1\n00:01.000 --> 00:03.000\n<v 私>今日は雨\n\n00:03.000 --> 00:05.000 align:start\n室内で体操\n';
  assert.equal(V.parseTranscript(vtt), '今日は雨\n室内で体操');
});

test('文字起こしの読み取り：Whisper の json（text か segments）・ふつうの文', () => {
  assert.equal(V.parseTranscript(JSON.stringify({ text: ' こんにちは ', segments: [] }), 'a.json'), 'こんにちは');
  assert.equal(V.parseTranscript(JSON.stringify({ segments: [{ text: ' 一つ目' }, { text: '二つ目 ' }] }), 'a.json'), '一つ目\n二つ目');
  assert.equal(V.parseTranscript('\uFEFF一行目\r\n\r\n\r\n\r\n二行目  \r\n', 'a.txt'), '一行目\n\n二行目');
  assert.equal(V.parseTranscript('{ こわれた json', 'a.json'), '{ こわれた json');
});

test('WAV：16kHz・モノラル・16bit の見出しと中身', () => {
  const wav = V.encodeWav(new Float32Array([0, 1, -1, 0.5]), 16000);
  const v = new DataView(wav.buffer);
  const str = (o, n) => String.fromCharCode(...wav.slice(o, o + n));
  assert.equal(str(0, 4), 'RIFF');
  assert.equal(str(8, 4), 'WAVE');
  assert.equal(v.getUint16(22, true), 1);
  assert.equal(v.getUint32(24, true), 16000);
  assert.equal(v.getUint16(34, true), 16);
  assert.equal(v.getUint32(40, true), 8);
  assert.deepEqual([1, 2, 3].map((i) => v.getInt16(44 + i * 2, true)), [32767, -32768, 16383]);
});

test('音をまとめる・間引く：2チャンネルを平均し、48kHz → 16kHz で 1/3 の長さ', () => {
  const mono = V.toMono([new Float32Array([1, 0, 1]), new Float32Array([0, 0, 1])]);
  assert.deepEqual([...mono], [0.5, 0, 1]);
  const down = V.downsample(new Float32Array(48000).fill(0.25), 48000, 16000);
  assert.equal(down.length, 16000);
  assert.equal(down[100], 0.25);
  assert.throws(() => V.downsample(new Float32Array(10), 8000, 16000));
});

test('変換コマンド：{file}・{dir}・{base}・{lang} を埋める（ほかの {…} はそのまま）', () => {
  const cmd = V.fillCommand('whisper "{file}" --language {lang} --output_dir "{dir}" --x {other}', { file: 'C:\\t\\voice.wav', dir: 'C:\\t', base: 'C:\\t\\voice', lang: 'ja' });
  assert.equal(cmd, 'whisper "C:\\t\\voice.wav" --language ja --output_dir "C:\\t" --x {other}');
});
