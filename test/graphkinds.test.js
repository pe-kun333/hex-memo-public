'use strict';

// グラフ上段の「線の種類」のボタン（renderer.js の graphKindChips）。
// 画面のスクリプトの中にあるので、印のコメントの間をそのまま取り出して動かす（merge.test.js と同じやり方）
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { buildIndex } = require('../scripts/build-web.js');

const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'renderer.js'), 'utf8');

function loadChips() {
  const start = SRC.indexOf('  // ---- 線の種類のボタン（たたむ・0 本をまとめる） ----');
  const end = SRC.indexOf('  // ---- 線の種類のボタン ここまで ----');
  assert.ok(start > 0 && end > start, '線の種類のボタンの部分が見つからない');
  // eslint-disable-next-line no-new-func
  return new Function(`${SRC.slice(start, end)}; return graphKindChips;`)();
}

const graphKindChips = loadChips();

// 登録した種類 13 個のうち、線があるのは続き（next）と原因（cause）だけ
const REGISTERED = [
  ['related', '関連'], ['support', '根拠'], ['against', '反論'], ['next', '続き'], ['cause', '原因'],
  ['k6', '種類6'], ['k7', '種類7'], ['k8', '種類8'], ['k9', '種類9'], ['k10', '種類10'], ['k11', '種類11'], ['k12', '種類12'], ['k13', '種類13'],
].map(([id, name], i) => ({ id, name, color: `#00${(10 + i).toString(16)}0ff`, directed: false }));
const link = (kind) => ({ a: 'a', b: 'b', ...(kind ? { kind } : {}) });
const rep = (n, kind) => Array.from({ length: n }, () => link(kind));
const ids = (plan) => plan.chips.map((c) => c.id);

test('線の種類のボタン：線が 0 本で表示中の種類は1つにまとめ、線のある種類はいつも出す', () => {
  const links = [...rep(7, 'next'), ...rep(1, 'cause')];
  const plan = graphKindChips(REGISTERED, links, null, false);
  assert.deepEqual(ids(plan), ['next', 'cause']);
  assert.equal(plan.folded, 11);
  assert.equal(plan.foldable, 11);
  assert.deepEqual(plan.chips.map((c) => c.n), [7, 1]);
  assert.equal(plan.total, 13);
  assert.equal(plan.hidden, 0);
  assert.ok(plan.chips.every((c) => c.on));
});

test('線の種類のボタン：0 本でも隠している種類はまとめない（絞り込みの状態をごまかさない）', () => {
  const links = [...rep(7, 'next'), ...rep(1, 'cause')];
  const shown = new Set(REGISTERED.map((k) => k.id));
  shown.delete('k9');
  const plan = graphKindChips(REGISTERED, links, shown, false);
  assert.deepEqual(ids(plan), ['next', 'cause', 'k9']);
  const k9 = plan.chips.find((c) => c.id === 'k9');
  assert.equal(k9.on, false);
  assert.equal(k9.n, 0);
  assert.equal(plan.folded, 10); // 11 から1つ減る
  assert.equal(plan.hidden, 1);
  assert.deepEqual(plan.hiddenNames, ['種類9']);
});

test('線の種類のボタン：0 本の種類も並べる（showEmpty）と、すべての種類がもとの順で並ぶ', () => {
  const links = [...rep(7, 'next'), ...rep(1, 'cause')];
  const plan = graphKindChips(REGISTERED, links, null, true);
  assert.deepEqual(ids(plan), REGISTERED.map((k) => k.id));
  assert.equal(plan.folded, 0);
  assert.equal(plan.foldable, 11); // 「0 本の種類をまとめる」のチップを出すための数
  // 色と名前は登録のまま
  assert.equal(plan.chips[3].name, '続き');
  assert.equal(plan.chips[3].color, REGISTERED[3].color);
});

test('線の種類のボタン：登録に無い種類の ID もチップになり、数の合計が線の本数と合う', () => {
  const links = [link('next'), link('next'), link('detail'), link('')];
  const plan = graphKindChips(REGISTERED, links, null, false);
  assert.deepEqual(ids(plan), ['next', 'detail', '']);
  const detail = plan.chips.find((c) => c.id === 'detail');
  assert.equal(detail.name, '（detail）'); // kindName と同じ書き方
  assert.equal(detail.color, null);
  assert.equal(plan.chips.find((c) => c.id === '').name, '指定なし');
  assert.equal(plan.chips.reduce((s, c) => s + c.n, 0), links.length);
  // 切り替えの母集合に入る：ほかの種類を切り替えても（detail）の線が消えない
  assert.ok(plan.allIds.includes('detail'));
  assert.ok(plan.allIds.includes(''));
  assert.equal(new Set(plan.allIds).size, plan.allIds.length);
  assert.equal(plan.folded, 12); // 登録の 13 のうち線があるのは next だけ
});

test('線の種類のボタン：登録に無い種類は、線に出てきた順で、指定なしの前に並ぶ。指定なしは線がある時だけ', () => {
  const plan = graphKindChips(REGISTERED, [link(''), link('question'), link('detail'), link('question')], null, false);
  assert.deepEqual(ids(plan), ['question', 'detail', '']);
  assert.deepEqual(plan.chips.map((c) => c.n), [2, 1, 1]);
  const none = graphKindChips(REGISTERED, [link('next')], null, false);
  assert.ok(!ids(none).includes(''));
  assert.ok(none.allIds.includes('')); // 母集合には、今までどおりいつも入れる
});

