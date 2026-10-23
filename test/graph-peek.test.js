'use strict';

// グラフの右の一覧・概観の「全文の吹き出し」（renderer.js の gPeekPlace・gPeekModel など）。
// 画面のスクリプトの中にあるので、その部分を取り出してそのまま動かす（DOM は使わない部分だけ）
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { buildIndex } = require('../scripts/build-web');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'renderer.js'), 'utf8');
const CSS = fs.readFileSync(path.join(__dirname, '..', 'styles.css'), 'utf8');
const HTML = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

function slice(from, to) {
  const start = SRC.indexOf(from);
  const end = SRC.indexOf(to, start + from.length);
  assert.ok(start > 0 && end > start, `見つからない：${from}`);
  return SRC.slice(start, end);
}

// 純粋な関数（置き場所・中身）：目印のコメントの間
const PURE = slice('  // ---- 全文の吹き出し：純粋な関数（ここから', '  // ---- 全文の吹き出し：純粋な関数（ここまで');
// eslint-disable-next-line no-new-func
const { gPeekPlace, gPeekModel } = new Function(`${PURE}; return { gPeekPlace, gPeekModel };`)();
// 更新の言い方は画面の formatRelative / formatFull をそのまま使う
// eslint-disable-next-line no-new-func
const { formatRelative, formatFull } = new Function(`${slice('  function formatRelative(', '  const formatCoord')}; return { formatRelative, formatFull };`)();

const rect = (left, top, width = 200, height = 22) => ({ left, top, right: left + width, bottom: top + height });
const VIEW = { w: 1280, h: 800 };
const PANEL = { left: 848, top: 174, right: 1268, bottom: 788 };
const SIZE = { w: 360, h: 180 };

// ---- 置き場所（右の区画の中。グラフの丸は隠さない） ----

const inside = (p, size, panel) => {
  assert.ok(p.x >= panel.left + 8 && p.x + Math.min(size.w, p.w) <= panel.right - 8 + 1e-9, `横がはみ出す ${JSON.stringify(p)}`);
  assert.ok(p.y >= panel.top + 8 - 1e-9 && p.y + Math.min(size.h, p.maxH) <= panel.bottom - 8 + 1e-9, `縦がはみ出す ${JSON.stringify(p)}`);
};

test('全文の吹き出し：区画の中、行のすぐ下（6px）に。横は行の左にそろえ、区画の右端で止める', () => {
  const a = rect(880, 450);
  const p = gPeekPlace(a, SIZE, VIEW, PANEL);
  assert.equal(p.side, 'below');
  assert.equal(p.y, a.bottom + 6);
  assert.equal(p.x, 880); // 880 + 360 <= 1268 - 8
  assert.ok(p.x >= PANEL.left, 'グラフの上（区画の左）に出さない');
  inside(p, SIZE, PANEL);
  const right = gPeekPlace(rect(1100, 450, 150), SIZE, VIEW, PANEL);
  assert.equal(right.x, PANEL.right - 8 - SIZE.w);
});

test('全文の吹き出し：下に入らなければ行の上', () => {
  const a = rect(880, 700); // 722 + 6 + 180 > 780
  const p = gPeekPlace(a, SIZE, VIEW, PANEL);
  assert.equal(p.side, 'above');
  assert.equal(p.y, a.top - 6 - SIZE.h);
  inside(p, SIZE, PANEL);
});

test('全文の吹き出し：上にも下にも入らなければ、広いほうに寄せて区画の中に収める', () => {
  const panel = { left: 300, top: 0, right: 700, bottom: 300 };
  const tall = { w: 360, h: 260 };
  const lower = gPeekPlace(rect(310, 200, 170), tall, VIEW, panel);
  assert.equal(lower.side, 'above');
  inside(lower, tall, panel);
  const upper = gPeekPlace(rect(310, 20, 170), tall, VIEW, panel);
  assert.equal(upper.side, 'below');
  inside(upper, tall, panel);
});

