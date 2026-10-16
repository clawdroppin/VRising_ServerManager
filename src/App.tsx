import { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Loader2 } from 'lucide-react';
import { api, errMsg, listen } from '@/lib/ipc';
import { useApp } from '@/store/app';
import { useBackendEvents } from '@/hooks/useBackendEvents';
import { TitleBar } from '@/components/layout/TitleBar';
import { Sidebar } from '@/components/layout/Sidebar';
import { TabBar } from '@/components/layout/TabBar';
import { TaskTray, Toaster } from '@/components/layout/Overlays';
import { CommandPalette } from '@/components/layout/CommandPalette';
import { confirm, ConfirmHost } from '@/components/ui/Dialog';
import { Dashboard } from '@/features/dashboard/Dashboard';
import { Workspace } from '@/features/server/Workspace';
import { NewServerDialog } from '@/features/dialogs/NewServerDialog';
import { AppSettingsDialog, CloneDialog, DeleteDialog, ExportDialog, ImportDialog } from '@/features/dialogs/Dialogs';

function useShortcuts() {
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (!e.ctrlKey) return;
      const s = useApp.getState();
      const k = e.key.toLowerCase();
      if (k === 'n') {
        e.preventDefault();
        s.setDialog({ kind: 'new' });
      } else if (k === 'w' && s.active !== 'home') {
        e.preventDefault();
        s.closeTab(s.active);
      } else if (e.key === 'Tab') {
        e.preventDefault();
        const order = ['home', ...s.tabs];
        const i = order.indexOf(s.active);
        s.setActive(order[(i + (e.shiftKey ? order.length - 1 : 1)) % order.length]);
      } else if (/^[1-9]$/.test(e.key)) {
        e.preventDefault();
        const order = ['home', ...s.tabs];
        const t = order[+e.key - 1];
        if (t) s.setActive(t);
      }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, []);
}

/** Window close: hide to tray (automation keeps running) or quit; servers survive either way. */
function useCloseHandler() {
  useEffect(() => {
    const off = listen('app://close-requested', async () => {
      const s = useApp.getState();
      if (s.settings?.closeToTray ?? true) {
        await api.hideWindow();
        return;
      }
      const running = s.instances.filter((i) => ['running', 'starting'].includes(s.statuses[i.id]?.state ?? '')).length;
      if (running > 0) {
        const r = await confirm({
          title: 'Quit the manager?',
          message: `${running} server${running === 1 ? ' keeps' : 's keep'} running, but crash recovery, schedules and backups pause until you open the manager again.`,
          confirm: 'Quit',
        });
        if (!r.ok) return;
      }
      await api.quit();
    });
    return () => {
      off.then((f) => f());
    };
  }, []);
}

export function App() {
  const ready = useApp((s) => s.ready);
  const active = useApp((s) => s.active);
  const [error, setError] = useState<string | null>(null);
  useBackendEvents();
  useShortcuts();
  useCloseHandler();

  useEffect(() => {
    useApp
      .getState()
      .init()
      .then(() => {
        // Secrets sealed on another PC/Windows account can't be decrypted here.
        const lost = useApp.getState().info?.lostSecrets ?? [];
        if (lost.length) useApp.getState().toast('warn', `Couldn't decrypt ${lost.length} saved secret(s) – re-enter them: ${lost.join(', ')}`);
      })
      .catch((e) => setError(errMsg(e)));
  }, []);

  return (
    <div className="flex h-full flex-col">
      <TitleBar />
      {!ready ? (
        <div className="flex flex-1 items-center justify-center gap-2 text-[13px] text-fg-3">
          {error ? (
            <span className="text-err">Failed to start: {error}</span>
          ) : (
            <>
              <Loader2 className="size-4 animate-spin text-accent" /> Waking from the crypt…
            </>
          )}
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          <Sidebar />
          <main className="flex min-w-0 flex-1 flex-col bg-bg">
            <TabBar />
            <div className="relative min-h-0 flex-1 bg-panel/30">
              <AnimatePresence mode="wait" initial={false}>
                <motion.div
                  key={active}
                  className="absolute inset-0"
                  initial={{ opacity: 0, y: 4 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.12, ease: 'easeOut' }}
                >
                  {active === 'home' ? <Dashboard /> : <Workspace id={active} />}
                </motion.div>
              </AnimatePresence>
            </div>
          </main>
        </div>
      )}
      <NewServerDialog />
      <ImportDialog />
      <ExportDialog />
      <CloneDialog />
      <DeleteDialog />
      <AppSettingsDialog />
      <CommandPalette />
      <ConfirmHost />
      <Toaster />
      <TaskTray />
    </div>
  );
}
