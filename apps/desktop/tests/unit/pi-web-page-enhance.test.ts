/**
 * pi 页体验增强注入单元测试（dev.45 建立，dev.47/48 更新，dev.49 主题直推+删按钮，
 * dev.51 输入框重构）
 *
 * 验证脚本内容关键要素（字符串断言，行为由 E2E 端到端覆盖）：
 * 1. 主题完全跟随浏览器（dev.49，根治 dev.48 切换阻塞）：暴露 __ubApplyTheme
 *    供主进程直推 + 同步幂等应用样式表（无 300ms 延迟双步）+ 官方存储语义
 *    （亮 setItem / 暗 removeItem）+ 2s 轮询降级兜底——禁止 reload
 * 2. 主题切换按钮删除（dev.49）：顶栏 chip-sub「主题/theme」所在 .dropdown
 *    整体移除 + more 菜单（.dd-menu）内主题段删除（替代 dev.48 隐藏类）
 * 3. 新对话按钮移植（dev.48）：隐藏顶栏原 chip.newchat，历史对话标题行注入
 *    同功能小按钮（右对齐、贴合行高）
 * 4. 最近项目删除注入（dev.45/47）已退役（dev.86）——删除迁至左区面板走官方
 *    remove_project；本文件断言注入不再残留
 * 5. 抑制「已切换到/已在工作目录」路径提示（dev.64：0.29.x 官方 .notice toast
 *    转发点击 .notice-close 走官方 dismiss 通道；.fp-notice 旧选择器保留兜底）
 * 6. 顶栏清理 + 关于（dev.89）：删除「打开项目」/GitHub/版本更新入口，
 *    版本号移入设置导航底部「关于」只读弹窗（不提供自动更新）
 * 7. 对话输入框重构（dev.51/52）：一体大框（主箱+chips 条无缝）、「+」合并至
 *    chips 条最左且换图标、发送/停止主题反色方块、工具条弹窗向上
 */
import { describe, it, expect } from 'vitest';
import {
  buildWebFormScript,
  buildThemeFollowScript,
  buildThemePushCall,
  pushPiTheme,
  buildProjectsPanelScript,
} from '../../src/main/pi-web/page-enhance';

describe('buildWebFormScript', () => {
  it('should strip Electron token from navigator.userAgent (A1 decision, dev.86)', () => {
    const s = buildWebFormScript();
    // 上游 isDesktop = piDesktop?.isDesktop || UA 含 Electron/ —— Urchin 本身是
    // Electron，必须抹掉 UA 标记，否则浏览器操作/pageCall 被官方按桌面壳禁用
    expect(s).toContain('navigator.userAgent');
    expect(s).toContain('Electron');
    expect(s).toContain('Object.defineProperty(navigator,"userAgent"');
    expect(s).toContain('configurable:true');
    // 失败静默：try/catch 包裹，最坏退回旧行为
    expect(s).toContain('catch(e){}');
  });
});

describe('injectable script syntax guards', () => {
  it('should generate syntactically valid injectable scripts (guard)', () => {
    // 教训：拼接注入脚本任何一段语法错误都会被 executeJavaScript 静默 catch，
    // 导致全部注入（面板/主题/左区/布局）失效——编译期守卫逐段解析（仅编译不执行）
    /* eslint-disable @typescript-eslint/no-implied-eval -- 注入脚本编译期守卫（不执行） */
    expect(() => new Function(buildWebFormScript())).not.toThrow();
    expect(() => new Function(buildThemeFollowScript())).not.toThrow();
    expect(() => new Function(buildProjectsPanelScript())).not.toThrow();
    /* eslint-enable @typescript-eslint/no-implied-eval */
  });
});

describe('buildThemeFollowScript', () => {
  it('should expose __ubApplyTheme for main-process push and apply without reload', () => {
    const s = buildThemeFollowScript();
    // dev.49：主进程直推入口 + 兜底轮询 + visibilitychange 即时同步
    expect(s).toContain('window.__ubApplyTheme');
    expect(s).toContain("fetch('urchin://pi-theme'");
    expect(s).toContain('visibilitychange');
    expect(s).toContain('setInterval');
    // dev.84：亮色映射官方浅色主题 white（0.90.0 主题=主题名，light.css 已移除）
    expect(s).toContain("var name=t==='light'?'white':null");
    expect(s).toContain("localStorage.setItem('pi-web-ui:theme',name)");
    expect(s).toContain('link.href="/themes/"+name+".css"');
    // 暗：移除 key（官方 dark 语义=键缺失）+ 移除样式表回内置默认
    expect(s).toContain("localStorage.removeItem('pi-web-ui:theme')");
    expect(s).toContain('link.remove()');
    // 保留官方事件派发（零监听者零副作用，兼容未来官方监听）
    expect(s).toContain('pi-web-ui:theme-change');
    // dev.49：同步幂等应用——无 300ms 延迟双步、无 localStorage 前置守卫
    //（守卫与 React 重挂载改写存储组合会永久早退，即「阻塞」根因）
    expect(s).not.toContain('setTimeout');
    // dev.47 教训：禁止整页 reload（空窗会令目录选择拦截器失效）
    expect(s).not.toContain('location.reload');
  });
});

