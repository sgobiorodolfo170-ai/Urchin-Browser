/**
 * 编辑会话 hook（use-edit-session）
 *
 * 职责：文件查看器的编辑阶段管理——阅读/编辑互切、脏状态判定、草稿防抖自动保存、
 * 覆盖保存/另存为/放弃流程、离开确认弹窗状态，并向 edit-guard 注册表登记会话
 * （供 App 的关闭/切换标签守卫查询）。
 *
 * 设计要点：
 * - 进入编辑时重新 file.read 原始内容：json 的显示是美化过的（formatJsonContent），
 *   编辑必须作用于磁盘原文，否则保存会把美化格式写回（改变用户文件）
 * - 脏判定 = 当前内容 !== 最近保存点内容；改回原文自动转清洁并停止草稿计时
 * - 草稿键由原路径哈希生成（draft-key），路径不出本机；草稿写失败静默重试
 *   （下次改动再写），保存/放弃成功后清理草稿
 * - 守卫确认弹窗（requestExit）返回 Promise：保存失败（如目标被移动/只读）时
 *   toast 提示并留在编辑（resolve false），由用户改用工具条「另存为」
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { setEditGuardSession } from '../../lib/edit-guard';
import { createAutoSaver } from './auto-saver';
import { draftKey } from './draft-key';

/** 草稿自动保存防抖间隔（毫秒）：输入停顿 2s 即落盘。 */
const DRAFT_AUTOSAVE_MS = 2000;

/** 离开确认弹窗动作（渲染层接 ConfirmDialog）。 */
export interface LeaveConfirmState {
  onSave: () => void;
  onDiscard: () => void;
  onCancel: () => void;
}

export interface EditSession {
  readonly mode: 'read' | 'edit';
  readonly dirty: boolean;
  /** 进入编辑中（重读原文）。 */
  readonly starting: boolean;
  /** 编辑器当前内容。 */
  readonly value: string;
  /** 内容版本号：放弃更改时 +1，编辑器组件以其为 key 重挂载回读初始值。 */
  readonly version: number;
  readonly confirm: LeaveConfirmState | null;
  /** 编辑器内容回写（脏判定 + 草稿调度）。 */
  setValue: (v: string) => void;
  startEdit: () => void;
  /** 请求退出编辑：脏时弹三键确认。resolve true = 允许离开（hook 已切回阅读）。 */
  requestExit: () => Promise<boolean>;
  /** 覆盖原文件保存。resolve true = 已保存。 */
  save: () => Promise<boolean>;
  /** 覆盖保存，失败自动转另存为（工具条「保存」按钮用）。 */
  saveWithFallback: () => Promise<boolean>;
  /** 另存为（系统对话框）。savedAsPath 非空时调用方导航到新文件。 */
  saveAs: () => Promise<{ saved: boolean; savedAsPath?: string }>;
  /** 放弃更改（清草稿、还原为最近保存点内容）。 */
  discard: () => Promise<void>;
  /** 取消确认弹窗（留在编辑）。 */
  cancelExit: () => void;
}

function errMessage(e: unknown): string {
  return (e as Error)?.message ?? String(e);
}

/** 取文件名（渲染层无 node:path，自行切分）。 */
function baseName(p: string): string {
  const idx = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'));
  return idx >= 0 ? p.slice(idx + 1) : p;
}

/** 取所在目录（无分隔符返回 null）。 */
function dirName(p: string): string | null {
  const idx = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'));
  return idx > 0 ? p.slice(0, idx) : null;
}

