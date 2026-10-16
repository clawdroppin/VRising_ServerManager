import { Archive, CalendarClock, HeartPulse, Megaphone, Plus, RefreshCw, Trash2, Zap } from 'lucide-react';
import { cn } from '@/lib/cn';
import { until } from '@/lib/format';
import type { ScheduleEntry } from '@/lib/types';
import { useStatus } from '@/store/app';
import { Button, IconButton } from '@/components/ui/Button';
import { FieldRow, Input, NumberInput, Select, Toggle } from '@/components/ui/Field';
import { Callout, Card, PageHeader, Section } from '@/components/ui/Surface';
import { useDraft } from '../draft';

const DAYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
const ACTIONS = [
  { value: 'restart', label: 'Restart' },
  { value: 'update', label: 'Update (stop → update → start)' },
  { value: 'backup', label: 'Back up' },
  { value: 'stop', label: 'Stop' },
  { value: 'start', label: 'Start' },
];

function ScheduleRow({ e, onChange, onRemove }: { e: ScheduleEntry; onChange: (e: ScheduleEntry) => void; onRemove: () => void }) {
  return (
    <div className={cn('flex items-center gap-3 py-3', !e.enabled && 'opacity-55')}>
      <Toggle size="sm" checked={e.enabled} onChange={(v) => onChange({ ...e, enabled: v })} />
      <Select value={e.action} onChange={(x) => onChange({ ...e, action: x.target.value })} className="w-64">
        {ACTIONS.map((a) => (
          <option key={a.value} value={a.value}>
            {a.label}
          </option>
        ))}
      </Select>
      <span className="text-[12px] text-fg-3">at</span>
      <Input type="time" value={e.time} onChange={(x) => onChange({ ...e, time: x.target.value })} className="w-28 font-mono [color-scheme:dark]" />
      <div className="flex gap-1">
        {DAYS.map((d, i) => {
          const on = e.days.length === 0 || e.days.includes(i);
          return (
            <button
              key={d}
              onClick={() => {
                const cur = e.days.length === 0 ? [0, 1, 2, 3, 4, 5, 6] : e.days;
                const next = cur.includes(i) ? cur.filter((x) => x !== i) : [...cur, i].sort();
                if (next.length === 0) return; // at least one day
                onChange({ ...e, days: next.length === 7 ? [] : next });
              }}
              className={cn('h-7 w-8 rounded-md border text-[11px] font-medium', on ? 'border-accent/50 bg-accent/12 text-accent' : 'border-line-strong text-fg-4 hover:text-fg-2')}
            >
              {d}
            </button>
          );
        })}
      </div>
      <span className="ml-1 text-[11px] text-fg-4">{e.days.length === 0 ? 'every day' : ''}</span>
      <IconButton label="Remove" className="ml-auto hover:text-err" onClick={onRemove}>
        <Trash2 />
      </IconButton>
    </div>
  );
}

