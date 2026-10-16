import { useEffect, useState, type ReactNode } from 'react';
import { Activity, Cpu, HardDrive, History, MemoryStick, Network, Users } from 'lucide-react';
import { api } from '@/lib/ipc';
import type { MetricRow } from '@/lib/types';
import { bytes, duration, pct } from '@/lib/format';
import { useServerHistory, useSystemHistory } from '@/lib/live';
import { useApp, useInstance, useStatus } from '@/store/app';
import { CoreGrid, Gauge, Legend, LiveChart, SERIES } from '@/components/charts/Charts';
import { Card, Empty, PageHeader } from '@/components/ui/Surface';
import { Segmented } from '@/components/ui/Field';

const WINDOWS = { '60': '1m', '300': '5m', '900': '15m', '3600': '1h', h24: '24h', d7: '7d', d30: '30d' } as const;
const RANGE_MS: Record<string, number> = { h24: 86_400_000, d7: 7 * 86_400_000, d30: 30 * 86_400_000 };
type Win = keyof typeof WINDOWS;

function stats(v: number[]) {
  if (!v.length) return { cur: 0, avg: 0, peak: 0 };
  let s = 0;
  let p = 0;
  for (const x of v) {
    s += x;
    if (x > p) p = x;
  }
  return { cur: v[v.length - 1], avg: s / v.length, peak: p };
}

function ChartCard({ title, icon, children, summary }: { title: string; icon: ReactNode; children: ReactNode; summary?: ReactNode }) {
  return (
    <Card className="p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-[12.5px] font-semibold text-fg [&_svg]:size-4 [&_svg]:text-fg-3">
          {icon}
          {title}
        </div>
        {summary}
      </div>
      {children}
    </Card>
  );
}

const dayTime = (ts: number) => new Date(ts).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

/** Per-minute rollups from manager.db – kept for the retention set in App settings. */
function HistoryCharts({ id, range }: { id: string; range: string }) {
  const [rows, setRows] = useState<MetricRow[] | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () => api.metricsHistory(id, Date.now() - RANGE_MS[range]).then((r) => alive && setRows(r)).catch(() => alive && setRows([]));
    load();
    const t = setInterval(load, 60_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [id, range]);
  if (!rows) return <Card className="p-8 text-center text-[12px] text-fg-4">Loading history…</Card>;
  if (!rows.length)
    return (
      <Card>
        <Empty icon={<History />} title="No history yet" description="The manager stores one sample per minute while the server runs. Check back after it has been up for a while." />
      </Card>
    );
  const ts = rows.map((r) => r.ts);
  const fmtPct = (v: number) => pct(v, v < 10 ? 1 : 0);
  const fmtR = (v: number) => `${bytes(v, 0)}/s`;
  const players = stats(rows.map((r) => r.players));
  return (
    <div className="grid grid-cols-2 gap-4">
      <ChartCard title="Players online" icon={<Users />} summary={<Summary {...players} fmt={(v) => v.toFixed(0)} />}>
        <LiveChart ts={ts} series={[{ name: 'Players', values: rows.map((r) => r.players) }]} format={(v) => v.toFixed(0)} timeFormat={dayTime} />
      </ChartCard>
      <ChartCard title="CPU usage (minute average)" icon={<Cpu />} summary={<Summary {...stats(rows.map((r) => r.cpu))} fmt={fmtPct} />}>
        <LiveChart ts={ts} series={[{ name: 'CPU', values: rows.map((r) => r.cpu) }]} format={fmtPct} timeFormat={dayTime} />
      </ChartCard>
      <ChartCard title="Memory (minute peak)" icon={<MemoryStick />} summary={<Summary {...stats(rows.map((r) => r.mem))} fmt={(v) => bytes(v, 1)} />}>
        <LiveChart ts={ts} series={[{ name: 'Memory', values: rows.map((r) => r.mem) }]} format={(v) => bytes(v, 1)} timeFormat={dayTime} />
      </ChartCard>
      <ChartCard
        title="Disk activity"
        icon={<HardDrive />}
        summary={
          <Legend
            items={[
              { name: 'Write', color: SERIES[0] },
              { name: 'Read', color: SERIES[1] },
            ]}
          />
        }
      >
        <LiveChart
          ts={ts}
          series={[
            { name: 'Write', values: rows.map((r) => r.writeBps), color: SERIES[0] },
            { name: 'Read', values: rows.map((r) => r.readBps), color: SERIES[1] },
          ]}
          format={fmtR}
          timeFormat={dayTime}
        />
      </ChartCard>
    </div>
  );
}

