/* ブラウザ版の zip の読み書き（Buffer を使わず Uint8Array で）。
 * 書くのは格納（無圧縮）のみ（デスクトップ版の zip.js と同じ形）。読むのは格納と deflate（ほかのアプリで作り直した zip も読めるように）。
 * ファイル名は UTF-8。ブラウザでは window.HexZip、Node（テスト）では module.exports として使う。 */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.HexZip = api;
})(typeof self !== 'undefined' ? self : globalThis, function (root) {
  'use strict';

  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const toBytes = (data) => (data instanceof Uint8Array ? data : data instanceof ArrayBuffer ? new Uint8Array(data) : enc.encode(String(data)));

  function dosTime(date) {
    const d = date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date();
    const year = Math.max(1980, d.getFullYear());
    return {
      time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
      date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
    };
  }

  // entries: [{ name, data: Uint8Array | string }] → Uint8Array
  function createZip(entries, now = new Date()) {
    const { time, date } = dosTime(now);
    const chunks = [];
    const centrals = [];
    let offset = 0;
    for (const e of entries) {
      const name = enc.encode(String(e.name).replace(/\\/g, '/').replace(/^\/+/, ''));
      const data = toBytes(e.data);
      const crc = crc32(data);
      const local = new DataView(new ArrayBuffer(30));
      local.setUint32(0, 0x04034b50, true);
      local.setUint16(4, 20, true);
      local.setUint16(6, 0x0800, true); // ファイル名は UTF-8
      local.setUint16(8, 0, true); // 格納
      local.setUint16(10, time, true);
      local.setUint16(12, date, true);
      local.setUint32(14, crc, true);
      local.setUint32(18, data.length, true);
      local.setUint32(22, data.length, true);
      local.setUint16(26, name.length, true);
      chunks.push(new Uint8Array(local.buffer), name, data);

      const central = new DataView(new ArrayBuffer(46));
      central.setUint32(0, 0x02014b50, true);
      central.setUint16(4, 20, true);
      central.setUint16(6, 20, true);
      central.setUint16(8, 0x0800, true);
      central.setUint16(12, time, true);
      central.setUint16(14, date, true);
      central.setUint32(16, crc, true);
      central.setUint32(20, data.length, true);
      central.setUint32(24, data.length, true);
      central.setUint16(28, name.length, true);
      central.setUint32(42, offset, true);
      centrals.push(new Uint8Array(central.buffer), name);
      offset += 30 + name.length + data.length;
    }
    const centralSize = centrals.reduce((n, b) => n + b.length, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, entries.length, true);
    end.setUint16(10, entries.length, true);
    end.setUint32(12, centralSize, true);
    end.setUint32(16, offset, true);
    const parts = [...chunks, ...centrals, new Uint8Array(end.buffer)];
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of parts) {
      out.set(p, at);
      at += p.length;
    }
    return out;
  }

  async function inflateRaw(bytes) {
    if (typeof root.DecompressionStream !== 'function') throw new Error('この環境では圧縮された zip を読めません（無圧縮の zip にしてください）');
    const stream = new Blob([bytes]).stream().pipeThrough(new root.DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  // Uint8Array | ArrayBuffer → [{ name, data: Uint8Array }]（フォルダの項目は除く）
  async function readZip(input) {
    const buf = toBytes(input);
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    let endAt = -1;
    for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
      if (view.getUint32(i, true) === 0x06054b50) {
        endAt = i;
        break;
      }
    }
    if (endAt < 0) throw new Error('zip ファイルではないようです（終端が見つかりません）');
    const count = view.getUint16(endAt + 10, true);
    let p = view.getUint32(endAt + 16, true);
    const out = [];
    for (let i = 0; i < count; i++) {
      if (view.getUint32(p, true) !== 0x02014b50) throw new Error('zip が壊れています（中央ディレクトリ）');
      const flags = view.getUint16(p + 8, true);
      const method = view.getUint16(p + 10, true);
      const crc = view.getUint32(p + 16, true);
      const size = view.getUint32(p + 20, true);
      const nameLen = view.getUint16(p + 28, true);
      const extraLen = view.getUint16(p + 30, true);
      const commentLen = view.getUint16(p + 32, true);
      const localAt = view.getUint32(p + 42, true);
      const nameBytes = buf.subarray(p + 46, p + 46 + nameLen);
      const name = flags & 0x0800 ? dec.decode(nameBytes) : dec.decode(nameBytes); // 古い zip の Shift_JIS 名は読めない（中身の名前は英数字なので問題ない）
      p += 46 + nameLen + extraLen + commentLen;
      if (name.endsWith('/')) continue;
      if (flags & 0x0001) throw new Error(`${name} は暗号化されているため読めません`);
      const lNameLen = view.getUint16(localAt + 26, true);
      const lExtraLen = view.getUint16(localAt + 28, true);
      const start = localAt + 30 + lNameLen + lExtraLen;
      const raw = buf.subarray(start, start + size);
      let data;
      if (method === 0) data = raw;
      else if (method === 8) data = await inflateRaw(raw);
      else throw new Error(`${name} は対応していない圧縮方式（${method}）です`);
      if (crc32(data) !== crc) throw new Error(`${name} が壊れています（CRC が一致しません）`);
      out.push({ name, data });
    }
    return out;
  }

  const text = (bytes) => dec.decode(bytes);

  // SHA-256（16進）。ブラウザの crypto.subtle が使えない環境（http で開いたときなど）で、添付ファイルの名前を計算するため
  const K256 = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ]);
  const rotr = (x, n) => (x >>> n) | (x << (32 - n));
  function sha256Hex(input) {
    const msg = toBytes(input);
    const len = msg.length;
    const total = Math.ceil((len + 9) / 64) * 64;
    const buf = new Uint8Array(total);
    buf.set(msg);
    buf[len] = 0x80;
    const dv = new DataView(buf.buffer);
    dv.setUint32(total - 8, Math.floor(len / 0x20000000));
    dv.setUint32(total - 4, (len << 3) >>> 0);
    const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
    const w = new Uint32Array(64);
    for (let off = 0; off < total; off += 64) {
      for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4);
      for (let i = 16; i < 64; i++) {
        const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
        const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
        w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
      }
      let [a, b, c, d, e, f, g, hh] = h;
      for (let i = 0; i < 64; i++) {
        const t1 = (hh + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K256[i] + w[i]) >>> 0;
        const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
        hh = g;
        g = f;
        f = e;
        e = (d + t1) >>> 0;
        d = c;
        c = b;
        b = a;
        a = (t1 + t2) >>> 0;
      }
      h[0] = (h[0] + a) >>> 0;
      h[1] = (h[1] + b) >>> 0;
      h[2] = (h[2] + c) >>> 0;
      h[3] = (h[3] + d) >>> 0;
      h[4] = (h[4] + e) >>> 0;
      h[5] = (h[5] + f) >>> 0;
      h[6] = (h[6] + g) >>> 0;
      h[7] = (h[7] + hh) >>> 0;
    }
    return [...h].map((x) => x.toString(16).padStart(8, '0')).join('');
  }

  return { createZip, readZip, crc32, text, sha256Hex };
});
