/**
 * 前后端协议版本一致性（P5）
 *
 * 前端 `apps/pi-web/src/protocol-version.ts` 与 pi-server
 * `packages/pi-web-host/src/pi-server/protocol-version.ts` 必须同步推进：
 * 任一侧单方面 +1 都会让类型/字段守卫按错误版本解释消息。
 * 这里用运行时断言锁定两者相等，避免只靠人工对照。
 */
import { describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION as uiProtocolVersion } from '../../src/protocol-version';
import { PROTOCOL_VERSION as serverProtocolVersion } from '@urchin/pi-web-host/shared/protocol-version';

describe('protocol version', () => {
  it('should keep the frontend and pi-server protocol versions in lockstep', () => {
    expect(uiProtocolVersion).toBe(serverProtocolVersion);
  });

  it('should stay a positive integer so equality checks are unambiguous', () => {
    expect(Number.isInteger(uiProtocolVersion)).toBe(true);
    expect(uiProtocolVersion).toBeGreaterThan(0);
  });
});