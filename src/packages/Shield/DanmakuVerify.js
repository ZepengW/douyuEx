// 弹幕鉴真 - 对引用格式弹幕（@用户名：内容）进行真实性标注
let isDanmakuVerify = getLocalIsDanmakuVerify();
let danmakuVerifyHistorySize = getLocalDanmakuVerifyHistorySize();
let danmakuVerifyTruthCacheTTL = getLocalDanmakuVerifyTruthCacheTTL();
const DANMAKU_VERIFY_TRUTH_CACHE_MAX = 2000;

// 一级：弹幕历史循环队列
let danmakuVerifyHistory = new Array(danmakuVerifyHistorySize);
let danmakuVerifyHistoryHead = 0;
let danmakuVerifyHistoryCount = 0;

// 二级：命中提升缓存 text(归一化) -> 过期时间戳
// 使用 Map 保证插入顺序，用于 LRU 淘汰
let danmakuVerifyTruthCache = new Map();

let danmakuVerifyCleanupTimer = null;
let danmakuVerifyDomHook = null;

// 引用格式正则：@用户名：内容 或 @用户名:内容
const DANMAKU_VERIFY_QUOTE_RE = /^@[^:：]+[：:](.+)$/;

if (isDanmakuVerify) startDanmakuVerify();

function initPkg_Shield_DanmakuVerify() {
  const shieldTool = document.getElementsByClassName("FilterKeywords")[0];
  shieldTool.insertAdjacentHTML(
    "afterbegin",
    `<div class="FilterSwitchStatus" id="ex-danmakuVerify">
    <h3>弹幕鉴真</h3>
    <div>
      <span class="FilterSwitchStatus-status ${isDanmakuVerify ? "is-checked" : "is-noChecked"}">${isDanmakuVerify ? "已开启" : "未开启"}</span>
      <span class="FilterSwitchStatus-switch ${isDanmakuVerify ? "is-checked" : "is-noChecked"}">
        <span class="FilterSwitchStatus-switch-inner"></span>
      </span>
    </div>
  </div>
  <p class="FilterKeywords-intelligentText" style="display: flex; align-items: center; justify-content: space-between;">
    <span>
      历史
      <input type="number" id="ex-danmakuVerifyHistorySize" min="50" max="2000" value="${danmakuVerifyHistorySize}" style="width: 45px; height: 14px; text-align: center;" />
      条
    </span>
    <span>
      缓存
      <input type="number" id="ex-danmakuVerifyTTL" min="1" max="60" value="${Math.round(danmakuVerifyTruthCacheTTL / 60)}" style="width: 38px; height: 14px; text-align: center;" />
      分钟
    </span>
  </p>`
  );

  const dom = document.getElementById("ex-danmakuVerify");
  const statusSpan = dom.querySelector(".FilterSwitchStatus-status");
  const switchSpan = dom.querySelector(".FilterSwitchStatus-switch");
  const historySizeInput = document.getElementById("ex-danmakuVerifyHistorySize");
  const ttlInput = document.getElementById("ex-danmakuVerifyTTL");

  historySizeInput.addEventListener("click", (e) => e.stopPropagation());
  ttlInput.addEventListener("click", (e) => e.stopPropagation());

  historySizeInput.addEventListener("input", () => {
    let value = parseInt(historySizeInput.value);
    if (isNaN(value) || value < 50) { value = 50; historySizeInput.value = 50; }
    else if (value > 2000) { value = 2000; historySizeInput.value = 2000; }
    danmakuVerifyHistorySize = value;
    setLocalDanmakuVerifyHistorySize(value);
    resetDanmakuVerifyHistory();
  });

  ttlInput.addEventListener("input", () => {
    let value = parseInt(ttlInput.value);
    if (isNaN(value) || value < 1) { value = 1; ttlInput.value = 1; }
    else if (value > 60) { value = 60; ttlInput.value = 60; }
    danmakuVerifyTruthCacheTTL = value * 60;
    setLocalDanmakuVerifyTruthCacheTTL(value * 60);
  });

  dom.addEventListener("click", () => {
    isDanmakuVerify = !isDanmakuVerify;
    if (isDanmakuVerify) {
      startDanmakuVerify();
      statusSpan.className = statusSpan.className.replace("is-noChecked", "is-checked");
      statusSpan.textContent = "已开启";
      switchSpan.className = switchSpan.className.replace("is-noChecked", "is-checked");
    } else {
      stopDanmakuVerify();
      statusSpan.className = statusSpan.className.replace("is-checked", "is-noChecked");
      statusSpan.textContent = "未开启";
      switchSpan.className = switchSpan.className.replace("is-checked", "is-noChecked");
    }
    setLocalIsDanmakuVerify(isDanmakuVerify);
  });
}

