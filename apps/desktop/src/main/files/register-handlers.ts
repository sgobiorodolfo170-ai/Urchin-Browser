/**
 * 本地文件域 IPC Handler 注册（file.*）
 *
 * 职责：
 * 1. file.stat：读取文件/目录元数据（名称/大小/扩展名/MIME/类型分类 + isDir 标记），
 *    供渲染层统一路由（目录开浏览页 / 文件开查看器）
 * 2. file.read：按 UTF-8 读取文本文件内容（有界读取：只分配 min(size, maxBytes) 内存，
 *    超上限截断并标记 truncated，由渲染层显示「已显示前 X / 共 Y」横幅）
 * 3. file.write：覆盖写入文本内容（编辑器「保存」到原文件或另存对话框已选定路径）
 * 4. file.saveAs：系统另存对话框（showSaveDialog）+ 写盘一通道完成
 * 5. file.open：原生路径选择器（openFile，单选文件），
 *    供左侧栏按钮/Ctrl+O/拖放入口使用
 * 6. file.dir：列目录（子目录在前 + 文件按名排序），供文件夹浏览页与同目录连续查看使用
 *
 * 安全边界（AGENTS.md §六 跨进程边界 + 项目特化审查点）：
 * - 所有入参/出参经 zod schema 双向校验（registerHandler 统一执行）
 * - 路径来自用户显式选择或地址栏输入，不做隐式目录遍历
 * - file.read 内存峰值恒为 maxBytes（默认 5MB），与文件实际大小无关——
 *   超大文件不再整读/拒载，防主进程内存冲击
 * - file.write/file.saveAs 的调用面为 urchin:// 内部页（preload 仅对受信协议暴露），
 *   目标路径来自已打开文件或系统另存对话框；日志只记路径与字节数不记内容（隐私）
 *
 * 可测试性（依赖注入）：fs 的 stat/open/readdir/writeFile 与 dialog 的
 * showSaveDialog 经 deps 注入（默认 node/electron 实现），
 * 单测传入 mock——vitest jsdom 下 node 内置模块导出无法 mock/spy，
 * 与 settings-manager 注入 mock 持久层的测试约定一致。
 */
