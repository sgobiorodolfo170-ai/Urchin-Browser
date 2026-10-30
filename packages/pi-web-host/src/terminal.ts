/**
 * pi-web-host · 终端管理（第五批 D10）
 *
 * 使用 node-pty 提供真实 PTY 终端，运行在 utility 进程内。
 * 前端 xterm.js 通过 WS 消息与之交互。
 */
import * as pty from 'node-pty';

interface TerminalEntry {
  id: string;
  process: pty.IPty;
  title: string;
  cwd: string;
}

const terminals = new Map<string, TerminalEntry>();

export interface TerminalInfo {
  id: string;
  title: string;
  cwd: string;
  pid: number;
}

/** 创建终端 */
export function createTerminal(
  id: string,
  cwd: string,
  cols: number,
  rows: number,
  title: string | undefined,
  onData: (terminalId: string, data: string) => void,
  onExit: (terminalId: string, exitCode: number) => void,
): void {
  const shell =
    process.platform === 'win32' ? 'powershell.exe' : (process.env.SHELL ?? '/bin/bash');
  const p = pty.spawn(shell, [], {
    name: 'xterm-256color',
    cols: cols || 80,
    rows: rows || 24,
    cwd: cwd || process.cwd(),
    env: process.env,
  });

  p.onData((data) => onData(id, data));
  p.onExit(({ exitCode }) => {
    terminals.delete(id);
    onExit(id, exitCode ?? 0);
  });

  terminals.set(id, { id, process: p, title: title ?? shell, cwd });
}

/** 发送输入到终端 */
export function terminalInput(id: string, data: string): void {
  const t = terminals.get(id);
  if (t) t.process.write(data);
}

/** 调整终端大小 */
export function terminalResize(id: string, cols: number, rows: number): void {
  const t = terminals.get(id);
  if (t) t.process.resize(cols, rows);
}

/** 杀死终端 */
export function terminalKill(id: string): void {
  const t = terminals.get(id);
  if (t) {
    try {
      t.process.kill();
    } catch {
      /* ignore */
    }
    terminals.delete(id);
  }
}

/** 列出所有活跃终端 */
export function listTerminals(): TerminalInfo[] {
  return Array.from(terminals.values()).map((t) => ({
    id: t.id,
    title: t.title,
    cwd: t.cwd,
    pid: t.process.pid,
  }));
}

/** 销毁所有终端（连接关闭时调用） */
export function disposeAllTerminals(): void {
  for (const t of terminals.values()) {
    try {
      t.process.kill();
    } catch {
      /* ignore */
    }
  }
  terminals.clear();
}
