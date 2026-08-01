/**
 * pi 模块前端加号菜单三项的 IPC handler 实现
 *
 * 职责：
 * 1. ai.screenshot：通过 Electron desktopCapturer 截取全屏，返回 base64 PNG
 * 2. ai.uploadFile：弹出原生文件选择器，读取选中文件内容并 base64 编码
 * 3. ai.setWorkdir：弹出原生目录选择器，返回选中目录路径
 *
 * 设计说明：
 * - 截图和文件读取在主进程执行（渲染进程无法直接访问文件系统/桌面捕获）
 * - 文件类型通过 magic-byte 嗅探（参考 pi 原项目 mime.ts）
 * - 工作目录选择后，由前端自行决定如何使用（如调用 ai.agent.start 时传入 cwd）
 */
import { ipcMain, desktopCapturer, dialog, BrowserWindow } from 'electron';
import { readFile, stat, readdir } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { registerHandler } from '@urchin/ipc-contract';
import { createLogger } from '@urchin/logger';

const log = createLogger('ai:input-handlers');

/** 通过文件头 magic-byte 嗅探 MIME 类型（参考 pi 原项目 mime.ts） */
function detectMimeType(bytes: Uint8Array): string {
  if (bytes.length < 4) return 'application/octet-stream';
  // PNG: 89 50 4E 47
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return 'image/png';
  }
  // JPEG: FF D8 FF
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  // GIF: 47 49 46 38
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) {
    return 'image/gif';
  }
  // WEBP: RIFF....WEBP
  if (
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes.length >= 12 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return 'image/webp';
  }
  // BMP: 42 4D
  if (bytes[0] === 0x42 && bytes[1] === 0x4d) {
    return 'image/bmp';
  }
  // PDF: %PDF
  if (bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46) {
    return 'application/pdf';
  }
  return 'application/octet-stream';
}

/** 通过扩展名推断 MIME 类型（magic-byte 嗅探失败时回退） */
function detectMimeTypeByExt(filename: string): string {
  const ext = extname(filename).toLowerCase().slice(1);
  const map: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    bmp: 'image/bmp',
    txt: 'text/plain',
    md: 'text/markdown',
    json: 'application/json',
    csv: 'text/csv',
    html: 'text/html',
    pdf: 'application/pdf',
  };
  return map[ext] ?? 'application/octet-stream';
}

/** 获取当前焦点窗口（用于关联 dialog） */
function getFocusedWindow(): BrowserWindow | undefined {
  const windows = BrowserWindow.getAllWindows();
  return windows.find((w) => w.isFocused()) ?? windows[0];
}

/**
 * 注册 pi 模块前端加号菜单三项 IPC handler。
 *
 * 应在 app.whenReady() 后调用。
 */
export function registerAiInputHandlers(ipcMainInstance: typeof ipcMain): void {
  // ── ai.screenshot：截取全屏 ──
  registerHandler(ipcMainInstance, 'ai.screenshot', async () => {
    log.info('ai.screenshot');
    try {
      // 获取所有屏幕源
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: 1920, height: 1080 },
        fetchWindowIcons: false,
      });
      if (sources.length === 0) {
        throw new Error('未找到可用的屏幕源');
      }
      // 取主屏幕（通常是第一个）
      const primary = sources[0]!;
      const thumbnail = primary.thumbnail;
      const dataUrl = thumbnail.toDataURL();
      // 解析 data URL：data:image/png;base64,xxxx
      const match = /^data:(image\/[a-z+]+);base64,(.+)$/i.exec(dataUrl);
      if (!match) {
        throw new Error('截图数据格式异常');
      }
      const mimeType = match[1]!;
      const base64 = match[2]!;
      return {
        dataUri: dataUrl,
        mimeType,
        base64,
        displayId: primary.display_id ?? undefined,
      };
    } catch (e) {
      log.error('screenshot failed', { error: String(e) });
      throw e;
    }
  });

  // ── ai.uploadFile：弹出文件选择器，读取文件内容 ──
  registerHandler(ipcMainInstance, 'ai.uploadFile', async (req) => {
    log.info('ai.uploadFile', { multiple: req.multiple, filtersCount: req.filters.length });
    const win = getFocusedWindow();
    const filters =
      req.filters.length > 0
        ? [{ name: '允许的文件', extensions: req.filters }]
        : [
            { name: '图片', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'] },
            { name: '文档', extensions: ['txt', 'md', 'json', 'csv', 'html', 'pdf'] },
            { name: '所有文件', extensions: ['*'] },
          ];

    const result = await dialog.showOpenDialog(win!, {
      title: req.title ?? '选择要上传的文件',
      properties: [req.multiple ? 'multiSelections' : 'openFile', 'openFile'],
      filters,
    });

    if (result.canceled || result.filePaths.length === 0) {
      return { files: [] };
    }

    const files = await Promise.all(
      result.filePaths.map(async (filePath) => {
        const buffer = await readFile(filePath);
        const stats = await stat(filePath);
        const name = basename(filePath);
        const mimeType = detectMimeType(buffer) || detectMimeTypeByExt(name);
        const isImage = mimeType.startsWith('image/');
        const base64 = buffer.toString('base64');
        return {
          name,
          path: filePath,
          size: stats.size,
          mimeType,
          base64,
          isImage,
        };
      }),
    );

    log.info('uploadFile completed', { count: files.length });
    return { files };
  });

  // ── ai.setWorkdir：弹出目录选择器 ──
  registerHandler(ipcMainInstance, 'ai.setWorkdir', async (req) => {
    log.info('ai.setWorkdir');
    const win = getFocusedWindow();
    const result = await dialog.showOpenDialog(win!, {
      title: req.title ?? '选择工作目录',
      properties: ['openDirectory'],
    });

    if (result.canceled || result.filePaths.length === 0) {
      return { path: null, exists: false };
    }

    const dirPath = result.filePaths[0]!;
    try {
      const entries = await readdir(dirPath);
      log.info('setWorkdir selected', { path: dirPath, entryCount: entries.length });
      return { path: dirPath, exists: true, entryCount: entries.length };
    } catch (e) {
      log.error('setWorkdir: readdir failed', { path: dirPath, error: String(e) });
      return { path: dirPath, exists: false };
    }
  });
}
