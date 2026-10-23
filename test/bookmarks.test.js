'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const B = require('../bookmarks.js');

const SAMPLE = `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">
<TITLE>Bookmarks</TITLE>
<H1>Bookmarks</H1>
<DL><p>
    <DT><H3 ADD_DATE="1700000000" PERSONAL_TOOLBAR_FOLDER="true">ブックマーク バー</H3>
    <DL><p>
        <DT><A HREF="https://example.com/a" ADD_DATE="1700000100">記事 A &amp; B</A>
        <DT><A HREF="javascript:void(0)">ブックマークレット</A>
        <DT><H3>ゲーム</H3>
        <DL><p>
            <DT><A HREF="https://game.example/1">ゲーム 1</A>
            <DT><H3>空のフォルダ</H3>
            <DL><p>
            </DL><p>
        </DL><p>
    </DL><p>
    <DT><A HREF="https://loose.example/">フォルダの外</A>
</DL><p>`;

test('ブックマークの HTML を木にする（フォルダ・日時・実体参照。http(s) 以外は読まない）', () => {
  const tree = B.parseBookmarksHtml(SAMPLE);
  assert.equal(tree.items.length, 1);
  assert.equal(tree.items[0].title, 'フォルダの外');
  const bar = tree.folders[0];
  assert.equal(bar.title, 'ブックマーク バー');
  assert.deepEqual(bar.items.map((i) => i.title), ['記事 A & B']);
  assert.equal(bar.items[0].addedAt, new Date(1700000100 * 1000).toISOString());
  assert.equal(bar.folders[0].title, 'ゲーム');
  assert.deepEqual(bar.folders[0].items.map((i) => i.url), ['https://game.example/1']);
});

test('渦巻きの並び：中心から周ごとに右上を起点に時計回り（重ならない）', () => {
  const keys = B.spiralKeys(19);
  assert.equal(keys[0], '0,0');
  assert.deepEqual(keys.slice(1, 7), ['1,-1', '1,0', '0,1', '-1,1', '-1,0', '0,-1']);
  assert.equal(new Set(keys).size, 19);
});

test('ノートの計画：フォルダは子ノート、空のフォルダは作らない、深すぎる中身は上のノートへ', () => {
  const plan = B.planImport(B.parseBookmarksHtml(SAMPLE), { rootName: 'ブックマーク', now: '2026-09-26T00:00:00.000Z' });
  assert.deepEqual(plan.notebooks.map((n) => [n.name, n.parent, Object.keys(n.memos).length]), [
    ['ブックマーク', null, 1], ['ブックマーク バー', 0, 1], ['ゲーム', 1, 1],
  ]);
  assert.equal(plan.bookmarks, 3);
  const rec = plan.notebooks[1].memos['0,0'];
  assert.equal(rec.text, '記事 A & B');
  assert.equal(rec.urls[0].url, 'https://example.com/a');
  const shallow = B.planImport(B.parseBookmarksHtml(SAMPLE), { maxDepth: 1 });
  assert.equal(shallow.notebooks.length, 2);
  assert.deepEqual(Object.values(shallow.notebooks[1].memos).map((r) => r.text).sort(), ['ゲーム › ゲーム 1', '記事 A & B'].sort());
});
