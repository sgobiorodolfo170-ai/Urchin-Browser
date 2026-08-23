/**
 * pi 页体验增强注入单元测试（dev.45 建立，dev.47 更新）
 *
 * 验证脚本内容关键要素（字符串断言，行为由 E2E 端到端覆盖）：
 * 1. 主题默认亮色：null 时写 'light' + 官方 theme-change 事件热切换 +
 *    400ms 样式表未生效时**直接替换样式表**（dev.47：不再整页 reload——
 *    reload 空窗期目录选择拦截器随 document 销毁，用户点击落回原生手输框）
 * 2. 最近项目：project-item 行注入删除按钮（sessionStorage 持久隐藏集）+
 *    删除前确认（默认 window.confirm，__ubProjDelConfirm 可覆盖供自动化）
 * 3. 抑制「已切换到/已在工作目录」路径提示（fp-notice 按文案匹配移除）
 * 4. 更新组件隐藏（dev.47 用户决策：pi-web-ui 随本项目升级，页内自更新
 *    在嵌入架构下无效且误导）——dd-update 仅留版本行 + update-dot 红点隐藏
 */
import { describe, it, expect } from 'vitest';
import {
  buildThemeDefaultScript,
  buildProjectsPanelScript,
} from '../../src/main/pi-web/page-enhance';

describe('buildThemeDefaultScript', () => {
  it('should set light only when theme key is null and swap stylesheet without reload', () => {
    const s = buildThemeDefaultScript();
    // 仅在 key 为 null（从未选择）时写入，不覆盖用户显式选择的主题
    expect(s).toContain("localStorage.getItem('pi-web-ui:theme') === null");
    expect(s).toContain("localStorage.setItem('pi-web-ui:theme', 'light')");
    // 官方热切换事件 + 样式表未生效时直接替换（dev.47：禁止 location.reload）
    expect(s).toContain('pi-web-ui:theme-change');
    expect(s).toContain('theme-stylesheet');
    expect(s).toContain("link.href = '/themes/light.css'");
    expect(s).not.toContain('location.reload');
  });
});

describe('buildProjectsPanelScript', () => {
  it('should inject delete buttons with confirm dialog and session-persisted hidden set', () => {
    const s = buildProjectsPanelScript();
    expect(s).toContain('button.project-item');
    expect(s).toContain('__ubProjDel');
    expect(s).toContain('__ubHiddenProjects');
    // 隐藏记录存 sessionStorage（页面重载后仍生效）
    expect(s).toContain('sessionStorage');
    // dev.47：删除前确认——默认 window.confirm，__ubProjDelConfirm 钩子可覆盖
    expect(s).toContain('__ubProjDelConfirm');
    expect(s).toContain('window.confirm');
  });

  it('should suppress only cwd-switch notices', () => {
    const s = buildProjectsPanelScript();
    expect(s).toContain('.fp-notice');
    // 仅匹配两类路径提示文案（\u 转义：已切换到工作目录 / 已在工作目录）
    expect(s).toContain('\\u5df2\\u5207\\u6362\\u5230\\u5de5\\u4f5c\\u76ee\\u5f55');
    expect(s).toContain('\\u5df2\\u5728\\u5de5\\u4f5c\\u76ee\\u5f55');
  });

  it('should hide in-page update UI keeping only the version row (dev.47)', () => {
    const s = buildProjectsPanelScript();
    // dd-update 仅保留首行（当前版本），其余子元素隐藏；新版本红点隐藏
    expect(s).toContain('.dd-update>*:not(:first-child){display:none!important}');
    expect(s).toContain('.update-dot{display:none!important}');
  });
});