// 文本归一化：去首尾空格、合并连续空格
function dvNormalize(text) {
  return text.trim().replace(/\s+/g, " ");
}

// 入历史循环队列
function danmakuVerifyAddToHistory(text) {
  if (!text) return;
  const normalized = dvNormalize(text);
  if (!normalized) return;
  danmakuVerifyHistory[danmakuVerifyHistoryHead] = normalized;
  danmakuVerifyHistoryHead = (danmakuVerifyHistoryHead + 1) % danmakuVerifyHistorySize;
  if (danmakuVerifyHistoryCount < danmakuVerifyHistorySize) {
    danmakuVerifyHistoryCount++;
  }
}

// 在历史队列中查找是否存在包含 quotedText 的弹幕
function danmakuVerifySearchHistory(quotedText) {
  const normalized = dvNormalize(quotedText);
  for (let i = 0; i < danmakuVerifyHistoryCount; i++) {
    if (danmakuVerifyHistory[i] && danmakuVerifyHistory[i].includes(normalized)) {
      return true;
    }
  }
  return false;
}

// 写入真值缓存（LRU：超容量时淘汰最旧条目）
function danmakuVerifyAddTruthCache(text) {
  const normalized = dvNormalize(text);
  if (danmakuVerifyTruthCache.has(normalized)) {
    // 已存在则刷新 TTL（先删后插以维持 Map 插入顺序）
    danmakuVerifyTruthCache.delete(normalized);
  } else if (danmakuVerifyTruthCache.size >= DANMAKU_VERIFY_TRUTH_CACHE_MAX) {
    // 淘汰最旧条目
    danmakuVerifyTruthCache.delete(danmakuVerifyTruthCache.keys().next().value);
  }
  danmakuVerifyTruthCache.set(normalized, Date.now() + danmakuVerifyTruthCacheTTL * 1000);
}

// 查询真值缓存，命中则刷新 TTL
function danmakuVerifyCheckTruthCache(text) {
  const normalized = dvNormalize(text);
  const expiry = danmakuVerifyTruthCache.get(normalized);
  if (!expiry) return false;
  if (Date.now() > expiry) {
    danmakuVerifyTruthCache.delete(normalized);
    return false;
  }
  // 命中刷新 TTL（先删后插）
  danmakuVerifyTruthCache.delete(normalized);
  danmakuVerifyTruthCache.set(normalized, Date.now() + danmakuVerifyTruthCacheTTL * 1000);
  return true;
}

// 定时清理过期真值缓存
function danmakuVerifyCleanupTruthCache() {
  const now = Date.now();
  for (const [key, expiry] of danmakuVerifyTruthCache.entries()) {
    if (expiry <= now) {
      danmakuVerifyTruthCache.delete(key);
    } else {
      break; // Map 按插入顺序排列，最旧的在前；遇到未过期则后面的也未过期
    }
  }
}

// 重置历史队列
function resetDanmakuVerifyHistory() {
  danmakuVerifyHistory = new Array(danmakuVerifyHistorySize);
  danmakuVerifyHistoryHead = 0;
  danmakuVerifyHistoryCount = 0;
}

// 对一条弹幕文本进行鉴真：先查真值缓存，再查历史队列
function danmakuVerifyCheck(text) {
  const normalized = dvNormalize(text);
  const match = normalized.match(DANMAKU_VERIFY_QUOTE_RE);
  if (!match) return false;
  const quotedContent = match[1].trim();
  if (!quotedContent) return false;

  // 先查二级真值缓存
  if (danmakuVerifyCheckTruthCache(quotedContent)) {
    return true;
  }
  // 再查一级历史队列
  if (danmakuVerifySearchHistory(quotedContent)) {
    danmakuVerifyAddTruthCache(quotedContent);
    return true;
  }
  return false;
}