describe('buildThemePushCall', () => {
  it('should build guarded push call for dark and light', () => {
    expect(buildThemePushCall(true)).toContain("window.__ubApplyTheme('dark')");
    expect(buildThemePushCall(false)).toContain("window.__ubApplyTheme('light')");
    expect(buildThemePushCall(true)).toContain('typeof window.__ubApplyTheme');
  });
});

describe('pushPiTheme', () => {
  it('should push only to pi tabs and ignore non-pi / injection failures', () => {
    const executed: string[] = [];
    const tabManager = {
      query: () => [
        { id: 1, url: 'http://127.0.0.1:45678/' },
        { id: 2, url: 'https://example.com/' },
        { id: 3, url: 'http://127.0.0.1:45678/x' },
      ],
      getTab: (id: number) => ({
        webContents: {
          executeJavaScript: (code: string) => {
            executed.push(code);
            return id === 3 ? Promise.reject(new Error('destroyed')) : Promise.resolve(true);
          },
        },
      }),
    };
    pushPiTheme(tabManager, (url) => url.startsWith('http://127.0.0.1:45678'), true);
    expect(executed).toHaveLength(2);
    expect(executed[0]).toContain("__ubApplyTheme('dark')");
  });

  it('should skip tabs without webContents', () => {
    const tabManager = {
      query: () => [{ id: 1, url: 'http://127.0.0.1:45678/' }],
      getTab: () => undefined,
    };
    expect(() => pushPiTheme(tabManager, () => true, false)).not.toThrow();
  });
});

