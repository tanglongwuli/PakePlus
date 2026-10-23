/* ============================================================================
 *  PhysBoard 授权模块 license.js
 *  配合 Cloudflare Workers + KV 授权服务使用
 *  必须在 app.js 之前加载
 *
 *  离线策略（v3）：
 *    · verify 网络不可达 / 5xx  → 使用本地未过期 token 继续运行（离线宽限）
 *    · token 过期但续期网络不可达 → 若最近 GRACE_DAYS 天内验证成功过，仍可离线使用
 *    · 服务端明确 401/403 撤销 token → 用激活码静默续期，续期失败才弹激活框
 *    · 本地期限同时受「本地 TOKEN_DAYS」与「服务端 expiresAt」双重约束：
 *        7 天试用码断网也无法超过 7 天，正式码最多 29 天
 *    · 激活框提供「暂不激活，退出程序」出口，避免内网机器卡死
 * ============================================================================ */
(function () {
'use strict';

/* ===== 1. 配置 ===== */
const API_BASE   = 'https://api.tangzhanglao123.cn';
const AUTH_FILE  = 'auth.json';
const TOKEN_DAYS = 29;
const GRACE_DAYS = 180;                /* 离线宽限天数：token 过期后，最近这么久内验证过就允许离线 */


/* ===== 1b. 基础工具：auth.json 签名 ===== */
/* 换成只有你自己知道的 64 位随机 hex。注意：一旦定下来不要再改，
   改了以后旧的 auth.json 全部验签失败，等同"清除激活记录"。 */
const SECRET = 'f3a9c2e1d84b7065a1c8e2f9d4b36807a2c5e9f1b4d76082c3a1e5f9b2d6480c';

/**
 * HMAC-SHA256 签名（十六进制输出）
 * 依赖 Web Crypto API：Tauri 应用 / https / localhost 均可用
 * @param {string} key      密钥
 * @param {string} message  待签名文本
 * @returns {Promise<string>}
 */
async function hmacSha256(key, message) {
  if (!window.crypto || !window.crypto.subtle) {
    throw new Error('当前环境不支持 Web Crypto（crypto.subtle），无法计算 HMAC 签名。请使用 Tauri 桌面版，或通过 https / localhost 打开页面。');
  }
  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    enc.encode(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, enc.encode(message));
  const bytes = new Uint8Array(sig);
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, '0');
  }
  return hex;
}


/* ===== 2. Tauri 环境下的文件读写（exe 同级目录） ===== */

let __appDirCache = null;       // null = 未解析；'' = 浏览器环境；string = 已解析路径
let __appDirPromise = null;     // 并发保护：多个调用同时到达时只解析一次
let __isBrowserEnv = null;      // null = 未判断；true/false = 已判断

async function getAppDir() {
  /* ---------- ① 已缓存有效路径 → 直接返回 ---------- */
  if (__appDirCache !== null) return __appDirCache;

  /* ---------- ② 已有解析进行中 → 复用同一个 Promise ---------- */
  if (__appDirPromise) return __appDirPromise;

  /* ---------- ③ 开始解析 ---------- */
  __appDirPromise = (async () => {
    const t = window.__TAURI__;

    /* ===== 浏览器环境：直接返回空字符串并缓存，永不再试 ===== */
    if (!t || !t.path) {
      __isBrowserEnv = true;
      __appDirCache = '';
      return __appDirCache;
    }
    __isBrowserEnv = false;

    /* ========== 方案 A：resolveResource('../') ========== */
    try {
      if (typeof t.path.resolveResource === 'function') {
        const res = await t.path.resolveResource('../');
        if (res && typeof res === 'string') {
          const dir = await t.path.dirname(res);
          if (dir) { __appDirCache = dir; return dir; }
        }
      }
    } catch (e) {
      console.warn('[getAppDir] 方案 A (resolveResource) 失败：', e);
    }

    /* ========== 方案 B：executableDir() ========== */
    try {
      if (typeof t.path.executableDir === 'function') {
        const dir = await t.path.executableDir();
        if (dir && typeof dir === 'string') { __appDirCache = dir; return dir; }
      }
    } catch (e) {
      console.warn('[getAppDir] 方案 B (executableDir) 失败：', e);
    }

    /* ========== 方案 C：resourceDir() ========== */
    try {
      if (typeof t.path.resourceDir === 'function') {
        const dir = await t.path.resourceDir();
        if (dir && typeof dir === 'string') { __appDirCache = dir; return dir; }
      }
    } catch (e) {
      console.warn('[getAppDir] 方案 C (resourceDir) 失败：', e);
    }

    /* ========== 方案 D：appDataDir() ========== */
    try {
      if (typeof t.path.appDataDir === 'function') {
        const dir = await t.path.appDataDir();
        if (dir && typeof dir === 'string') { __appDirCache = dir; return dir; }
      }
    } catch (e) {
      console.warn('[getAppDir] 方案 D (appDataDir) 失败：', e);
    }

    /* ========== 全部失败 ========== */
    console.error('[getAppDir] 所有路径策略均失败，下次调用会重新尝试');
    return '';
  })();

  try {
    return await __appDirPromise;
  } finally {
    __appDirPromise = null;
  }
}