test('線の種類のボタン：hidden は隠している種類の数（graph.kinds が null ならすべて表示で 0）', () => {
  const links = [...rep(3, 'next'), ...rep(2, 'support'), link('detail')];
  assert.equal(graphKindChips(REGISTERED, links, null, false).hidden, 0);
  const all = new Set(graphKindChips(REGISTERED, links, null, false).allIds);
  assert.equal(graphKindChips(REGISTERED, links, all, false).hidden, 0);
  all.delete('next');
  all.delete('detail');
  const plan = graphKindChips(REGISTERED, links, all, false);
  assert.equal(plan.hidden, 2);
  assert.deepEqual(plan.hiddenNames, ['続き', '（detail）']);
  assert.deepEqual(plan.chips.filter((c) => !c.on).map((c) => c.id), ['next', 'detail']);
});

test('線の種類のボタン：まとめるものが無ければ foldable は 0（「＋0 本の種類」のチップを出さない）', () => {
  // すべての種類に線がある
  const every = REGISTERED.slice(0, 2);
  const links = [link('related'), link('support')];
  const plan = graphKindChips(every, links, null, false);
  assert.equal(plan.foldable, 0);
  assert.equal(plan.folded, 0);
  // 0 本の種類がすべて隠してある：まとめられるものは無い
  const shown = new Set(['next']);
  const hiddenAll = graphKindChips(REGISTERED, rep(2, 'next'), shown, false);
  assert.equal(hiddenAll.foldable, 0);
  assert.equal(hiddenAll.chips.length, 13); // 隠している 12 個は並べたまま
});

test('線の種類のボタン：数は渡した線（ノート全体）で数え、graph.kinds の絞り込みでは変わらない', () => {
  const links = [...rep(4, 'next'), ...rep(2, 'cause')];
  const plan = graphKindChips(REGISTERED, links, new Set(['cause']), false);
  assert.equal(plan.chips.find((c) => c.id === 'next').n, 4); // 隠していても本数は同じ
  assert.equal(plan.chips.find((c) => c.id === 'next').on, false);
  // 隠した 0 本の種類を表示に戻すと、まとめる側へ移る（並べるのをやめる）
  const back = graphKindChips(REGISTERED, links, new Set(['cause', 'next', 'k6']), false);
  assert.ok(!ids(back).includes('k6'));
});

test('線の種類のボタン：登録した種類が空でも落ちない（見出しは「0」）', () => {
  const plan = graphKindChips([], [], null, false);
  assert.equal(plan.total, 0);
  assert.deepEqual(plan.chips, []);
  assert.deepEqual(plan.allIds, ['']);
});

test('線の種類のボタン：ブラウザ版・iPad でも出る（index.html と buildIndex() の両方に入れ物があり、たたみ方を覚える）', () => {
  for (const html of [fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8'), buildIndex()]) {
    assert.ok(html.includes('id="graphKinds"') && html.includes('aria-label="表示する種類"'));
  }
  assert.ok(SRC.includes("'hexMemo.graphKindsClosed'") && SRC.includes("'hexMemo.graphKindsShowEmpty'"));
  assert.ok(SRC.includes('dataset.kindsToggle') && SRC.includes("'aria-expanded'"));
  // 見出し・まとめるチップは .kind-btn の切り替えより先に見る（.kind-more も .kind-btn の形なので）
  const click = SRC.slice(SRC.indexOf("$('graphKinds').addEventListener('click'"));
  assert.ok(click.indexOf('[data-kinds-toggle]') < click.indexOf(".kind-btn[data-kind]"));
  assert.ok(click.indexOf('[data-kinds-empty]') < click.indexOf(".kind-btn[data-kind]"));
  // Space は全体のキー処理でハニカムのパン用に止められるので、種類のボタンの上では通す（キーボードでも押せる）
  assert.ok(/spaceOnKinds = [^;]*closest\('#graphKinds'\)/.test(SRC) && /&& !spaceOnKinds\)/.test(SRC));
  // 指で押しやすい高さ（タッチの画面）
  const css = fs.readFileSync(path.join(ROOT, 'styles.css'), 'utf8');
  assert.match(css, /@media \(pointer: coarse\)\s*\{[^}]*\.kinds-head[^}]*height: 30px/);
});

test('線の種類のボタン：たたむ・開くでグラフが飛ばない（gFit を見送る仕組みが ResizeObserver にある）', () => {
  const ro = SRC.slice(SRC.indexOf('new ResizeObserver(() => {\n    if (activeTab !== \'graph\' || gDrag || gPan) return;'));
  assert.ok(ro.length > 0 && ro.slice(0, 700).includes('gHold'), 'ResizeObserver が gHold を見ていない');
  // たたむ・開く・まとめるは、gKeepView を通して描き直す
  assert.ok(/kindsClosed = !kindsClosed;[\s\S]{0,160}gKeepView\(renderGraphKinds\)/.test(SRC));
  assert.ok(/kindsShowEmpty = !kindsShowEmpty;[\s\S]{0,160}gKeepView\(renderGraphKinds\)/.test(SRC));
});
