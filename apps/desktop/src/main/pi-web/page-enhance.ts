/**
 * pi 网页版 · 页面体验增强注入（dev.45 建立，dev.48 重构主题跟随）
 *
 * 用户需求（均不动第三方包源码，注入脚本按 DOM 守卫仅 pi 页生效）：
 * 1. 主题跟随浏览器（dev.48，替代 dev.45 的「默认亮色」）：注入脚本轮询
 *    `urchin://pi-theme`（主进程读 nativeTheme）驱动 pi 主题——亮=官方
 *    light.css，暗=移除样式表回内置默认。pi 设置内的主题选择器同时隐藏
 *    （跟随逻辑会覆盖手选，保留选择器徒增困惑）。切亮沿用 dev.47 机制：
 *    官方 theme-change 事件热切换 + 直接替换 #theme-stylesheet——**禁止
 *    整页 reload**（reload 空窗会令目录选择拦截器短暂失效，dev.47 教训）。
 *    危险度评估（用户要求先行）：仅外观层（样式表切换），不涉会话/凭据/
 *    进程；失败模式=不同步（页面维持当前主题），无功能损失；写入值
 *    'light'/'dark' 均为官方已知值。
 * 2. 新对话按钮移植（dev.48）：隐藏顶栏原 button.chip.newchat，在左区
 *    「历史对话」标题行（.panel-sessions > .panel-section-title）尾部注入
 *    同功能小按钮（右对齐、尺寸贴合标题行高），点击转发触发原按钮逻辑。
 * 3. 最近项目删除按钮（dev.45/47）：行尾 ✕ + 删除确认（window.confirm，
 *    __ubProjDelConfirm 钩子供自动化）+ sessionStorage 会话内隐藏。
 * 4. 抑制中区路径提示（dev.45）：移除「已切换到/已在工作目录」notice。
 * 5. 更新组件隐藏（dev.47）：.dd-update 仅留版本行 + update-dot 红点隐藏。
 */
import { createLogger } from '@urchin/logger';

const log = createLogger('pi-web-enhance');

/** 注入脚本幂等标志 */
const INSTALLED_FLAG = '__ubPageEnhanceInstalled';

/** pi-web-ui 官方存储键 / 元素（前端 bundle 核验） */
const THEME_KEY = 'pi-web-ui:theme';
const THEME_LINK_ID = 'theme-stylesheet';
const THEME_CHANGE_EVENT = 'pi-web-ui:theme-change';

/** 本模块 sessionStorage 键：会话内已隐藏的最近项目路径 */
const HIDDEN_KEY = '__ubHiddenProjects';

/** 主题轮询间隔（ms）：浏览器切主题后 pi 最迟 2s + visibilitychange 即时跟进 */
const THEME_POLL_MS = 2000;

/**
 * 构建主题跟随浏览器脚本（纯字符串，可单测）。
 *
 * 轮询 urchin://pi-theme → {dark}；期望值与 localStorage 不一致时：
 * 写 key + 派发官方 theme-change 事件热切换；300ms 后样式表未达预期则
 * 直接操作 #theme-stylesheet（亮=建/换 href /themes/light.css，暗=移除）。
 */
export function buildThemeFollowScript(): string {
  return (
    '(function(){' +
    'function applyTheme(t){' +
    `if (localStorage.getItem('${THEME_KEY}') === t) return;` +
    `localStorage.setItem('${THEME_KEY}', t);` +
    `document.dispatchEvent(new CustomEvent('${THEME_CHANGE_EVENT}', { detail: t }));` +
    'setTimeout(function(){' +
    `var link = document.getElementById('${THEME_LINK_ID}');` +
    "if (t === 'light') {" +
    "if (!link || !/light/.test(link.href || '')) {" +
    "if (!link) { link = document.createElement('link'); link.id = '" +
    THEME_LINK_ID +
    "'; link.rel = 'stylesheet'; document.head.appendChild(link); }" +
    "link.href = '/themes/light.css';" +
    '}' +
    '} else if (link) { link.remove(); }' +
    '}, 300);' +
    '}' +
    'function sync(){' +
    "fetch('urchin://pi-theme', { mode: 'cors' })" +
    '.then(function(r){ return r.json(); })' +
    ".then(function(d){ applyTheme(d && d.dark ? 'dark' : 'light'); })" +
    '.catch(function(){});' +
    '}' +
    'sync();' +
    `setInterval(sync, ${THEME_POLL_MS});` +
    "document.addEventListener('visibilitychange', function(){ if (!document.hidden) sync(); });" +
    '})();'
  );
}

