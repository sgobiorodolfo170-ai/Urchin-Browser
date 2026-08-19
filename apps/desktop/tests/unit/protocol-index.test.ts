/**
 * urchin:// 内部协议模块单元测试
 *
 * 验证：
 * 1. registerUrchinSchemePrivileged：注册特权 scheme（standard/secure/fetch/cors）
 * 2. registerUrchinProtocol：路由 urchin://settings / ai / newtab → HTML
 * 3. 未知 host → 404
 * 4. 非法 URL → 500
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const protocolMocks = vi.hoisted(() => ({
  registerSchemesAsPrivileged: vi.fn(),
  handle: vi.fn(),
}));

vi.mock('electron', () => ({
  protocol: {
    registerSchemesAsPrivileged: protocolMocks.registerSchemesAsPrivileged,
    handle: protocolMocks.handle,
  },
}));

import {
  registerUrchinSchemePrivileged,
  registerUrchinProtocol,
  URCHIN_SCHEME,
} from '../../src/main/protocol/index';

type ProtocolHandler = (request: { url: string }) => Response | Promise<Response>;

function getHandler(): ProtocolHandler {
  const call = protocolMocks.handle.mock.calls.find((c) => c[0] === URCHIN_SCHEME);
  if (!call) throw new Error('protocol.handle not registered');
  return call[1] as ProtocolHandler;
}

describe('protocol/index', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should export urchin scheme name', () => {
    expect(URCHIN_SCHEME).toBe('urchin');
  });

  describe('registerUrchinSchemePrivileged', () => {
    it('should register scheme with privileged flags', () => {
      registerUrchinSchemePrivileged();

      expect(protocolMocks.registerSchemesAsPrivileged).toHaveBeenCalledWith([
        {
          scheme: 'urchin',
          privileges: {
            standard: true,
            secure: true,
            supportFetchAPI: true,
            bypassCSP: true,
            corsEnabled: true,
          },
        },
      ]);
    });
  });

  describe('registerUrchinProtocol', () => {
    it('should register protocol handler', () => {
      registerUrchinProtocol();
      expect(protocolMocks.handle).toHaveBeenCalledWith('urchin', expect.any(Function));
    });

    it('should serve settings html for urchin://settings', async () => {
      registerUrchinProtocol();
      const res = await getHandler()({ url: 'urchin://settings' });
      const body = await res.text();

      expect(res.status).toBe(200);
      expect(body).toContain('<title>设置</title>');
    });

    it('should serve ai html for urchin://ai', async () => {
      registerUrchinProtocol();
      const res = await getHandler()({ url: 'urchin://ai' });
      const body = await res.text();

      expect(res.status).toBe(200);
      expect(body).toContain('<title>AI 助手</title>');
    });

    it('should serve newtab html for urchin://newtab', async () => {
      registerUrchinProtocol();
      const res = await getHandler()({ url: 'urchin://newtab' });
      const body = await res.text();

      expect(res.status).toBe(200);
      expect(body).toContain('Urchin Browser');
    });

    it('should return 404 for unknown host', async () => {
      registerUrchinProtocol();
      const res = await getHandler()({ url: 'urchin://unknown' });

      expect(res.status).toBe(404);
    });

    it('should return 500 for malformed url', async () => {
      registerUrchinProtocol();
      const res = await getHandler()({ url: 'not-a-url' });

      expect(res.status).toBe(500);
    });

    describe('zoom routes (Ctrl+滚轮缩放信号)', () => {
      it('should invoke onZoom for urchin://zoom?d=in with tab target', async () => {
        const onZoom = vi.fn();
        registerUrchinProtocol({ onZoom });
        const res = await getHandler()({ url: 'urchin://zoom?d=in' });

        expect(res.status).toBe(200);
        expect(onZoom).toHaveBeenCalledWith('in', 'tab');
      });

      it('should invoke onZoom for urchin://zoom?d=out with tab target', async () => {
        const onZoom = vi.fn();
        registerUrchinProtocol({ onZoom });
        await getHandler()({ url: 'urchin://zoom?d=out' });

        expect(onZoom).toHaveBeenCalledWith('out', 'tab');
      });

      it('should invoke onZoom for urchin://zoom-main?d=in with main target', async () => {
        const onZoom = vi.fn();
        registerUrchinProtocol({ onZoom });
        await getHandler()({ url: 'urchin://zoom-main?d=in' });

        expect(onZoom).toHaveBeenCalledWith('in', 'main');
      });

      it('should not invoke onZoom for invalid direction param', async () => {
        const onZoom = vi.fn();
        registerUrchinProtocol({ onZoom });
        const res = await getHandler()({ url: 'urchin://zoom?d=sideways' });

        expect(res.status).toBe(200);
        expect(onZoom).not.toHaveBeenCalled();
      });
    });
  });
});
