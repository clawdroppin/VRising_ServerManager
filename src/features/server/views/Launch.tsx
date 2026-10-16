import { useEffect, useState } from 'react';
import { Check, Copy, Cpu, Rocket, Terminal, TriangleAlert } from 'lucide-react';
import { cn } from '@/lib/cn';
import { api } from '@/lib/ipc';
import { copy } from '@/lib/shell';
import { PRIORITIES } from '@/data/gameplay';
import { useApp, useStatus } from '@/store/app';
import { Button } from '@/components/ui/Button';
import { FieldRow, Input, Select, Toggle } from '@/components/ui/Field';
import { Card, PageHeader, Section } from '@/components/ui/Surface';
import { useDraft } from '../draft';

function LaunchPreview({ id }: { id: string }) {
  const { saved } = useDraft(id);
  const st = useStatus(id);
  const [line, setLine] = useState('');
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    api.launchLine(id).then(setLine).catch(() => {});
  }, [id, saved?.launch.extraArgs, saved?.installDir, st?.state]);
  return (
    <Card className="overflow-hidden">
      <div className="flex items-center justify-between border-b border-line px-4 py-2.5">
        <div className="flex items-center gap-2 text-[12.5px] font-semibold text-fg">
          <Terminal className="size-4 text-fg-3" /> Launch command
        </div>
        <button
          onClick={() => {
            copy(line);
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          }}
          className="flex items-center gap-1.5 text-[11.5px] text-fg-3 hover:text-fg"
        >
          {copied ? <Check className="size-3.5 text-ok" /> : <Copy className="size-3.5" />} Copy
        </button>
      </div>
      <div className="selectable bg-bg/70 px-4 py-3 font-mono text-[11.5px] leading-relaxed break-all text-fg-2">{line || '…'}</div>
      <div className="border-t border-line px-4 py-2 text-[11px] text-fg-4">
        The manager passes only the data folder and log file – everything else comes from ServerHostSettings.json, so passwords never appear on the command line.
      </div>
    </Card>
  );
}

export function Launch({ id }: { id: string }) {
  const { draft, patch } = useDraft(id);
  const info = useApp((s) => s.info);
  if (!draft) return null;
  const l = draft.launch;
  const cores = info?.cores ?? 8;
  const setCores = (list: number[]) => patch((d) => void (d.launch.affinity = list));
  const range = (from: number, to: number) => Array.from({ length: Math.max(0, to - from) }, (_, i) => from + i);

  return (
    <div className="mx-auto max-w-[1000px] space-y-5 p-6 pb-24">
      <PageHeader title="Process & launch" description="How the server process runs on this PC: console window, CPU priority and cores, and extra arguments." />
      <LaunchPreview id={id} />

      <Section title="Process" icon={<Cpu />} description="Priority, cores and console visibility apply immediately to a running server, too." bodyClassName="divide-y divide-line">
        <FieldRow label="Show console window" description="The server’s console is hidden by default – the manager shows its log in the Console tab. Turn on to keep the window on the desktop.">
          <Toggle checked={l.showConsole} onChange={(b) => patch((d) => void (d.launch.showConsole = b))} />
        </FieldRow>
        <FieldRow label="CPU priority" description="Above normal can help on a PC that also runs games. High may starve other apps.">
          <Select value={l.priority} onChange={(e) => patch((d) => void (d.launch.priority = e.target.value))}>
            {PRIORITIES.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </Select>
        </FieldRow>
        <FieldRow
          label="CPU cores"
          description="Restrict the server to specific logical cores – e.g. keep it off the cores your game uses. None selected means all cores. V Rising's simulation runs mostly on a few threads."
          stacked
          hint={l.affinity.length ? `${l.affinity.length} of ${cores} cores` : `All ${cores} cores`}
        >
          <div className="mb-2 flex flex-wrap gap-1.5">
            <Button size="xs" variant="outline" onClick={() => setCores([])}>
              All
            </Button>
            <Button size="xs" variant="outline" onClick={() => setCores(range(0, Math.ceil(cores / 2)))}>
              First half
            </Button>
            <Button size="xs" variant="outline" onClick={() => setCores(range(Math.floor(cores / 2), cores))}>
              Second half
            </Button>
            <Button size="xs" variant="outline" onClick={() => setCores(range(Math.max(0, cores - 8), cores))}>
              Last 8
            </Button>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {Array.from({ length: cores }, (_, c) => {
              const on = l.affinity.includes(c);
              return (
                <button
                  key={c}
                  onClick={() => setCores(on ? l.affinity.filter((x) => x !== c) : [...l.affinity, c].sort((a, b) => a - b))}
                  className={cn(
                    'h-7 w-9 rounded-md border font-mono text-[11px] transition-colors',
                    on ? 'border-accent-strong bg-accent/15 text-accent' : 'border-line-strong bg-bg-raised text-fg-3 hover:text-fg',
                  )}
                >
                  {c}
                </button>
              );
            })}
          </div>
          {l.affinity.length > 0 && l.affinity.length < 4 && (
            <div className="mt-2 flex items-center gap-1.5 text-[11.5px] text-warn">
              <TriangleAlert className="size-3.5" /> Fewer than 4 cores will make the world stutter with several players.
            </div>
          )}
        </FieldRow>
      </Section>

      <Section title="Arguments" icon={<Rocket />} description="Rarely needed – the dedicated server reads its settings from ServerHostSettings.json." bodyClassName="divide-y divide-line">
        <FieldRow
          label="Data folder"
          description="-persistentDataPath: settings, admin/ban lists and saves. Relative paths are inside the server folder. Change it only to point at an existing data folder – stop the server first."
          stacked
        >
          <Input mono value={l.dataDir} placeholder="./save-data" onChange={(e) => patch((d) => void (d.launch.dataDir = e.target.value))} />
        </FieldRow>
        <FieldRow label="Extra arguments" description="Appended to the command line as-is, e.g. -lowerFPSWhenEmpty. Quote values with spaces." stacked>
          <Input mono value={l.extraArgs} placeholder="(none)" onChange={(e) => patch((d) => void (d.launch.extraArgs = e.target.value))} />
        </FieldRow>
      </Section>
    </div>
  );
}
