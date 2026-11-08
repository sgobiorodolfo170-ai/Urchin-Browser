/**
 * plugin-manager.ts 生命周期单元测试
 *
 * 安装 / 卸载 / 激活 / 反激活 / catalog 合并。不用网络：
 * 只覆盖 path 安装与会被拒绝的来源；npm / github 分支留给 E2E。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  installPlugin,
  uninstallPlugin,
  activatePlugin,
  deactivatePlugin,
  deactivateAllPlugins,
  getActivePluginTools,
  getActivePluginIds,
  readCatalog,
  addCatalogEntry,
  removeCatalogEntry,
  scanPlugins,
  parseInstallSpec,
  type UiPluginCatalogEntry,
} from '../src/plugin-manager';

let agentDir: string;

beforeEach(() => {
  agentDir = mkdtempSync(join(tmpdir(), 'pi-plugin-life-'));
});

afterEach(async () => {
  await deactivateAllPlugins(agentDir);
  rmSync(agentDir, { recursive: true, force: true });
  const g = globalThis as Record<string, unknown>;
  delete g.__piTestActivations;
  delete g.__piTestDeactivations;
});

function writePlugin(id: string, manifest: Record<string, unknown>, entrySource?: string): string {
  const dir = join(agentDir, 'plugins', id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest));
  if (entrySource !== undefined) writeFileSync(join(dir, 'index.mjs'), entrySource);
  return dir;
}

describe('parseInstallSpec edge cases', () => {
  it('should treat an unscoped owner/repo as github with ref only when "#" present', () => {
    expect(parseInstallSpec('owner/repo#main')).toEqual({
      kind: 'github',
      repo: 'owner/repo',
      ref: 'main',
    });
  });

  it('should reject scoped paths that are not valid npm specs', () => {
    expect(parseInstallSpec('@scope/pkg/extra')).toEqual({ kind: 'invalid' });
  });

  it('should reject whitespace-only input', () => {
    expect(parseInstallSpec('   ')).toEqual({ kind: 'invalid' });
  });
});

describe('installPlugin / uninstallPlugin', () => {
  it('should reject an invalid plugin id', async () => {
    await expect(installPlugin(agentDir, 'owner/repo', '../evil')).resolves.toEqual({
      ok: false,
      error: 'invalid plugin id',
    });
  });

  it('should reject unsupported source kinds without touching the network', async () => {
    expect((await installPlugin(agentDir, 'https://example.com/p', 'p')).error).toBe(
      'unsupported source: url',
    );
    expect((await installPlugin(agentDir, '???', 'p')).error).toBe('unsupported source: invalid');
  });

  it('should copy a local plugin directory', async () => {
    const sourceDir = mkdtempSync(join(tmpdir(), 'pi-plugin-src-'));
    try {
      mkdirSync(join(sourceDir, 'client'), { recursive: true });
      writeFileSync(join(sourceDir, 'manifest.json'), JSON.stringify({ name: 'Local' }));
      writeFileSync(join(sourceDir, 'client', 'entry.mjs'), 'export default {};');

      await expect(installPlugin(agentDir, sourceDir, 'local-plugin')).resolves.toEqual({
        ok: true,
      });
      const plugins = await scanPlugins(agentDir);
      expect(plugins).toHaveLength(1);
      expect(plugins[0]).toMatchObject({ id: 'local-plugin', name: 'Local', hasClient: true });
    } finally {
      rmSync(sourceDir, { recursive: true, force: true });
    }
  });

  it('should remove an installed plugin and tolerate a missing one', async () => {
    writePlugin('gone', { name: 'Gone' });
    await uninstallPlugin(agentDir, 'gone');
    expect(await scanPlugins(agentDir)).toEqual([]);
    await expect(uninstallPlugin(agentDir, 'never-installed')).resolves.toBeUndefined();
  });
});

describe('activatePlugin / deactivatePlugin', () => {
  it('should treat a plugin without index.mjs as a static plugin', async () => {
    writePlugin('static-plugin', { name: 'Static' });
    await expect(activatePlugin(agentDir, 'static-plugin')).resolves.toEqual({ ok: true });
    expect(getActivePluginIds()).not.toContain('static-plugin');
  });

  it('should fail when the manifest is missing or invalid JSON', async () => {
    const dir = join(agentDir, 'plugins', 'broken');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'index.mjs'), 'export default function () {};');
    await expect(activatePlugin(agentDir, 'broken')).resolves.toEqual({
      ok: false,
      error: 'manifest.json missing or invalid',
    });
  });

  it('should reject a manifest that fails permission validation', async () => {
    writePlugin('strict', { name: 'Strict', apiVersion: 2 }, 'export default function () {};');
    const result = await activatePlugin(agentDir, 'strict');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('permissions');
  });

  it('should run a function-style activate and register its tools', async () => {
    writePlugin(
      'fn-plugin',
      { name: 'Fn', apiVersion: 1, permissions: ['tools'] },
      `export default (host) => {
        globalThis.__piTestActivations = (globalThis.__piTestActivations ?? 0) + 1;
        host.registerTool({ name: 'demo_tool', description: 'demo', exec: async () => 'ok' });
        return () => {
          globalThis.__piTestDeactivations = (globalThis.__piTestDeactivations ?? 0) + 1;
        };
      };`,
    );
    await expect(activatePlugin(agentDir, 'fn-plugin')).resolves.toEqual({ ok: true });
    expect(getActivePluginIds()).toContain('fn-plugin');
    expect(getActivePluginTools().map((t) => t.name)).toEqual(['demo_tool']);

    await deactivatePlugin(agentDir, 'fn-plugin');
    expect(getActivePluginIds()).not.toContain('fn-plugin');
    expect(getActivePluginTools()).toEqual([]);
    expect((globalThis as Record<string, unknown>).__piTestDeactivations).toBe(1);
  });

  it('should run an object-style activate', async () => {
    writePlugin(
      'obj-plugin',
      { name: 'Obj', apiVersion: 1 },
      `export default {
        activate(host) {
          host.registerTool({ name: 'obj_tool', description: 'demo', exec: async () => 1 });
        },
      };`,
    );
    await expect(activatePlugin(agentDir, 'obj-plugin')).resolves.toEqual({ ok: true });
    expect(getActivePluginTools().map((t) => t.name)).toEqual(['obj_tool']);
  });

  it('should be idempotent for an already-active plugin', async () => {
    writePlugin(
      'once',
      { name: 'Once', apiVersion: 1 },
      `export default () => {
        globalThis.__piTestActivations = (globalThis.__piTestActivations ?? 0) + 1;
      };`,
    );
    await activatePlugin(agentDir, 'once');
    await activatePlugin(agentDir, 'once');
    expect((globalThis as Record<string, unknown>).__piTestActivations).toBe(1);
  });

  it('should report a throwing activate as a failure', async () => {
    writePlugin(
      'thrower',
      { name: 'Thrower', apiVersion: 1 },
      'export default () => { throw new Error("activate boom"); };',
    );
    await expect(activatePlugin(agentDir, 'thrower')).resolves.toEqual({
      ok: false,
      error: 'activate boom',
    });
    expect(getActivePluginIds()).not.toContain('thrower');
  });

  it('should make deactivate idempotent and deactivate all plugins', async () => {
    writePlugin('a', { name: 'A', apiVersion: 1 }, 'export default () => undefined;');
    writePlugin('b', { name: 'B', apiVersion: 1 }, 'export default () => undefined;');
    await activatePlugin(agentDir, 'a');
    await activatePlugin(agentDir, 'b');
    expect(getActivePluginIds().sort()).toEqual(['a', 'b']);

    await deactivatePlugin(agentDir, 'a');
    await deactivatePlugin(agentDir, 'a');
    await deactivateAllPlugins(agentDir);
    expect(getActivePluginIds()).toEqual([]);
  });
});

describe('catalog merge', () => {
  it('should prepend builtin entries and mark custom ones as non-builtin', async () => {
    const builtin: UiPluginCatalogEntry[] = [
      { id: 'builtin-1', name: 'Builtin', source: 'bundled', builtin: true },
    ];
    await addCatalogEntry(agentDir, {
      id: 'custom-1',
      name: 'Custom',
      source: 'owner/repo',
      builtin: false,
    });
    const catalog = await readCatalog(agentDir, builtin);
    expect(catalog.map((e) => e.id)).toEqual(['builtin-1', 'custom-1']);
    expect(catalog[1]?.builtin).toBe(false);
  });

  it('should not duplicate a custom entry that shadows a builtin id', async () => {
    const builtin: UiPluginCatalogEntry[] = [
      { id: 'same', name: 'Builtin', source: 'bundled', builtin: true },
    ];
    await addCatalogEntry(agentDir, { id: 'same', name: 'Custom', source: 'owner/repo' });
    const catalog = await readCatalog(agentDir, builtin);
    expect(catalog).toHaveLength(1);
    expect(catalog[0]?.name).toBe('Builtin');
  });

  it('should keep builtin entries when removing by id', async () => {
    const builtin: UiPluginCatalogEntry[] = [
      { id: 'keep', name: 'Builtin', source: 'bundled', builtin: true },
    ];
    // addCatalogEntry 只读写自定义层，builtin 由调用方传入；这里先写自定义同名项再删
    await addCatalogEntry(agentDir, { id: 'keep', name: 'Custom', source: 'owner/repo' });
    await addCatalogEntry(agentDir, { id: 'drop', name: 'Drop', source: 'owner/repo' });
    await removeCatalogEntry(agentDir, 'drop');
    const catalog = await readCatalog(agentDir, builtin);
    expect(catalog.map((e) => e.id)).toEqual(['keep']);
  });

  it('should ignore a malformed custom catalog file', async () => {
    writeFileSync(join(agentDir, 'plugin-catalog.json'), 'not json');
    expect(await readCatalog(agentDir)).toEqual([]);
  });
});
