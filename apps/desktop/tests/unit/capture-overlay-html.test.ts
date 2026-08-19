/**
 * 框选截图 · 覆盖窗口 HTML 内容测试
 *
 * 验证选区交互能力（框内移动 / 四边四角缩放 / 框外右键取消）已内嵌于覆盖页：
 * 1. 选区元素可交互（pointer-events: auto）——框内拖动移动的前提
 * 2. 命中检测覆盖四角 / 四边 / 框内移动九个方向
 * 3. Esc 取消有 keydown + keyup 双通道兜底
 * 4. 框外右键取消（contextmenu 监听，选区框内不拦截）
 * 5. 提示文案告知移动、缩放与取消操作
 */
import { describe, it, expect } from 'vitest';
import { getCaptureOverlayHtml } from '../../src/main/screenshots/capture-overlay-html';

describe('capture overlay html', () => {
  const html = getCaptureOverlayHtml();

  it('should make selection interactive for move and resize', () => {
    // 选区元素须捕获指针事件，框内按住拖动才能移动 / 缩放
    expect(html).toMatch(/#selection\s*{[^}]*pointer-events:\s*auto/s);
    // 命中检测须包含四角 + 四边缩放方向与框内移动
    for (const dir of ['nw', 'ne', 'sw', 'se', 'n', 's', 'e', 'w', 'move']) {
      expect(html).toContain(`'${dir}'`);
    }
  });

  it('should cancel on Escape via keydown and keyup fallback', () => {
    // keydown 正常通道
    expect(html).toMatch(
      /addEventListener\('keydown'[\s\S]*?e\.key === 'Escape'[\s\S]*?cancelCapture\(\)/,
    );
    // keyup 兜底（透明窗口焦点抖动时 keydown 可能被吞）
    expect(html).toMatch(
      /addEventListener\('keyup'[\s\S]*?e\.key === 'Escape'[\s\S]*?cancelCapture\(\)/,
    );
  });

  it('should cancel on right-click outside selection', () => {
    // contextmenu 监听框外右键取消
    expect(html).toMatch(/addEventListener\('contextmenu'/);
    expect(html).toMatch(/inSelection/);
  });

  it('should hint move, resize and cancel operations', () => {
    expect(html).toContain('框内拖动移动');
    expect(html).toContain('缩放');
    expect(html).toContain('框外右键取消');
  });
});