async function readFile(name) {
  const t = window.__TAURI__;

  /* ---------- ① 优先走 Tauri 文件系统 ---------- */
  if (t && t.fs && t.path) {
    try {
      const dir = await getAppDir();
      if (dir && dir !== '') {
        const p = await t.path.join(dir, name);
        const content = await t.fs.readTextFile(p);
        if (content != null) return content;
      }
    } catch (e) {
      /* 文件不存在或路径无效，静默回退 */
    }
  }

  /* ---------- ② 浏览器环境 / Tauri 读取失败时走 localStorage 兜底 ---------- */
  try {
    return localStorage.getItem('__pb_' + name);
  } catch (e) {
    return null;
  }
}

async function writeFile(name, content) {
  const t = window.__TAURI__;

  /* ---------- ① 优先走 Tauri 文件系统 ---------- */
  if (t && t.fs && t.path) {
    try {
      const dir = await getAppDir();

      if (dir === '' || dir === null || dir === undefined) {
        throw new Error('getAppDir 未返回有效目录');
      }

      const p = await t.path.join(dir, name);
      await t.fs.writeTextFile(p, content);
      return;
    } catch (e) {
      console.warn('[writeFile] Tauri 文件写入失败，回退到 localStorage：', name, e);
    }
  }

  /* ---------- ② 浏览器环境 / 文件写入失败时的兜底 ---------- */
  try {
    localStorage.setItem('__pb_' + name, content);
  } catch (e) {
    console.warn('[writeFile] localStorage 写入也失败了：', name, e);
  }
}

/* ===== 3. auth.json 读写 ===== */
let __auth = null;
let __offlineMode = false;
let __activatedOk = false;     // ← 新增：本次运行是否已成功激活，避免重复调用
function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return 'dev-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
}

async function writeAuth(a) {
  const body = JSON.stringify(a);
  const mac = await hmacSha256(SECRET, body); // SECRET 硬编码
  await writeFile(AUTH_FILE, JSON.stringify({ body, mac }));
}
async function readAuth() {
  const text = await readFile(AUTH_FILE);
  if (!text) return null;
  try {
    const { body, mac } = JSON.parse(text);
    if (await hmacSha256(SECRET, body) !== mac) return null; // 被篡改
    return JSON.parse(body);
  } catch (e) { return null; }
}

/* ---- 归一化服务端返回的 expiresAt（兼容数字 / ISO 字符串 / null） ---- */
function normalizeExpiresAt(v) {
  if (typeof v === 'number' && v > 0 && isFinite(v)) return v;
  if (typeof v === 'string') {
    const t = Date.parse(v);
    if (!isNaN(t) && t > 0) return t;
  }
  return 0;   // 0 = 服务端未给期限（永久授权）
}

