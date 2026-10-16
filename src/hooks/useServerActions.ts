import { useCallback, useState } from 'react';
import { api, errMsg } from '@/lib/ipc';
import { confirm } from '@/components/ui/Dialog';
import { useApp } from '@/store/app';

export type Action = 'start' | 'stop' | 'forceStop' | 'restart' | 'warnRestart' | 'update' | 'validate' | 'install';

/** Start/stop/restart/update one server with confirmation and error toasts. */
export function useServerActions(id: string) {
  const [pending, setPending] = useState<Action | null>(null);
  const run = useCallback(
    async (a: Action) => {
      const st = useApp.getState();
      const inst = st.instances.find((i) => i.id === id);
      const status = st.statuses[id];
      const confirmOn = st.settings?.confirmDestructive ?? true;
      const name = inst?.name ?? 'server';
      const players = status?.players.length ?? 0;
      if (confirmOn && (a === 'stop' || a === 'restart' || a === 'forceStop') && status?.state === 'running') {
        const who = players > 0 ? ` ${players} player${players === 1 ? ' is' : 's are'} online.` : '';
        const res = await confirm({
          title: a === 'restart' ? `Restart ${name}?` : a === 'forceStop' ? `Force stop ${name}?` : `Stop ${name}?`,
          message:
            a === 'forceStop'
              ? `The process is killed immediately – anything since the last save may be lost.${who}`
              : `The server is asked to shut down cleanly (force-closed after ${inst?.automation.stopTimeoutSecs ?? 90}s). The world is kept by the game’s own saves and the manager’s backups.${who}`,
          confirm: a === 'restart' ? 'Restart' : a === 'forceStop' ? 'Force stop' : 'Stop server',
          danger: a === 'forceStop',
        });
        if (!res.ok) return;
      }
      if ((a === 'update' || a === 'validate') && status?.state === 'running' && confirmOn) {
        const res = await confirm({
          title: `${a === 'update' ? 'Update' : 'Validate'} ${name}?`,
          message: 'The server will be stopped cleanly, updated through SteamCMD and started again.',
          confirm: a === 'update' ? 'Update now' : 'Validate now',
        });
        if (!res.ok) return;
      }
      setPending(a);
      try {
        if (a === 'start') await api.start(id);
        else if (a === 'stop') await api.stop(id, false);
        else if (a === 'forceStop') await api.stop(id, true);
        else if (a === 'restart') await api.restart(id, false);
        else if (a === 'warnRestart') {
          const mins = inst?.automation.restartWarningMins || 5;
          await api.restart(id, false, mins);
          useApp.getState().toast('info', `Players warned – restarting in ${mins} min (cancel from the header)`, id);
        }
        else if (a === 'update' || a === 'install') await api.installServer(id, false);
        else if (a === 'validate') await api.installServer(id, true);
      } catch (e) {
        useApp.getState().toast('error', errMsg(e), id);
      } finally {
        setPending(null);
      }
    },
    [id],
  );
  return { run, pending };
}
