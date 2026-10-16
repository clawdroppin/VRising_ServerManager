import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, ArrowRightLeft, Check, ChevronDown, ChevronRight, CopyPlus, FolderOpen, FolderSearch, Globe2, History, Laptop, PenLine, Play, Plus, RefreshCw, RotateCcw, ShieldCheck, Sparkles, Trash2, Upload } from 'lucide-react';
import { api, errMsg } from '@/lib/ipc';
import { ago, bytes, dateTime, plural } from '@/lib/format';
import { pickFolder, reveal } from '@/lib/shell';
import type { LocalWorld, SaveCheck, World } from '@/lib/types';
import { useApp, useInstance, useStatus } from '@/store/app';
import { Button } from '@/components/ui/Button';
import { confirm } from '@/components/ui/Dialog';
import { Checkbox, Input } from '@/components/ui/Field';
import { Badge, Callout, Card, Empty, PageHeader, Section } from '@/components/ui/Surface';
import { cn } from '@/lib/cn';
import { discardDraft } from '../draft';

function SaveRow({ s, check, onRestore, disabled }: { s: World['saves'][number]; check?: SaveCheck; onRestore: () => void; disabled: boolean }) {
  return (
    <div className={cn('flex items-center gap-3 rounded-lg px-3 py-2', s.latest ? 'bg-accent/[0.06]' : 'hover:bg-panel-2')}>
      <div className={cn('flex h-7 min-w-7 items-center justify-center rounded-md px-1.5 font-mono text-[11px]', s.latest ? 'bg-accent/15 text-accent' : 'bg-panel-2 text-fg-3')}>{s.number}</div>
      <div className="min-w-0 flex-1">
        <div className="text-[12.5px] text-fg">
          {dateTime(s.modified)} <span className="text-fg-4">· {ago(s.modified)}</span>
        </div>
        <div className="font-mono text-[10.5px] text-fg-4">
          {s.file} · {bytes(s.size)}
        </div>
      </div>
      {check &&
        (check.ok ? (
          <Badge tone="ok" title={`${bytes(check.bytes)} uncompressed`}>
            <ShieldCheck /> Intact
          </Badge>
        ) : (
          <Badge tone="err" title={check.error ?? ''}>
            <AlertTriangle /> {check.error ?? 'Damaged'}
          </Badge>
        ))}
      {s.latest ? (
        <Badge tone="accent">
          <Check /> Loads next
        </Badge>
      ) : (
        <Button size="sm" variant="outline" icon={<RotateCcw className="size-3.5" />} disabled={disabled} onClick={onRestore}>
          Roll back to this
        </Button>
      )}
    </div>
  );
}

