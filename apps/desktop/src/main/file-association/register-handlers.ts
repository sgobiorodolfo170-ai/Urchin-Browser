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
import { shell, type IpcMain } from 'electron';
import { IpcError, IpcErrorCode, registerHandler } from '@urchin/ipc-contract';
import { createLogger } from '@urchin/logger';
import { classifyFileKind, getExtensionsForKind } from '../files/file-kind';
import {
  ASSOCIATION_GROUPS,
  buildDefaultBrowserRegistryEntries,
  getExtensionsForGroup,
  getExtensionsByGroup,
  type AssociationGroupId,
} from './associations';
import {
  getRegisteredExtensions,
  registerAssociations,
  registerRegistryEntries,
  type AssociationDeps,
} from './register';

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

/** 按前端勾选过滤扩展名；未传 extensions 时保持整组注册。 */
function resolveSelectedExtensions(
  groupId: AssociationGroupId,
  requested: readonly string[] | undefined,
): readonly string[] {
  const allowed = resolveExtensions(groupId);
  if (requested === undefined) return allowed;
  const normalized = new Set(requested.map((ext) => ext.toLowerCase().replace(/^\./, '')));
  return allowed.filter((ext) => normalized.has(ext));
}

/** IPC handler 注册依赖。 */
export interface FileAssociationHandlersDeps extends AssociationDeps {
  readonly ipcMain: IpcMain;
  /** 浏览器可执行文件路径（process.execPath）。 */
  readonly exePath: string;
  /** 开发模式启动参数（Electron 需要应用目录作为首个参数）。 */
  readonly launchArgs?: readonly string[];
}

/**
 * 注册 file-association 域 IPC handler。
 */
export function registerFileAssociationHandlers(deps: FileAssociationHandlersDeps): void {
  const { ipcMain, exePath, regExec, launchArgs } = deps;
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

  // file-association.register：注册某分组（可只注册勾选的扩展名）
  registerHandler(ipcMain, 'file-association.register', async (req) => {
    const exts = resolveSelectedExtensions(req.group, req.extensions);
    if (exts.length === 0) {
      throw new IpcError(IpcErrorCode.VALIDATION, `No extensions selected for: ${req.group}`, {
        channel: 'file-association.register',
      });
    }
    log.info('file-association.register', { group: req.group, count: exts.length });
    try {
      await registerAssociations(exts, exePath, regDeps, launchArgs);
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

  // file-association.setDefaultBrowser：登记默认浏览器能力并打开系统默认应用页
  registerHandler(ipcMain, 'file-association.setDefaultBrowser', async () => {
    try {
      await registerRegistryEntries(
        buildDefaultBrowserRegistryEntries(exePath, launchArgs),
        regDeps,
      );
      let openedSettings = false;
      try {
        await shell.openExternal('ms-settings:defaultapps');
        openedSettings = true;
      } catch (err) {
        log.warn('open default apps settings failed', { error: String(err) });
      }
      return { ok: true as const, openedSettings };
    } catch (err) {
      log.warn('file-association.setDefaultBrowser failed', { error: String(err) });
      throw new IpcError(
        IpcErrorCode.INTERNAL,
        `注册默认浏览器失败：${err instanceof Error ? err.message : String(err)}`,
        { channel: 'file-association.setDefaultBrowser' },
      );
    }
  });
}
