/**
 * M25 MailStorage 单元测试。
 *
 * 验证：
 * 1. loadAccounts：空 / 有数据
 * 2. insertAccount：写入 + 字段映射
 * 3. deleteAccount：删除
 * 4. loadFolders / upsertFolders：文件夹缓存 CRUD
 * 5. loadMessages / upsertMessage / getMessage：邮件缓存 CRUD
 */
import { describe, it, expect, vi } from 'vitest';
import { MailStorage } from '../../src/main/mail/mail-storage';
import type { MailAccountRecord, MailFolderRow, MailMessageRow } from '../../src/main/mail/types';

interface MockTables {
  mail_accounts: Map<string, Record<string, unknown>>;
  mail_folders: Map<string, Record<string, unknown>>;
  mail_messages: Map<string, Record<string, unknown>>;
}

function createMockStorage() {
  const tables: MockTables = {
    mail_accounts: new Map(),
    mail_folders: new Map(),
    mail_messages: new Map(),
  };

  const query = vi.fn((sql: string, ...params: readonly unknown[]) => {
    const s = sql.trim();
    if (s.includes('FROM mail_accounts')) {
      return [...tables.mail_accounts.values()].map((r) => ({
        id: r.id,
        name: r.name,
        email: r.email,
        imapHost: r.imapHost,
        imapPort: r.imapPort,
        imapSecure: r.imapSecure,
        smtpHost: r.smtpHost,
        smtpPort: r.smtpPort,
        smtpSecure: r.smtpSecure,
        createdAt: r.createdAt,
      }));
    }
    if (s.includes('FROM mail_folders') && s.includes('WHERE account_id')) {
      const accId = String(params[0]);
      return [...tables.mail_folders.values()].filter((r) => r.account_id === accId);
    }
    if (s.includes('FROM mail_messages') && s.includes('WHERE account_id')) {
      const accId = String(params[0]);
      const folder = String(params[1]);
      return [...tables.mail_messages.values()]
        .filter((r) => r.account_id === accId && r.folder === folder)
        .sort((a, b) => String(b.date).localeCompare(String(a.date)));
    }
    if (s.includes('FROM mail_messages') && s.includes('AND uid')) {
      const accId = String(params[0]);
      const folder = String(params[1]);
      const uid = Number(params[2]);
      const row = [...tables.mail_messages.values()].find(
        (r) => r.account_id === accId && r.folder === folder && r.uid === uid,
      );
      return row ? [row] : [];
    }
    return [];
  });

  const run = vi.fn((sql: string, ...params: readonly unknown[]) => {
    const s = sql.trim();
    if (s.startsWith('INSERT INTO mail_accounts')) {
      const id = String(params[0]);
      tables.mail_accounts.set(id, {
        id,
        name: params[1],
        email: params[2],
        imapHost: params[3],
        imapPort: params[4],
        imapSecure: params[5],
        smtpHost: params[6],
        smtpPort: params[7],
        smtpSecure: params[8],
        createdAt: params[9],
      });
    } else if (s.startsWith('DELETE FROM mail_accounts')) {
      const id = String(params[0]);
      tables.mail_accounts.delete(id);
      for (const [k, v] of tables.mail_folders) {
        if (v.account_id === id) tables.mail_folders.delete(k);
      }
      for (const [k, v] of tables.mail_messages) {
        if (v.account_id === id) tables.mail_messages.delete(k);
      }
    } else if (s.includes('INSERT INTO mail_folders')) {
      const key = `${String(params[0])}:${String(params[1])}`;
      tables.mail_folders.set(key, {
        account_id: params[0],
        path: params[1],
        name: params[2],
        delimiter: params[3],
        flags: params[4],
        msg_count: params[5],
        unseen: params[6],
        last_synced_at: params[7],
      });
    } else if (s.includes('INSERT INTO mail_messages')) {
      const key = `${String(params[0])}:${String(params[1])}:${String(params[2])}`;
      tables.mail_messages.set(key, {
        account_id: params[0],
        folder: params[1],
        uid: params[2],
        subject: params[3],
        from_addr: params[4],
        to_addrs: params[5],
        date: params[6],
        size: params[7],
        flags: params[8],
        fetched_at: params[9],
      });
    }
  });

  return {
    storage: new MailStorage(
      query as unknown as <T>(sql: string, ...params: readonly unknown[]) => readonly T[],
      run,
    ),
    tables,
    query,
    run,
  };
}

function createTestAccount(): MailAccountRecord {
  return {
    id: 'test-uuid-1',
    name: '测试账户',
    email: 'test@example.com',
    imapHost: 'imap.example.com',
    imapPort: 993,
    imapSecure: true,
    smtpHost: null,
    smtpPort: null,
    smtpSecure: null,
    createdAt: 1700000000000,
  };
}

