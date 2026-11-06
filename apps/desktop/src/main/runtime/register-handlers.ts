/**
 * Runtime 域 · IPC Handler 注册（设置-关于 · 运行时信息）
 *
 * 通道（契约见 ipc-contract runtime.* schema）：
 * 1. runtime.portableNode：探测便携 Node（路径/存在/可运行/版本）。
 *    打开设置-关于页时调用；探测含一次 `--version` spawn（5s 超时），
 *    正常亚秒返回。无状态、不缓存——每次调用如实反映当前机器状态
 *    （用户重装/删除文件后无需重启应用即可看到最新状态）。
 */
import type { IpcMain } from 'electron';
import { registerHandler } from '@urchin/ipc-contract';
import { createLogger } from '@urchin/logger';
import { probePortableNode } from './portable-node';

const log = createLogger('runtime-ipc');

/** Runtime 域 handler 依赖（便携 node.exe 期望路径，由 bootstrap 组装注入） */
export interface RuntimeHandlerDeps {
  readonly portableNodeExePath: string;
}

/** 注册 Runtime 域 IPC handler。 */
export function registerRuntimeHandlers(ipcMain: IpcMain, deps: RuntimeHandlerDeps): void {
  registerHandler(ipcMain, 'runtime.portableNode', () =>
    probePortableNode({ exePath: deps.portableNodeExePath }),
  );
  log.info('runtime ipc handlers registered', { portableNodeExePath: deps.portableNodeExePath });
}
