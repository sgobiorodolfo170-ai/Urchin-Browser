/**
 * BrowserView 工厂（createBrowserView）单元测试
 *
 * 验证：
 * 1. 创建 BrowserView 并配置 M18 安全边界（sandbox / contextIsolation / nodeIntegration 关）
 * 2. 设置不透明背景色避免加载闪烁（颜色跟随主题，dev.50）
 * 3. 返回符合 BrowserViewLike 接口的实例
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const browserViewMock = {
  setBackgroundColor: vi.fn(),
  setBounds: vi.fn(),
};

/** dev.50：nativeTheme 暗色标志（背景色跟随主题断言用） */
const electronState = vi.hoisted(() => ({ dark: false }));

/** TP7：mock session（工作区分区解析结果）。 */
const mockSession = { partition: 'persist:urchin-workspace-test' } as unknown as Electron.Session;
const resolveSession = vi.fn(() => mockSession);

vi.mock('electron', () => ({
  BrowserView: vi.fn().mockImplementation(() => browserViewMock),
  nativeTheme: {
    get shouldUseDarkColors() {
      return electronState.dark;
    },
  },
}));

import { createBrowserView } from '../../src/main/tabs/create-browser-view';
import { BrowserView } from 'electron';

describe('createBrowserView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    electronState.dark = false;
  });

  it('should create BrowserView with M18 security boundaries + workspace session', () => {
    const view = createBrowserView('test', resolveSession);

    expect(BrowserView).toHaveBeenCalledWith({
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        session: mockSession,
      },
    });
    expect(resolveSession).toHaveBeenCalledWith('test');
    expect(view).toBeDefined();
  });

  it('should set opaque background color following theme (dev.50)', () => {
    // 亮色：白（与渲染层 --color-surface 亮值一致）
    createBrowserView('test', resolveSession);
    expect(browserViewMock.setBackgroundColor).toHaveBeenCalledWith('#ffffff');

    // 暗色：surface 深色——硬编码白在深色模式造成加载白闪 + 缝隙透白分割线
    electronState.dark = true;
    createBrowserView('test', resolveSession);
    expect(browserViewMock.setBackgroundColor).toHaveBeenLastCalledWith('#0f172a');
  });

  it('should return a BrowserViewLike-compatible instance', () => {
    const view = createBrowserView('test', resolveSession) as unknown as { setBounds: unknown };

    expect(typeof view.setBounds).toBe('function');
  });
});
