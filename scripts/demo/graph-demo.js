'use strict';

/* デモ動画「関係線のグラフで、つながりを見渡し、その場で書き足す」（約 1 分半）
 *   node scripts/demo/graph-demo.js [出力の mp4]（既定：demo-out/hexmemo-graph-demo.mp4）
 * 先に npm run build:web。Playwright と ffmpeg を使う（scripts/demo/recorder.js）。 */

const path = require('node:path');
const { openApp, seed, Recorder, cellAt, ROOT } = require('./recorder');
const { buildSample } = require('./sample');

const out = path.resolve(process.argv[2] || path.join(ROOT, 'demo-out', 'hexmemo-graph-demo.mp4'));

(async () => {
  const app = await openApp();
  const { page, demo } = app;
  await seed(page, buildSample());
  const node = (text) => page.locator('#graphSvg .g-node').filter({ has: page.locator('title', { hasText: text }) }).first();
  // 一覧の項目（本文で探す。ほかの項目の「線」の欄に同じ文字が出ても間違えないように）
  const item = (text) => page.locator('#graphPanelBody .g-item').filter({ has: page.locator('.g-item-text, .g-item-input', { hasText: text }) }).first();

  const rec = new Recorder(page);
  await rec.start(out);

  // 0. 表紙
  await demo.title('六角メモ', '関係線のグラフで、つながりを見渡し、その場で書き足す', ['この関係線のグラフ', '本文の一覧で書き足す', 'コメント', 'つながる新しいメモ', 'スライド・書き出し']);
  await demo.wait(3200);
  await demo.title(null);
  await demo.wait(500);

  // 1. ハニカム
  await demo.caption('1', 'ハニカムに置いたメモを、関連線でつなぐ', '根拠・反論・原因・続き … 種類ごとに色と向きがあります');
  await demo.moveToEl(cellAt(page, '2, 0'), { ms: 900 });
  await demo.wait(700);
  await demo.moveToEl(cellAt(page, '1, -1'), { ms: 700 });
  await demo.wait(700);
  await demo.moveToEl(cellAt(page, '0, 1'), { ms: 700 });
  await demo.wait(900);

  // 2. 🔗 の右クリック →「この関係線のグラフ」
  await demo.caption('2', '🔗 を右クリック →「この関係線のグラフ」', '「主張：朝の散歩は…」とつながるメモだけを取り出します');
  await demo.rightClick(cellAt(page, '1, 0').locator('.meta-link'), { ms: 800 });
  await demo.wait(900);
  await demo.spot('#sideLinkGraph', 6);
  await demo.wait(900);
  await demo.spot(null);
  await demo.click('#sideLinkGraph', { ms: 600 });
  await demo.wait(1400);
  await demo.click('#sideClose', { ms: 600 }); // グラフを広く見せる（コメントのときにまた開く）
  await demo.wait(300);
  await demo.click('#gFit', { ms: 500 });
  await demo.wait(1200);

  // 3. 絞り込んだグラフと本文の一覧
  await demo.caption('3', 'つながるメモだけのグラフと、本文の一覧', '起点（緑の枠）から近い順に並び、線の種類と相手も一覧で見えます');
  await demo.spot('#graphPanel', 4);
  await demo.wait(1600);
  await demo.spot(null);
  await demo.moveToEl(item('根拠：歩いた日'), { ms: 700 });
  await demo.wait(1100);
  await demo.moveToEl(item('反論：雨の日'), { ms: 600 });
  await demo.wait(1100);
  await demo.moveToEl(item('原因：起きてすぐ'), { ms: 600 });
  await demo.wait(1000);

  // 3b. 線の種類と数はたためる
  await demo.caption('3', '線の種類と数は、たたんで広く見られる', '下の凡例は押すたびに開く・たたむを切り替えます');
  await demo.click('#graphLegend [data-legend-toggle]', { ms: 700 });
  await demo.wait(1200);
  await demo.click('#graphLegend [data-legend-toggle]', { ms: 300 });
  await demo.wait(900);

  // 4. 一覧でそのまま書き足す
  await demo.caption('4', '一覧で、本文をそのまま書き足す', '「書き足す」→ 書いて Ctrl+Enter。ハニカムのメモにもすぐ反映されます');
  await demo.click(item('根拠：歩いた日').locator('[data-g-edit]'), { ms: 700 });
  await demo.wait(500);
  await page.locator('#graphPanelBody .g-item-input').evaluate((t) => {
    t.focus();
    t.setSelectionRange(t.value.length, t.value.length);
  });
  await demo.type('\n4週目も同じ傾向。雨の日を除くと 3 割', 70);
  await demo.wait(600);
  await demo.press('Control+Enter', 'Ctrl + Enter');
  await demo.wait(1500);

  // 5. 丸の右クリック → コメント
  await demo.caption('5', '丸を右クリック → コメントを書く', 'グラフを見ながら、気づいたことをそのメモに残せます');
  await demo.rightClick(node('主張：朝の散歩'), { ms: 800 });
  await demo.wait(1300);
  await demo.click('#graphNodeMenu [data-cmd="g-comment"]', { ms: 600 });
  await demo.wait(700);
  await demo.type('4週目の記録もグラフに足した。来週は歩く時間を変えて比べる', 60);
  await demo.wait(500);
  await demo.press('Control+Enter', 'Ctrl + Enter');
  await demo.wait(1800);

  // 6. 丸から、つながる新しいメモを作る
  await demo.caption('6', '丸から、関連線でつながる新しいメモを作る', '本文・線の種類（続き・根拠・反論 …）・ラベルを選んで「作る」');
  await demo.rightClick(node('反論：雨の日'), { ms: 800 });
  await demo.wait(900);
  await demo.click('#gNewText', { ms: 500 });
  await demo.type('対策：雨の日は駅の地下通路を 15 分歩く', 65);
  await demo.wait(400);
  await demo.click('#gNewKinds .kind-btn[data-kind="next"]', { ms: 500 });
  await demo.wait(600);
  await demo.click('#gNewMake', { ms: 500 });
  await demo.wait(2400);
  await demo.moveToEl(node('対策：雨の日は駅'), { ms: 700 }).catch(() => {});
  await demo.wait(1400);

  // 7. この順に読む（スライド）
  await demo.caption('7', '一覧の順に、スライドで読む', '起点 → 直接の相手 → 2 つ先 … と、1 枚ずつ大きく');
  await demo.click('#graphPanelBody [data-g-read]', { ms: 800 });
  await demo.wait(1600);
  for (let i = 0; i < 3; i++) {
    await demo.press('ArrowRight', '→');
    await demo.wait(1300);
  }
  await demo.press('Escape', 'Esc');
  await demo.wait(800);

  // 8. 書き出す・印刷
  await demo.caption('8', 'まとまりを画像・HTML・PDF に書き出す・印刷', '図の番号は一覧の番号。HTML は 1 つのファイルで、どのブラウザでも開けます');
  await demo.click('#gExportBtn', { ms: 800 });
  await demo.wait(1200);
  await demo.moveToEl('#exportImg', { ms: 700 });
  await demo.wait(1600);
  await demo.click('[data-ex-theme="dark"]', { ms: 600 });
  await demo.wait(1300);
  await demo.click('[data-ex-theme="light"]', { ms: 400 });
  await demo.wait(800);
  await demo.click('#exportCancel', { ms: 600 });
  await demo.wait(700);

  // 9. 終わり
  await demo.caption(null);
  await demo.title('六角メモ', '書く・つなぐ・見渡す。グラフの中で、そのまま考えを育てる', ['関係線のグラフ', '一覧で書き足す', 'コメント', 'つながる新しいメモ', 'スライド', '画像・HTML・PDF']);
  await demo.wait(3200);

  const r = await rec.stop();
  console.log(`${r.out}（${r.seconds.toFixed(1)} 秒）`);
  if (app.errors.length) console.log('ページのエラー：', app.errors);
  await app.close();
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
