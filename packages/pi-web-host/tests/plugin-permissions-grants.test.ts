/**
 * plugin-permissions.ts 授权表（IO 部分）单元测试
 *
 * 三层权限模型里的「目录授权 / 动态能力授权 / DOM 授权」三张 JSON 表：
 * fail-closed（读坏当空）、授权幂等、目录包含关系、网络域名后缀匹配、
 * LLM 白名单空集放行。
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  checkDirAccess,
  grantDirAccess,
  revokeDirAccess,
  listGrants,
  checkNetHost,
  grantNetHost,
  checkLlmModel,
  listPermissions,
  checkDomConsent,
  setDomConsent,
} from '../src/plugin-permissions';

let agentDir: string;

beforeEach(() => {
  agentDir = mkdtempSync(join(tmpdir(), 'pi-perm-'));
});

afterEach(() => {
  rmSync(agentDir, { recursive: true, force: true });
});

function grantsPath(): string {
  return join(agentDir, 'plugin-grants.json');
}

describe('directory grants', () => {
  it('should deny by default and after a malformed grants file', async () => {
    expect(await checkDirAccess(agentDir, 'p', '/tmp/x')).toBe(false);
    writeFileSync(grantsPath(), '{not json');
    expect(await checkDirAccess(agentDir, 'p', '/tmp/x')).toBe(false);
    expect(await listGrants(agentDir)).toEqual([]);
  });

  it('should allow the granted directory and its descendants', async () => {
    const root = join(agentDir, 'workspace');
    await grantDirAccess(agentDir, 'p1', root);
    expect(await checkDirAccess(agentDir, 'p1', root)).toBe(true);
    expect(await checkDirAccess(agentDir, 'p1', join(root, 'src', 'file.ts'))).toBe(true);
  });

  it('should deny siblings, parents and path escapes', async () => {
    const root = join(agentDir, 'workspace');
    await grantDirAccess(agentDir, 'p1', root);
    expect(await checkDirAccess(agentDir, 'p1', join(agentDir, 'workspace2'))).toBe(false);
    expect(await checkDirAccess(agentDir, 'p1', agentDir)).toBe(false);
    expect(await checkDirAccess(agentDir, 'p1', join(root, '..', '..', 'etc'))).toBe(false);
  });

  it('should not duplicate an already granted directory', async () => {
    const root = join(agentDir, 'workspace');
    await grantDirAccess(agentDir, 'p1', root);
    await grantDirAccess(agentDir, 'p1', root);
    const stored = JSON.parse(readFileSync(grantsPath(), 'utf8')) as {
      grants: Record<string, string[]>;
    };
    expect(stored.grants.p1).toEqual([resolve(root)]);
  });

  it('should revoke a single directory or the whole plugin', async () => {
    const a = join(agentDir, 'a');
    const b = join(agentDir, 'b');
    await grantDirAccess(agentDir, 'p1', a);
    await grantDirAccess(agentDir, 'p1', b);

    await revokeDirAccess(agentDir, 'p1', a);
    expect(await checkDirAccess(agentDir, 'p1', a)).toBe(false);
    expect(await checkDirAccess(agentDir, 'p1', b)).toBe(true);

    await revokeDirAccess(agentDir, 'p1');
    expect(await listGrants(agentDir)).toEqual([]);
  });

  it('should list all grants', async () => {
    await grantDirAccess(agentDir, 'p1', join(agentDir, 'x'));
    await grantDirAccess(agentDir, 'p2', join(agentDir, 'y'));
    const grants = await listGrants(agentDir);
    expect(grants).toHaveLength(2);
    expect(grants.map((g) => g.pluginId).sort()).toEqual(['p1', 'p2']);
  });
});

describe('network grants', () => {
  it('should deny unknown hosts by default', async () => {
    expect(await checkNetHost(agentDir, 'p', 'api.example.com')).toBe(false);
  });

  it('should match the exact host and its subdomains only', async () => {
    await grantNetHost(agentDir, 'p', 'example.com');
    expect(await checkNetHost(agentDir, 'p', 'example.com')).toBe(true);
    expect(await checkNetHost(agentDir, 'p', 'api.example.com')).toBe(true);
    expect(await checkNetHost(agentDir, 'p', 'notexample.com')).toBe(false);
    expect(await checkNetHost(agentDir, 'p', 'example.com.evil.io')).toBe(false);
    expect(await checkNetHost(agentDir, 'other', 'example.com')).toBe(false);
  });

  it('should not duplicate a host', async () => {
    await grantNetHost(agentDir, 'p', 'example.com');
    await grantNetHost(agentDir, 'p', 'example.com');
    const perms = await listPermissions(agentDir);
    expect(perms).toEqual([{ pluginId: 'p', family: 'net', hosts: ['example.com'] }]);
  });

  it('should fail closed when the permissions file is malformed', async () => {
    writeFileSync(join(agentDir, 'plugin-permissions.json'), '{oops');
    await expect(checkNetHost(agentDir, 'p', 'example.com')).resolves.toBe(false);
    await expect(listPermissions(agentDir)).resolves.toEqual([]);
  });

  it('should fail closed when a grants/permissions file holds valid JSON but not an object', async () => {
    for (const content of ['null', '[]', '"text"', '42']) {
      writeFileSync(join(agentDir, 'plugin-grants.json'), content);
      writeFileSync(join(agentDir, 'plugin-permissions.json'), content);
      writeFileSync(join(agentDir, 'plugin-dom.json'), content);
      await expect(checkDirAccess(agentDir, 'p', agentDir)).resolves.toBe(false);
      await expect(listGrants(agentDir)).resolves.toEqual([]);
      await expect(checkNetHost(agentDir, 'p', 'example.com')).resolves.toBe(false);
      await expect(listPermissions(agentDir)).resolves.toEqual([]);
      await expect(checkDomConsent(agentDir, 'p')).resolves.toBe(false);
    }
  });

  it('should ignore a grants file whose grants field is not an object', async () => {
    writeFileSync(join(agentDir, 'plugin-grants.json'), JSON.stringify({ grants: [] }));
    await expect(listGrants(agentDir)).resolves.toEqual([]);
    await expect(checkDirAccess(agentDir, 'p', agentDir)).resolves.toBe(false);
  });
});

describe('llm grants', () => {
  it('should allow everything when no grant exists', async () => {
    expect(await checkLlmModel(agentDir, 'p', 'any-model')).toBe(true);
  });

  it('should allow everything when the model list is empty', async () => {
    writeFileSync(
      join(agentDir, 'plugin-permissions.json'),
      JSON.stringify({ p: { grants: { llm: { models: [] } } } }),
    );
    expect(await checkLlmModel(agentDir, 'p', 'any-model')).toBe(true);
  });

  it('should restrict to the configured model list', async () => {
    writeFileSync(
      join(agentDir, 'plugin-permissions.json'),
      JSON.stringify({ p: { grants: { llm: { models: ['m1', 'm2'] } } } }),
    );
    expect(await checkLlmModel(agentDir, 'p', 'm1')).toBe(true);
    expect(await checkLlmModel(agentDir, 'p', 'm3')).toBe(false);
  });

  it('should list both net and llm families', async () => {
    writeFileSync(
      join(agentDir, 'plugin-permissions.json'),
      JSON.stringify({
        p: { grants: { net: { hosts: ['a.com'] }, llm: { models: ['m1'] } } },
      }),
    );
    const perms = await listPermissions(agentDir);
    expect(perms).toEqual([
      { pluginId: 'p', family: 'net', hosts: ['a.com'] },
      { pluginId: 'p', family: 'llm', models: ['m1'] },
    ]);
  });
});

describe('DOM consent', () => {
  it('should deny by default and persist explicit consent', async () => {
    expect(await checkDomConsent(agentDir, 'p')).toBe(false);
    await setDomConsent(agentDir, 'p', true);
    expect(await checkDomConsent(agentDir, 'p')).toBe(true);
    await setDomConsent(agentDir, 'p', false);
    expect(await checkDomConsent(agentDir, 'p')).toBe(false);
  });
});
