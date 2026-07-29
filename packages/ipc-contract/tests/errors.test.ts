/**
 * IpcError 单元测试。
 */
import { describe, it, expect } from 'vitest';
import { IpcError, IpcErrorCode, isIpcErrorPayload } from '../src/index';

describe('IpcError', () => {
  it('should construct with code and message', () => {
    const err = new IpcError(IpcErrorCode.NOT_FOUND, 'tab not found');
    expect(err.code).toBe(IpcErrorCode.NOT_FOUND);
    expect(err.message).toBe('tab not found');
    expect(err.name).toBe('IpcError');
  });

  it('should default retryable for TIMEOUT', () => {
    const err = new IpcError(IpcErrorCode.TIMEOUT, 'timeout');
    expect(err.retryable).toBe(true);
  });

  it('should default non-retryable for VALIDATION', () => {
    const err = new IpcError(IpcErrorCode.VALIDATION, 'bad input');
    expect(err.retryable).toBe(false);
  });

  it('should allow override retryable', () => {
    const err = new IpcError(IpcErrorCode.INTERNAL, 'oops', { retryable: true });
    expect(err.retryable).toBe(true);
  });

  it('should serialize to payload and back', () => {
    const err = new IpcError(IpcErrorCode.STATE, 'invalid state', {
      channel: 'tab.reload',
      retryable: false,
    });
    const payload = err.toPayload();
    expect(payload.code).toBe(IpcErrorCode.STATE);
    expect(payload.message).toBe('invalid state');
    expect(payload.channel).toBe('tab.reload');
    expect(payload.retryable).toBe(false);

    const restored = IpcError.fromPayload(payload);
    expect(restored.code).toBe(err.code);
    expect(restored.message).toBe(err.message);
    expect(restored.channel).toBe(err.channel);
    expect(restored.retryable).toBe(err.retryable);
  });
});

describe('isIpcErrorPayload', () => {
  it('should accept valid payload', () => {
    expect(isIpcErrorPayload({ code: 'INTERNAL', message: 'x' })).toBe(true);
  });

  it('should reject missing fields', () => {
    expect(isIpcErrorPayload({ code: 'INTERNAL' })).toBe(false);
    expect(isIpcErrorPayload({ message: 'x' })).toBe(false);
  });

  it('should reject unknown code', () => {
    expect(isIpcErrorPayload({ code: 'UNKNOWN', message: 'x' })).toBe(false);
  });

  it('should reject non-object', () => {
    expect(isIpcErrorPayload(null)).toBe(false);
    expect(isIpcErrorPayload('x')).toBe(false);
    expect(isIpcErrorPayload(42)).toBe(false);
  });
});
