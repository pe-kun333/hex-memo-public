'use strict';

/* 添付ファイル（画像・保存したページ・リンクのファビコンや代表画像）の保存。
 * データフォルダの attachments/ に、中身の SHA-256 をファイル名にして置く（同じ画像は1つだけ）。
 * メモの記録にはファイル名だけを書く。表示用の縮小版は <ハッシュ>.thumb.<拡張子>。
 * Electron に依存しないので Node 単体でテストできる。 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ATT_DIR = 'attachments';
const FILE_RE = /^([0-9a-f]{64})(\.thumb)?\.(png|jpg|gif|webp|ico|pdf)$/;
const MB = 1024 * 1024;
const LIMITS = { image: 25 * MB, thumb: 4 * MB, icon: 512 * 1024, pdf: 80 * MB };
const IMAGE_EXTS = ['png', 'jpg', 'gif', 'webp'];
const MIME = { png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', ico: 'image/x-icon', pdf: 'application/pdf' };

// 中身の先頭で種類を見分ける（拡張子や申告された種類は信用しない）
function sniff(buf) {
  if (!buf || buf.length < 4) return null;
  const b = buf;
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg';
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return 'gif';
  if (b.length >= 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  if (b[0] === 0x00 && b[1] === 0x00 && b[2] === 0x01 && b[3] === 0x00) return 'ico';
  if (b.toString('ascii', 0, 5) === '%PDF-') return 'pdf';
  return null;
}

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const isAttachmentFile = (name) => typeof name === 'string' && FILE_RE.test(name);

class AttachmentStore {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.dir = path.join(dataDir, ATT_DIR);
  }

  // 保存して { file, type, size, ext } を返す。kinds で受け付ける種類を絞る
  put(data, { kinds = IMAGE_EXTS, limit = null } = {}) {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const ext = sniff(buf);
    if (!ext || !kinds.includes(ext)) throw new Error('対応していない種類のファイルです（PNG・JPEG・GIF・WebP の画像に対応）');
    const max = limit || (ext === 'pdf' ? LIMITS.pdf : ext === 'ico' ? LIMITS.icon : LIMITS.image);
    if (buf.length > max) throw new Error(`ファイルが大きすぎます（${Math.round(max / MB)}MB まで）`);
    const file = `${sha256(buf)}.${ext}`;
    this.write(file, buf);
    return { file, type: MIME[ext], size: buf.length, ext };
  }

  // 元のファイル（hash.ext）の縮小版を保存する
  putThumb(originalFile, data) {
    const m = FILE_RE.exec(originalFile || '');
    if (!m || m[2]) throw new Error('元の画像の名前が正しくありません');
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const ext = sniff(buf);
    if (!ext || !IMAGE_EXTS.includes(ext)) throw new Error('縮小版の種類が正しくありません');
    if (buf.length > LIMITS.thumb) throw new Error('縮小版が大きすぎます');
    const file = `${m[1]}.thumb.${ext}`;
    this.write(file, buf, { replace: true });
    return file;
  }

  write(file, buf, { replace = false } = {}) {
    fs.mkdirSync(this.dir, { recursive: true });
    const abs = path.join(this.dir, file);
    if (!replace && fs.existsSync(abs)) {
      fs.utimesSync(abs, new Date(), new Date()); // 使い直した：片付けの猶予を延ばす
      return;
    }
    const tmp = `${abs}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, buf);
    fs.renameSync(tmp, abs);
  }

  // 名前が正しい添付ファイルだけ、フォルダの中の絶対パスにする（それ以外は null）
  resolve(file) {
    if (!isAttachmentFile(file)) return null;
    return path.join(this.dir, file);
  }

  has(file) {
    const abs = this.resolve(file);
    return !!abs && fs.existsSync(abs);
  }

  read(file) {
    const abs = this.resolve(file);
    if (!abs) throw new Error('ファイル名が正しくありません');
    return fs.readFileSync(abs);
  }

  mime(file) {
    const m = FILE_RE.exec(file || '');
    return m ? MIME[m[3]] : 'application/octet-stream';
  }

  // 別のメモアプリ（別のデータフォルダ）の添付ファイルを取り込む。元の画像は中身とファイル名が一致するものだけ
  importFrom(srcDir, file) {
    const m = FILE_RE.exec(file || '');
    if (!m || typeof srcDir !== 'string' || !srcDir) return false;
    if (this.has(file)) return true;
    const src = path.join(srcDir, file);
    if (path.dirname(src) !== path.resolve(srcDir)) return false;
    let buf;
    try {
      buf = fs.readFileSync(src);
    } catch {
      return false;
    }
    const ext = sniff(buf);
    if (!ext || ext !== m[3]) return false;
    if (!m[2] && sha256(buf) !== m[1]) return false; // 縮小版は元の画像のハッシュ名なので、種類だけ確かめる
    this.write(file, buf);
    return true;
  }

  // どのノートからも使われていないファイルを消す。更新から graceMs たっていないものは残す
  sweep(refs, { graceMs = 3 * 24 * 3600 * 1000, now = Date.now() } = {}) {
    let names = [];
    try {
      names = fs.readdirSync(this.dir);
    } catch {
      return { removed: 0, bytes: 0, kept: 0 };
    }
    let removed = 0;
    let bytes = 0;
    let kept = 0;
    for (const name of names) {
      const abs = path.join(this.dir, name);
      if (name.endsWith('.tmp')) {
        // 書きかけの一時ファイル（落ちたときの残り）
        try {
          if (now - fs.statSync(abs).mtimeMs > 3600 * 1000) fs.rmSync(abs, { force: true });
        } catch {
          // 消せなくても次回に回す
        }
        continue;
      }
      if (!isAttachmentFile(name)) continue;
      if (refs.has(name)) {
        kept++;
        continue;
      }
      try {
        const st = fs.statSync(abs);
        if (now - st.mtimeMs < graceMs) {
          kept++;
          continue;
        }
        fs.rmSync(abs, { force: true });
        removed++;
        bytes += st.size;
      } catch {
        // 使用中などで消せなければ残す
      }
    }
    return { removed, bytes, kept };
  }
}

// メモの記録（保存形式・画面の Map 形式のどちらでも）から、使っている添付ファイルの名前を集める
function collectRecordRefs(rec, refs = new Set()) {
  if (!rec || typeof rec !== 'object') return refs;
  const add = (f) => {
    if (isAttachmentFile(f)) refs.add(f);
  };
  if (Array.isArray(rec.images)) {
    for (const img of rec.images) {
      if (!img || typeof img !== 'object') continue;
      add(img.file);
      add(img.thumb);
    }
  }
  if (Array.isArray(rec.urls)) {
    for (const u of rec.urls) {
      if (!u || typeof u !== 'object') continue;
      add(u.favicon);
      add(u.image);
      if (u.snapshot && typeof u.snapshot === 'object') add(u.snapshot.file);
    }
  }
  // 周りに書いたメモ（第1層 children と、重ねた第2層以降 moreLayers）の中も
  const layers = [rec.children, ...(Array.isArray(rec.moreLayers) ? rec.moreLayers : [])];
  for (const layer of layers) {
    const kids = layer && layer.memos;
    if (kids) for (const child of kids instanceof Map ? kids.values() : Object.values(kids)) collectRecordRefs(child, refs);
  }
  return refs;
}

// ノート1冊の中で、メモの記録がある場所（マス・未配置の棚・ゴミ箱・区画の紙片）を全部回る。
// 保存形式（ファイルから読んだ生の JSON でも、normalizeStore を通したものでも）を受け取り、形がおかしい所は黙って飛ばす。
// 区画の紙片は pockets[].slips[].rec（紙片の rec は棚のメモと同じ形。周りに書いたメモは持たない）
function forEachStoreRecord(store, fn) {
  if (!store || typeof store !== 'object') return;
  const memos = store.memos;
  if (memos && typeof memos === 'object') {
    const list = memos instanceof Map ? memos.values() : Array.isArray(memos) ? memos : Object.values(memos);
    for (const rec of list) if (rec && typeof rec === 'object') fn(rec);
  }
  // 未配置の棚：メモの記録そのものの並び
  if (Array.isArray(store.shelf)) {
    for (const rec of store.shelf) if (rec && typeof rec === 'object') fn(rec);
  }
  // ゴミ箱：{ id, deletedAt, rec, … } の rec（周りに書いたメモも rec の中にある）
  if (Array.isArray(store.trash)) {
    for (const t of store.trash) if (t && typeof t === 'object' && t.rec && typeof t.rec === 'object') fn(t.rec);
  }
  // 区画（写しの作業台）：{ id, name, slips: [{ id, kind, rec, … }], … } の紙片の rec
  if (Array.isArray(store.pockets)) {
    for (const p of store.pockets) {
      if (!p || !Array.isArray(p.slips)) continue;
      for (const s of p.slips) if (s && s.rec && typeof s.rec === 'object') fn(s.rec);
    }
  }
}

// 書き出し（zip）とブラウザ版の片付けが使う。マス・棚・ゴミ箱・区画の紙片の添付ファイルを集める
function collectStoreRefs(store, refs = new Set()) {
  forEachStoreRecord(store, (rec) => collectRecordRefs(rec, refs));
  return refs;
}

// データフォルダの中の、ノートのファイルすべて（バックアップ・削除したノート・変換前の原本も含む）から集める。
// 読めないファイルがあれば安全のため null（何も消さない）
function collectDirRefs(dataDir) {
  const refs = new Set();
  let names;
  try {
    names = fs.readdirSync(dataDir);
  } catch {
    return null;
  }
  for (const name of names) {
    if (!/^memos(?:-[a-z0-9]{1,32})?\.json/.test(name)) continue;
    const abs = path.join(dataDir, name);
    let text;
    try {
      if (!fs.statSync(abs).isFile()) continue;
      text = fs.readFileSync(abs, 'utf8');
    } catch {
      return null;
    }
    // 壊れた JSON でも、ファイル名の形をした文字列はすべて使用中とみなす（消しすぎないように）
    for (const m of text.matchAll(/[0-9a-f]{64}(?:\.thumb)?\.(?:png|jpg|gif|webp|ico|pdf)/g)) refs.add(m[0]);
  }
  return refs;
}

module.exports = {
  ATT_DIR, FILE_RE, LIMITS, IMAGE_EXTS, MIME, AttachmentStore, sniff, sha256, isAttachmentFile,
  collectRecordRefs, forEachStoreRecord, collectStoreRefs, collectDirRefs,
};
