'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const S = require('../settings.js');

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hex-memo-settings-'));

test('設定：無ければ既定（関連線の種類は5つ・クイック入力は Ctrl+Alt+Q・原点の近く）', () => {
  const s = S.normalizeSettings(null);
  assert.deepEqual(s.tags, []);
  assert.deepEqual(s.linkKinds.map((k) => k.id), ['related', 'support', 'against', 'next', 'cause']);
  assert.deepEqual(s.quickInput, { shortcut: 'CommandOrControl+Alt+Q', place: 'origin', global: true, toggle: true, hideShortcut: '' });
});

test('タグの登録：名前の # と空白を除き、重複を外し、色は順に割り当てる。よく使う順は回数→最近→登録順', () => {
  const s = S.normalizeSettings({ tags: [{ name: '#仕事', icon: '💼', uses: 3 }, '買い物', { name: '仕事' }, { name: '本', uses: 3, lastUsedAt: '2026-01-02T00:00:00Z' }, { name: '映画', color: '#112233' }] });
  assert.deepEqual(s.tags.map((t) => t.name), ['仕事', '買い物', '本', '映画']);
  assert.equal(s.tags[0].icon, '💼');
  assert.equal(s.tags[0].color, S.TAG_PALETTE[0]);
  assert.equal(s.tags[3].color, '#112233');
  assert.deepEqual(S.topTags(s, 2).map((t) => t.name), ['本', '仕事']);
  assert.deepEqual(S.registerTags(s, ['#新しい', '仕事', '']), ['新しい']);
  assert.equal(s.tags.length, 5);
});

test('関連線の種類：ID・名前・色。読めるものが無ければ既定に戻す', () => {
  const s = S.normalizeSettings({ linkKinds: [{ id: 'cause', name: ' 原因 ', color: '#ff0000' }, { id: 'Bad id', name: 'x' }, { id: 'cause', name: '重複' }] });
  assert.deepEqual(s.linkKinds, [{ id: 'cause', name: '原因', color: '#ff0000', directed: true }]);
  assert.equal(S.normalizeSettings({ linkKinds: [] }).linkKinds.length, 5);
});

test('クイック入力のキー：修飾キー＋キー1つの形だけ。読めなければ既定', () => {
  for (const ok of ['CommandOrControl+Alt+Q', 'Ctrl+Shift+Space', 'Alt+1', 'F9', 'Control+Alt+Z', 'CmdOrCtrl+Shift+;']) assert.equal(S.isAccelerator(ok), true, ok);
  for (const bad of ['Q', '', 'Ctrl+', 'Ctrl++', 'Ctrl+Ctrl+A', 'Foo+A', 'Ctrl+Unknown', 42]) assert.equal(S.isAccelerator(bad), false, String(bad));
  assert.equal(S.normalizeSettings({ quickInput: { shortcut: 'Q', place: 'nowhere', global: false } }).quickInput.shortcut, 'CommandOrControl+Alt+Q');
  assert.deepEqual(S.normalizeSettings({ quickInput: { shortcut: 'Ctrl+Alt+Z', place: 'ask', global: false } }).quickInput, { shortcut: 'Ctrl+Alt+Z', place: 'ask', global: false, toggle: true, hideShortcut: '' });
});

test('SettingsStore：読み込み・部分的な更新・保存（壊れたファイルは既定で開く）', () => {
  const dir = tmpDir();
  const store = new S.SettingsStore(dir);
  assert.equal(store.get().tags.length, 0);
  store.update({ tags: [{ name: 'a' }], quickInput: { place: 'latest' } });
  const again = new S.SettingsStore(dir).get();
  assert.deepEqual(again.tags.map((t) => t.name), ['a']);
  assert.equal(again.quickInput.place, 'latest');
  assert.equal(again.quickInput.shortcut, 'CommandOrControl+Alt+Q'); // 触っていない項目はそのまま
  fs.writeFileSync(path.join(dir, S.SETTINGS_FILE), '{ broken');
  assert.equal(new S.SettingsStore(dir).get().linkKinds.length, 5);
});

