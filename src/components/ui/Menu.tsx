import { useEffect, useRef, useState, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { cn } from '@/lib/cn';

export interface MenuItem {
  label: ReactNode;
  icon?: ReactNode;
  onSelect?: () => void;
  danger?: boolean;
  disabled?: boolean;
  hint?: ReactNode;
  separator?: boolean;
}

/** Small click-to-open dropdown menu anchored to its trigger. */
export function Menu({ trigger, items, align = 'end', width = 220 }: { trigger: (open: boolean) => ReactNode; items: MenuItem[]; align?: 'start' | 'end'; width?: number }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const k = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('mousedown', h);
    window.addEventListener('keydown', k);
    return () => {
      window.removeEventListener('mousedown', h);
      window.removeEventListener('keydown', k);
    };
  }, [open]);
  return (
    <div ref={ref} className="relative">
      <div onClick={() => setOpen(!open)}>{trigger(open)}</div>
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: -4, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -4, scale: 0.98 }}
            transition={{ duration: 0.12 }}
            style={{ width }}
            className={cn('absolute top-full z-40 mt-1.5 rounded-xl border border-line-strong bg-panel-2 p-1 shadow-pop', align === 'end' ? 'right-0' : 'left-0')}
          >
            {items.map((it, i) =>
              it.separator ? (
                <div key={i} className="my-1 h-px bg-line" />
              ) : (
                <button
                  key={i}
                  disabled={it.disabled}
                  onClick={() => {
                    setOpen(false);
                    it.onSelect?.();
                  }}
                  className={cn(
                    'flex h-8 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-[12.5px] transition-colors disabled:opacity-40 [&_svg]:size-3.5',
                    it.danger ? 'text-err hover:bg-err/10' : 'text-fg-2 hover:bg-hover hover:text-fg',
                  )}
                >
                  <span className={cn('shrink-0', it.danger ? 'text-err' : 'text-fg-3')}>{it.icon}</span>
                  <span className="flex-1 truncate">{it.label}</span>
                  {it.hint && <span className="text-[11px] text-fg-4">{it.hint}</span>}
                </button>
              ),
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
