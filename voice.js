/* 音声で入力するための小さな道具（文字起こしファイルの読み取り・WAV への書き出し・変換コマンドの組み立て）
 * レンダラでは window.HexVoice、Node（テスト）では module.exports として使う。 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.HexVoice = api;
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  // 文字起こしソフト（Whisper など）が書き出しやすく、読み込みやすい形：16kHz・モノラル・16bit の WAV
  const WAV_RATE = 16000;
  const TIME_LINE = /^\s*(?:\d+:)?\d{1,2}:\d{2}[.,]\d{1,3}\s*-->\s*(?:\d+:)?\d{1,2}:\d{2}[.,]\d{1,3}.*$/;

  // 文字起こしの結果（txt・srt・vtt・Whisper の json）から、ふつうの文章だけを取り出す
  function parseTranscript(text, name = '') {
    const src = String(text || '').replace(/^﻿/, '').replace(/\r\n?/g, '\n');
    const ext = (String(name).match(/\.([a-z0-9]+)$/i) || [])[1];
    const kind = (ext || '').toLowerCase();
    const trimmed = src.trim();
    if (kind === 'json' || (!kind && /^[[{]/.test(trimmed))) {
      try {
        const v = JSON.parse(trimmed);
        if (v && typeof v.text === 'string') return tidy(v.text);
        const segs = Array.isArray(v) ? v : v && Array.isArray(v.segments) ? v.segments : v && Array.isArray(v.transcription) ? v.transcription : null;
        if (segs) return tidy(segs.map((s) => (s && typeof s.text === 'string' ? s.text.trim() : '')).filter(Boolean).join('\n'));
      } catch {
        // JSON でなければ、ふつうの文として読む
      }
    }
    if (kind === 'srt' || kind === 'vtt' || /^WEBVTT/.test(trimmed) || src.split('\n').some((l) => TIME_LINE.test(l))) {
      const out = [];
      let inNote = false;
      const lines = src.split('\n');
      lines.forEach((raw, i) => {
        const line = raw.trim();
        if (lines[i + 1] !== undefined && TIME_LINE.test(lines[i + 1]) && !TIME_LINE.test(line)) return; // 時刻の直前の行は、番号・見出し（cue の名前）
        if (!line) {
          inNote = false;
          return;
        }
        if (/^WEBVTT/.test(line) || /^(STYLE|REGION)\b/.test(line)) return;
        if (/^NOTE\b/.test(line)) {
          inNote = true;
          return;
        }
        if (inNote || TIME_LINE.test(line) || /^\d+$/.test(line)) return;
        const clean = line.replace(/<[^>]+>/g, '').trim(); // vtt の <v 話者> などの印
        if (clean && clean !== out[out.length - 1]) out.push(clean);
      });
      return tidy(out.join('\n'));
    }
    return tidy(src);
  }

  function tidy(s) {
    return String(s).split('\n').map((l) => l.replace(/\s+$/, '')).join('\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  // 何チャンネルかの音（Float32Array の配列）を1つにまとめ、toRate に間引く（区間の平均）
  function toMono(channels) {
    if (channels.length === 1) return channels[0];
    const n = Math.min(...channels.map((c) => c.length));
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let s = 0;
      for (const c of channels) s += c[i];
      out[i] = s / channels.length;
    }
    return out;
  }
  function downsample(samples, fromRate, toRate = WAV_RATE) {
    if (fromRate === toRate) return samples;
    if (fromRate < toRate) throw new Error('元の音のほうが粗いため、間引けません');
    const ratio = fromRate / toRate;
    const n = Math.floor(samples.length / ratio);
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const from = Math.floor(i * ratio);
      const to = Math.min(samples.length, Math.floor((i + 1) * ratio));
      let s = 0;
      for (let j = from; j < to; j++) s += samples[j];
      out[i] = to > from ? s / (to - from) : 0;
    }
    return out;
  }

  // 16bit PCM の WAV（モノラル）
  function encodeWav(samples, sampleRate = WAV_RATE) {
    const buf = new ArrayBuffer(44 + samples.length * 2);
    const v = new DataView(buf);
    const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    str(0, 'RIFF');
    v.setUint32(4, 36 + samples.length * 2, true);
    str(8, 'WAVE');
    str(12, 'fmt ');
    v.setUint32(16, 16, true); // fmt の長さ
    v.setUint16(20, 1, true); // PCM
    v.setUint16(22, 1, true); // モノラル
    v.setUint32(24, sampleRate, true);
    v.setUint32(28, sampleRate * 2, true); // 1秒あたりのバイト数
    v.setUint16(32, 2, true); // 1つの音のバイト数
    v.setUint16(34, 16, true); // 16bit
    str(36, 'data');
    v.setUint32(40, samples.length * 2, true);
    for (let i = 0; i < samples.length; i++) {
      const x = Math.max(-1, Math.min(1, samples[i]));
      v.setInt16(44 + i * 2, x < 0 ? x * 0x8000 : x * 0x7fff, true);
    }
    return new Uint8Array(buf);
  }

  // 変換コマンドの {file}（録音の WAV）・{dir}（そのフォルダ）・{base}（拡張子なし）・{lang}（言語：ja など）を埋める
  function fillCommand(template, vars) {
    return String(template || '').replace(/\{(file|dir|base|lang)\}/g, (_, k) => String(vars[k] ?? ''));
  }

  return { WAV_RATE, parseTranscript, toMono, downsample, encodeWav, fillCommand };
});
