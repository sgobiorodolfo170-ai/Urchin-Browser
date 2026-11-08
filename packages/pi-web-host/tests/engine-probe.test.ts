/**
 * engine-probe.ts 单元测试（引擎收窄后：仅 pi）
 *
 * 覆盖 ENGINE_PACKAGES 目录收窄、probePi / probeEngine 状态、后台卸载拒绝、
 * 以及「无外部引擎依赖需随包检查」的 collectInstalledEngineTargets。
 *
 * 两个 mock 的原因：
 * 1. `@earendil-works/pi-coding-agent` 是 vendored 包，经 esbuild 别名打包，
 *    vitest 无法解析（与 agent-bridge.test.ts 同款处理），故用 vi.mock 提供 VERSION。
 * 2. engine-probe 在模块加载时会 `void probeAllEngines(true)`，会走 npm registry
 *    网络检查；单元测试必须离线确定，故把 update-check 换成桩（版本比较恒等 +
 *    拉取直接失败 → 更新信息 enrich 静默跳过）。
 */
import { describe, expect, it, vi } from 'vitest';

// vi.mock 工厂会被提升到文件顶部，引用的变量必须同样经 vi.hoisted 提升
const { PI_VERSION } = vi.hoisted(() => ({ PI_VERSION: '1.2.3-test' }));

vi.mock('@earendil-works/pi-coding-agent', () => ({
  VERSION: PI_VERSION,
}));

vi.mock('../src/pi-server/update-check.js', () => ({
  // 版本比较恒等：即使有 latest 也不会被判定为「有更新」
  compareVersions: () => 0,
  defaultFetcher: () => Promise.reject(new Error('network disabled in unit test')),
  fetchLatest: () => Promise.reject(new Error('network disabled in unit test')),
  NPM_DEFAULT_REGISTRY: 'https://registry.npmjs.org',
}));

import {
  ENGINE_PACKAGES,
  collectInstalledEngineTargets,
  getCachedEngineStatuses,
  isEngineUninstalling,
  isEngineUpdating,
  probeAllEngines,
  probeEngine,
  probePi,
  uninstallEngineBackground,
} from '../src/pi-server/engine-probe.js';

const PI_PACKAGE = '@earendil-works/pi-coding-agent';

describe('ENGINE_PACKAGES', () => {
  it('should only expose the pi engine after the engine narrowing', () => {
    expect(Object.keys(ENGINE_PACKAGES)).toEqual(['pi']);
  });

  it('should describe pi install metadata from ENGINE_CATALOG', () => {
    const pi = ENGINE_PACKAGES.pi;
    expect(pi).toBeDefined();
    expect(pi?.id).toBe('pi');
    expect(pi?.packageName).toBe(PI_PACKAGE);
    expect(pi?.installCommand).toContain(PI_PACKAGE);
  });

  it('should not expose removed engines', () => {
    for (const removed of ['dsh', 'claude', 'codex', 'agy', 'durable', 'universal']) {
      expect(ENGINE_PACKAGES[removed]).toBeUndefined();
    }
  });
});

describe('probePi', () => {
  it('should report pi as installed with the bundled VERSION', () => {
    const status = probePi();
    expect(status.id).toBe('pi');
    expect(status.installed).toBe(true);
    expect(status.packageName).toBe(PI_PACKAGE);
    expect(status.version).toBe(PI_VERSION);
  });
});

describe('probeEngine', () => {
  it('should return the installed pi status for id "pi"', async () => {
    const status = await probeEngine('pi');
    expect(status.id).toBe('pi');
    expect(status.installed).toBe(true);
    expect(status.version).toBe(PI_VERSION);
    expect(status.packageName).toBe(PI_PACKAGE);
  });

  it('should return installed=false for removed engines', async () => {
    for (const removed of ['dsh', 'claude', 'codex', 'durable']) {
      const status = await probeEngine(removed);
      expect(status.id).toBe(removed);
      expect(status.installed).toBe(false);
    }
  });

  it('should return installed=false for an unknown engine', async () => {
    const status = await probeEngine('does-not-exist');
    expect(status.installed).toBe(false);
    expect(status.id).toBe('does-not-exist');
  });
});

describe('probeAllEngines', () => {
  it('should list pi as the only installed engine', async () => {
    const engines = await probeAllEngines(true);
    const installed = engines.filter((e) => e.installed);
    expect(installed.map((e) => e.id)).toEqual(['pi']);
    expect(installed[0]?.version).toBe(PI_VERSION);
  });

  it('should keep non-pi entries reported as not installed', async () => {
    const engines = await probeAllEngines();
    for (const engine of engines) {
      if (engine.id !== 'pi') expect(engine.installed).toBe(false);
    }
  });
});

describe('getCachedEngineStatuses', () => {
  it('should include pi as installed and never claim a removed engine is installed', () => {
    const statuses = getCachedEngineStatuses();
    expect(statuses.find((s) => s.id === 'pi')?.installed).toBe(true);
    expect(statuses.filter((s) => s.id !== 'pi' && s.installed)).toEqual([]);
  });
});

describe('isEngineUpdating / isEngineUninstalling', () => {
  it('should be false by default', () => {
    expect(isEngineUpdating('pi')).toBe(false);
    expect(isEngineUninstalling('pi')).toBe(false);
  });

  it('should be false for unknown engines', () => {
    expect(isEngineUpdating('dsh')).toBe(false);
    expect(isEngineUninstalling('dsh')).toBe(false);
  });
});

describe('uninstallEngineBackground', () => {
  it('should refuse to uninstall the built-in pi engine', async () => {
    const res = await uninstallEngineBackground('pi');
    expect(res.ok).toBe(false);
    expect(res.error).toBeTruthy();
    expect(res.error).toContain('内置');
  });

  it('should refuse unknown or removed engines', async () => {
    const res = await uninstallEngineBackground('dsh');
    expect(res.ok).toBe(false);
    expect(res.error).toContain('dsh');

    const unknown = await uninstallEngineBackground('whatever');
    expect(unknown.ok).toBe(false);
    expect(unknown.error).toContain('whatever');
  });

  it('should accept an options argument without changing the refusal', async () => {
    const res = await uninstallEngineBackground('pi', { timeoutMs: 1000 });
    expect(res.ok).toBe(false);
  });
});

describe('collectInstalledEngineTargets', () => {
  it('should return an empty list when pi is the only engine', () => {
    expect(collectInstalledEngineTargets()).toEqual([]);
  });
});
