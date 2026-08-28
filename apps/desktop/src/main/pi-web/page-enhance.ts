/**
 * pi 网页版 · 页面体验增强注入（dev.45 建立，dev.48 主题跟随，dev.49 直推+删按钮）
 *
 * 用户需求（均不动第三方包源码，注入脚本按 DOM 守卫仅 pi 页生效）：
 * 1. 主题完全跟随浏览器（dev.49 根治「切主题时 pi 卡住/不跟随」）：
 *    - **主进程直推**：浏览器切主题（ui.theme.set）后立刻向所有 pi 标签
 *      executeJavaScript 调注入脚本暴露的 `window.__ubApplyTheme`，不再
 *      依赖 2s 轮询滞后（轮询降级为兜底，覆盖页面加载/推送竞态）。
 *    - **同步幂等应用**：applyTheme 直接同步增删 #theme-stylesheet
 *      （亮=官方 light.css，暗=移除回内置默认），去掉 dev.48 的 300ms
 *      延迟双步——那次双步与 localStorage 前置守卫组合会在 React 重挂载
 *      改写存储后永久早退，造成 DOM 主题与浏览器脱节（「阻塞」根因）。
 *    - **官方存储语义**：亮写 key='light'、暗移除 key（与 pi-web-ui 的
 *      da()/Yt() 一致），React 挂载时读到的状态与 DOM 恒一致，不打架。
 *    - 仍派发官方 theme-change 事件（无人监听也零副作用）。**禁止整页
 *      reload**（reload 空窗会令目录选择拦截器短暂失效，dev.47 教训）。
 *    - 危险度评估（用户要求先行）：仅外观层（样式表切换），不涉会话/
 *      凭据/进程；失败模式=不同步（页面维持当前主题，轮询兜底），无
 *      功能损失；写入值 'light'/null 均为官方已知值。
 * 2. 删除主题切换按钮（dev.49，用户要求：pi 主题完全跟随浏览器，不提供
 *    手选）：顶栏主题下拉触发器（chip-sub「主题/theme」所在 .dropdown）
 *    整体移除 + 「更多」菜单（.dd-menu）内主题段（dd-header「主题」+ 其
 *    后 dd-item）移除。React 重渲染会重建节点，由 MutationObserver 调度
 *    的 enhance() 反复重删（与 dev.45 删除按钮同一生命周期）。
 * 3. 新对话按钮移植（dev.48）：隐藏顶栏原 button.chip.newchat，在左区
 *    「历史对话」标题行（.panel-sessions > .panel-section-title）尾部注入
 *    同功能小按钮（右对齐、尺寸贴合标题行高），点击转发触发原按钮逻辑。
 * 4. 最近项目删除按钮（dev.45/47）：行尾 ✕ + 删除确认（window.confirm，
 *    __ubProjDelConfirm 钩子供自动化）+ sessionStorage 会话内隐藏。
 * 5. 抑制中区路径提示（dev.45，dev.64 修正选择器）：左区切换项目时服务端发
 *    notice「已切换到/已在工作目录」，0.29.x 渲染为 fixed 居中 toast（.notice，
 *    .notices 容器）——dev.45 瞄准的 .fp-notice 在 0.29.1 实为「预览截断」提示
 *    未命中；现对匹配文本的 .notice 转发点击 .notice-close 走官方 dismiss_notice
 *    通道（React 状态一致，重渲染不复活），.fp-notice 移除保留兜底；错误级提示
 *    （切换工作目录失败）不匹配文本，不受影响。
 * 6. 更新组件隐藏（dev.47）：.dd-update 仅留版本行 + update-dot 红点隐藏。
 * 7. 左区重构（dev.65，详见 left-panel.ts）：上区改「项目配置」（技能/插件启停 +
 *    .pi/ 配置文件编辑），下区改「项目」管理（项目行切换 + 行内「＋」新建对话 +
 *    当前项目下挂运行对话与历史会话）。自有面板经同 clientId 第二条 WebSocket 收发
 *    官方协议；未就绪前官方面板保持可见（:has() 降级）。
 * 8. 中区布局控制（dev.67，详见 layout.ts + ui-state.ts）：中区左右上角折叠
 *    按钮 + 分割线拖拽调宽，状态经 urchin://pi-ui-state 主进程落盘跨会话保留；
 *    左区项目按持久化顺序排列（首见追加，会话触发不影响）+ 行拖拽排序；
 *    toast/[data-tip] 层叠修复（右区标题行不再遮挡提示）。
 * 9. 对话输入框重构（dev.51 → dev.54 基线，用户参考 ChatGPT 风格截图）：
 *    纯 CSS 注入（不改第三方源码、不移动 React 持有节点）——
 *    - dev.51 布局：.inputbox 外壳透明化，主输入箱（.inputbox-row，textarea
 *      独占首行 flex-wrap 换行）与工具条（.input-tools，模型/思考 chips）拆分；
 *      发送/停止改主题反色圆角方块（var(--text)/var(--bg) 自动反转）；
 *    - dev.52：①「+」合并——主箱内上传按钮隐藏，统一用 .input-tools-right 内
 *      那一只并 order:-1 移到 chips 最左，SVG 图标用 ::before "+" 替换；
 *      ② 工具条内弹窗一律向上；③ 主箱与独立条合成一体大框（gap:0 去缝、上/
 *      下圆角、margin-top:-1px 成分割线、focus 光环包整框）；
 *    - dev.53：①「+」/模型/思考 间距 6→16px；② 工具条背景 var(--bg)（更深成
 *      主箱阴影）；③「+」var(--text-dim)→var(--text)。
 *    - dev.54：①「+」加粗 font-weight:700；② 模型选择框左移 5px
 *      （.input-tools-left margin-left:-5px）；③ 删除顶栏模型+思考选择框。
 *    ⚠️ dev.55/56 曾尝试「发送移到工具条最右（absolute）+ tools-left 强制 flex
 *    + background-image 绘制 +」——叠加后工具条在运行时消失（复现：注入规则未
 *    生效时 .input-tools 回落官方宽屏 display:none）。已回退到 dev.54 基线
 *    （发送回主箱右下、撤销 absolute 定位），恢复工具条可见。
 *    - dev.57：在 dev.54 布局基础上安全重做三项（发送留主箱、无 absolute）——
 *      ① 发送/停止 38→33（各-5px）；② 「+」用 background-image SVG data-URI
 *      绘制（亮 #111827 黑 / 暗 #f3f4f6 白，弃用被官方归零的 ::before）；
 *      ③ .input-tools-left 强制 display:flex + gap:5px（模型↔思考 5px）。
 *    - dev.58：① 发送/停止移入工具条最右——.input-tools 设 position:relative，
 *      .input-tools-right .inputbox-actions 用 absolute right:10px 垂直居中
 *      （dev.55/56 曾因此类写法联动出问题，但根因实为注入字符串未转义，已由
 *      JSON.stringify 根治——本条纯 CSS 布局，可行）；主箱 inputbox-actions 隐藏；
 *      ② 发送/停止 33→28（再各-5px）；③ 模型↔思考 gap 5→10px。
 *    - dev.59：① 去工具条模型/思考 chips 边框；② 去主箱 textarea 聚焦时的大框
 *      紫色环绕（.inputbox:focus-within 不再画 accent 光环、主箱边框保持常规色）；
 *      ③ 「+」后注入上下文用量圆环（读 statusbar 的 .status-ctx：ctx-bar-fill 宽度%
 *      着色 + 颜色级别 + token 文字；不显示费用）。
 *    - dev.60：隐藏整条信息栏（statusbar，display:none——不再保留「已连接/费用/
 *      消息数/插件状态」等）；项目路径移入工具条下方（注入 .__ubCwdRow，转发点击
 *      原 button.status-cwd 弹原生目录选择器，路径文本从原按钮读取——其本身已含
 *      📁 图标，不再额外加图标）。
 *    - 两种布局都靠官方 DOM 中「行内含一套 attach+actions、.input-tools-right
 *      另有一套」用高优先级规则反转可见性实现，零 DOM 移动，规避 React
 *      受控节点搬移风险。
 */
