/**
 * M1 Window Lifecycle · BrowserWindow 工厂
 *
 * 依据：02-架构设计 §4 安全边界 / §6 启动顺序 / M18 Permission/Sandbox
 * 职责：
 * 1. 创建 Electron BrowserWindow，配置 M18 安全边界
 * 2. 根据开发/生产模式加载渲染进程入口
 *
 * 设计理由（AGENTS.md §七.2 + §六 项目特化审查点「进程隔离」）：
 * v0.1 即开 sandbox + contextIsolation + preload，从第一天建立安全基线。
 * webSecurity:true 防止渲染进程直接访问 file:// 协议绕过 preload。
 * nodeIntegration:false 确保渲染进程无 Node.js 能力。
 */
import { BrowserWindow, Menu, app } from 'electron';
import { join } from 'node:path';
import { createLogger } from '@urchin/logger';
import { currentThemeBackground } from '../theme';
import {
  DEFAULT_WINDOW_WIDTH,
  DEFAULT_WINDOW_HEIGHT,
  MIN_WINDOW_WIDTH,
  MIN_WINDOW_HEIGHT,
} from './window-geometry';
import type { BrowserWindowLike, CreateWindowOptions } from './types';

const log = createLogger('window-factory');

/**
 * 创建 BrowserWindow 并配置 M18 安全边界。
 *
 * @param opts 创建选项
 * @returns 符合 BrowserWindowLike 接口的 BrowserWindow 实例
 */
export function createBrowserWindow(opts: CreateWindowOptions): BrowserWindowLike {
  const width = opts.width ?? DEFAULT_WINDOW_WIDTH;
  const height = opts.height ?? DEFAULT_WINDOW_HEIGHT;
  // x/y 成对且为有限数字时定位到恢复位置；否则省略，由 Electron 默认居中。
  // （window-state 恢复链路已保证成对传入；此处的散值防御只影响 BrowserWindow 参数）
  const hasPosition =
    opts.x !== undefined &&
    opts.y !== undefined &&
    Number.isFinite(opts.x) &&
    Number.isFinite(opts.y);
  const position = hasPosition ? { x: opts.x, y: opts.y } : {};

  log.info('creating browser window', {
    width,
    height,
    x: hasPosition ? opts.x : undefined,
    y: hasPosition ? opts.y : undefined,
    maximize: opts.maximize ?? false,
    incognito: opts.incognito ?? false,
  });

  // 应用图标路径：
  // - 打包后：extraResources 把图标复制到 resources 目录
  // - 开发模式：从 apps/desktop/build 引用
  const iconName = process.platform === 'win32' ? 'icon.ico' : 'icon.png';
  const iconPath = app.isPackaged
    ? join(process.resourcesPath, iconName)
    : join(app.getAppPath(), 'build', iconName);

  // Windows 首版启用无边框窗口：原生标题栏由渲染层自绘标题栏替代，
  // 从而让 8px #F6F2F0 外框 + 圆角 shell 能包裹「整个窗口（含标题栏）」。
  // 非 Windows 保留原生标题栏，避免 macOS/Linux 丢失系统红绿灯/窗口装饰。
  // 不启用 transparent：仓库已有透明 BrowserView 触发 Windows DWM/TDR 的记录，
  // 且不透明窗口仍保留系统阴影与圆角。
  const useCustomChrome = process.platform === 'win32';

  const win = new BrowserWindow({
    width,
    height,
    ...position,
    minWidth: MIN_WINDOW_WIDTH,
    minHeight: MIN_WINDOW_HEIGHT,
    show: false,
    frame: !useCustomChrome,
    title: 'Urchin Browser',
    // 背景跟随主题（dev.50）：硬编码白色在深色模式下会从窗口未覆盖区域/
    // 几何缝隙透出白光；暗色取 --color-surface 同值。切换主题时由
    // ui.theme.set 处理内统一刷新已存在窗口。
    backgroundColor: currentThemeBackground(),
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

  // 恢复上次会话最大化态（窗口状态记忆）：在 ready-to-show 显示前最大化，
  // 避免先以正常尺寸闪现再切换成最大化。正常态 bounds 已由 width/height/x/y
  // 传入，取消最大化时 Electron 还原到该尺寸。
  if (opts.maximize) {
    win.maximize();
  }

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
