'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const SB = require('../sendbox.js');
const { BoardManager } = require('../boards.js');
const { AttachmentStore } = require('../attachments.js');

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hex-memo-send-'));
const NOW = '2026-10-02T00:00:00.000Z';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const rec = (text, extra = {}) => ({ text, createdAt: NOW, updatedAt: NOW, likedLevel: 0, liked: false, bookmarked: false, comments: [], ...extra });

// ノートを2冊（main と子ノート）持つメモアプリのデータフォルダ
function makeApp(memos = {}, childMemos = {}) {
  const dir = tmpDir();
  const boards = new BoardManager(dir).load();
  const child = boards.create('子ノート', 'main');
  boards.save('main', { version: 2, camera: { x: 0, y: 0 }, memos });
  boards.save(child.id, { version: 2, camera: { x: 0, y: 0 }, memos: childMemos });
  return { dir, boards, childId: child.id, attachments: new AttachmentStore(dir) };
}

test('送り先の登録：形を確かめ、同じ送り先は1つだけ。外す・ノートの削除で片付ける', () => {
  const dir = tmpDir();
  assert.deepEqual(SB.readTargets(dir), []);
  const a = SB.addTarget(dir, { kind: 'board', appId: null, boardId: 'main' });
  assert.equal(a.existed, false);
  assert.match(a.target.id, /^[a-z0-9]{4,32}$/);
  const again = SB.addTarget(dir, { kind: 'board', boardId: 'main' }); // appId を省いても同じ（大もとのアプリ）
  assert.equal(again.existed, true);
  assert.equal(again.target.id, a.target.id);
  SB.addTarget(dir, { kind: 'memo', appId: 'a1b2c3d4', boardId: 'b2', memoId: 'memo-1' });
  SB.addTarget(dir, { kind: 'board', appId: 'a1b2c3d4', boardId: 'main' }); // 別のアプリの同じ ID のノートは別の送り先
  assert.equal(SB.readTargets(dir).length, 3);
  assert.throws(() => SB.addTarget(dir, { kind: 'memo', boardId: 'main' }), /形が正しくありません/); // メモの ID が無い
  assert.throws(() => SB.addTarget(dir, { kind: 'board', appId: 'BAD', boardId: 'main' }), /形が正しくありません/);
  assert.throws(() => SB.addTarget(dir, { kind: 'board', boardId: '../x' }), /形が正しくありません/);
  // ファイルを手で壊しても、読めるものだけ
  const file = path.join(dir, SB.TARGETS_FILE);
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  raw.targets.push({ kind: 'board', boardId: '../../etc' }, { id: raw.targets[0].id, kind: 'board', boardId: 'zzz' }, 'x');
  fs.writeFileSync(file, JSON.stringify(raw));
  assert.equal(SB.readTargets(dir).length, 3);
  assert.equal(SB.removeTarget(dir, a.target.id).length, 2);
  assert.equal(SB.pruneTargets(dir, (t) => t.appId === 'a1b2c3d4' && t.boardId === 'b2').length, 1);
  fs.writeFileSync(file, '{ 壊れた');
  assert.deepEqual(SB.readTargets(dir), []);
});

