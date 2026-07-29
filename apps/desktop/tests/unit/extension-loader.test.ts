/**
 * M10 Extension Loader · ExtensionLoader 单元测试
 *
 * 验证扩展加载、启用/禁用、卸载逻辑。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ExtensionLoader } from '../../src/main/extensions/extension-loader';

const VALID_MANIFEST = JSON.stringify({
  manifest_version: 3,
  name: 'Test Extension',
  version: '1.0.0',
});

function createTempExtension(manifest: string): string {
  const dir = join(
    tmpdir(),
    `urchin-test-ext-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'manifest.json'), manifest, 'utf-8');
  return dir;
}

describe('ExtensionLoader', () => {
  let loader: ExtensionLoader;

  beforeEach(() => {
    loader = new ExtensionLoader();
  });

  it('should load extension from valid directory', () => {
    const dir = createTempExtension(VALID_MANIFEST);
    try {
      const ext = loader.loadFromPath(dir);
      expect(ext.name).toBe('Test Extension');
      expect(ext.version).toBe('1.0.0');
      expect(ext.enabled).toBe(true);
      expect(ext.id).toHaveLength(32);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('should throw if manifest.json not found', () => {
    const dir = join(tmpdir(), `urchin-test-no-ext-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    try {
      expect(() => loader.loadFromPath(dir)).toThrow(/manifest.json not found/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('should throw if manifest is invalid', () => {
    const dir = createTempExtension('{ invalid }');
    try {
      expect(() => loader.loadFromPath(dir)).toThrow(/Invalid manifest/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('should generate deterministic ID from path', () => {
    const dir = createTempExtension(VALID_MANIFEST);
    try {
      const ext1 = loader.loadFromPath(dir);
      const ext2 = loader.loadFromPath(dir);
      expect(ext1.id).toBe(ext2.id);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('should reload extension (replace existing)', () => {
    const dir = createTempExtension(VALID_MANIFEST);
    try {
      const ext1 = loader.loadFromPath(dir);
      const ext2 = loader.loadFromPath(dir);
      expect(ext1.id).toBe(ext2.id);
      expect(loader.getCount()).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('should get extension by id', () => {
    const dir = createTempExtension(VALID_MANIFEST);
    try {
      const ext = loader.loadFromPath(dir);
      const found = loader.get(ext.id);
      expect(found).toBeDefined();
      expect(found?.name).toBe('Test Extension');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('should return undefined for non-existent id', () => {
    expect(loader.get('non-existent')).toBeUndefined();
  });

  it('should list all loaded extensions', () => {
    const dir1 = createTempExtension(VALID_MANIFEST);
    const dir2 = createTempExtension(
      JSON.stringify({ manifest_version: 3, name: 'Ext 2', version: '2.0.0' }),
    );
    try {
      loader.loadFromPath(dir1);
      loader.loadFromPath(dir2);
      const list = loader.list();
      expect(list).toHaveLength(2);
    } finally {
      rmSync(dir1, { recursive: true, force: true });
      rmSync(dir2, { recursive: true, force: true });
    }
  });

  it('should disable extension', () => {
    const dir = createTempExtension(VALID_MANIFEST);
    try {
      const ext = loader.loadFromPath(dir);
      loader.disable(ext.id);
      const found = loader.get(ext.id);
      expect(found?.enabled).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('should enable extension', () => {
    const dir = createTempExtension(VALID_MANIFEST);
    try {
      const ext = loader.loadFromPath(dir);
      loader.disable(ext.id);
      loader.enable(ext.id);
      const found = loader.get(ext.id);
      expect(found?.enabled).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('should throw when disabling non-existent extension', () => {
    expect(() => loader.disable('non-existent')).toThrow(/not found/);
  });

  it('should throw when enabling non-existent extension', () => {
    expect(() => loader.enable('non-existent')).toThrow(/not found/);
  });

  it('should remove extension', () => {
    const dir = createTempExtension(VALID_MANIFEST);
    try {
      const ext = loader.loadFromPath(dir);
      loader.remove(ext.id);
      expect(loader.get(ext.id)).toBeUndefined();
      expect(loader.getCount()).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('should throw when removing non-existent extension', () => {
    expect(() => loader.remove('non-existent')).toThrow(/not found/);
  });

  it('should return correct count', () => {
    expect(loader.getCount()).toBe(0);
    const dir = createTempExtension(VALID_MANIFEST);
    try {
      loader.loadFromPath(dir);
      expect(loader.getCount()).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
