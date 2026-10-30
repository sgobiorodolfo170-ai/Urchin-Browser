/**
 * pi 阶段 2 托管服务 · 会话存储（M2B-3b）
 *
 * 自管 JSONL 持久化：每轮对话（user + assistant）追加到
 * `<agentDir>/sessions/<sessionId>.jsonl`，格式与 pi 官方 SessionManager 的
 * `message` entry 形状兼容（`{type:'message', role, content, ts}`），但目录约定
 * 自管（不依赖 pi 的 `--<encoded-cwd>--` 目录结构），简化实现。
 *
 * M2B-4 接入 createAgentSession 时可迁移到官方 SessionManager（format 兼容）。
 */
import { appendFile, readdir, readFile, mkdir, unlink, copyFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface SessionInfo {
  readonly id: string;
  readonly firstMessage: string;
  readonly messageCount: number;
}

export interface StoredMessage {
  readonly role: 'user' | 'assistant';
  readonly content: string;
}

/** 确保会话目录存在并返回路径 */
async function ensureSessionDir(agentDir: string): Promise<string> {
  const dir = join(agentDir, 'sessions');
  await mkdir(dir, { recursive: true });
  return dir;
}

/** 持久化一轮对话（user + assistant）到会话 JSONL */
export async function persistExchange(
  agentDir: string,
  sessionId: string,
  userText: string,
  assistantText: string,
): Promise<void> {
  const dir = await ensureSessionDir(agentDir);
  const file = join(dir, `${sessionId}.jsonl`);
  const ts = new Date().toISOString();
  const lines =
    [
      JSON.stringify({ type: 'message', role: 'user', content: userText, ts }),
      JSON.stringify({ type: 'message', role: 'assistant', content: assistantText, ts }),
    ].join('\n') + '\n';
  await appendFile(file, lines, 'utf8');
}

/** 列出所有会话（按 id 倒序，最新在前） */
export async function listSessions(agentDir: string): Promise<SessionInfo[]> {
  const dir = join(agentDir, 'sessions');
  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    return [];
  }
  const sessions: SessionInfo[] = [];
  for (const file of files) {
    if (!file.endsWith('.jsonl')) continue;
    const id = file.replace(/\.jsonl$/, '');
    try {
      const content = await readFile(join(dir, file), 'utf8');
      const lines = content.trim().split('\n').filter(Boolean);
      let firstMessage = '';
      let messageCount = 0;
      for (const line of lines) {
        const entry = JSON.parse(line) as {
          type?: string;
          role?: string;
          content?: string;
        };
        if (entry.type === 'message' && entry.role === 'user' && !firstMessage) {
          firstMessage = (entry.content ?? '').slice(0, 60);
        }
        if (entry.type === 'message') messageCount++;
      }
      sessions.push({ id, firstMessage, messageCount });
    } catch {
      // 跳过损坏文件
    }
  }
  return sessions.sort((a, b) => b.id.localeCompare(a.id));
}

/** 加载会话的历史消息（用于切换会话时回显） */
export async function loadSessionMessages(
  agentDir: string,
  sessionId: string,
): Promise<StoredMessage[]> {
  const dir = join(agentDir, 'sessions');
  try {
    const content = await readFile(join(dir, `${sessionId}.jsonl`), 'utf8');
    const lines = content.trim().split('\n').filter(Boolean);
    const messages: StoredMessage[] = [];
    for (const line of lines) {
      const entry = JSON.parse(line) as {
        type?: string;
        role?: 'user' | 'assistant';
        content?: string;
      };
      if (entry.type === 'message' && entry.role && entry.content) {
        messages.push({ role: entry.role, content: entry.content });
      }
    }
    return messages;
  } catch {
    return [];
  }
}

/** 生成新会话 ID（时间戳 + 随机后缀） */
export function generateSessionId(): string {
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const suffix = Math.random().toString(36).slice(2, 8);
  return `${ts}_${suffix}`;
}

/** 删除会话文件 */
export async function deleteSession(agentDir: string, sessionId: string): Promise<void> {
  const dir = await ensureSessionDir(agentDir);
  try {
    await unlink(join(dir, `${sessionId}.jsonl`));
  } catch {
    /* 文件不存在忽略 */
  }
}

/** Fork 会话：复制原会话全部消息到新会话文件，返回新 sessionId */
export async function forkSession(agentDir: string, originalSessionId: string): Promise<string> {
  const dir = await ensureSessionDir(agentDir);
  const newId = generateSessionId();
  try {
    await copyFile(join(dir, `${originalSessionId}.jsonl`), join(dir, `${newId}.jsonl`));
  } catch {
    /* 原文件不存在时新会话为空 */
  }
  return newId;
}
