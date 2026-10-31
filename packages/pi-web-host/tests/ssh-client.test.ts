/* eslint-disable @typescript-eslint/no-empty-function -- ssh2 mock 需要宽松类型处理事件回调和 stream 模拟 */
/**
 * ssh-client.ts 单元测试
 *
 * 覆盖纯文件操作（listProfiles / saveProfile / deleteProfile）+
 * SSH 连接 mock 测试（probe / listDir / installTools）。
 * ssh2 被 mock 为 MockClient，支持事件分发和 exec/sftp 模拟。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const sshMock = vi.hoisted(() => {
  const events = new Map<string, ((arg?: any) => void)[]>();
  const execResults = new Map<string, { stdout: string; stderr: string; code: number }>();
  let sftpItems: any[] | null = null;
  let sftpError: string | null = null;

  class MockClient {
    on(event: string, cb: (arg?: any) => void): this {
      if (!events.has(event)) events.set(event, []);
      events.get(event)!.push(cb);
      return this;
    }
    connect(): void {
      /* 测试手动触发 ready/error */
    }
    exec(cmd: string, cb: (err: Error | null, stream: any) => void): void {
      const result = execResults.get(cmd) ?? { stdout: '', stderr: '', code: 0 };
      const handlers: Record<string, (...args: any[]) => void> = {};
      const stream = {
        on: (event: string, handler: (...args: any[]) => void) => {
          handlers[event] = handler;
          if (event === 'data' && result.stdout) handler(Buffer.from(result.stdout));
        },
        stderr: {
          on: (event: string, handler: (...args: any[]) => void) => {
            if (event === 'data' && result.stderr) handler(Buffer.from(result.stderr));
          },
        },
      };
      cb(null, stream);
      setImmediate(() => handlers.close?.(result.code));
    }
    sftp(cb: (err: Error | null, sftp: any) => void): void {
      if (sftpError) {
        cb(new Error(sftpError), null);
        return;
      }
      cb(null, {
        readdir: (_path: string, readdirCb: (err: Error | null, list: any[]) => void) => {
          if (sftpItems) readdirCb(null, sftpItems);
          else readdirCb(new Error('no such directory'), []);
        },
      });
    }
    end(): void {}
  }

  return {
    MockClient,
    events,
    setExecResult: (cmd: string, result: { stdout: string; stderr: string; code: number }) =>
      execResults.set(cmd, result),
    setSftpItems: (items: any[]) => {
      sftpItems = items;
      sftpError = null;
    },
    setSftpError: (err: string) => {
      sftpError = err;
      sftpItems = null;
    },
    emit: (event: string, arg?: any) => events.get(event)?.forEach((cb) => cb(arg)),
    reset: () => {
      events.clear();
      execResults.clear();
      sftpItems = null;
      sftpError = null;
    },
  };
});

vi.mock('ssh2', () => ({ Client: sshMock.MockClient }));

import {
  listProfiles,
  deleteProfile,
  saveProfile,
  probe,
  listDir,
  installTools,
  disposeAllSsh,
} from '../src/ssh-client';
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

/* ── P3：SSH 连接 mock 测试 ── */

