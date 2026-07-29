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
import { BrowserWindow, app } from 'electron';
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

  const win = new BrowserWindow({
    width,
    height,
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    show: false,
    title: 'Urchin Browser',
    backgroundColor: '#ffffff',
    webPreferences: {
      // M18 安全边界：sandbox + contextIsolation + preload
      preload: join(__dirname, '..', 'preload', 'index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });

  // 开发模式加载 dev server，生产模式加载打包文件
  const isDev = !app.isPackaged;
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
