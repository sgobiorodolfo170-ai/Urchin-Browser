/* eslint-disable @typescript-eslint/require-await -- 测试用 async mock 不需要真实 await */
/**
 * 深度抽取：子 frame 过滤、closed shadow 尝试条件、CDP 补抽与降级。
 */
import { describe, it, expect, vi } from 'vitest';
import {
  collectClosedShadowHtml,
  collectSubFrames,
  shouldTryClosedShadow,
} from '../../../src/main/clipper/deep-extract';

const baseSignals = {
  copyBlocked: false,
  userSelectNone: false,
  hasCanvas: false,
  hasOpenShadow: false,
  hasClosedShadow: false,
  frameCount: 0,
  imageCount: 0,
  textLength: 0,
};

describe('clipper deep extract', () => {
  it('should collect subframes without main frame', () => {
    const a = { executeJavaScript: vi.fn() };
    const b = { executeJavaScript: vi.fn() };
    const main = { framesInSubtree: [a, b] };
    const frames = collectSubFrames({ mainFrame: main });
    // framesInSubtree 包含自身时，mainFrame 类型里没有该对象；这里只验证过滤非空
    expect(frames).toHaveLength(2);
  });

  it('should try closed shadow only for low text or canvas', () => {
    expect(shouldTryClosedShadow({ ...baseSignals, textLength: 10 })).toBe(true);
    expect(shouldTryClosedShadow({ ...baseSignals, textLength: 5000, hasCanvas: true })).toBe(true);
    expect(shouldTryClosedShadow({ ...baseSignals, textLength: 5000 })).toBe(false);
  });

  it('should collect closed shadow content via CDP tree and detach', async () => {
    const sendCommand = vi.fn(async (method: string) => {
      if (method === 'DOM.getDocument') {
        return {
          root: {
            nodeId: 1,
            children: [],
            shadowRoots: [
              {
                nodeId: 2,
                shadowRootType: 'closed',
                children: [
                  {
                    nodeId: 3,
                    nodeType: 1,
                    nodeName: 'P',
                    children: [{ nodeId: 4, nodeType: 3, nodeValue: 'shadow' }],
                  },
                ],
              },
            ],
          },
        };
      }
      return {};
    });
    const detach = vi.fn();
    const html = await collectClosedShadowHtml({
      debugger: {
        isAttached: () => false,
        attach: vi.fn(),
        detach,
        sendCommand,
      },
    });
    expect(html).toContain('shadow');
    expect(detach).toHaveBeenCalled();
  });

  it('should return empty string when debugger unavailable or command fails', async () => {
    expect(await collectClosedShadowHtml({})).toBe('');
    const html = await collectClosedShadowHtml({
      debugger: {
        isAttached: () => true,
        attach: vi.fn(),
        detach: vi.fn(),
        sendCommand: vi.fn(async () => {
          throw new Error('cdp busy');
        }),
      },
    });
    expect(html).toBe('');
  });
});