export function useEditSession(opts: {
  /** 原文件绝对路径；空串 = 非文件查看（会话禁用）。 */
  path: string;
  /** 进入编辑重读原文的读取上限（= read-plan 的 maxBytes）。 */
  maxBytes: number;
  /** 所属标签（守卫注册归属）；缺省不注册。 */
  tabId?: number;
  onToast: (msg: string) => void;
}): EditSession {
  const { path, maxBytes, tabId, onToast } = opts;

  const [mode, setMode] = useState<'read' | 'edit'>('read');
  const [dirty, setDirty] = useState(false);
  const [starting, setStarting] = useState(false);
  const [value, setValueState] = useState('');
  const [version, setVersion] = useState(0);
  const [confirm, setConfirm] = useState<LeaveConfirmState | null>(null);

  const valueRef = useRef('');
  const savedRef = useRef('');
  const keyRef = useRef('');
  const dirtyRef = useRef(false);
  const confirmResolveRef = useRef<((ok: boolean) => void) | null>(null);

  const setDirtyBoth = useCallback((v: boolean): void => {
    dirtyRef.current = v;
    setDirty(v);
  }, []);

  const flushDraft = useCallback(async (): Promise<void> => {
    if (!dirtyRef.current) return;
    try {
      await window.urchin.invoke('editor.saveDraft', {
        key: keyRef.current,
        content: valueRef.current,
      });
    } catch (e) {
      // 草稿写失败静默（下次改动重试）；主保存流程不依赖草稿
      console.warn('draft autosave failed', e);
    }
  }, []);

  const autoSaver = useMemo(() => createAutoSaver(DRAFT_AUTOSAVE_MS, flushDraft), [flushDraft]);
  useEffect(() => () => autoSaver.cancel(), [autoSaver]);

  const cleanupDraft = useCallback(async (): Promise<void> => {
    if (!keyRef.current) return;
    try {
      await window.urchin.invoke('editor.cleanupDraft', { key: keyRef.current });
    } catch {
      /* 清理失败不影响主流程（启动清扫兜底） */
    }
  }, []);

  const markClean = useCallback((): void => {
    savedRef.current = valueRef.current;
    autoSaver.cancel();
    setDirtyBoth(false);
  }, [autoSaver, setDirtyBoth]);

  // 路径切换复位（关键防错）：FileViewer 在「文件查看标签 → 文件查看标签」切换时
  // 不卸载（激活标签始终是 file-viewer），仅 path 变化——编辑会话若不复位，
  // 旧文件的编辑态（含旧内容与保存目标）会套在新文件上：显示旧内容、
  // 保存把旧内容写进新文件。脏状态不可能走到这里（脏时切换被守卫拦截，
  // 保存/放弃后才会放行），复位丢弃的只是与磁盘一致的只读编辑态。
  useEffect(() => {
    setMode('read');
    autoSaver.cancel();
    setDirtyBoth(false);
    valueRef.current = '';
    savedRef.current = '';
    keyRef.current = '';
    setValueState('');
    setVersion((v) => v + 1);
    setConfirm(null);
    confirmResolveRef.current = null;
  }, [path, autoSaver, setDirtyBoth]);

  const discard = useCallback(async (): Promise<void> => {
    autoSaver.cancel();
    valueRef.current = savedRef.current;
    setValueState(savedRef.current);
    setDirtyBoth(false);
    setVersion((v) => v + 1);
    await cleanupDraft();
  }, [autoSaver, cleanupDraft, setDirtyBoth]);

  const save = useCallback(async (): Promise<boolean> => {
    try {
      await window.urchin.invoke('file.write', { path, content: valueRef.current });
    } catch (e) {
      onToast('保存失败：' + errMessage(e));
      return false;
    }
    markClean();
    void cleanupDraft();
    return true;
  }, [path, markClean, cleanupDraft, onToast]);

  const saveAs = useCallback(async (): Promise<{ saved: boolean; savedAsPath?: string }> => {
    try {
      const res = (await window.urchin.invoke('file.saveAs', {
        content: valueRef.current,
        defaultName: baseName(path),
        defaultDir: dirName(path) ?? undefined,
      })) as { path: string | null };
      if (!res.path) return { saved: false };
      markClean();
      void cleanupDraft();
      return { saved: true, savedAsPath: res.path };
    } catch (e) {
      onToast('另存失败：' + errMessage(e));
      return { saved: false };
    }
  }, [path, markClean, cleanupDraft, onToast]);

  const saveWithFallback = useCallback(async (): Promise<boolean> => {
    const ok = await save();
    if (ok) return true;
    onToast('已转为另存为…');
    const r = await saveAs();
    return r.saved;
  }, [save, saveAs, onToast]);

  const setValue = useCallback(
    (v: string): void => {
      valueRef.current = v;
      setValueState(v);
      const isDirty = v !== savedRef.current;
      setDirtyBoth(isDirty);
      if (isDirty) autoSaver.schedule();
      else autoSaver.cancel();
    },
    [autoSaver, setDirtyBoth],
  );

  const startEdit = useCallback((): void => {
    if (!path || mode === 'edit' || starting) return;
    setStarting(true);
    void (async () => {
      try {
        // 重读磁盘原文（json 显示美化不参与编辑；markdown 编辑源为 md 文本）
        const res = (await window.urchin.invoke('file.read', {
          path,
          maxBytes,
        })) as { content: string };
        valueRef.current = res.content;
        savedRef.current = res.content;
        keyRef.current = draftKey(path);
        setValueState(res.content);
        setDirtyBoth(false);
        setVersion((v) => v + 1);
        setMode('edit');
      } catch (e) {
        onToast('无法进入编辑：' + errMessage(e));
      } finally {
        setStarting(false);
      }
    })();
  }, [path, maxBytes, mode, starting, onToast, setDirtyBoth]);

  const settle = useCallback((ok: boolean): void => {
    setConfirm(null);
    confirmResolveRef.current?.(ok);
    confirmResolveRef.current = null;
  }, []);

  const requestExit = useCallback((): Promise<boolean> => {
    if (!dirtyRef.current) {
      setMode('read');
      return Promise.resolve(true);
    }
    return new Promise<boolean>((resolve) => {
      confirmResolveRef.current = resolve;
      setConfirm({
        onSave: () => {
          void (async () => {
            const ok = await save();
            if (ok) setMode('read');
            settle(ok);
          })();
        },
        onDiscard: () => {
          void (async () => {
            await discard();
            setMode('read');
            settle(true);
          })();
        },
        onCancel: () => settle(false),
      });
    });
  }, [save, discard, settle]);

  const cancelExit = useCallback((): void => settle(false), [settle]);

  // 守卫注册：编辑期间向 edit-guard 登记会话（App 关闭/切换标签前查询）
  const dirtyStateRef = useRef(dirty);
  dirtyStateRef.current = dirty;
  useEffect(() => {
    if (mode !== 'edit' || !tabId || !path) return;
    setEditGuardSession({
      tabId,
      isDirty: () => dirtyStateRef.current,
      save,
      discard,
    });
    return () => setEditGuardSession(null);
  }, [mode, tabId, path, save, discard]);

  return {
    mode,
    dirty,
    starting,
    value,
    version,
    confirm,
    setValue,
    startEdit,
    requestExit,
    save,
    saveWithFallback,
    saveAs,
    discard,
    cancelExit,
  };
}