test('関連線の種類の向き・期限の通知・足あと：既定と読み込み', () => {
  const s = S.normalizeSettings(null);
  assert.deepEqual(s.linkKinds.map((k) => [k.id, k.directed]), [['related', false], ['support', true], ['against', true], ['next', true], ['cause', true]]);
  assert.deepEqual(s.notify, { enabled: true, time: '09:00' });
  assert.deepEqual(s.footprints, { show: false, record: true });
  // 以前の形式（directed 無し）の種類は、既定の向きになる。知らない種類は向きなし
  const old = S.normalizeSettings({ linkKinds: [{ id: 'support', name: '根拠', color: '#00ba7c' }, { id: 'mine', name: '自作', color: '#123456' }, { id: 'related', name: '関連', color: '#a78bfa', directed: true }] });
  assert.deepEqual(old.linkKinds.map((k) => k.directed), [true, false, true]);
  const t = S.normalizeSettings({ notify: { enabled: false, time: '25:00' }, footprints: { show: true, record: false } });
  assert.deepEqual(t.notify, { enabled: false, time: '09:00' });
  assert.deepEqual(t.footprints, { show: true, record: false });
  assert.equal(S.normalizeSettings({ quickInput: { place: 'shelf' } }).quickInput.place, 'shelf');
});

test('定型：基準からの相対座標に直し、番号で持つ関連線・領域はマスに合わせる。右クリックに出す6つはピン留め→回数', () => {
  const s = S.normalizeSettings({ templates: [
    { id: 't0123abcd', name: ' 会議 ', cells: [{ dq: 2, dr: 1, text: '議題', tags: ['#会議', '会議'], comments: [{ text: '確認' }, { text: '返信', parent: 0 }, { text: '', parent: 9 }], due: 3, progress: 2 }, { dq: 3, dr: 1, text: '決定' }, { dq: 3, dr: 1, text: '重複' }, { dq: 'x' }],
      links: [{ a: 0, b: 1, kind: 'next', label: ' つぎ ' }, { a: 1, b: 0 }, { a: 0, b: 3 }, { a: 2, b: 2 }], regions: [{ name: '島', cells: [0, 1, 7], color: '#112233' }, { name: '', cells: [0] }], uses: 2 },
    { name: 'ピン', cells: [{ dq: 0, dr: 0, text: '' }], pinned: true },
    { name: '多い', cells: [{ dq: 0, dr: 0 }], uses: 9 },
    { name: 'マス無し', cells: [] },
    'bad',
  ] });
  assert.equal(s.templates.length, 3);
  const t = s.templates[0];
  assert.equal(t.id, 't0123abcd');
  assert.equal(t.name, '会議');
  assert.deepEqual(t.cells.map((c) => [c.dq, c.dr]), [[0, 0], [1, 0]]);
  assert.deepEqual(t.cells[0].tags, ['会議']);
  assert.deepEqual(t.cells[0].comments, [{ text: '確認' }, { text: '返信', parent: 0 }]);
  assert.equal(t.cells[0].due, 3);
  assert.equal(t.cells[0].progress, 2);
  assert.deepEqual(t.links, [{ a: 0, b: 1, kind: 'next', label: 'つぎ' }]);
  assert.deepEqual(t.regions, [{ name: '島', cells: [0, 1], color: '#112233' }]);
  assert.equal(t.pinned, false);
  assert.ok(/^t[0-9a-f]{8}$/.test(s.templates[1].id));
  assert.deepEqual(S.topTemplates(s).map((x) => x.name), ['ピン', '多い', '会議']);
  // 保存して読み直しても同じ
  const dir = tmpDir();
  const store = new S.SettingsStore(dir);
  store.update({ templates: s.templates });
  assert.deepEqual(new S.SettingsStore(dir).load().templates, s.templates);
});