test('全文の吹き出し：区画が細ければ幅を区画に合わせ（w）、高さの上限（maxH）も区画から', () => {
  const panel = { left: 600, top: 100, right: 880, bottom: 500 };
  const p = gPeekPlace(rect(620, 200, 150), SIZE, VIEW, panel);
  assert.equal(p.w, 880 - 600 - 16);
  assert.equal(p.maxH, 500 - 100 - 16);
  assert.equal(p.x, 608);
  // 区画が無い（null：欄を閉じている）ときは画面の中
  const q = gPeekPlace(rect(600, 300, 150), SIZE, VIEW, null);
  assert.equal(q.side, 'below');
  assert.equal(q.w, SIZE.w);
});

test('全文の吹き出し：いろいろな行・大きさで、いつも区画の中（グラフの上に出ない）', () => {
  for (const panel of [PANEL, { left: 400, top: 60, right: 760, bottom: 700 }]) {
    for (let top = panel.top; top < panel.bottom - 22; top += 37) {
      for (const size of [SIZE, { w: 300, h: 420 }, { w: 500, h: 90 }]) {
        const p = gPeekPlace(rect(panel.left + 12, top, 160), size, VIEW, panel);
        inside(p, size, panel);
      }
    }
  }
});

// ---- 線の両端を光らせる（gPairEdge） ----
test('線の印：その2つを結ぶ線だけ（向きは問わない）', () => {
  // eslint-disable-next-line no-new-func
  const { gPairEdge } = new Function(`${PURE}; return { gPairEdge };`)();
  assert.equal(gPairEdge(['a', 'b'], { a: 'a', b: 'b' }), true);
  assert.equal(gPairEdge(['a', 'b'], { a: 'b', b: 'a' }), true);
  assert.equal(gPairEdge(['a', 'b'], { a: 'a', b: 'c' }), false);
  assert.equal(gPairEdge(null, { a: 'a', b: 'b' }), false);
});

test('線の印：重ねている間と、止めている間は光らせる・止めをやめたら描き直す', () => {
  assert.match(SRC, /go: '相手のメモへ', pair: \[rec\.id, otherId\] \}\);/);
  assert.match(SRC, /graph\.hoverPair = pair;\s*drawGraph\(\);/);
  assert.match(SRC, /const pair = graph\.hoverPair \|\| pinnedPair \|\| null;/);
  assert.match(slice('  function hideGraphPeek() {', '  // マウスを行に重ねた'), /if \(hadPair\) drawGraph\(\);/);
  assert.match(CSS, /\.g-node\.is-pair polygon/);
  assert.match(CSS, /\.g-edge\.is-pair \.g-line/);
});

// ---- 中身 ----

const NOW = Date.parse('2026-10-13T09:00:00+09:00');
const deps = {
  tags: (rec) => (Array.isArray(rec.tags) ? rec.tags : []),
  tagLabel: (n) => `#${n}`,
  likeLabels: ['いいねなし', 'いいね', 'いいね×2', 'いいね×3'],
  relative: (iso) => formatRelative(iso, NOW),
  full: formatFull,
};
const head = { dir: '→', kind: '根拠：前提', color: '#00ba7c' };

test('全文の吹き出しの中身：本文は切らずに全部（一覧の線の印の 14 文字・概観の 40 文字で切らない）。末尾の空白だけ除く', () => {
  const long = `最初の行がとても長くて、一覧の線の印では十四文字までで切れてしまう\n${'あ'.repeat(300)}\n\n次の段落\n\n`;
  const m = gPeekModel({ text: long, comments: [] }, head, 'ノート直下（2, 0）', deps);
  assert.equal(m.text, long.replace(/\s+$/, ''));
  assert.ok([...m.text].length > 300);
  assert.ok(m.text.includes('\n\n次の段落')); // 改行はそのまま（pre-wrap で出す）
  assert.equal(m.empty, false);
  assert.deepEqual(m.head, head);
  assert.equal(m.where, 'ノート直下（2, 0）');
});

