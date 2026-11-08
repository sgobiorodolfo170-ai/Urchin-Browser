/**
 * @earendil-works/pi-coding-agent 测试桩
 *
 * 本仓不安装 vendored pi 包，pi-server 的会话模块只用到 SessionManager 的少量能力与一个
 * 压缩默认值常量。这里提供语义等价的同步 open / 构造器直灌 / 追加持久化实现，
 * 并允许测试打开「构造结果与文件头不一致」开关以覆盖回退分支。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface StubEntry {
  id?: string;
  parentId?: string | null;
  type?: string;
  message?: unknown;
  [key: string]: unknown;
}

export class StubSessionManager {
  /** 测试开关：模拟「构造结果与文件头不一致」，用于覆盖异步打开的回退分支。 */
  static forceMismatch = false;
  /** 记录 sync open 的调用路径，用于断言走了哪条路径。 */
  static readonly openCalls: string[] = [];

  private readonly entries: StubEntry[];
  private readonly header: Record<string, unknown>;
  private readonly file: string;
  private readonly cwd: string;
  private readonly persisted: boolean;
  private seq = 0;

  constructor(
    cwd: string,
    _sessionDir: string,
    sessionFile: string,
    persist: boolean,
    _newSessionOptions: undefined,
    preloadedFileEntries: unknown[],
  ) {
    const all = preloadedFileEntries as StubEntry[];
    this.header = all[0] ?? {};
    this.entries = all.slice(1);
    this.file = sessionFile;
    this.cwd = cwd;
    this.persisted = persist;
  }

  static open(path: string): StubSessionManager {
    StubSessionManager.openCalls.push(path);
    const raw = readFileSync(path, 'utf8');
    const parsed: StubEntry[] = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const value = JSON.parse(line) as StubEntry | null;
        if (value) parsed.push(value);
      } catch {
        // 与真实 JSONL 解析一致：坏行忽略
      }
    }
    const header = parsed[0];
    if (!header) return new StubSessionManager('/', dirname(path), path, true, undefined, []);
    if (header.type !== 'session' || typeof header.id !== 'string') {
      throw new Error(`Not a pi session file: ${path}`);
    }
    return new StubSessionManager(
      typeof header.cwd === 'string' ? header.cwd : '/',
      dirname(path),
      path,
      true,
      undefined,
      parsed,
    );
  }

  getSessionFile(): string {
    return this.file;
  }

  getSessionDir(): string {
    return dirname(this.file);
  }

  getSessionId(): string {
    if (StubSessionManager.forceMismatch) return 'mismatched-id';
    return typeof this.header.id === 'string' ? this.header.id : '';
  }

  getCwd(): string {
    return this.cwd;
  }

  getHeader(): Record<string, unknown> {
    return this.header;
  }

  getEntries(): StubEntry[] {
    return this.entries;
  }

  getLeafId(): string | null {
    const last = this.entries[this.entries.length - 1];
    return typeof last?.id === 'string' ? last.id : null;
  }

  getBranch(): StubEntry[] {
    return this.entries;
  }

  isPersisted(): boolean {
    return this.persisted;
  }

  appendMessage(message: Record<string, unknown>): StubEntry {
    const entry: StubEntry = {
      type: 'message',
      id: `appended-${this.seq++}`,
      parentId: this.getLeafId(),
      message,
    };
    this.entries.push(entry);
    writeFileSync(this.file, `${JSON.stringify(entry)}\n`, { flag: 'a' });
    return entry;
  }

  appendSessionInfo(name: string): void {
    writeFileSync(this.file, `${JSON.stringify({ type: 'session_info', name })}\n`, { flag: 'a' });
  }
}

export const DEFAULT_COMPACTION_SETTINGS = { reserveTokens: 16384 };

export const SessionManager = StubSessionManager;
