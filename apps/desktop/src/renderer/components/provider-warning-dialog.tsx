/**
 * M13 AI Side Panel · 第三方 Provider 安装 warning 对话框（IP8 决策）
 *
 * 依据：契约 A §6 IP8 / W5-D2
 *
 * 职责：
 * 1. 用户安装第三方 Provider 前强制显示 warning
 * 2. 用户必须输入「我确认」才能继续安装
 * 3. 调用 provider.install IPC：先 confirm=false 获取 warning 文案，再 confirm=true 执行安装
 *
 * IP8 决策：
 * - v0.1 允许第三方加载，但 UI 强制 warning
 * - 用户必须输入「我确认」才能继续
 * - v0.1 不做签名校验；v0.4 引入签名 + allowlist
 */
import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, X } from 'lucide-react';
import { Button } from './ui/button';
import { Input } from './ui/input';

/** provider.install 返回的 warning payload（与 ipc-schema ProviderInstallWarningRes 对齐） */
interface InstallWarning {
  readonly confirmationRequired: true;
  readonly warning: string;
  readonly confirmPhrase: string;
}

/** provider.install 成功响应 */
interface InstallSuccess {
  readonly confirmationRequired: false;
  readonly providerId: string;
  readonly source: string;
}

interface ProviderWarningDialogProps {
  /** 是否显示 */
  readonly open: boolean;
  /** 安装源（本地路径或 npm 包名） */
  readonly source: string;
  /** 关闭对话框 */
  readonly onClose: () => void;
  /** 安装成功回调 */
  readonly onInstalled: (result: InstallSuccess) => void;
  /** 安装失败回调 */
  readonly onError: (error: string) => void;
}

/**
 * 第三方 Provider 安装 warning 对话框。
 *
 * 流程：
 * 1. open=true 时，调用 provider.install({source, confirm: false}) 获取 warning
 * 2. 显示 warning 文案，要求用户输入 confirmPhrase
 * 3. 用户点击「确认安装」且输入匹配时，调用 provider.install({source, confirm: true})
 */
export function ProviderWarningDialog({
  open,
  source,
  onClose,
  onInstalled,
  onError,
}: ProviderWarningDialogProps) {
  const [warning, setWarning] = useState<string>('');
  const [confirmPhrase, setConfirmPhrase] = useState<string>('我确认');
  const [userInput, setUserInput] = useState<string>('');
  const [installing, setInstalling] = useState<boolean>(false);
  const [loadingWarning, setLoadingWarning] = useState<boolean>(false);

  // open 变化时获取 warning
  useEffect(() => {
    if (!open) {
      setUserInput('');
      setWarning('');
      return;
    }

    let cancelled = false;
    setLoadingWarning(true);
    void (async () => {
      try {
        const result = (await window.urchin.invoke('provider.install', {
          source,
          confirm: false,
        })) as InstallWarning | InstallSuccess;

        if (cancelled) return;

        if (result.confirmationRequired) {
          setWarning(result.warning);
          setConfirmPhrase(result.confirmPhrase);
        } else {
          // 不需要确认（理论上 v0.1 不会走到这里）
          onInstalled(result);
        }
      } catch (e) {
        if (!cancelled) {
          onError(e instanceof Error ? e.message : String(e));
        }
      } finally {
        if (!cancelled) setLoadingWarning(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [open, source, onInstalled, onError]);

  const handleConfirm = useCallback(async () => {
    if (userInput !== confirmPhrase) return;
    setInstalling(true);
    try {
      const result = (await window.urchin.invoke('provider.install', {
        source,
        confirm: true,
      })) as InstallSuccess;
      onInstalled(result);
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setInstalling(false);
    }
  }, [userInput, confirmPhrase, source, onInstalled, onError]);

  if (!open) return null;

  const canConfirm = userInput === confirmPhrase && !installing && !loadingWarning;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="w-full max-w-md rounded-lg border border-border bg-surface shadow-lg">
        {/* Header */}
        <div className="flex items-start gap-3 border-b border-border p-4">
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-warning" />
          <div className="flex-1">
            <h2 className="text-base font-semibold text-text">第三方 Provider 安装确认</h2>
            <p className="mt-1 text-xs text-text-secondary">来源：{source}</p>
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 w-7 p-0"
            onClick={onClose}
            aria-label="关闭"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>

        {/* Body：warning 文案 */}
        <div className="p-4">
          {loadingWarning ? (
            <p className="text-sm text-text-secondary">加载警告信息...</p>
          ) : (
            <>
              <div className="rounded-md border border-warning/30 bg-warning/10 p-3">
                <p className="text-sm text-text">{warning}</p>
              </div>
              <div className="mt-4">
                <label className="text-xs font-medium text-text-secondary">
                  请输入 <span className="font-bold text-text">{confirmPhrase}</span> 以确认安装
                </label>
                <Input
                  className="mt-1"
                  value={userInput}
                  onChange={(e) => setUserInput(e.target.value)}
                  placeholder={confirmPhrase}
                  disabled={installing}
                  autoFocus
                />
              </div>
            </>
          )}
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-2 border-t border-border p-4">
          <Button variant="ghost" size="sm" onClick={onClose} disabled={installing}>
            取消
          </Button>
          <Button
            variant="danger"
            size="sm"
            onClick={() => void handleConfirm()}
            disabled={!canConfirm}
            loading={installing}
          >
            确认安装
          </Button>
        </div>
      </div>
    </div>
  );
}