describe('probe (mock ssh2)', () => {
  beforeEach(() => {
    sshMock.reset();
    disposeAllSsh();
  });

  it('should return ok with system info on connect ready', async () => {
    sshMock.setExecResult('uname -s -m -n', { stdout: 'Linux x86_64 myhost', stderr: '', code: 0 });
    sshMock.setExecResult('whoami', { stdout: 'root', stderr: '', code: 0 });
    sshMock.setExecResult('echo $HOME', { stdout: '/home/root', stderr: '', code: 0 });
    sshMock.setExecResult('git --version 2>/dev/null', {
      stdout: 'git version 2.34.1',
      stderr: '',
      code: 0,
    });
    sshMock.setExecResult('node --version 2>/dev/null', { stdout: 'v18.0.0', stderr: '', code: 0 });
    sshMock.setExecResult('which bash 2>/dev/null', { stdout: '/bin/bash', stderr: '', code: 0 });

    const promise = probe('1.2.3.4', 22, 'root', { type: 'password', password: 'pass' });
    sshMock.emit('ready');
    const result = await promise;

    expect(result.ok).toBe(true);
    expect(result.connectionId).toBeDefined();
    expect(result.system).toEqual({
      os: 'Linux',
      arch: 'x86_64',
      hostname: 'myhost',
      homeDir: '/home/root',
      user: 'root',
    });
    expect(result.tools?.git.installed).toBe(true);
    expect(result.tools?.git.version).toBe('git version 2.34.1');
    expect(result.tools?.node.installed).toBe(true);
    expect(result.tools?.node.version).toBe('v18.0.0');
    expect(result.tools?.bash.installed).toBe(true);
    expect(result.tools?.bash.path).toBe('/bin/bash');
  });

  it('should return error on connect error', async () => {
    const promise = probe('bad.host', 22, 'root', { type: 'password', password: 'pass' });
    sshMock.emit('error', new Error('connection refused'));
    const result = await promise;

    expect(result.ok).toBe(false);
    expect(result.error).toBe('connection refused');
  });

  it('should detect missing tools via exit code', async () => {
    sshMock.setExecResult('uname -s -m -n', { stdout: 'Linux x86_64 host', stderr: '', code: 0 });
    sshMock.setExecResult('whoami', { stdout: 'root', stderr: '', code: 0 });
    sshMock.setExecResult('echo $HOME', { stdout: '/root', stderr: '', code: 0 });
    sshMock.setExecResult('git --version 2>/dev/null', { stdout: '', stderr: '', code: 1 });
    sshMock.setExecResult('node --version 2>/dev/null', { stdout: '', stderr: '', code: 127 });
    sshMock.setExecResult('which bash 2>/dev/null', { stdout: '', stderr: '', code: 1 });

    const promise = probe('host', 22, 'root', { type: 'key', privateKey: 'xxx' });
    sshMock.emit('ready');
    const result = await promise;

    expect(result.ok).toBe(true);
    expect(result.tools?.git.installed).toBe(false);
    expect(result.tools?.node.installed).toBe(false);
    expect(result.tools?.bash.installed).toBe(false);
  });
});

describe('listDir (mock ssh2)', () => {
  beforeEach(() => {
    sshMock.reset();
    disposeAllSsh();
  });

  it('should return error when connection not found', async () => {
    const result = await listDir('nonexistent-id', '/home');
    expect(result.ok).toBe(false);
    expect(result.error).toBe('connection not found');
  });

  it('should list directory items via sftp', async () => {
    sshMock.setExecResult('uname -s -m -n', { stdout: 'Linux x86_64 h', stderr: '', code: 0 });
    sshMock.setExecResult('whoami', { stdout: 'root', stderr: '', code: 0 });
    sshMock.setExecResult('echo $HOME', { stdout: '/root', stderr: '', code: 0 });
    sshMock.setExecResult('git --version 2>/dev/null', { stdout: '', stderr: '', code: 1 });
    sshMock.setExecResult('node --version 2>/dev/null', { stdout: '', stderr: '', code: 1 });
    sshMock.setExecResult('which bash 2>/dev/null', { stdout: '', stderr: '', code: 1 });

    const probePromise = probe('host', 22, 'root', { type: 'password', password: 'p' });
    sshMock.emit('ready');
    const probeResult = await probePromise;
    expect(probeResult.ok).toBe(true);
    const connId = probeResult.connectionId!;

    sshMock.setSftpItems([
      {
        filename: 'file.txt',
        attrs: { size: 100, mtime: 1700000000, isDirectory: () => false },
      },
      {
        filename: 'subdir',
        attrs: { size: 0, mtime: 1700000001, isDirectory: () => true },
      },
    ]);

    const result = await listDir(connId, '/home/root');
    expect(result.ok).toBe(true);
    expect(result.items).toHaveLength(2);
    expect(result.items![0].name).toBe('file.txt');
    expect(result.items![0].type).toBe('file');
    expect(result.items![1].name).toBe('subdir');
    expect(result.items![1].type).toBe('dir');
    expect(result.items![0].path).toBe('/home/root/file.txt');
  });

  it('should return error when sftp readdir fails', async () => {
    sshMock.setExecResult('uname -s -m -n', { stdout: 'Linux x86 h', stderr: '', code: 0 });
    sshMock.setExecResult('whoami', { stdout: 'root', stderr: '', code: 0 });
    sshMock.setExecResult('echo $HOME', { stdout: '/r', stderr: '', code: 0 });
    sshMock.setExecResult('git --version 2>/dev/null', { stdout: '', stderr: '', code: 1 });
    sshMock.setExecResult('node --version 2>/dev/null', { stdout: '', stderr: '', code: 1 });
    sshMock.setExecResult('which bash 2>/dev/null', { stdout: '', stderr: '', code: 1 });

    const probePromise = probe('h', 22, 'root', { type: 'password', password: 'p' });
    sshMock.emit('ready');
    const probeResult = await probePromise;
    const connId = probeResult.connectionId!;

    sshMock.setSftpError('permission denied');
    const result = await listDir(connId, '/restricted');
    expect(result.ok).toBe(false);
    expect(result.error).toBe('permission denied');
  });
});

