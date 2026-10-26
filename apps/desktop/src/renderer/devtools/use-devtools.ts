/**
 * M15 DevTools · 渲染层状态 hook
 *
 * 职责：订阅 devtools:event 推送，维护 Network/Console 镜像与状态，
 * 调用 devtools.* RPC。按 target tabId 过滤广播批。
 *
 * 设计理由（实施规划 §7.2）：state 事件触发镜像重置 + 重拉快照；
 * network.batch 按 requestId upsert（幂等）；console.append 按 seq 去重。
 */
import { useEffect, useState, useCallback, useRef } from 'react';
import {
  DEVTOOLS_EVENT_CHANNEL,
  type DevtoolsEventPayload,
  type NetworkEntry,
  type ConsoleEntry,
  type DevtoolsState,
} from '@urchin/ipc-contract';

/** 面板绑定的检视目标。 */
export interface DevtoolsTarget {
  tabId: number;
  title: string;
}

/** evaluate 结果。 */
export interface EvaluateResult {
  ok: boolean;
  result?: unknown;
  exception?: string;
  error?: string;
  truncated?: boolean;
}

/** hook 返回值。 */
export interface UseDevtools {
  /** 当前检视目标（null = 未绑定） */
  target: DevtoolsTarget | null;
  /** 会话状态 */
  state: DevtoolsState;
  unavailableReason?: string;
  network: NetworkEntry[];
  networkDropped: number;
  console: ConsoleEntry[];
  consoleDropped: number;
  /** 绑定并开始检视某标签 */
  attach: (tabId: number) => Promise<void>;
  /** 停止检视 */
  detach: () => Promise<void>;
  /** 清空网络 */
  clearNetwork: () => Promise<void>;
  /** 清空控制台 */
  clearConsole: () => Promise<void>;
  /** 执行表达式 */
  evaluate: (expression: string, awaitPromise?: boolean) => Promise<EvaluateResult>;
}

export function useDevtools(): UseDevtools {
  const [target, setTarget] = useState<DevtoolsTarget | null>(null);
  const [state, setState] = useState<DevtoolsState>('detached');
  const [unavailableReason, setUnavailableReason] = useState<string | undefined>();
  const [network, setNetwork] = useState<NetworkEntry[]>([]);
  const [networkDropped, setNetworkDropped] = useState(0);
  const [consoleEntries, setConsole] = useState<ConsoleEntry[]>([]);
  const [consoleDropped, setConsoleDropped] = useState(0);
  /** 已见 console seq 集合（会话内去重，state=attached 重置） */
  const seenSeqs = useRef<Set<number>>(new Set());

  // 订阅 devtools:event
  useEffect(() => {
    const off = window.urchin.on(DEVTOOLS_EVENT_CHANNEL, (payload: unknown) => {
      const evt = payload as DevtoolsEventPayload;
      if (evt.type === 'state') {
        // 目标不匹配的 state 忽略（多窗口广播）
        if (target && evt.tabId !== target.tabId) return;
        setState(evt.state);
        setUnavailableReason(evt.reason);
        if (evt.state === 'attached') {
          // state 重置：清空镜像 + 重拉快照
          seenSeqs.current.clear();
          setNetwork([]);
          setConsole([]);
          setNetworkDropped(0);
          setConsoleDropped(0);
          if (evt.target) setTarget(evt.target);
          // 重拉快照
          if (evt.tabId) {
            void window.urchin
              .invoke('devtools.network.list', { tabId: evt.tabId })
              .then((r) => {
                const res = r as { entries: NetworkEntry[]; dropped: number };
                setNetwork(res.entries);
                setNetworkDropped(res.dropped);
              })
              .catch(() => undefined);
            void window.urchin
              .invoke('devtools.console.list', { tabId: evt.tabId })
              .then((r) => {
                const res = r as { entries: ConsoleEntry[]; dropped: number };
                setConsole(res.entries);
                setConsoleDropped(res.dropped);
                for (const e of res.entries) seenSeqs.current.add(e.seq);
              })
              .catch(() => undefined);
          }
        } else if (evt.state === 'detached' || evt.state === 'unavailable') {
          seenSeqs.current.clear();
        }
      } else if (evt.type === 'network.batch' && target?.tabId === evt.tabId) {
        // 幂等 upsert by requestId
        setNetwork((prev) => {
          const map = new Map(prev.map((e) => [e.requestId, e]));
          for (const entry of evt.entries) map.set(entry.requestId, entry);
          return Array.from(map.values());
        });
      } else if (evt.type === 'console.append' && target?.tabId === evt.tabId) {
        // seq 去重
        const fresh = evt.entries.filter((e) => !seenSeqs.current.has(e.seq));
        if (fresh.length > 0) {
          for (const e of fresh) seenSeqs.current.add(e.seq);
          setConsole((prev) => [...prev, ...fresh]);
        }
      } else if (evt.type === 'cleared' && target?.tabId === evt.tabId) {
        if (evt.scope === 'network') {
          setNetwork([]);
          setNetworkDropped(0);
        } else {
          setConsole([]);
          setConsoleDropped(0);
        }
      }
    });
    return off;
  }, [target]);

  const attach = useCallback(async (tabId: number) => {
    const raw = await window.urchin.invoke('devtools.attach', { tabId });
    const res = raw as { state: DevtoolsState; reason?: string; target?: DevtoolsTarget };
    setState(res.state);
    setUnavailableReason(res.reason);
    if (res.target) setTarget(res.target);
    if (res.state === 'attached') {
      // 重拉快照
      const [netRaw, conRaw] = await Promise.all([
        window.urchin.invoke('devtools.network.list', { tabId }),
        window.urchin.invoke('devtools.console.list', { tabId }),
      ]);
      const net = netRaw as { entries: NetworkEntry[]; dropped: number };
      const con = conRaw as { entries: ConsoleEntry[]; dropped: number };
      setNetwork(net.entries);
      setNetworkDropped(net.dropped);
      setConsole(con.entries);
      setConsoleDropped(con.dropped);
      seenSeqs.current = new Set(con.entries.map((e) => e.seq));
    } else {
      setNetwork([]);
      setConsole([]);
    }
  }, []);

  const detach = useCallback(async () => {
    if (!target) return;
    await window.urchin.invoke('devtools.detach', { tabId: target.tabId });
    setState('detached');
    setTarget(null);
    setNetwork([]);
    setConsole([]);
    seenSeqs.current.clear();
  }, [target]);

  const clearNetwork = useCallback(async () => {
    if (!target) return;
    await window.urchin.invoke('devtools.network.clear', { tabId: target.tabId });
  }, [target]);

  const clearConsole = useCallback(async () => {
    if (!target) return;
    await window.urchin.invoke('devtools.console.clear', { tabId: target.tabId });
  }, [target]);

  const evaluate = useCallback(
    async (expression: string, awaitPromise?: boolean): Promise<EvaluateResult> => {
      if (!target) return { ok: false, error: 'no target' };
      const raw = await window.urchin.invoke('devtools.evaluate', {
        tabId: target.tabId,
        expression,
        awaitPromise,
      });
      return raw as EvaluateResult;
    },
    [target],
  );

  return {
    target,
    state,
    unavailableReason,
    network,
    networkDropped,
    console: consoleEntries,
    consoleDropped,
    attach,
    detach,
    clearNetwork,
    clearConsole,
    evaluate,
  };
}
