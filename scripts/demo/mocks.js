'use strict';

/* モック（番号つきの注釈を重ねた画面イメージ）を作る：
 *   node scripts/demo/mocks.js [出力のフォルダ]（既定：demo-out/）→ mock-1-honeycomb.png … mock-6-export.png
 * アプリ（ブラウザ版）の画面を撮り、注目させたい部品の位置を取って、説明の列と一緒に 1920×1080 の1枚に組む。
 * 先に npm run build:web。Playwright を使う（scripts/demo/recorder.js）。 */

const fs = require('node:fs');
const path = require('node:path');
const { openApp, seed, cellAt, loadPlaywright, ROOT } = require('./recorder');
const { buildSample } = require('./sample');

const outDir = path.resolve(process.argv[2] || path.join(ROOT, 'demo-out'));

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// 1枚の組み立て：左に画面（注釈の枠と番号）、右に番号ごとの説明
function sheetHtml({ title, sub, png, callouts, view }) {
  const W = 1400;
  const s = W / view.width;
  const H = Math.round(view.height * s);
  const x0 = 40;
  const y0 = 112;
  const marks = callouts.map((c, i) => {
    const b = c.box;
    if (!b) return '';
    const pad = c.pad ?? 4;
    const left = x0 + (b.x - pad) * s;
    const top = y0 + (b.y - pad) * s;
    return `<div class="mark" style="left:${left}px;top:${top}px;width:${(b.width + pad * 2) * s}px;height:${(b.height + pad * 2) * s}px"></div>`
      + `<div class="num" style="left:${left - 17}px;top:${top - 17}px">${i + 1}</div>`;
  }).join('');
  const notes = callouts.map((c, i) => `<li><span class="n">${i + 1}</span><div><b>${esc(c.title)}</b>${c.text ? `<p>${esc(c.text)}</p>` : ''}</div></li>`).join('');
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><style>
  * { box-sizing: border-box; }
  body { margin: 0; width: 1920px; height: 1080px; overflow: hidden; background: radial-gradient(ellipse at 30% 0%, #16233a 0%, #0b0f16 60%); color: #e7e9ea; font-family: "IPAPGothic", "IPAGothic", sans-serif; }
  header { position: absolute; left: 40px; top: 28px; right: 40px; display: flex; align-items: baseline; gap: 18px; }
  header .logo { width: 40px; height: 40px; align-self: center; }
  header h1 { margin: 0; font-size: 38px; letter-spacing: .04em; }
  header p { margin: 0; color: #9fb0c3; font-size: 20px; }
  .shot { position: absolute; left: ${x0}px; top: ${y0}px; width: ${W}px; height: ${H}px; border: 1px solid #2c3644; border-radius: 14px; box-shadow: 0 24px 70px rgba(0,0,0,.55); overflow: hidden; }
  .shot img { display: block; width: 100%; height: 100%; }
  .mark { position: absolute; border: 3px solid #ffd400; border-radius: 10px; box-shadow: 0 0 0 1px rgba(0,0,0,.5), 0 0 18px rgba(255,212,0,.35); }
  .num, .n { display: grid; place-items: center; width: 34px; height: 34px; border-radius: 50%; background: linear-gradient(135deg, #ffd400, #f59e0b); color: #1a1205; font: 800 18px/1 "DejaVu Sans", sans-serif; box-shadow: 0 3px 10px rgba(0,0,0,.5); }
  .num { position: absolute; }
  aside { position: absolute; left: ${x0 + W + 36}px; right: 40px; top: ${y0}px; }
  aside ol { margin: 0; padding: 0; list-style: none; display: grid; gap: 16px; }
  aside li { display: flex; gap: 14px; align-items: flex-start; }
  aside .n { flex: none; }
  aside b { display: block; font-size: 20px; line-height: 1.45; }
  aside p { margin: 4px 0 0; color: #a9b7c6; font-size: 16px; line-height: 1.6; }
  footer { position: absolute; left: ${x0}px; top: ${y0 + H + 16}px; color: #6f8196; font-size: 15px; }
  </style></head><body>
  <header><svg class="logo" viewBox="0 0 100 100"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#1d9bf0"/><stop offset="1" stop-color="#7c3aed"/></linearGradient></defs><polygon points="50,4 90,27 90,73 50,96 10,73 10,27" fill="none" stroke="url(#g)" stroke-width="8" stroke-linejoin="round"/><polygon points="50,30 67,40 67,60 50,70 33,60 33,40" fill="url(#g)"/></svg><h1>${esc(title)}</h1><p>${esc(sub)}</p></header>
  <div class="shot"><img src="data:image/png;base64,${png.toString('base64')}" alt=""></div>
  ${marks}
  <aside><ol>${notes}</ol></aside>
  <footer>六角メモ（ブラウザ版の画面・サンプルのノート「午前の集中ノート」）</footer>
  </body></html>`;
}

(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  const app = await openApp();
  const { page, demo } = app;
  await seed(page, buildSample());
  // 重ね表示（矢印・波紋）は、操作のあいだだけ出し、撮るときは隠す
  const overlay = (on) => page.evaluate((v) => {
    document.getElementById('demoRoot').style.display = v ? '' : 'none';
  }, on);
  await overlay(false);
  const view = page.viewportSize();
  const sheets = [];
  const boxOf = async (target) => {
    if (!target) return null;
    const loc = typeof target === 'string' ? page.locator(target).first() : target;
    if (!(await loc.isVisible().catch(() => false))) return null;
    // スクロールする枠の中の部品は、見えている分だけを囲む
    return loc.evaluate((el) => {
      const r = el.getBoundingClientRect();
      let x0 = r.left;
      let y0 = r.top;
      let x1 = r.right;
      let y1 = r.bottom;
      for (let p = el.parentElement; p; p = p.parentElement) {
        const cs = getComputedStyle(p);
        if (!/(auto|scroll|hidden)/.test(cs.overflow + cs.overflowX + cs.overflowY)) continue;
        const q = p.getBoundingClientRect();
        x0 = Math.max(x0, q.left);
        y0 = Math.max(y0, q.top);
        x1 = Math.min(x1, q.right);
        y1 = Math.min(y1, q.bottom);
      }
      return x1 > x0 && y1 > y0 ? { x: x0, y: y0, width: x1 - x0, height: y1 - y0 } : null;
    });
  };
  const unionOf = (boxes) => {
    const bs = boxes.filter(Boolean);
    if (!bs.length) return null;
    const x = Math.min(...bs.map((b) => b.x));
    const y = Math.min(...bs.map((b) => b.y));
    return { x, y, width: Math.max(...bs.map((b) => b.x + b.width)) - x, height: Math.max(...bs.map((b) => b.y + b.height)) - y };
  };
  async function capture(name, title, sub, defs) {
    const callouts = [];
    for (const d of defs) {
      const targets = Array.isArray(d.target) ? d.target : [d.target];
      const box = unionOf(await Promise.all(targets.map(boxOf)));
      if (!box) console.warn(`  見つからない：${name} / ${d.title}`);
      callouts.push({ ...d, box });
    }
    const png = await page.screenshot(); // 画面の倍率のまま（組むときに縮めて、くっきり）
    sheets.push({ name, title, sub, png, callouts });
  }
  const node = (text) => page.locator('#graphSvg .g-node').filter({ has: page.locator('title', { hasText: text }) }).first();
  const item = (text) => page.locator('#graphPanelBody .g-item').filter({ has: page.locator('.g-item-text, .g-item-input', { hasText: text }) }).first();

  // 1. ハニカム
  await capture('1-honeycomb', 'ハニカムに書いて、つなぐ', '六角形のマスにメモ。関連線・領域・順路で、考えの形が見える', [
    { title: 'マスをクリックして書く', text: '自動で保存。右クリックでメニュー（タグボタン・音声で書く・関連付けのある新しいメモ…）', target: cellAt(page, '3, 0').locator('.zone-body') },
    { title: '関連線（種類ごとの色と向き）', text: '根拠・反論・続き・原因・関連。ラベルも付けられる', target: page.locator('.link-label', { hasText: '記録' }), pad: 10 },
    { title: '領域：マスの集まりに名前', text: '画像・HTML・PDF に書き出す・印刷もここから', target: page.locator('.region-label').first(), pad: 8 },
    { title: 'Dendritic Extension の番号', text: '読む順の道と枝。スライドで見せられる', target: page.locator('.dend-badge').nth(1), pad: 6 },
    { title: 'いいね・ブックマーク・コメント・タグ・🔗', text: '🔗 を右クリック →「この関係線のグラフ」', target: [cellAt(page, '-1, 1').locator('.zone-actions'), cellAt(page, '-1, 1').locator('.zone-tags'), cellAt(page, '-1, 1').locator('.meta-link')] },
    { title: '今日の1枚・未配置の棚', text: '見直すメモが毎日浮かぶ。場所をあとで決めるメモは棚へ', target: ['#shelfBtn', '#todayBtn'] },
  ]);

  // 2. この関係線のグラフ
  await overlay(true);
  await demo.rightClick(cellAt(page, '1, 0').locator('.meta-link'), { ms: 100 });
  await demo.wait(500);
  await demo.click('#sideLinkGraph', { ms: 100 });
  await demo.wait(900);
  await demo.click('#sideClose', { ms: 100 });
  await demo.click('#gFit', { ms: 100 });
  await demo.moveTo(700, 760, 50);
  await demo.wait(1500);
  await overlay(false);
  await capture('2-graph', 'この関係線のグラフ', 'つながるメモだけを取り出し、グラフと本文の一覧で見渡す', [
    { title: '起点とつながるメモ・関連線の数', text: '「すべてのつながり」か「直接の相手だけ」かを選ぶ', target: '#graphFocus' },
    { title: '起点のメモ（緑の枠）', text: '丸をドラッグで動かせる。ダブルクリックでハニカムのマスへ', target: '#graphSvg .g-node.is-origin', pad: 12 },
    { title: '線の種類と数（たためる）', text: '押すたびに開く・たたむ', target: '#graphLegend' },
    { title: '本文の一覧（起点から近い順）', text: '線の種類と相手も一覧で。項目に重ねると、グラフで強調', target: '#graphPanel' },
    { title: 'この順に読む・Markdown・画像/HTML', text: 'スライドで読む・文章としてコピー・書き出す', target: '#graphPanelBody .g-list-tools' },
    { title: '並びを保存・書き出す・印刷', text: '整えた並びに名前を付けて保存', target: ['#gLayoutsBtn', '#gExportBtn'] },
  ]);

  // 3. その場で書き足す・コメント
  await overlay(true);
  await demo.rightClick(node('主張：朝の散歩'), { ms: 100 });
  await demo.wait(500);
  await demo.click('#graphNodeMenu [data-cmd="g-comment"]', { ms: 100 });
  await demo.wait(500);
  await page.keyboard.insertText('4週目の記録も足した。来週は歩く時間を変えて比べる');
  await page.keyboard.press('Control+Enter');
  await demo.wait(500);
  await demo.click(item('根拠：歩いた日').locator('[data-g-edit]'), { ms: 100 });
  await demo.wait(400);
  await page.locator('#graphPanelBody .g-item-input').evaluate((t) => {
    t.focus();
    t.setSelectionRange(t.value.length, t.value.length);
  });
  await page.keyboard.insertText('\n4週目も同じ傾向。雨の日を除くと 3 割');
  await demo.wait(600);
  await overlay(false);
  await capture('3-edit-comment', 'グラフの区画で、そのまま書き足す・コメントする', 'グラフを見ながら、気づいたことをその場でメモに残す', [
    { title: 'コメント（返信のツリー）', text: '丸の右クリック →「コメントを書く」でサイドバーに。返信もツリーで', target: '#sideThread' },
    { title: 'コメントを書く欄', text: 'Ctrl+Enter で投稿', target: '#sideInput' },
    { title: '一覧で本文を書き足す・直す', text: '「書き足す」→ 書いて Ctrl+Enter で保存、Esc でやめる。ハニカムにもすぐ反映', target: '#graphPanelBody .g-item.is-editing' },
    { title: '選んだメモと直接の相手を強調', text: '一覧の項目を押すと、グラフのそのメモへ', target: '#graphSvg .g-node.is-selected', pad: 12 },
  ]);

  // 4. 丸の右クリック：つながる新しいメモ
  await page.keyboard.press('Escape');
  await overlay(true);
  await demo.click('#sideClose', { ms: 100 }).catch(() => {});
  await demo.wait(400);
  await demo.rightClick(node('反論：雨の日'), { ms: 100 });
  await demo.wait(500);
  await demo.click('#gNewText', { ms: 100 });
  await page.keyboard.insertText('対策：雨の日は駅の地下通路を 15 分歩く');
  await demo.click('#gNewKinds .kind-btn[data-kind="next"]', { ms: 100 });
  await demo.click('#gNewLabel', { ms: 100 });
  await page.keyboard.insertText('雨の日の代わり');
  await demo.wait(400);
  await overlay(false);
  await capture('4-node-menu', '丸の右クリック：コメント・書き足す・つながる新しいメモ', 'グラフの中から、関連線でつながった新しいメモを作れる', [
    { title: 'コメントを書く・本文を書き足す', text: 'サイドバーのコメント欄・右の一覧の書く欄へ', target: ['#graphNodeMenu [data-cmd="g-comment"]', '#graphNodeMenu [data-cmd="g-edit"]'] },
    { title: '新しいメモの本文', text: 'Ctrl+Enter でも作れる', target: '#gNewText' },
    { title: '線の種類', text: '向きのある種類は「→」付き', target: '#gNewKinds' },
    { title: '向きの入れ替え・線のラベル', target: ['#gNewDir', '#gNewLabel', '#gNewMake'] },
    { title: '置く場所・作ったあと', text: '近くの空いたマスへ。「作ったメモから続けて作る」で、つながりを次々に', target: ['#gNewWhere', '#gNewChain'] },
    { title: 'ほかのメモと関連付ける・この順に読む・起点にする', target: ['#graphNodeMenu [data-cmd="g-link"]', '#graphNodeMenu [data-cmd="g-jump"]'] },
  ]);

  // 5. Dendritic Extension のスライド
  await page.keyboard.press('Escape');
  await demo.wait(300);
  await overlay(true);
  await demo.click('#appMenuBtn', { ms: 100 });
  await demo.click('#appMenu [data-cmd="dendrites"]', { ms: 100 });
  await demo.wait(500);
  await demo.click(page.locator('.dend-card').filter({ has: page.locator('.dend-name', { hasText: /^朝のルーティン$/ }) }).locator('[data-dend-slides]'), { ms: 100 });
  await demo.wait(600);
  for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowRight');
  await page.keyboard.press('o');
  await demo.moveTo(1240, 780, 50);
  await demo.wait(700);
  await overlay(false);
  await capture('5-slides', 'Dendritic Extension をスライドで見せる', '読む順の道と枝を、1枚ずつ大きく。分かれ目で枝を選べる', [
    { title: '一覧：順路と枝ごとの見出し', text: 'O で開く・閉じる。押すとその1枚へ', target: '#slideOutline' },
    { title: '順路の名前と位置', text: '順路の色の見出しと縁', target: '#slideCard .slide-group' },
    { title: '枝の分かれ目', text: '「枝へ」「枝を飛ばして続きへ」。1〜9 のキーでも', target: '#slideCard .slide-choices' },
    { title: '自動で進む（P）・秒数', target: ['#slidePlay', '#slideSec'] },
    { title: 'ハニカムのこのマスへ（Enter）', target: '#slideJump' },
  ]);

  // 6. 書き出す・印刷
  await page.keyboard.press('Escape');
  await demo.wait(300);
  await overlay(true);
  await demo.click('#sideClose', { ms: 100 }).catch(() => {});
  await page.evaluate(() => document.querySelector('[data-tab="grid"]').click()); // ハニカムに戻る
  await demo.wait(700);
  await demo.click('.region-label >> nth=0', { ms: 100 });
  await demo.click('#regionMenu [data-cmd="export"]', { ms: 100 });
  await demo.wait(900);
  await overlay(false);
  await capture('6-export', '画像・HTML・PDF で書き出す・印刷', '領域・選んだマス・関係線のまとまりを、図と本文の一覧に', [
    { title: '題名と、書き出すものの数', target: ['#exportWhat', '#exportName'] },
    { title: '図の見本', text: '図の番号は一覧の番号。いいねは ♥、タグは色の点', target: '.export-preview' },
    { title: '配色・一覧やコメントを付けるか', target: '.export-opts' },
    { title: '画像をコピー・PNG・HTML・PDF・印刷', text: 'HTML は1つのファイルで、どのブラウザでも開ける（PDF はデスクトップ版）', target: '.export-actions' },
  ]);
  await app.close();

  // 組み立てて書き出す
  const { chromium } = loadPlaywright();
  const browser = await chromium.launch();
  const p2 = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  for (const sh of sheets) {
    await p2.setContent(sheetHtml({ ...sh, view }));
    await p2.waitForTimeout(150);
    const file = path.join(outDir, `mock-${sh.name}.png`);
    await p2.screenshot({ path: file });
    console.log(file);
  }
  await browser.close();
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
