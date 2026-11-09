/**
 * `prepareNativeCliSessionLaunch` · observeOnly（keepAlive 重连仍存活的远程会话）的
 * 事件来源判定。
 *
 * 背景（2026-11-09，P2-2）：`native-cli-session.ts` 曾无条件声明
 * `capabilities.events = "hooks"`，但 observeOnly **不能**再安装上报器——事件只能由原启动
 * 留下的写入者产生。本仓唯一的事件写入者是 pi 预设的 `--extension <dir>/pi-extension.mjs`
 * （`custom` 预设从未安装）。旧声明会让 `nativeEvents` 谎报「有原生事件」，实际永远等不到。
 *
 * 这里用本地 observeOnly（无 SSH service）直接验证判据，不联网、不启动子进程。
 */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { prepareNativeCliSessionLaunch } from '../../src/pi-server/native-cli-session.js';
import type { NativeCliConfig } from '../../src/pi-server/protocol.js';

const KEY = '11111111-2222-3333-4444-555555555555';

let dataDir: string;
let sessionDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'pi-native-cli-observe-'));
  sessionDir = join(dataDir, 'native-cli', KEY);
  mkdirSync(join(sessionDir, 'events'), { recursive: true, mode: 0o700 });
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

/** 以 observeOnly 观察某个已存在的会话目录（本地路径形式，不走 SSH）。 */
async function observe(config: NativeCliConfig): Promise<{ events: 'hooks' | 'process' }> {
  const launch = await prepareNativeCliSessionLaunch(
    config,
    { key: KEY },
    {
      cwd: dataDir,
      dataDir,
      observeOnly: true,
      onEvent: () => undefined,
    },
  );
  try {
    return { events: launch.capabilities.events };
  } finally {
    await launch.dispose();
  }
}

/** 写入原启动留下的 pi 扩展脚本（写入者是它，不是本模块）。 */
function installPiExtension(): void {
  const file = join(sessionDir, 'pi-extension.mjs');
  writeFileSync(file, '// installed by the original pi launch\nexport default function () {}\n', {
    mode: 0o600,
  });
  chmodSync(file, 0o600);
}

describe('prepareNativeCliSessionLaunch observeOnly events', () => {
  it('should report hooks when the original pi extension is still installed', async () => {
    installPiExtension();
    expect((await observe({ preset: 'pi' })).events).toBe('hooks');
  });

  it('should report process when no event writer was ever installed', async () => {
    // 目录存在（原启动建的），但没有任何写入者 —— custom 预设的情况
    expect((await observe({ preset: 'custom' })).events).toBe('process');
  });

  it('should not claim hooks for a pi session launched with --no-extensions', async () => {
    // 无 pi-extension.mjs 即「原启动没装扩展」，此时不应谎报原生事件
    expect((await observe({ preset: 'pi', args: ['--no-extensions'] })).events).toBe('process');
  });

  it('should report process when the events directory cannot be read', async () => {
    installPiExtension();
    rmSync(join(sessionDir, 'events'), { recursive: true, force: true });
    expect((await observe({ preset: 'pi' })).events).toBe('process');
  });
});