describe('installTools (mock ssh2)', () => {
  beforeEach(() => {
    sshMock.reset();
    disposeAllSsh();
  });

  it('should return error when connection not found', async () => {
    const result = await installTools('nonexistent', ['git']);
    expect(result.ok).toBe(false);
    expect(result.error).toBe('connection not found');
  });

  it('should install tools successfully', async () => {
    sshMock.setExecResult('uname -s -m -n', { stdout: 'Linux x86 h', stderr: '', code: 0 });
    sshMock.setExecResult('whoami', { stdout: 'root', stderr: '', code: 0 });
    sshMock.setExecResult('echo $HOME', { stdout: '/r', stderr: '', code: 0 });
    sshMock.setExecResult('git --version 2>/dev/null', { stdout: '', stderr: '', code: 1 });
    sshMock.setExecResult('node --version 2>/dev/null', { stdout: '', stderr: '', code: 1 });
    sshMock.setExecResult('which bash 2>/dev/null', { stdout: '', stderr: '', code: 1 });
    sshMock.setExecResult('apt-get install -y git || yum install -y git', {
      stdout: '',
      stderr: '',
      code: 0,
    });
    sshMock.setExecResult('apt-get install -y bash', { stdout: '', stderr: '', code: 0 });

    const probePromise = probe('h', 22, 'root', { type: 'password', password: 'p' });
    sshMock.emit('ready');
    const probeResult = await probePromise;
    const connId = probeResult.connectionId!;

    const result = await installTools(connId, ['git', 'bash']);
    expect(result.ok).toBe(true);
  });

  it('should fail when install command fails', async () => {
    sshMock.setExecResult('uname -s -m -n', { stdout: 'Linux x86 h', stderr: '', code: 0 });
    sshMock.setExecResult('whoami', { stdout: 'root', stderr: '', code: 0 });
    sshMock.setExecResult('echo $HOME', { stdout: '/r', stderr: '', code: 0 });
    sshMock.setExecResult('git --version 2>/dev/null', { stdout: '', stderr: '', code: 1 });
    sshMock.setExecResult('node --version 2>/dev/null', { stdout: '', stderr: '', code: 1 });
    sshMock.setExecResult('which bash 2>/dev/null', { stdout: '', stderr: '', code: 1 });
    sshMock.setExecResult('apt-get install -y git || yum install -y git', {
      stdout: '',
      stderr: 'no permissions',
      code: 1,
    });

    const probePromise = probe('h', 22, 'root', { type: 'password', password: 'p' });
    sshMock.emit('ready');
    const probeResult = await probePromise;
    const connId = probeResult.connectionId!;

    const result = await installTools(connId, ['git']);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('failed to install git');
  });
});
