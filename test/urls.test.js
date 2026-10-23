'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const U = require('../urls.js');

test('Web の URL と、マスへのリンクの見分け', () => {
  assert.equal(U.isWebUrl('https://example.com/a'), true);
  assert.equal(U.isWebUrl('http://localhost:8080/'), true);
  assert.equal(U.isWebUrl('javascript:alert(1)'), false);
  assert.equal(U.isWebUrl('file:///C:/x'), false);
  assert.equal(U.isWebUrl('ftp://x.com'), false);
  assert.equal(U.classifyPasted('  https://example.com/a  '), 'web');
  assert.equal(U.classifyPasted('https://example.com/a と説明'), null); // URL だけではない
  assert.equal(U.classifyPasted('hexmemo://memo/abc-123?b=main'), 'memo');
  assert.equal(U.classifyPasted('ただの文字'), null);
});

test('追跡用の付加情報を外す（YouTube の si、X の s・t も）', () => {
  assert.equal(U.stripTracking('https://ex.com/a?utm_source=x&id=3&fbclid=abc'), 'https://ex.com/a?id=3');
  assert.equal(U.stripTracking('https://youtu.be/abcdefghijk?si=XYZ&t=30'), 'https://youtu.be/abcdefghijk?t=30');
  assert.equal(U.stripTracking('https://x.com/u/status/1?s=20&t=abc'), 'https://x.com/u/status/1');
  assert.equal(U.stripTracking('https://ex.com/a?t=5'), 'https://ex.com/a?t=5'); // X 以外の t は残す
  assert.equal(U.stripTracking('not a url'), 'not a url');
});

test('YouTube の動画と再生位置', () => {
  assert.deepEqual(U.youtubeInfo('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=754'), { id: 'dQw4w9WgXcQ', start: 754 });
  assert.deepEqual(U.youtubeInfo('https://youtu.be/dQw4w9WgXcQ?t=12m34s'), { id: 'dQw4w9WgXcQ', start: 754 });
  assert.deepEqual(U.youtubeInfo('https://www.youtube.com/shorts/dQw4w9WgXcQ'), { id: 'dQw4w9WgXcQ', start: null });
  assert.deepEqual(U.youtubeInfo('https://youtube.com/live/dQw4w9WgXcQ?start=90'), { id: 'dQw4w9WgXcQ', start: 90 });
  assert.equal(U.youtubeInfo('https://example.com/watch?v=dQw4w9WgXcQ'), null);
  assert.equal(U.parseTime('1h2m3s'), 3723);
  assert.equal(U.parseTime('12:34'), 754);
  assert.equal(U.parseTime('1:02:03'), 3723);
  assert.equal(U.parseTime('abc'), null);
  assert.equal(U.formatTime(754), '12:34');
  assert.equal(U.formatTime(3723), '1:02:03');
  assert.equal(U.withYoutubeStart('https://www.youtube.com/watch?v=dQw4w9WgXcQ', 754), 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=754s');
  assert.equal(U.withYoutubeStart('https://youtu.be/dQw4w9WgXcQ?t=5', null), 'https://youtu.be/dQw4w9WgXcQ');
});

test('同じページの判定（www・末尾の / ・#・引数の順番・追跡用の引数・YouTube の再生位置の違いは同じ）', () => {
  const k = U.pageKey;
  assert.equal(k('https://www.Example.com/a/?b=2&a=1#top'), k('http://example.com/a?a=1&b=2'));
  assert.equal(k('https://example.com/a?utm_source=x'), k('https://example.com/a'));
  assert.notEqual(k('https://example.com/a'), k('https://example.com/b'));
  assert.equal(k('https://youtu.be/dQw4w9WgXcQ?t=30'), k('https://www.youtube.com/watch?v=dQw4w9WgXcQ'));
  assert.equal(k('javascript:x'), null);
});

test('本文の中の URL を見つける（末尾の句読点・閉じかっこは含めない）', () => {
  const t = 'こちら https://example.com/a?b=1。と（https://ex.org/x）と https://ja.wikipedia.org/wiki/A_(B) と hexmemo://memo/abc?b=main です';
  assert.deepEqual(U.findUrls(t).map((x) => x.url), [
    'https://example.com/a?b=1', 'https://ex.org/x', 'https://ja.wikipedia.org/wiki/A_(B)', 'hexmemo://memo/abc?b=main',
  ]);
  assert.deepEqual(U.findUrls('URL なし'), []);
});

test('表示用の短い形・国際化ドメインの注意', () => {
  assert.equal(U.shortUrl('https://www.example.com/'), 'example.com');
  assert.equal(U.shortUrl('https://example.com/%E6%97%A5%E6%9C%AC'), 'example.com/日本');
  assert.ok(U.shortUrl(`https://example.com/${'a'.repeat(80)}`).endsWith('…'));
  assert.equal(U.hostOf('https://www.example.com/x'), 'example.com');
  assert.equal(U.isSuspiciousHost('https://xn--pple-43d.com/'), true);
  assert.equal(U.isSuspiciousHost('https://apple.com/'), false);
});

test('マスへのリンク', () => {
  const url = U.makeInternalLink({ memoId: '7e0f0110-6ad6-48bd-adc5-2275f0ebf1dd', boardId: 'main', appId: 'a1b2c3d4' });
  assert.equal(url, 'hexmemo://memo/7e0f0110-6ad6-48bd-adc5-2275f0ebf1dd?b=main&a=a1b2c3d4');
  assert.deepEqual(U.parseInternalLink(url), { memoId: '7e0f0110-6ad6-48bd-adc5-2275f0ebf1dd', boardId: 'main', appId: 'a1b2c3d4' });
  assert.deepEqual(U.parseInternalLink('hexmemo://memo/abc'), { memoId: 'abc', boardId: null, appId: null });
  assert.equal(U.parseInternalLink('hexmemo://memo/a/b'), null); // ID に使えない文字
  assert.equal(U.parseInternalLink('hexmemo://other/abc'), null);
  assert.equal(U.parseInternalLink('https://memo/abc'), null);
});