test('全文の吹き出しの中身：本文が空のときは「（本文なし）」', () => {
  for (const text of ['', '  \n ', undefined]) {
    const m = gPeekModel({ text, comments: [] }, head, 'ノート直下（0, 0）', deps);
    assert.equal(m.text, '（本文なし）');
    assert.equal(m.empty, true);
  }
});

test('全文の吹き出しの中身：タグ・更新（相対の言い方と title は日時）・コメントの数・いいねの段階', () => {
  const rec = {
    text: '本文', tags: ['仮説', '健康'], comments: [{}, {}, {}], likedLevel: 2, updatedAt: '2026-10-13T08:30:00+09:00', createdAt: '2026-09-01T00:00:00Z',
  };
  const m = gPeekModel(rec, head, 'x', deps);
  assert.deepEqual(m.tags, [{ name: '仮説', label: '#仮説' }, { name: '健康', label: '#健康' }]);
  assert.deepEqual(m.meta.map((x) => x.kind), ['updated', 'comments', 'like']);
  assert.equal(m.meta[0].text, '更新 30分前');
  assert.equal(m.meta[0].title, formatFull('2026-10-13T08:30:00+09:00'));
  assert.equal(m.meta[1].text, 'コメント 3');
  assert.equal(m.meta[2].text, '♥ いいね×2');
  assert.equal(m.meta[2].level, 2);
});

test('全文の吹き出しの中身：コメント・いいねが無ければ出さない。更新が無ければ作成日時。日時が読めなければ更新の行も出さない', () => {
  const m = gPeekModel({ text: 'a', comments: [], likedLevel: 0, createdAt: '2026-10-10T00:00:00+09:00' }, head, 'x', deps);
  assert.deepEqual(m.meta.map((x) => x.kind), ['updated']);
  assert.equal(m.meta[0].text, '更新 3日前');
  assert.deepEqual(m.tags, []);
  const none = gPeekModel({ text: 'a', updatedAt: 'いつか' }, head, 'x', deps);
  assert.deepEqual(none.meta, []); // comments が無い（undefined）メモでも落ちない
});

// ---- 時間の動き（出すまで 300ms・外れて 120ms・出ている間はすぐ切り替え）：本物の関数を、時計を進めて動かす ----

function loadTimers() {
  const code = slice('  function hideGraphPeek() {', "  graphPanelBody.addEventListener('pointerover', (e) => {\n    if (e.pointerType !== 'mouse')");
  const gPeek = { anchor: null, pinned: false, pending: null, showTimer: 0, hideTimer: 0, size: { w: 360, h: 200 } };
  const box = { open: false, shown: [], contains: () => false, replaceChildren() {}, hidePopover() { box.open = false; } };
  const mkAnchor = (name) => ({ name, isConnected: true, removeAttribute() {}, focus() {} });
  const log = [];
  const showGraphPeek = (a, { pinned = false } = {}) => {
    clearTimeout(gPeek.showTimer);
    clearTimeout(gPeek.hideTimer);
    gPeek.showTimer = gPeek.hideTimer = 0;
    gPeek.pending = null;
    gPeek.anchor = a;
    gPeek.pinned = pinned;
    box.open = true;
    log.push(`show:${a.name}${pinned ? ':pinned' : ''}`);
  };
  // eslint-disable-next-line no-new-func
  const fns = new Function('gPeek', 'graphPeekBox', 'gPeekOpen', 'showGraphPeek', 'document', 'G_PEEK_DELAY', 'G_PEEK_HIDE',
    `${code}; return { hideGraphPeek, scheduleGraphPeek, leaveGraphPeek };`)(gPeek, box, () => box.open, showGraphPeek, { activeElement: null }, 300, 120);
  return { gPeek, box, mkAnchor, showGraphPeek, log, ...fns };
}