import { createLogger } from '@urchin/logger';
import { buildLeftPanelScript } from './left-panel';
import { buildLayoutScript } from './layout';

const log = createLogger('pi-web-enhance');

/** 注入脚本幂等标志 */
const INSTALLED_FLAG = '__ubPageEnhanceInstalled';

/** 本模块 sessionStorage 键：会话内已隐藏的最近项目路径 */
const HIDDEN_KEY = '__ubHiddenProjects';

/** 主题轮询间隔（ms）：兜底轮询——主进程直推（pushPiTheme）为即时通道 */
const THEME_POLL_MS = 2000;

/**
 * 构建主题跟随浏览器脚本（纯字符串，可单测）。
 *
 * dev.49 重构（根治 dev.48「切主题卡住」）：
 * - 暴露 window.__ubApplyTheme(t) 供主进程直推调用——**同步、幂等、DOM 权威**：
 *   每次调用都按 t 强制对齐 #theme-stylesheet（存在性 + href），无任何
 *   localStorage 前置守卫（dev.48 的守卫会在 React 重挂载改写存储后永久早退）。
 * - 存储跟随官方语义：亮 setItem 'light'、暗 removeItem（pi-web-ui 的
 *   Yt()/da() 同义），保证 React 挂载/重挂载读到的状态与 DOM 一致。
 * - 派发官方 theme-change 事件（零监听者、零副作用，保留未来兼容面）。
 * - 2s 轮询 urchin://pi-theme + visibilitychange 兜底（页面加载即对齐、
 *   推送竞态自愈）。
 */
