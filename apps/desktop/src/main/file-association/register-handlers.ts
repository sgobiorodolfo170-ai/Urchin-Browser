/**
 * 文件关联域 IPC Handler 注册（file-association.*）
 *
 * 职责：
 * 1. file-association.getStatus：查询三组（音视频/文档/图片）已登记扩展名数、
 *    当前 exe 路径、是否指向旧位置（供设置页「默认应用」显示状态）
 * 2. file-association.register：把某分组（或勾选的）扩展名写入 HKCU 注册表，
 *    使浏览器出现在 Windows「打开方式」与「默认应用」候选列表
 * 3. file-association.unregister：清除本应用写过的关联项（幂等修复入口）
 * 4. file-association.setDefaultBrowser：登记默认浏览器能力并打开系统默认应用页
 *
 * 安全：入参/出参 zod 校验；注册表写入目标固定为 HKCU\Software\Classes 与
 * 本应用的 StartMenuInternet 客户端键，扩展名经白名单校验（必须是已分类且
 * ASSOCIABLE_EXTENSIONS 命中的扩展名，防注入任意注册表键）。
 */
import { shell, type IpcMain } from 'electron';
import { IpcError, IpcErrorCode, registerHandler } from '@urchin/ipc-contract';
import { createLogger } from '@urchin/logger';
import { classifyFileKind, getExtensionsForKind } from '../files/file-kind';
import {
  ASSOCIATION_GROUPS,
  buildDefaultAppsSettingsUri,
  buildDefaultBrowserRegistryEntries,
  getExtensionsForGroup,
  type AssociationGroupId,
} from './associations';
import {
  getRegistrationState,
  registerAssociations,
  registerRegistryEntries,
  unregisterAssociations,
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

/** 全部三组的扩展名并集（清理入口用）。 */
function resolveAllExtensions(): readonly string[] {
  const set = new Set<string>();
  for (const group of ASSOCIATION_GROUPS) {
    for (const ext of getExtensionsForGroup(group)) {
      if (isKnownExtension(ext)) set.add(ext);
    }
  }
  return [...set];
}

/** 按前端勾选过滤扩展名；未传 extensions 时保持整组。 */
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
  // 开发模式（`electron <appDir>`）登记的命令会带应用目录参数，指向 node_modules
  // 里的开发可执行文件——设置页据此显示警示，避免用户误以为已装好默认应用。
  const devMode = (launchArgs?.length ?? 0) > 0;

  // file-association.getStatus：各分组已登记扩展名数 + 应用级登记状态
  registerHandler(ipcMain, 'file-association.getStatus', async () => {
    const state = await getRegistrationState(exePath, regDeps);
    const groups: Record<string, { registered: number; total: number; extensions: string[] }> = {};
    for (const group of ASSOCIATION_GROUPS) {
      const exts = getExtensionsForGroup(group).filter(isKnownExtension);
      groups[group.id] = {
        registered: exts.filter((ext) => state.registered.has(ext)).length,
        total: exts.length,
        extensions: [...exts],
      };
    }
    return {
      groups,
      exePath,
      devMode,
      appRegistered: state.appRegistered,
      exeMatches: state.exeMatches,
    };
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

  // file-association.unregister：清除本应用关联（幂等修复入口）
  registerHandler(ipcMain, 'file-association.unregister', async (req) => {
    const scope = req.scope ?? 'extensions';
    let exts: readonly string[] = [];
    if (scope !== 'app') {
      exts = req.group
        ? resolveSelectedExtensions(req.group, req.extensions)
        : (req.extensions ?? resolveAllExtensions()).filter(isKnownExtension);
    }
    if (scope !== 'app' && exts.length === 0) {
      throw new IpcError(IpcErrorCode.VALIDATION, 'No extensions selected to unregister', {
        channel: 'file-association.unregister',
      });
    }
    log.info('file-association.unregister', { scope, count: exts.length });
    const result = await unregisterAssociations({ exts, exePath, scope }, regDeps);
    return { ok: true as const, removed: result.removed, attempted: result.attempted };
  });

  // file-association.openSettings：只打开系统「默认应用」页（不写注册表），
  // 供设置页「打开系统默认应用」按钮与清理关联后的引导使用。
  registerHandler(ipcMain, 'file-association.openSettings', async () => {
    for (const uri of [buildDefaultAppsSettingsUri(), 'ms-settings:defaultapps']) {
      try {
        await shell.openExternal(uri);
        return { ok: true as const };
      } catch (err) {
        log.warn('open default apps settings failed', { uri, error: String(err) });
      }
    }
    return { ok: false as const };
  });

  // file-association.setDefaultBrowser：登记默认浏览器能力并打开系统默认应用页
  registerHandler(ipcMain, 'file-association.setDefaultBrowser', async () => {
    try {
      await registerRegistryEntries(
        buildDefaultBrowserRegistryEntries(exePath, launchArgs),
        regDeps,
      );
      let openedSettings = false;
      // 优先打开本应用专属的「默认应用」页（可直接点「设为默认」），
      // 老版本 Windows 忽略 registeredAppUser 参数时回退到总览页。
      for (const uri of [buildDefaultAppsSettingsUri(), 'ms-settings:defaultapps']) {
        try {
          await shell.openExternal(uri);
          openedSettings = true;
          break;
        } catch (err) {
          log.warn('open default apps settings failed', { uri, error: String(err) });
        }
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
