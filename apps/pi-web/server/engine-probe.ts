import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { VERSION } from '@earendil-works/pi-coding-agent';
import { runtimeBaseCandidates } from './dsh/preset-clones.js';
import type { EngineStatus } from './protocol.js';
import { probeClaudeCode } from './universal/drivers/claude-code.js';
import type { LocalPackage } from './update-check.js';
import { probeGlobalPackage } from './global-loader.js';

export interface EnginePackageMeta {
  id: string;
  packageName: string;
  installCommand: string;
}

export const ENGINE_PACKAGES: Record<string, EnginePackageMeta> = {
  pi: {
    id: 'pi',
    packageName: '@earendil-works/pi-coding-agent',
    installCommand: 'npm i -g @earendil-works/pi-coding-agent',
  },
  dsh: {
    id: 'dsh',
    packageName: '@deepseek-ai/dsh',
    installCommand: 'npm i -g @deepseek-ai/dsh',
  },
  claude: {
    id: 'claude',
    packageName: '@anthropic-ai/claude-code',
    installCommand: 'npm i -g @anthropic-ai/claude-code',
  },
  durable: {
    id: 'durable',
    packageName: '@earendil-works/pi-durable',
    installCommand: 'npm i -g @earendil-works/pi-durable',
  },
};

/** 探针缓存 TTL：5 秒（短时多次探测免除重复频繁执行进程调用） */
const CACHE_TTL_MS = 5000;

interface EngineEntry {
  status: EngineStatus;
  probedAt: number;
}

/** 引擎状态原子字典：单一事实源，收敛 status / probedAt 二元组，杜绝独立状态撕裂 */
const engineRegistry = new Map<string, EngineEntry>([
  [
    'pi',
    {
      status: {
        id: 'pi',
        installed: true,
        packageName: ENGINE_PACKAGES.pi.packageName,
        version: VERSION,
      },
      probedAt: 0,
    },
  ],
  [
    'dsh',
    {
      status: { id: 'dsh', installed: false, packageName: ENGINE_PACKAGES.dsh.packageName },
      probedAt: 0,
    },
  ],
  [
    'claude',
    {
      status: { id: 'claude', installed: false, packageName: ENGINE_PACKAGES.claude.packageName },
      probedAt: 0,
    },
  ],
  [
    'durable',
    {
      status: { id: 'durable', installed: false, packageName: ENGINE_PACKAGES.durable.packageName },
      probedAt: 0,
    },
  ],
]);

/**
 * 探测 Pi 原生引擎状态（作为内置/捆绑引擎恒存在）。
 */
function probePi(): EngineStatus {
  return {
    id: 'pi',
    installed: true,
    packageName: ENGINE_PACKAGES.pi.packageName,
    version: VERSION,
  };
}

/**
 * 快速探测 DSH 引擎全局包/运行时树是否已安装。
 * 1. 优先检查常见全局 node_modules / 候选路径中的 @deepseek-ai/dsh package.json 与 dsh-base；
 * 2. 回退通过命令行探针执行 `dsh --version`。
 */
async function probeDsh(): Promise<EngineStatus> {
  const pkgName = ENGINE_PACKAGES.dsh.packageName;

  // 0. 通用全局包探测器（覆盖 fnm / nvm / pnpm / 全局 prefix 等）
  try {
    const globalProbe = probeGlobalPackage(pkgName);
    if (globalProbe.installed) {
      return { id: 'dsh', installed: true, packageName: pkgName, version: globalProbe.version };
    }
  } catch {
    /* ignore */
  }

  // 1. 路径快速探测（纯 fs 访问，无进程派生开销）
  try {
    for (const root of runtimeBaseCandidates()) {
      if (!root) continue;
      // A. 直接在全局或候选 node_modules 中找到 @deepseek-ai/dsh 包目录
      const dshPkgJson = join(root, '@deepseek-ai', 'dsh', 'package.json');
      if (existsSync(dshPkgJson)) {
        try {
          const pkg = JSON.parse(readFileSync(dshPkgJson, 'utf8')) as { version?: string };
          return { id: 'dsh', installed: true, packageName: pkgName, version: pkg.version };
        } catch {
          return { id: 'dsh', installed: true, packageName: pkgName };
        }
      }

      // B. 检查平铺运行树（@deepseek-ai/dsh-base）
      const flatBase = join(root, '@deepseek-ai', 'dsh-base', 'cordis.patch.yml');
      const flatBoot = join(root, '@deepseek-ai', 'dsh-app-boot', 'lib', 'index.js');
      if (existsSync(flatBase) && existsSync(flatBoot)) {
        return { id: 'dsh', installed: true, packageName: pkgName };
      }

      // C. 检查嵌套运行树（@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-base）
      const nestedBase = join(
        root,
        '@deepseek-ai',
        'dsh',
        'node_modules',
        '@deepseek-ai',
        'dsh-base',
        'cordis.patch.yml',
      );
      const nestedBoot = join(
        root,
        '@deepseek-ai',
        'dsh',
        'node_modules',
        '@deepseek-ai',
        'dsh-app-boot',
        'lib',
        'index.js',
      );
      if (existsSync(nestedBase) && existsSync(nestedBoot)) {
        return { id: 'dsh', installed: true, packageName: pkgName };
      }
    }
  } catch {
    /* ignore fs errors */
  }

  // 2. 命令行回退探测（检查 PATH 中是否有可用的 dsh CLI）
  try {
    const cliProbe = await new Promise<{ installed: boolean; version?: string }>((resolve) => {
      execFile(
        'dsh',
        ['--version'],
        {
          timeout: 3000,
          shell: process.platform === 'win32',
        },
        (err, stdout) => {
          if (err) {
            resolve({ installed: false });
          } else {
            const v = stdout.trim();
            resolve({ installed: true, version: v || undefined });
          }
        },
      );
    });
    if (cliProbe.installed) {
      return {
        id: 'dsh',
        installed: true,
        packageName: pkgName,
        version: cliProbe.version,
      };
    }
  } catch {
    /* ignore cli error */
  }

  return { id: 'dsh', installed: false, packageName: pkgName };
}