/**
 * 构建面板增强脚本（新对话移植 + 删除按钮/确认 + 提示抑制 + 更新组件隐藏，
 * 纯字符串可单测）。
 */
export function buildProjectsPanelScript(): string {
  return (
    '(function(){' +
    'function hiddenList(){' +
    'try { return JSON.parse(sessionStorage.getItem("' +
    HIDDEN_KEY +
    '") || "[]"); }' +
    'catch (e) { return []; }' +
    '}' +
    'function saveHidden(list){ sessionStorage.setItem("' +
    HIDDEN_KEY +
    '", JSON.stringify(list)); }' +
    // 样式（注入一次）：
    // - 行尾 ✕（悬停显现）
    // - dev.48 新对话移植：隐藏顶栏原按钮；历史对话标题行改 flex，注入按钮右对齐、
    //   尺寸贴合标题行高（18px 图标按钮）
    // - dev.48 主题跟随：隐藏 pi 设置内主题选择器触发器（跟随逻辑会覆盖手选）
    // - dev.47 更新组件：.dd-update 仅留版本行 + update-dot 红点隐藏
    'if (!document.getElementById("__ubProjStyle")) {' +
    'var st = document.createElement("style"); st.id = "__ubProjStyle";' +
    'st.textContent = ' +
    '".project-item{position:relative!important}' +
    '.__ubProjDel{position:absolute;right:6px;top:50%;transform:translateY(-50%);' +
    'width:16px;height:16px;line-height:16px;text-align:center;border-radius:4px;' +
    'cursor:pointer;color:#e5484d;font-size:12px;opacity:0;transition:opacity .12s;' +
    'background:rgba(229,72,77,.08)}' +
    '.project-item:hover .__ubProjDel{opacity:1}' +
    'button.chip.newchat{display:none!important}' +
    '.panel-sessions>.panel-section-title{display:flex!important;align-items:center}' +
    '.__ubNewChat{margin-left:auto;display:inline-flex;align-items:center;justify-content:center;' +
    'width:18px;height:18px;border:none;border-radius:4px;background:transparent;' +
    'cursor:pointer;color:inherit;font-size:15px;line-height:1;opacity:.65}' +
    '.__ubNewChat:hover{opacity:1;background:rgba(128,128,128,.12)}' +
    '.__ubThemeSelHidden{display:none!important}' +
    '.dd-update>*:not(:first-child){display:none!important}' +
    '.update-dot{display:none!important}";' +
    'document.head.appendChild(st);' +
    '}' +
    'function enhance(){' +
    // ── dev.48：新对话按钮移植到「历史对话」标题行尾 ──
    'var sessionsTitle = document.querySelector(".panel-sessions > .panel-section-title");' +
    'if (sessionsTitle && !sessionsTitle.querySelector(".__ubNewChat")) {' +
    'var nc = document.createElement("button");' +
    'nc.className = "__ubNewChat"; nc.type = "button";' +
    'nc.textContent = "+";' +
    'nc.title = "\\u65b0\\u5bf9\\u8bdd";' +
    'nc.addEventListener("click", function(ev){' +
    'ev.preventDefault(); ev.stopPropagation();' +
    // 转发触发被隐藏的原按钮（顶栏常驻渲染，display:none 不影响 .click()）
    'var orig = document.querySelector("button.chip.newchat");' +
    'if (orig) orig.click();' +
    '});' +
    'sessionsTitle.appendChild(nc);' +
    '}' +
    // ── dev.48：隐藏主题选择器触发器（chip-sub 文本「主题/theme」的 chip）──
    'var chips = document.querySelectorAll("span.chip-sub");' +
    'for (var ci = 0; ci < chips.length; ci++) {' +
    'var txt = (chips[ci].textContent || "").trim();' +
    'if (/^(\\u4e3b\\u9898|theme)$/i.test(txt)) {' +
    'var host = chips[ci].closest("[class*=chip]") || chips[ci].parentElement;' +
    'if (host && !host.classList.contains("__ubThemeSelHidden")) host.classList.add("__ubThemeSelHidden");' +
    '}' +
    '}' +
    // ── dev.45/47：最近项目删除按钮（确认 + 会话内隐藏）──
    'var hidden = hiddenList();' +
    'var items = document.querySelectorAll("button.project-item");' +
    'for (var i = 0; i < items.length; i++) {' +
    'var btn = items[i];' +
    'var path = btn.getAttribute("title") || "";' +
    'if (hidden.indexOf(path) >= 0) { btn.style.display = "none"; continue; }' +
    'btn.style.display = "";' +
    'if (!btn.querySelector(".__ubProjDel")) {' +
    'var del = document.createElement("span");' +
    'del.className = "__ubProjDel"; del.textContent = "\\u00d7"; del.title = "\\u4ece\\u5217\\u8868\\u79fb\\u9664\\u8be5\\u9879\\u76ee";' +
    'del.addEventListener("click", function(ev){' +
    'ev.preventDefault(); ev.stopPropagation();' +
    'var row = ev.target.closest("button.project-item");' +
    'var p = row && (row.getAttribute("title") || "");' +
    'var ok = (typeof window.__ubProjDelConfirm === "function")' +
    '  ? window.__ubProjDelConfirm(p)' +
    '  : window.confirm("\\u786e\\u8ba4\\u4ece\\u6700\\u8fd1\\u9879\\u76ee\\u5217\\u8868\\u79fb\\u9664\\uff1f\\n" + p);' +
    'if (!ok) return;' +
    'if (p) { var l = hiddenList(); if (l.indexOf(p) < 0) { l.push(p); saveHidden(l); } }' +
    'if (row) row.style.display = "none";' +
    '});' +
    'btn.appendChild(del);' +
    '}' +
    '}' +
    '}' +
    // 移除「已切换到/已在工作目录」路径提示（其他 notice 不动）
    'function suppressCwdNotices(){' +
    'var notes = document.querySelectorAll(".fp-notice");' +
    'for (var i = 0; i < notes.length; i++) {' +
    'var t = notes[i].textContent || "";' +
    'if (/\\u5df2\\u5207\\u6362\\u5230\\u5de5\\u4f5c\\u76ee\\u5f55|\\u5df2\\u5728\\u5de5\\u4f5c\\u76ee\\u5f55/.test(t)) notes[i].remove();' +
    '}' +
    '}' +
    'var timer = null;' +
    'function schedule(){' +
    'if (timer) return;' +
    'timer = setTimeout(function(){ timer = null; enhance(); suppressCwdNotices(); }, 80);' +
    '}' +
    'new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true });' +
    'enhance(); suppressCwdNotices();' +
    '})();'
  );
}

