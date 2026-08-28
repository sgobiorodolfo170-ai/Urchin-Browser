/**
 * pi 中区布局控制注入单元测试（dev.67）
 *
 * 验证脚本内容关键要素（字符串断言，行为由 E2E 端到端覆盖）：
 * 1. 折叠按钮：main.main 内左上/右上角（#__ubLTCollapse / #__ubRTCollapse），
 *    切换 html 根类 __ubNoLeft / __ubNoRight 隐藏官方抽屉包装
 * 2. 分割线：.view-pane 内 .__ubSplitL / .__ubSplitR，mousedown 拖拽改
 *    panel 内联宽度（180–520 钳制），mouseup 持久化
 * 3. 持久化：urchin://pi-ui-state 读 + a=set 写（防抖 300ms），暴露
 *    window.__ubPiUI（state/save/__reorder）供左区面板消费
 * 4. 层叠修复：.notices z-index 70（高于窄屏抽屉 60）、[data-tip]:after 80
 * 5. 窄屏降级：≤768px 控件隐藏 + 面板宽度交还官方
 */
import { describe, it, expect } from 'vitest';
import { buildLayoutScript } from '../../src/main/pi-web/layout';

describe('buildLayoutScript', () => {
  it('should install with idempotent flag and expose shared UI store', () => {
    const s = buildLayoutScript();
    expect(s).toContain('__ubLayoutInstalled');
    expect(s).toContain('window.__ubPiUI = UI');
    expect(s).toContain('UI.__reorder');
    // 状态就绪/排序变化广播（left-panel 监听重渲染）
    expect(s).toContain("'__ubPiUIReady'");
    expect(s).toContain("'__ubPiUIOrder'");
  });

  it('should persist via urchin://pi-ui-state with debounced set', () => {
    const s = buildLayoutScript();
    expect(s).toContain("fetch('urchin://pi-ui-state', { mode: 'cors' })");
    expect(s).toContain("'?a=set&lw='");
    expect(s).toContain('encodeURIComponent(JSON.stringify(s.po');
    expect(s).toContain('300'); // 防抖间隔
  });

  it('should inject corner collapse buttons into main and toggle root classes', () => {
    const s = buildLayoutScript();
    expect(s).toContain("getElementById('__ubLTCollapse')");
    expect(s).toContain("getElementById('__ubRTCollapse')");
    expect(s).toContain("id = '__ubLTCollapse'");
    expect(s).toContain('#__ubLTCollapse{left:8px}');
    expect(s).toContain('#__ubRTCollapse{right:8px}');
    expect(s).toContain('.main{position:relative}');
    expect(s).toContain("classList.toggle('__ubNoLeft'");
    expect(s).toContain("classList.toggle('__ubNoRight'");
    // 后代选择器（.view-pane 非 html 直接子级，直接子选择器永不匹配）
    expect(s).toContain('.__ubNoLeft .drawer-left{display:none!important}');
    expect(s).toContain('.__ubNoRight .drawer-right{display:none!important}');
  });

  it('should create draggable splitters with width clamping', () => {
    const s = buildLayoutScript();
    expect(s).toContain('__ubSplitL');
    expect(s).toContain('__ubSplitR');
    expect(s).toContain("bindDrag(sl, 'lw', 'left')");
    expect(s).toContain("bindDrag(sr, 'rw', 'right')");
    expect(s).toContain('Math.min(520, Math.max(180');
    expect(s).toContain("panel.style.width = w + 'px'");
    expect(s).toContain('UI.save()');
  });

  it('should fix stacking: notices above drawers, tooltips above notices', () => {
    const s = buildLayoutScript();
    expect(s).toContain('.notices{z-index:70!important}');
    expect(s).toContain('[data-tip]:after{z-index:80!important}');
  });

  it('should deactivate on narrow viewports (official drawer mode)', () => {
    const s = buildLayoutScript();
    expect(s).toContain('@media(max-width:768px)');
    expect(s).toContain('.panel-left,.panel-right{width:auto!important}');
  });
});
