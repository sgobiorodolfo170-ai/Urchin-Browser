/**
 * pi 网页版 · 页面体验增强注入（dev.45 建立，dev.48 主题跟随，dev.49 直推+删按钮）
 *
 * 用户需求（均不动第三方包源码，注入脚本按 DOM 守卫仅 pi 页生效）：
 * 1. 主题完全跟随浏览器（dev.49 根治「切主题时 pi 卡住/不跟随」）：
 *    - **主进程直推**：浏览器切主题（ui.theme.set）后立刻向所有 pi 标签
 *      executeJavaScript 调注入脚本暴露的 `window.__ubApplyTheme`，不再
 *      依赖 2s 轮询滞后（轮询降级为兜底，覆盖页面加载/推送竞态）。
 *    - **同步幂等应用**：applyTheme 直接同步增删 #theme-stylesheet
 *      （亮=官方浅色主题 white.css，暗=移除回内置默认），去掉 dev.48 的
 *      300ms 延迟双步——那次双步与 localStorage 前置守卫组合会在 React 重挂载
 *      改写存储后永久早退，造成 DOM 主题与浏览器脱节（「阻塞」根因）。
 *    - **官方存储语义**：亮写 key='white'（0.90.0 起主题=主题名，light.css
 *      已移除）、暗移除 key（与 pi-web-ui 主题引擎一致），React 挂载时读到
 *      的状态与 DOM 恒一致，不打架。
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
 * 4. 最近项目删除按钮（dev.45/47）：**dev.86 决策退役**——注入式 ✕ + 会话内
 *    隐藏列表整体移除，删除入口迁至我方左区面板（left-panel.ts），走官方
 *    `remove_project`（持久 tombstone），并保留 `__ubProjDelConfirm` 自动化钩子语义。
 * 5. 抑制中区路径提示（dev.45，dev.64 修正选择器）：左区切换项目时服务端发
 *    notice「已切换到/已在工作目录」，0.29.x 渲染为 fixed 居中 toast（.notice，
 *    .notices 容器）——dev.45 瞄准的 .fp-notice 在 0.29.1 实为「预览截断」提示
 *    未命中；现对匹配文本的 .notice 转发点击 .notice-close 走官方 dismiss_notice
 *    通道（React 状态一致，重渲染不复活），.fp-notice 移除保留兜底；错误级提示
 *    （切换工作目录失败）不匹配文本，不受影响。
 * 5.5 设置弹窗去重（dev.69）：**dev.86 决策清理已退役**——0.90.0 上游设置页
 *    重组后已无「技能/插件」tab（改名/并入界面插件等），去重逻辑成为惰性
 *    代码；技能/插件状态仍走 settings_state / set_settings 同源接口。
 * 6. 版本/更新入口移除 + 关于页（dev.89，用户指令）：
 *    - 顶栏「打开项目」按钮删除（与输入框下方 cwd 行功能重复）；
 *    - 顶栏 GitHub 连接删除（顶栏 + 「更多」菜单两处）；
 *    - 版本/更新入口整只移除（旧 dev.47 仅留版本行的 CSS 退役），版本号移入
 *      设置导航最底部新增的「关于」项——点击弹出只读关于弹窗（前端版本 +
 *      内置 pi SDK 版本），不提供应用内自动更新。
 *    - dev.104（用户指令）：右区右上角官方折叠按钮删除（与中区右上角自绘
 *      #__ubRTCollapse 功能重复；右区折叠统一由中区按钮负责）。
 * 6.5 「未检测到 pi agent 配置」弹窗取消（dev.87，用户指令）：官方 PiSetupModal
 *    纯 CSS 隐藏（.modal-backdrop:has(>.modal.setup-modal)），不阻塞交互、
 *    不与 React 状态对抗，兼除「自动安装 pi agent」入口（containment 面）。
 * 7. 左区重构（dev.65，详见 left-panel.ts）：上区改「项目配置」（仅技能/插件启停，
 *    与官方设置「技能」「插件」页同源对齐；dev.89 移除命令/预设/配置文件三组），
 *    下区改「项目」管理（项目行切换 + 行内「＋」新建对话 +
 *    当前项目下挂运行对话与历史会话）。自有面板经同 clientId 第二条 WebSocket 收发
 *    官方协议；未就绪前官方面板保持可见（:has() 降级）。
 * 8. 中区布局控制（dev.67，详见 layout.ts + ui-state.ts）：中区左右上角折叠
 *    按钮 + 分割线拖拽调宽，状态经 urchin://pi-ui-state 主进程落盘跨会话保留；
 *    左区项目按持久化顺序排列（首见追加，会话触发不影响）+ 行拖拽排序；
 *    toast/[data-tip] 层叠修复（右区标题行不再遮挡提示）。
 * 9. 对话输入框重构（dev.51 → dev.54 基线，用户参考 ChatGPT 风格截图）：
 *    【dev.71 起 0.47.0 上游原生实现了同款设计（.inputbox 直含 textarea +
 *    .composer-tools，模型/思考下拉移入工具条左、发送在右、下拉原生向上弹），
 *    dev.51-58 的结构性 hack 全部退役，仅保留视觉定制：发送/停止主题反色、
 *    「+」background-image 绘制、上下文圆环、信息栏隐藏 + 项目路径行——
 *    选择器按新类名映射 input-tools* → composer-tools*。下列历史细节仅存档】
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

/** 主题轮询间隔（ms）：兜底轮询——主进程直推（pushPiTheme）为即时通道 */
const THEME_POLL_MS = 2000;

