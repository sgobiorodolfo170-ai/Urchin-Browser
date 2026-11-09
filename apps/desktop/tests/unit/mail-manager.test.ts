/**
 * M25 MailManager 单元测试。
 *
 * 验证（不含 IMAP 连接——imapflow 在集成/E2E 测试覆盖）：
 * 1. listAccounts：从持久化加载
 * 2. addAccount：写入 SQLite + safeStorage 加密密码
 * 3. deleteAccount：清理密码 + 删除记录
 * 4. setNotifyNewMessage：通知函数注入
 */
import { describe, it, expect, vi } from 'vitest';
import { MailManager } from '../../src/main/mail/mail-manager';
import type { MailPersistence } from '../../src/main/mail/mail-storage';
import type { MailAccountRecord } from '../../src/main/mail/types';

/** Mock SecretStore */
function createMockSecretStore() {
  const secrets = new Map<string, string>();
  return {
    // eslint-disable-next-line @typescript-eslint/require-await -- async signature required by SecretStore interface, mock is synchronous
    get: vi.fn(async (name: string): Promise<string | null> => secrets.get(name) ?? null),
    // eslint-disable-next-line @typescript-eslint/require-await -- async signature required by SecretStore interface, mock is synchronous
    set: vi.fn(async (name: string, value: string): Promise<void> => {
      void name;
      void value;
      secrets.set(name, value);
    }),
    // eslint-disable-next-line @typescript-eslint/require-await -- async signature required by SecretStore interface, mock is synchronous
    delete: vi.fn(async (name: string): Promise<void> => {
      void name;
      secrets.delete(name);
    }),
    has: vi.fn((name: string): boolean => secrets.has(name)),
  };
}

/** Mock MailPersistence */
function createMockPersistence(): MailPersistence & { accounts: MailAccountRecord[] } {
  const accounts: MailAccountRecord[] = [];
  return {
    accounts,
    loadAccounts: () => [...accounts],
    insertAccount: (acc: MailAccountRecord) => {
      accounts.push(acc);
    },
    deleteAccount: (id: string) => {
      const idx = accounts.findIndex((a) => a.id === id);
      if (idx >= 0) accounts.splice(idx, 1);
    },
    loadFolders: () => [],
    upsertFolders: () => {
      // noop (mock)
    },
    loadMessages: () => [],
    upsertMessages: () => {
      // noop (mock)
    },
    getMessage: () => null,
    updateMessageBody: () => {
      // noop (mock)
    },
    updateMessageFlags: () => {
      // noop (mock)
    },
    getMaxUid: () => null,
  };
}

