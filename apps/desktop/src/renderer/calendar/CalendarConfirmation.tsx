import { useEffect, useRef, type ReactNode } from 'react';

export function CalendarConfirmation({
  title,
  message,
  confirmLabel,
  onCancel,
  onConfirm,
  busy,
  children,
}: {
  readonly title: string;
  readonly message: string;
  readonly confirmLabel: string;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
  readonly busy: boolean;
  readonly children?: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const previous = document.activeElement;
    const dialog = ref.current;
    dialog?.showModal();
    return () => {
      dialog?.close();
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      role="alertdialog"
      aria-label={title}
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onCancel();
      }}
      className="m-auto max-w-md rounded-lg border border-border bg-surface p-5 text-sm text-text shadow-xl backdrop:bg-black/50"
    >
      <p>{message}</p>
      {children}
      <div className="mt-4 flex justify-end gap-2">
        <button
          type="button"
          autoFocus
          className="rounded px-3 py-2 hover:bg-primary/10"
          disabled={busy}
          onClick={onCancel}
        >
          继续保留
        </button>
        <button
          type="button"
          className="rounded px-3 py-2 text-error hover:bg-primary/10"
          disabled={busy}
          onClick={onConfirm}
        >
          {confirmLabel}
        </button>
      </div>
    </dialog>
  );
}
