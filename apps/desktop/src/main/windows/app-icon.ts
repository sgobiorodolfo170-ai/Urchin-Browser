/**
 * M1 Window Lifecycle · 应用图标路径解析（窗口 / 系统托盘共用）
 *
 * 打包后：electron-builder 的 extraResources 把 build/icon.ico|png 复制到
 * resources 根目录；开发模式：直接从 apps/desktop/build 读取。
 * Windows 用 ico（多尺寸，托盘/任务栏都能取到合适分辨率），其余平台用 png。
 */
import { app } from 'electron';
import { join } from 'node:path';

export function resolveAppIconPath(): string {
  const iconName = process.platform === 'win32' ? 'icon.ico' : 'icon.png';
  return app.isPackaged
    ? join(process.resourcesPath, iconName)
    : join(app.getAppPath(), 'build', iconName);
}
