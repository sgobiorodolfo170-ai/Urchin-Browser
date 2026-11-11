/**
 * 本地文件关联 · 注册表读写（经 reg.exe，系统自带，零依赖）
 *
 * 职责：
 * 1. registerAssociations：把扩展名关联条目写入 HKCU（reg.exe add）
 * 2. getRegistrationState：查询已登记扩展名（Capabilities\FileAssociations）
 *    与应用级登记是否指向当前 exe
 * 3. unregisterAssociations：清除本应用写过的关联项（修复 / 卸载前清理）
 *
 * reg.exe 以 execFile 注入（默认 child_process.execFile）：
 * - 便于单测（vitest jsdom 下 child_process 无法 mock，注入 mock 实现）
 * - 与 settings-manager 注入 mock 持久层、files 模块注入 mock fs 同一约定
 *
 * 状态查询为什么按 Capabilities 而不是 `.ext` 默认值：
 * 新模型不再改写 `.ext` 默认值（见 associations.ts），且 Win10/11 的实际
 * 默认由 `UserChoice`（带 hash）决定——读 `.ext` 默认值会把「系统默认已换成
 * 别的应用」误报成「已关联本应用」，也会把「只登记了能力但用户还没确认」
 * 误报成默认。Capabilities\FileAssociations 才是「本应用已登记」的真实信号。
 */
import { execFile as execFileDefault } from 'node:child_process';
import {
  buildAllRegistryEntries,
  buildAppRemovals,
  buildExtensionRemovals,
  buildProgId,
  exeBaseName,
  DEFAULT_BROWSER_CLIENT_KEY,
  type RegistryEntry,
  type RegistryRemoval,
} from './associations';

/** reg.exe 执行器类型（默认 node:child_process.execFile）。 */
export type RegExec = (
  command: string,
  args: readonly string[],
  options: { windowsHide: boolean },
  callback: (error: Error | null, stdout: string, stderr: string) => void,
) => void;

/** 依赖：reg.exe 执行器（可注入 mock）。 */
export interface AssociationDeps {
  readonly regExec?: RegExec;
}

/** Capabilities 键（与 associations.ts 保持一致）。 */
const CAPABILITIES_FILE_ASSOCIATIONS = `HKCU\\Software\\Clients\\StartMenuInternet\\${DEFAULT_BROWSER_CLIENT_KEY}\\Capabilities\\FileAssociations`;

/**
 * 构造 reg.exe add 的参数（纯函数，便于单测锁定语法）。
 *
 * 2026-11-09 修复：旧实现把 `/f` 前置又在末尾重复一次（`add KEY /f /v ... /f`），
 * reg.exe 会报「错误: 无效语法」，导致「设为默认浏览器」与全部「设为默认
 * 打开方式」100% 失败。reg.exe 不接受重复的 `/f`，这里统一只保留一个并置于末尾。
 */
export function buildRegAddArgs(entry: RegistryEntry): readonly string[] {
  const args = ['add', entry.key];
  if (entry.valueName === '/d') {
    // 默认值：/ve 表示键的 (默认) 值
    args.push('/ve', '/d', entry.value, '/f');
  } else {
    args.push('/v', entry.valueName, '/t', 'REG_SZ', '/d', entry.value, '/f');
  }
  return args;
}

/**
 * 构造 reg.exe delete 的参数（valueName 语义：
 * - `null` → 删除整个键
 * - `'/ve'` → 删除键的 (默认) 值
 * - 其它 → 删除指定值名
 */
export function buildRegDeleteArgs(removal: RegistryRemoval): readonly string[] {
  if (removal.valueName === null) return ['delete', removal.key, '/f'];
  if (removal.valueName === '/ve') return ['delete', removal.key, '/ve', '/f'];
  return ['delete', removal.key, '/v', removal.valueName, '/f'];
}