/**
 * 安装 pi 页增强注入（镜像 zoom/dir-picker 的生命周期模式）。
 *
 * 对每个网页 tab 的 webContents（created + 存量补装）did-finish-load 后
 * 注入主题跟随 + 面板脚本（幂等标志防叠加；脚本按 DOM 守卫，非 pi 页零影响）。
 *
 * @param tabManager 网页 tab 管理实例
 * @returns 卸载函数（移除 created 与 did-finish-load 监听）
 */
export function installPiWebPageEnhance(tabManager: {
  on(event: 'created', listener: (snapshot: { id: number }) => void): unknown;
  off(event: 'created', listener: (snapshot: { id: number }) => void): unknown;
  getTab(id: number): { webContents: unknown } | undefined;
  query(_: unknown): readonly { id: number }[];
}): () => void {
  const disposers: (() => void)[] = [];
  const script = buildThemeFollowScript() + buildProjectsPanelScript();

  const injectInto = (wc: unknown): void => {
    const electronWc = wc as Electron.WebContents;
    if (!electronWc || typeof electronWc.on !== 'function') return;
    const inject = (): void => {
      try {
        void electronWc
          .executeJavaScript(
            `if (!window.${INSTALLED_FLAG}) { window.${INSTALLED_FLAG} = true; ${script} }`,
            true,
          )
          .catch(() => {
            /* 页面导航/卸载中注入失败不影响下次 */
          });
      } catch {
        /* 忽略 */
      }
    };
    electronWc.on('did-finish-load', inject);
    disposers.push(() => {
      if (typeof electronWc.removeListener === 'function') {
        electronWc.removeListener('did-finish-load', inject);
      }
    });
    inject();
  };

  const attachToTab = (snapshot: { id: number }): void => {
    const tab = tabManager.getTab(snapshot.id);
    if (tab) injectInto(tab.webContents);
  };
  tabManager.on('created', attachToTab);
  for (const snapshot of tabManager.query({})) {
    attachToTab(snapshot);
  }
  log.info('pi-web page enhance installed');
  return () => {
    tabManager.off('created', attachToTab);
    for (const dispose of disposers) {
      dispose();
    }
  };
}
