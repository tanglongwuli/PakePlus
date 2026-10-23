window.addEventListener("DOMContentLoaded",()=>{const t=document.createElement("script");t.src="https://www.googletagmanager.com/gtag/js?id=G-W5GKHM0893",t.async=!0,document.head.appendChild(t);const n=document.createElement("script");n.textContent="window.dataLayer = window.dataLayer || [];function gtag(){dataLayer.push(arguments);}gtag('js', new Date());gtag('config', 'G-W5GKHM0893');",document.body.appendChild(n)});// ============================================================
// PakePlus 注入脚本 · 电子白板专用
// ============================================================

// ---- 第一部分：PakePlus 官方示例（解决 target="_blank" 链接无法打开的问题）----
const hookClick = (e) => {
  const origin = e.target.closest('a');
  const isBaseTargetBlank = document.querySelector('head base[target="_blank"]');
  if (
    (origin && origin.href && origin.target === '_blank') ||
    (origin && origin.href && isBaseTargetBlank)
  ) {
    e.preventDefault();
    location.href = origin.href;
  }
};
window.open = function (url) { location.href = url; };
document.addEventListener('click', hookClick, { capture: true });

// ---- 第二部分：为授权遮罩层注入“最小化 / 关闭”按钮 ----
;(function () {
  async function minimizeWin() {
    try {
      if (!window.__TAURI__) return;
      if (window.__TAURI__.window) {
        if (window.__TAURI__.window.getCurrentWindow) {
          const { getCurrentWindow } = window.__TAURI__.window;
          await getCurrentWindow().minimize();
          return;
        }
        if (window.__TAURI__.window.appWindow) {
          await window.__TAURI__.window.appWindow.minimize();
          return;
        }
      }
    } catch (e) { console.warn('minimize failed:', e); }
  }

  async function closeWin() {
    try {
      if (!window.__TAURI__) return;
      if (window.__TAURI__.window) {
        if (window.__TAURI__.window.getCurrentWindow) {
          const { getCurrentWindow } = window.__TAURI__.window;
          await getCurrentWindow().close();
          return;
        }
        if (window.__TAURI__.window.appWindow) {
          await window.__TAURI__.window.appWindow.close();
          return;
        }
      }
    } catch (e) { console.warn('close failed:', e); }
  }

  function makeBtn(text, title, kind) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = text;
    b.title = title;
    const isClose = kind === 'close';
    b.style.cssText = `
      width:38px;height:38px;border-radius:9px;
      display:grid;place-items:center;
      font-family:inherit;font-size:${isClose ? '15px' : '17px'};
      cursor:pointer;outline:none;padding:0;
      border:1px solid ${isClose ? 'rgba(248,113,113,.38)' : 'rgba(120,180,255,.30)'};
      background:${isClose ? 'rgba(248,113,113,.10)' : 'rgba(120,180,255,.10)'};
      color:${isClose ? '#fca5a5' : '#e6edf7'};
      transition:background .15s,color .15s;
      line-height:1;
    `;
    b.onmouseenter = () => {
      b.style.background = isClose ? 'rgba(248,113,113,.26)' : 'rgba(120,180,255,.24)';
      if (isClose) b.style.color = '#fff';
    };
    b.onmouseleave = () => {
      b.style.background = isClose ? 'rgba(248,113,113,.10)' : 'rgba(120,180,255,.10)';
      if (isClose) b.style.color = '#fca5a5';
    };
    return b;
  }

  function injectControls() {
    const overlay = document.getElementById('__pbLicenseOverlay');
    if (!overlay) return;
    if (overlay.dataset.__winControlsInjected === '1') return;
    overlay.dataset.__winControlsInjected = '1';

    const bar = document.createElement('div');
    bar.style.cssText = `
      position:absolute; top:14px; right:14px;
      display:flex; gap:8px; z-index:100000;
      pointer-events:auto;
    `;

    const minBtn = makeBtn('—', '最小化', 'min');
    minBtn.addEventListener('click', function (e) { e.stopPropagation(); minimizeWin(); });

    const closeBtn = makeBtn('✕', '关闭', 'close');
    closeBtn.addEventListener('click', function (e) { e.stopPropagation(); closeWin(); });

    bar.appendChild(minBtn);
    bar.appendChild(closeBtn);
    overlay.appendChild(bar);
    console.log('[PakePlus] 授权遮罩层窗口按钮已注入');
  }

  let tries = 0;
  const timer = setInterval(() => {
    injectControls();
    tries++;
    const overlay = document.getElementById('__pbLicenseOverlay');
    if ((overlay && overlay.dataset.__winControlsInjected === '1') || tries > 60) {
      clearInterval(timer);
    }
  }, 300);

  if (document.body) {
    new MutationObserver(injectControls).observe(document.body, { childList: true, subtree: true });
  } else {
    document.addEventListener('DOMContentLoaded', function () {
      new MutationObserver(injectControls).observe(document.body, { childList: true, subtree: true });
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', injectControls);
  } else { injectControls(); }
  window.addEventListener('load', injectControls);
})();

// ---- 第三部分：劫持 fetch，让 kdocs.cn 请求走 Tauri 后端，绕过 CORS ----
;(function hijackFetchForKdocs() {
  try {
    if (!window.__TAURI__ || !window.__TAURI__.http || !window.__TAURI__.http.fetch) {
      console.warn('[PakePlus] 未检测到 window.__TAURI__.http.fetch，无法劫持 fetch');
      return;
    }
    const tauriFetch = window.__TAURI__.http.fetch;
    const originalFetch = window.fetch.bind(window);
    window.fetch = function (input, init) {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      if (url.indexOf('kdocs.cn') !== -1) {
        console.log('[PakePlus] 代理请求 →', url);
        return tauriFetch(input, init);
      }
      return originalFetch(input, init);
    };
    console.log('[PakePlus] fetch 已成功劫持：kdocs.cn 请求将走 Tauri 后端');
  } catch (e) {
    console.warn('[PakePlus] fetch 劫持失败:', e);
  }
})();