/** reg.exe add 单个条目（带重试以抵抗偶发并发写冲突）。 */
function regAdd(exec: RegExec, entry: RegistryEntry, retries = 1): Promise<void> {
  const args = buildRegAddArgs(entry);
  return new Promise((resolve, reject) => {
    exec('reg.exe', args, { windowsHide: true }, (error, _stdout, stderr) => {
      if (!error) {
        resolve();
        return;
      }
      if (retries > 0) {
        regAdd(exec, entry, retries - 1)
          .then(resolve)
          .catch(() => reject(new Error(`reg.exe add failed: ${stderr || String(error)}`)));
        return;
      }
      reject(new Error(`reg.exe add failed: ${stderr || String(error)}`));
    });
  });
}

/**
 * reg.exe delete 单个删除目标。
 *
 * 返回值仅表示「命令是否成功」：键/值本就不存在时 reg.exe 返回码 1，
 * 清理动作按幂等处理（不因此中断，也不当失败上报）。
 */
function regDelete(exec: RegExec, removal: RegistryRemoval): Promise<boolean> {
  const args = buildRegDeleteArgs(removal);
  return new Promise((resolve) => {
    exec('reg.exe', args, { windowsHide: true }, (error) => resolve(!error));
  });
}

/** reg.exe query 原始输出（失败返回 null）。 */
function regQuery(exec: RegExec, key: string, valueName?: string): Promise<string | null> {
  const args = valueName
    ? ['query', key, valueName === '/d' ? '/ve' : '/v', ...(valueName === '/d' ? [] : [valueName])]
    : ['query', key];
  return new Promise((resolve) => {
    exec('reg.exe', args, { windowsHide: true }, (error, stdout) => resolve(error ? null : stdout));
  });
}

/**
 * 写入一组注册表条目；任一失败抛错（由 handler 层装箱）。
 */
export async function registerRegistryEntries(
  entries: readonly RegistryEntry[],
  deps: AssociationDeps = {},
): Promise<{ registered: number }> {
  const exec = deps.regExec ?? execFileDefault;
  for (const entry of entries) {
    await regAdd(exec, entry);
  }
  return { registered: entries.length };
}

/**
 * 注册一组扩展名的文件关联（写入 HKCU\Software\Classes + Capabilities）。
 * 应用级条目（Applications\<exe> / Capabilities / RegisteredApplications）
 * 随本调用一次性写好，扩展名条目逐个写入；任一失败抛错（由 handler 层装箱）。
 *
 * @param exts 扩展名数组（可含点前缀，自动归一）
 * @param exePath 浏览器可执行文件绝对路径（process.execPath）
 */
export async function registerAssociations(
  exts: readonly string[],
  exePath: string,
  deps: AssociationDeps = {},
  launchArgs: readonly string[] = [],
): Promise<{ registered: number }> {
  const entries = buildAllRegistryEntries(exts, exePath, launchArgs);
  return registerRegistryEntries(entries, deps);
}

/** 已登记状态（供设置页展示）。 */
export interface RegistrationState {
  /** 已登记进 Capabilities\FileAssociations 的扩展名（小写、不含点）。 */
  readonly registered: ReadonlySet<string>;
  /** `Applications\<exe>` 应用级登记是否存在。 */
  readonly appRegistered: boolean;
  /** 应用级登记的命令是否指向当前 exe（false = 指向旧位置/未登记）。 */
  readonly exeMatches: boolean;
}

/**
 * 解析 `reg query ...\Capabilities\FileAssociations` 的输出。
 *
 * 行格式：`    .mp4    REG_SZ    UrchinBrowser.mp4`
 * （默认值行的值名是本地化的「(默认)」，不是点开头，天然被忽略。）
 */
export function parseCapabilityExtensions(stdout: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^\s+(\.[^\s]+)\s+REG_\w+\s+(\S+)\s*$/.exec(line);
    if (!match) continue;
    const ext = match[1]!.slice(1).toLowerCase();
    const progId = match[2]!;
    if (!ext) continue;
    map.set(ext, progId);
  }
  return map;
}

/**
 * 查询当前登记状态：2 次 reg.exe 调用（与扩展名数量无关）。
 *
 * 旧实现按扩展名逐个 `reg query .ext /ve`：50 个扩展 = 50 次进程启动、
 * 1~3 秒，且判定口径与实际默认（UserChoice）不符。
 */
