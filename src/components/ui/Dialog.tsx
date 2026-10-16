import { useEffect, useState, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { AlertTriangle, X } from 'lucide-react';
import { create } from 'zustand';
import { cn } from '@/lib/cn';
import { Button } from './Button';

export function Dialog({
  open,
  onClose,
  title,
  description,
  icon,
  children,
  footer,
  width = 560,
  className,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  icon?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
  className?: string;
}) {
  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [open, onClose]);
  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6 backdrop-blur-[3px]"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.14 }}
          onMouseDown={(e) => e.target === e.currentTarget && onClose()}
        >
          <motion.div
            role="dialog"
            className={cn('flex max-h-full w-full flex-col overflow-hidden rounded-2xl border border-line-strong bg-panel shadow-pop', className)}
            style={{ maxWidth: width }}
            initial={{ opacity: 0, y: 10, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 6, scale: 0.985 }}
            transition={{ duration: 0.16, ease: [0.2, 0.8, 0.2, 1] }}
          >
            <div className="flex items-start gap-3 border-b border-line px-5 py-4">
              {icon && <div className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-accent-dim/70 text-accent [&_svg]:size-[18px]">{icon}</div>}
              <div className="min-w-0 flex-1">
                <div className="text-[15px] font-semibold text-fg">{title}</div>
                {description && <div className="mt-0.5 text-[12.5px] leading-relaxed text-fg-3">{description}</div>}
              </div>
              <button onClick={onClose} className="flex size-7 items-center justify-center rounded-md text-fg-3 hover:bg-hover hover:text-fg">
                <X className="size-4" />
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
            {footer && <div className="flex items-center justify-end gap-2 border-t border-line bg-bg-raised/60 px-5 py-3">{footer}</div>}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

// ------------------------------------------------------------------ confirm()

interface ConfirmReq {
  title: string;
  message?: ReactNode;
  confirm?: string;
  danger?: boolean;
  checkbox?: string;
  /** Show a text field with this initial value; its text comes back as `value`. */
  input?: string;
  inputPlaceholder?: string;
  resolve: (v: { ok: boolean; checked: boolean; value: string }) => void;
}

const useConfirm = create<{ req: ConfirmReq | null; set: (r: ConfirmReq | null) => void }>((set) => ({ req: null, set: (req) => set({ req }) }));

/** Promise-based confirmation dialog. */
export function confirm(opts: Omit<ConfirmReq, 'resolve'>): Promise<{ ok: boolean; checked: boolean; value: string }> {
  return new Promise((resolve) => useConfirm.getState().set({ ...opts, resolve }));
}

export function ConfirmHost() {
  const { req, set } = useConfirm();
  const [checked, setChecked] = useState(false);
  const [value, setValue] = useState('');
  useEffect(() => {
    setChecked(false);
    setValue(req?.input ?? '');
  }, [req]);
  const done = (ok: boolean) => {
    req?.resolve({ ok, checked, value: value.trim() });
    set(null);
  };
  return (
    <Dialog
      open={!!req}
      onClose={() => done(false)}
      title={req?.title}
      icon={req?.danger ? <AlertTriangle /> : undefined}
      width={460}
      footer={
        <>
          <Button variant="ghost" onClick={() => done(false)}>
            Cancel
          </Button>
          <Button variant={req?.danger ? 'danger' : 'primary'} onClick={() => done(true)} disabled={req?.input !== undefined && !value.trim()} autoFocus={req?.input === undefined}>
            {req?.confirm ?? 'Confirm'}
          </Button>
        </>
      }
    >
      <div className="text-[12.5px] leading-relaxed text-fg-2">{req?.message}</div>
      {req?.input !== undefined && (
        <input
          autoFocus
          value={value}
          placeholder={req.inputPlaceholder}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && value.trim() && done(true)}
          className="mt-3 h-9 w-full rounded-lg border border-line-strong bg-bg-raised px-3 text-[13px] text-fg outline-none placeholder:text-fg-4 focus:border-accent/60"
        />
      )}
      {req?.checkbox && (
        <label className="mt-4 flex items-center gap-2 text-[12.5px] text-fg-2">
          <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} className="accent-accent" />
          {req.checkbox}
        </label>
      )}
    </Dialog>
  );
}