test('六角形スクショ・トレイ：大きさは 40〜2000 で重複なく小さい順、キーは accelerator の形、既定はトレイに常駐', () => {
  const s = S.normalizeSettings(null);
  assert.deepEqual(s.capture, { shortcut: 'CommandOrControl+Alt+H', sizes: [160, 280, 440], last: 280, comment: true });
  assert.deepEqual(s.tray, { enabled: true });
  const c = S.normalizeSettings({ capture: { shortcut: 'Ctrl+Shift+S', sizes: [500, 10, 500, 9999, 'x', 120.4], last: 1, comment: false }, tray: { enabled: false } });
  assert.deepEqual(c.capture, { shortcut: 'Ctrl+Shift+S', sizes: [40, 120, 500, 2000], last: 40, comment: false });
  assert.equal(c.tray.enabled, false);
  const dir = tmpDir();
  const store = new S.SettingsStore(dir);
  store.update({ capture: { last: 300 } });
  assert.equal(store.get().capture.last, 300);
  assert.equal(store.get().capture.shortcut, 'CommandOrControl+Alt+H');
});

test('タグボタンのセット：枠は9つ（空きは \'\'・同じタグは後の方を空きに）、名前が無ければ「セット n」、ID が重なれば付け直す。今のセットは無い ID なら最初', () => {
  const s = S.normalizeSettings({
    tagSets: [
      { id: 's0123abcd', name: ' 仕事 ', tags: ['#会議', '連絡', '会議', '', null, '資料', 'a', 'b', 'c', 'd（10個目）'] },
      { id: 's0123abcd', tags: 'x' },
      { id: 'bad', name: '読書' },
      3,
    ],
    tagSetActive: 'snotthere',
  });
  assert.equal(s.tagSets.length, 3);
  assert.deepEqual(s.tagSets[0], { id: 's0123abcd', name: '仕事', tags: ['会議', '連絡', '', '', '', '資料', 'a', 'b', 'c'] });
  assert.equal(s.tagSets[1].name, 'セット 2');
  assert.deepEqual(s.tagSets[1].tags, Array(S.TAG_SET_SLOTS).fill(''));
  assert.notEqual(s.tagSets[1].id, 's0123abcd');
  assert.match(s.tagSets[2].id, /^s[0-9a-f]{8}$/);
  assert.equal(s.tagSets[2].name, '読書');
  assert.equal(s.tagSetActive, 's0123abcd');
  assert.equal(S.normalizeSettings({ tagSets: s.tagSets, tagSetActive: s.tagSets[2].id }).tagSetActive, s.tagSets[2].id);
  assert.deepEqual(S.normalizeSettings(null).tagSets, []);
  assert.equal(S.normalizeSettings(null).tagSetActive, '');
  assert.equal(S.normalizeTagSets(Array.from({ length: 30 }, () => ({}))).length, S.MAX_TAG_SETS);
});

test('SettingsStore：タグボタンのセットと今のセットを部分的に更新できる（ほかの設定はそのまま）', () => {
  const dir = tmpDir();
  const store = new S.SettingsStore(dir);
  store.update({ tags: [{ name: '会議' }] });
  const a = store.update({ tagSets: [{ id: 's00000001', name: 'A', tags: ['会議'] }, { id: 's00000002', name: 'B', tags: [] }] });
  assert.equal(a.tagSetActive, 's00000001');
  const b = store.update({ tagSetActive: 's00000002' });
  assert.equal(b.tagSetActive, 's00000002');
  assert.equal(b.tagSets.length, 2);
  assert.deepEqual(b.tags.map((t) => t.name), ['会議']);
  const c = store.update({ tagSets: [{ id: 's00000001', name: 'A', tags: ['会議'] }] }); // 今のセットを消したら最初のセットへ
  assert.equal(c.tagSetActive, 's00000001');
  const again = new S.SettingsStore(dir);
  assert.deepEqual(again.load().tagSets, c.tagSets);
});