export async function getRegistrationState(
  exePath: string,
  deps: AssociationDeps = {},
): Promise<RegistrationState> {
  const exec = deps.regExec ?? execFileDefault;
  const capabilities = await regQuery(exec, CAPABILITIES_FILE_ASSOCIATIONS);
  const registered = new Set<string>();
  if (capabilities) {
    for (const [ext, progId] of parseCapabilityExtensions(capabilities)) {
      // 只认本应用的 ProgID（防其它软件写到同名 Capabilities 时被误判）
      if (progId.startsWith('UrchinBrowser.')) registered.add(ext);
    }
  }

  const appKey = `HKCU\\Software\\Classes\\Applications\\${exeBaseName(exePath)}\\shell\\open\\command`;
  const appCommand = await regQuery(exec, appKey, '/d');
  const appRegistered = appCommand !== null;
  const exeMatches =
    appCommand?.toLowerCase().includes(exePath.replace(/\//g, '\\').toLowerCase()) === true;
  return { registered, appRegistered, exeMatches };
}

/**
 * 兼容旧签名的「已登记扩展名」查询（只读 Capabilities，不判断 exe 指向）。
 *
 * @param exts 待查询扩展名；返回其与已登记集合的交集
 */
export async function getRegisteredExtensions(
  exts: readonly string[],
  deps: AssociationDeps = {},
): Promise<ReadonlySet<string>> {
  const state = await getRegistrationState(process.execPath, deps);
  const result = new Set<string>();
  for (const raw of exts) {
    const ext = raw.toLowerCase().replace(/^\./, '');
    if (state.registered.has(ext)) result.add(ext);
  }
  return result;
}

/** 清理范围：只清扩展名 / 只清应用级 / 两者都清。 */
export type UnregisterScope = 'extensions' | 'app' | 'all';

/** 清理选项。 */
export interface UnregisterOptions {
  /** 要清理的扩展名（scope 含 extensions 时使用）。 */
  readonly exts?: readonly string[];
  /** 当前 exe 路径（scope 含 app 时用于定位 Applications\<exe> 键）。 */
  readonly exePath?: string;
  /** 清理范围，默认 extensions。 */
  readonly scope?: UnregisterScope;
}

/** 清理结果：attempted = 发起删除的目标数，removed = reg.exe 成功数。 */
export interface UnregisterResult {
  readonly attempted: number;
  readonly removed: number;
}

/**
 * 清除本应用写过的文件关联项（幂等）。
 *
 * 安全边界：
 * - 只删 `UrchinBrowser.<ext>` 前缀的 ProgID 键与 `.ext\OpenWithProgids` 下
 *   本应用的值，不动其它应用的登记；
 * - `.ext` 默认值只在确认它等于本应用 ProgID 时才清（旧版本写过的残留），
 *   避免误删别的应用设置的默认；
 * - 键/值本不存在属正常（幂等清理），不计为失败。
 */
export async function unregisterAssociations(
  opts: UnregisterOptions,
  deps: AssociationDeps = {},
): Promise<UnregisterResult> {
  const exec = deps.regExec ?? execFileDefault;
  const scope = opts.scope ?? 'extensions';
  let attempted = 0;
  let removed = 0;

  const remove = async (removal: RegistryRemoval): Promise<void> => {
    attempted += 1;
    if (await regDelete(exec, removal)) removed += 1;
  };

  if (scope === 'extensions' || scope === 'all') {
    for (const raw of opts.exts ?? []) {
      const ext = raw.toLowerCase().replace(/^\./, '');
      for (const removal of buildExtensionRemovals(ext)) {
        await remove(removal);
      }
      // 旧版本把 `.ext` 默认值改成过我们的 ProgID：仅在确实等于时清掉
      const extKey = `HKCU\\Software\\Classes\\.${ext}`;
      const current = await regQuery(exec, extKey, '/d');
      if (current?.includes(buildProgId(ext))) {
        await remove({ key: extKey, valueName: '/ve' });
      }
    }
  }

  if ((scope === 'app' || scope === 'all') && opts.exePath) {
    for (const removal of buildAppRemovals(opts.exePath)) {
      await remove(removal);
    }
  }

  return { attempted, removed };
}
