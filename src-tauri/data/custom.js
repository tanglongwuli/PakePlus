window.addEventListener("DOMContentLoaded",()=>{const t=document.createElement("script");t.src="https://www.googletagmanager.com/gtag/js?id=G-W5GKHM0893",t.async=!0,document.head.appendChild(t);const n=document.createElement("script");n.textContent="window.dataLayer = window.dataLayer || [];function gtag(){dataLayer.push(arguments);}gtag('js', new Date());gtag('config', 'G-W5GKHM0893');",document.body.appendChild(n)});// ============================================================
// PakePlus 注入脚本 · 电子白板专用
// ============================================================

// ------------------------------------------------------------
// 第一部分：PakePlus 官方示例（让 target="_blank" 和 window.open
// 在 Tauri WebView 里能正常跳转，不要删）
// ------------------------------------------------------------
const hookClick = (e) => {
  const origin = e.target.closest('a')
  const isBaseTargetBlank = document.querySelector(
    'head base[target="_blank"]'
  )
  console.log('origin', origin, isBaseTargetBlank)
  if (
    (origin && origin.href && origin.target === '_blank') ||
    (origin && origin.href && isBaseTargetBlank)
  ) {
    e.preventDefault()
    console.log('handle origin', origin)
    location.href = origin.href
  } else {
    console.log('not handle origin', origin)
  }
}

window.open = function (url, target, features) {
  console.log('open', url, target, features)
  location.href = url
}

document.addEventListener('click', hookClick, { capture: true })

// ------------------------------------------------------------
// 第二部分：为授权遮罩层注入“最小化 / 关闭”按钮
// 只在授权遮罩层 __pbLicenseOverlay 出现时生效，
// 激活成功后遮罩层消失，按钮也随之消失。
// ------------------------------------------------------------
(function () {
  // ---- 最小化窗口 ----
  async function minimizeWin() {
    try {
      if (!window.__TAURI__) return;
      // Tauri v2
      if (window.__TAURI__.window) {
        if (window.__TAURI__.window.getCurrentWindow) {
          const { getCurrentWindow } = window.__TAURI__.window;
          await getCurrentWindow().minimize();
          return;
        }
        // Tauri v1
        if (window.__TAURI__.window.appWindow) {
          await window.__TAURI__.window.appWindow.minimize();
          return;
        }
      }
      // 兜底：Tauri internals（部分版本）
      if (window.__TAURI_INTERNALS__?.invoke) {
        await window.__TAURI_INTERNALS__.invoke('plugin:window|minimize');
      }
    } catch (e) {
      console.warn('minimize failed:', e);
    }
  }

  // ---- 关闭窗口 ----
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
      if (window.__TAURI_INTERNALS__?.invoke) {
        await window.__TAURI_INTERNALS__.invoke('plugin:window|close');
      }
    } catch (e) {
      console.warn('close failed:', e);
    }
  }

  // ---- 生成按钮 ----
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

  // ---- 注入 ----
  function injectControls() {
    const overlay = document.getElementById('__pbLicenseOverlay');
    if (!overlay) return;
    // 只在遮罩层还没被注入过时处理
    if (overlay.dataset.__winControlsInjected === '1') return;
    overlay.dataset.__winControlsInjected = '1';

    const bar = document.createElement('div');
    bar.style.cssText = `
      position:absolute; top:14px; right:14px;
      display:flex; gap:8px; z-index:100000;
      pointer-events:auto;
    `;

    const minBtn = makeBtn('—', '最小化', 'min');
    minBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      minimizeWin();
    });

    const closeBtn = makeBtn('✕', '关闭', 'close');
    closeBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      closeWin();
    });

    bar.appendChild(minBtn);
    bar.appendChild(closeBtn);
    overlay.appendChild(bar);

    console.log('[PakePlus] 授权遮罩层窗口按钮已注入');
  }

  // ---- 触发：轮询 + DOM 变化监听 + 事件，双保险 ----
  let tries = 0;
  const timer = setInterval(() => {
    injectControls();
    tries++;
    // 遮罩层已经注入过，或尝试 60 次（约 18 秒）后停掉
    const overlay = document.getElementById('__pbLicenseOverlay');
    if ((overlay && overlay.dataset.__winControlsInjected === '1') || tries > 60) {
      clearInterval(timer);
    }
  }, 300);

  // 监听 body 变化，遮罩层一插入就立刻处理
  if (document.body) {
    new MutationObserver(injectControls).observe(document.body, {
      childList: true,
      subtree: true
    });
  } else {
    document.addEventListener('DOMContentLoaded', function () {
      new MutationObserver(injectControls).observe(document.body, {
        childList: true,
        subtree: true
      });
    });
  }

  // 页面加载完成后也尝试一次
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', injectControls);
  } else {
    injectControls();
  }

  window.addEventListener('load', injectControls);
})();