test('よく使う検索：検索語・タグ・並べ方・範囲・領域の名前。何も絞らないものは捨て、名前が無ければ検索語から', () => {
  const s = S.normalizeSettings({
    savedSearches: [
      { id: 'q0123abcd', name: ' 仕事の 未完了 ', query: '  会議   メモ ', tags: ['#仕事', '仕事', ''], sort: 'updated', scope: 'all', region: ' 島A ' },
      { query: '散歩' },
      { tags: ['読書'], sort: 'nope', scope: 'x' },
      { name: '空', query: '   ' },
      'bad',
    ],
  });
  assert.equal(s.savedSearches.length, 3);
  assert.deepEqual(s.savedSearches[0], { id: 'q0123abcd', name: '仕事の 未完了', query: '会議 メモ', tags: ['仕事'], sort: 'updated', scope: 'all', region: '島A' });
  assert.equal(s.savedSearches[1].name, '散歩');
  assert.match(s.savedSearches[1].id, /^q[0-9a-f]{8}$/);
  assert.deepEqual([s.savedSearches[2].name, s.savedSearches[2].sort, s.savedSearches[2].scope], ['#読書', 'relevance', 'board']);
  assert.deepEqual(S.normalizeSettings(null).savedSearches, []);
});

test('今日の1枚：枚数は 1〜9、対象は決まったものだけ、起動時は既定で開かない。部分的に更新できる', () => {
  assert.deepEqual(S.normalizeSettings(null).today, { count: 1, source: 'mixed', startup: false, aiCount: 20 });
  assert.deepEqual(S.normalizeToday({ count: 30, source: 'liked', startup: true, aiCount: 2 }), { count: 9, source: 'liked', startup: true, aiCount: 5 });
  assert.deepEqual(S.normalizeToday({ count: 'x', source: 'nope' }), { count: 1, source: 'mixed', startup: false, aiCount: 20 });
  const store = new S.SettingsStore(tmpDir());
  assert.deepEqual(store.update({ today: { count: 3 } }).today, { count: 3, source: 'mixed', startup: false, aiCount: 20 });
  assert.equal(store.update({ today: { startup: true } }).today.count, 3);
});

test('音声で入力：方法・書き込む先は決まったものだけ、言語は ja-JP の形、変換コマンドは1行・600字まで。部分的に更新できる', () => {
  assert.deepEqual(S.normalizeSettings(null).voice, { method: 'browser', lang: 'ja-JP', command: '', auto: true, place: 'new' });
  assert.deepEqual(S.normalizeVoice({ method: 'record', lang: 'en', command: ' whisper "{file}"\n--language ja ', auto: false, place: 'shelf' }),
    { method: 'record', lang: 'en', command: 'whisper "{file}" --language ja', auto: false, place: 'shelf' });
  assert.deepEqual(S.normalizeVoice({ method: 'nope', lang: 'ja JP; rm', command: 5, place: 'x' }), { method: 'browser', lang: 'ja-JP', command: '', auto: true, place: 'new' });
  assert.equal(S.normalizeVoice({ command: 'あ'.repeat(700) }).command.length, 600);
  const store = new S.SettingsStore(tmpDir());
  assert.equal(store.update({ voice: { command: 'whisper "{file}"' } }).voice.method, 'browser');
  const v = store.update({ voice: { method: 'record' } }).voice;
  assert.equal(v.command, 'whisper "{file}"');
  assert.equal(v.method, 'record');
});