describe('buildProjectsPanelScript', () => {
  it('should move new-chat button into history title row (dev.48)', () => {
    const s = buildProjectsPanelScript();
    // 隐藏顶栏原按钮 + 标题行注入右对齐小按钮 + 转发触发原按钮
    expect(s).toContain('button.chip.newchat{display:none!important}');
    expect(s).toContain('.panel-sessions>.panel-section-title{display:flex!important');
    expect(s).toContain('__ubNewChat');
    expect(s).toContain('margin-left:auto');
    expect(s).toContain('orig.click()');
  });

  it('should delete the theme switch button instead of hiding it (dev.49)', () => {
    const s = buildProjectsPanelScript();
    // 顶栏触发器：chip-sub「主题/theme」所在的 .dropdown 整体移除（图标+文字+菜单）
    expect(s).toContain('span.chip-sub');
    expect(s).toContain('closest(".dropdown")');
    expect(s).toContain('dd.remove()');
    // more 菜单内主题段：dd-header「主题」+ 其后 dd-item 一并删除
    expect(s).toContain('.dd-menu');
    expect(s).toContain('dd-header');
    // dev.48 的隐藏类方案废弃（隐藏 ≠ 删除，且 closest 只命中 span 本身漏图标）
    expect(s).not.toContain('__ubThemeSelHidden');
  });

  it('should retire injected project delete/hidden-set (dev.86: migrated to left panel + remove_project)', () => {
    const s = buildProjectsPanelScript();
    // dev.86 决策退役：注入式 ✕ / 确认钩子 / sessionStorage 隐藏列表整体移除；
    // 删除入口迁至左区面板（pi-web-left-panel.test.ts 覆盖官方 remove_project）
    expect(s).not.toContain('__ubProjDel');
    expect(s).not.toContain('__ubProjDelConfirm');
    expect(s).not.toContain('__ubHiddenProjects');
    expect(s).not.toContain('button.project-item');
  });

  it('should suppress only cwd-switch notices (dev.64: official .notice toast via close click)', () => {
    const s = buildProjectsPanelScript();
    // dev.64：0.29.x 官方 toast（.notice，.notices 容器 fixed 居中「中区弹窗」）——
    // 转发点击 .notice-close 走官方 dismiss_notice 通道（React 状态一致不复活）
    expect(s).toContain('".fp-notice, .notice"');
    expect(s).toContain('querySelector(".notice-close")');
    expect(s).toContain('close.click()');
    // 文本匹配仍限定「已切换到/已在工作目录」（错误级「切换失败」不命中）
    expect(s).toContain('\\u5df2\\u5207\\u6362\\u5230\\u5de5\\u4f5c\\u76ee\\u5f55');
    expect(s).toContain('\\u5df2\\u5728\\u5de5\\u4f5c\\u76ee\\u5f55');
  });

  it('should remove topbar duplicates and add read-only About (dev.89)', () => {
    const s = buildProjectsPanelScript();
    // 顶栏清理：打开项目（与输入框下方 cwd 行重复）/ GitHub / 版本更新入口
    expect(s).toContain('button.chip.open-project');
    expect(s).toContain('a.chip.github');
    expect(s).toContain('/^v?\\d+\\.\\d+\\.\\d+/');
    expect(s).toContain('window.__ubPiVersionChip');
    // 设置导航底部「关于」+ 只读弹窗（版本号 + 无自动更新）
    expect(s).toContain('.settings-rail');
    expect(s).toContain('__ubAboutTab');
    expect(s).toContain('openAbout');
    expect(s).toContain('__ubAboutRow');
    expect(s).toContain('__ubAboutNote');
    // 注入脚本中中文以 \uXXXX 转义写入（与既有注入一致），运行时即「自动更新」
    expect(s).toContain('\\u81ea\\u52a8\\u66f4\\u65b0');
    // 旧 dev.47「仅留版本行」CSS 退役
    expect(s).not.toContain('.dd-update>*:not(:first-child)');
    expect(s).not.toContain('.update-dot{display:none!important}');
    // dev.104（用户指令）：右区右上角官方折叠按钮删除（与中区自绘 #__ubRTCollapse 重复）
    expect(s).toContain('.panel-right .panel-collapse-btn');
  });

  it('should cancel pi agent setup modal via injected CSS (dev.87)', () => {
    const s = buildProjectsPanelScript();
    // 官方 PiSetupModal（setupTitle「未检测到 pi agent 配置」）纯 CSS 隐藏；
    // 0.90 起 piConfigured=模型运行时可用模型数，auth.json 占位对其无效
    expect(s).toContain('.modal-backdrop:has(>.modal.setup-modal){display:none!important}');
  });

  it('should retire skills/extensions settings-dedupe (dev.86 cleanup)', () => {
    const s = buildProjectsPanelScript();
    // dev.86 决策清理：0.90.0 上游设置页重组后已无「技能/插件」tab，
    // dev.69/71 去重逻辑成为惰性代码——整体退役删除
    expect(s).not.toContain('removeSettingsDupSections');
    expect(s).not.toContain('button.settings-tab');
    expect(s).not.toContain('set-section');
  });

  it('should keep only visual composer customizations on 0.47.0 native structure (dev.71)', () => {
    const s = buildProjectsPanelScript();
    // dev.71：上游 0.47.0 原生 ChatGPT 式单框（.inputbox 直含 .composer-tools）
    // ——dev.51-58 结构性 hack 退役，断言其不再出现
    expect(s).not.toContain('.inputbox-row');
    expect(s).not.toContain('.input-tools');
    expect(s).not.toContain('position:absolute;right:10px');
    expect(s).not.toContain('border-radius:22px 22px 0 0');
    // 保留视觉定制 ①：发送/停止主题反色 28px 方块（选择器放宽到 .inputbar 级）
    expect(s).toContain('.inputbar .btn.send,.inputbar .btn.stop{background:var(--text)');
    expect(s).toContain('width:28px;height:28px;border-radius:10px');
    // 保留视觉定制 ②：「+」background-image 绘制（新选择器 composer-tools-left）
    expect(s).toContain(
      '.inputbar .composer-tools-left .btn.attach-img svg{display:none!important}',
    );
    expect(s).toContain(
      '.inputbar .composer-tools-left .btn.attach-img{background-color:transparent;background-repeat:no-repeat;background-position:center;background-size:18px 18px;width:27px;height:27px',
    );
    expect(s).toContain('url(\\"data:image/svg+xml');
    expect(s).toContain('%23111827');
    expect(s).toContain('%23f3f4f6');
    expect(s).toContain(
      '.inputbar .composer-tools-left .btn.attach-img:disabled{opacity:1!important}',
    );
    // 确保整段 CSS 是作为 st.textContent 字符串赋值（JSON.stringify 转义后无引号破坏）
    expect(s).toContain('st.textContent = ');
    // dev.59：上下文圆环（注入点随 + 移到 composer-tools-left）
    expect(s).toContain('__ubCtxRing');
    expect(s).toContain('composer-tools-left .__ubCtxRing');
    expect(s).toContain('conic-gradient');
    expect(s).toContain('insertAdjacentElement("afterend",ring)');
    // dev.119：旧注入式 cwd 行（__ubCwdRow）已移除，改用 pi-web-ui 0.110 原生 picker
    expect(s).not.toContain('__ubCwdRow');
    expect(s).not.toContain('__ubCwdPath');
    // dev.86：顶栏模型/思考移除为死代码（0.90 顶栏已无此二项，由 composer.actions
    // 承载），按决策退役删除——脚本中不再出现该逻辑
    expect(s).not.toContain('span.chip-model');
    expect(s).not.toContain('.topbar-desktop');
  });
});
