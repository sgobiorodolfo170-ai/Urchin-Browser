/**
 * ssh-client.ts 单元测试
 *
 * 仅覆盖纯文件操作：listProfiles / saveProfile / deleteProfile。
 * SSH 连接（probe/listDir/installTools）需真实 ssh2 服务器或 mock，留待 P3。
 * ssh2 被 mock 为空桩，避免原生 bindings 在 CI 中 flaky；文件操作不依赖 Client。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

vi.mock('ssh2', () => ({ Client: vi.fn() }));

import { listProfiles, deleteProfile, saveProfile } from '../src/ssh-client';
import type { SshProfileSummary } from '../src/ssh-client';

const PROFILES_FILE = 'ssh-profiles.json';

function makeProfile(over: Partial<SshProfileSummary> = {}): SshProfileSummary {
  return {
    name: over.name ?? 'default',
    host: over.host ?? 'example.com',
    port: over.port ?? 22,
    username: over.username ?? 'root',
    authType: over.authType ?? 'password',
  };
}

describe('ssh-client profiles', () => {
  let agentDir: string;

  beforeEach(() => {
    agentDir = mkdtempSync(join(tmpdir(), 'pi-ssh-test-'));
  });

  afterEach(() => {
    rmSync(agentDir, { recursive: true, force: true });
  });

  describe('listProfiles', () => {
    it('should return empty array when profiles file does not exist', async () => {
      const profiles = await listProfiles(agentDir);
      expect(profiles).toEqual([]);
    });

    it('should return parsed profiles when file exists', async () => {
      const sample = [
        makeProfile({ name: 'prod', host: '1.2.3.4', port: 22, authType: 'password' }),
      ];
      writeFileSyncJson(agentDir, sample);
      const profiles = await listProfiles(agentDir);
      expect(profiles).toHaveLength(1);
      expect(profiles[0].name).toBe('prod');
      expect(profiles[0].host).toBe('1.2.3.4');
      expect(profiles[0].authType).toBe('password');
    });

    it('should return multiple profiles in file order', async () => {
      writeFileSyncJson(agentDir, [
        makeProfile({ name: 'a', port: 22 }),
        makeProfile({ name: 'b', port: 2222 }),
        makeProfile({ name: 'c', port: 22000, authType: 'key' }),
      ]);
      const profiles = await listProfiles(agentDir);
      expect(profiles.map((p) => p.name)).toEqual(['a', 'b', 'c']);
      expect(profiles[1].port).toBe(2222);
      expect(profiles[2].authType).toBe('key');
    });

    it('should return empty array when file is invalid JSON', async () => {
      writeFileSync(join(agentDir, PROFILES_FILE), 'not json {{{');
      const profiles = await listProfiles(agentDir);
      expect(profiles).toEqual([]);
    });

    it('should return empty array when file is empty', async () => {
      writeFileSync(join(agentDir, PROFILES_FILE), '');
      const profiles = await listProfiles(agentDir);
      expect(profiles).toEqual([]);
    });
  });

  describe('saveProfile', () => {
    it('should create profiles file when none exists', async () => {
      await saveProfile(agentDir, makeProfile({ name: 'dev', host: 'localhost' }));
      const raw = readFileSync(join(agentDir, PROFILES_FILE), 'utf8');
      const parsed = JSON.parse(raw) as SshProfileSummary[];
      expect(parsed).toHaveLength(1);
      expect(parsed[0].name).toBe('dev');
      expect(parsed[0].host).toBe('localhost');
    });

    it('should append new profile to existing list', async () => {
      await saveProfile(agentDir, makeProfile({ name: 'a', host: 'h1' }));
      await saveProfile(agentDir, makeProfile({ name: 'b', host: 'h2', port: 2222 }));
      const profiles = await listProfiles(agentDir);
      expect(profiles).toHaveLength(2);
      expect(profiles.map((p) => p.name)).toEqual(['a', 'b']);
      expect(profiles[1].host).toBe('h2');
    });

    it('should update existing profile by name without duplicating', async () => {
      await saveProfile(agentDir, makeProfile({ name: 'prod', host: 'old.example.com' }));
      await saveProfile(
        agentDir,
        makeProfile({ name: 'prod', host: 'new.example.com', port: 2222, authType: 'key' }),
      );
      const profiles = await listProfiles(agentDir);
      expect(profiles).toHaveLength(1);
      expect(profiles[0].host).toBe('new.example.com');
      expect(profiles[0].port).toBe(2222);
      expect(profiles[0].authType).toBe('key');
    });

    it('should update only the matching profile and leave others intact', async () => {
      await saveProfile(agentDir, makeProfile({ name: 'keep', host: 'keep.host' }));
      await saveProfile(agentDir, makeProfile({ name: 'change', host: 'old' }));
      await saveProfile(agentDir, makeProfile({ name: 'change', host: 'new' }));
      const profiles = await listProfiles(agentDir);
      expect(profiles).toHaveLength(2);
      expect(profiles.find((p) => p.name === 'keep')?.host).toBe('keep.host');
      expect(profiles.find((p) => p.name === 'change')?.host).toBe('new');
    });

    it('should create nested agentDir if it does not exist', async () => {
      const nested = join(agentDir, 'nested', 'deep', 'dir');
      await saveProfile(nested, makeProfile({ name: 'x' }));
      expect(existsSync(join(nested, PROFILES_FILE))).toBe(true);
      const profiles = await listProfiles(nested);
      expect(profiles).toHaveLength(1);
    });

    it('should persist as pretty-printed JSON', async () => {
      await saveProfile(agentDir, makeProfile({ name: 'p' }));
      const raw = readFileSync(join(agentDir, PROFILES_FILE), 'utf8');
      // writeProfiles 用 JSON.stringify(profiles, null, 2)，应含多行缩进而非单行
      expect(raw).toContain('\n');
      expect(raw.startsWith('[\n')).toBe(true);
      const parsed = JSON.parse(raw) as SshProfileSummary[];
      const compact = JSON.stringify(parsed);
      expect(raw).not.toBe(compact);
    });
  });

  describe('deleteProfile', () => {
    it('should remove profile by name', async () => {
      await saveProfile(agentDir, makeProfile({ name: 'keep' }));
      await saveProfile(agentDir, makeProfile({ name: 'remove' }));
      await deleteProfile(agentDir, 'remove');
      const profiles = await listProfiles(agentDir);
      expect(profiles).toHaveLength(1);
      expect(profiles[0].name).toBe('keep');
    });

    it('should not throw when deleting non-existent profile', async () => {
      await expect(deleteProfile(agentDir, 'ghost')).resolves.not.toThrow();
    });

    it('should not throw when profiles file does not exist', async () => {
      await expect(deleteProfile(agentDir, 'anything')).resolves.not.toThrow();
    });

    it('should leave file with empty array when deleting last profile', async () => {
      await saveProfile(agentDir, makeProfile({ name: 'only' }));
      await deleteProfile(agentDir, 'only');
      const profiles = await listProfiles(agentDir);
      expect(profiles).toEqual([]);
      // 文件仍存在，内容为 []
      const raw = readFileSync(join(agentDir, PROFILES_FILE), 'utf8');
      expect(JSON.parse(raw)).toEqual([]);
    });

    it('should only delete the matching name', async () => {
      await saveProfile(agentDir, makeProfile({ name: 'a' }));
      await saveProfile(agentDir, makeProfile({ name: 'b' }));
      await saveProfile(agentDir, makeProfile({ name: 'c' }));
      await deleteProfile(agentDir, 'b');
      const profiles = await listProfiles(agentDir);
      expect(profiles.map((p) => p.name)).toEqual(['a', 'c']);
    });
  });

  describe('round-trip', () => {
    it('should preserve all authType variants through save/list', async () => {
      const variants: SshProfileSummary[] = [
        makeProfile({ name: 'p', authType: 'password' }),
        makeProfile({ name: 'k', authType: 'key' }),
        makeProfile({ name: 'g', authType: 'agent' }),
      ];
      for (const p of variants) await saveProfile(agentDir, p);
      const profiles = await listProfiles(agentDir);
      expect(profiles.map((p) => p.authType).sort()).toEqual(['agent', 'key', 'password']);
    });
  });
});

function writeFileSyncJson(dir: string, data: unknown): void {
  writeFileSync(join(dir, PROFILES_FILE), JSON.stringify(data));
}