test('クイック入力：もう一度押して最小化（既定はする）・最小化する別のキー（呼び出すキーと同じ・使えない形なら無し）', () => {
  assert.deepEqual(S.normalizeQuick({ toggle: false, hideShortcut: 'Ctrl+Alt+W' }), { shortcut: 'CommandOrControl+Alt+Q', place: 'origin', global: true, toggle: false, hideShortcut: 'Ctrl+Alt+W' });
  assert.equal(S.normalizeQuick({ hideShortcut: 'CmdOrCtrl+alt+q' }).hideShortcut, ''); // 書き方が違っても同じキー
  assert.equal(S.normalizeQuick({ shortcut: 'Alt+Shift+M', hideShortcut: 'Shift+Alt+M' }).hideShortcut, '');
  assert.equal(S.normalizeQuick({ hideShortcut: 'W' }).hideShortcut, ''); // 修飾キー無しの文字は登録しない
  assert.equal(S.normalizeQuick({ hideShortcut: 'F9' }).hideShortcut, 'F9');
  assert.equal(S.acceleratorKey('CommandOrControl+Shift+A'), S.acceleratorKey('shift+cmdorctrl+a'));
  const store = new S.SettingsStore(tmpDir());
  store.update({ quickInput: { hideShortcut: 'Ctrl+Alt+H' } });
  const q = store.update({ quickInput: { toggle: false } }).quickInput;
  assert.equal(q.hideShortcut, 'Ctrl+Alt+H');
  assert.equal(q.toggle, false);
});

test('全体表示は見るだけ：既定は切。ほかの設定を保存しても残り、古い設定ファイルにも足さないまま読める', () => {
  assert.equal(S.normalizeSettings(null).overviewViewOnly, false);
  assert.equal(S.normalizeSettings({ overviewViewOnly: true }).overviewViewOnly, true);
  assert.equal(S.normalizeSettings({ overviewViewOnly: 'yes' }).overviewViewOnly, false);
  const dir = tmpDir();
  const store = new S.SettingsStore(dir);
  assert.equal(store.update({ overviewViewOnly: true }).overviewViewOnly, true);
  assert.equal(store.update({ zoom: { lock: { grid: 33 } } }).overviewViewOnly, true);
  assert.equal(store.update({ tags: ['仕事'] }).overviewViewOnly, true);
  const fresh = new S.SettingsStore(dir);
  assert.equal(fresh.load().overviewViewOnly, true);
  assert.equal(fresh.get().zoom.lock.grid, 33);
  store.update({ overviewViewOnly: false });
  assert.equal(new S.SettingsStore(dir).load().overviewViewOnly, false);
  const oldDir = tmpDir();
  fs.writeFileSync(path.join(oldDir, S.SETTINGS_FILE), `${JSON.stringify({ version: 1, tags: [] })}\n`);
  const old = new S.SettingsStore(oldDir).load();
  assert.equal(old.overviewViewOnly, false);
  assert.deepEqual(old.zoom.presets, [25, 50, 75, 100, 125, 150]);
});

test('表示倍率：既定は 25/50/75/100/125/150% の6つ・固定なし', () => {
  assert.deepEqual(S.normalizeSettings(null).zoom, { presets: [25, 50, 75, 100, 125, 150], lock: { grid: null, graph: null }, overviewClick: 'zoom' });
  assert.deepEqual(S.normalizeZoom('x'), S.DEFAULT_ZOOM);
  assert.deepEqual(S.normalizeZoom({ presets: 'no', lock: 3 }), { presets: [25, 50, 75, 100, 125, 150], lock: { grid: null, graph: null }, overviewClick: 'zoom' });
});

test('表示倍率：縮小中のメモのクリックは「拡大」（既定）か「編集」。おかしな値は既定に戻し、ほかの変更でも消えない', () => {
  assert.equal(S.normalizeZoom({ overviewClick: 'edit' }).overviewClick, 'edit');
  assert.equal(S.normalizeZoom({ overviewClick: 'zoom' }).overviewClick, 'zoom');
  assert.equal(S.normalizeZoom({ overviewClick: 'x' }).overviewClick, 'zoom');
  assert.equal(S.normalizeZoom({ overviewClick: true }).overviewClick, 'zoom');
  assert.equal(S.normalizeSettings({ zoom: { lock: { grid: 75 }, overviewClick: 'edit' } }).zoom.overviewClick, 'edit');
});

