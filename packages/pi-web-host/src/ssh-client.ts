/**
 * pi-web-host · SSH 客户端（第五批 D11）
 *
 * 使用 ssh2 纯 JS 实现，在 utility 进程内提供远程 SSH 连接、目录浏览、
 * 环境探针和工具安装功能。
 */
import { Client } from 'ssh2';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

interface SshConnection {
  conn: Client;
  host: string;
  port: number;
  username: string;
}

const connections = new Map<string, SshConnection>();
const PROFILES_FILE = 'ssh-profiles.json';

export interface SshProfileSummary {
  name: string;
  host: string;
  port: number;
  username: string;
  authType: 'password' | 'key' | 'agent';
}

function getProfilesPath(agentDir: string): string {
  return join(agentDir, PROFILES_FILE);
}

async function readProfiles(agentDir: string): Promise<SshProfileSummary[]> {
  try {
    const raw = await readFile(getProfilesPath(agentDir), 'utf8');
    return JSON.parse(raw) as SshProfileSummary[];
  } catch {
    return [];
  }
}

async function writeProfiles(agentDir: string, profiles: SshProfileSummary[]): Promise<void> {
  await mkdir(agentDir, { recursive: true });
  await writeFile(getProfilesPath(agentDir), JSON.stringify(profiles, null, 2), 'utf8');
}

interface ProbeResult {
  ok: boolean;
  connectionId?: string;
  error?: string;
  system?: { os: string; arch: string; hostname: string; homeDir: string; user: string };
  tools?: {
    git: { installed: boolean; version?: string };
    node: { installed: boolean; version?: string };
    bash: { installed: boolean; path?: string };
  };
}

function execCommand(
  conn: Client,
  cmd: string,
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    conn.exec(cmd, (err, stream) => {
      if (err) {
        resolve({ stdout: '', stderr: err.message, code: -1 });
        return;
      }
      let stdout = '';
      let stderr = '';
      stream.on('data', (data: Buffer) => {
        stdout += data.toString();
      });
      stream.stderr.on('data', (data: Buffer) => {
        stderr += data.toString();
      });
      stream.on('close', (code: number) => {
        resolve({ stdout, stderr, code: code ?? 0 });
      });
    });
  });
}

export async function probe(
  host: string,
  port: number,
  username: string,
  auth:
    | { type: 'password'; password?: string }
    | { type: 'key'; privateKey?: string; privateKeyPath?: string; passphrase?: string }
    | { type: 'agent' },
): Promise<ProbeResult> {
  return new Promise((resolve) => {
    const conn = new Client();
    const connectConfig: Record<string, unknown> = { host, port, username };
    if (auth.type === 'password') {
      connectConfig.password = auth.password;
    } else if (auth.type === 'key') {
      connectConfig.privateKey = auth.privateKey;
      if (auth.passphrase) connectConfig.passphrase = auth.passphrase;
    }

    conn.on('ready', () => {
      void (async () => {
        const connectionId = randomUUID();
        connections.set(connectionId, { conn, host, port, username });

        const uname = await execCommand(conn, 'uname -s -m -n');
        const whoami = await execCommand(conn, 'whoami');
        const homeDir = await execCommand(conn, 'echo $HOME');
        const gitVer = await execCommand(conn, 'git --version 2>/dev/null');
        const nodeVer = await execCommand(conn, 'node --version 2>/dev/null');
        const bashPath = await execCommand(conn, 'which bash 2>/dev/null');

        const parts = uname.stdout.trim().split(/\s+/);
        resolve({
          ok: true,
          connectionId,
          system: {
            os: parts[0] ?? 'unknown',
            arch: parts[1] ?? 'unknown',
            hostname: parts[2] ?? host,
            homeDir: homeDir.stdout.trim(),
            user: whoami.stdout.trim(),
          },
          tools: {
            git: {
              installed: gitVer.code === 0,
              version: gitVer.stdout.trim() || undefined,
            },
            node: {
              installed: nodeVer.code === 0,
              version: nodeVer.stdout.trim() || undefined,
            },
            bash: {
              installed: bashPath.code === 0,
              path: bashPath.stdout.trim() || undefined,
            },
          },
        });
      })();
    });

    conn.on('error', (err: Error) => {
      resolve({ ok: false, error: err.message });
    });

    conn.connect(connectConfig);
  });
}

export async function listDir(
  connectionId: string,
  path: string,
): Promise<{
  ok: boolean;
  items?: { name: string; path: string; type: 'dir' | 'file'; size?: number; mtime?: number }[];
  error?: string;
}> {
  const entry = connections.get(connectionId);
  if (!entry) return { ok: false, error: 'connection not found' };

  return new Promise((resolve) => {
    entry.conn.sftp((err, sftp) => {
      if (err) {
        resolve({ ok: false, error: err.message });
        return;
      }
      const targetPath = path || '.';
      sftp.readdir(targetPath, (err2, list) => {
        if (err2) {
          resolve({ ok: false, error: err2.message });
          return;
        }
        const items = list.map((item) => ({
          name: item.filename,
          path: targetPath.endsWith('/')
            ? targetPath + item.filename
            : targetPath + '/' + item.filename,
          type: (item.attrs as { isDirectory: () => boolean }).isDirectory()
            ? ('dir' as const)
            : ('file' as const),
          size: item.attrs.size,
          mtime: item.attrs.mtime,
        }));
        resolve({ ok: true, items });
      });
    });
  });
}

export async function installTools(
  connectionId: string,
  tools: string[],
): Promise<{ ok: boolean; error?: string }> {
  const entry = connections.get(connectionId);
  if (!entry) return { ok: false, error: 'connection not found' };

  for (const tool of tools) {
    const cmd =
      tool === 'git'
        ? 'apt-get install -y git || yum install -y git'
        : tool === 'node'
          ? 'curl -fsSL https://deb.nodesource.com/setup_lts.x | bash - && apt-get install -y nodejs'
          : tool === 'bash'
            ? 'apt-get install -y bash'
            : `echo "unknown tool: ${tool}"`;
    const result = await execCommand(entry.conn, cmd);
    if (result.code !== 0) {
      return { ok: false, error: `failed to install ${tool}: ${result.stderr}` };
    }
  }
  return { ok: true };
}

export async function listProfiles(agentDir: string): Promise<SshProfileSummary[]> {
  return readProfiles(agentDir);
}

export async function deleteProfile(agentDir: string, name: string): Promise<void> {
  const profiles = await readProfiles(agentDir);
  const filtered = profiles.filter((p) => p.name !== name);
  await writeProfiles(agentDir, filtered);
}

export async function saveProfile(agentDir: string, profile: SshProfileSummary): Promise<void> {
  const profiles = await readProfiles(agentDir);
  const idx = profiles.findIndex((p) => p.name === profile.name);
  if (idx >= 0) {
    profiles[idx] = profile;
  } else {
    profiles.push(profile);
  }
  await writeProfiles(agentDir, profiles);
}

export function disposeAllSsh(): void {
  for (const entry of connections.values()) {
    try {
      entry.conn.end();
    } catch {
      /* ignore */
    }
  }
  connections.clear();
}
