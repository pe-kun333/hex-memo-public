'use strict';

/* 合成ノートの道具（段 1）。配置ヒント付きのノートを 4 冊作る開発用の道具で、アプリの実行には使わない。
 * 出すもの：出力フォルダの中に、データフォルダ（boards.json と memos-*.json。デスクトップ版は HEX_MEMO_DATA_DIR に指定して開く）と、
 * zip フォルダの中に、ノート 1 冊ずつの zip（中身は memos.json だけ。ブラウザ版の「データの読み込み」に渡す）。
 * 走らせ方：node scripts/demo/graph-sample.js <出力フォルダ>（空のフォルダを指定する）
 * 実データの場所（%APPDATA%\hex-memo）には書かない。その下と、中身のあるフォルダ（boards.json があるものを含む）は断る。 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { normalizeStore } = require('../../store');
const { BoardManager, INDEX_FILE } = require('../../boards');
const { createZip } = require('../../zip');

// 節の zone（節の番号 s を 6 で割った余りで選ぶ）
const ZONES = ['right', 'top-right', 'top-left', 'left', 'bottom-left', 'bottom-right'];

// 作る 4 冊（タブの順）。N = 1 + sections × (1 + perSection) + grok
const NOTES = [
  { name: 'graph-10', sections: 3, perSection: 1, grok: 3, hubW: 0.9 },
  { name: 'graph-38', sections: 6, perSection: 4, grok: 7, hubW: 0.9 },
  { name: 'graph-106', sections: 6, perSection: 15, grok: 9, hubW: 0.9 },
  { name: 'graph-38-noweight', sections: 6, perSection: 4, grok: 7, hubW: null },
];

// 原点から輪の順に並べたハニカムのマス（軸座標の [q, r] の配列）。hint-sim.js の hexCells と同じ順
function hexCells(n) {
  const out = [[0, 0]];
  const dirs = [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]];
  for (let k = 1; out.length < n; k++) {
    let q = -k;
    let r = k;
    for (const [dq, dr] of dirs) {
      for (let s = 0; s < k && out.length < n; s++) {
        out.push([q, r]);
        q += dq;
        r += dr;
      }
    }
  }
  return out.slice(0, n);
}

// メモの ID。sample.js の id(n) と同じ形
const idOf = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

// 1 冊分のストア（{ version, memos, links, layoutHints }）と数を作る。
// 並び：ハブ 1 → 節ごとに「節 1 → その節の項目」→ Grok 考察。その順に hexCells のマスへ置く
function buildGraphNote({ sections, perSection, grok, hubW, now = new Date() }) {
  const iso = now.toISOString();
  const n = 1 + sections * (1 + perSection) + grok;
  const cells = hexCells(n);
  const memos = {};
  const nodes = {}; // 配置ヒント（メモの ID → ヒント）
  const links = [];
  let next = 0; // 次に置くマスの番号（0 始まり）

  const place = (text, extra = {}) => {
    const [q, r] = cells[next];
    const rec = {
      id: idOf(next + 1), text, createdAt: iso, updatedAt: iso, likedLevel: 0, liked: false, bookmarked: false, comments: [], ...extra,
    };
    memos[`${q},${r}`] = rec;
    next++;
    return rec.id;
  };
  const link = (a, b) => links.push({ a, b, createdAt: iso });

  const hubId = place(`ハブ：グラフの試し（${n} マス）`);
  nodes[hubId] = { pin: { x: 0.5, y: 0.5 }, weight: 1 };

  const sectionIds = [];
  for (let s = 0; s < sections; s++) {
    const zone = ZONES[s % ZONES.length];
    const group = `g${s}`;
    const sid = place(`節 ${s + 1}（${zone}）`);
    nodes[sid] = { zone, group, ...(typeof hubW === 'number' ? { weight: hubW } : {}) };
    link(hubId, sid);
    sectionIds.push(sid);
    for (let i = 0; i < perSection; i++) {
      const iid = place(`項目 ${s + 1}-${i + 1}`);
      nodes[iid] = { group };
      link(sid, iid);
    }
  }
  for (let g = 0; g < grok; g++) {
    const kid = place(`Grok 考察 ${g + 1}`, { tags: ['Grok'] });
    link(sectionIds[g % sections], kid);
  }

  const store = {
    version: 2,
    memos,
    links,
    layoutHints: { v: 1, source: 'sample', createdAt: iso, grokOuter: true, nodes },
  };
  return { store, counts: { n, links: links.length, hints: Object.keys(nodes).length } };
}

// 実データの場所（%APPDATA%\hex-memo）の絶対パス。ファイルは読まず、場所の文字列だけ作る
function realDataDir(env = process.env) {
  const roaming = env.APPDATA ? env.APPDATA : path.join(os.homedir(), 'AppData', 'Roaming');
  return path.resolve(path.join(roaming, 'hex-memo'));
}

// 比べるときの形（Windows では大文字小文字を区別しない）
const comparable = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);

// 出力先を使ってよいか。使ってよいとき { ok: true, dir }、断るとき { ok: false, error }
function checkOutDir(outDir, env = process.env) {
  if (typeof outDir !== 'string' || outDir.trim() === '') {
    return { ok: false, error: '出力フォルダを指定してください（node scripts/demo/graph-sample.js <出力フォルダ>）' };
  }
  const dir = path.resolve(outDir);
  const real = realDataDir(env);
  const rel = path.relative(comparable(real), comparable(dir));
  // 同じ場所（rel が空）か、その下。下は、上へ出る「..」の区間で始まらず、別のドライブでもないこと（「..foo」の名前は下に入る）
  const underReal = rel === '' || (!path.isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${path.sep}`));
  if (underReal) return { ok: false, error: `実データの場所（${real}）の下には書きません` };
  if (fs.existsSync(path.join(dir, INDEX_FILE))) {
    return { ok: false, error: 'すでにノートのあるフォルダです（boards.json があります）。空のフォルダを指定してください' };
  }
  // memos.json だけがあるフォルダも、読み込みで main のノートとして拾われて上書きされるので、中身のあるフォルダは断る
  if (fs.existsSync(dir) && (!fs.statSync(dir).isDirectory() || fs.readdirSync(dir).length > 0)) {
    return { ok: false, error: '空のフォルダを指定してください（中身のあるフォルダには書きません）' };
  }
  return { ok: true, dir };
}

// 出力フォルダに、データフォルダと zip を書く。断られたら何も書かずに Error を投げる
function writeGraphSamples(outDir, { env = process.env, now = new Date() } = {}) {
  const checked = checkOutDir(outDir, env);
  if (!checked.ok) throw new Error(checked.error);
  const dir = checked.dir;
  fs.mkdirSync(dir, { recursive: true });
  const iso = now.toISOString();

  const bm = new BoardManager(dir).load(now);
  const built = NOTES.map((spec, k) => {
    const { store, counts } = buildGraphNote({ ...spec, now });
    const board = k === 0 ? bm.rename('main', spec.name) : bm.create(spec.name, null);
    bm.save(board.id, store);
    return { spec, store, counts, board };
  });
  // 開いたときに 38 マスが出るように、38 のノートを表示中にする（setActive はメモリだけなので、一覧も書き直す）
  bm.setActive(built.find((b) => b.spec.name === 'graph-38').board.id);
  bm.writeIndex();

  const zipDir = path.join(dir, 'zip');
  fs.mkdirSync(zipDir, { recursive: true });
  const notes = built.map(({ spec, store, counts, board }) => {
    const zip = path.join(zipDir, `${spec.name}.hexmemo.zip`);
    fs.writeFileSync(zip, createZip([{ name: 'memos.json', data: JSON.stringify(store, null, 2) }], now));
    const after = normalizeStore(JSON.parse(JSON.stringify(store)), iso).store;
    const hintsAfter = after.layoutHints && after.layoutHints.nodes ? Object.keys(after.layoutHints.nodes).length : 0;
    return { name: spec.name, file: board.file, zip, n: counts.n, links: counts.links, hints: counts.hints, hintsAfter };
  });
  return { dir, notes };
}

module.exports = { hexCells, buildGraphNote, NOTES, realDataDir, checkOutDir, writeGraphSamples };

if (require.main === module) {
  try {
    const res = writeGraphSamples(process.argv[2]);
    for (const n of res.notes) {
      console.log(`${n.name}  N=${n.n}  線 ${n.links}  ヒント ${n.hintsAfter}  zip: ${n.zip}`);
    }
    console.log(`デスクトップ版：$env:HEX_MEMO_DATA_DIR = "${res.dir}"; npm start（HEX_MEMO_HOME が未設定であること）`);
    console.log('ブラウザ版：npm run serve:web で開き、「データの読み込み」で zip/<名前>.hexmemo.zip を選ぶ（タブが 1 つ足される）');
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  }
}
