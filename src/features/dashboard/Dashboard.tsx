import { useState } from 'react';
import { motion } from 'motion/react';
import { ArrowUpRight, Cpu, Download, Moon, MemoryStick, Network, Play, Plus, Server, Square, Users } from 'lucide-react';
import { api, errMsg } from '@/lib/ipc';
import { bytes, pct } from '@/lib/format';
import { serverColor } from '@/lib/colors';
import { useServerHistory, useSystemHistory } from '@/lib/live';
import type { ServerInstance } from '@/lib/types';
import { onlineCount, useApp } from '@/store/app';
import { Sparkline, SERIES } from '@/components/charts/Charts';
import { Button } from '@/components/ui/Button';
import { confirm } from '@/components/ui/Dialog';
import { Card, StatusPill } from '@/components/ui/Surface';
import { ServerControls } from '@/features/server/ServerControls';

function ServerCard({ inst, i }: { inst: ServerInstance; i: number }) {
  const st = useApp((s) => s.statuses[inst.id]);
  const openServer = useApp((s) => s.openServer);
  const hist = useServerHistory(inst.id);
  const win = hist.slice(-90);
  const last = hist[hist.length - 1];
  const live = st?.state === 'running' || st?.state === 'starting';
  return (
    <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.18, delay: Math.min(i * 0.03, 0.2) }}>
      <Card interactive className="group relative flex h-full flex-col overflow-hidden p-0">
        <div className="absolute inset-x-0 top-0 h-[2px]" style={{ background: serverColor(inst.color), opacity: live ? 1 : 0.4 }} />
        <button onClick={() => openServer(inst.id)} className="flex flex-1 flex-col p-4 text-left">
          <div className="flex items-start gap-3">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5 truncate text-[14px] font-semibold text-fg">
                {inst.name}
                <ArrowUpRight className="size-3.5 text-fg-4 opacity-0 transition-opacity group-hover:opacity-100" />
              </div>
              <div className="mt-0.5 truncate font-mono text-[11px] text-fg-4">
                “{inst.config.name}” · UDP {inst.config.port}/{inst.config.queryPort} · {inst.config.gameSettingsPreset || 'custom rules'}
              </div>
            </div>
            <StatusPill state={st?.state} busy={st?.busy} />
          </div>
          <div className="mt-4 grid grid-cols-3 gap-3">
            <div>
              <div className="text-[10.5px] tracking-wide text-fg-4 uppercase">CPU</div>
              <div className="font-mono text-[14px] text-fg">{live && last ? pct(last.cpu, 1) : '—'}</div>
            </div>
            <div>
              <div className="text-[10.5px] tracking-wide text-fg-4 uppercase">Memory</div>
              <div className="font-mono text-[14px] text-fg">{live && last ? bytes(last.mem) : '—'}</div>
            </div>
            <div>
              <div className="text-[10.5px] tracking-wide text-fg-4 uppercase">Players</div>
              <div className="font-mono text-[14px] text-fg">{live ? `${onlineCount(st)}/${inst.config.maxConnectedUsers}` : '—'}</div>
            </div>
          </div>
          <Sparkline className="mt-3" height={36} values={win.map((p) => p.cpu)} max={Math.max(10, ...win.map((p) => p.cpu)) * 1.2} color={serverColor(inst.color)} />
        </button>
        <div className="flex items-center justify-between border-t border-line bg-bg-raised/50 px-4 py-2.5">
          <span className="text-[11.5px] text-fg-4">
            {st?.installedBuild && st.latestBuild && st.installedBuild !== st.latestBuild ? <span className="text-accent">Update available</span> : st?.installedBuild ? `Build ${st.installedBuild}` : st?.state === 'notInstalled' ? 'Not installed' : ''}
          </span>
          <ServerControls id={inst.id} size="sm" compact />
        </div>
      </Card>
    </motion.div>
  );
}

function SystemStrip() {
  const sys = useSystemHistory();
  const info = useApp((s) => s.info);
  const win = sys.slice(-90);
  const last = sys[sys.length - 1];
  const tiles = [
    { label: 'CPU', icon: Cpu, value: last ? pct(last.cpu) : '—', sub: `${info?.cores ?? '?'} logical cores`, values: win.map((p) => p.cpu), max: 100 },
    { label: 'Memory', icon: MemoryStick, value: last ? bytes(last.memUsed) : '—', sub: last ? `of ${bytes(last.memTotal)}` : '', values: win.map((p) => p.memUsed), fit: true },
    { label: 'Network in', icon: Network, value: last ? `${bytes(last.rxBps)}/s` : '—', sub: 'whole PC', values: win.map((p) => p.rxBps), color: SERIES[1] },
    { label: 'Network out', icon: Network, value: last ? `${bytes(last.txBps)}/s` : '—', sub: 'whole PC', values: win.map((p) => p.txBps), color: SERIES[0] },
  ];
  return (
    <div className="grid grid-cols-4 gap-4">
      {tiles.map((t) => (
        <Card key={t.label} className="p-4">
          <div className="flex items-center gap-2 text-[11px] font-medium tracking-wide text-fg-3 uppercase">
            <t.icon className="size-3.5" />
            {t.label}
          </div>
          <div className="mt-1.5 flex items-baseline gap-2">
            <span className="font-mono text-[19px] font-semibold text-fg tabular-nums">{t.value}</span>
            <span className="text-[11px] text-fg-4">{t.sub}</span>
          </div>
          <Sparkline className="mt-2" height={28} values={t.values} max={t.max} color={t.color} fit={t.fit} />
        </Card>
      ))}
    </div>
  );
}

