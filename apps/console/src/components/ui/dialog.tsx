import { useEffect, type FormEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { Button } from './button';

/**
 * The modal frame, as Landflow's data-tables/dialog.tsx: portalled; Escape and a click outside close it. With
 * `onSubmit` the body is a form, so Enter submits.
 */
export function Dialog({
  title,
  subtitle,
  onClose,
  children,
  footer,
  onSubmit,
  width = 520,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  onSubmit?: () => void;
  width?: number;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  const inner = (
    <>
      <header className="flex items-center gap-3 border-b border-hair px-5 py-3.5">
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-[15px] font-semibold text-t1">{title}</h2>
          {subtitle && <p className="truncate text-[12px] text-t3">{subtitle}</p>}
        </div>
        <Button type="button" size="icon-sm" variant="ghost" onClick={onClose} aria-label="Close">
          <X className="size-4" />
        </Button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
      {footer && (
        <footer className="flex items-center justify-end gap-2 border-t border-hair px-5 py-3">{footer}</footer>
      )}
    </>
  );
  const frame =
    'flex max-h-[min(760px,90vh)] max-w-full flex-col overflow-hidden rounded-2xl border border-hair bg-sf shadow-pop animate-in';
  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-overlay p-6 animate-in"
      onMouseDown={onClose}
    >
      {onSubmit ? (
        <form
          role="dialog"
          aria-label={typeof title === 'string' ? title : undefined}
          onMouseDown={(e) => e.stopPropagation()}
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            onSubmit();
          }}
          style={{ width }}
          className={frame}
        >
          {inner}
        </form>
      ) : (
        <div
          role="dialog"
          aria-label={typeof title === 'string' ? title : undefined}
          onMouseDown={(e) => e.stopPropagation()}
          style={{ width }}
          className={frame}
        >
          {inner}
        </div>
      )}
    </div>,
    document.body,
  );
}

/** "Deactivate …?" with a danger button. */
export function ConfirmDialog({
  title,
  message,
  action,
  busy,
  onConfirm,
  onClose,
}: {
  title: string;
  message: ReactNode;
  action: string;
  busy?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <Dialog
      title={title}
      onClose={onClose}
      width={440}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="danger" onClick={onConfirm} loading={busy} autoFocus>
            {action}
          </Button>
        </>
      }
    >
      <div className="text-[13px] leading-relaxed text-t2">{message}</div>
    </Dialog>
  );
}

/** A form error, under the fields. */
export function FormError({ error }: { error: unknown }) {
  if (!error) return null;
  return (
    <p role="alert" className="rounded-[10px] border border-rdbd bg-rddim px-3 py-2 text-[12px] text-rd">
      {error instanceof Error ? error.message : String(error)}
    </p>
  );
}
