/* デモ録画のときだけページに入れる重ね表示（window.__demo）：字幕・見出しの1枚・マウスの矢印・クリックの波紋・押したキー・注目の枠。
 * ダイアログやメニュー（最前面の層）より上に出すため、全体を popover（manual）にして、ほかが開くたびに出し直す。
 * 録画の道具（scripts/demo/recorder.js）が addInitScript で入れる。アプリ本体には含めない。 */
(() => {
  if (window.__demo) return;
  const css = `
  #demoRoot { position: fixed; inset: 0; width: 100vw; height: 100vh; max-width: none; max-height: none; margin: 0; padding: 0; border: 0; background: transparent; overflow: visible; pointer-events: none; color: #fff; font-family: "IPAPGothic", "IPAGothic", sans-serif; }
  #demoRoot * { pointer-events: none; box-sizing: border-box; }
  .dm-cursor { position: absolute; left: 0; top: 0; width: 26px; height: 26px; transform: translate(-3px, -2px); transition: opacity .2s; filter: drop-shadow(0 2px 3px rgba(0,0,0,.55)); z-index: 5; }
  .dm-ripple { position: absolute; width: 44px; height: 44px; margin: -22px 0 0 -22px; border: 3px solid #ffd400; border-radius: 50%; animation: dmRipple .55s ease-out forwards; z-index: 4; }
  .dm-ripple.is-right { border-color: #f91880; }
  @keyframes dmRipple { from { transform: scale(.35); opacity: 1; } to { transform: scale(1.35); opacity: 0; } }
  .dm-caption { position: absolute; left: 50%; bottom: 34px; display: flex; align-items: center; gap: 14px; width: max-content; max-width: min(1100px, calc(100vw - 60px)); padding: 13px 24px 13px 14px; transform: translate(-50%, 16px); border: 1px solid rgba(255,255,255,.14); border-radius: 18px; background: rgba(8, 12, 18, .9); box-shadow: 0 14px 40px rgba(0,0,0,.5); opacity: 0; transition: opacity .35s, transform .35s; z-index: 3; }
  .dm-caption.is-on { opacity: 1; transform: translate(-50%, 0); }
  .dm-caption.is-top { top: 70px; bottom: auto; }
  .dm-step { flex: none; display: grid; place-items: center; min-width: 40px; height: 40px; padding: 0 10px; border-radius: 12px; background: linear-gradient(135deg, #1d9bf0, #7c3aed); font: 800 19px/1 "DejaVu Sans", sans-serif; }
  .dm-text { display: grid; gap: 3px; }
  .dm-text b { font-size: 22px; line-height: 1.35; font-weight: 700; letter-spacing: .02em; }
  .dm-text span { color: #b8c4d2; font-size: 15px; line-height: 1.45; }
  .dm-key { position: absolute; right: 30px; top: 74px; padding: 8px 16px; border: 1px solid rgba(255,255,255,.25); border-radius: 12px; background: rgba(8,12,18,.88); font: 700 20px/1.2 "DejaVu Sans", "IPAPGothic", sans-serif; letter-spacing: .04em; opacity: 0; transform: translateY(-8px); transition: opacity .2s, transform .2s; z-index: 3; }
  .dm-key.is-on { opacity: 1; transform: none; }
  .dm-spot { position: absolute; border: 3px solid #ffd400; border-radius: 14px; box-shadow: 0 0 0 9999px rgba(0,0,0,.28), 0 0 24px rgba(255,212,0,.6); opacity: 0; transition: opacity .3s, left .4s, top .4s, width .4s, height .4s; z-index: 2; }
  .dm-spot.is-on { opacity: 1; }
  .dm-title { position: absolute; inset: 0; display: grid; place-content: center; justify-items: center; gap: 18px; background: radial-gradient(ellipse at 50% 40%, #1b2a44 0%, #0b0f16 70%); opacity: 0; transition: opacity .6s; z-index: 6; text-align: center; }
  .dm-title.is-on { opacity: 1; }
  .dm-title svg { width: 92px; height: 92px; }
  .dm-title h1 { margin: 0; font-size: 54px; font-weight: 700; letter-spacing: .06em; }
  .dm-title p { margin: 0; max-width: 900px; color: #b8c4d2; font-size: 24px; line-height: 1.6; }
  .dm-title .dm-chips { display: flex; flex-wrap: wrap; justify-content: center; gap: 10px; margin-top: 6px; }
  .dm-title .dm-chips span { padding: 6px 14px; border: 1px solid rgba(255,255,255,.18); border-radius: 999px; color: #dfe7ef; font-size: 17px; }
  `;
  const HEX = '<svg viewBox="0 0 100 100"><defs><linearGradient id="dmg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#1d9bf0"/><stop offset="1" stop-color="#7c3aed"/></linearGradient></defs><polygon points="50,4 90,27 90,73 50,96 10,73 10,27" fill="none" stroke="url(#dmg)" stroke-width="7" stroke-linejoin="round"/><polygon points="50,30 67,40 67,60 50,70 33,60 33,40" fill="url(#dmg)"/></svg>';
  const CURSOR = '<svg viewBox="0 0 24 24"><path d="M3 2 L3 19.5 L7.6 15.4 L10.6 22 L13.8 20.6 L10.9 14.1 L17 14.1 Z" fill="#fff" stroke="#0b0f16" stroke-width="1.4" stroke-linejoin="round"/></svg>';

  let root;
  let cursor;
  let caption;
  let keyEl;
  let spot;
  let title;
  let keyTimer = 0;
  let raising = false;

  function raise() {
    if (!root || raising) return;
    raising = true;
    requestAnimationFrame(() => {
      raising = false;
      try {
        if (root.matches(':popover-open')) root.hidePopover();
        root.showPopover();
      } catch {
        // 出し直せなくても録画は続ける
      }
    });
  }

  function setup() {
    const style = document.createElement('style');
    style.textContent = css;
    document.head.append(style);
    root = document.createElement('div');
    root.id = 'demoRoot';
    root.setAttribute('popover', 'manual');
    root.innerHTML = `<div class="dm-spot"></div><div class="dm-caption"><div class="dm-step"></div><div class="dm-text"><b></b><span></span></div></div><div class="dm-key"></div><div class="dm-title"></div><div class="dm-cursor">${CURSOR}</div>`;
    document.body.append(root);
    cursor = root.querySelector('.dm-cursor');
    caption = root.querySelector('.dm-caption');
    keyEl = root.querySelector('.dm-key');
    spot = root.querySelector('.dm-spot');
    title = root.querySelector('.dm-title');
    cursor.style.opacity = '0';
    root.showPopover();
    const move = (e) => {
      cursor.style.opacity = '1';
      cursor.style.left = `${e.clientX}px`;
      cursor.style.top = `${e.clientY}px`;
    };
    window.addEventListener('pointermove', move, true);
    window.addEventListener('mousemove', move, true);
    window.addEventListener('pointerdown', (e) => {
      const r = document.createElement('div');
      r.className = `dm-ripple${e.button === 2 ? ' is-right' : ''}`;
      r.style.left = `${e.clientX}px`;
      r.style.top = `${e.clientY}px`;
      root.append(r);
      setTimeout(() => r.remove(), 700);
    }, true);
    // ダイアログ・メニューが開いたら、重ね表示をその上に出し直す
    document.addEventListener('toggle', (e) => {
      if (e.target !== root && e.newState === 'open') raise();
    }, true);
    new MutationObserver((list) => {
      if (list.some((m) => m.target !== root && m.target.tagName === 'DIALOG' && m.target.open)) raise();
    }).observe(document.body, { attributes: true, attributeFilter: ['open'], subtree: true });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', setup);
  else setup();

  window.__demo = {
    raise,
    caption(step, text, sub = '', { top = false } = {}) {
      if (!text) {
        caption.classList.remove('is-on');
        return;
      }
      caption.querySelector('.dm-step').textContent = step;
      caption.querySelector('.dm-step').style.display = step ? '' : 'none';
      caption.querySelector('b').textContent = text;
      caption.querySelector('.dm-text span').textContent = sub;
      caption.querySelector('.dm-text span').style.display = sub ? '' : 'none';
      caption.classList.toggle('is-top', top);
      caption.classList.add('is-on');
      raise();
    },
    key(label, ms = 1300) {
      keyEl.textContent = label;
      keyEl.classList.add('is-on');
      clearTimeout(keyTimer);
      keyTimer = setTimeout(() => keyEl.classList.remove('is-on'), ms);
      raise();
    },
    spot(rect, pad = 8) {
      if (!rect) {
        spot.classList.remove('is-on');
        return;
      }
      Object.assign(spot.style, { left: `${rect.x - pad}px`, top: `${rect.y - pad}px`, width: `${rect.width + pad * 2}px`, height: `${rect.height + pad * 2}px` });
      spot.classList.add('is-on');
      raise();
    },
    title(head, sub = '', chips = []) {
      if (!head) {
        title.classList.remove('is-on');
        return;
      }
      title.innerHTML = `${HEX}<h1></h1><p></p><div class="dm-chips"></div>`;
      title.querySelector('h1').textContent = head;
      title.querySelector('p').textContent = sub;
      title.querySelector('.dm-chips').append(...chips.map((c) => Object.assign(document.createElement('span'), { textContent: c })));
      title.classList.add('is-on');
      raise();
    },
    hideCursor() {
      cursor.style.opacity = '0';
    },
  };
})();