describe('MailStorage', () => {
  describe('accounts', () => {
    it('loadAccounts: should return empty when no accounts', () => {
      const { storage } = createMockStorage();
      expect(storage.loadAccounts()).toEqual([]);
    });

    it('insertAccount + loadAccounts: should persist and load account', () => {
      const { storage } = createMockStorage();
      const account = createTestAccount();
      storage.insertAccount(account);
      const loaded = storage.loadAccounts();
      expect(loaded).toHaveLength(1);
      expect(loaded[0]!.id).toBe(account.id);
      expect(loaded[0]!.email).toBe(account.email);
    });

    // 回归测试（2026-09-25 生产 bug）：SQLite INTEGER 0/1 必须转回 boolean，
    // 否则 mail.account.list 出参 zod 校验（z.boolean()）失败，UI 卡在配置表单。
    it('loadAccounts: should convert SQLite 0/1 back to boolean', () => {
      const { storage } = createMockStorage();
      const account = createTestAccount();
      storage.insertAccount(account);
      const loaded = storage.loadAccounts();
      expect(loaded[0]!.imapSecure).toBe(true);
      expect(typeof loaded[0]!.imapSecure).toBe('boolean');
      expect(loaded[0]!.smtpSecure).toBeNull();
    });

    it('deleteAccount: should remove account', () => {
      const { storage, tables } = createMockStorage();
      const account = createTestAccount();
      storage.insertAccount(account);
      expect(tables.mail_accounts.size).toBe(1);
      storage.deleteAccount(account.id);
      expect(tables.mail_accounts.size).toBe(0);
      expect(storage.loadAccounts()).toEqual([]);
    });
  });

  describe('folders', () => {
    it('loadFolders: should return empty for account with no folders', () => {
      const { storage } = createMockStorage();
      expect(storage.loadFolders('acc-1')).toEqual([]);
    });

    it('upsertFolders + loadFolders: should persist and load folders', () => {
      const { storage } = createMockStorage();
      const folders: MailFolderRow[] = [
        {
          account_id: 'acc-1',
          path: 'INBOX',
          name: '收件箱',
          delimiter: '/',
          flags: '[]',
          msg_count: 10,
          unseen: 3,
          last_synced_at: 1700000000000,
        },
        {
          account_id: 'acc-1',
          path: 'Sent',
          name: '已发送',
          delimiter: '/',
          flags: '[]',
          msg_count: 5,
          unseen: 0,
          last_synced_at: 1700000000000,
        },
      ];
      storage.upsertFolders('acc-1', folders);
      const loaded = storage.loadFolders('acc-1');
      expect(loaded).toHaveLength(2);
      expect(loaded[0]!.path).toBe('INBOX');
      expect(loaded[1]!.path).toBe('Sent');
    });
  });

  describe('messages', () => {
    it('loadMessages: should return empty for folder with no messages', () => {
      const { storage } = createMockStorage();
      expect(storage.loadMessages('acc-1', 'INBOX')).toEqual([]);
    });

    it('upsertMessage + loadMessages: should persist and load message', () => {
      const { storage } = createMockStorage();
      const row: MailMessageRow = {
        account_id: 'acc-1',
        folder: 'INBOX',
        uid: 123,
        subject: '测试邮件',
        from_addr: 'sender@example.com',
        to_addrs: '["test@example.com"]',
        date: '2024-01-01T00:00:00.000Z',
        size: 1024,
        flags: '["\\Seen"]',
        fetched_at: 1700000000000,
        body_html: null,
        body_text: null,
      };
      storage.upsertMessages([row]);
      const loaded = storage.loadMessages('acc-1', 'INBOX');
      expect(loaded).toHaveLength(1);
      expect(loaded[0]!.uid).toBe(123);
      expect(loaded[0]!.subject).toBe('测试邮件');
    });

    it('getMessage: should return specific message by uid', () => {
      const { storage } = createMockStorage();
      const row: MailMessageRow = {
        account_id: 'acc-1',
        folder: 'INBOX',
        uid: 456,
        subject: '查找测试',
        from_addr: 'sender@example.com',
        to_addrs: '[]',
        date: '2024-01-02T00:00:00.000Z',
        size: 512,
        flags: '[]',
        fetched_at: null,
        body_html: null,
        body_text: null,
      };
      storage.upsertMessages([row]);
      const found = storage.getMessage('acc-1', 'INBOX', 456);
      expect(found).not.toBeNull();
      expect(found!.subject).toBe('查找测试');
    });

    it('getMessage: should return null for non-existent uid', () => {
      const { storage } = createMockStorage();
      expect(storage.getMessage('acc-1', 'INBOX', 999)).toBeNull();
    });

    it('upsertMessage: should update existing message (ON CONFLICT)', () => {
      const { storage } = createMockStorage();
      const row: MailMessageRow = {
        account_id: 'acc-1',
        folder: 'INBOX',
        uid: 789,
        subject: '原标题',
        from_addr: 'sender@example.com',
        to_addrs: '[]',
        date: '2024-01-03T00:00:00.000Z',
        size: 100,
        flags: '[]',
        fetched_at: null,
        body_html: null,
        body_text: null,
      };
      storage.upsertMessages([row]);
      storage.upsertMessages([
        { ...row, subject: '新标题', flags: '["\\Seen"]', body_html: null, body_text: null },
      ]);
      const loaded = storage.loadMessages('acc-1', 'INBOX');
      expect(loaded).toHaveLength(1);
      expect(loaded[0]!.subject).toBe('新标题');
      expect(loaded[0]!.flags).toBe('["\\Seen"]');
    });
  });
});
