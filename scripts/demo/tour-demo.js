'use strict';

/* デモ動画「六角メモのひとめぐり」（約 2 分）：書く・タグボタン・関連付け・今日の1枚・Dendritic Extension のスライド・
 * 元に戻す・音声で入力・領域の書き出し。
 *   node scripts/demo/tour-demo.js [出力の mp4]（既定：demo-out/hexmemo-tour-demo.mp4）
 * 先に npm run build:web。Playwright と ffmpeg を使う（scripts/demo/recorder.js）。 */

const path = require('node:path');
const { openApp, seed, Recorder, cellAt, ROOT } = require('./recorder');
const { buildSample } = require('./sample');

const out = path.resolve(process.argv[2] || path.join(ROOT, 'demo-out', 'hexmemo-tour-demo.mp4'));

(async () => {
  const app = await openApp();
  const { page, demo } = app;
  await seed(page, buildSample());
  const snap = async (name) => {
    if (process.env.DEMO_SNAPS) await page.screenshot({ path: path.join(process.env.DEMO_SNAPS, `${name}.png`) });
  };

  const rec = new Recorder(page);
  await rec.start(out);

  // 0. 表紙
  await demo.title('六角メモ', '無限のハニカムに、想いを置く。書いて、つないで、見直す', ['ハニカムに書く', 'タグボタン', '関連線', '今日の1枚', 'スライド', '元に戻す', '音声で入力', '書き出し']);
  await demo.wait(3200);
  await demo.title(null);
  await demo.wait(500);

  // 1. 書く
  await demo.caption('1', 'マスをクリックして書く', '六角形のマスに、思いついたことをそのまま。自動で保存されます');
  await demo.click(cellAt(page, '3, 1'), { ms: 900 });
  await demo.wait(300);
  await demo.type('昼休みにも 10 分歩いてみる', 75);
  await demo.wait(500);
  await demo.press('Escape', 'Esc');
  await demo.wait(900);
  await snap('t1-write');

  // 2. タグボタン
  await demo.caption('2', 'T でタグボタン：よく使うタグをボタンで', '6 つのボタンのセットを切り替えられます（複数のマスにもまとめて）');
  await demo.press('t', 'T');
  await demo.wait(1000);
  await snap('t2-tags');
  await demo.click('#shelfTagPad .tag-pad-btn >> nth=0', { ms: 700 });
  await demo.wait(700);
  await demo.click('#shelfTagPad .tag-pad-btn >> nth=5', { ms: 500 });
  await demo.wait(900);
  await demo.press('Escape', 'Esc');
  await demo.wait(600);

  // 3. 関連付け
  await demo.caption('3', 'Ctrl+L で関連付け（根拠・反論・続き …）', '数字のキーで線の種類を選んでクリック。線には向きと色があります');
  await demo.click(cellAt(page, '2, 1'), { ms: 800 });
  await demo.press('Escape');
  await demo.wait(300);
  await demo.press('Control+l', 'Ctrl + L');
  await demo.wait(700);
  await demo.press('4', '4：続き');
  await demo.wait(700);
  await demo.click(cellAt(page, '3, 1'), { ms: 800 });
  await demo.wait(1400);
  await demo.press('Escape');
  await snap('t3-link');

  // 4. 今日の1枚
  await demo.caption('4', '今日の1枚：忘れているメモを、毎日見直す', '枚数・対象を選べ、AI に分析を頼む文もワンクリックでコピー');
  await demo.click('#todayBtn', { ms: 900 });
  await demo.wait(1800);
  await snap('t4-today');
  await demo.moveToEl('#sideListItems', { dy: 0.3, ms: 700 });
  await demo.wait(1200);
  await demo.click('#todayBtn', { ms: 700 });
  await demo.wait(600);

  // 5. Dendritic Extension をスライドで
  await demo.caption('5', 'Dendritic Extension をスライドで見せる', '読む順の道と枝。分かれ目では「枝へ」「飛ばして続きへ」を選べます');
  await demo.click('#appMenuBtn', { ms: 800 });
  await demo.wait(500);
  await demo.click('#appMenu [data-cmd="dendrites"]', { ms: 500 });
  await demo.wait(900);
  await demo.click(page.locator('.dend-card').filter({ has: page.locator('.dend-name', { hasText: /^朝のルーティン$/ }) }).locator('[data-dend-slides]'), { ms: 700 });
  await demo.wait(2000);
  await snap('t5-cover');
  for (let i = 0; i < 3; i++) {
    await demo.press('ArrowRight', '→');
    await demo.wait(1300);
  }
  await snap('t5-branch');
  await demo.press('1', '1：枝「雨の日」へ');
  await demo.wait(1600);
  await demo.press('ArrowRight', '→');
  await demo.wait(1500);
  await demo.press('Escape', 'Esc');
  await demo.wait(500);
  await page.locator('#sideClose').click().catch(() => {});
  await demo.wait(500);

  // 6. 元に戻す・ゴミ箱
  await demo.caption('6', '消しても、Ctrl+Z ですぐ元に戻せる', '削除したメモはゴミ箱へ（30 日間）。関連線も一緒に戻ります');
  await demo.click(cellAt(page, '1, 1'), { ms: 800 });
  await demo.press('Escape');
  await demo.wait(300);
  await demo.press('Delete', 'Delete');
  await demo.wait(900);
  await demo.click('#confirmOk', { ms: 600 });
  await demo.wait(1300);
  await demo.press('Control+z', 'Ctrl + Z');
  await demo.wait(1700);
  await snap('t6-undo');

  // 7. 音声で入力
  await demo.caption('7', '音声で入力（認識・録音して文字起こし・OS）', '録音は Whisper などがそのまま読める WAV（16kHz）に。srt・vtt も読み込めます');
  await demo.press('Control+Shift+M', 'Ctrl + Shift + M');
  await demo.wait(1500);
  await demo.click('input[name="voiceMethod"][value="record"]', { ms: 700 });
  await demo.wait(1600);
  await snap('t7-voice');
  await demo.click('input[name="voiceMethod"][value="os"]', { ms: 600 });
  await demo.wait(1300);
  await demo.click('#voiceCancel', { ms: 600 });
  await demo.wait(600);

  // 8. 領域を画像・HTML に
  await demo.caption('8', '領域を画像・HTML・PDF に書き出す・印刷', '関係線のまとまりも。図の番号は一覧の番号、HTML は 1 つのファイル');
  await demo.click('.region-label >> nth=0', { ms: 900 });
  await demo.wait(800);
  await demo.click('#regionMenu [data-cmd="export"]', { ms: 600 });
  await demo.wait(1600);
  await demo.moveToEl('#exportImg', { ms: 700 });
  await demo.wait(1800);
  await snap('t8-export');
  await demo.click('#exportCancel', { ms: 600 });
  await demo.wait(600);

  // 9. グラフへ（もう1本の動画の予告）
  await demo.caption('9', '関連グラフ：一覧で書き足し・コメント・新しいメモも', 'くわしくは「関係線のグラフ」のデモ動画で');
  if (await page.locator('[data-tab="graph"]').isVisible()) await demo.click('[data-tab="graph"]', { ms: 900 });
  else await page.evaluate(() => document.querySelector('[data-tab="graph"]').click());
  await demo.wait(2600);
  await snap('t9-graph');

  await demo.caption(null);
  await demo.title('六角メモ', '書く・つなぐ・見直す・見せる。Windows・Mac・iPad（ブラウザ版）で', ['ハニカム', '関連グラフ', '今日の1枚', 'Dendritic Extension', '音声で入力', '画像・HTML・PDF']);
  await demo.wait(3200);

  const r = await rec.stop();
  console.log(`${r.out}（${r.seconds.toFixed(1)} 秒）`);
  if (app.errors.length) console.log('ページのエラー：', app.errors);
  await app.close();
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