export function buildThemeFollowScript(): string {
  return (
    '(function(){' +
    'function applyTheme(t){' +
    "var link=document.getElementById('theme-stylesheet');" +
    "if(t==='light'){" +
    'if(!link){link=document.createElement("link");link.id="theme-stylesheet";' +
    'link.rel="stylesheet";document.head.appendChild(link);}' +
    'if(!/light/.test(link.href||""))link.href="/themes/light.css";' +
    '}else if(link){link.remove();}' +
    'try{' +
    "if(t==='light'){localStorage.setItem('pi-web-ui:theme','light');}" +
    "else{localStorage.removeItem('pi-web-ui:theme');}" +
    '}catch(e){}' +
    "document.dispatchEvent(new CustomEvent('pi-web-ui:theme-change',{detail:t}));" +
    '}' +
    'window.__ubApplyTheme=applyTheme;' +
    'function sync(){' +
    "fetch('urchin://pi-theme',{mode:'cors'})" +
    '.then(function(r){return r.json();})' +
    ".then(function(d){applyTheme(d&&d.dark?'dark':'light');})" +
    '.catch(function(){});' +
    '}' +
    'sync();' +
    `setInterval(sync,${THEME_POLL_MS});` +
    "document.addEventListener('visibilitychange',function(){if(!document.hidden)sync();});" +
    '})();'
  );
}

/** pi 标签查询接口（pushPiTheme 依赖的最小面，真实 TabManager 结构兼容） */
export interface PiThemeTabManagerLike {
  query(_: unknown): readonly { id: number; url: string }[];
  getTab(id: number): { webContents: unknown } | undefined;
}

/**
 * 构建主题直推调用脚本（纯函数，可单测）。
 * 注入脚本已暴露 window.__ubApplyTheme；未安装（非 pi 页/注入失败）时静默跳过。
 */
export function buildThemePushCall(dark: boolean): string {
  return `if (typeof window.__ubApplyTheme === 'function') { window.__ubApplyTheme('${dark ? 'dark' : 'light'}'); }`;
}

/**
 * 向所有 pi 标签即时推送浏览器主题（dev.49）。
 *
 * 浏览器切主题（ui.theme.set 处理内）调用：遍历标签，URL 命中 pi 服务地址
 * （isPiUrl 由调用方用 launcher 实时 URL 判定）的即 executeJavaScript 直推，
 * 消除 dev.48 纯轮询的 ≤2s 滞后与 fetch 偶发失败导致的「pi 主题卡住」。
 * 失败静默——页面导航/销毁中忽略，2s 兜底轮询自愈。
 *
 * @param tabManager 标签管理（结构兼容 TabManager）
 * @param isPiUrl URL 是否 pi 页判定（外部注入，读 launcher 实时地址）
 * @param dark 目标是否暗色
 */