/* ---- 计算本地 token 有效期：不超过 29 天，也不超过服务端期限 ---- */
function computeTokenExpiry(serverExpiresAt) {
  const localMax = Date.now() + TOKEN_DAYS * 24 * 3600 * 1000;
  const se = normalizeExpiresAt(serverExpiresAt);
  if (se > 0) return Math.min(localMax, se);
  return localMax;
}

/* ===== 4. 网络请求（区分网络错误和服务端拒绝） ===== */
async function fetchWithTimeout(url, opts, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms || 3000);
  try {
    return await fetch(url, Object.assign({}, opts, { signal: ctrl.signal }));
  } finally {
    clearTimeout(timer);
  }
}

async function postJSON(path, body) {
  try {
    const res = await fetchWithTimeout(API_BASE + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }, 10000);
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, data: data, networkError: false };
  } catch (e) {
    return { ok: false, status: 0, data: {}, networkError: true, error: e };
  }
}

async function getJSON(path, token) {
  const headers = {};
  if (token) headers['Authorization'] = 'Bearer ' + token;
  try {
    const res = await fetchWithTimeout(API_BASE + path, { headers: headers }, 5000);
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, data: data, networkError: false };
  } catch (e) {
    return { ok: false, status: 0, data: {}, networkError: true, error: e };
  }
}

/* ===== 5. 核心流程：确保已激活 ===== */

let __licenseInfo = {
  code: '',
  expiresAt: null,
  daysLeft: null,
  maxDevices: 5,
  boundCount: 0,
  offline: false
};

