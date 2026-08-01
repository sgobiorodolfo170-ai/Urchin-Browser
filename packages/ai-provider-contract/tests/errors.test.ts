/**
 * M12 Provider Contract · ProviderError 单元测试
 */

import { describe, it, expect } from 'vitest';
import { ProviderError, isRetryable, RETRYABLE_ERROR_CODES } from '../src/errors';

describe('ProviderError', () => {
  describe('constructor', () => {
    it('should create with code and message', () => {
      const err = new ProviderError('AUTH_INVALID', 'bad key');
      expect(err.code).toBe('AUTH_INVALID');
      expect(err.message).toBe('bad key');
      expect(err.name).toBe('ProviderError');
      expect(err.retryable).toBe(false);
    });

    it('should default retryable to true for NETWORK_ERROR', () => {
      const err = new ProviderError('NETWORK_ERROR', 'timeout');
      expect(err.retryable).toBe(true);
    });

    it('should default retryable to true for RATE_LIMITED', () => {
      const err = new ProviderError('RATE_LIMITED', '429');
      expect(err.retryable).toBe(true);
    });

    it('should allow overriding retryable', () => {
      const err = new ProviderError('NETWORK_ERROR', 'timeout', { retryable: false });
      expect(err.retryable).toBe(false);
    });

    it('should store cause when provided', () => {
      const cause = new Error('underlying');
      const err = new ProviderError('PROVIDER_ERROR', 'wrapped', { cause });
      expect(err.cause).toBe(cause);
    });

    it('should not set cause when undefined', () => {
      const err = new ProviderError('UNKNOWN', 'no cause');
      expect(err.cause).toBeUndefined();
    });

    it('should be an instance of Error', () => {
      const err = new ProviderError('UNKNOWN', 'test');
      expect(err).toBeInstanceOf(Error);
      expect(err).toBeInstanceOf(ProviderError);
    });
  });

  describe('from()', () => {
    it('should return same instance for ProviderError', () => {
      const original = new ProviderError('AUTH_INVALID', 'bad');
      expect(ProviderError.from(original)).toBe(original);
    });

    it('should wrap generic Error as UNKNOWN', () => {
      const original = new Error('something broke');
      const wrapped = ProviderError.from(original);
      expect(wrapped.code).toBe('UNKNOWN');
      expect(wrapped.message).toBe('something broke');
      expect(wrapped.cause).toBe(original);
      expect(wrapped.retryable).toBe(false);
    });

    it('should wrap non-Error value as UNKNOWN', () => {
      const wrapped = ProviderError.from('string error');
      expect(wrapped.code).toBe('UNKNOWN');
      expect(wrapped.message).toBe('string error');
    });

    it('should wrap null as UNKNOWN', () => {
      const wrapped = ProviderError.from(null);
      expect(wrapped.code).toBe('UNKNOWN');
      expect(wrapped.message).toBe('null');
    });
  });
});

describe('isRetryable', () => {
  it('should return true for NETWORK_ERROR', () => {
    expect(isRetryable('NETWORK_ERROR')).toBe(true);
  });

  it('should return true for RATE_LIMITED', () => {
    expect(isRetryable('RATE_LIMITED')).toBe(true);
  });

  it('should return false for AUTH_INVALID', () => {
    expect(isRetryable('AUTH_INVALID')).toBe(false);
  });

  it('should return false for CONTEXT_TOO_LONG', () => {
    expect(isRetryable('CONTEXT_TOO_LONG')).toBe(false);
  });

  it('should return false for CONTENT_FILTERED', () => {
    expect(isRetryable('CONTENT_FILTERED')).toBe(false);
  });

  it('should return false for ABORTED', () => {
    expect(isRetryable('ABORTED')).toBe(false);
  });

  it('should return false for UNKNOWN', () => {
    expect(isRetryable('UNKNOWN')).toBe(false);
  });

  it('RETRYABLE_ERROR_CODES should contain exactly 2 codes', () => {
    expect(RETRYABLE_ERROR_CODES).toHaveLength(2);
    expect(RETRYABLE_ERROR_CODES).toContain('NETWORK_ERROR');
    expect(RETRYABLE_ERROR_CODES).toContain('RATE_LIMITED');
  });
});