test('同じメモアプリのノートへ：原点の下・マスの下へ置いて保存（重ならない・見つからなければ送らない）', () => {
  const app = makeApp({ '0,0': rec('原点', { children: { camera: { x: 0, y: 0 }, memos: { '1,-1': rec('先客') } } }) },
    { '2,0': rec('送り先のメモ', { id: 'target-memo' }) });
  const r1 = SB.insertIntoBoards(app.boards, { kind: 'board', boardId: 'main' }, [rec('A', { id: 'src' })], null, { now: NOW });
  assert.deepEqual(r1.placed, ['1,0']);
  assert.equal(r1.fellBack, false);
  const main = app.boards.store('main').current;
  assert.equal(main.memos['0,0'].children.memos['1,0'].text, 'A');
  assert.equal(main.memos['0,0'].children.memos['1,0'].id, undefined); // 写しは別のメモ
  assert.equal(main.memos['0,0'].children.memos['1,-1'].text, '先客');
  // 再読み込みしても残る（保存された）
  const reread = new BoardManager(app.dir).load();
  assert.equal(reread.store('main').current.memos['0,0'].children.memos['1,0'].text, 'A');
  // メモへ：ノートを指定しなくても、メモの ID で探す
  const r2 = SB.insertIntoBoards(app.boards, { kind: 'memo', memoId: 'target-memo', boardId: null }, [rec('B'), rec('C')], [{ dq: 0, dr: 0 }, { dq: 1, dr: 0 }], { now: NOW });
  assert.equal(r2.boardId, app.childId);
  assert.equal(r2.memoText, '送り先のメモ');
  assert.deepEqual(r2.boardPath, ['ノート 1', '子ノート']);
  const kids = app.boards.store(app.childId).current.memos['2,0'].children.memos;
  assert.deepEqual(Object.values(kids).map((x) => x.text).sort(), ['B', 'C']);
  // 見つからない：送らない（fallback なし）／原点の下へ（fallback あり）
  assert.throws(() => SB.insertIntoBoards(app.boards, { kind: 'memo', memoId: 'nothere' }, [rec('D')], null, { now: NOW }), /見つかりません/);
  assert.throws(() => SB.insertIntoBoards(app.boards, { kind: 'board', boardId: 'zzzz' }, [rec('D')], null, { now: NOW }), /見つかりません/);
  const r3 = SB.insertIntoBoards(app.boards, { kind: 'memo', memoId: 'nothere', boardId: app.childId }, [rec('E')], null, { now: NOW, fallback: true });
  assert.equal(r3.fellBack, true);
  assert.equal(r3.boardId, app.childId);
  assert.equal(app.boards.store(app.childId).current.memos['0,0'].children.memos[r3.placed[0]].text, 'E');
});

test('送り先の見出し：自分のノート・ほかのメモアプリのノートとメモ（ファイルを読むだけ）', () => {
  const self = makeApp({ '0,0': rec('原点') }, { '1,0': rec('子ノートのメモ\n2行目', { id: 'm-self' }) });
  const other = makeApp({ '3,0': rec('ゲームの敵キャラ', { id: 'm-other' }) });
  const otherBoardsJson = fs.readFileSync(path.join(other.dir, 'boards.json'), 'utf8');
  const never = tmpDir(); // 一度も起動していないアプリ（boards.json が無い）
  const ctx = {
    selfAppId: null,
    boards: self.boards,
    apps: [{ id: null, name: '六角メモ' }, { id: 'a1b2c3d4', name: 'ゲーム制作' }, { id: 'b1b2c3d4', name: '新しいアプリ' }],
    dataDirOf: (id) => (id === 'a1b2c3d4' ? other.dir : id === 'b1b2c3d4' ? never : null),
  };
  const targets = [
    { id: 't1', kind: 'board', appId: null, boardId: self.childId },
    { id: 't2', kind: 'memo', appId: null, boardId: null, memoId: 'm-self' },
    { id: 't3', kind: 'memo', appId: 'a1b2c3d4', boardId: 'main', memoId: 'm-other' },
    { id: 't4', kind: 'board', appId: 'b1b2c3d4', boardId: 'main' },
    { id: 't5', kind: 'memo', appId: null, boardId: 'main', memoId: 'gone' },
    { id: 't6', kind: 'board', appId: 'ffffffff', boardId: 'main' },
  ];
  const d = SB.describeTargets(targets, ctx);
  assert.deepEqual(d.map((x) => x.exists), [true, true, true, true, false, false]);
  assert.deepEqual(d[0].boardPath, ['ノート 1', '子ノート']);
  assert.equal(d[0].self, true);
  assert.equal(d[1].boardId, self.childId); // メモの場所から分かったノート
  assert.equal(d[1].memoText, '子ノートのメモ');
  assert.equal(d[2].self, false);
  assert.equal(d[2].appName, 'ゲーム制作');
  assert.equal(d[2].memoText, 'ゲームの敵キャラ');
  assert.deepEqual(d[3].boardPath, ['ノート 1']);
  // ほかのアプリのファイルは書き換えない（作り直したりもしない）
  assert.equal(fs.readFileSync(path.join(other.dir, 'boards.json'), 'utf8'), otherBoardsJson);
  assert.deepEqual(fs.readdirSync(never), []);
  // 「送り先を追加」の一覧：アプリごとのノート（子ノートは字下げ）
  const cat = SB.catalog(ctx);
  assert.deepEqual(cat[0].boards.map((b) => [b.name, b.depth]), [['ノート 1', 0], ['子ノート', 1]]);
  assert.equal(cat[0].self, true);
  assert.equal(cat[1].name, 'ゲーム制作');
  assert.deepEqual(cat[2].boards.map((b) => b.id), ['main']);
});