test('全文の吹き出しの時間：重ねて 300ms で出る。その前に外れたら出さない', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const x = loadTimers();
  const a = x.mkAnchor('A');
  x.scheduleGraphPeek(a);
  t.mock.timers.tick(299);
  assert.equal(x.box.open, false);
  t.mock.timers.tick(1);
  assert.equal(x.box.open, true);
  assert.equal(x.gPeek.anchor, a);
  // 出さずに外れる
  x.hideGraphPeek();
  const b = x.mkAnchor('B');
  x.scheduleGraphPeek(b);
  t.mock.timers.tick(200);
  x.leaveGraphPeek();
  t.mock.timers.tick(1000);
  assert.equal(x.box.open, false);
  assert.deepEqual(x.log, ['show:A']);
});

test('全文の吹き出しの時間：同じ行の中を動いても待ち直さない・出ている間はほかの行へすぐ切り替わる', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const x = loadTimers();
  const a = x.mkAnchor('A');
  const b = x.mkAnchor('B');
  x.scheduleGraphPeek(a);
  t.mock.timers.tick(200);
  x.scheduleGraphPeek(a); // 行の中の別の部分（pointerover がまた来る）
  t.mock.timers.tick(100);
  assert.equal(x.box.open, true, '最初の重ねから 300ms で出る');
  x.scheduleGraphPeek(b);
  assert.equal(x.gPeek.anchor, b, '待たずに切り替わる');
  assert.deepEqual(x.log, ['show:A', 'show:B']);
});

test('全文の吹き出しの時間：外れて 120ms で消える。すき間を渡って 120ms 以内に次の行へ来れば消えない', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const x = loadTimers();
  const a = x.mkAnchor('A');
  const b = x.mkAnchor('B');
  x.scheduleGraphPeek(a);
  t.mock.timers.tick(300);
  assert.equal(x.box.open, true);
  x.leaveGraphPeek();
  t.mock.timers.tick(119);
  assert.equal(x.box.open, true);
  x.scheduleGraphPeek(b); // すき間のあと隣の行へ
  t.mock.timers.tick(500);
  assert.equal(x.box.open, true);
  assert.equal(x.gPeek.anchor, b);
  x.leaveGraphPeek();
  t.mock.timers.tick(120);
  assert.equal(x.box.open, false);
  assert.equal(x.gPeek.anchor, null);
});

test('全文の吹き出しの時間：止めている間は、重ねても外れても何も変わらない。hide で止めも解ける', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const x = loadTimers();
  const a = x.mkAnchor('A');
  const b = x.mkAnchor('B');
  x.showGraphPeek(a, { pinned: true });
  x.scheduleGraphPeek(b);
  t.mock.timers.tick(1000);
  x.leaveGraphPeek();
  t.mock.timers.tick(1000);
  assert.equal(x.box.open, true);
  assert.equal(x.gPeek.anchor, a);
  assert.equal(x.gPeek.pinned, true);
  x.hideGraphPeek();
  assert.equal(x.box.open, false);
  assert.equal(x.gPeek.pinned, false);
  assert.equal(x.gPeek.anchor, null);
  x.hideGraphPeek(); // 何も出ていないときに呼んでも落ちない
});

// ---- 画面の部品・ほかの処理との行き違い（ソースの確認） ----

