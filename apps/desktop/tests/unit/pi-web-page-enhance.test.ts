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
 * 5. 抑制「已切换到/已在工作目录」路径提示（dev.64：0.29.x 官方 .notice toast
 *    转发点击 .notice-close 走官方 dismiss 通道；.fp-notice 旧选择器保留兜底）
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

  it('should hide in-page update UI keeping only the version row (dev.47)', () => {
    const s = buildProjectsPanelScript();
    expect(s).toContain('.dd-update>*:not(:first-child){display:none!important}');
    expect(s).toContain('.update-dot{display:none!important}');
  });

  it('should remove skills/extensions tabs and sections from settings dialog (dev.69/71)', () => {
    const s = buildProjectsPanelScript();
    // 管理面统一到左区（同一 settings_state/set_settings 接口），弹窗内移除。
    // dev.71：0.47.0 弹窗为标签页布局——删 nav.settings-rail 里的
    // button.settings-tab（title 属性=精确标签）即整节不可达
    expect(s).toContain('removeSettingsDupSections');
    expect(s).toContain('"button.settings-tab"');
    expect(s).toContain('tabs[i].remove()');
    // 激活 tab 兜底（被删 tab 若为激活项，点第一个剩余 tab 保持内容区有效）
    expect(s).toContain('button.settings-tab.active');
    expect(s).toContain('first.click()');
    // .set-section 内容级移除保留作兜底（旧布局/激活态节）
    expect(s).toContain('".set-section .set-section-title"');
    expect(s).toContain('closest(".set-section")');
    expect(s).toContain('sec.remove()');
    // title/纯文本精确匹配（防「审查可用技能」「界面插件」子串误删）
    expect(s).toContain('/^(\\u6280\\u80fd|skills)$/i.test(tl)');
    expect(s).toContain('/^(\\u63d2\\u4ef6|extensions)$/i.test(tl)');
    expect(s).toContain('/^(\\u6280\\u80fd|skills)$/i.test(label)');
    // 挂进 MutationObserver 调度（弹窗重开重建节点时重复移除）
    expect(s).toContain('enhance(); suppressCwdNotices(); removeSettingsDupSections();');
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
      '.inputbar .composer-tools-left .btn.attach-img{border:none;background-color:transparent;background-repeat:no-repeat;background-position:center;background-size:18px 18px;width:27px;height:27px',
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
    // dev.60：隐藏整条信息栏 + 项目路径行（转发原 button.status-cwd 点击）
    expect(s).toContain('.statusbar{display:none!important}');
    expect(s).toContain('__ubCwdRow');
    expect(s).toContain('insertAdjacentElement("afterend",row)');
    expect(s).toContain('button.status-cwd');
    expect(s).toContain('__ubCwdPath');
    // dev.54 顶栏模型/思考移除：0.47.0 上游已原生移除（保留为无害兜底）
    expect(s).toContain('span.chip-model');
    expect(s).toContain('.topbar-desktop');
  });
});
