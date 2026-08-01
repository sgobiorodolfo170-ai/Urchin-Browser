/**
 * M12 Provider Contract · manifest 与版本测试
 */

import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { hasCapability, validateManifest, getManifestValidationError } from '../src/manifest';
import type { ProviderManifest } from '../src/manifest';
import { isSupportedApiVersion, CURRENT_API_VERSION, SUPPORTED_API_VERSIONS } from '../src/version';

/** 构建合法 manifest 用于测试 */
function makeManifest(overrides?: Partial<ProviderManifest>): ProviderManifest {
  return {
    id: 'test-provider',
    name: 'Test Provider',
    version: '1.0.0',
    apiVersion: 'urchin-ai-provider/v1',
    capabilities: ['chat.completion', 'chat.completion.streaming'],
    configSchema: z.object({ apiKey: z.string() }),
    authMethod: 'api_key',
    rateLimit: { requestsPerMin: 60 },
    ...overrides,
  };
}

describe('validateManifest', () => {
  it('should return true for a valid manifest', () => {
    expect(validateManifest(makeManifest())).toBe(true);
  });

  it('should return false for null', () => {
    expect(validateManifest(null)).toBe(false);
  });

  it('should return false for non-object', () => {
    expect(validateManifest('string')).toBe(false);
    expect(validateManifest(42)).toBe(false);
    expect(validateManifest(undefined)).toBe(false);
  });

  it('should return false for empty id', () => {
    expect(validateManifest(makeManifest({ id: '' }))).toBe(false);
  });

  it('should return false for missing capabilities', () => {
    const bad = makeManifest() as unknown as Record<string, unknown>;
    delete bad.capabilities;
    expect(validateManifest(bad)).toBe(false);
  });

  it('should return false for non-array capabilities', () => {
    const bad = makeManifest({ capabilities: 'chat' as unknown as never });
    expect(validateManifest(bad)).toBe(false);
  });

  it('should return false for missing authMethod', () => {
    const bad = makeManifest() as unknown as Record<string, unknown>;
    delete bad.authMethod;
    expect(validateManifest(bad)).toBe(false);
  });
});

describe('getManifestValidationError', () => {
  it('should return null for a valid manifest', () => {
    expect(getManifestValidationError(makeManifest())).toBeNull();
  });

  it('should return error for null', () => {
    expect(getManifestValidationError(null)).toBe('manifest must be a non-null object');
  });

  it('should return error for invalid id format', () => {
    // 大写字母不被允许
    const err = getManifestValidationError(makeManifest({ id: 'InvalidID' }));
    expect(err).toContain('manifest.id');
    expect(err).toContain('invalid');
  });

  it('should return error for invalid SemVer version', () => {
    const err = getManifestValidationError(makeManifest({ version: '1.0' }));
    expect(err).toContain('SemVer');
  });

  it('should return error for invalid capability value', () => {
    const bad = makeManifest() as unknown as Record<string, unknown>;
    bad.capabilities = ['chat.completion', 'unknown.cap'];
    const err = getManifestValidationError(bad);
    expect(err).toContain('capabilities');
    expect(err).toContain('unknown.cap');
  });

  it('should return error for invalid authMethod', () => {
    const bad = makeManifest() as unknown as Record<string, unknown>;
    bad.authMethod = 'oauth2';
    const err = getManifestValidationError(bad);
    expect(err).toContain('authMethod');
    expect(err).toContain('oauth2');
  });

  it('should accept all valid authMethod values', () => {
    for (const authMethod of ['api_key', 'oauth', 'none', 'local'] as const) {
      expect(getManifestValidationError(makeManifest({ authMethod }))).toBeNull();
    }
  });

  it('should return error for invalid rateLimit.requestsPerMin', () => {
    const bad = makeManifest() as unknown as Record<string, unknown>;
    bad.rateLimit = { requestsPerMin: -1 };
    const err = getManifestValidationError(bad);
    expect(err).toContain('requestsPerMin');
  });

  it('should accept valid rateLimit with tokensPerMin', () => {
    const m = makeManifest({ rateLimit: { requestsPerMin: 60, tokensPerMin: 1000 } });
    expect(getManifestValidationError(m)).toBeNull();
  });
});

describe('hasCapability', () => {
  it('should return true if capability is declared', () => {
    const m = makeManifest({ capabilities: ['chat.completion', 'embedding'] });
    expect(hasCapability(m, 'chat.completion')).toBe(true);
    expect(hasCapability(m, 'embedding')).toBe(true);
  });

  it('should return false if capability is not declared', () => {
    const m = makeManifest({ capabilities: ['chat.completion'] });
    expect(hasCapability(m, 'embedding')).toBe(false);
    expect(hasCapability(m, 'vision')).toBe(false);
  });

  it('should return false for empty capabilities', () => {
    const m = makeManifest({ capabilities: [] });
    expect(hasCapability(m, 'chat.completion')).toBe(false);
  });
});

describe('version', () => {
  it('CURRENT_API_VERSION should be urchin-ai-provider/v1', () => {
    expect(CURRENT_API_VERSION).toBe('urchin-ai-provider/v1');
  });

  it('SUPPORTED_API_VERSIONS should contain v1', () => {
    expect(SUPPORTED_API_VERSIONS).toContain('urchin-ai-provider/v1');
  });

  it('isSupportedApiVersion should return true for v1', () => {
    expect(isSupportedApiVersion('urchin-ai-provider/v1')).toBe(true);
  });

  it('isSupportedApiVersion should return false for unknown version', () => {
    expect(isSupportedApiVersion('urchin-ai-provider/v2')).toBe(false);
    expect(isSupportedApiVersion('')).toBe(false);
    expect(isSupportedApiVersion('random')).toBe(false);
  });
});
