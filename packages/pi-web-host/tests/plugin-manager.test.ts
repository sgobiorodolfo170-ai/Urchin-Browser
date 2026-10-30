/**
 * plugin-manager.ts 单元测试
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  parseInstallSpec,
  scanPlugins,
  readCatalog,
  addCatalogEntry,
  removeCatalogEntry,
} from '../src/plugin-manager';

describe('parseInstallSpec', () => {
  it('should classify npm package', () => {
    expect(parseInstallSpec('some-package')).toEqual({ kind: 'npm', pkg: 'some-package' });
  });

  it('should classify scoped npm package with version', () => {
    expect(parseInstallSpec('@scope/pkg@1.2.3')).toEqual({
      kind: 'npm',
      pkg: '@scope/pkg@1.2.3',
    });
  });

  it('should classify github repo', () => {
    const result = parseInstallSpec('owner/repo');
    expect(result.kind).toBe('github');
    expect(result.repo).toBe('owner/repo');
  });

  it('should classify github repo with ref', () => {
    const result = parseInstallSpec('owner/repo#v1');
    expect(result.kind).toBe('github');
    expect(result.ref).toBe('v1');
  });

  it('should classify url', () => {
    expect(parseInstallSpec('https://example.com/plugin')).toEqual({ kind: 'url' });
  });

  it('should classify absolute path', () => {
    expect(parseInstallSpec('C:\\plugins\\my-plugin').kind).toBe('path');
  });

  it('should classify empty string as invalid', () => {
    expect(parseInstallSpec('')).toEqual({ kind: 'invalid' });
  });
});

describe('scanPlugins', () => {
  let agentDir: string;

  beforeEach(() => {
    agentDir = mkdtempSync(join(tmpdir(), 'pi-plugin-test-'));
  });

  afterEach(() => {
    rmSync(agentDir, { recursive: true, force: true });
  });

  it('should return empty array when plugins dir does not exist', async () => {
    const plugins = await scanPlugins(agentDir);
    expect(plugins).toEqual([]);
  });

  it('should scan a plugin with manifest', async () => {
    const pluginsDir = join(agentDir, 'plugins', 'my-plugin');
    mkdirSync(pluginsDir, { recursive: true });
    writeFileSync(
      join(pluginsDir, 'manifest.json'),
      JSON.stringify({
        name: 'My Plugin',
        version: '1.0.0',
        permissions: ['fs', 'tools'],
      }),
    );

    const plugins = await scanPlugins(agentDir);
    expect(plugins).toHaveLength(1);
    expect(plugins[0].id).toBe('my-plugin');
    expect(plugins[0].name).toBe('My Plugin');
    expect(plugins[0].version).toBe('1.0.0');
    expect(plugins[0].permissions).toEqual(['fs', 'tools']);
    expect(plugins[0].hasClient).toBe(false);
  });

  it('should detect client entry', async () => {
    const pluginsDir = join(agentDir, 'plugins', 'with-client');
    mkdirSync(pluginsDir, { recursive: true });
    writeFileSync(join(pluginsDir, 'manifest.json'), JSON.stringify({ name: 'Test' }));
    mkdirSync(join(pluginsDir, 'client'), { recursive: true });
    writeFileSync(join(pluginsDir, 'client', 'entry.mjs'), 'export default {};');

    const plugins = await scanPlugins(agentDir);
    expect(plugins[0].hasClient).toBe(true);
  });

  it('should set error when manifest is missing', async () => {
    const pluginsDir = join(agentDir, 'plugins', 'no-manifest');
    mkdirSync(pluginsDir, { recursive: true });

    const plugins = await scanPlugins(agentDir);
    expect(plugins[0].error).toBeDefined();
    expect(plugins[0].name).toBe('no-manifest');
  });

  it('should skip directories with invalid names', async () => {
    mkdirSync(join(agentDir, 'plugins', 'valid-name'), { recursive: true });
    writeFileSync(
      join(agentDir, 'plugins', 'valid-name', 'manifest.json'),
      JSON.stringify({ name: 'Valid' }),
    );
    mkdirSync(join(agentDir, 'plugins', 'invalid..name'), { recursive: true });

    const plugins = await scanPlugins(agentDir);
    expect(plugins).toHaveLength(1);
    expect(plugins[0].id).toBe('valid-name');
  });
});

describe('catalog', () => {
  let agentDir: string;

  beforeEach(() => {
    agentDir = mkdtempSync(join(tmpdir(), 'pi-catalog-test-'));
  });

  afterEach(() => {
    rmSync(agentDir, { recursive: true, force: true });
  });

  it('should return empty catalog when file does not exist', async () => {
    const catalog = await readCatalog(agentDir);
    expect(catalog).toEqual([]);
  });

  it('should add and read catalog entry', async () => {
    await addCatalogEntry(agentDir, {
      id: 'test-plugin',
      name: 'Test Plugin',
      source: 'owner/repo',
      builtin: false,
    });
    const catalog = await readCatalog(agentDir);
    expect(catalog).toHaveLength(1);
    expect(catalog[0].id).toBe('test-plugin');
    expect(catalog[0].name).toBe('Test Plugin');
  });

  it('should remove catalog entry', async () => {
    await addCatalogEntry(agentDir, {
      id: 'to-remove',
      name: 'Remove Me',
      source: 'owner/repo',
    });
    await addCatalogEntry(agentDir, {
      id: 'keep',
      name: 'Keep Me',
      source: 'owner/repo2',
    });
    await removeCatalogEntry(agentDir, 'to-remove');
    const catalog = await readCatalog(agentDir);
    expect(catalog).toHaveLength(1);
    expect(catalog[0].id).toBe('keep');
  });

  it('should update existing entry on add', async () => {
    await addCatalogEntry(agentDir, {
      id: 'update-me',
      name: 'Old Name',
      source: 'old/repo',
    });
    await addCatalogEntry(agentDir, {
      id: 'update-me',
      name: 'New Name',
      source: 'new/repo',
    });
    const catalog = await readCatalog(agentDir);
    expect(catalog).toHaveLength(1);
    expect(catalog[0].name).toBe('New Name');
  });
});
