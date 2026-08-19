/**
 * 文件关联域 IPC Handler 注册（file-association.*）
 *
 * 职责：
 * 1. file-association.getStatus：查询三个分组（音视频/文档/图片）各自
 *    已注册的扩展名数量（供设置页「默认应用」显示状态）
 * 2. file-association.register：把某分组的扩展名写入 HKCU 注册表，
 *    使浏览器出现在 Windows「打开方式」列表
 *
 * 安全：入参/出参 zod 校验；注册表写入目标固定为 HKCU\Software\Classes，
 * 扩展名经白名单校验（必须是已分类扩展名，防注入任意注册表键）。
 */
import type { IpcMain } from 'electron';
import { IpcError, IpcErrorCode, registerHandler } from '@urchin/ipc-contract';
import { createLogger } from '@urchin/logger';
import { classifyFileKind, getExtensionsForKind } from '../files/file-kind';
import {
  ASSOCIATION_GROUPS,
  getExtensionsForGroup,
  getExtensionsByGroup,
  type AssociationGroupId,
} from './associations';
import { getRegisteredExtensions, registerAssociations, type AssociationDeps } from './register';

const log = createLogger('file-association-ipc');

/** 合法扩展名白名单：来自分类表（EXT_KIND），防任意注册表路径注入。 */
function isKnownExtension(ext: string): boolean {
  return getExtensionsForKind(classifyFileKind(`x.${ext}`)).includes(ext);
}

/** 展开分组 id → 扩展名数组（含白名单过滤）。 */
function resolveExtensions(groupId: AssociationGroupId): readonly string[] {
  const group = ASSOCIATION_GROUPS.find((g) => g.id === groupId);
  if (!group) return [];
  return getExtensionsForGroup(group).filter(isKnownExtension);
}

/** IPC handler 注册依赖。 */
export interface FileAssociationHandlersDeps extends AssociationDeps {
  readonly ipcMain: IpcMain;
  /** 浏览器可执行文件路径（process.execPath）。 */
  readonly exePath: string;
}

/**
 * 注册 file-association 域 IPC handler。
 */
export function registerFileAssociationHandlers(deps: FileAssociationHandlersDeps): void {
  const { ipcMain, exePath, regExec } = deps;
  const regDeps: AssociationDeps = regExec ? { regExec } : {};

  // file-association.getStatus：各分组已注册扩展名数 + 清单
  registerHandler(ipcMain, 'file-association.getStatus', async () => {
    const byGroup = getExtensionsByGroup();
    const result: Record<string, { registered: number; total: number; extensions: string[] }> = {};
    for (const group of ASSOCIATION_GROUPS) {
      const exts = byGroup[group.id];
      const registered = await getRegisteredExtensions(exts, regDeps);
      result[group.id] = {
        registered: exts.filter((e) => registered.has(e)).length,
        total: exts.length,
        extensions: [...exts],
      };
    }
    return { groups: result };
  });

  // file-association.register：注册某分组的全部扩展名
  registerHandler(ipcMain, 'file-association.register', async (req) => {
    const exts = resolveExtensions(req.group);
    if (exts.length === 0) {
      throw new IpcError(IpcErrorCode.VALIDATION, `Unknown association group: ${req.group}`, {
        channel: 'file-association.register',
      });
    }
    log.info('file-association.register', { group: req.group, count: exts.length });
    try {
      await registerAssociations(exts, exePath, regDeps);
      return { ok: true, count: exts.length };
    } catch (err) {
      log.warn('file-association.register failed', { error: String(err) });
      throw new IpcError(
        IpcErrorCode.INTERNAL,
        `注册文件关联失败：${err instanceof Error ? err.message : String(err)}`,
        { channel: 'file-association.register' },
      );
    }
  });
}
