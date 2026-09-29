/**
 * M25 邮箱服务商预设 · 单元测试
 *
 * 验证：
 * 1. detectProviderByEmail：域名识别（QQ/163/Gmail/大小写/空白/无 @ 等边界）
 * 2. getPresetById：按 ID 查预设
 * 3. 预设表完整性：每条预设的 IMAP 配置字段齐全
 */
import { describe, it, expect } from 'vitest';
import {
  MAIL_PROVIDER_PRESETS,
  detectProviderByEmail,
  getPresetById,
} from '../../src/renderer/mail/provider-presets';

describe('mail provider presets', () => {
  describe('detectProviderByEmail', () => {
    it('should detect QQ 邮箱 by qq.com domain', () => {
      expect(detectProviderByEmail('user@qq.com')?.id).toBe('qq');
    });

    it('should detect QQ 邮箱 by foxmail.com domain', () => {
      expect(detectProviderByEmail('user@foxmail.com')?.id).toBe('qq');
    });

    it('should detect 网易163 by 163.com domain', () => {
      expect(detectProviderByEmail('user@163.com')?.id).toBe('163');
    });

    it('should detect Gmail by gmail.com domain', () => {
      expect(detectProviderByEmail('user@gmail.com')?.id).toBe('gmail');
    });

    it('should detect Outlook by hotmail.com domain', () => {
      expect(detectProviderByEmail('user@hotmail.com')?.id).toBe('outlook');
    });

    it('should be case-insensitive for domain', () => {
      expect(detectProviderByEmail('user@Gmail.COM')?.id).toBe('gmail');
      expect(detectProviderByEmail('user@QQ.COM')?.id).toBe('qq');
    });

    it('should trim surrounding whitespace', () => {
      expect(detectProviderByEmail('  user@163.com  ')?.id).toBe('163');
    });

    it('should return undefined for email without @', () => {
      expect(detectProviderByEmail('notanemail')).toBeUndefined();
    });

    it('should return undefined for email ending with @', () => {
      expect(detectProviderByEmail('user@')).toBeUndefined();
    });

    it('should return undefined for unknown domain', () => {
      expect(detectProviderByEmail('user@unknown-mail-xyz.com')).toBeUndefined();
    });

    it('should use lastIndexOf @ (local part may contain @ in quoted form)', () => {
      // "user@x"@gmail.com 这类引号形式的 local part——取最后一个 @ 后的域名
      expect(detectProviderByEmail('a@b@gmail.com')?.id).toBe('gmail');
    });

    it('should not match exmail by domain (企业邮箱域名不定)', () => {
      expect(detectProviderByEmail('user@company.example')).toBeUndefined();
    });
  });

  describe('getPresetById', () => {
    it('should return preset for known id', () => {
      const p = getPresetById('gmail');
      expect(p).toBeDefined();
      expect(p!.imap.host).toBe('imap.gmail.com');
      expect(p!.imap.port).toBe(993);
      expect(p!.imap.secure).toBe(true);
    });

    it('should return undefined for custom id', () => {
      expect(getPresetById('custom')).toBeUndefined();
    });

    it('should return undefined for unknown id', () => {
      expect(getPresetById('nonexistent')).toBeUndefined();
    });
  });

  describe('preset table integrity', () => {
    it('every preset should have valid IMAP config', () => {
      for (const p of MAIL_PROVIDER_PRESETS) {
        expect(p.id.length).toBeGreaterThan(0);
        expect(p.name.length).toBeGreaterThan(0);
        expect(p.imap.host).toMatch(/\./);
        expect(p.imap.port).toBeGreaterThan(0);
        expect(typeof p.imap.secure).toBe('boolean');
      }
    });

    it('app-password presets should have authHint', () => {
      for (const p of MAIL_PROVIDER_PRESETS) {
        if (p.authType === 'app-password') {
          expect(p.authHint, `${p.id} 缺少 authHint`).toBeDefined();
        }
      }
    });

    it('preset ids should be unique', () => {
      const ids = MAIL_PROVIDER_PRESETS.map((p) => p.id);
      expect(new Set(ids).size).toBe(ids.length);
    });
  });
});