/**
 * 探测 Claude Code 引擎状态。
 */
async function probeClaude(force = false): Promise<EngineStatus> {
  const pkgName = ENGINE_PACKAGES.claude.packageName;
  try {
    const res = await probeClaudeCode();
    if (res.installed) {
      return {
        id: 'claude',
        installed: true,
        packageName: pkgName,
        version: res.version,
      };
    }
  } catch {
    /* ignore */
  }

  // 降级兜底：某些环境（如 fnm/nvm 目录未生成直接软链，或全局通过 npm 安装了包但 postinstall 尚未就绪）
  // 尝试通过全局包管理器探测是否已安装该包
  try {
    const globalProbe = probeGlobalPackage(pkgName, { refresh: force });
    if (globalProbe.installed) {
      return {
        id: 'claude',
        installed: true,
        packageName: pkgName,
        version: globalProbe.version,
      };
    }
  } catch {
    /* ignore */
  }

  return { id: 'claude', installed: false, packageName: pkgName };
}

/**
 * 探测 Pi Durable 引擎状态。
 * 检查当前项目或全局环境（npm -g, fnm, nvm 等）下是否安装了 @earendil-works/pi-durable。
 */
async function probeDurable(force = false): Promise<EngineStatus> {
  const pkgName = ENGINE_PACKAGES.durable.packageName;
  try {
    const probe = probeGlobalPackage(pkgName, { refresh: force });
    if (probe.installed) {
      return {
        id: 'durable',
        installed: true,
        packageName: pkgName,
        version: probe.version,
      };
    }
  } catch {
    /* ignore */
  }
  return { id: 'durable', installed: false, packageName: pkgName };
}

/**
 * 探测全部已知引擎并把结果写入注册表（带 TTL 缓存防抖）。
 * 引擎选择 UI 已移除：探测结果仅供 collectInstalledEngineTargets 把
 * 已安装的第三方引擎全局包纳入全量更新检查名录。
 */
async function probeAllEngines(force = false): Promise<void> {
  const now = Date.now();
  const entries = Array.from(engineRegistry.values());
  const allFresh = entries.every((e) => e.probedAt > 0 && now - e.probedAt < CACHE_TTL_MS);
  if (allFresh) return;
  const [pi, dsh, claude, durable] = await Promise.all([
    probePi(),
    probeDsh(),
    probeClaude(force),
    probeDurable(force),
  ]);
  const timestamp = Date.now();
  for (const res of [pi, dsh, claude, durable]) {
    engineRegistry.set(res.id, { status: res, probedAt: timestamp });
  }
}

/**
 * 收集已安装的第三方全局引擎包，供全量更新检查（check_updates_all）纳入统一检查名录。
 */
export function collectInstalledEngineTargets(): LocalPackage[] {
  const out: LocalPackage[] = [];
  for (const entry of engineRegistry.values()) {
    const status = entry.status;
    // pi-core 在 collectTargets 中已有独立专属条目（PI_CORE_PACKAGE），此处收纳其他已安装引擎全局包
    if (status.id !== 'pi' && status.installed && status.packageName && status.version) {
      out.push({
        name: status.packageName,
        version: status.version,
        kind: 'engine',
      });
    }
  }
  return out;
}

// 模块加载时预热后台探测
void probeAllEngines(true).catch(() => {});
