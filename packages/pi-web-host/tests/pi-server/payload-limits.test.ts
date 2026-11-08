import { describe, expect, it } from 'vitest';
import {
  isUploadDataTooLong,
  MAX_UPLOAD_BASE64_CHARS,
  MAX_UPLOAD_BYTES,
  normalizeUploadMaxMb,
  TASK_REPORT_UPLOAD_JSON_BYTES,
  uploadLimitBytes,
  WS_MAX_PAYLOAD_BYTES,
} from '../../src/pi-server/payload-limits.js';

const MB = 1024 * 1024;
const defaults = { chatUploadMaxMb: 20, workspaceUploadMaxMb: 100, folderUploadMaxMb: 32 };

describe('payload limit constants', () => {
  it('should expose a 100 MiB base64-era upload ceiling', () => {
    expect(MAX_UPLOAD_BYTES).toBe(100 * MB);
    expect(MAX_UPLOAD_BASE64_CHARS).toBe(Math.ceil(MAX_UPLOAD_BYTES / 3) * 4);
    expect(WS_MAX_PAYLOAD_BYTES).toBe(MAX_UPLOAD_BASE64_CHARS + MB);
  });

  it('should keep the task report JSON ceiling at 128 KiB', () => {
    expect(TASK_REPORT_UPLOAD_JSON_BYTES).toBe(128 * 1024);
  });
});

describe('normalizeUploadMaxMb', () => {
  it.each([
    [1, 1],
    [100, 100],
    [42, 42],
    [19.99, 19],
    [100.9, 100],
    [0, 1],
    [-10, 1],
    [0.9, 1],
    [101, 100],
    [Number.MAX_VALUE, 100],
  ])('should normalize %s MB to the integer %s MB', (input, expected) => {
    expect(normalizeUploadMaxMb(input, 32)).toBe(expected);
  });

  it.each([undefined, null, NaN, Infinity, -Infinity, '50', '', true, {}, []])(
    'should fall back for invalid input %j',
    (input) => {
      for (const fallback of [20, 100, 32])
        expect(normalizeUploadMaxMb(input, fallback)).toBe(fallback);
    },
  );
});

describe('uploadLimitBytes', () => {
  it.each(['chat', 'workspace', 'folder'] as const)(
    'should apply the %s default and convert MB to bytes',
    (kind) => {
      expect(uploadLimitBytes({}, kind)).toBe(defaults[`${kind}UploadMaxMb`] * MB);
    },
  );

  it.each([
    [{ chatUploadMaxMb: 7.9, workspaceUploadMaxMb: 48, folderUploadMaxMb: 99 }, [7, 48, 99]],
    [{ chatUploadMaxMb: -1, workspaceUploadMaxMb: 101, folderUploadMaxMb: NaN }, [1, 100, 32]],
  ])('should normalize each category against its own cap', (settings, expected) => {
    for (const [index, kind] of (['chat', 'workspace', 'folder'] as const).entries()) {
      expect(uploadLimitBytes(settings, kind)).toBe(expected[index] * MB);
    }
  });

  it('should ignore caps that belong to another category', () => {
    expect(uploadLimitBytes({ chatUploadMaxMb: 3 }, 'workspace')).toBe(100 * MB);
    expect(uploadLimitBytes({ folderUploadMaxMb: 3 }, 'chat')).toBe(20 * MB);
  });
});

describe('isUploadDataTooLong', () => {
  it('should accept data exactly at the base64 cap and reject one char past it', () => {
    const cap = 4 * MB;
    const limit = Math.ceil(cap / 3) * 4;
    expect(isUploadDataTooLong(limit, cap)).toBe(false);
    expect(isUploadDataTooLong(limit + 1, cap)).toBe(true);
  });

  it('should default to the global 100 MiB cap', () => {
    expect(isUploadDataTooLong(0)).toBe(false);
    expect(isUploadDataTooLong(MAX_UPLOAD_BASE64_CHARS)).toBe(false);
    expect(isUploadDataTooLong(MAX_UPLOAD_BASE64_CHARS + 1)).toBe(true);
  });
});
