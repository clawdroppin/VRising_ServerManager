import { useState } from 'react';
import { Download, Home, Plus, Settings, Users } from 'lucide-react';
import { cn } from '@/lib/cn';
import { api } from '@/lib/ipc';
import { serverColor } from '@/lib/colors';
import { useServerHistory } from '@/lib/live';
import { onlineCount, useApp } from '@/store/app';
import { StatusDot } from '@/components/ui/Surface';
import type { ServerInstance } from '@/lib/types';

function ServerItem({ inst, index }: { inst: ServerInstance; index: number }) {
  const status = useApp((s) => s.statuses[inst.id]);
  const active = useApp((s) => s.active === inst.id);
  const openServer = useApp((s) => s.openServer);
  const hist = useServerHistory(inst.id);
  const last = hist[hist.length - 1];
  const live = status?.state === 'running' || status?.state === 'starting';
  const [over, setOver] = useState(false);

  return (
    <button
      draggable
      onDragStart={(e) => e.dataTransfer.setData('text/esm-server', String(index))}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        setOver(false);
        const from = +e.dataTransfer.getData('text/esm-server');
        if (isNaN(from) || from === index) return;
        const list = [...useApp.getState().instances];
        const [m] = list.splice(from, 1);
        list.splice(index, 0, m);
        useApp.setState({ instances: list });
        api.reorderInstances(list.map((i) => i.id));
      }}
      onClick={() => openServer(inst.id)}
      className={cn(
        'group relative flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors duration-150',
        active ? 'bg-hover text-fg' : 'text-fg-2 hover:bg-panel-2 hover:text-fg',
        over && 'ring-1 ring-accent/50',
      )}
    >
      <span className="absolute top-2 bottom-2 left-0 w-[3px] rounded-r-full transition-opacity" style={{ background: serverColor(inst.color), opacity: active ? 1 : 0.35 }} />
      <StatusDot state={status?.state} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[12.5px] font-medium">{inst.name}</div>
        <div className="mt-0.5 flex items-center gap-2 font-mono text-[10.5px] text-fg-4">
          {live && last ? (
            <>
              <span>{last.cpu.toFixed(0)}% cpu</span>
              <span>{(last.mem / 1073741824).toFixed(1)} GB</span>
            </>
          ) : (
            <span>:{inst.config.port}</span>
          )}
        </div>
      </div>
      {live && onlineCount(status) > 0 && (
        <span className="flex items-center gap-1 rounded-md bg-ok/10 px-1.5 py-0.5 font-mono text-[10.5px] text-ok">
          <Users className="size-3" />
          {onlineCount(status)}
        </span>
      )}
    </button>
  );
}

export function Sidebar() {
  const instances = useApp((s) => s.instances);
  const active = useApp((s) => s.active);
  const setActive = useApp((s) => s.setActive);
  const setDialog = useApp((s) => s.setDialog);
  const info = useApp((s) => s.info);
  const statuses = useApp((s) => s.statuses);
  const online = instances.filter((i) => statuses[i.id]?.state === 'running').length;

  return (
    <aside className="flex w-[236px] shrink-0 flex-col border-r border-line bg-bg">
      <div className="p-2.5">
        <button
          onClick={() => setActive('home')}
          className={cn(
            'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-[12.5px] font-medium transition-colors',
            active === 'home' ? 'bg-hover text-fg' : 'text-fg-2 hover:bg-panel-2 hover:text-fg',
          )}
        >
          <Home className="size-4 text-fg-3" />
          Dashboard
          <span className="ml-auto font-mono text-[10.5px] text-fg-4">
            {online}/{instances.length} online
          </span>
        </button>
      </div>
      <div className="flex items-center justify-between px-5 pt-1 pb-1.5">
        <span className="text-[10.5px] font-semibold tracking-[0.12em] text-fg-4 uppercase">Servers</span>
        <button title="New server (Ctrl+N)" onClick={() => setDialog({ kind: 'new' })} className="flex size-5 items-center justify-center rounded text-fg-3 hover:bg-hover hover:text-accent">
          <Plus className="size-3.5" />
        </button>
      </div>
      <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-2.5 pb-2">
        {instances.map((i, idx) => (
          <ServerItem key={i.id} inst={i} index={idx} />
        ))}
        {instances.length === 0 && (
          <button
            onClick={() => setDialog({ kind: 'new' })}
            className="flex w-full flex-col items-center gap-1 rounded-xl border border-dashed border-line-strong px-3 py-5 text-center text-[12px] text-fg-3 hover:border-accent/50 hover:text-fg-2"
          >
            <Plus className="size-4 text-accent" />
            Create your first server
          </button>
        )}
      </div>
      <div className="space-y-0.5 border-t border-line p-2.5">
        <button onClick={() => setDialog({ kind: 'new' })} className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-[12.5px] text-fg-2 hover:bg-panel-2 hover:text-fg">
          <Plus className="size-4 text-accent" /> New server
        </button>
        <button onClick={() => setDialog({ kind: 'import' })} className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-[12.5px] text-fg-2 hover:bg-panel-2 hover:text-fg">
          <Download className="size-4 text-fg-3" /> Import server
        </button>
        <button onClick={() => setDialog({ kind: 'settings' })} className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-[12.5px] text-fg-2 hover:bg-panel-2 hover:text-fg">
          <Settings className="size-4 text-fg-3" /> App settings
          <span className="ml-auto font-mono text-[10px] text-fg-4">v{info?.version}</span>
        </button>
      </div>
    </aside>
  );
}