/**
 * 构建「Web 形态」脚本（dev.86，A1 决策）。
 *
 * 背景：上游桌面判定 `isDesktop = window.piDesktop?.isDesktop===true || UA 含 'Electron/'`。
 * Urchin 本身是 Electron，pi 页 UA 必然命中 →「浏览器操作」（page-picker 桥）与
 * `host.pageCall` 被官方逻辑按「桌面壳不支持」禁用，更新面板也走桌面分支。
 *
 * 处置：把 pi 页的 navigator.userAgent 覆盖为去掉 Electron 标记的 UA，让上游按
 * Web 形态运行（与本项目部署形态一致：pi-web-ui 是 Urchin 内的 Web 服务，而非
 * 官方 Electron 壳）。幂等（重复注入只覆盖一次）；失败静默（最坏退回旧行为）。
 */
export function buildWebFormScript(): string {
  return (
    '(function(){' +
    "try{var ua=navigator.userAgent||'';" +
    'var clean=ua.replace(/\\s*Electron\\/[^\\s]+/,"");' +
    'if(clean!==ua){Object.defineProperty(navigator,"userAgent",{get:function(){return clean;},configurable:true});}' +
    '}catch(e){}' +
    '})();'
  );
}

/**
 * 构建主题跟随浏览器脚本（纯字符串，可单测）。
 *
 * dev.49 重构（根治 dev.48「切主题卡住」）；dev.84 适配 pi-web-ui 0.90.0
 * 主题引擎重构（主题=主题名，样式表 /themes/<name>.css；旧 light.css 已移除，
 * 亮色统一映射官方浅色主题 white.css——applyTheme 对外仍收 'light'/'dark'）：
 * - 暴露 window.__ubApplyTheme(t) 供主进程直推调用——**同步、幂等、DOM 权威**：
 *   每次调用都按 t 强制对齐 #theme-stylesheet（存在性 + href），无任何
 *   localStorage 前置守卫（dev.48 的守卫会在 React 重挂载改写存储后永久早退）。
 * - 存储跟随官方语义：亮 setItem 'white'（官方浅色主题名）、暗 removeItem
 *   （0.90.0 引擎默认 dark=键缺失），保证 React 挂载/重挂载读到的状态与 DOM 一致。
 * - 派发官方 theme-change 事件（零监听者、零副作用，保留未来兼容面）。
 * - 2s 轮询 urchin://pi-theme + visibilitychange 兜底（页面加载即对齐、
 *   推送竞态自愈）。
 */
