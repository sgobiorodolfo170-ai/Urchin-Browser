/**
 * session-store.ts 单元测试
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  persistExchange,
  listSessions,
  loadSessionMessages,
  generateSessionId,
  deleteSession,
  forkSession,
} from '../src/session-store';

describe('session-store', () => {
  let agentDir: string;

  beforeEach(() => {
    agentDir = mkdtempSync(join(tmpdir(), 'pi-test-'));
  });

  afterEach(() => {
    rmSync(agentDir, { recursive: true, force: true });
  });

  describe('generateSessionId', () => {
    it('should generate unique IDs', () => {
      const id1 = generateSessionId();
      const id2 = generateSessionId();
      expect(id1).not.toBe(id2);
      expect(id1.length).toBeGreaterThan(10);
    });
  });

  describe('persistExchange', () => {
    it('should persist user + assistant messages to JSONL', async () => {
      const sid = generateSessionId();
      await persistExchange(agentDir, sid, 'Hello', 'Hi there');
      const messages = await loadSessionMessages(agentDir, sid);
      expect(messages).toHaveLength(2);
      expect(messages[0].role).toBe('user');
      expect(messages[0].content).toBe('Hello');
      expect(messages[1].role).toBe('assistant');
      expect(messages[1].content).toBe('Hi there');
    });
  });

  describe('listSessions', () => {
    it('should list persisted sessions sorted by id descending', async () => {
      await persistExchange(agentDir, 'session-a', 'msg1', 'reply1');
      await persistExchange(agentDir, 'session-b', 'msg2', 'reply2');
      const sessions = await listSessions(agentDir);
      expect(sessions).toHaveLength(2);
      expect(sessions[0].id).toBe('session-b');
      expect(sessions[1].id).toBe('session-a');
    });

    it('should return empty array when no sessions', async () => {
      const sessions = await listSessions(agentDir);
      expect(sessions).toEqual([]);
    });

    it('should extract firstMessage from user content', async () => {
      await persistExchange(agentDir, 'test-sid', 'This is a long user message', 'reply');
      const sessions = await listSessions(agentDir);
      expect(sessions[0].firstMessage).toBe('This is a long user message');
    });
  });

  describe('loadSessionMessages', () => {
    it('should return empty array for non-existent session', async () => {
      const messages = await loadSessionMessages(agentDir, 'nonexistent');
      expect(messages).toEqual([]);
    });

    it('should load messages in order', async () => {
      const sid = generateSessionId();
      await persistExchange(agentDir, sid, 'first', 'reply1');
      await persistExchange(agentDir, sid, 'second', 'reply2');
      const messages = await loadSessionMessages(agentDir, sid);
      expect(messages).toHaveLength(4);
      expect(messages[0].content).toBe('first');
      expect(messages[1].content).toBe('reply1');
      expect(messages[2].content).toBe('second');
      expect(messages[3].content).toBe('reply2');
    });
  });

  describe('deleteSession', () => {
    it('should delete session file', async () => {
      const sid = generateSessionId();
      await persistExchange(agentDir, sid, 'msg', 'reply');
      await deleteSession(agentDir, sid);
      const messages = await loadSessionMessages(agentDir, sid);
      expect(messages).toEqual([]);
    });

    it('should not throw for non-existent session', async () => {
      await expect(deleteSession(agentDir, 'nonexistent')).resolves.not.toThrow();
    });
  });

  describe('forkSession', () => {
    it('should copy session to new id', async () => {
      const originalId = generateSessionId();
      await persistExchange(agentDir, originalId, 'original msg', 'original reply');
      const newId = await forkSession(agentDir, originalId);
      expect(newId).not.toBe(originalId);
      const messages = await loadSessionMessages(agentDir, newId);
      expect(messages).toHaveLength(2);
      expect(messages[0].content).toBe('original msg');
    });

    it('should create empty session when original does not exist', async () => {
      const newId = await forkSession(agentDir, 'nonexistent');
      const messages = await loadSessionMessages(agentDir, newId);
      expect(messages).toEqual([]);
    });
  });
});
