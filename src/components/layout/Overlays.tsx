import { AnimatePresence, motion } from 'motion/react';
import { AlertTriangle, CheckCircle2, Info, Loader2, X, XCircle } from 'lucide-react';
import { cn } from '@/lib/cn';
import { api } from '@/lib/ipc';
import { useApp } from '@/store/app';
import { Progress } from '@/components/ui/Surface';

const icons = { info: Info, success: CheckCircle2, warn: AlertTriangle, error: XCircle };
const colors = { info: 'text-info', success: 'text-ok', warn: 'text-warn', error: 'text-err' };

export function Toaster() {
  const toasts = useApp((s) => s.toasts);
  const dismiss = useApp((s) => s.dismissToast);
  const instances = useApp((s) => s.instances);
  const openServer = useApp((s) => s.openServer);
  return (
    <div className="pointer-events-none fixed right-4 bottom-4 z-[60] flex w-[380px] flex-col gap-2">
      <AnimatePresence initial={false}>
        {toasts.map((t) => {
          const Icon = icons[t.level];
          const inst = t.serverId ? instances.find((i) => i.id === t.serverId) : undefined;
          return (
            <motion.div
              key={t.id}
              layout
              initial={{ opacity: 0, y: 12, scale: 0.97 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, x: 40 }}
              transition={{ duration: 0.16 }}
              className="pointer-events-auto flex items-start gap-3 rounded-xl border border-line-strong bg-panel-2/95 px-3.5 py-3 shadow-pop backdrop-blur"
            >
              <Icon className={cn('mt-0.5 size-4 shrink-0', colors[t.level])} />
              <div className="min-w-0 flex-1">
                {inst && (
                  <button onClick={() => openServer(inst.id)} className="mb-0.5 block text-[11px] font-medium text-fg-3 hover:text-accent">
                    {inst.name}
                  </button>
                )}
                <div className="text-[12.5px] leading-snug break-words text-fg">{t.message}</div>
              </div>
              <button onClick={() => dismiss(t.id)} className="text-fg-4 hover:text-fg">
                <X className="size-3.5" />
              </button>
            </motion.div>
          );
        })}
      </AnimatePresence>
    </div>
  );
}

export function TaskTray() {
  const all = useApp((s) => s.tasks);
  const tasks = Object.values(all).filter((t) => !t.done || t.error);
  const instances = useApp((s) => s.instances);
  if (!tasks.length) return null;
  return (
    <div className="fixed bottom-4 left-[252px] z-[55] flex w-[360px] flex-col gap-2">
      <AnimatePresence initial={false}>
        {tasks.map((t) => (
          <motion.div
            key={t.taskId}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 10 }}
            className="rounded-xl border border-line-strong bg-panel-2/95 px-3.5 py-3 shadow-pop backdrop-blur"
          >
            <div className="flex items-center gap-2">
              {t.error ? <XCircle className="size-4 text-err" /> : <Loader2 className="size-4 animate-spin text-accent" />}
              <div className="min-w-0 flex-1">
                <div className="truncate text-[12.5px] font-medium text-fg">{t.title}</div>
                {t.instanceId && <div className="truncate text-[11px] text-fg-4">{instances.find((i) => i.id === t.instanceId)?.name}</div>}
              </div>
              {!t.done && (
                <button onClick={() => api.cancelTask(t.taskId)} className="rounded px-1.5 py-0.5 text-[11px] text-fg-3 hover:bg-hover hover:text-fg">
                  Cancel
                </button>
              )}
            </div>
            <div className="mt-2 truncate text-[11.5px] text-fg-3">{t.error ?? t.message}</div>
            {!t.done && <Progress className="mt-2" value={t.progress} />}
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}