export function Worlds({ id }: { id: string }) {
  const inst = useInstance(id)!;
  const st = useStatus(id);
  const toast = useApp((s) => s.toast);
  const upsert = useApp((s) => s.upsertInstance);
  const confirmOn = useApp((s) => s.settings?.confirmDestructive ?? true);
  const [worlds, setWorlds] = useState<World[] | null>(null);
  const [local, setLocal] = useState<LocalWorld[] | null>(null);
  const [picked, setPicked] = useState<{ dir: string; worlds: World[] } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [newName, setNewName] = useState('');
  const [adopt, setAdopt] = useState(true);
  const [checks, setChecks] = useState<Record<string, SaveCheck>>({});
  const running = st?.state === 'running' || st?.state === 'starting' || st?.state === 'stopping';

  const load = useCallback(() => {
    api.listWorlds(id).then(setWorlds).catch((e) => toast('error', errMsg(e)));
    api.listLocalWorlds().then(setLocal).catch(() => setLocal([]));
  }, [id, toast]);
  useEffect(load, [load, st?.state, st?.lastSave]);

  const active = worlds?.find((w) => w.active);
  const others = worlds?.filter((w) => !w.active) ?? [];
  const savesDir = active ? active.dir.replace(/\\[^\\]+$/, '') : `${inst.installDir}\\save-data\\Saves\\v4`;

  const run = async (key: string, fn: () => Promise<unknown>, ok: string) => {
    setBusy(key);
    try {
      await fn();
      toast('success', ok, id);
      load();
    } catch (e) {
      toast('error', errMsg(e), id);
    } finally {
      setBusy(null);
    }
  };
  const activate = (name: string) =>
    run(
      `act-${name}`,
      async () => {
        const out = await api.activateWorld(id, name);
        discardDraft(id);
        upsert(out);
      },
      running ? `“${name}” loads at the next restart` : `“${name}” is now the server world`,
    );

  const rename = async (w: World) => {
    const r = await confirm({
      title: `Rename world “${w.name}”`,
      message: w.active ? 'The server keeps loading it under the new name (Save name follows).' : 'The world folder gets the new name.',
      input: w.name,
      inputPlaceholder: 'New world name',
      confirm: 'Rename',
    });
    if (!r.ok || r.value === w.name) return;
    await run(
      `ren-${w.version}/${w.name}`,
      async () => {
        const name = await api.renameWorld(id, w.version, w.name, r.value);
        if (w.active) {
          discardDraft(id);
          upsert({ ...inst, config: { ...inst.config, saveName: name } });
        }
      },
      `Renamed to “${r.value}”`,
    );
  };

  const checkSaves = async (w: World) => {
    setBusy('check');
    try {
      const res = await api.checkWorld(id, w.version, w.name);
      setChecks(Object.fromEntries(res.map((c) => [c.file, c])));
      const bad = res.filter((c) => !c.ok);
      if (!bad.length) toast('success', `All ${res.length} autosaves are intact`, id);
      else if (bad[0].number === res[0]?.number) toast('error', `The newest autosave is damaged – roll back to the newest intact one before starting`, id);
      else toast('warn', `${plural(bad.length, 'older autosave')} damaged – the one that loads next is fine`, id);
    } catch (e) {
      toast('error', errMsg(e), id);
    } finally {
      setBusy(null);
    }
  };

  const importWorld = async (dir: string, w: World, label: string) => {
    const name = w.name.length > 30 || /^[0-9a-f-]{20,}$/i.test(w.name) ? 'imported-world' : w.name;
    const useNow = !running;
    await run(
      `imp-${w.dir}`,
      () => api.importWorld(id, dir, name, adopt && w.hasSettings && !running, useNow),
      useNow ? `Imported “${label}” – it loads on the next start` : `Imported “${label}” – switch to it after stopping the server`,
    );
    setPicked(null);
  };

  return (
    <div className="mx-auto max-w-[1100px] space-y-5 p-6">
      <PageHeader
        title="Worlds"
        description="Each world is a folder of autosaves. The server loads the one named in Save name and saves it every few minutes and on every stop; you can keep several worlds and switch between them."
        actions={
          <>
            <Button size="sm" icon={<FolderOpen className="size-3.5" />} onClick={() => reveal(savesDir)}>
              Open saves folder
            </Button>
            <Button size="sm" icon={<RefreshCw className="size-3.5" />} onClick={load}>
              Refresh
            </Button>
          </>
        }
      />
      {running && <Callout tone="warn">The server has its world open. Stop it to roll back, reset or delete the active world – switching, exporting and backups work while it runs (a switch applies at the next restart).</Callout>}

      <Section
        title={
          <span className="flex items-center gap-2">
            Active world <span className="font-mono text-[11.5px] font-normal text-fg-4">{inst.config.saveName}</span>
          </span>
        }
        description={active ? `Last saved ${ago(active.savedAt)} · ${bytes(active.size)} · ${plural(active.saves.length, 'autosave')}${active.startDate ? ` · started ${active.startDate}` : ''}` : 'Not created yet – the server generates it on the next start.'}
        icon={<Globe2 />}
        actions={
          active && (
            <>
              <Button
                size="sm"
                icon={<Upload className="size-3.5" />}
                onClick={async () => {
                  const dest = await pickFolder('Export the world folder to…');
                  if (dest) run('export', () => api.exportWorld(id, active.version, active.name, dest), 'World exported');
                }}
              >
                Export
              </Button>
              <Button size="sm" icon={<ShieldCheck className="size-3.5" />} loading={busy === 'check'} disabled={!active.saves.length} onClick={() => checkSaves(active)}>
                Check saves
              </Button>
              <Button
                size="sm"
                icon={<CopyPlus className="size-3.5" />}
                onClick={() => run('dup', () => api.duplicateWorld(id, active.version, active.name, `${active.name}-copy`), 'World copied')}
              >
                Duplicate
              </Button>
              <Button size="sm" icon={<PenLine className="size-3.5" />} disabled={running} onClick={() => rename(active)}>
                Rename
              </Button>
              <Button
                size="sm"
                variant="danger"
                icon={<Sparkles className="size-3.5" />}
                disabled={running}
                loading={busy === 'reset'}
                onClick={async () => {
                  if (confirmOn) {
                    const r = await confirm({
                      title: 'Wipe this world?',
                      message: 'A backup is made and the world folder moves to the quarantine folder (nothing is deleted). The next start generates a fresh Vardoran under the same name – characters and castles start over.',
                      confirm: 'Wipe world',
                      danger: true,
                    });
                    if (!r.ok) return;
                  }
                  run('reset', () => api.resetWorld(id), 'World wiped – a new one is created on the next start');
                }}
              >
                Wipe
              </Button>
            </>
          )
        }
        bodyClassName="py-3"
      >
        {!worlds ? (
          <div className="py-6 text-center text-[12px] text-fg-4">Loading…</div>
        ) : !active || !active.saves.length ? (
          <Empty icon={<Globe2 />} title="No autosaves yet" description="Start the server to generate the world, or bring an existing one over below." className="py-6" />
        ) : (
          <div className="space-y-1">
            <div className="mb-2 flex items-center gap-2 text-[11px] tracking-wide text-fg-4 uppercase">
              <History className="size-3.5" /> Autosaves, newest first
            </div>
            {active.saves.map((s) => (
              <SaveRow
                key={s.file}
                s={s}
                check={checks[s.file]}
                disabled={running || busy != null}
                onRestore={async () => {
                  const r = await confirm({
                    title: `Roll back to the save from ${dateTime(s.modified)}?`,
                    message: 'A backup is made first, then that autosave is copied to the next number so the server loads it. Everything that happened after it is gone from the world (nothing is overwritten on disk).',
                    confirm: 'Roll back',
                    danger: true,
                  });
                  if (r.ok) run(`slot-${s.number}`, () => api.restoreAutosave(id, active.version, active.name, s.number), 'Rolled back – the server loads that save next');
                }}
              />
            ))}
          </div>
        )}
      </Section>

      <Section
        title="Other worlds"
        description="Worlds kept on this server. Switch the server to one, or start a brand-new world under a new name."
        icon={<Globe2 />}
        bodyClassName="py-3 space-y-3"
      >
        <div className="flex items-center gap-2">
          <Input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="New world name – e.g. season-2" maxLength={64} className="max-w-[320px]" />
          <Button
            size="md"
            icon={<Plus className="size-3.5" />}
            disabled={!newName.trim() || /[\\/:*?"<>|]/.test(newName)}
            onClick={async () => {
              const r = await confirm({ title: `Start a new world “${newName.trim()}”?`, message: 'The server switches to it and generates it on the next start. Your current world stays where it is – you can switch back any time.', confirm: 'New world' });
              if (r.ok) {
                await activate(newName.trim());
                setNewName('');
              }
            }}
          >
            Start new world
          </Button>
        </div>
        {others.length === 0 ? (
          <div className="py-3 text-center text-[12px] text-fg-4">No other worlds.</div>
        ) : (
          <div className="divide-y divide-line">
            {others.map((w) => {
              const key = `${w.version}/${w.name}`;
              const expanded = open === key;
              const legacy = w.version !== 'v4';
              return (
                <div key={key} className="py-2">
                  <div className="flex items-center gap-3">
                    <button onClick={() => setOpen(expanded ? null : key)} className="flex size-6 items-center justify-center rounded text-fg-3 hover:bg-hover">
                      {expanded ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
                    </button>
                    <span className="font-medium text-fg">{w.name}</span>
                    {legacy && <Badge tone="warn">{w.version} (older game version)</Badge>}
                    <span className="text-[12px] text-fg-3">
                      saved {ago(w.savedAt)} · {bytes(w.size)} · {plural(w.saves.length, 'autosave')}
                    </span>
                    <div className="ml-auto flex gap-1.5">
                      {!legacy && (
                        <Button size="sm" variant="primary" icon={<Play className="size-3.5" />} loading={busy === `act-${w.name}`} onClick={() => activate(w.name)}>
                          Use this world
                        </Button>
                      )}
                      <Button
                        size="sm"
                        icon={<Upload className="size-3.5" />}
                        onClick={async () => {
                          const dest = await pickFolder('Export the world folder to…');
                          if (dest) run(`exp-${key}`, () => api.exportWorld(id, w.version, w.name, dest), 'World exported');
                        }}
                      >
                        Export
                      </Button>
                      <Button size="sm" icon={<PenLine className="size-3.5" />} onClick={() => rename(w)}>
                        Rename
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        icon={<Trash2 className="size-3.5" />}
                        onClick={async () => {
                          const r = await confirm({ title: `Remove world “${w.name}”?`, message: 'It moves to Saves\\_quarantine – delete it from there yourself once you are sure.', confirm: 'Remove', danger: true });
                          if (r.ok) run(`del-${key}`, () => api.deleteWorld(id, w.version, w.name), 'Moved to quarantine');
                        }}
                      >
                        Remove
                      </Button>
                    </div>
                  </div>
                  {expanded && (
                    <div className="mt-2 ml-9 space-y-1">
                      {w.saves.slice(0, 12).map((s) => (
                        <div key={s.file} className="flex items-center gap-3 px-2 py-1 text-[12px] text-fg-3">
                          <span className="font-mono text-fg-2">{s.file}</span> {dateTime(s.modified)} · {bytes(s.size)}
                        </div>
                      ))}
                      {w.saves.length > 12 && <div className="px-2 text-[11px] text-fg-4">+{w.saves.length - 12} older</div>}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </Section>

      <Section
        title="Bring a world from the game"
        description="Copy a world from a private game you hosted from the V Rising client (or another server) onto this one. Your original stays untouched."
        icon={<ArrowRightLeft />}
        actions={
          <Button
            size="sm"
            icon={<FolderSearch className="size-3.5" />}
            onClick={async () => {
              const dir = await pickFolder('Pick a world folder (with AutoSave_N files) or a Saves folder');
              if (!dir) return;
              try {
                const ws = await api.scanWorldFolder(dir);
                if (!ws.length) toast('warn', 'No V Rising autosaves (AutoSave_N files) found in that folder.', id);
                setPicked({ dir, worlds: ws });
              } catch (e) {
                toast('error', errMsg(e), id);
              }
            }}
          >
            From another folder…
          </Button>
        }
        bodyClassName="py-3"
      >
        <div className="mb-3">
          <Checkbox checked={adopt} onChange={setAdopt} label="Also use the world’s own game rules (its ServerGameSettings.json) when it has one" />
        </div>
        {picked && (
          <div className="mb-3 space-y-1.5 rounded-xl border border-accent/30 bg-accent/[0.04] p-3">
            <div className="truncate font-mono text-[11px] text-fg-3">{picked.dir}</div>
            {picked.worlds.map((w) => (
              <div key={w.dir} className="flex items-center gap-3 rounded-lg px-2 py-1.5">
                <Globe2 className="size-4 text-fg-3" />
                <span className="font-mono text-[12.5px] text-fg">{w.name}</span>
                <span className="text-[12px] text-fg-3">
                  saved {ago(w.savedAt)} · {bytes(w.size)} {w.hasSettings && '· has its own rules'}
                </span>
                <Button size="sm" variant="primary" className="ml-auto" loading={busy === `imp-${w.dir}`} onClick={() => importWorld(w.dir, w, w.name)}>
                  Import
                </Button>
              </div>
            ))}
          </div>
        )}
        {!local ? (
          <div className="py-5 text-center text-[12px] text-fg-4">Looking for game saves…</div>
        ) : local.length === 0 ? (
          <div className="flex items-center gap-3 py-3 text-[12px] text-fg-3">
            <Laptop className="size-4 shrink-0 text-fg-4" />
            No V Rising game saves on this PC. Looked in AppData\LocalLow\Stunlock Studios\VRising (Saves and CloudSaves). Copy a world folder from another PC and use “From another folder”.
          </div>
        ) : (
          <div className="divide-y divide-line">
            {local.map((l) => (
              <div key={l.world.dir} className="flex items-center gap-3 py-2.5">
                <Laptop className="size-4 shrink-0 text-fg-3" />
                <div className="min-w-0 flex-1">
                  <div className="text-[12.5px] text-fg">
                    <span className="font-mono">{l.world.name}</span> <span className="text-fg-3">· saved {ago(l.world.savedAt)}</span>
                  </div>
                  <div className="truncate text-[11px] text-fg-4">
                    {l.source} · {l.world.version} · {bytes(l.world.size)} · {plural(l.world.saves.length, 'autosave')}
                  </div>
                </div>
                <Button size="sm" variant="primary" loading={busy === `imp-${l.world.dir}`} onClick={() => importWorld(l.world.dir, l.world, l.world.name)}>
                  Import
                </Button>
              </div>
            ))}
          </div>
        )}
      </Section>

      <Card className="p-4 text-[12px] leading-relaxed text-fg-3">
        <b className="text-fg-2">Characters live in the world.</b> In V Rising, characters, castles and progress are all part of the server’s save – switching or wiping a world switches or resets everyone’s
        characters too. Back up before big changes (Backups does it automatically before rollbacks, wipes and restores).
      </Card>
    </div>
  );
}