test('ほかのメモアプリへ：inbox に置き、相手が取り込む（画像も届く・二重に取り込まない）', () => {
  const sender = makeApp({ '0,0': rec('送る側') });
  const img = sender.attachments.put(PNG);
  const target = makeApp({ '0,0': rec('相手の原点'), '4,0': rec('相手のメモ', { id: 'dest' }) });
  const records = [rec('画像つきのメモ', { images: [{ id: 'i1', file: img.file, width: 1, height: 1 }] }), rec('もう1つ')];
  const files = [{ name: img.file, abs: path.join(sender.attachments.dir, img.file) }];
  const sent = SB.dropToInbox(target.dir, { target: { kind: 'memo', appId: 'a1b2c3d4', memoId: 'dest', boardId: 'main' }, records, offsets: [{ dq: 0, dr: 0 }, { dq: 1, dr: 0 }], from: { appId: null, appName: '技術メモ' } }, files);
  assert.equal(sent.missing, 0);
  assert.equal(SB.inboxState(target.dir, sent.id), 'waiting');
  // 書きかけ（.part）は取り込まない
  fs.mkdirSync(path.join(target.dir, 'inbox', '00000000-0000-4000-8000-000000000000.part'), { recursive: true });
  const res = SB.processInbox({ dir: target.dir, boards: target.boards, attachments: target.attachments });
  assert.equal(res.imported.length, 1);
  assert.equal(res.failed.length, 0);
  assert.match(res.notices[0].message, /「技術メモ」から 2 マス届きました（ノート 1・『相手のメモ』の下）/);
  const kids = target.boards.store('main').current.memos['4,0'].children.memos;
  assert.equal(Object.keys(kids).length, 2);
  assert.ok(target.attachments.has(img.file)); // 画像のファイルも相手のフォルダへ
  // 結果は送った側が読んで片付ける
  assert.equal(SB.inboxState(target.dir, sent.id), 'done');
  const result = SB.takeInboxResult(target.dir, sent.id);
  assert.equal(result.ok, true);
  assert.equal(result.placed.length, 2);
  assert.equal(SB.inboxState(target.dir, sent.id), 'gone');
  // もう一度調べても、二重には取り込まない
  const again = SB.processInbox({ dir: target.dir, boards: target.boards, attachments: target.attachments });
  assert.equal(again.imported.length, 0);
  assert.equal(Object.keys(target.boards.store('main').current.memos['4,0'].children.memos).length, 2);
  // 途中で止まった取り込み（.taking のまま）：結果があれば片付けるだけ、無ければもう一度
  const s2 = SB.dropToInbox(target.dir, { target: { kind: 'board', appId: null, boardId: 'main' }, records: [rec('途中')], from: { appName: 'X' } });
  fs.renameSync(path.join(target.dir, 'inbox', s2.id), path.join(target.dir, 'inbox', `${s2.id}.taking`));
  const r2 = SB.processInbox({ dir: target.dir, boards: target.boards, attachments: target.attachments });
  assert.equal(r2.imported.length, 1);
  assert.equal(target.boards.store('main').current.memos['0,0'].children.memos[r2.imported[0].placed[0]].text, '途中');
});

