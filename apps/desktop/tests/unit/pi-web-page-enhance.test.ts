/**
 * pi 页体验增强注入单元测试（dev.45）
 *
 * 验证脚本内容关键要素（字符串断言，行为由 E2E 端到端覆盖）：
 * 1. 主题默认亮色：null 时写 'light' + 官方 theme-change 事件热切换 + 400ms 兜底 reload
 * 2. 最近项目：project-item 行注入删除按钮（sessionStorage 持久隐藏集）
 * 3. 抑制「已切换到/已在工作目录」路径提示（fp-notice 按文案匹配移除）
 */
import { describe, it, expect } from 'vitest';
import {
  buildThemeDefaultScript,
  buildProjectsPanelScript,
} from '../../src/main/pi-web/page-enhance';

describe('buildThemeDefaultScript', () => {
  it('should set light only when theme key is null and hot-swap via official event', () => {
    const s = buildThemeDefaultScript();
    // 仅在 key 为 null（从未选择）时写入，不覆盖用户显式选择的主题
    expect(s).toContain("localStorage.getItem('pi-web-ui:theme') === null");
    expect(s).toContain("localStorage.setItem('pi-web-ui:theme', 'light')");
    // 官方热切换事件 + 样式表未生效时 reload 兜底
    expect(s).toContain('pi-web-ui:theme-change');
    expect(s).toContain('theme-stylesheet');
    expect(s).toContain('location.reload()');
  });
});

describe('buildProjectsPanelScript', () => {
  it('should inject delete buttons into project items with session-persisted hidden set', () => {
    const s = buildProjectsPanelScript();
    expect(s).toContain('button.project-item');
    expect(s).toContain('__ubProjDel');
    expect(s).toContain('__ubHiddenProjects');
    // 隐藏记录存 sessionStorage（页面重载后仍生效）
    expect(s).toContain('sessionStorage');
  });

  it('should suppress only cwd-switch notices', () => {
    const s = buildProjectsPanelScript();
    expect(s).toContain('.fp-notice');
    // 仅匹配两类路径提示文案（\u 转义：已切换到工作目录 / 已在工作目录）
    expect(s).toContain('\\u5df2\\u5207\\u6362\\u5230\\u5de5\\u4f5c\\u76ee\\u5f55');
    expect(s).toContain('\\u5df2\\u5728\\u5de5\\u4f5c\\u76ee\\u5f55');
  });
});