async function ensureActivated() {
  /* ---------- 0. 本次运行已激活成功 → 直接返回，避免重复网络请求 ---------- */
  if (__activatedOk) return true;

  let auth = await readAuth();

  /* 第一次启动：生成 deviceId 并落盘 */
  if (!auth) {
    auth = {
      deviceId: uuid(),
      code: '',
      token: '',
      tokenExpiresAt: 0,
      activatedAt: 0,
      lastVerifiedAt: 0
    };
    await writeAuth(auth);
  }

  /* ---------- ① token 未过期 → 远端验证 ---------- */
  if (auth.token && auth.tokenExpiresAt > Date.now()) {
    const r = await getJSON('/api/verify', auth.token);

    if (r.ok) {
      const se = normalizeExpiresAt(r.data.expiresAt);

      /* 服务端返回成功，但 expiresAt 已过期 → 视为授权失效，转续期流程 */
      if (se > 0 && se <= Date.now()) {
        console.warn('[license] verify 成功但服务端期限已过，转续期流程');
        auth.token = '';
        auth.tokenExpiresAt = 0;
        await writeAuth(auth);
        /* 不 return，继续往下走续期 / 激活 */
      } else {
        auth.lastVerifiedAt = Date.now();
        /* 用服务端 expiresAt 校正本地期限：只收紧，不放宽 */
        if (se > 0) {
          auth.serverExpiresAt = se;
          auth.tokenExpiresAt = Math.min(
            auth.tokenExpiresAt || Infinity,
            se
          );
        }
        await writeAuth(auth);
        __auth = auth;
        __offlineMode = false;
        __activatedOk = true;
        __licenseInfo = {
          code: r.data.code || auth.code || '',
          expiresAt: r.data.expiresAt || null,
          daysLeft: r.data.daysLeft != null ? r.data.daysLeft : null,
          maxDevices: r.data.maxDevices || 5,
          boundCount: r.data.boundCount || 0,
          offline: false
        };
        return true;
      }
    }

    /* 网络 / 服务端故障 → 离线宽限（双重期限检查） */
    if (r.networkError || r.status >= 500) {
      const effExp = Math.min(
        auth.tokenExpiresAt || 0,
        (typeof auth.serverExpiresAt === 'number' && auth.serverExpiresAt > 0)
          ? auth.serverExpiresAt
          : Infinity
      );
      if (effExp > Date.now()) {
        console.warn('[license] verify 不可达，进入离线宽限模式：',
                     r.networkError ? 'network' : r.status);
        __auth = auth;
        __offlineMode = true;
        __activatedOk = true;
        __licenseInfo = {
          code: auth.code || '',
          expiresAt: null,
          daysLeft: Math.max(0, Math.ceil((effExp - Date.now()) / 86400000)),
          maxDevices: 5,
          boundCount: 0,
          offline: true
        };
        return true;
      }
      /* 期限已到 → 不 return，继续往下走去续期 / 弹激活框 */
      console.warn('[license] verify 不可达且本地期限已到，转续期流程');
    }

    /* 服务端明确拒绝 → token 被撤销，清空后尝试续期 */
    if (r.status === 401 || r.status === 403) {
      console.warn('[license] token 被服务端拒绝（' + r.status + '），尝试续期');
      auth.token = '';
      auth.tokenExpiresAt = 0;
      await writeAuth(auth);
    }
    /* 其他 4xx（如 429 限流）→ 不清 token，继续走续期 */
  }

  /* ---------- ② token 过期或已被撤销 → 用 code 续期 ---------- */
  if (auth.code) {
    const r = await postJSON('/api/activate', {
      code: auth.code,
      deviceId: auth.deviceId
    });

    if (r.ok && r.data.token) {
      auth.token = r.data.token;
      auth.tokenExpiresAt = computeTokenExpiry(r.data.expiresAt);
      const se = normalizeExpiresAt(r.data.expiresAt);
      if (se > 0) auth.serverExpiresAt = se;
      auth.lastVerifiedAt = Date.now();
      await writeAuth(auth);
      __auth = auth;
      __offlineMode = false;
      __activatedOk = true;
      __licenseInfo = {
        code: r.data.code || auth.code || '',
        expiresAt: r.data.expiresAt || null,
        daysLeft: r.data.daysLeft != null ? r.data.daysLeft : null,
        maxDevices: r.data.maxDevices || 5,
        boundCount: r.data.boundCount || 0,
        offline: false
      };
      return true;
    }

    /* 续期遇到网络 / 服务端故障：宽限期内允许离线 */
    if (r.networkError || r.status >= 500) {
      const lastOk = auth.lastVerifiedAt || 0;
      const withinGrace =
        lastOk > 0 && (Date.now() - lastOk) < GRACE_DAYS * 86400000;

      /* 服务端期限也必须未到，否则 7 天试用过期后断网仍会被放行 */
      const serverExp = (typeof auth.serverExpiresAt === 'number' && auth.serverExpiresAt > 0)
        ? auth.serverExpiresAt
        : Infinity;
      const serverOk = serverExp > Date.now();

      if (withinGrace && serverOk) {
        console.warn('[license] 续期不可达，宽限期内离线继续');
        __auth = auth;
        __offlineMode = true;
        __activatedOk = true;
        __licenseInfo = {
          code: auth.code || '',
          expiresAt: null,
          daysLeft: null,
          maxDevices: 5,
          boundCount: 0,
          offline: true
        };
        return true;
      }
      if (withinGrace && !serverOk) {
        console.warn('[license] 服务端授权期限已到，不再离线宽限');
      }
    }
  }

  /* ---------- ③ 都失败 → 激活界面 ---------- */
  const ok = await showActivationUI();
  if (ok) __activatedOk = true;
  return ok;
}


/* ===== 6. 对外查询 ===== */
function getLicenseInfo() { return __licenseInfo; }
function isOffline()      { return __offlineMode; }
function getToken()       { return __auth ? __auth.token    : ''; }
function getDeviceId()    { return __auth ? __auth.deviceId : ''; }

