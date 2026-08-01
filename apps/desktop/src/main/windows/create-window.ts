/**
 * M1 Window Lifecycle · BrowserWindow 工厂
 *
 * 依据：02-架构设计 §4 安全边界 / §6 启动顺序 / M18 Permission/Sandbox
 * 职责：
 * 1. 创建 Electron BrowserWindow，配置 M18 安全边界
 * 2. 根据开发/生产模式加载渲染进程入口
 *
 * 设计理由（agents.md §七.2 + §六 项目特化审查点「进程隔离」）：
 * v0.1 即开 sandbox + contextIsolation + preload，从第一天建立安全基线。
 * webSecurity:true 防止渲染进程直接访问 file:// 协议绕过 preload。
 * nodeIntegration:false 确保渲染进程无 Node.js 能力。
 */
import { BrowserWindow, Menu, app } from 'electron';
import { join } from 'node:path';
import { createLogger } from '@urchin/logger';
import type { BrowserWindowLike, CreateWindowOptions } from './types';

const log = createLogger('window-factory');

/** 默认窗口尺寸 */
const DEFAULT_WIDTH = 1280;
const DEFAULT_HEIGHT = 800;
const MIN_WIDTH = 800;
const MIN_HEIGHT = 600;

/**
 * 创建 BrowserWindow 并配置 M18 安全边界。
 *
 * @param opts 创建选项
 * @returns 符合 BrowserWindowLike 接口的 BrowserWindow 实例
 */
export function createBrowserWindow(opts: CreateWindowOptions): BrowserWindowLike {
  const width = opts.width ?? DEFAULT_WIDTH;
  const height = opts.height ?? DEFAULT_HEIGHT;

  log.info('creating browser window', { width, height, incognito: opts.incognito ?? false });

  // 应用图标路径：
  // - 打包后：extraResources 把图标复制到 resources 目录
  // - 开发模式：从 apps/desktop/build 引用
  const iconName = process.platform === 'win32' ? 'icon.ico' : 'icon.png';
  const iconPath = app.isPackaged
    ? join(process.resourcesPath, iconName)
    : join(app.getAppPath(), 'build', iconName);

  const win = new BrowserWindow({
    width,
    height,
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    show: false,
    title: 'Urchin Browser',
    backgroundColor: '#ffffff',
    icon: iconPath,
    // 隐藏菜单栏（File/Edit/View/Window/Help）。
    // autoHideMenuBar 让菜单栏默认隐藏（Alt 可临时唤起），
    // setMenuBarVisibility(false) 则彻底关闭，两者结合确保菜单栏不出现。
    autoHideMenuBar: true,
    webPreferences: {
      // M18 安全边界：sandbox + contextIsolation + preload
      preload: join(__dirname, '..', 'preload', 'index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });

  // 彻底关闭菜单栏：setMenuBarVisibility(false) 隐藏当前窗口菜单，
  // Menu.setApplicationMenu(null) 移除全局默认菜单（防止新窗口继承）。
  win.setMenuBarVisibility(false);
  Menu.setApplicationMenu(null);

  // 开发模式加载 dev server，生产模式加载打包文件
  // E2E 测试时通过 NODE_ENV=production 强制加载打包文件（app.isPackaged 在未打包时为 false）
  const isDev = !app.isPackaged && process.env.NODE_ENV !== 'production';
  if (isDev) {
    const url = process.env.URCHIN_RENDERER_URL ?? 'http://localhost:5173';
    void win.loadURL(url);
    win.webContents.openDevTools({ mode: 'detach' });
  } else {
    void win.loadFile(join(__dirname, '..', 'renderer', 'index.html'));
  }

  win.once('ready-to-show', () => {
    win.show();
    log.info('window shown', { id: win.id });
  });

  return win;
}
