/**
 * native-cli-model.ts 单元测试
 *
 * D5 回归：引擎目录裁剪为 `pi` + `custom` 后，上游 `claude` / `codex` 的 env 注入
 * 分支已不可达（`NativeCliPreset` 不含它们，原比较恒真并触发 TS2367）。修复后契约
 * 明确为「不注入」，这里锁定行为，防止后续误恢复死分支或悄悄改回 env 注入。
 */
import { describe, expect, it, vi } from 'vitest';
import type { ModelRuntime } from '@earendil-works/pi-coding-agent';
import {
  nativeCliModelLaunch,
  resolveNativeCliModelConnection,
  type NativeCliModelConnection,
} from '../../src/pi-server/native-cli-model.js';

const MODEL = { provider: 'anthropic', id: 'claude-sonnet-4' };

describe('resolveNativeCliModelConnection', () => {
  it('should not resolve an env connection for the pi preset', async () => {
    const runtime = {
      getModel: vi.fn(),
      isUsingOAuth: vi.fn(),
      getAuth: vi.fn(),
      getCompatibilityRequestConfig: vi.fn(),
    };

    const result = await resolveNativeCliModelConnection(
      { preset: 'pi', model: MODEL },
      runtime as unknown as ModelRuntime,
    );

    expect(result).toBeUndefined();
    expect(runtime.getModel).not.toHaveBeenCalled();
    expect(runtime.getAuth).not.toHaveBeenCalled();
  });

  it('should not resolve a connection for custom presets', async () => {
    expect(await resolveNativeCliModelConnection({ preset: 'custom' }, undefined)).toBeUndefined();
  });
});

describe('nativeCliModelLaunch', () => {
  it('should add no args or env for the pi preset', () => {
    const connection: NativeCliModelConnection = {
      baseUrl: 'https://api.example.test',
      apiKey: 'secret',
    };

    const launch = nativeCliModelLaunch({ preset: 'pi', model: MODEL }, connection, {
      PATH: '/bin',
    });

    expect(launch).toEqual({ args: [] });
    expect(launch.env).toBeUndefined();
  });

  it('should stay inert without a connection', () => {
    expect(nativeCliModelLaunch({ preset: 'pi', model: MODEL }, undefined, {})).toEqual({
      args: [],
    });
  });
});