test('表示倍率：登録はいつも6つで枠の順のまま、4〜150 の整数に収め、おかしな枠は既定。固定はハニカム 4〜150・グラフ 20〜250', () => {
  const z = S.normalizeSettings({ zoom: { presets: [3, 200, 'x', 66.6, 100], lock: { grid: 999, graph: 5 } } }).zoom;
  assert.deepEqual(z.presets, [4, 150, 75, 67, 100, 150]);
  assert.deepEqual(z.lock, { grid: 150, graph: 20 });
  // 並べ替えない・重複もそのまま（登録の枠を押したときの動きが変わらないように）。7つ目からは捨てる
  assert.deepEqual(S.normalizeZoom({ presets: [150, 100, 100, '80', null, -5, 7, 8] }).presets, [150, 100, 100, 80, 125, 4]);
  // グラフは 250% まで固定できる。ハニカムは 150% まで
  assert.deepEqual(S.normalizeZoom({ lock: { grid: 49.6, graph: 240 } }).lock, { grid: 50, graph: 240 });
  assert.deepEqual(S.normalizeZoom({ lock: { grid: 'abc', graph: true } }).lock, { grid: null, graph: null });
  assert.deepEqual(S.normalizeZoom({ lock: { grid: '', graph: NaN } }).lock, { grid: null, graph: null });
  assert.deepEqual(S.normalizeZoom({ lock: { grid: '75', graph: 1000 } }).lock, { grid: 75, graph: 250 });
});

test('表示倍率：ほかの設定を保存しても消えず、固定はハニカム・グラフの片方だけ変えられる。読み直しても同じ', () => {
  const dir = tmpDir();
  const store = new S.SettingsStore(dir);
  store.update({ zoom: { lock: { grid: 75 } } });
  let z = store.update({ zoom: { presets: [10, 20, 30, 40, 50, 60] } }).zoom;
  assert.deepEqual(z, { presets: [10, 20, 30, 40, 50, 60], lock: { grid: 75, graph: null }, overviewClick: 'zoom' });
  z = store.update({ zoom: { lock: { graph: 120 } } }).zoom;
  assert.deepEqual(z, { presets: [10, 20, 30, 40, 50, 60], lock: { grid: 75, graph: 120 }, overviewClick: 'zoom' });
  // 関係の無い設定（タグ・今日の1枚）を保存しても倍率の登録と固定は残る
  store.update({ tags: ['仕事'] });
  z = store.update({ today: { count: 2 } }).zoom;
  assert.deepEqual(z, { presets: [10, 20, 30, 40, 50, 60], lock: { grid: 75, graph: 120 }, overviewClick: 'zoom' });
  // 縮小中のクリック（編集する）も、倍率の変更やほかの設定で消えない
  store.update({ zoom: { overviewClick: 'edit' } });
  z = store.update({ zoom: { presets: [10, 20, 30, 40, 50, 60] } }).zoom;
  assert.equal(z.overviewClick, 'edit');
  assert.equal(new S.SettingsStore(dir).get().zoom.overviewClick, 'edit');
  store.update({ zoom: { overviewClick: 'zoom' } });
  // 固定を外す（null）
  z = store.update({ zoom: { lock: { grid: null } } }).zoom;
  assert.deepEqual(z.lock, { grid: null, graph: 120 });
  const fresh = new S.SettingsStore(dir);
  assert.deepEqual(fresh.load().zoom, { presets: [10, 20, 30, 40, 50, 60], lock: { grid: null, graph: 120 }, overviewClick: 'zoom' });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, S.SETTINGS_FILE), 'utf8')).zoom, fresh.get().zoom);
});
