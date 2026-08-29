/**
 * 编辑器草稿域 IPC Handler 注册（editor.*）+ 启动清扫
 *
 * 职责：编辑会话的自动临时保存（防崩溃丢失）——editor.saveDraft / editor.cleanupDraft。
 *
 * 设计理由（agents.md §六 跨进程边界 + 安全）：
 * - 草稿键（key）由渲染层从原文件绝对路径哈希生成——原路径不出本机；
 *   主进程以 key 拼接 editor-drafts 目录内路径，schema 层白名单校验
 *   （仅字母/数字/连字符），无路径入参、无目录遍历面
 * - 草稿生命周期：编辑中防抖写入 → 保存完成/放弃更改/关闭确认后清理；
 *   应用启动时 sweepDrafts 清扫上一会话残留（v1 草稿仅会话内防丢，
 *   不做崩溃恢复 UI）
 * - 隐私（agents.md §六）：日志只记 key 与字节数，不记内容
 */
import type { IpcMain } from 'electron';
import { join } from 'node:path';
import { readdir, rm, unlink, writeFile } from 'node:fs/promises';
import { registerHandler } from '@urchin/ipc-contract';
import { createLogger } from '@urchin/logger';

const log = createLogger('editor-drafts');

/** 编辑器 handler 注册依赖（fs 经 DI 便于单测，惯例同 file 域）。 */
export interface EditorHandlersDeps {
  readonly ipcMain: IpcMain;
  /** 草稿目录绝对路径（<dataDir>/editor-drafts，ensureDataDir 预创建）。 */
  readonly draftsDir: string;
  readonly writeFile?: typeof writeFile;
  readonly unlink?: typeof unlink;
}

/** 草稿文件路径（key 已过 schema 白名单校验，此处纯拼接）。 */
export function resolveDraftPath(draftsDir: string, key: string): string {
  return join(draftsDir, key);
}

/** 注册 editor.* handler。 */
export function registerEditorHandlers(deps: EditorHandlersDeps): void {
  const writeFileFs = deps.writeFile ?? writeFile;
  const unlinkFs = deps.unlink ?? unlink;

  registerHandler(deps.ipcMain, 'editor.saveDraft', async (req) => {
    const draftPath = resolveDraftPath(deps.draftsDir, req.key);
    await writeFileFs(draftPath, req.content, 'utf-8');
    log.info('draft saved', { key: req.key, bytes: Buffer.byteLength(req.content, 'utf-8') });
    return { draftPath };
  });

  registerHandler(deps.ipcMain, 'editor.cleanupDraft', async (req) => {
    const draftPath = resolveDraftPath(deps.draftsDir, req.key);
    try {
      await unlinkFs(draftPath);
      log.info('draft cleaned', { key: req.key });
      return { removed: true };
    } catch {
      // 草稿不存在（未触发过自动保存）→ 视为已清理
      return { removed: false };
    }
  });
}

/** 启动清扫：删除草稿目录下全部残留（目录本身保留；目录不存在则跳过）。 */
export async function sweepDrafts(
  draftsDir: string,
  deps?: { readdir?: typeof readdir; rm?: typeof rm },
): Promise<void> {
  const readdirFs = deps?.readdir ?? readdir;
  const rmFs = deps?.rm ?? rm;
  let names: string[];
  try {
    names = await readdirFs(draftsDir);
  } catch {
    return;
  }
  await Promise.all(names.map((n) => rmFs(join(draftsDir, n), { recursive: true, force: true })));
  if (names.length > 0) {
    log.info('stale drafts swept', { count: names.length });
  }
}