// 在弹幕 DOM 上添加"真"标签
function danmakuVerifyMarkTrue(contentDom) {
  const badge = document.createElement("span");
  badge.className = "ex-dv-badge";
  badge.textContent = "真";
  contentDom.appendChild(badge);
}

function startDanmakuVerify() {
  if (danmakuVerifyDomHook) return; // 避免重复启动

  StyleHook_set(
    "Ex_Style_DanmakuVerify",
    `.ex-dv-badge {
      display: inline-block;
      margin-left: 4px;
      padding: 0 3px;
      font-size: 10px;
      font-weight: bold;
      color: #fff;
      background: #16a34a;
      border-radius: 3px;
      vertical-align: middle;
      line-height: 14px;
      pointer-events: none;
    }`
  );

  const setupHook = () => {
    startDanmakuVerifyCleanupTimer();
    danmakuVerifyDomHook = new DomHook("#js-barrage-list", false, (m) => {
      if (!isDanmakuVerify) return;
      if (m.length <= 0 || m[0].addedNodes.length <= 0) return;
      const barrageDom = m[0].addedNodes[0];
      if (!barrageDom || !("getElementsByClassName" in barrageDom)) return;
      const contentDoms = barrageDom.getElementsByClassName("Barrage-content");
      if (!contentDoms || contentDoms.length === 0) return;
      const contentDom = contentDoms[0];
      const text = contentDom.innerText ? contentDom.innerText.trim() : "";
      if (!text) return;

      // 引用格式弹幕：先鉴真，再入历史（引用本身也作为历史记录供后续引用）
      if (danmakuVerifyCheck(text)) {
        danmakuVerifyMarkTrue(contentDom);
      }
      danmakuVerifyAddToHistory(text);
    });
  };

  if (document.getElementById("js-barrage-list")) {
    setupHook();
  } else {
    let timer = setInterval(() => {
      if (document.getElementById("js-barrage-list")) {
        clearInterval(timer);
        if (!isDanmakuVerify) return; // 等待期间被关闭则不启动
        setupHook();
      }
    }, 1000);
  }
}

function stopDanmakuVerify() {
  if (danmakuVerifyDomHook) {
    danmakuVerifyDomHook.closeHook();
    danmakuVerifyDomHook = null;
  }
  stopDanmakuVerifyCleanupTimer();
  StyleHook_remove("Ex_Style_DanmakuVerify");
  resetDanmakuVerifyHistory();
  danmakuVerifyTruthCache.clear();
}

function startDanmakuVerifyCleanupTimer() {
  if (danmakuVerifyCleanupTimer) return;
  danmakuVerifyCleanupTimer = setInterval(danmakuVerifyCleanupTruthCache, 30000);
}

function stopDanmakuVerifyCleanupTimer() {
  if (danmakuVerifyCleanupTimer) {
    clearInterval(danmakuVerifyCleanupTimer);
    danmakuVerifyCleanupTimer = null;
  }
}

function getLocalIsDanmakuVerify() {
  return localStorage.getItem("ExSave_isDanmakuVerify") === "1";
}

function setLocalIsDanmakuVerify(value) {
  localStorage.setItem("ExSave_isDanmakuVerify", value ? "1" : "0");
}

function getLocalDanmakuVerifyHistorySize() {
  const saved = localStorage.getItem("ExSave_danmakuVerifyHistorySize");
  if (saved) {
    const value = parseInt(saved);
    if (!isNaN(value) && value >= 50 && value <= 2000) return value;
  }
  return 500;
}

function setLocalDanmakuVerifyHistorySize(value) {
  localStorage.setItem("ExSave_danmakuVerifyHistorySize", value.toString());
}

function getLocalDanmakuVerifyTruthCacheTTL() {
  const saved = localStorage.getItem("ExSave_danmakuVerifyTruthCacheTTL");
  if (saved) {
    const value = parseInt(saved);
    if (!isNaN(value) && value >= 60 && value <= 3600) return value;
  }
  return 300; // 默认 5 分钟
}

function setLocalDanmakuVerifyTruthCacheTTL(value) {
  localStorage.setItem("ExSave_danmakuVerifyTruthCacheTTL", value.toString());
}