test('同じメモアプリのノートへ：置けないときのわけ（深すぎる・ノートが無い）、保存を止めているノート、登録の上限', () => {
  // 50 段の深さにあるマス（その下には置けない）
  let deep = rec('いちばん下', { id: 'deepest' });
  for (let i = 0; i < 50; i++) deep = rec(`段${i}`, { children: { camera: { x: 0, y: 0 }, memos: { '1,0': deep } } });
  const app = makeApp({ '0,0': rec('原点'), '2,0': deep });
  assert.throws(() => SB.insertIntoBoards(app.boards, { kind: 'memo', memoId: 'deepest' }, [rec('Z')], null, { now: NOW }), /深すぎる/);
  const r1 = SB.insertIntoBoards(app.boards, { kind: 'memo', memoId: 'deepest' }, [rec('Z')], null, { now: NOW, fallback: true });
  assert.equal(r1.fellBack, true);
  assert.equal(r1.fellBackReason, 'too-deep');
  assert.equal(r1.memoText, '');
  assert.equal(app.boards.store('main').current.memos['0,0'].children.memos[r1.placed[0]].text, 'Z');
  const r2 = SB.insertIntoBoards(app.boards, { kind: 'board', boardId: 'zzzz' }, [rec('Y')], null, { now: NOW, fallback: true });
  assert.equal(r2.fellBackReason, 'missing-board');
  assert.equal(r2.boardId, app.boards.list().activeId);
  app.boards.store(app.childId).readOnly = true;
  assert.throws(() => SB.insertIntoBoards(app.boards, { kind: 'board', boardId: app.childId }, [rec('X')], null, { now: NOW }), (e) => e.transient === true);
  // 登録は 60 件まで。壊れた一覧は退避して作り直す
  const dir = tmpDir();
  for (let i = 0; i < 60; i++) SB.addTarget(dir, { kind: 'board', boardId: `b${i}` });
  assert.throws(() => SB.addTarget(dir, { kind: 'board', boardId: 'b60' }), /60 件まで/);
  fs.writeFileSync(path.join(dir, SB.TARGETS_FILE), '{ 壊れ');
  SB.addTarget(dir, { kind: 'board', boardId: 'new' });
  assert.equal(SB.readTargets(dir).length, 1);
  assert.ok(fs.readdirSync(dir).some((n) => n.startsWith(`${SB.TARGETS_FILE}.corrupt-`)));
  assert.ok(!fs.readdirSync(dir).some((n) => n.endsWith('.tmp')));
});

test('ほかのメモアプリの一覧が壊れていれば「読めない」と扱う（例外にしない）。相手が動いているか・受け取れる版か', () => {
  const self = makeApp({});
  const broken = tmpDir();
  fs.writeFileSync(path.join(broken, 'boards.json'), '{ 壊れ');
  const ctx = { selfAppId: null, boards: self.boards, apps: [{ id: null, name: '六角メモ' }, { id: 'c1c2c3c4', name: '壊れたアプリ' }], dataDirOf: (id) => (id ? broken : null) };
  assert.equal(SB.catalog(ctx)[1].available, false);
  assert.equal(SB.describeTargets([{ id: 'tt', kind: 'board', appId: 'c1c2c3c4', boardId: 'main' }], ctx)[0].exists, false);
  // 動いているか：データフォルダの lockfile（Chromium が持つ）と、受け取れる版が書く印（.alive）で見分ける
  const dir = tmpDir();
  assert.equal(SB.appStatus(dir), 'stopped');
  fs.writeFileSync(path.join(dir, 'lockfile'), '');
  assert.equal(SB.appStatus(dir), 'old'); // 印が無い：古い版
  SB.markInboxAlive(dir, process.pid);
  assert.equal(SB.appStatus(dir), 'ready');
  assert.equal(SB.appStatus(dir, () => false), 'stopped'); // 印を書いたプロセスがもう無い：落ちたときの lockfile の残り
  SB.clearInboxAlive(dir, 12345); // ほかのプロセスの印は消さない
  assert.equal(SB.appStatus(dir), 'ready');
  SB.clearInboxAlive(dir, process.pid);
  assert.equal(SB.appStatus(dir), 'old');
});