export function buildThemeFollowScript(): string {
  return (
    '(function(){' +
    'function applyTheme(t){' +
    "var name=t==='light'?'white':null;" +
    "var link=document.getElementById('theme-stylesheet');" +
    'if(name){' +
    'if(!link){link=document.createElement("link");link.id="theme-stylesheet";' +
    'link.rel="stylesheet";document.head.appendChild(link);}' +
    'if(!/white\\.css/.test(link.href||""))link.href="/themes/"+name+".css";' +
    '}else if(link){link.remove();}' +
    'try{' +
    "if(name){localStorage.setItem('pi-web-ui:theme',name);}" +
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
    'button.chip.newchat{display:none!important}' +
    '.panel-sessions>.panel-section-title{display:flex!important;align-items:center}' +
    '.__ubNewChat{margin-left:auto;display:inline-flex;align-items:center;justify-content:center;' +
    'width:18px;height:18px;border:none;border-radius:4px;background:transparent;' +
    'cursor:pointer;color:inherit;font-size:15px;line-height:1;opacity:.65}' +
    '.__ubNewChat:hover{opacity:1;background:rgba(128,128,128,.12)}' +
    // dev.89：版本/更新入口整只移除（版本号移入「设置-关于」，不提供自动更新），
    // 旧的 dev.47「仅留版本行」CSS 一并退役。
    // 关于弹窗（自绘，风格对齐官方 .modal）
    '.__ubAboutBackdrop{position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:130;display:flex;align-items:center;justify-content:center}' +
    '.__ubAboutModal{width:min(420px,90vw);background:var(--bg-elev);border:1px solid var(--border);border-radius:12px;padding:18px 20px;color:var(--text);box-shadow:0 18px 60px rgba(0,0,0,.4)}' +
    '.__ubAboutTitle{font-size:15px;font-weight:700;margin:0 0 12px}' +
    '.__ubAboutRow{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:7px 0;border-bottom:1px solid var(--border-soft);font-size:12.5px;color:var(--text-dim)}' +
    '.__ubAboutRow b{color:var(--text);font-weight:600}' +
    '.__ubAboutNote{margin:12px 0 0;font-size:11.5px;line-height:1.6;color:var(--text-faint)}' +
    '.__ubAboutClose{margin-top:14px;width:100%;padding:7px 0;border-radius:8px;border:1px solid var(--border);background:transparent;color:var(--text);font-size:12.5px;cursor:pointer}' +
    '.__ubAboutClose:hover{background:var(--accent-soft)}' +
    // 输入框区（dev.71 适配 0.47.0）：上游原生实现了 ChatGPT 式单框设计
    //（.inputbox 直含 textarea + .composer-tools，模型/思考下拉在工具条左、
    // 发送在右，下拉原生向上弹）——dev.51-58 的结构性 hack 全部退役，仅保留
    // 用户逐轮迭代的视觉定制：① 发送/停止主题反色 28px 方块；②「+」
    // background-image 绘制（亮黑/暗白）；③ 上下文用量圆环；④ 信息栏隐藏 +
    // 项目路径行。选择器按新类名映射（input-tools* → composer-tools*）。
    '.inputbar .btn.send,.inputbar .btn.stop{background:var(--text);' +
    'border-color:var(--text);color:var(--bg);width:28px;height:28px;border-radius:10px;box-shadow:none}' +
    '.inputbar .btn.send:hover:not(:disabled),.inputbar .btn.stop:hover:not(:disabled)' +
    '{background:var(--text);border-color:var(--text);opacity:.88;transform:none;box-shadow:none}' +
    // dev.86 输入框规则审计（决策「可移除已覆盖规则」）：官方 0.90 CSS 已覆盖
    // `.inputbox .btn.attach-img{border:none}`——本条移除；其余规则（反色发送/
    // 「+」绘制/圆环/信息栏隐藏/cwd 行）仍为独有定制，保留；官方 composer-resize
    // 拖高未被本文件触碰（E2E 断言在位）。
    '.inputbar .composer-tools-left .btn.attach-img{' +
    'background-color:transparent;background-repeat:no-repeat;background-position:center;' +
    'background-size:18px 18px;width:27px;height:27px;padding:0;flex-shrink:0;opacity:1!important;' +
    "background-image:url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none'%3E%3Cpath d='M12 5v14M5 12h14' stroke='%23111827' stroke-width='2.4' stroke-linecap='round'/%3E%3C/svg%3E\")}" +
    '.inputbar .composer-tools-left .btn.attach-img:disabled{opacity:1!important}' +
    '.inputbar .composer-tools-left .btn.attach-img svg{display:none!important}' +
    '.inputbar .composer-tools-left .btn.attach-img:hover{background-color:var(--accent-soft);border-radius:6px}' +
    '@media (prefers-color-scheme: dark){.inputbar .composer-tools-left .btn.attach-img{' +
    "background-image:url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none'%3E%3Cpath d='M12 5v14M5 12h14' stroke='%23f3f4f6' stroke-width='2.4' stroke-linecap='round'/%3E%3C/svg%3E\")!important}}" +
    // dev.59：上下文用量圆环（随 statusbar 数据着色）。
    // dev.60：隐藏整条信息栏（statusbar）；新增 .__ubCwdRow——项目路径移入
    //          输入框下方（点击转发原 button.status-cwd 弹原生目录选择器）。
    '.__ubCtxRing{width:20px;height:20px;border-radius:50%;margin-left:8px;flex-shrink:0;align-self:center;' +
    'position:relative;display:inline-flex;align-items:center;justify-content:center;' +
    '-webkit-mask:radial-gradient(farthest-side,transparent calc(100% - 4px),#000 calc(100% - 3px));' +
    'mask:radial-gradient(farthest-side,transparent calc(100% - 4px),#000 calc(100% - 3px))}' +
    '.statusbar{display:none!important}' +
    '.__ubCwdRow{display:flex;align-items:center;gap:6px;max-width:860px;margin:6px auto 0;' +
    'font-size:12.5px;color:var(--text-dim);cursor:pointer;padding:2px 12px;user-select:none}' +
    '.__ubCwdRow:hover{color:var(--accent)}' +
    // dev.87（用户指令）：取消「未检测到 pi agent 配置」弹窗（官方 PiSetupModal，
    // setupTitle）。0.90 起 piConfigured=模型运行时是否有可用模型（不再看 auth.json，
    // dev.43 占位对旧引导有效、对本弹窗无效）；该弹窗还含「自动安装 pi agent」
    // （npm i -g，containment 忌惮面）。纯 CSS 隐藏（不阻塞、不与 React 状态对抗；
    // React 重渲染/重开也持续生效）。
    '.modal-backdrop:has(>.modal.setup-modal){display:none!important}';

  return (
    '(function(){' +
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
    // 调度的 enhance() 重复删除。
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
    // ── dev.89（用户指令）：顶栏清理 + 设置底部「关于」──
    // 1) 打开项目：与输入框下方 cwd 行（原生目录选择）功能重复 → 删除顶栏按钮
    'var opBtn = document.querySelector("button.chip.open-project");' +
    'if (opBtn) opBtn.remove();' +
    // 2) GitHub 连接：删除（顶栏与「更多」菜单两处，均为 a.chip.github）
    'var gh = document.querySelectorAll("a.chip.github");' +
    'for (var gi = 0; gi < gh.length; gi++) gh[gi].remove();' +
    // 3) 版本/更新入口：记录版本号后整只移除（版本号移入「设置-关于」；
    //    同时移除更新下拉/红点——不提供应用内自动更新）
    'var vsubs = document.querySelectorAll(".chip-sub");' +
    'for (var vi = 0; vi < vsubs.length; vi++) {' +
    'var vt = (vsubs[vi].textContent || "").trim();' +
    'if (/^v?\\d+\\.\\d+\\.\\d+/.test(vt)) {' +
    'window.__ubPiVersionChip = vt.replace(/^v/i, "");' +
    'var vhost = vsubs[vi].closest(".dropdown") || vsubs[vi].closest("button") || vsubs[vi];' +
    'vhost.remove();' +
    '}' +
    '}' +
    // 4) 设置导航底部「关于」项（点击打开只读关于弹窗；React 重建由 observer 重加）
    'var rail = document.querySelector(".settings-rail");' +
    'if (rail && !rail.querySelector(".__ubAboutTab")) {' +
    'var ab = document.createElement("button");' +
    'ab.type = "button"; ab.className = "settings-tab __ubAboutTab";' +
    'ab.setAttribute("data-tab", "__ub-about"); ab.title = "关于";' +
    'var abi = document.createElement("span"); abi.className = "settings-tab-icon"; abi.textContent = "\\u24d8";' +
    'var abl = document.createElement("span"); abl.className = "settings-tab-label"; abl.textContent = "关于";' +
    'ab.appendChild(abi); ab.appendChild(abl);' +
    'ab.addEventListener("click", function(ev){ ev.preventDefault(); ev.stopPropagation(); openAbout(); });' +
    'rail.appendChild(ab);' +
    '}' +
    // ── dev.104（用户指令）：右区右上角官方折叠按钮删除——与中区右上角
    // 自绘折叠按钮（#__ubRTCollapse）功能重复；React 重建由 observer 重删
    'var rc = document.querySelectorAll(".panel-right .panel-collapse-btn");' +
    'for (var ri = 0; ri < rc.length; ri++) rc[ri].remove();' +
    '}' + // 闭合 enhance()
    // ── dev.45/47 最近项目删除注入：dev.86 决策退役（改用官方 remove_project，
    // 删除入口迁到我方左区面板 left-panel.ts；会话内隐藏列表同步废弃）──
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
    // dev.89：关于弹窗（只读展示版本；版本号来源：左区 WS ready / 移除前顶栏版本 chip）
    'function openAbout(){' +
    'var old = document.getElementById("__ubAbout"); if (old) old.remove();' +
    'var v = window.__ubPiVersions || {};' +
    'var front = v.app || window.__ubPiVersionChip || "\\u2014";' +
    'var core = v.server || "\\u2014";' +
    'var wrap = document.createElement("div"); wrap.id = "__ubAbout"; wrap.className = "__ubAboutBackdrop";' +
    'var box = document.createElement("div"); box.className = "__ubAboutModal";' +
    'var h = document.createElement("h3"); h.className = "__ubAboutTitle"; h.textContent = "关于";' +
    'box.appendChild(h);' +
    'function row(label, value){' +
    'var r = document.createElement("div"); r.className = "__ubAboutRow";' +
    'var l = document.createElement("span"); l.textContent = label;' +
    'var b = document.createElement("b"); b.textContent = value;' +
    'r.appendChild(l); r.appendChild(b); return r;' +
    '}' +
    'box.appendChild(row("pi-web-ui \\u524d\\u7aef", "v" + front));' +
    'box.appendChild(row("pi SDK \\uff08\\u5185\\u7f6e\\u6838\\u5fc3\\uff09", "v" + core));' +
    'var note = document.createElement("p"); note.className = "__ubAboutNote";' +
    'note.textContent = "\\u7248\\u672c\\u968f Urchin Browser \\u4e3b\\u9879\\u76ee\\u53d1\\u5e03\\u4e0e\\u66f4\\u65b0\\uff0c\\u4e0d\\u63d0\\u4f9b\\u5e94\\u7528\\u5185\\u81ea\\u52a8\\u66f4\\u65b0\\u3002";' +
    'box.appendChild(note);' +
    'var btn = document.createElement("button"); btn.type = "button"; btn.className = "__ubAboutClose"; btn.textContent = "\\u5173\\u95ed";' +
    'btn.addEventListener("click", function(){ wrap.remove(); });' +
    'box.appendChild(btn);' +
    'wrap.appendChild(box);' +
    'wrap.addEventListener("click", function(ev){ if (ev.target === wrap) wrap.remove(); });' +
    'document.body.appendChild(wrap);' +
    '}' +
    // dev.59：上下文用量圆环——在「+」后注入一只圆环，读取信息栏 statusbar 的
    // .status-ctx（圆环自身的隐藏由 CSS 完成，此处仅读其 .ctx-bar-fill 宽度%与
    // 颜色级别 + token 文字）实时着色；React 重渲染重建由定时器兜底补插。
    'function ensureCtxRing(){' +
    'var plus=document.querySelector(".inputbar .composer-tools-left .btn.attach-img");' +
    'if(!plus)return;' +
    'var ring=document.querySelector(".inputbar .composer-tools-left .__ubCtxRing");' +
    'if(!ring){ring=document.createElement("span");ring.className="__ubCtxRing";' +
    'plus.insertAdjacentElement("afterend",ring);}' +
    '}' +
    'function updateCtxRing(){' +
    'var ring=document.querySelector(".inputbar .composer-tools-left .__ubCtxRing");' +
    'if(!ring){ensureCtxRing();ring=document.querySelector(".inputbar .composer-tools-left .__ubCtxRing");}' +
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
  // dev.86（A1 决策）：Web 形态脚本最先执行——UA 抹掉 Electron 标记，避免 pi 页
  // 按官方 Electron 壳分支运行（更新面板桌面分支、浏览器操作/pageCall 误禁）。
  // dev.65：左区重构脚本追加在末尾（自带幂等标志与样式，独立于面板增强）；
  // dev.67：布局控制（layout）先于左区面板（leftPanel）注入——后者消费前者
  // 暴露的 window.__ubPiUI（项目排序 po 与持久化通道）
  const script =
    buildWebFormScript() +
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
    // dev.68：dom-ready 先注入（React 挂载前），根治启动时左区闪现官方旧 UI——
    // 脚本同步建骨架并接管面板隐藏；did-finish-load 兜底补注入（幂等标志防叠）
    electronWc.on('dom-ready', inject);
    electronWc.on('did-finish-load', inject);
    disposers.push(() => {
      if (typeof electronWc.removeListener === 'function') {
        electronWc.removeListener('dom-ready', inject);
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
