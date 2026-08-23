/**
 * pi 页体验增强注入单元测试（dev.45 建立，dev.47/48 更新）
 *
 * 验证脚本内容关键要素（字符串断言，行为由 E2E 端到端覆盖）：
 * 1. 主题跟随浏览器（dev.48，替代默认亮色）：轮询 urchin://pi-theme →
 *    写官方 key + 热切换事件 + 直接替换/移除 #theme-stylesheet——禁止 reload
 * 2. 新对话按钮移植（dev.48）：隐藏顶栏原 chip.newchat，历史对话标题行注入
 *    同功能小按钮（右对齐、贴合行高）
 * 3. 主题选择器隐藏（dev.48）：chip-sub「主题/theme」触发器加隐藏类
 * 4. 最近项目删除按钮 + 确认（__ubProjDelConfirm 钩子）+ 会话内隐藏
 * 5. 抑制「已切换到/已在工作目录」路径提示
 * 6. 更新组件隐藏（.dd-update 仅版本行 + update-dot 红点）
 */
import { describe, it, expect } from 'vitest';
import {
  buildThemeFollowScript,
  buildProjectsPanelScript,
} from '../../src/main/pi-web/page-enhance';

describe('buildThemeFollowScript', () => {
  it('should poll browser theme endpoint and apply light/dark without reload', () => {
    const s = buildThemeFollowScript();
    // 轮询官方端点 + visibilitychange 即时同步
    expect(s).toContain("fetch('urchin://pi-theme'");
    expect(s).toContain('visibilitychange');
    // 亮：写 key + 官方事件 + 直接替换样式表（与官方切换同 URL）
    expect(s).toContain("localStorage.setItem('pi-web-ui:theme', t)");
    expect(s).toContain('pi-web-ui:theme-change');
    expect(s).toContain("link.href = '/themes/light.css'");
    // 暗：移除样式表回内置默认
    expect(s).toContain('link.remove()');
    // dev.47 教训：禁止整页 reload（空窗会令目录选择拦截器失效）
    expect(s).not.toContain('location.reload');
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

  it('should hide pi theme selector trigger (dev.48 follow-browser)', () => {
    const s = buildProjectsPanelScript();
    expect(s).toContain('span.chip-sub');
    expect(s).toContain('__ubThemeSelHidden');
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
});
