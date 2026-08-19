/**
 * 本地文件关联 · 注册表读写（经 reg.exe，系统自带，零依赖）
 *
 * 职责：
 * 1. registerAssociations：把扩展名关联条目写入 HKCU（reg.exe add）
 * 2. getAssociationStatus：查询扩展名是否已注册（reg.exe query .ext 默认值）
 *
 * reg.exe 以 execFile 注入（默认 child_process.execFile）：
 * - 便于单测（vitest jsdom 下 child_process 无法 mock，注入 mock 实现）
 * - 与 settings-manager 注入 mock 持久层、files 模块注入 mock fs 同一约定
 */
import { execFile as execFileDefault } from 'node:child_process';
import { buildAllRegistryEntries, buildProgId, type RegistryEntry } from './associations';

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

/** reg.exe add 单个条目（带重试以抵抗偶发并发写冲突）。 */
function regAdd(exec: RegExec, entry: RegistryEntry, retries = 1): Promise<void> {
  const args = ['add', entry.key, '/f'];
  if (entry.valueName === '/d') {
    // 默认值：/ve 表示键的 (默认) 值
    args.push('/ve', '/d', entry.value, '/f');
  } else {
    args.push('/v', entry.valueName, '/t', 'REG_SZ', '/d', entry.value, '/f');
  }
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
 * 注册一组扩展名的文件关联（写入 HKCU\Software\Classes）。
 * 全部条目逐一写入；任一失败抛错（由 handler 层装箱）。
 *
 * @param exts 扩展名数组（可含点前缀，自动归一）
 * @param exePath 浏览器可执行文件绝对路径（process.execPath）
 */
export async function registerAssociations(
  exts: readonly string[],
  exePath: string,
  deps: AssociationDeps = {},
): Promise<{ registered: number }> {
  const exec = deps.regExec ?? execFileDefault;
  const entries = buildAllRegistryEntries(exts, exePath);
  for (const entry of entries) {
    await regAdd(exec, entry);
  }
  return { registered: entries.length };
}

/**
 * 查询扩展名是否已注册关联（.ext 默认值 == 本浏览器 ProgID）。
 * reg.exe query 返回 0 且输出含 ProgID 视为已注册；键不存在（code 1）视为未注册。
 *
 * @param exts 扩展名数组
 * @returns 已注册的扩展名集合（小写、不含点）
 */
export async function getRegisteredExtensions(
  exts: readonly string[],
  deps: AssociationDeps = {},
): Promise<ReadonlySet<string>> {
  const exec = deps.regExec ?? execFileDefault;
  const registered = new Set<string>();
  for (const raw of exts) {
    const ext = raw.toLowerCase().replace(/^\./, '');
    const progId = buildProgId(ext);
    const args = ['query', `HKCU\\Software\\Classes\\.${ext}`, '/ve'];
    const ok = await new Promise<boolean>((resolve) => {
      exec('reg.exe', args, { windowsHide: true }, (error, stdout) => {
        if (error) {
          resolve(false);
          return;
        }
        resolve(stdout.includes(progId));
      });
    });
    if (ok) registered.add(ext);
  }
  return registered;
}
