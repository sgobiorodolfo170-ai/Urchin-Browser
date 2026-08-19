/**
 * 截图域 · screenshot.* handlers（地址栏截图按钮 → 整屏框选截图）
 *
 * 职责：
 * - screenshot.capture：弹出全屏框选覆盖窗口（CaptureOverlay.start，桌面截图 + 透明覆盖窗）
 * - screenshot.getImageData：覆盖窗口拉取整屏截图 data URI（显示为背景）
 * - screenshot.confirm：按选区裁剪整屏截图 → 保存 PNG 到 <数据目录>/screenshots/
 * - screenshot.cancel：取消框选，关闭覆盖窗口
 *
 * 与 pi 模块的 ai.screenshot 区别：
 * - ai.screenshot（pi）：desktopCapturer 截整个屏幕，base64 返回给 AI
 * - screenshot.*（本文件）：整屏截图 + 用户框选 + 裁剪落盘到用户数据目录（DD1 决策）
 *
 * 设计理由（agents.md §七.2 + §六 项目特化审查点）：
 * - 覆盖窗口是独立 BrowserWindow（frame:false + transparent + alwaysOnTop），
 *   其渲染进程经 urchin://capture-overlay 页内 window.urchin.invoke 调本域通道
 * - CaptureOverlay 单例由调用方注入（index.ts 持有），handler 仅做转发
 */
import { registerHandler } from '@urchin/ipc-contract';
import type { CaptureOverlay } from './capture-overlay';

/** 截图 handler 依赖（依赖注入，便于测试） */
export interface ScreenshotDeps {
  /** 框选覆盖窗口单例 */
  overlay: CaptureOverlay;
}

/**
 * 注册截图域 IPC handlers。
 *
 * @param ipcMain 已包装的 ipcMain（registerHandler 内做 zod 校验）
 * @param deps 依赖注入（覆盖窗口单例）
 */
export function registerScreenshotHandlers(
  ipcMain: Parameters<typeof registerHandler>[0],
  deps: ScreenshotDeps,
): void {
  // 地址栏截图按钮：弹出整屏框选覆盖窗口
  registerHandler(ipcMain, 'screenshot.capture', async () => {
    const started = await deps.overlay.start();
    return { started };
  });

  // 覆盖窗口拉取背景截图
  registerHandler(ipcMain, 'screenshot.getImageData', () => {
    return { dataUri: deps.overlay.getImageData() };
  });

  // 覆盖窗口确认框选：裁剪保存
  registerHandler(ipcMain, 'screenshot.confirm', (req) => {
    const path = deps.overlay.confirm({
      x: req.x,
      y: req.y,
      width: req.width,
      height: req.height,
    });
    return { path };
  });

  // 覆盖窗口取消框选
  registerHandler(ipcMain, 'screenshot.cancel', () => {
    deps.overlay.cancel();
    return {};
  });
}