describe('MailManager', () => {
  describe('account management', () => {
    it('listAccounts: should return empty when no accounts', () => {
      const persistence = createMockPersistence();
      const manager = new MailManager(persistence, createMockSecretStore());
      expect(manager.listAccounts()).toEqual([]);
    });

    it('addAccount: should persist account and encrypt password', async () => {
      const persistence = createMockPersistence();
      const secrets = createMockSecretStore();
      const manager = new MailManager(persistence, secrets);

      const account = await manager.addAccount({
        name: '测试',
        email: 'test@example.com',
        imapHost: 'imap.example.com',
        imapPort: 993,
        imapSecure: true,
        password: 'secret123',
      });

      expect(account.id).toBeDefined();
      expect(account.email).toBe('test@example.com');
      expect(persistence.accounts).toHaveLength(1);

      // password should be stored in safeStorage, not in the account record
      expect(secrets.set).toHaveBeenCalledTimes(1);
      expect(secrets.set).toHaveBeenCalledWith(expect.stringContaining(account.id), 'secret123');
    });

    it('addAccount: should generate unique UUIDs', async () => {
      const persistence = createMockPersistence();
      const manager = new MailManager(persistence, createMockSecretStore());

      const a1 = await manager.addAccount({
        name: 'A',
        email: 'a@example.com',
        imapHost: 'imap.a.com',
        imapPort: 993,
        imapSecure: true,
        password: 'pw',
      });
      const a2 = await manager.addAccount({
        name: 'B',
        email: 'b@example.com',
        imapHost: 'imap.b.com',
        imapPort: 993,
        imapSecure: true,
        password: 'pw',
      });

      expect(a1.id).not.toBe(a2.id);
    });

    it('addAccount: should write password BEFORE inserting row (atomicity, 2026-11-10)', async () => {
      const persistence = createMockPersistence();
      const insertSpy = vi.spyOn(persistence, 'insertAccount');
      const secrets = createMockSecretStore();
      const manager = new MailManager(persistence, secrets);

      await manager.addAccount({
        name: '顺序',
        email: 'order@example.com',
        imapHost: 'imap.example.com',
        imapPort: 993,
        imapSecure: true,
        password: 'pw',
      });

      // 先写密文后插行：密文失败时不能留下「账户在、密码缺」的残缺行
      const setOrder = secrets.set.mock.invocationCallOrder[0]!;
      const insertOrder = insertSpy.mock.invocationCallOrder[0]!;
      expect(setOrder).toBeLessThan(insertOrder);
    });

    it('addAccount: should NOT persist row when secret write fails', async () => {
      const persistence = createMockPersistence();
      const secrets = createMockSecretStore();
      secrets.set.mockRejectedValueOnce(new Error('safeStorage not available'));
      const manager = new MailManager(persistence, secrets);

      await expect(
        manager.addAccount({
          name: '失败',
          email: 'fail@example.com',
          imapHost: 'imap.example.com',
          imapPort: 993,
          imapSecure: true,
          password: 'pw',
        }),
      ).rejects.toThrow('safeStorage not available');
      expect(persistence.accounts).toHaveLength(0);
    });

    it('hasPassword: should reflect secret presence', async () => {
      const persistence = createMockPersistence();
      const secrets = createMockSecretStore();
      const manager = new MailManager(persistence, secrets);

      const account = await manager.addAccount({
        name: '探测',
        email: 'probe@example.com',
        imapHost: 'imap.example.com',
        imapPort: 993,
        imapSecure: true,
        password: 'pw',
      });
      expect(manager.hasPassword(account.id)).toBe(true);
      await manager.deleteAccount(account.id);
      expect(manager.hasPassword(account.id)).toBe(false);
    });

    it('setPassword: should store new password for existing account', async () => {
      const persistence = createMockPersistence();
      const secrets = createMockSecretStore();
      const manager = new MailManager(persistence, secrets);

      const account = await manager.addAccount({
        name: '重授权',
        email: 'reauth@example.com',
        imapHost: 'imap.example.com',
        imapPort: 993,
        imapSecure: true,
        password: 'old',
      });
      await manager.setPassword(account.id, 'new-auth-code');
      expect(secrets.set).toHaveBeenLastCalledWith(
        expect.stringContaining(account.id),
        'new-auth-code',
      );
      expect(await secrets.get(`mail-account/${account.id}/password`)).toBe('new-auth-code');
    });

    it('setPassword: should reject for non-existent account', async () => {
      const persistence = createMockPersistence();
      const manager = new MailManager(persistence, createMockSecretStore());

      await expect(manager.setPassword('no-such-id', 'pw')).rejects.toThrow('账户不存在');
    });

    it('deleteAccount: should remove account and delete password', async () => {
      const persistence = createMockPersistence();
      const secrets = createMockSecretStore();
      const manager = new MailManager(persistence, secrets);

      const account = await manager.addAccount({
        name: '删除测试',
        email: 'del@example.com',
        imapHost: 'imap.example.com',
        imapPort: 993,
        imapSecure: true,
        password: 'delme',
      });

      expect(persistence.accounts).toHaveLength(1);
      await manager.deleteAccount(account.id);
      expect(persistence.accounts).toHaveLength(0);
      expect(secrets.delete).toHaveBeenCalledTimes(1);
    });

    it('deleteAccount: should handle non-existent account gracefully', async () => {
      const persistence = createMockPersistence();
      const secrets = createMockSecretStore();
      const manager = new MailManager(persistence, secrets);

      await manager.deleteAccount('nonexistent-id');
      expect(secrets.delete).toHaveBeenCalled();
    });
  });

  describe('notifyNewMessage', () => {
    it('setNotifyNewMessage: should inject callback', () => {
      const persistence = createMockPersistence();
      const manager = new MailManager(persistence, createMockSecretStore());
      const fn = vi.fn();
      manager.setNotifyNewMessage(fn);
      // callback stored (tested via startIdle which requires IMAP connection)
      // this test verifies the setter doesn't throw
      expect(fn).not.toHaveBeenCalled();
    });
  });
});
