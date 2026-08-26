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
 * 4. 最近项目删除按钮 + 确认（__ubProjDelConfirm 钩子）+ 会话内隐藏
 * 5. 抑制「已切换到/已在工作目录」路径提示
 * 6. 更新组件隐藏（.dd-update 仅版本行 + update-dot 红点）
 * 7. 对话输入框重构（dev.51/52）：一体大框（主箱+chips 条无缝）、「+」合并至
 *    chips 条最左且换图标、发送/停止主题反色方块、工具条弹窗向上
 */
import { describe, it, expect } from 'vitest';
import {
  buildThemeFollowScript,
  buildThemePushCall,
  pushPiTheme,
  buildProjectsPanelScript,
} from '../../src/main/pi-web/page-enhance';

describe('buildThemeFollowScript', () => {
  it('should expose __ubApplyTheme for main-process push and apply without reload', () => {
    const s = buildThemeFollowScript();
    // dev.49：主进程直推入口 + 兜底轮询 + visibilitychange 即时同步
    expect(s).toContain('window.__ubApplyTheme');
    expect(s).toContain("fetch('urchin://pi-theme'");
    expect(s).toContain('visibilitychange');
    expect(s).toContain('setInterval');
    // 亮：官方 key 写 'light' + 直接替换样式表（与官方切换同 URL）
    expect(s).toContain("localStorage.setItem('pi-web-ui:theme','light')");
    expect(s).toContain('link.href="/themes/light.css"');
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

  it('should inject delete buttons with confirm dialog and session-persisted hidden set', () => {
    const s = buildProjectsPanelScript();
    expect(s).toContain('button.project-item');
    expect(s).toContain('__ubProjDel');
    expect(s).toContain('__ubProjDelConfirm');
    expect(s).toContain('window.confirm');
    expect(s).toContain('sessionStorage');
  });

  it('should suppress only cwd-switch notices', () => {
    const s = buildProjectsPanelScript();
    expect(s).toContain('.fp-notice');
    expect(s).toContain('\\u5df2\\u5207\\u6362\\u5230\\u5de5\\u4f5c\\u76ee\\u5f55');
    expect(s).toContain('\\u5df2\\u5728\\u5de5\\u4f5c\\u76ee\\u5f55');
  });

  it('should hide in-page update UI keeping only the version row (dev.47)', () => {
    const s = buildProjectsPanelScript();
    expect(s).toContain('.dd-update>*:not(:first-child){display:none!important}');
    expect(s).toContain('.update-dot{display:none!important}');
  });

  it('should restyle composer into merged frame + + merged to chips left + popup up (dev.52)', () => {
    const s = buildProjectsPanelScript();
    // 外壳透明化 + 一体大框：gap:0 去缝、上圆角/下圆角、独立条上边框负重叠成分割线
    expect(s).toContain('.inputbar .inputbox{background:transparent');
    expect(s).toContain('.inputbar .inputbox-row{flex-wrap:wrap');
    expect(s).toContain('.inputbar .inputbox-row textarea{flex:1 1 100%');
    expect(s).toContain('border-radius:22px 22px 0 0');
    expect(s).toContain('border-radius:0 0 22px 22px');
    expect(s).toContain('margin-top:-1px');
    // 主箱内 attach 隐藏（+ 移到工具条）；发送/停止仍在主箱右下（dev.54 基线）
    expect(s).toContain('.inputbar .inputbox-row .attach-img{display:none!important}');
    expect(s).toContain(
      '.inputbar .inputbox-row .inputbox-actions{display:flex!important;margin-left:auto}',
    );
    // 发送/停止：主题反色圆角方块 + 尺寸 33（38-5）
    expect(s).toContain(
      '.inputbar .inputbox .btn.send,.inputbar .inputbox .btn.stop{background:var(--text)',
    );
    expect(s).toContain('width:33px;height:33px;border-radius:10px');
    // 工具条：+ 最左（order:-1）；其 actions（发送副本）隐藏；模型↔思考 5px（强制 flex）+ 模型左移
    expect(s).toContain('.inputbar .input-tools-right{display:flex!important;order:-1}');
    expect(s).toContain('.inputbar .input-tools-right .inputbox-actions{display:none!important}');
    expect(s).toContain(
      '.inputbar .input-tools-left{display:flex!important;align-items:center;gap:5px;margin-left:-5px}',
    );
    expect(s).toContain('background:var(--bg);border:1px solid var(--border)');
    // 「+」：藏官方 SVG，改用 background-image SVG data-URI（亮 #111827 黑 / 暗 #f3f4f6 白）
    // 注意：CSS 经 JSON.stringify 嵌入 st.textContent，内部双引号以 \" 转义
    expect(s).toContain('.inputbar .input-tools-right .btn.attach-img svg{display:none!important}');
    expect(s).toContain(
      '.inputbar .input-tools-right .btn.attach-img{display:inline-flex!important;border:none;background-color:transparent;background-repeat:no-repeat;background-position:center;background-size:15px 15px;width:22px;height:22px',
    );
    expect(s).toContain('url(\\"data:image/svg+xml');
    expect(s).toContain('%23111827');
    expect(s).toContain('%23f3f4f6');
    // 确保整段 CSS 是作为 st.textContent 字符串赋值（JSON.stringify 转义后无引号破坏）
    expect(s).toContain('st.textContent = ');
    expect(s).toContain(
      '.inputbar .input-tools-right .btn.attach-img:disabled{opacity:1!important}',
    );
    // 弹窗一律向上开（absolute + bottom:100%，覆盖官方朝下与 ≤768px fixed 贴底）
    expect(s).toContain('.inputbar .input-tools .dropdown .dd-menu{position:absolute!important;');
    expect(s).toContain('bottom:calc(100% + 6px)!important');
    // dev.54：删除顶栏（.topbar-desktop）模型 + 思考选择框（模型=含 span.chip-model，
    // 思考=紧随其后的 .dropdown）
    expect(s).toContain('span.chip-model');
    expect(s).toContain('.topbar-desktop');
    expect(s).toContain('tds[ti].querySelector("span.chip-model")');
  });
});