export function pushPiTheme(
  tabManager: PiThemeTabManagerLike,
  isPiUrl: (url: string) => boolean,
  dark: boolean,
): void {
  const call = buildThemePushCall(dark);
  for (const snapshot of tabManager.query({})) {
    if (!isPiUrl(snapshot.url)) continue;
    const tab = tabManager.getTab(snapshot.id);
    const wc = tab?.webContents as Electron.WebContents | undefined;
    if (!wc || typeof wc.executeJavaScript !== 'function') continue;
    try {
      void wc.executeJavaScript(call, true).catch(() => {
        /* 页面导航/卸载中注入失败：2s 兜底轮询自愈 */
      });
    } catch {
      /* 忽略 */
    }
  }
}

/**
 * 构建面板增强脚本（新对话移植 + 删除按钮/确认 + 提示抑制 + 更新组件隐藏，
 * 纯字符串可单测）。
 */
export function buildProjectsPanelScript(): string {
  // 注入样式（单一 textContent 字符串）：必须用 JSON.stringify 转义嵌入——
  // 否则 CSS 内的双引号（如 url("data:image/svg+xml,...")）会在生成的
  // st.textContent = "..." 字面量里提前终止字符串，导致整个注入脚本
  // SyntaxError（实测浏览器报 Uncaught SyntaxError: Unexpected identifier 'data'，
  // 面板+主题脚本全部失效，.input-tools 回落到官方 display:none ——即「工具条删了」）。
  const styleCss =
    '.project-item{position:relative!important}' +
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
    '.dd-update>*:not(:first-child){display:none!important}' +
    '.update-dot{display:none!important}' +
    // 输入框重构（dev.51/52/53/54 基线 + dev.57 三项微调）：主箱+工具条一体大框、
    // 发送回主箱右下（-5px=33）、+ 用 background-image（黑/白随主题）、模型↔思考 5px
    '.inputbar .inputbox{background:transparent;border:none;box-shadow:none;padding:0;gap:0;overflow:visible}' +
    '.inputbar .inputbox:focus-within{border:none;box-shadow:0 0 0 3px var(--accent-soft)}' +
    '.inputbar .inputbox-row{flex-wrap:wrap;align-items:center;background:var(--bg-elev);' +
    'border:1px solid var(--border);border-radius:22px 22px 0 0;padding:4px 10px 8px;' +
    'transition:border-color .2s ease,box-shadow .2s ease;overflow:visible}' +
    '.inputbar .inputbox-row:focus-within{border-color:color-mix(in srgb,var(--accent) 55%,var(--border))}' +
    '.inputbar .inputbox-row textarea{flex:1 1 100%;padding:10px 6px 2px}' +
    '.inputbar .inputbox-row .attach-img{display:none!important}' +
    '.inputbar .inputbox-row .inputbox-actions{display:none!important}' +
    '.inputbar .inputbox .btn.send,.inputbar .inputbox .btn.stop{background:var(--text);' +
    'border-color:var(--text);color:var(--bg);width:28px;height:28px;border-radius:10px;box-shadow:none}' +
    '.inputbar .inputbox .btn.send:hover:not(:disabled),.inputbar .inputbox .btn.stop:hover:not(:disabled)' +
    '{background:var(--text);border-color:var(--text);opacity:.88;transform:none;box-shadow:none}' +
    '.inputbar .input-tools{position:relative!important;display:flex!important;justify-content:flex-start;align-items:center;gap:16px;' +
    'background:var(--bg);border:1px solid var(--border);border-radius:0 0 22px 22px;' +
    'padding:6px 10px;margin-top:-1px;overflow:visible}' +
    '.inputbar .input-tools-left{display:flex!important;align-items:center;gap:10px;margin-left:-5px}' +
    '.inputbar .input-tools-right{display:flex!important;align-items:center;order:-1}' +
    // 发送/停止副本：absolute 拉到工具条最右（垂直居中），脱离 + 与 chips 布局
    '.inputbar .input-tools-right .inputbox-actions{display:flex!important;position:absolute;' +
    'right:10px;top:50%;transform:translateY(-50%);z-index:5}' +
    '.inputbar .input-tools-right .btn.attach-img{display:inline-flex!important;border:none;' +
    'background-color:transparent;background-repeat:no-repeat;background-position:center;' +
    'background-size:18px 18px;width:27px;height:27px;padding:0;flex-shrink:0;opacity:1!important;' +
    "background-image:url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none'%3E%3Cpath d='M12 5v14M5 12h14' stroke='%23111827' stroke-width='2.4' stroke-linecap='round'/%3E%3C/svg%3E\")}" +
    '.inputbar .input-tools-right .btn.attach-img:disabled{opacity:1!important}' +
    '.inputbar .input-tools-right .btn.attach-img svg{display:none!important}' +
    '.inputbar .input-tools-right .btn.attach-img:hover{background-color:var(--accent-soft);border-radius:6px}' +
    '@media (prefers-color-scheme: dark){.inputbar .input-tools-right .btn.attach-img{' +
    "background-image:url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none'%3E%3Cpath d='M12 5v14M5 12h14' stroke='%23f3f4f6' stroke-width='2.4' stroke-linecap='round'/%3E%3C/svg%3E\")!important}}" +
    '.inputbar .input-tools .dropdown{position:relative}' +
    '.inputbar .input-tools .dropdown .dd-menu{position:absolute!important;' +
    'top:auto!important;bottom:calc(100% + 6px)!important;right:0!important;left:auto!important;' +
    'max-height:min(360px,50vh);z-index:80}' +
    '.inputbar .input-tools .dropdown.left .dd-menu{left:0!important;right:auto!important}' +
    // dev.59：① 去工具条模型/思考 chips 边框；② 去主箱 focus 环绕紫色；
    //          ③ 新增上下文用量圆环（随 statusbar 数据着色）。
    // dev.60：隐藏整条信息栏（statusbar）；新增 .__ubCwdRow——项目路径移入工具条
    //          下方（点击转发原 button.status-cwd 弹原生目录选择器）。
    '.inputbar .input-tools .chip{border:none;background:var(--bg)}' +
    '.inputbar .inputbox-row:focus-within{border-color:var(--border)}' +
    '.inputbar .inputbox:focus-within{border:none;box-shadow:none}' +
    '.__ubCtxRing{width:20px;height:20px;border-radius:50%;margin-left:8px;flex-shrink:0;align-self:center;' +
    'position:relative;display:inline-flex;align-items:center;justify-content:center;' +
    '-webkit-mask:radial-gradient(farthest-side,transparent calc(100% - 4px),#000 calc(100% - 3px));' +
    'mask:radial-gradient(farthest-side,transparent calc(100% - 4px),#000 calc(100% - 3px))}' +
    '.statusbar{display:none!important}' +
    '.__ubCwdRow{display:flex;align-items:center;gap:6px;max-width:860px;margin:6px auto 0;' +
    'font-size:12.5px;color:var(--text-dim);cursor:pointer;padding:2px 12px;user-select:none}' +
    '.__ubCwdRow:hover{color:var(--accent)}';

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
    // 注入一次样式：JSON.stringify 转义，避免 CSS 内双引号破坏 st.textContent 字面量
    'if (!document.getElementById("__ubProjStyle")) {' +
    'var st = document.createElement("style"); st.id = "__ubProjStyle";' +
    'st.textContent = ' +
    JSON.stringify(styleCss) +
    ';' +
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
    // ── dev.49：删除主题切换按钮（主题完全跟随浏览器，不提供手选）──
    // 顶栏触发器：chip-sub 文本「主题/theme」所在的 .dropdown 整体移除
    //（图标 + 文字 + 菜单一并消失）；React 重渲染重建时由 MutationObserver
    // 调度的 enhance() 重复删除（与 dev.45 删除按钮同一生命周期）。
    'var chips = document.querySelectorAll("span.chip-sub");' +
    'for (var ci = 0; ci < chips.length; ci++) {' +
    'var txt = (chips[ci].textContent || "").trim();' +
    'if (/^(\\u4e3b\\u9898|theme)$/i.test(txt)) {' +
    'var dd = chips[ci].closest(".dropdown");' +
    'if (dd) { dd.remove(); }' +
    'else { var tbtn = chips[ci].closest("button"); if (tbtn) tbtn.remove(); }' +
    '}' +
    '}' +
    // 「更多」菜单（topbar-more）内的主题段：dd-header「主题/theme」及其后
    // dd-item 一并删除，直至遇到下一个 dd-header（其他段不动）
    'var menus = document.querySelectorAll(".dd-menu");' +
    'for (var mi = 0; mi < menus.length; mi++) {' +
    'var kids = Array.prototype.slice.call(menus[mi].children);' +
    'var removing = false;' +
    'for (var ki = 0; ki < kids.length; ki++) {' +
    'var el = kids[ki];' +
    'var isHeader = el.classList && el.classList.contains("dd-header");' +
    'if (isHeader && /^(\\u4e3b\\u9898|theme)$/i.test((el.textContent || "").trim())) {' +
    'el.remove();' +
    'removing = true;' +
    'continue;' +
    '}' +
    'if (removing) {' +
    'if (isHeader) { removing = false; } else { el.remove(); }' +
    '}' +
    '}' +
    '}' +
    // ── dev.54：删除顶栏（网页标题栏）的模型选择框 + 思考选择框──
    // 顶栏 Wt 组件渲染两只相邻 .dropdown（模型=含 span.chip-model，思考=紧随其后）。
    // 模型/思考在工具条（.input-tools-left）内仍有，顶栏属重复入口，整体移除；
    // React 重渲染重建由 MutationObserver 调度的 enhance() 重复删除。
    'var topDesk = document.querySelector(".topbar-desktop");' +
    'if (topDesk) {' +
    'var tds = Array.prototype.slice.call(topDesk.querySelectorAll(".dropdown"));' +
    'for (var ti = 0; ti < tds.length; ti++) {' +
    'if (tds[ti].querySelector("span.chip-model")) {' +
    'tds[ti].remove();' +
    'var next = tds[ti + 1];' +
    'if (next && next.classList && next.classList.contains("dropdown")) next.remove();' +
    'break;' +
    '}' +
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
    // 移除「已切换到/已在工作目录」提示（其他 notice 不动）。
    // dev.64：0.29.x 官方 toast 为 .notice（.notices 容器 fixed 居中即「中区弹窗」），
    // 转发点击 .notice-close 走官方 dismiss_notice 通道（React 状态一致，重渲染不复活）；
    // .fp-notice 为 dev.45 旧选择器（0.29.1 中属「预览截断」提示），保留 remove() 兜底。
    'function suppressCwdNotices(){' +
    'var notes = document.querySelectorAll(".fp-notice, .notice");' +
    'for (var i = 0; i < notes.length; i++) {' +
    'var n = notes[i];' +
    'var t = n.textContent || "";' +
    'if (/\\u5df2\\u5207\\u6362\\u5230\\u5de5\\u4f5c\\u76ee\\u5f55|\\u5df2\\u5728\\u5de5\\u4f5c\\u76ee\\u5f55/.test(t)) {' +
    'var close = n.querySelector(".notice-close");' +
    'if (close) close.click(); else n.remove();' +
    '}' +
    '}' +
    '}' +
    // dev.59：上下文用量圆环——在「+」后注入一只圆环，读取信息栏 statusbar 的
    // .status-ctx（圆环自身的隐藏由 CSS 完成，此处仅读其 .ctx-bar-fill 宽度%与
    // 颜色级别 + token 文字）实时着色；React 重渲染重建由定时器兜底补插。
    'function ensureCtxRing(){' +
    'var plus=document.querySelector(".inputbar .input-tools-right .btn.attach-img");' +
    'if(!plus)return;' +
    'var ring=document.querySelector(".inputbar .input-tools-right .__ubCtxRing");' +
    'if(!ring){ring=document.createElement("span");ring.className="__ubCtxRing";' +
    'plus.insertAdjacentElement("afterend",ring);}' +
    '}' +
    'function updateCtxRing(){' +
    'var ring=document.querySelector(".inputbar .input-tools-right .__ubCtxRing");' +
    'if(!ring){ensureCtxRing();ring=document.querySelector(".inputbar .input-tools-right .__ubCtxRing");}' +
    'if(!ring)return;' +
    'var ctx=document.querySelector(".statusbar .status-item.status-ctx");' +
    'if(!ctx)return;' +
    'var fill=ctx.querySelector(".ctx-bar-fill");var pct=0;' +
    'if(fill&&fill.style.width)pct=parseFloat(fill.style.width)||0;' +
    'var bar=ctx.querySelector(".ctx-bar");var col="#22c55e";' +
    'if(bar){if(bar.classList.contains("warn"))col="#ef4444";else if(bar.classList.contains("mid"))col="#f59e0b";}' +
    'var track="rgba(128,128,128,.25)";' +
    'ring.style.background=pct>0?("conic-gradient("+col+" "+pct+"%, "+track+" 0)"):track;' +
    'var txt=(ctx.textContent||"").replace(/\\u4e0a\\u4e0b\\u6587|Context/g,"").trim();' +
    'ring.title=txt?("\\u4e0a\\u4e0b\\u6587 "+pct+"% · "+txt):("\\u4e0a\\u4e0b\\u6587 "+pct+"%");' +
    '}' +
    // dev.60：项目路径移入工具条下方——注入 .__ubCwdRow（显示路径+转发点击原 button.status-cwd）
    'function ensureCwdRow(){' +
    'var bar=document.querySelector(".inputbar");if(!bar)return;' +
    'if(bar.querySelector(".__ubCwdRow"))return;' +
    'var row=document.createElement("div");row.className="__ubCwdRow";' +
    'row.title="\\u70b9\\u51fb\\u9009\\u62e9\\u9879\\u76ee\\u76ee\\u5f55";' +
    // 路径文本本身已含 📁 图标（源 button.status-cwd 自带），不再额外加图标
    'var path=document.createElement("span");path.className="__ubCwdPath";' +
    'row.appendChild(path);' +
    'row.addEventListener("click",function(ev){' +
    'ev.preventDefault();ev.stopPropagation();' +
    'var orig=document.querySelector("button.status-cwd");' +
    'if(orig)orig.click();' +
    '});' +
    'var box=bar.querySelector(".inputbox");' +
    'if(box)box.insertAdjacentElement("afterend",row);else bar.appendChild(row);' +
    '}' +
    'function updateCwdRow(){' +
    'var row=document.querySelector(".inputbar .__ubCwdRow");' +
    'if(!row){ensureCwdRow();row=document.querySelector(".inputbar .__ubCwdRow");}' +
    'if(!row)return;' +
    'var src=document.querySelector("button.status-cwd");' +
    'var txt=src?(src.textContent||"").trim():"";' +
    'var el=row.querySelector(".__ubCwdPath");' +
    'if(el)el.textContent=txt||"(\\u9009\\u62e9\\u9879\\u76ee\\u76ee\\u5f55)";' +
    '}' +
    'setInterval(function(){ensureCtxRing();updateCtxRing();ensureCwdRow();updateCwdRow();},1500);' +
    'var timer = null;' +
    'function schedule(){' +
    'if (timer) return;' +
    'timer = setTimeout(function(){ timer = null; enhance(); suppressCwdNotices(); }, 80);' +
    '}' +
    'new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true });' +
    'enhance(); suppressCwdNotices(); ensureCtxRing(); updateCtxRing(); ensureCwdRow(); updateCwdRow();' +
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
  // dev.65：左区重构脚本追加在末尾（自带幂等标志与样式，独立于面板增强）；
  // dev.67：布局控制（layout）先于左区面板（leftPanel）注入——后者消费前者
  // 暴露的 window.__ubPiUI（项目排序 po 与持久化通道）
  const script =
    buildThemeFollowScript() +
    buildLayoutScript() +
    buildProjectsPanelScript() +
    buildLeftPanelScript();

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