function Summary({ cur, avg, peak, fmt }: { cur: number; avg: number; peak: number; fmt: (v: number) => string }) {
  return (
    <div className="flex gap-4 font-mono text-[11px]">
      <span className="text-fg-4">
        now <span className="text-fg">{fmt(cur)}</span>
      </span>
      <span className="text-fg-4">
        avg <span className="text-fg-2">{fmt(avg)}</span>
      </span>
      <span className="text-fg-4">
        peak <span className="text-fg-2">{fmt(peak)}</span>
      </span>
    </div>
  );
}

export function Performance({ id }: { id: string }) {
  const inst = useInstance(id)!;
  const st = useStatus(id);
  const info = useApp((s) => s.info);
  const all = useServerHistory(id);
  const sysAll = useSystemHistory();
  const [win, setWin] = useState<Win>('300');
  const historical = win in RANGE_MS;
  const n = historical ? 0 : +win;
  const h = all.slice(-n);
  const sys = sysAll.slice(-n);
  const last = all[all.length - 1];
  const lastSys = sysAll[sysAll.length - 1];
  const live = st?.state === 'running' || st?.state === 'starting';
  const ts = h.map((p) => p.ts);

  const cpu = stats(h.map((p) => p.cpu));
  const mem = stats(h.map((p) => p.mem));
  const fmtPct = (v: number) => pct(v, v < 10 ? 1 : 0);
  const fmtB = (v: number) => bytes(v, 1);
  const fmtR = (v: number) => `${bytes(v, 0)}/s`;

  return (
    <div className="mx-auto max-w-[1200px] p-6">
      <PageHeader
        title="Performance"
        description={historical ? 'Per-minute history from the manager’s database – also covers times the window was closed, as long as the manager ran in the tray.' : 'Live resource usage of the server process, sampled every second.'}
        actions={<Segmented value={win} onChange={setWin} options={Object.entries(WINDOWS).map(([value, label]) => ({ value: value as Win, label }))} />}
      />
      {historical ? (
        <HistoryCharts id={id} range={win} />
      ) : !live && all.length === 0 ? (
        <Card>
          <Empty icon={<Activity />} title="The server isn't running" description="Start it to see CPU, memory and disk activity in real time." />
        </Card>
      ) : (
        <div className="space-y-4">
          <div className="grid grid-cols-4 gap-4">
            <Card className="p-4">
              <Gauge value={last?.cpu ?? 0} label="Server CPU" sub={`of ${info?.cores ?? '?'} cores`} />
            </Card>
            <Card className="p-4">
              <Gauge value={info ? ((last?.mem ?? 0) / info.totalMemory) * 100 : 0} label="Server memory" sub={`${bytes(last?.mem ?? 0)} · ${bytes(last?.virt ?? 0)} commit`} />
            </Card>
            <Card className="p-4">
              <Gauge value={lastSys?.cpu ?? 0} label="System CPU" sub="all processes" />
            </Card>
            <Card className="p-4">
              <Gauge value={lastSys ? (lastSys.memUsed / lastSys.memTotal) * 100 : 0} label="System memory" sub={lastSys ? `${bytes(lastSys.memUsed)} / ${bytes(lastSys.memTotal)}` : ''} />
            </Card>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <ChartCard title="CPU usage" icon={<Cpu />} summary={<Summary {...cpu} fmt={fmtPct} />}>
              <LiveChart ts={ts} series={[{ name: 'CPU', values: h.map((p) => p.cpu) }]} format={fmtPct} />
            </ChartCard>
            <ChartCard title="Memory (working set)" icon={<MemoryStick />} summary={<Summary {...mem} fmt={fmtB} />}>
              <LiveChart ts={ts} series={[{ name: 'Memory', values: h.map((p) => p.mem) }]} format={fmtB} />
              {inst.automation.memoryLimitMb > 0 && (
                <div className="mt-2 text-[11px] text-fg-4">Automatic restart above {bytes(inst.automation.memoryLimitMb * 1048576)} is enabled.</div>
              )}
            </ChartCard>
            <ChartCard
              title="Disk activity"
              icon={<HardDrive />}
              summary={
                <Legend
                  items={[
                    { name: 'Read', color: SERIES[1], value: fmtR(last?.readBps ?? 0) },
                    { name: 'Write', color: SERIES[0], value: fmtR(last?.writeBps ?? 0) },
                  ]}
                />
              }
            >
              <LiveChart
                ts={ts}
                series={[
                  { name: 'Write', values: h.map((p) => p.writeBps), color: SERIES[0] },
                  { name: 'Read', values: h.map((p) => p.readBps), color: SERIES[1] },
                ]}
                format={fmtR}
              />
            </ChartCard>
            <ChartCard
              title="Network (whole PC)"
              icon={<Network />}
              summary={
                <Legend
                  items={[
                    { name: 'In', color: SERIES[1], value: fmtR(lastSys?.rxBps ?? 0) },
                    { name: 'Out', color: SERIES[0], value: fmtR(lastSys?.txBps ?? 0) },
                  ]}
                />
              }
            >
              <LiveChart
                ts={sys.map((p) => p.ts)}
                series={[
                  { name: 'Out', values: sys.map((p) => p.txBps), color: SERIES[0] },
                  { name: 'In', values: sys.map((p) => p.rxBps), color: SERIES[1] },
                ]}
                format={fmtR}
              />
              <div className="mt-2 text-[11px] text-fg-4">Windows doesn't expose per-process network counters, so this is all traffic on this PC.</div>
            </ChartCard>
          </div>

          <div className="grid grid-cols-[1fr_360px] gap-4">
            <Card className="p-4">
              <div className="mb-3 flex items-center justify-between text-[12.5px] font-semibold text-fg">
                CPU cores (system)
                <span className="font-mono text-[11px] font-normal text-fg-4">{lastSys?.perCore.length ?? 0} logical cores</span>
              </div>
              <CoreGrid values={lastSys?.perCore ?? []} />
              {inst.launch.affinity.length > 0 && <div className="mt-2 text-[11px] text-fg-4">Server pinned to cores {inst.launch.affinity.join(', ')}.</div>}
            </Card>
            <Card className="p-4">
              <div className="mb-2 text-[12.5px] font-semibold text-fg">Process</div>
              <dl className="grid grid-cols-2 gap-y-1.5 text-[12px]">
                <dt className="text-fg-3">PID</dt>
                <dd className="text-right font-mono text-fg">{st?.pid ?? '—'}</dd>
                <dt className="text-fg-3">Uptime</dt>
                <dd className="text-right font-mono text-fg">{last?.uptime ? duration(last.uptime) : '—'}</dd>
                <dt className="text-fg-3">Priority</dt>
                <dd className="text-right font-mono text-fg">{inst.launch.priority}</dd>
                <dt className="text-fg-3">Peak memory</dt>
                <dd className="text-right font-mono text-fg">{bytes(stats(all.map((p) => p.mem)).peak)}</dd>
                <dt className="text-fg-3">Recommended</dt>
                <dd className="text-right font-mono text-fg">{inst.config.maxConnectedUsers > 8 ? 16 : 8} GB RAM</dd>
              </dl>
            </Card>
          </div>
        </div>
      )}
    </div>
  );
}
