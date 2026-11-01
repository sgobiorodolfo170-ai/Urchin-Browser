/**
 * 剪藏面板几何：居中、底部贴状态栏、最小/最大尺寸。
 */
import { describe, it, expect } from 'vitest';
import { computeClipperPanelBounds } from '../../../src/main/clipper/panel';

const CONTENT = { x: 0, y: 0, width: 1280, height: 800 };
const LAYOUT = { leftWidth: 44, rightWidth: 44, bottomHeight: 48 };

describe('clipper panel geometry', () => {
  it('should center within middle width and sit above bottom bar', () => {
    const bounds = computeClipperPanelBounds({ contentBounds: CONTENT, ...LAYOUT });
    const middle = 1280 - 44 - 44;
    expect(bounds.x).toBe(Math.round(44 + (middle - bounds.width) / 2));
    expect(bounds.y + bounds.height).toBe(800 - 48 - 8);
  });

  it('should shrink to fit narrow windows', () => {
    const bounds = computeClipperPanelBounds({
      contentBounds: { x: 0, y: 0, width: 600, height: 500 },
      ...LAYOUT,
    });
    expect(bounds.width).toBeLessThanOrEqual(600 - 88 - 16);
    expect(bounds.height).toBeLessThanOrEqual(500 - 48 - 24);
  });
});