test('ほかのメモアプリへ：一時的に取り込めないものは待って（わけを残し）、あとで取り込む。二重に取り込まない', () => {
  const target = makeApp({ '0,0': rec('原点') });
  target.boards.store('main').readOnly = true;
  const s1 = SB.dropToInbox(target.dir, { target: { kind: 'board', boardId: 'main' }, records: [rec('待つ')], from: { appName: 'A' } });
  let res = SB.processInbox({ dir: target.dir, boards: target.boards, attachments: target.attachments });
  assert.equal(res.imported.length, 0);
  assert.equal(res.deferred.length, 1);
  assert.equal(res.notices.filter((n) => n.level === 'warn').length, 1);
  assert.equal(SB.inboxState(target.dir, s1.id), 'waiting');
  assert.match(SB.inboxWaitReason(target.dir, s1.id), /保存を止めています/);
  res = SB.processInbox({ dir: target.dir, boards: target.boards, attachments: target.attachments });
  assert.equal(res.notices.length, 0); // 同じお知らせは繰り返さない
  target.boards.store('main').readOnly = false;
  res = SB.processInbox({ dir: target.dir, boards: target.boards, attachments: target.attachments });
  assert.equal(res.imported.length, 1);
  assert.equal(SB.inboxWaitReason(target.dir, s1.id), null);
  // 取り込み済みの印（フォルダの外）があれば、結果が読まれた後でも二重に取り込まない（片付けが途中で止まったとき）
  const s2 = SB.dropToInbox(target.dir, { target: { kind: 'board', boardId: 'main' }, records: [rec('一度だけ')], from: { appName: 'B' } });
  const w2 = path.join(target.dir, 'inbox', `${s2.id}.taking`);
  fs.renameSync(path.join(target.dir, 'inbox', s2.id), w2);
  fs.writeFileSync(path.join(target.dir, 'inbox', `${s2.id}.imported`), NOW);
  res = SB.processInbox({ dir: target.dir, boards: target.boards, attachments: target.attachments });
  assert.equal(res.imported.length, 0);
  assert.ok(!fs.existsSync(w2));
  assert.ok(!fs.existsSync(path.join(target.dir, 'inbox', `${s2.id}.imported`))); // フォルダが片付いたら印も消す
  // 取り込みが終わると、印もフォルダも残らない
  assert.deepEqual(fs.readdirSync(path.join(target.dir, 'inbox')).filter((n) => n.endsWith('.imported')), []);
  // 結果があるのに .taking が残っていた：片付けるだけ
  const s3 = SB.dropToInbox(target.dir, { target: { kind: 'board', boardId: 'main' }, records: [rec('結果あり')] });
  const w3 = path.join(target.dir, 'inbox', `${s3.id}.taking`);
  fs.renameSync(path.join(target.dir, 'inbox', s3.id), w3);
  fs.mkdirSync(path.join(target.dir, 'inbox', 'results'), { recursive: true });
  fs.writeFileSync(path.join(target.dir, 'inbox', 'results', `${s3.id}.json`), '{"ok":true}');
  res = SB.processInbox({ dir: target.dir, boards: target.boards, attachments: target.attachments });
  assert.equal(res.imported.length, 0);
  assert.ok(!fs.existsSync(w3));
  const texts = Object.values(target.boards.store('main').current.memos['0,0'].children.memos).map((r) => r.text);
  assert.deepEqual(texts, ['待つ']);
  // 大きすぎるものは待たずに failed へ。古い結果は片付ける（新しい結果は残す）
  const s4 = SB.dropToInbox(target.dir, { target: { kind: 'board', boardId: 'main' }, records: [rec('大きい')] });
  const oldResult = path.join(target.dir, 'inbox', 'results', 'old.json');
  fs.writeFileSync(oldResult, '{}');
  const past = (Date.now() - 11 * 60 * 1000) / 1000;
  fs.utimesSync(oldResult, past, past);
  res = SB.processInbox({ dir: target.dir, boards: target.boards, attachments: target.attachments, maxPayload: 10 });
  assert.equal(res.failed.length, 1);
  assert.equal(res.failed[0].id, s4.id);
  assert.ok(!fs.existsSync(oldResult));
  assert.ok(fs.existsSync(path.join(target.dir, 'inbox', 'results', `${s3.id}.json`)));
  // 画像のファイルが無ければ、その数を知らせる
  const s5 = SB.dropToInbox(target.dir, { target: { kind: 'board', boardId: 'main' }, records: [rec('x')] }, [{ name: `${'a'.repeat(64)}.png`, abs: path.join(target.dir, 'nothere.png') }]);
  assert.equal(s5.missing, 1);
  // 壊れたお知らせ・形の合わないお知らせは捨てる
  fs.writeFileSync(path.join(target.dir, 'inbox', 'notices.json'), '{ 壊れ');
  assert.deepEqual(SB.takeInboxNotices(target.dir), []);
  assert.ok(!fs.existsSync(path.join(target.dir, 'inbox', 'notices.json')));
  fs.writeFileSync(path.join(target.dir, 'inbox', 'notices.json'), JSON.stringify({ notices: [{ level: 'info', message: 'ok' }, { level: 'boom', message: 'x' }, { level: 'warn', message: 5 }] }));
  assert.deepEqual(SB.takeInboxNotices(target.dir), [{ level: 'info', message: 'ok' }]);
});