/* ===== 7. 激活界面 ===== */
function injectStyles() {
  if (document.getElementById('pbLicStyle')) return;
  const s = document.createElement('style');
  s.id = 'pbLicStyle';
  s.textContent = `
    .pblic-mask{position:fixed;inset:0;z-index:99999;background:rgba(4,10,22,.88);
      backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);
      display:flex;align-items:center;justify-content:center;
      font-family:system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;
      color:#e6edf7;padding:20px;}
    .pblic-card{width:100%;max-width:460px;padding:32px 28px 24px;
      background:linear-gradient(160deg,rgba(24,36,60,.98),rgba(14,22,40,.98));
      border:1px solid rgba(120,180,255,.28);border-radius:20px;
      box-shadow:0 30px 80px rgba(0,8,24,.7),0 0 60px rgba(56,189,248,.12);}
    .pblic-title{font-size:19px;font-weight:600;margin:0 0 14px;
      display:flex;align-items:center;gap:10px;}
    .pblic-title::before{content:'';width:4px;height:18px;border-radius:2px;
      background:linear-gradient(180deg,#38bdf8,#818cf8);
      box-shadow:0 0 12px rgba(56,189,248,.5);}
    .pblic-msg{font-size:13.5px;color:#8fa3c0;line-height:1.7;margin:0 0 22px;}
    .pblic-card input{width:100%;height:52px;padding:0 14px;
      background:rgba(8,16,32,.6);border:1px solid rgba(120,180,255,.22);
      border-radius:12px;color:#e6edf7;outline:none;
      font-family:ui-monospace,Menlo,Consolas,monospace;
      font-size:17px;letter-spacing:1.5px;
      transition:border-color .15s,box-shadow .15s;}
    .pblic-card input:focus{border-color:#38bdf8;
      box-shadow:0 0 0 3px rgba(56,189,248,.13);}
    .pblic-card input::placeholder{color:#5b6b84;}
    .pblic-status{min-height:20px;font-size:12.5px;margin:10px 0 6px;
      letter-spacing:.3px;color:#8fa3c0;}
    .pblic-status.bad{color:#fca5a5;}
    .pblic-status.ok{color:#4ade80;}
    .pblic-btn{width:100%;height:52px;margin-top:10px;
      background:linear-gradient(135deg,#38bdf8,#818cf8);color:#fff;
      border:none;border-radius:12px;font-size:15px;font-weight:600;
      letter-spacing:1px;font-family:inherit;cursor:pointer;
      box-shadow:0 6px 20px rgba(56,189,248,.35);transition:.15s;}
    .pblic-btn:hover{filter:brightness(1.1);}
    .pblic-btn:active{transform:scale(.98);}
    .pblic-btn:disabled{opacity:.5;cursor:default;filter:none;}
    .pblic-btn-ghost{background:rgba(120,180,255,.10);box-shadow:none;
      color:#b8c7de;font-weight:500;letter-spacing:.3px;}
    .pblic-btn-ghost:hover{background:rgba(120,180,255,.18);filter:none;}
    .pblic-foot{margin-top:22px;padding-top:18px;
      border-top:1px solid rgba(120,180,255,.12);
      font-size:12px;color:#6b7c96;line-height:1.9;text-align:center;}
  `;
  document.head.appendChild(s);
}

let __activationPromise = null;