export function Dashboard() {
  const instances = useApp((s) => s.instances);
  const statuses = useApp((s) => s.statuses);
  const info = useApp((s) => s.info);
  const setDialog = useApp((s) => s.setDialog);
  const toast = useApp((s) => s.toast);
  const [bulk, setBulk] = useState<'start' | 'stop' | null>(null);
  const online = instances.filter((i) => statuses[i.id]?.state === 'running');
  const players = online.reduce((n, i) => n + onlineCount(statuses[i.id]), 0);
  const startable = instances.filter((i) => ['stopped', 'crashed'].includes(statuses[i.id]?.state ?? ''));
  const hour = new Date().getHours();
  const greet = hour < 5 ? 'The night is young, vampire' : hour < 12 ? 'Mind the sun, vampire' : hour < 18 ? 'Stay in the shade, vampire' : 'Good evening, vampire';

  const bulkRun = async (a: 'start' | 'stop') => {
    if (a === 'stop') {
      const r = await confirm({ title: `Stop ${online.length} server${online.length === 1 ? '' : 's'}?`, message: 'Each server saves and shuts down cleanly.', confirm: 'Stop all' });
      if (!r.ok) return;
    }
    setBulk(a);
    for (const i of a === 'start' ? startable : online) {
      try {
        if (a === 'start') await api.start(i.id);
        else await api.stop(i.id);
      } catch (e) {
        toast('error', `${i.name}: ${errMsg(e)}`, i.id);
      }
    }
    setBulk(null);
  };

  return (
    <div className="h-full overflow-y-auto">
      <div className="shroud-sky relative border-b border-line">
        <div className="mx-auto max-w-[1280px] px-8 pt-8 pb-7">
          <div className="flex items-end justify-between gap-6">
            <div>
              <div className="flex items-center gap-2 text-[12px] font-medium text-accent">
                <Moon className="size-3.5" /> {info?.hostname ?? 'This PC'}
              </div>
              <h1 className="mt-1.5 text-[26px] font-semibold tracking-tight text-fg">{greet}</h1>
              <p className="mt-1 text-[13px] text-fg-3">
                {instances.length === 0
                  ? 'Create your first V Rising dedicated server – a minute of setup plus a ~300 MB download.'
                  : `${online.length} of ${instances.length} server${instances.length === 1 ? '' : 's'} online · ${players} player${players === 1 ? '' : 's'} connected`}
              </p>
            </div>
            <div className="flex gap-2">
              {instances.length > 0 && (
                <>
                  <Button icon={<Play className="size-3.5" />} disabled={!startable.length} loading={bulk === 'start'} onClick={() => bulkRun('start')}>
                    Start all
                  </Button>
                  <Button icon={<Square className="size-3.5" />} disabled={!online.length} loading={bulk === 'stop'} onClick={() => bulkRun('stop')}>
                    Stop all
                  </Button>
                </>
              )}
              <Button icon={<Download className="size-3.5" />} onClick={() => setDialog({ kind: 'import' })}>
                Import
              </Button>
              <Button variant="primary" size="md" icon={<Plus className="size-4" />} onClick={() => setDialog({ kind: 'new' })}>
                New server
              </Button>
            </div>
          </div>
        </div>
      </div>
      <div className="mx-auto max-w-[1280px] space-y-6 px-8 py-6">
        <SystemStrip />
        <div>
          <div className="mb-3 flex items-center gap-2 text-[12px] font-semibold tracking-[0.1em] text-fg-3 uppercase">
            <Server className="size-3.5" /> Servers
            {players > 0 && (
              <span className="ml-2 flex items-center gap-1 font-mono text-[11px] tracking-normal text-ok normal-case">
                <Users className="size-3" /> {players} online
              </span>
            )}
          </div>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(320px,1fr))] gap-4">
            {instances.map((i, idx) => (
              <ServerCard key={i.id} inst={i} i={idx} />
            ))}
            <button
              onClick={() => setDialog({ kind: 'new' })}
              className="group flex min-h-[210px] flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-line-strong text-fg-3 transition-colors hover:border-accent/60 hover:bg-accent/[0.03] hover:text-fg"
            >
              <div className="flex size-11 items-center justify-center rounded-xl border border-line bg-panel-2 transition-colors group-hover:border-accent/40 group-hover:text-accent">
                <Plus className="size-5" />
              </div>
              <div className="text-[13px] font-medium">Create a server</div>
              <div className="text-[11.5px] text-fg-4">Install, configure and launch in one flow</div>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