test('ほかのメモアプリへ：使用中で名前を変えられない・読めないものは待つ（わけを残す）。ノートの原点を開くための ID', (t) => {
  const target = makeApp({ '0,0': rec('原点', { id: 'origin-1' }) });
  const s1 = SB.dropToInbox(target.dir, { target: { kind: 'board', boardId: 'main' }, records: [rec('使用中')], from: { appName: 'A' } });
  const realRename = fs.renameSync;
  const busy = t.mock.method(fs, 'renameSync', (from, to) => {
    if (String(to).endsWith('.taking')) throw Object.assign(new Error('busy'), { code: 'EBUSY' });
    return realRename(from, to);
  });
  let res = SB.processInbox({ dir: target.dir, boards: target.boards, attachments: target.attachments });
  busy.mock.restore();
  assert.equal(res.imported.length, 0);
  assert.equal(res.deferred.length, 1);
  assert.equal(SB.inboxState(target.dir, s1.id), 'waiting');
  assert.match(SB.inboxWaitReason(target.dir, s1.id), /使用中/);
  // payload を読めない（EACCES など）：壊れたものとして failed へは送らず、待つ
  const realRead = fs.readFileSync;
  const locked = t.mock.method(fs, 'readFileSync', (file, ...rest) => {
    if (String(file).endsWith('payload.json')) throw Object.assign(new Error('locked'), { code: 'EACCES' });
    return realRead(file, ...rest);
  });
  res = SB.processInbox({ dir: target.dir, boards: target.boards, attachments: target.attachments, now: Date.now() + 10 * 60 * 1000 });
  locked.mock.restore();
  assert.equal(res.failed.length, 0);
  assert.equal(res.deferred.length, 1);
  res = SB.processInbox({ dir: target.dir, boards: target.boards, attachments: target.attachments });
  assert.equal(res.imported.length, 1);
  // 送り先の一覧が読めないとき（ほかのプロセスが掴んでいる）：書き換えない
  const dir = tmpDir();
  SB.addTarget(dir, { kind: 'board', boardId: 'keep' });
  const before = fs.readFileSync(path.join(dir, SB.TARGETS_FILE), 'utf8');
  const locked2 = t.mock.method(fs, 'readFileSync', (file, ...rest) => {
    if (String(file).endsWith(SB.TARGETS_FILE)) throw Object.assign(new Error('locked'), { code: 'EACCES' });
    return realRead(file, ...rest);
  });
  assert.throws(() => SB.addTarget(dir, { kind: 'board', boardId: 'new' }), /読めませんでした/);
  locked2.mock.restore();
  assert.equal(fs.readFileSync(path.join(dir, SB.TARGETS_FILE), 'utf8'), before);
  // ノートの送り先には、原点のメモの ID（ほかのメモアプリからでも、そのノートを開けるように）
  const ctx = { selfAppId: null, boards: target.boards, apps: [{ id: null, name: '六角メモ' }], dataDirOf: () => null };
  assert.equal(SB.describeTargets([{ id: 'tt', kind: 'board', appId: null, boardId: 'main' }], ctx)[0].originId, 'origin-1');
});

test('同じメモアプリのノートへ：送り先のマスの下に空きが無ければ、原点の下へ（わけ：空きが無い）', () => {
  const memos = {};
  for (let ring = 1; ring <= 60; ring++) for (const { dq, dr } of require('../send.js').ringOffsets(ring)) memos[`${dq},${dr}`] = rec('x');
  const app = makeApp({ '0,0': rec('原点'), '5,0': rec('満員', { id: 'full-memo', children: { camera: { x: 0, y: 0 }, memos } }) });
  const r = SB.insertIntoBoards(app.boards, { kind: 'memo', memoId: 'full-memo' }, [rec('入らない')], null, { now: NOW, fallback: true });
  assert.equal(r.fellBack, true);
  assert.equal(r.fellBackReason, 'full');
  assert.equal(app.boards.store('main').current.memos['0,0'].children.memos[r.placed[0]].text, '入らない');
});

