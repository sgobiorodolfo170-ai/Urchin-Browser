/**
 * pi 中区布局控制注入单元测试（dev.67 建立，dev.71 适配 0.47.0 原生拖拽把手）
 *
 * 验证脚本内容关键要素（字符串断言，行为由 E2E 端到端覆盖）：
 * 1. 折叠按钮：main.main 内左上/右上角（#__ubLTCollapse / #__ubRTCollapse），
 *    切换 html 根类 __ubNoLeft / __ubNoRight 隐藏官方抽屉包装
 * 2. 持久化（dev.71）：自绘分割线退役（上游原生 .resize-handle 承担拖拽），
 *    我方给原生把手打 data-ub-side 标记 + pointerup 读两区宽度落盘
 *    （urchin://pi-ui-state）；宽度恢复仍由 applyAll 承担
 * 3. 共享契约：暴露 window.__ubPiUI（state/save/__reorder）供左区面板消费
 * 4. 层叠修复：.notices z-index 70（高于窄屏抽屉 60）、[data-tip]:after 80
 * 5. 窄屏降级：≤768px 折叠钮隐藏 + 面板宽度交还官方
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

  it('should hook native resize handles for persistence instead of own splitters (dev.71)', () => {
    const s = buildLayoutScript();
    // 自绘分割线退役（0.47.0 原生 .resize-handle 承担拖拽）
    expect(s).not.toContain('__ubSplitL');
    expect(s).not.toContain('bindDrag');
    // 原生把手挂持久化：pointerdown 时在 window 补 pointerup（拖拽中光标离开
    // 把手，原生的 up 派发在 window）读两区宽度落盘
    expect(s).toContain(".querySelectorAll(':scope > .resize-handle')");
    expect(s).toContain("addEventListener('pointerdown'");
    expect(s).toContain("window.addEventListener('pointerup', done)");
    expect(s).toContain('getBoundingClientRect().width');
    expect(s).toContain('UI.save()');
    // 折叠时隐藏对应侧的原生把手（原生自带 resize-left/right 类）
    expect(s).toContain('.__ubNoLeft .resize-handle.resize-left{display:none!important}');
    expect(s).toContain('.__ubNoRight .resize-handle.resize-right{display:none!important}');
    // 宽度守护避开原生拖拽期（body.panel-resizing），其余时机防 React 弹回默认
    expect(s).toContain("classList.contains('panel-resizing')");
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