export function Automation({ id }: { id: string }) {
  const { draft, patch } = useDraft(id);
  const st = useStatus(id);
  if (!draft) return null;
  const a = draft.automation;
  const set = <K extends keyof typeof a>(k: K, v: (typeof a)[K]) => patch((d) => void (d.automation[k] = v));

  return (
    <div className="mx-auto max-w-[1000px] space-y-5 p-6 pb-24">
      <PageHeader title="Automation" description="Keep the server healthy without babysitting it – crash recovery, schedules, backups and updates. The manager must be running for automation to work." />

      <Section title="Uptime & recovery" icon={<HeartPulse />} bodyClassName="divide-y divide-line">
        <FieldRow label="Start with the manager" description="Start this server automatically when the manager opens.">
          <Toggle checked={a.autoStart} onChange={(v) => set('autoStart', v)} />
        </FieldRow>
        <FieldRow label="Restart after a crash" description="Bring the server back automatically if it exits unexpectedly.">
          <Toggle checked={a.autoRestart} onChange={(v) => set('autoRestart', v)} />
        </FieldRow>
        <FieldRow label="Restart delay" description="Wait before restarting after a crash.">
          <NumberInput value={a.restartDelaySecs} min={0} max={600} step={5} suffix="s" onChange={(v) => set('restartDelaySecs', v)} />
        </FieldRow>
        <FieldRow label="Crash-loop guard" description="Pause auto-restart after this many crashes within 15 minutes, so a broken config doesn’t restart forever. 0 = never pause.">
          <NumberInput value={a.crashLimit} min={0} max={50} suffix="crashes" onChange={(v) => set('crashLimit', v)} />
        </FieldRow>
        <FieldRow label="Graceful stop timeout" description="How long to wait for the server to save and exit before it is force-closed.">
          <NumberInput value={a.stopTimeoutSecs} min={5} max={900} step={5} suffix="s" onChange={(v) => set('stopTimeoutSecs', v)} />
        </FieldRow>
        <FieldRow label="Restart above memory" description="Restart when the server stays above this much RAM for 30 seconds – a safety net for leaks. 0 = off.">
          <NumberInput value={a.memoryLimitMb} min={0} max={262144} step={512} suffix="MB" onChange={(v) => set('memoryLimitMb', v)} />
        </FieldRow>
        <FieldRow label="Restart after uptime" description="Restart once the server has been up this long. 0 = off. A daily scheduled restart is usually nicer for players.">
          <NumberInput value={a.maxUptimeHours} min={0} max={720} suffix="h" onChange={(v) => set('maxUptimeHours', v)} />
        </FieldRow>
        <FieldRow label="Stop when empty" description="Shut the server down after nobody has been online for this long – saves power on a home PC. 0 = off.">
          <NumberInput value={a.idleStopMins} min={0} max={1440} step={5} suffix="min" onChange={(v) => set('idleStopMins', v)} />
        </FieldRow>
      </Section>

      <Section
        title="Schedules"
        icon={<CalendarClock />}
        description={st?.nextSchedule ? `Next: ${st.nextSchedule.action} ${until(st.nextSchedule.at)}` : 'Run actions at set times (local time).'}
        actions={
          <Button size="sm" icon={<Plus className="size-3.5" />} onClick={() => patch((d) => void d.automation.schedules.push({ enabled: true, time: '05:00', days: [], action: 'restart' }))}>
            Add schedule
          </Button>
        }
        bodyClassName="divide-y divide-line"
      >
        {a.schedules.length === 0 ? (
          <div className="py-6 text-center text-[12.5px] text-fg-4">
            No schedules. A daily restart at a quiet hour keeps memory fresh and picks up updates.
            <div className="mt-3 flex justify-center gap-2">
              <Button size="sm" onClick={() => patch((d) => void d.automation.schedules.push({ enabled: true, time: '05:00', days: [], action: 'restart' }))}>
                Daily restart at 05:00
              </Button>
              <Button size="sm" onClick={() => patch((d) => void d.automation.schedules.push({ enabled: true, time: '04:30', days: [], action: 'update' }))}>
                Daily update at 04:30
              </Button>
            </div>
          </div>
        ) : (
          a.schedules.map((e, i) => (
            <ScheduleRow
              key={i}
              e={e}
              onChange={(n) => patch((d) => void (d.automation.schedules[i] = n))}
              onRemove={() => patch((d) => void d.automation.schedules.splice(i, 1))}
            />
          ))
        )}
      </Section>

      <Section
        title="Warnings & announcements"
        icon={<Megaphone />}
        description="Sent to players in chat over RCON. Needs RCON on (Server Settings)."
        actions={
          <Button size="sm" icon={<Plus className="size-3.5" />} onClick={() => patch((d) => void d.automation.announcements.push({ enabled: true, message: '', everyMins: 60 }))}>
            Add announcement
          </Button>
        }
        bodyClassName="divide-y divide-line"
      >
        {!draft.config.rconEnabled && <Callout tone="warn" className="my-3">RCON is off, so warnings and announcements can’t be sent. Turn it on under Server Settings.</Callout>}
        <FieldRow
          label="Warn before restarts"
          description="Before an automatic or scheduled restart, update or stop while players are online: announce it (“server restarting in N minutes”) and wait. Reminders go out at 10, 5 and 1 minute. You can cancel the countdown from the header. 0 = no warning."
        >
          <NumberInput value={a.restartWarningMins} min={0} max={60} suffix="min" onChange={(v) => set('restartWarningMins', v)} />
        </FieldRow>
        {a.announcements.map((an, i) => (
          <div key={i} className={cn('flex items-center gap-3 py-3', !an.enabled && 'opacity-55')}>
            <Toggle size="sm" checked={an.enabled} onChange={(v) => patch((d) => void (d.automation.announcements[i].enabled = v))} />
            <Input value={an.message} maxLength={240} placeholder="e.g. Join our Discord: discord.gg/…" onChange={(e) => patch((d) => void (d.automation.announcements[i].message = e.target.value))} className="flex-1" />
            <span className="text-[12px] text-fg-3">every</span>
            <NumberInput value={an.everyMins} min={5} max={1440} step={5} suffix="min" onChange={(v) => patch((d) => void (d.automation.announcements[i].everyMins = v))} className="w-36" />
            <IconButton label="Remove" className="hover:text-err" onClick={() => patch((d) => void d.automation.announcements.splice(i, 1))}>
              <Trash2 />
            </IconButton>
          </div>
        ))}
        {a.announcements.length === 0 && <div className="py-4 text-center text-[12px] text-fg-4">No timed announcements. They only go out while someone is online.</div>}
      </Section>

      <Section title="Backups" icon={<Archive />} bodyClassName="divide-y divide-line">
        <FieldRow label="Back up while running" description="Snapshot the world every N minutes while the server is online. 0 = off.">
          <NumberInput value={a.backupIntervalMins} min={0} max={1440} step={15} suffix="min" onChange={(v) => set('backupIntervalMins', v)} />
        </FieldRow>
        <FieldRow label="Keep automatic backups" description="Older automatic backups are deleted beyond this count. Manual backups are always kept. 0 = keep all.">
          <NumberInput value={a.backupKeep} min={0} max={1000} suffix="backups" onChange={(v) => set('backupKeep', v)} />
        </FieldRow>
        <FieldRow label="Back up after stopping" description="Take a snapshot each time the server shuts down cleanly.">
          <Toggle checked={a.backupOnStop} onChange={(v) => set('backupOnStop', v)} />
        </FieldRow>
        <FieldRow label="Back up before updating" description="Snapshot before SteamCMD updates the server files.">
          <Toggle checked={a.backupBeforeUpdate} onChange={(v) => set('backupBeforeUpdate', v)} />
        </FieldRow>
      </Section>

      <Section title="Updates" icon={<RefreshCw />} description="The server only accepts players on the same game version – after every game patch the server must update." bodyClassName="divide-y divide-line">
        <FieldRow label="Check for updates" description="Ask Steam for the latest server build every N minutes. 0 = off.">
          <NumberInput value={a.updateCheckMins} min={0} max={1440} step={15} suffix="min" onChange={(v) => set('updateCheckMins', v)} />
        </FieldRow>
        <FieldRow label={<span className="flex items-center gap-1.5"><Zap className="size-3.5 text-accent" /> Install updates automatically</span>} description="When a new build appears: stop cleanly, update, start again. Takes a minute or two; with “Wait for players to leave” it happens once the server is empty.">
          <Toggle checked={a.autoUpdate} onChange={(v) => set('autoUpdate', v)} />
        </FieldRow>
        <FieldRow
          label="Wait for players to leave"
          description="Scheduled restarts/stops/updates and automatic updates first wait until the server is empty (at most 60 minutes). Busy servers rarely empty – the restart warning above is usually the better choice."
        >
          <Toggle checked={a.waitForEmpty} onChange={(v) => set('waitForEmpty', v)} />
        </FieldRow>
        <FieldRow label="Update on every start" description="Run a SteamCMD update before each start (slower starts, never out of date).">
          <Toggle checked={a.updateOnStart} onChange={(v) => set('updateOnStart', v)} />
        </FieldRow>
      </Section>
      <Card className="p-4 text-[12px] text-fg-3">
        Tip: keep the manager running (it can sit minimised) – crash recovery, schedules and update checks run inside it. Servers themselves keep running if you close the manager, and are picked up again when it reopens.
      </Card>
    </div>
  );
}
