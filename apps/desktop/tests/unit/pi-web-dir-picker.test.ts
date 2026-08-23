/**
 * pi 网页版原生目录选择器单元测试（dev.44）
 *
 * 覆盖：
 * 1. buildPickDirectoryResponse：受信 Referer（localhost）→ 调用 onPick 并返回 {path}
 * 2. 非受信 Referer（远程网页）→ 403，不调用 onPick（防盗读/防诱弹）
 * 3. 取消选择 → { path: null }
 * 4. 响应带 CORS 头（页面需跨源读取 JSON）
 * 5. buildCwdPickerInjectionScript：含幂等标志 / 拦截目标 / 协议端点 / 调试入口
 */
import { describe, it, expect, vi } from 'vitest';
import {
  buildPickDirectoryResponse,
  buildCwdPickerInjectionScript,
} from '../../src/main/pi-web/dir-picker';

describe('buildPickDirectoryResponse', () => {
  it('should invoke onPick and return picked path for trusted localhost referer', async () => {
    const onPick = vi.fn(() => Promise.resolve('G:\\pj\\Urchin-Browser'));
    const res = await buildPickDirectoryResponse('http://127.0.0.1:51785/', onPick);

    expect(res.status).toBe(200);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(await res.json()).toEqual({ path: 'G:\\pj\\Urchin-Browser' });
    expect(onPick).toHaveBeenCalledTimes(1);
  });

  it('should return path null when user cancels the dialog', async () => {
    const onPick = vi.fn(() => Promise.resolve(null));
    const res = await buildPickDirectoryResponse('http://127.0.0.1:51785/', onPick);
    expect(await res.json()).toEqual({ path: null });
  });

  it('should deny remote web pages (403) and never open the dialog', async () => {
    const onPick = vi.fn(() => Promise.resolve('G:\\should-not-run'));
    const res = await buildPickDirectoryResponse('https://evil.example.com/page', onPick);

    expect(res.status).toBe(403);
    expect(await res.text()).toBe('Forbidden');
    expect(onPick).not.toHaveBeenCalled();
  });

  it('should allow empty referer (same as file-resource semantics)', async () => {
    const onPick = vi.fn(() => Promise.resolve('C:\\projects'));
    const res = await buildPickDirectoryResponse('', onPick);
    expect(res.status).toBe(200);
  });
});

describe('buildCwdPickerInjectionScript', () => {
  it('should contain idempotent flag, intercept target, endpoint and debug entry', () => {
    const script = buildCwdPickerInjectionScript();
    expect(script).toContain('__ubCwdPickerInstalled');
    expect(script).toContain('button.status-cwd');
    expect(script).toContain('urchin://pi-pick-dir');
    expect(script).toContain('__ubCwdPickerPick');
    expect(script).toContain('input.status-cwd-input');
  });
});