test('全文の吹き出し：一覧の線の印・概観の行に目印を付け、ブラウザの title（吹き出しに重なる）は空に。場所の全文は title に', () => {
  const item = slice('  function buildGraphListItem(', '  const graphPanelBody = $');
  assert.match(item, /markGraphPeek\(b, \{ rec: other\.rec, node: other,/); // 相手のメモを出す
  assert.doesNotMatch(item, /クリックで相手のメモへ`/); // これまでの種類だけの title は付けない
  assert.match(item, /where\.title = where\.textContent/);
  const overview = slice('  function renderGraphPanel() {', '  // ---- 一覧（右の区画）');
  assert.match(overview, /markGraphPeek\(b, \{ rec: n\.rec, node: n,/); // 概観の行は、その行のメモ
  const mark = slice('  function markGraphPeek(', '  const gPeekOpen');
  assert.match(mark, /dataset\.gPeek = '1'/);
  assert.match(mark, /setAttribute\('title', ''\)/); // 空の title は、後ろの li の title も出さない
});

test('全文の吹き出し：一覧・概観の描き直し・タブの切り替え・区画の開け閉めで閉じる', () => {
  assert.match(slice('  function renderGraphPanel() {', '    syncGraphChrome();'), /hideGraphPeek\(\)/);
  assert.match(slice('  function renderGraphList() {', '    const body = $'), /hideGraphPeek\(\)/);
  assert.match(slice('  function setTab(tab) {', '    queueMicrotask'), /hideGraphPeek\(\)/);
  assert.match(slice("  $('gPanelToggle').addEventListener('click'", '    syncGraphChrome();'), /hideGraphPeek\(\)/);
});

test('全文の吹き出し：マウスだけ（タッチは長押し）・Esc は window の capture でグラフの Esc より先に・右クリックは止めて、ブラウザのメニューは出さない', () => {
  const hover = slice("  graphPanelBody.addEventListener('pointerover', (e) => {\n    if (e.pointerType !== 'mouse')", '  // キーボード');
  assert.match(hover, /e\.pointerType !== 'mouse'/);
  assert.match(hover, /pointerleave/);
  const esc = slice("  window.addEventListener('keydown', (e) => {\n    if (e.key !== 'Escape'", "  window.addEventListener('blur', hideGraphPeek)");
  assert.match(esc, /e\.stopPropagation\(\)/);
  assert.match(esc, /\}, true\);\s*$/); // capture
  assert.match(esc, /!gPeek\.anchor/); // 出ていないときは Esc に触らない（グラフの Esc はこれまでどおり）
  // グラフの Esc は document の（capture ではない）keydown：window の capture の後で動く
  // （固定の F キーと同じリスナーで、Esc はその後ろで見る）
  assert.match(SRC, /document\.addEventListener\('keydown', \(e\) => \{\n {4}if \(activeTab !== 'graph' \|\| anyDialogOpen\(\)\) return;[\s\S]{0,800}?\n {4}if \(e\.key !== 'Escape'\) return;/);
  const ctx = slice("  graphPanelBody.addEventListener('contextmenu', (e) => {", '  // 一覧のスクロール');
  assert.match(ctx, /e\.preventDefault\(\)/);
  assert.match(ctx, /pinned: true/);
  assert.match(SRC, /const G_PEEK_DELAY = 300;/);
  assert.match(SRC, /const G_PEEK_HIDE = 120;/);
});

test('全文の吹き出し：止めたカードの「相手のメモへ」も、グラフの固定を通る（固定中は動かさずに光らせるだけ）', () => {
  const go = SRC.slice(SRC.indexOf("const go = e.target.closest('[data-peek-go]');"));
  assert.match(go.slice(0, 600), /gSelect\(rec\);[^\n]*\n\s*if \(graphLocked\(\)\) gPing\(rec\);[^\n]*\n\s*else gCenterOn\(rec\);/);
});

test('全文の吹き出し：#graphPeek は index.html にも buildIndex()（ブラウザ版）にも1つだけ。popover="manual"・class "menu" なし・デスクトップ専用でない・style 属性なし', () => {
  for (const html of [HTML, buildIndex()]) {
    assert.equal((html.match(/id="graphPeek"/g) || []).length, 1);
    const tag = /<[^>]*\bid="graphPeek"[^>]*>/.exec(html)[0];
    assert.match(tag, /popover="manual"/); // ほかのメニューを閉じない
    assert.doesNotMatch(tag, /class="[^"]*\bmenu\b/); // 出ている間に、全体・グラフの Esc の判定（.menu:popover-open）に当たらない
    assert.doesNotMatch(tag, /data-desktop-only/);
    assert.doesNotMatch(tag, /\sstyle=/); // CSP（style-src 'self'）
  }
});

test('全文の吹き出し：styles.css は、出ていないときは隠れ（display は :popover-open のときだけ）、重ねただけでは操作を遮らず、止めると操作できる', () => {
  const rule = (sel) => {
    const m = new RegExp(`(?:^|\\n)${sel.replace(/[.[\]:()]/g, '\\$&')} \\{([^}]*)\\}`).exec(CSS);
    assert.ok(m, sel);
    return m[1];
  };
  assert.doesNotMatch(rule('.g-peek'), /\bdisplay\s*:/); // 常に見えてしまうのを防ぐ（popover の既定の display:none を上書きしない）
  assert.match(rule('.g-peek'), /pointer-events:\s*none/);
  assert.match(rule('.g-peek'), /position:\s*fixed/);
  assert.match(rule('.g-peek:popover-open'), /display:\s*flex/);
  assert.match(rule('.g-peek.is-pinned'), /pointer-events:\s*auto/);
  assert.match(rule('.g-peek.is-pinned .g-peek-body'), /overflow-y:\s*auto/);
  assert.match(rule('.g-peek.is-pinned .g-peek-body'), /user-select:\s*text/);
  assert.match(CSS, /\.g-peek\.is-clipped \.g-peek-more \{ display: block; \}/);
  // 動きを減らす設定では現れ方の動きも無し
  assert.match(CSS, /prefers-reduced-motion: reduce\) \{[^]*\.g-peek:popover-open \{ animation: none; \}/);
  // 印刷・書き出しには出ない（[popover] を隠す既存の規則）
  assert.match(CSS, /body\.is-printing \[popover\][^{]*\{ display: none !important; \}/);
});

// ---- 右クリックのメニュー：見出しに本文ぜんぶ（gMenuFullText・openGraphNodeMenu） ----
// （package.json のテストの並びを変えずに、ほかの PR とぶつからないよう、ここに置く）
const menuFnSrc = (name) => {
  const start = SRC.indexOf(`  function ${name}(`);
  const end = SRC.indexOf('\n  }\n', start);
  assert.ok(start > 0 && end > start, `${name} が見つからない`);
  return SRC.slice(start, end);
};

// el・hasText だけ差し替えて、本物の gMenuFullText を動かす
// eslint-disable-next-line no-new-func
const gMenuFullText = new Function('el', 'hasText', `${menuFnSrc('gMenuFullText')}\n  }; return gMenuFullText;`)(
  (tag, cls, text) => ({ tag, className: cls, textContent: text }),
  (rec) => !!rec.text.trim(),
);

test('本文ぜんぶを、一覧の全文と同じクラスで出す（切らない）', () => {
  const long = `1行目\n${'あ'.repeat(2000)}\n最後の行`;
  const box = gMenuFullText({ text: long });
  assert.equal(box.textContent, long);
  assert.match(box.className, /\bg-item-text\b/);
  assert.match(box.className, /\bis-open\b/);
  assert.match(box.className, /\bg-menu-full\b/);
  assert.equal(box.tabIndex, -1);
  const empty = gMenuFullText({ text: '  ' });
  assert.equal(empty.textContent, '（本文なし）');
  assert.match(empty.className, /\bis-empty\b/);
});

test('メニューは書き出し（24 字）をやめ、本文ぜんぶを見出しに。ほかは今まで通り', () => {
  const open = menuFnSrc('openGraphNodeMenu');
  assert.doesNotMatch(open, /recordLabel\(n\.rec, n\.key, 24\)/);
  assert.match(open, /\$\('graphNodeHead'\)\.replaceChildren\(document\.createTextNode\(where\), gMenuFullText\(n\.rec\)\);/);
  assert.match(open, /\$\('gNewText'\)\.focus\(/);
});

test('CSS：長い本文は 320px ほどでスクロール', () => {
  assert.match(CSS, /\.graph-node-menu \.g-menu-full \{[^}]*max-height: min\(40vh, 320px\);[^}]*overflow-y: auto;/);
});
