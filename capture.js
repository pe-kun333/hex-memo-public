'use strict';

/* 六角形スクショの枠：本体から受け取った画面の静止画の上に、マウスに追従する六角形の窓を出す。
 * ホイール／トラックパッドのピンチ（Ctrl+ホイールとして届く）で大きさを変え、1〜9 で登録サイズ、クリック（Enter）で切り取る。
 * 切り取った後はコメントを書いて（設定で省ける）本体へ渡す。本体が棚に置き、この窓を閉じる */

(() => {
  const $ = (id) => document.getElementById(id);
  const frame = $('frame');
  const hex = $('hex');
  const readout = $('readout');
  const sizesEl = $('sizes');
  const box = $('commentBox');
  const ta = $('comment');
  const SQ3 = Math.sqrt(3);
  const R_MIN = 40;
  const R_MAX = 2000;

  let bmp = null; // 画面の静止画（実ピクセル）
  let scale = 1; // 実ピクセル / 画面の px
  let W = 0;
  let Hh = 0;
  let cx = 0;
  let cy = 0;
  let R = 280; // 六角形の外接円の半径（画面の px）
  let sizes = [];
  let askComment = true;
  let locked = false; // 撮った後（コメント入力中）は枠を止める
  let shot = null; // 切り取った PNG
  let raf = 0;

  const clampR = (v) => Math.min(R_MAX, Math.max(R_MIN, v));

  // pointy-top（マスと同じ向き）の六角形
  function hexPath(ctx, x, y, r) {
    ctx.beginPath();
    for (let i = 0; i < 6; i++) {
      const a = (Math.PI / 180) * (60 * i - 90);
      const px = x + r * Math.cos(a);
      const py = y + r * Math.sin(a);
      if (i) ctx.lineTo(px, py);
      else ctx.moveTo(px, py);
    }
    ctx.closePath();
  }

  function draw() {
    raf = 0;
    if (!bmp) return;
    const w = SQ3 * R;
    const h = 2 * R;
    const pw = Math.max(1, Math.round(w * scale));
    const ph = Math.max(1, Math.round(h * scale));
    if (hex.width !== pw || hex.height !== ph) {
      hex.width = pw;
      hex.height = ph;
    }
    hex.style.width = `${w}px`;
    hex.style.height = `${h}px`;
    hex.style.transform = `translate(${cx - w / 2}px, ${cy - h / 2}px)`;
    const ctx = hex.getContext('2d');
    ctx.clearRect(0, 0, pw, ph);
    ctx.save();
    hexPath(ctx, pw / 2, ph / 2, R * scale - 1);
    ctx.clip();
    ctx.drawImage(bmp, (cx - w / 2) * scale, (cy - h / 2) * scale, pw, ph, 0, 0, pw, ph);
    ctx.restore();
    hexPath(ctx, pw / 2, ph / 2, R * scale - 1.5 * scale);
    ctx.lineWidth = 2 * scale;
    ctx.strokeStyle = 'rgba(255, 255, 255, .95)';
    ctx.stroke();
    hexPath(ctx, pw / 2, ph / 2, R * scale - 4 * scale);
    ctx.lineWidth = 1.2 * scale;
    ctx.strokeStyle = 'rgba(29, 155, 240, .9)';
    ctx.stroke();
    readout.textContent = `半径 ${Math.round(R)} px（${Math.round(w)} × ${Math.round(h)}）`;
  }
  const request = () => {
    if (!raf) raf = requestAnimationFrame(draw);
  };

  // 六角形の外は透明にして PNG に（実ピクセルで）
  function cropPng() {
    const w = SQ3 * R;
    const h = 2 * R;
    const pw = Math.max(1, Math.round(w * scale));
    const ph = Math.max(1, Math.round(h * scale));
    const c = document.createElement('canvas');
    c.width = pw;
    c.height = ph;
    const ctx = c.getContext('2d');
    hexPath(ctx, pw / 2, ph / 2, R * scale);
    ctx.clip();
    ctx.drawImage(bmp, (cx - w / 2) * scale, (cy - h / 2) * scale, pw, ph, 0, 0, pw, ph);
    return new Promise((resolve, reject) => {
      c.toBlob((b) => (b ? b.arrayBuffer().then((ab) => resolve(new Uint8Array(ab))) : reject(new Error('画像を作れませんでした'))), 'image/png');
    });
  }

  function renderSizes() {
    sizesEl.replaceChildren(...sizes.map((s, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `size${Math.round(R) === s ? ' is-on' : ''}`;
      b.textContent = `${i < 9 ? `${i + 1}: ` : ''}${s}`;
      b.title = `半径 ${s} px${i < 9 ? `（キー ${i + 1}）` : ''}`;
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        setR(s);
      });
      return b;
    }));
  }
  function setR(v) {
    R = clampR(v);
    request();
    renderSizes();
  }

  window.hexCapture.onFrame(async (p) => {
    W = p.width;
    Hh = p.height;
    scale = p.pixelWidth / p.width || 1;
    cx = p.cursor.x;
    cy = p.cursor.y;
    R = clampR(p.r || 280);
    sizes = Array.isArray(p.sizes) ? p.sizes : [];
    askComment = p.comment !== false;
    try {
      bmp = await createImageBitmap(new Blob([p.png], { type: 'image/png' }));
    } catch (err) {
      alert(`画面の画像を読めませんでした：${err.message}`);
      window.hexCapture.cancel();
      return;
    }
    frame.width = bmp.width;
    frame.height = bmp.height;
    frame.getContext('2d').drawImage(bmp, 0, 0);
    renderSizes();
    request();
    document.body.classList.add('is-ready');
  });

  window.addEventListener('mousemove', (e) => {
    if (locked) return;
    cx = e.clientX;
    cy = e.clientY;
    request();
  });
  window.addEventListener('wheel', (e) => {
    if (locked) return;
    e.preventDefault();
    const k = e.ctrlKey ? 0.01 : 0.0022; // ピンチは Ctrl+ホイールとして届く（細かい値）
    setR(R * Math.exp(-e.deltaY * k));
  }, { passive: false });
  window.addEventListener('mousedown', (e) => {
    if (locked || e.button !== 0) return;
    if (e.target.closest('.hud, .comment-box')) return;
    e.preventDefault();
    shoot();
  });
  window.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if (!locked) cancel();
  });

  async function shoot() {
    try {
      shot = await cropPng();
    } catch (err) {
      alert(err.message);
      return;
    }
    if (!askComment) {
      send('');
      return;
    }
    locked = true;
    document.body.classList.add('is-locked');
    // コメント欄は六角形の右（入らなければ左、それも無理なら下）に
    const w = SQ3 * R;
    const bw = 360;
    const bh = 160;
    let x = cx + w / 2 + 12;
    let y = cy - bh / 2;
    if (x + bw > W - 8) x = cx - w / 2 - bw - 12;
    if (x < 8) x = Math.max(8, Math.min(W - bw - 8, cx - bw / 2));
    y = Math.max(8, Math.min(Hh - bh - 8, y));
    box.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
    box.hidden = false;
    ta.value = '';
    ta.focus();
  }

  async function send(comment) {
    if (!shot) return;
    const png = shot;
    shot = null;
    document.body.classList.add('is-sending');
    try {
      const res = await window.hexCapture.done({ png, comment: String(comment || ''), r: Math.round(R) });
      if (!res || !res.ok) throw new Error((res && res.error) || '不明なエラー');
    } catch (err) {
      document.body.classList.remove('is-sending');
      shot = png;
      alert(`送れませんでした：${err.message}`);
    }
  }
  function unlock() {
    locked = false;
    shot = null;
    document.body.classList.remove('is-locked');
    box.hidden = true;
    request();
  }
  function cancel() {
    window.hexCapture.cancel();
  }

  $('send').addEventListener('click', () => send(ta.value.trim()));
  $('sendPlain').addEventListener('click', () => send(''));
  $('back').addEventListener('click', unlock);
  $('cancel').addEventListener('click', cancel);
  $('saveSize').addEventListener('click', async (e) => {
    e.stopPropagation();
    try {
      const res = await window.hexCapture.saveSize(Math.round(R));
      if (res && res.ok && Array.isArray(res.sizes)) {
        sizes = res.sizes;
        renderSizes();
      }
    } catch {
      // 登録できなくても撮れる
    }
  });
  ta.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send(ta.value.trim());
    } else if (e.key === 'Escape') {
      e.preventDefault();
      unlock();
    }
  });
  window.addEventListener('keydown', (e) => {
    if (e.target === ta) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      if (locked) unlock();
      else cancel();
      return;
    }
    if (locked) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      shoot();
    } else if (e.key === '+' || e.key === '=' || e.key === 'ArrowUp' || e.key === 'ArrowRight') {
      e.preventDefault();
      setR(R * 1.08);
    } else if (e.key === '-' || e.key === 'ArrowDown' || e.key === 'ArrowLeft') {
      e.preventDefault();
      setR(R / 1.08);
    } else if (/^[1-9]$/.test(e.key) && sizes[Number(e.key) - 1]) {
      e.preventDefault();
      setR(sizes[Number(e.key) - 1]);
    } else if (e.key === 's' || e.key === 'S') {
      e.preventDefault();
      $('saveSize').click();
    }
  });
})();
