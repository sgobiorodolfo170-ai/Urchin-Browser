/**
 * pi 网页版 · 页面体验增强注入（dev.45）
 *
 * 三项用户需求（均不动第三方包源码，注入脚本按 DOM 守卫仅 pi 页生效）：
 * 1. 主题默认亮色：pi-web-ui 前端默认 dark，主题 id 持久于 localStorage
 *    `pi-web-ui:theme`（null = dark 内置样式）。launcher 端口每次随机 →
 *    origin 变化 → localStorage 清零，故每次会话首访注入时补设 'light'：
 *    先派发官方 `pi-web-ui:theme-change` 事件尝试热切换；400ms 后若
 *    #theme-stylesheet 未生效则 reload 一次（key 已写入，重载后即亮色，
 *    不会循环）。用户在 pi 设置里显式选过其他主题（key 非 null）则不动。
 * 2. 最近项目删除按钮：左区 panel-projects 的 project-item 行尾注入 ✕，
 *    点击隐藏该行并记入 sessionStorage（React 重渲染后观察器重新应用）。
 *    注：clientId 存 localStorage 同样随端口重置——最近项目列表本就每次
 *    会话重建，会话内隐藏即等效删除；无服务端 remove_project 命令可用。
 * 3. 抑制中区路径提示：点击最近项目触发的「已切换到工作目录/已在工作
 *    目录」notice toast 即时移除（MutationObserver，仅匹配这两类文案，
 *    错误提示等其他 notice 不受影响）。
 */
import { createLogger } from '@urchin/logger';

const log = createLogger('pi-web-enhance');

/** 注入脚本幂等标志 */
const INSTALLED_FLAG = '__ubPageEnhanceInstalled';

/** pi-web-ui 官方存储键 / 元素（vendor 0.28.2 前端 bundle 核验） */
const THEME_KEY = 'pi-web-ui:theme';
const THEME_LINK_ID = 'theme-stylesheet';
const THEME_CHANGE_EVENT = 'pi-web-ui:theme-change';

/** 本模块 sessionStorage 键：会话内已隐藏的最近项目路径 */
const HIDDEN_KEY = '__ubHiddenProjects';

/**
 * 构建主题默认亮色脚本（纯字符串，可单测）。
 */
export function buildThemeDefaultScript(): string {
  return (
    '(function(){' +
    'try{' +
    `if (localStorage.getItem('${THEME_KEY}') === null) {` +
    `localStorage.setItem('${THEME_KEY}', 'light');` +
    // 先尝试官方热切换事件；400ms 后未见样式表生效则**直接替换/创建样式表**
    //（服务端 /themes/light.css，与官方切换同一 URL）——不整页 reload。
    // dev.47 教训：reload 空窗期内目录选择拦截器随 document 销毁，此间点击
    // 📁 会落回 pi 原生手输框（用户反馈「升级后选择器失效」的根因）。
    `document.dispatchEvent(new CustomEvent('${THEME_CHANGE_EVENT}', { detail: 'light' }));` +
    'setTimeout(function(){' +
    `var link = document.getElementById('${THEME_LINK_ID}');` +
    "if (!link || !/light/.test(link.href || '')) {" +
    "if (!link) { link = document.createElement('link'); link.id = '" +
    THEME_LINK_ID +
    "'; link.rel = 'stylesheet'; document.head.appendChild(link); }" +
    "link.href = '/themes/light.css';" +
    '}' +
    '}, 400);' +
    '}' +
    '}catch(e){}' +
    '})();'
  );
}

/**
 * 构建最近项目面板增强脚本（删除按钮 + 路径提示抑制，纯字符串可单测）。
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
    // 样式：行尾 ✕（悬停显现，样式注入一次）；
    // 更新组件（dev.47 用户决策：pi-web-ui 随本项目升级，页内自更新无效且误导）：
    // 隐藏 .dd-update 除首行（当前版本）外的全部内容 + 触发器新版本红点
    'if (!document.getElementById("__ubProjStyle")) {' +
    'var st = document.createElement("style"); st.id = "__ubProjStyle";' +
    'st.textContent = ' +
    '".project-item{position:relative!important}' +
    '.__ubProjDel{position:absolute;right:6px;top:50%;transform:translateY(-50%);' +
    'width:16px;height:16px;line-height:16px;text-align:center;border-radius:4px;' +
    'cursor:pointer;color:#e5484d;font-size:12px;opacity:0;transition:opacity .12s;' +
    'background:rgba(229,72,77,.08)}' +
    '.project-item:hover .__ubProjDel{opacity:1}' +
    '.dd-update>*:not(:first-child){display:none!important}' +
    '.update-dot{display:none!important}";' +
    'document.head.appendChild(st);' +
    '}' +
    'function enhance(){' +
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
    // dev.47 用户决策：删除前弹确认。默认 window.confirm（Electron 原生确认框）；
    // window.__ubProjDelConfirm(path) 可覆盖判定（E2E/自动化用，避免真弹窗阻塞）
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
 * 注入主题 + 面板脚本（幂等标志防叠加；脚本按 DOM 守卫，非 pi 页零影响）。
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
  const script = buildThemeDefaultScript() + buildProjectsPanelScript();

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
