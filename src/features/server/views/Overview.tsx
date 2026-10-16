import { useEffect, useState } from 'react';
import {
  Archive,
  ArrowRight,
  CalendarClock,
  Check,
  CircleDashed,
  Copy,
  Cpu,
  Eye,
  EyeOff,
  Globe2,
  HardDrive,
  KeyRound,
  History,
  MemoryStick,
  Save,
  Search,
  Terminal,
  Users,
} from 'lucide-react';
import { api } from '@/lib/ipc';
import { cn } from '@/lib/cn';
import { ago, bytes, clock, mask, pct, until } from '@/lib/format';
import { isNoise, lineLevel, seedLines, useLogLines, useServerHistory } from '@/lib/live';
import { copy } from '@/lib/shell';
import type { EventRow } from '@/lib/types';
import { onlineCount, useApp, useInstance, useStatus } from '@/store/app';
import { Sparkline } from '@/components/charts/Charts';
import { Button } from '@/components/ui/Button';
import { Badge, Callout, Card, Stat } from '@/components/ui/Surface';
import { ServerControls } from '../ServerControls';

function CopyChip({ label, value, icon, secret }: { label: string; value: string; icon: React.ReactNode; secret?: boolean }) {
  const [done, setDone] = useState(false);
  const streamer = useApp((s) => s.settings?.streamerMode ?? false);
  const [show, setShow] = useState(false);
  const hidden = secret && (!show || streamer);
  return (
    <div className="group flex min-w-0 flex-1 items-center gap-3 rounded-xl border border-line bg-bg-raised px-3.5 py-2.5 transition-colors hover:border-line-strong">
      <div className="text-fg-4 [&_svg]:size-4">{icon}</div>
      <div className="min-w-0 flex-1">
        <div className="text-[10.5px] font-medium tracking-wide text-fg-4 uppercase">{label}</div>
        <div className="selectable truncate font-mono text-[13px] text-fg">{hidden ? '•'.repeat(Math.min(14, value.length || 8)) : value || '—'}</div>
      </div>
      {secret && !streamer && (
        <button title={show ? 'Hide' : 'Show'} onClick={() => setShow(!show)} className="text-fg-4 hover:text-fg">
          {show ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
        </button>
      )}
      <button
        title="Copy"
        onClick={() => {
          copy(value);
          setDone(true);
          setTimeout(() => setDone(false), 1200);
        }}
        className="text-fg-4 hover:text-fg"
      >
        {done ? <Check className="size-3.5 text-ok" /> : <Copy className="size-3.5" />}
      </button>
    </div>
  );
}

const EVENT_TONE: Record<string, string> = { success: 'bg-ok', error: 'bg-err', warn: 'bg-warn', info: 'bg-info' };

function Timeline({ id }: { id: string }) {
  const [rows, setRows] = useState<EventRow[]>([]);
  const st = useStatus(id);
  const players = useApp((s) => s.players[id]?.length ?? 0);
  useEffect(() => {
    api.eventHistory(id, 40).then(setRows).catch(() => {});
  }, [id, st?.state, st?.lastBackup, players]);
  return (
    <Card className="flex min-h-[260px] flex-col overflow-hidden">
      <div className="flex items-center gap-2 border-b border-line px-4 py-2.5 text-[12.5px] font-semibold text-fg">
        <History className="size-4 text-fg-3" /> Activity
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-2">
        {rows.length === 0 ? (
          <div className="py-6 text-center text-[12px] text-fg-4">Starts, crashes, players, backups and updates show up here.</div>
        ) : (
          rows.map((r) => (
            <div key={r.id} className="relative flex gap-3 py-1.5 pl-1">
              <span className={cn('mt-1.5 size-1.5 shrink-0 rounded-full', EVENT_TONE[r.level] ?? 'bg-fg-4')} />
              <div className="min-w-0 flex-1">
                <div className="text-[12px] leading-snug text-fg-2">{r.message}</div>
                <div className="font-mono text-[10.5px] text-fg-4">
                  {new Date(r.ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} {clock(r.ts)} · {r.kind}
                </div>
              </div>
            </div>
          ))
        )}
      </div>
    </Card>
  );
}

export function Overview({ id }: { id: string }) {
  const inst = useInstance(id)!;
  const st = useStatus(id);
  const hist = useServerHistory(id);
  const lines = useLogLines(id);
  const setView = useApp((s) => s.setView);
  const info = useApp((s) => s.info);
  const streamer = useApp((s) => s.settings?.streamerMode ?? false);
  const [fwOk, setFwOk] = useState<boolean | null>(null);
  useEffect(() => {
    // Show the end of the current log file, not just what streamed in since the manager opened.
    api.logTail(id, 1500).then((l) => seedLines(id, l)).catch(() => {});
  }, [id]);
  useEffect(() => {
    api.firewallState(id).then((f) => setFwOk((f.portsOk || f.programRule) && f.blockedBy.length === 0)).catch(() => setFwOk(null));
  }, [id, st?.installedBuild]);

  const win = hist.slice(-120);
  const last = hist[hist.length - 1];
  const live = st?.state === 'running' || st?.state === 'starting';
  const state = st?.state ?? 'stopped';
  const memLimit = (info?.totalMemory ?? 0) || 1;
  const online = onlineCount(st);
  const [admins, setAdmins] = useState<number | null>(null);
  useEffect(() => {
    api.getAccess(id).then((a) => setAdmins(a.admins.length)).catch(() => setAdmins(null));
  }, [id, st?.state]);

  const checklist = [
    { done: state !== 'notInstalled', label: 'Install the dedicated server files (about 2 GB)', go: 'files' as const },
    { done: (admins ?? 1) > 0, label: 'Make yourself an admin (your SteamID64)', go: 'access' as const },
    { done: fwOk !== false, label: 'Allow the server through Windows Firewall', go: 'health' as const },
    { done: live, label: 'Start the server', go: null },
  ];
  const setupDone = checklist.every((c) => c.done);
  const recent = lines.filter((l) => l.source !== 'server' || !isNoise(l.text)).slice(-12);
  const names = st?.players.map((p) => p.name || 'new player') ?? [];

  return (
    <div className="mx-auto max-w-[1200px] space-y-5 p-6">
      {!setupDone && (
        <Card className="relative overflow-hidden p-5">
          <div className="shroud-sky pointer-events-none absolute inset-0 opacity-80" />
          <div className="relative flex items-start gap-6">
            <div className="min-w-0 flex-1">
              <div className="text-[15px] font-semibold text-fg">Raise {inst.name} from the grave</div>
              <div className="mt-1 text-[12.5px] text-fg-3">A few steps and Vardoran is ready for your clan.</div>
              <div className="mt-4 space-y-2">
                {checklist.map((c, i) => (
                  <button
                    key={i}
                    disabled={c.done || !c.go}
                    onClick={() => c.go && setView(id, c.go)}
                    className={cn('flex w-full items-center gap-2.5 text-left text-[12.5px]', c.done ? 'text-fg-4 line-through' : 'text-fg-2 hover:text-fg')}
                  >
                    {c.done ? <Check className="size-4 text-ok" /> : <CircleDashed className="size-4 text-accent" />}
                    {c.label}
                    {!c.done && c.go && <ArrowRight className="size-3.5 text-fg-4" />}
                  </button>
                ))}
              </div>
            </div>
            <ServerControls id={id} size="lg" compact={false} />
          </div>
        </Card>
      )}

      {st?.state === 'crashed' && (
        <Callout
          tone="err"
          title={st.crashLoop ? 'The server keeps crashing' : 'The server stopped unexpectedly'}
          action={
            <Button size="sm" icon={<Terminal className="size-3.5" />} onClick={() => setView(id, 'console')}>
              Open console
            </Button>
          }
        >
          {st.crashLoop
            ? `It crashed ${st.crashCount} times in 15 minutes, so automatic restarts are paused. Check the console and Network & Health, then start it again.`
            : 'Check the console for the last log lines. Automatic restart is ' + (inst.automation.autoRestart ? 'on.' : 'off.')}
        </Callout>
      )}

      <Card className="p-5">
        <div className="mb-3 flex items-center justify-between">
          <div className="text-[13px] font-semibold text-fg">How players join</div>
          <Badge tone={inst.config.password ? 'ok' : 'warn'}>
            <KeyRound /> {inst.config.password ? 'Password protected' : 'Open – no password'}
          </Badge>
        </div>
        <div className="flex gap-3">
          <CopyChip label={inst.config.listOnSteam ? 'Search in the server list' : 'Server name'} value={inst.config.name} icon={<Search />} />
          <CopyChip label="Direct connect" value={st?.publicIp ? mask(`${st.publicIp}:${inst.config.port}`, streamer) : 'shown once online'} icon={<Globe2 />} />
          {inst.config.password && <CopyChip label="Password" value={inst.config.password} icon={<KeyRound />} secret />}
        </div>
        <div className="mt-3 text-[11.5px] leading-relaxed text-fg-4">
          In-game: Play → Online Play → Find Servers, search “{inst.config.name}”{!inst.config.listOnSteam && ' (not listed – use Direct Connect with the address above)'}.{' '}
          {admins === 0 && (
            <>
              Nobody is an admin yet –{' '}
              <button className="text-accent hover:underline" onClick={() => setView(id, 'access')}>
                add yourself
              </button>
              .{' '}
            </>
          )}
          Players outside your network need UDP {inst.config.port} and {inst.config.queryPort} reachable –{' '}
          <button className="text-accent hover:underline" onClick={() => setView(id, 'ports')}>
            port forwarding guide
          </button>
          .
        </div>
      </Card>

      <div className="grid grid-cols-4 gap-4">
        <Stat label="CPU" icon={<Cpu />} value={live && last ? pct(last.cpu, 1) : '—'} sub={live ? `${info?.cores ?? '?'} cores available` : 'Server offline'}>
          <Sparkline className="mt-3" values={win.map((p) => p.cpu)} max={Math.max(10, ...win.map((p) => p.cpu)) * 1.2} />
        </Stat>
        <Stat label="Memory" icon={<MemoryStick />} value={live && last ? bytes(last.mem) : '—'} sub={live && last ? `${pct((last.mem / memLimit) * 100, 1)} of system` : `Recommended ${inst.config.maxConnectedUsers > 40 ? 16 : 8} GB`}>
          <Sparkline className="mt-3" values={win.map((p) => p.mem)} fit />
        </Stat>
        <Stat label="Players" icon={<Users />} value={live ? `${online}/${inst.config.maxConnectedUsers}` : '—'} sub={names.length ? names.join(', ') : live ? 'Nobody online' : 'From the server log'}>
          <button onClick={() => setView(id, 'players')} className="mt-3 text-[11.5px] text-accent hover:underline">
            Players →
          </button>
        </Stat>
        <Stat label="Disk I/O" icon={<HardDrive />} value={live && last ? `${bytes(last.writeBps)}/s` : '—'} sub={live && last ? `write · ${bytes(last.readBps)}/s read` : '—'}>
          <Sparkline className="mt-3" values={win.map((p) => p.writeBps)} />
        </Stat>
      </div>

      <div className="grid grid-cols-[1fr_340px] gap-4">
        <Card className="flex min-h-[260px] flex-col overflow-hidden">
          <div className="flex items-center justify-between border-b border-line px-4 py-2.5">
            <div className="flex items-center gap-2 text-[12.5px] font-semibold text-fg">
              <Terminal className="size-4 text-fg-3" /> Recent console
            </div>
            <button onClick={() => setView(id, 'console')} className="text-[11.5px] text-accent hover:underline">
              Open console →
            </button>
          </div>
          <div className="selectable min-h-0 flex-1 overflow-hidden bg-bg/60 px-4 py-2.5 font-mono text-[11.5px] leading-[1.7]">
            {recent.length === 0 ? (
              <div className="text-fg-4">{live ? 'Waiting for log output…' : 'No output yet – start the server to see its log here.'}</div>
            ) : (
              recent.map((l) => (
                <div
                  key={l.n}
                  className={cn(
                    'truncate',
                    l.source === 'manager' ? 'text-accent' : l.source === 'steamcmd' ? 'text-info' : { error: 'text-err', warn: 'text-warn', display: 'text-fg-2', log: 'text-fg-3' }[lineLevel(l.text)],
                  )}
                >
                  {l.text}
                </div>
              ))
            )}
          </div>
        </Card>
        <div className="space-y-4">
          <Card className="p-4">
            <div className="text-[11.5px] font-medium tracking-wide text-fg-3 uppercase">Version</div>
            <div className="mt-2 flex items-center justify-between">
              <span className="font-mono text-[13px] text-fg">{st?.installedBuild ? `Build ${st.installedBuild}` : state === 'notInstalled' ? 'Not installed' : 'Unknown build'}</span>
              {st?.installedBuild && st.latestBuild && st.latestBuild !== st.installedBuild ? <Badge tone="accent">Update available</Badge> : st?.latestBuild ? <Badge tone="ok">Up to date</Badge> : null}
            </div>
            {st?.gameVersion && <div className="mt-1 font-mono text-[11px] text-fg-4">VRisingServer v{st.gameVersion}</div>}
          </Card>
          <Card className="p-4">
            <div className="flex items-center gap-2 text-[11.5px] font-medium tracking-wide text-fg-3 uppercase">
              <Save className="size-3.5" /> World
            </div>
            <div className="mt-2 flex items-center justify-between text-[13px] text-fg">
              {st?.lastSave ? `Saved ${ago(st.lastSave)}` : live ? `Autosaves every ${Math.round(inst.config.autoSaveInterval / 60) || 1} min` : 'Saved on every stop'}
              <button onClick={() => setView(id, 'worlds')} className="text-[11.5px] text-accent hover:underline">
                Worlds →
              </button>
            </div>
            <div className="mt-1 text-[11.5px] text-fg-4">
              “{inst.config.saveName}” · {inst.config.gameSettingsPreset || 'custom rules'}
              {st?.daysRunning != null && ` · day ${st.daysRunning}`}
            </div>
          </Card>
          <Card className="p-4">
            <div className="flex items-center gap-2 text-[11.5px] font-medium tracking-wide text-fg-3 uppercase">
              <CalendarClock className="size-3.5" /> Next scheduled
            </div>
            <div className="mt-2 text-[13px] text-fg">
              {st?.nextSchedule ? (
                <>
                  <span className="capitalize">{st.nextSchedule.action}</span> <span className="text-fg-3">{until(st.nextSchedule.at)}</span>
                </>
              ) : (
                <button onClick={() => setView(id, 'automation')} className="text-fg-3 hover:text-accent">
                  Nothing scheduled – add a daily restart →
                </button>
              )}
            </div>
          </Card>
          <Card className="p-4">
            <div className="flex items-center gap-2 text-[11.5px] font-medium tracking-wide text-fg-3 uppercase">
              <Archive className="size-3.5" /> Last backup
            </div>
            <div className="mt-2 flex items-center justify-between text-[13px] text-fg">
              {ago(st?.lastBackup)}
              <button onClick={() => setView(id, 'backups')} className="text-[11.5px] text-accent hover:underline">
                Backups →
              </button>
            </div>
            <div className="mt-1 text-[11.5px] text-fg-4">{inst.automation.backupIntervalMins > 0 ? `Every ${inst.automation.backupIntervalMins} min while running` : 'Interval backups off'}</div>
          </Card>
        </div>
      </div>
      <Timeline id={id} />
    </div>
  );
}
