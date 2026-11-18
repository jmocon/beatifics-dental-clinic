// In-page overlay for recordings: a visible cursor with click ripples, and a caption pill.
// Playwright videos don't show the mouse, so we draw our own.

const OVERLAY_CSS = `
    #__cur { position: fixed; left: 0; top: 0; width: 26px; height: 26px; z-index: 2147483647; pointer-events: none;
      transform: translate(-200px, -200px); transition: transform var(--__dur, 650ms) cubic-bezier(.45,.05,.25,1); }
    #__cur svg { filter: drop-shadow(0 2px 4px rgba(0,0,0,.35)); }
    .__ripple { position: fixed; z-index: 2147483646; pointer-events: none; width: 44px; height: 44px; margin: -22px 0 0 -22px;
      border-radius: 50%; border: 3px solid #3E8E9A; background: rgba(62,142,154,.18); animation: __rip .6s ease-out forwards; }
    @keyframes __rip { from { transform: scale(.3); opacity: 1 } to { transform: scale(1.5); opacity: 0 } }
    #__cap { position: fixed; left: 50%; bottom: 28px; z-index: 2147483645; pointer-events: none; max-width: 80vw;
      transform: translate(-50%, 16px); opacity: 0; transition: opacity .35s, transform .35s;
      background: rgba(20,50,61,.94); color: #fff; font: 500 22px/1.35 Figtree, system-ui, sans-serif; letter-spacing: .01em;
      padding: 14px 28px; border-radius: 999px; box-shadow: 0 10px 30px rgba(20,50,61,.35); text-align: center; }
    #__cap.on { opacity: 1; transform: translate(-50%, 0); }
    #__cap b { color: #9FD6D9; font-weight: 600; }
`;

/** Injected into every page (desktop scenes) or the phone "stage" page. */
export const OVERLAY_SCRIPT = `
(() => {
  if (window.__overlay) return;
  const css = ${JSON.stringify(OVERLAY_CSS)};
  const boot = () => {
    const style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);
    const cur = document.createElement('div');
    cur.id = '__cur';
    cur.innerHTML = '<svg width="26" height="26" viewBox="0 0 24 24"><path d="M4 2l15 11-6.5 1.2L16 21l-3 1.4-3.5-6.8L4 20z" fill="#fff" stroke="#14323D" stroke-width="1.6" stroke-linejoin="round"/></svg>';
    document.body.appendChild(cur);
    const cap = document.createElement('div');
    cap.id = '__cap';
    document.body.appendChild(cap);
    const pos = window.__curPos || { x: -200, y: -200 };
    cur.style.transform = 'translate(' + pos.x + 'px,' + pos.y + 'px)';
  };
  window.__overlay = {
    move(x, y, ms) {
      const cur = document.getElementById('__cur');
      window.__curPos = { x, y };
      if (!cur) return;
      cur.style.setProperty('--__dur', ms + 'ms');
      cur.style.transform = 'translate(' + (x - 3) + 'px,' + (y - 2) + 'px)';
    },
    ripple(x, y) {
      const r = document.createElement('div');
      r.className = '__ripple';
      r.style.left = x + 'px';
      r.style.top = y + 'px';
      document.body.appendChild(r);
      setTimeout(() => r.remove(), 700);
    },
    /** Phone scenes: a fingertip dot instead of an arrow. */
    touch() {
      const cur = document.getElementById('__cur');
      if (cur) cur.innerHTML = '<div style="width:34px;height:34px;margin:-14px 0 0 -14px;border-radius:50%;background:rgba(20,50,61,.28);border:2px solid rgba(255,255,255,.9);box-shadow:0 2px 8px rgba(0,0,0,.25)"></div>';
    },
    caption(html) {
      const cap = document.getElementById('__cap');
      if (!cap) return;
      if (!html) { cap.classList.remove('on'); return; }
      cap.innerHTML = html;
      cap.classList.add('on');
    },
  };
  if (document.body) boot(); else document.addEventListener('DOMContentLoaded', boot);
})();
`;

/** Host page for phone scenes: the site runs in a 390×844 iframe "phone", captions sit beside it. */
export function stageHtml(src: string): string {
  return `<!doctype html><html><head><meta charset="utf-8">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Figtree:wght@400;500;600&family=Newsreader:ital,opsz,wght@0,6..72,300;1,6..72,300&display=swap" rel="stylesheet">
<style>
  html, body { margin: 0; height: 100%; overflow: hidden; }
  body { background: radial-gradient(1200px 700px at 20% 30%, #E1F0EF 0%, #F3F7F5 55%, #FAFAF7 100%);
    font-family: Figtree, system-ui, sans-serif; color: #14323D; display: grid; grid-template-columns: 1fr auto; align-items: center;
    padding: 0 170px 0 150px; box-sizing: border-box; }
  .side { max-width: 640px; }
  .eyebrow { font: 600 15px Figtree, sans-serif; letter-spacing: .16em; text-transform: uppercase; color: #2A6878; margin-bottom: 18px; }
  .brand { display: flex; align-items: center; gap: 14px; margin-bottom: 56px; }
  .brand img { height: 40px; }
  .step { font: 300 58px/1.12 Newsreader, Georgia, serif; margin: 0 0 22px; transition: opacity .4s, transform .4s; }
  .step em { color: #2A6878; }
  .sub { font-size: 23px; line-height: 1.5; color: #48595F; margin: 0; transition: opacity .4s, transform .4s; }
  .fade { opacity: 0; transform: translateY(12px); }
  .phone { border-radius: 58px; padding: 13px; background: #14323D;
    box-shadow: 0 40px 90px rgba(20,50,61,.35), inset 0 0 0 2px #2A4B57; }
  .screen { width: 390px; border-radius: 46px; overflow: hidden; background: #fff; }
  .status { height: 40px; display: flex; align-items: center; justify-content: space-between; padding: 4px 34px 0;
    font: 600 15px Figtree, system-ui, sans-serif; color: #14323D; position: relative; }
  .status::after { content: ''; position: absolute; top: 9px; left: 50%; width: 104px; height: 28px; margin-left: -52px;
    background: #14323D; border-radius: 16px; }
  .status i { display: inline-block; width: 24px; height: 11px; border: 1.6px solid #14323D; border-radius: 3.5px; position: relative; }
  .status i::after { content: ''; position: absolute; inset: 1.5px 5px 1.5px 1.5px; background: #14323D; border-radius: 1.5px; }
  iframe { width: 390px; height: 844px; border: 0; background: #fff; display: block; }
</style></head><body>
  <div class="side">
    <div class="brand"><img src="/images/wordmark-smooth-teal.png" alt=""></div>
    <div class="eyebrow" id="eyebrow">For patients</div>
    <h1 class="step" id="step"></h1>
    <p class="sub" id="sub"></p>
  </div>
  <div class="phone"><div class="screen">
    <div class="status"><span>9:41</span><i></i></div>
    <iframe id="app" src="${src}"></iframe>
  </div></div>
<script>
  window.setStep = (eyebrow, step, sub) => {
    const s = document.getElementById('step'), p = document.getElementById('sub');
    s.classList.add('fade'); p.classList.add('fade');
    setTimeout(() => {
      document.getElementById('eyebrow').textContent = eyebrow;
      s.innerHTML = step; p.innerHTML = sub || '';
      s.classList.remove('fade'); p.classList.remove('fade');
    }, 380);
  };
</script>
</body></html>`;
}
