/**
 * BrowserView 工厂（createBrowserView）单元测试
 *
 * 验证：
 * 1. 创建 BrowserView 并配置 M18 安全边界（sandbox / contextIsolation / nodeIntegration 关）
 * 2. 设置背景色避免白屏
 * 3. 返回符合 BrowserViewLike 接口的实例
 */

import { describe, it, expect, vi } from 'vitest';

const browserViewMock = {
  setBackgroundColor: vi.fn(),
  setBounds: vi.fn(),
};

vi.mock('electron', () => ({
  BrowserView: vi.fn().mockImplementation(() => browserViewMock),
}));

import { createBrowserView } from '../../src/main/tabs/create-browser-view';
import { BrowserView } from 'electron';

describe('createBrowserView', () => {
  it('should create BrowserView with M18 security boundaries', () => {
    const view = createBrowserView();

    expect(BrowserView).toHaveBeenCalledWith({
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
      },
    });
    expect(view).toBeDefined();
  });

  it('should set white background color to avoid flash', () => {
    createBrowserView();

    expect(browserViewMock.setBackgroundColor).toHaveBeenCalledWith('#ffffff');
  });

  it('should return a BrowserViewLike-compatible instance', () => {
    const view = createBrowserView() as unknown as { setBounds: unknown };

    expect(typeof view.setBounds).toBe('function');
  });
});
