import { useEffect } from 'react';
import { listen } from '@/lib/ipc';
import { pushLines, pushTelemetry } from '@/lib/live';
import type { LogBatch, PlayerEvent, ServerEvent, ServerStatus, TaskEvent, TelemetryEvent } from '@/lib/types';
import { useApp } from '@/store/app';

/** Bridge every backend event into the stores. Mounted once in App. */
export function useBackendEvents() {
  useEffect(() => {
    const offs: Promise<() => void>[] = [
      listen<ServerStatus>('server-status', (s) => useApp.getState().setStatus(s)),
      listen<TelemetryEvent>('telemetry', (t) => pushTelemetry(t.ts, t.system, t.servers)),
      listen<LogBatch>('log-lines', (b) => pushLines(b.id, b.source, b.lines, b.ts)),
      listen<TaskEvent>('task', (t) => {
        useApp.getState().applyTask(t);
        // SteamCMD output also goes into the server's console.
      }),
      listen<ServerEvent>('server-event', (e) => useApp.getState().toast(e.level, e.message, e.id)),
      listen<PlayerEvent>('player-event', (e) => useApp.getState().addPlayerEvent(e)),
      listen<unknown>('instances-changed', () => void useApp.getState().refresh()),
    ];
    return () => {
      offs.forEach((p) => p.then((off) => off()));
    };
  }, []);
}