import type { IpcMain } from 'electron';
import { BrowserWindow, dialog } from 'electron';
import { open, stat, readdir, writeFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { IpcError, IpcErrorCode, registerHandler } from '@urchin/ipc-contract';
import { createLogger } from '@urchin/logger';
import { classifyFileKind, inferMimeType } from './file-kind';

const log = createLogger('files-ipc');

/** 文件类型分类映射：kind → 是否可网页化查看（false 则渲染层提示外部打开）。 */
export const VIEWABLE_KINDS: ReadonlySet<string> = new Set([
  'audio',
  'video',
  'pdf',
  'image',
  'html',
  'markdown',
  'json',
  'text',
  // 阶段 4：Word 文档由 GenOffice docs 编辑器承载（产物缺失时查看器提示）
  'docx',
  // 阶段 5：PowerPoint 演示文档由 GenOffice slides 编辑器承载（产物缺失时查看器提示）
  'pptx',
  // 阶段 5：Excel 表格由 GenOffice sheets 编辑器承载（产物缺失时查看器提示）
  'xlsx',
]);

/** Windows 非法文件名字符（含控制字符），另存默认名净化用（同 summary-manager 惯例）。 */
// eslint-disable-next-line no-control-regex -- 文件名净化需要剔除控制字符
const ILLEGAL_FILENAME_CHARS = /[<>:"/\\|?*\x00-\x1f]/g;

/** 另存对话框默认文件名净化：非法字符→下划线、截断 80 字符、空名兜底。 */
function sanitizeFileName(name: string): string {
  const cleaned = name.replace(ILLEGAL_FILENAME_CHARS, '_').trim();
  return cleaned.length > 0 ? cleaned.slice(0, 80) : 'untitled';
}

/** 默认读取上限：5MB——也是 file.read 的内存峰值上限（有界读取）。
 * 实测该体量纯文本 <pre> 渲染 ≈0.35s，渲染进程与主进程均安全。 */
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;

/** IPC handler 注册依赖（fs 操作可注入 mock，便于单测）。 */
export interface FileHandlersDeps {
  readonly ipcMain: IpcMain;
  /** 文件 stat 实现（默认 node:fs/promises.stat）。 */
  readonly stat?: typeof stat;
  /** 有界读取实现（默认 node:fs/promises.open，handler 只读前 N 字节）。 */
  readonly open?: typeof open;
  /** 目录读取实现（默认 node:fs/promises.readdir）。 */
  readonly readdir?: typeof readdir;
  /** 文件写入实现（默认 node:fs/promises.writeFile，file.write/file.saveAs 用）。 */
  readonly writeFile?: typeof writeFile;
  /** 另存对话框实现（默认 electron dialog.showSaveDialog）。 */
  readonly showSaveDialog?: typeof dialog.showSaveDialog;
}

/**
 * 注册 file 域 IPC handler。
 */
export function registerFileHandlers(deps: FileHandlersDeps): void {
  const { ipcMain } = deps;
  const fsStat = deps.stat ?? stat;
  const fsOpen = deps.open ?? open;
  const fsWriteFile = deps.writeFile ?? writeFile;
  // 另存对话框：优先 DI（单测），默认直接走 electron dialog（懒调用，不绑定——
  // 单测的 electron mock 可能只提供部分 dialog 方法）
  const showSave = deps.showSaveDialog;

  /** 写盘失败的错误映射：目标不存在 → NOT_FOUND，其余 → INTERNAL。 */
  const writeError = (path: string, err: unknown): IpcError => {
    const notFound = (err as NodeJS.ErrnoException)?.code === 'ENOENT';
    log.warn('file write failed', { path, error: String(err) });
    return new IpcError(
      notFound ? IpcErrorCode.NOT_FOUND : IpcErrorCode.INTERNAL,
      `Cannot write file: ${path}`,
      { channel: 'file.write' },
    );
  };

  // file.write：覆盖写入文本内容（编辑器保存）
  registerHandler(ipcMain, 'file.write', async (req) => {
    try {
      await fsWriteFile(req.path, req.content, 'utf-8');
      const bytesWritten = Buffer.byteLength(req.content, 'utf-8');
      log.info('file written', { path: req.path, bytes: bytesWritten });
      return { bytesWritten };
    } catch (err) {
      throw writeError(req.path, err);
    }
  });

  // file.saveAs：系统另存对话框 + 写盘一通道完成（取消返回 null）。
  // 默认文件名做非法字符净化（同 summary-manager 惯例）；选定路径缺扩展名时
  // 补默认扩展名（保存网页 context-menu 先例）。
  registerHandler(ipcMain, 'file.saveAs', async (req) => {
    const baseName = sanitizeFileName(req.defaultName);
    const ext = extname(baseName).replace(/^\./, '') || 'txt';
    const options: Electron.SaveDialogOptions = {
      title: '另存为',
      defaultPath: req.defaultDir ? join(req.defaultDir, baseName) : baseName,
      filters: [
        { name: `${ext.toUpperCase()} 文件`, extensions: [ext] },
        { name: '所有文件', extensions: ['*'] },
      ],
      buttonLabel: '保存',
    };
    const focused = BrowserWindow.getFocusedWindow();
    const result =
      showSave !== undefined
        ? focused
          ? await showSave(focused, options)
          : await showSave(options)
        : focused
          ? await dialog.showSaveDialog(focused, options)
          : await dialog.showSaveDialog(options);
    if (result.canceled || !result.filePath) {
      return { path: null };
    }
    let target = result.filePath;
    if (!extname(target)) {
      target = `${target}.${ext}`;
    }
    try {
      await fsWriteFile(target, req.content, 'utf-8');
      log.info('file saved as', { path: target, bytes: Buffer.byteLength(req.content, 'utf-8') });
      return { path: target };
    } catch (err) {
      throw writeError(target, err);
    }
  });

  // file.stat：读文件/目录元数据 + 类型分类
  // 目录返回 isDir:true（kind 置 binary 占位），渲染层据此打开目录浏览页；
  // 文件返回 isDir:false + 类型分类。不再对目录抛错——统一入口
  // （按钮/拖放/地址栏）拿到路径后先判类型再路由，选择文件夹就打开文件夹。
  registerHandler(ipcMain, 'file.stat', async (req) => {
    let info;
    try {
      info = await fsStat(req.path);
    } catch (err) {
      log.warn('file.stat failed', { path: req.path, error: String(err) });
      throw new IpcError(IpcErrorCode.NOT_FOUND, `File not found: ${req.path}`, {
        channel: 'file.stat',
      });
    }
    const name = basename(req.path);
    if (!info.isFile()) {
      return {
        name,
        size: 0,
        ext: '',
        mimeType: 'application/octet-stream',
        kind: 'binary',
        isDir: true,
      };
    }
    return {
      name,
      size: info.size,
      ext: name.lastIndexOf('.') > 0 ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : '',
      mimeType: inferMimeType(name),
      kind: classifyFileKind(name),
      isDir: false,
    };
  });

  // file.read：按 UTF-8 读取文本内容（有界读取 + 截断语义）
  // 先 stat 拿真实大小，只分配 min(size, maxBytes) 内存顺序读取——
  // 旧实现先整读整个文件再判超限拒载，误选超大文件（如 500MB 日志）时
  // 主进程要付出全量内存（实测 +451MB RSS）才能报错；截断语义下内存
  // 峰值恒为 maxBytes，超大文件显示前 maxBytes 字节并由渲染层加横幅。
  registerHandler(ipcMain, 'file.read', async (req) => {
    const maxBytes = req.maxBytes ?? DEFAULT_MAX_BYTES;
    let info;
    try {
      info = await fsStat(req.path);
    } catch (err) {
      log.warn('file.read stat failed', { path: req.path, error: String(err) });
      throw new IpcError(IpcErrorCode.NOT_FOUND, `Cannot read file: ${req.path}`, {
        channel: 'file.read',
      });
    }
    if (!info.isFile()) {
      throw new IpcError(IpcErrorCode.NOT_FOUND, `Cannot read file: ${req.path}`, {
        channel: 'file.read',
      });
    }
    const totalSize = info.size;
    const toRead = Math.min(totalSize, maxBytes);
    let content = '';
    let readBytes = 0;
    if (toRead > 0) {
      try {
        const fh = await fsOpen(req.path, 'r');
        try {
          const buf = Buffer.alloc(toRead);
          // 顺序填满 buf；read 返回 0 视为 EOF（文件被并发截短的兜底）
          while (readBytes < toRead) {
            const { bytesRead } = await fh.read(buf, readBytes, toRead - readBytes, readBytes);
            if (bytesRead === 0) break;
            readBytes += bytesRead;
          }
          // 截断可能落在多字节 UTF-8 字符中间，末尾会产生替换符（U+FFFD）——预览场景可接受
          content = buf.subarray(0, readBytes).toString('utf8');
        } finally {
          await fh.close();
        }
      } catch (err) {
        log.warn('file.read failed', { path: req.path, error: String(err) });
        throw new IpcError(IpcErrorCode.NOT_FOUND, `Cannot read file: ${req.path}`, {
          channel: 'file.read',
        });
      }
    }
    return { content, truncated: totalSize > maxBytes, totalSize, readBytes };
  });

  // file.open：原生文件选择器（单选）。
  // 仅 openFile（Windows 不支持 openFile+openDirectory 组合，目录入口已移除）。
  // 选中后由渲染层统一路由（file.stat 判类型 → 文件开查看器）。
  registerHandler(ipcMain, 'file.open', async (req) => {
    const focused = BrowserWindow.getFocusedWindow();
    const options: Electron.OpenDialogOptions = {
      title: req.title ?? '打开文件',
      properties: ['openFile'],
    };
    const result = focused
      ? await dialog.showOpenDialog(focused, options)
      : await dialog.showOpenDialog(options);
    if (result.canceled || result.filePaths.length === 0) {
      return { path: null };
    }
    return { path: result.filePaths[0]! };
  });

  // file.dir：列目录（子目录在前 + 文件按名排序）
  registerHandler(ipcMain, 'file.dir', async (req) => {
    const fsReaddir = deps.readdir ?? readdir;
    const fsStat = deps.stat ?? stat;
    let names: string[];
    try {
      names = await fsReaddir(req.path);
    } catch (err) {
      log.warn('file.dir failed', { path: req.path, error: String(err) });
      throw new IpcError(IpcErrorCode.NOT_FOUND, `Directory not found: ${req.path}`, {
        channel: 'file.dir',
      });
    }

    const entries = await Promise.all(
      names.map(async (name) => {
        const fullPath = join(req.path, name);
        let info;
        try {
          info = await fsStat(fullPath);
        } catch {
          // 单个条目 stat 失败（如权限/幽灵文件）跳过，不拖垮整个目录
          return null;
        }
        if (info.isDirectory()) {
          return { name, path: fullPath, kind: 'binary' as const, isDir: true, size: 0 };
        }
        return {
          name,
          path: fullPath,
          kind: classifyFileKind(name),
          isDir: false,
          size: info.size,
        };
      }),
    );

    const valid = entries.filter((e): e is NonNullable<typeof e> => e !== null);
    // 子目录在前（字母序），其后文件按名排序（字母序，忽略大小写）
    valid.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    });
    log.info('file.dir listed', {
      path: req.path,
      count: valid.length,
      dirs: valid.filter((e) => e.isDir).length,
    });
    return { entries: valid };
  });
}