test('ほかのメモアプリへ：取り込めないものは failed に残して知らせる。書きかけ（新しい・読めない）は待つ', () => {
  const target = makeApp({ '0,0': rec('原点') });
  // 送り先のマスが無い → 原点の下へ（失わない）
  const s1 = SB.dropToInbox(target.dir, { target: { kind: 'memo', memoId: 'deleted' }, records: [rec('迷子')], from: { appName: 'A' } });
  // 送るメモが読めない → failed
  const s2 = SB.dropToInbox(target.dir, { target: { kind: 'board', boardId: 'main' }, records: [null, 5, [1]], from: { appName: 'B' } });
  // payload が壊れている：新しいうちは待つ、古ければ failed
  const s3 = SB.dropToInbox(target.dir, { target: { kind: 'board', boardId: 'main' }, records: [rec('壊れる')] });
  fs.writeFileSync(path.join(target.dir, 'inbox', s3.id, 'payload.json'), '{ 書きかけ');
  const res = SB.processInbox({ dir: target.dir, boards: target.boards, attachments: target.attachments });
  assert.equal(res.imported.length, 1);
  assert.equal(res.imported[0].fellBack, true);
  assert.match(res.notices.find((n) => n.level === 'warn').message, /送り先のマスが見つからなかったため/);
  assert.equal(res.failed.length, 1);
  assert.equal(res.failed[0].id, s2.id);
  assert.ok(fs.existsSync(path.join(target.dir, 'inbox', 'failed', s2.id)));
  assert.equal(SB.takeInboxResult(target.dir, s2.id).ok, false);
  assert.equal(SB.inboxState(target.dir, s3.id), 'waiting'); // まだ待つ
  const later = SB.processInbox({ dir: target.dir, boards: target.boards, attachments: target.attachments, now: Date.now() + 120000 });
  assert.equal(later.failed.length, 1);
  assert.ok(fs.existsSync(path.join(target.dir, 'inbox', 'failed', s3.id)));
  // 画面が無いときのお知らせは残しておき、次に開いたときに出す
  SB.saveInboxNotices(target.dir, res.notices);
  const notices = SB.takeInboxNotices(target.dir);
  assert.equal(notices.length, res.notices.length);
  assert.deepEqual(SB.takeInboxNotices(target.dir), []);
  // 合図の引数
  assert.equal(SB.isInboxArg('hexmemo://inbox'), true);
  assert.equal(SB.isInboxArg('hexmemo://inbox/'), true);
  assert.equal(SB.isInboxArg('hexmemo://memo/abc'), false);
});

test('区画（写しの作業台）のあるノートへ「コピーして送る」をしても、送り先の区画は残る（ほかのメモアプリから届いたときも）', () => {
  const app = makeApp({ '0,0': rec('原点') });
  const S1 = 's0000000000000001';
  const S2 = 's0000000000000002';
  const pockets = [{
    id: 'p0123456789ab',
    name: '考えごと',
    createdAt: NOW,
    updatedAt: NOW,
    slips: [
      { id: S1, kind: 'memo', q: 0, r: 0, at: NOW, rec: rec('紙片'), origin: { board: 'main', memoId: 'gone' }, placed: [{ board: 'main', memoId: 'gone', at: NOW }] },
      { id: S2, kind: 'comment', q: 1, r: 0, at: NOW, rec: rec('コメントの紙片'), origin: { board: 'main', commentId: 'c1', parentLine: '親' } },
    ],
    lines: [{ a: S1, b: S2, createdAt: NOW }],
  }];
  app.boards.save('main', { ...app.boards.store('main').current, pockets });
  const before = JSON.parse(JSON.stringify(app.boards.store('main').current.pockets));
  assert.equal(before.length, 1);
  assert.equal(before[0].slips.length, 2);
  // 同じメモアプリのノートへ
  const r = SB.insertIntoBoards(app.boards, { kind: 'board', boardId: 'main' }, [rec('送ったメモ')], null, { now: NOW });
  assert.equal(r.placed.length, 1);
  const main = app.boards.store('main').current;
  assert.equal(main.memos['0,0'].children.memos[r.placed[0]].text, '送ったメモ');
  assert.deepEqual(main.pockets, before);
  assert.deepEqual(new BoardManager(app.dir).load().store('main').current.pockets, before); // 保存された
  // ほかのメモアプリから inbox に届いたとき
  SB.dropToInbox(app.dir, { target: { kind: 'board', appId: 'a1b2c3d4', boardId: 'main' }, records: [rec('届いたメモ')], from: { appName: 'A' } });
  const res = SB.processInbox({ dir: app.dir, boards: app.boards, attachments: app.attachments });
  assert.equal(res.imported.length, 1);
  assert.deepEqual(app.boards.store('main').current.pockets, before);
  assert.deepEqual(new BoardManager(app.dir).load().store('main').current.pockets, before);
});