function showActivationUI(message) {
  if (__activationPromise) return __activationPromise;
  if (document.getElementById('pbLicMask')) {
    return Promise.resolve(false);
  }

  __activationPromise = new Promise(function (resolve) {
    injectStyles();

    const mask = document.createElement('div');
    mask.id = 'pbLicMask';
    mask.className = 'pblic-mask';
    mask.innerHTML =
      '<div class="pblic-card">' +
        '<div class="pblic-title">软件未激活</div>' +
        '<div class="pblic-msg">' +
          (message || '请输入激活码完成授权。每个激活码可绑定多台设备，绑定后无需重复输入。') +
        '</div>' +
        '<input id="pbLicInput" placeholder="XXXX-XXXX-XXXX-XXXX" autocomplete="off" spellcheck="false">' +
        '<div class="pblic-status" id="pbLicStatus"></div>' +
        '<button class="pblic-btn" id="pbLicBtn">激 活</button>' +
        '<button class="pblic-btn pblic-btn-ghost" id="pbLicExit">暂不激活，退出程序</button>' +
        '<div class="pblic-foot">' +
          '作者：唐龙 · 公众号：Mli随笔 · B站/抖音：教物理的唐长老' +
        '</div>' +
      '</div>';
    document.body.appendChild(mask);

    const input = document.getElementById('pbLicInput');
    const btn   = document.getElementById('pbLicBtn');
    const st    = document.getElementById('pbLicStatus');

    function closeWith(result) {
      try { mask.remove(); } catch (e) {}
      __activationPromise = null;
      resolve(result);
    }

    input.addEventListener('input', function () {
      const v = input.value.replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 16);
      input.value = v.replace(/(.{4})(?=.)/g, '$1-');
    });

    async function activate() {
      const code = input.value.trim().toUpperCase();
      if (code.replace(/-/g, '').length !== 16) {
        st.className = 'pblic-status bad';
        st.textContent = '请输入完整的 16 位激活码';
        return;
      }
      btn.disabled = true;
      btn.textContent = '验证中…';
      st.className = 'pblic-status';
      st.textContent = '';

      let auth = await readAuth();
      if (!auth) {
        auth = {
          deviceId: uuid(),
          code: '',
          token: '',
          tokenExpiresAt: 0,
          activatedAt: 0,
          lastVerifiedAt: 0
        };
      }

      const r = await postJSON('/api/activate', {
        code: code,
        deviceId: auth.deviceId
      });

      if (!r.ok) {
        st.className = 'pblic-status bad';
        if (r.networkError) {
          st.textContent = '网络错误：无法连接授权服务器，请检查网络后重试';
        } else {
          st.textContent = r.data.error || ('激活失败（HTTP ' + r.status + '）');
        }
        btn.disabled = false;
        btn.textContent = '激 活';
        return;
      }

      const se = normalizeExpiresAt(r.data.expiresAt);

      auth.code = code;
      auth.token = r.data.token;
      auth.tokenExpiresAt = computeTokenExpiry(r.data.expiresAt);
      if (se > 0) auth.serverExpiresAt = se; else delete auth.serverExpiresAt;
      auth.activatedAt = Date.now();
      auth.lastVerifiedAt = Date.now();
      await writeAuth(auth);
      __auth = auth;
      __offlineMode = false;
      __licenseInfo = {
        code: r.data.code || code,
        expiresAt: se > 0 ? se : null,
        daysLeft: r.data.daysLeft != null ? r.data.daysLeft : null,
        maxDevices: r.data.maxDevices || 5,
        boundCount: r.data.boundCount || 0,
        offline: false
      };

      st.className = 'pblic-status ok';
      st.textContent = '激活成功 · 本码剩余 ' +
        ((r.data.maxDevices || 5) - (r.data.boundCount || 1)) + ' 台设备名额';

      /* 成功提示期间禁止再点「退出」，避免"激活成功但程序不启动" */
      const exitBtn = document.getElementById('pbLicExit');
      if (exitBtn) {
        exitBtn.disabled = true;
        exitBtn.style.opacity = '0.4';
        exitBtn.style.pointerEvents = 'none';
      }
      btn.disabled = true;

      setTimeout(function () { closeWith(true); }, 900);
    }

    btn.addEventListener('click', activate);
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') activate();
    });

    document.getElementById('pbLicExit').addEventListener('click', function () {
      closeWith(false);
    });

    setTimeout(function () { try { input.focus(); } catch (e) {} }, 100);
  });

  return __activationPromise;
}

/* ===== 8. 对外接口 ===== */
const licenseAPI = {
  API_BASE: API_BASE,
  ensureActivated: ensureActivated,
  getToken: getToken,
  getDeviceId: getDeviceId,
  getLicenseInfo: getLicenseInfo,
  isOffline: isOffline,
  check: async function () { return !!(await readAuth()); },
  showActivationUI: function (msg) { return showActivationUI(msg); }
};

// 【修补】防止控制台直接覆盖或删除该对象
Object.defineProperty(window, '__pbLicense', {
  value: licenseAPI,
  writable: false,
  configurable: false
});

/* 把文件读写暴露给 app.js 复用 */
window.__pbFS = {
  getAppDir: getAppDir,
  readFile: readFile,
  writeFile: writeFile
};

})();