import { useEffect, useState } from 'react';
import { Archive, Download, FileCode2, FolderOpen, GitBranch, HardDrive, RefreshCw, ScrollText, Search, ShieldCheck, Trash2, Upload } from 'lucide-react';
import { api, errMsg } from '@/lib/ipc';
import { bytes } from '@/lib/format';
import { pickFolder, reveal } from '@/lib/shell';
import type { DiskUsage } from '@/lib/types';
import { useApp, useInstance, useStatus } from '@/store/app';
import { useServerActions } from '@/hooks/useServerActions';
import { Button } from '@/components/ui/Button';
import { FieldRow, Input, SecretInput } from '@/components/ui/Field';
import { Badge, Card, PageHeader, Section } from '@/components/ui/Surface';
import { useDraft } from '../draft';

export function Files({ id }: { id: string }) {
  const inst = useInstance(id)!;
  const st = useStatus(id);
  const { draft, patch } = useDraft(id);
  const toast = useApp((s) => s.toast);
  const setDialog = useApp((s) => s.setDialog);
  const { run, pending } = useServerActions(id);
  const [usage, setUsage] = useState<DiskUsage | null>(null);
  const [backupDir, setBackupDir] = useState('');
  const [checking, setChecking] = useState(false);
  const live = st?.state === 'running' || st?.state === 'starting' || st?.state === 'stopping';
  const installed = st?.state !== 'notInstalled';
  const busy = st?.state === 'installing' || st?.state === 'updating';

  useEffect(() => {
    api.diskUsage(id).then(setUsage).catch(() => {});
    api.backupDir(id).then(setBackupDir).catch(() => {});
  }, [id, st?.installedBuild]);

  // The data folder (-persistentDataPath) is "./relative" to the install folder unless absolute.
  const v = inst.launch.dataDir || './save-data';
  const data = /^[a-z]:[\\/]/i.test(v) ? v : `${inst.installDir}\\${v.replace(/^\.[\\/]/, '').replace(/\//g, '\\')}`;
  const folders = [
    { label: 'Server folder', path: inst.installDir, icon: HardDrive },
    { label: 'Data folder', path: data, icon: FolderOpen },
    { label: 'World saves', path: `${data}\\Saves\\v4`, icon: Archive },
    { label: 'Settings files', path: `${data}\\Settings`, icon: FileCode2 },
    { label: 'Logs', path: `${inst.installDir}\\logs`, icon: ScrollText },
    { label: 'Backups', path: backupDir, icon: Archive },
  ];
  const total = usage ? usage.install + usage.backups : 0;
  const update = st?.installedBuild && st.latestBuild && st.installedBuild !== st.latestBuild;

  return (
    <div className="mx-auto max-w-[1000px] space-y-5 p-6 pb-24">
      <PageHeader title="Install & Files" description="Server files are installed and updated with SteamCMD (anonymous login, free Steam app 1829350, about 2 GB on disk)." />

      <Card className="p-5">
        <div className="flex items-center gap-5">
          <div className="flex size-12 items-center justify-center rounded-xl bg-accent-dim text-accent">
            <Download className="size-5" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 text-[14px] font-semibold text-fg">
              {!installed ? 'Not installed yet' : st?.installedBuild ? `Build ${st.installedBuild}` : 'Installed'}
              {update ? <Badge tone="accent">Build {st!.latestBuild} available</Badge> : st?.latestBuild ? <Badge tone="ok">Latest</Badge> : null}
              {inst.branch && inst.branch !== 'public' && <Badge tone="violet">branch: {inst.branch}</Badge>}
            </div>
            <div className="mt-0.5 text-[12px] text-fg-3">
              {!installed ? 'Download the dedicated server (several GB) into the folder below.' : 'After every game patch, update the server – players on a newer game version can’t join an older server.'}
            </div>
          </div>
          <div className="flex gap-2">
            {installed && (
              <Button
                size="md"
                icon={<Search className="size-3.5" />}
                loading={checking}
                onClick={async () => {
                  setChecking(true);
                  try {
                    const avail = await api.checkUpdate(id);
                    toast(avail ? 'info' : 'success', avail ? 'An update is available' : 'The server is up to date', id);
                  } catch (e) {
                    toast('error', errMsg(e), id);
                  } finally {
                    setChecking(false);
                  }
                }}
              >
                Check
              </Button>
            )}
            {installed && (
              <Button icon={<ShieldCheck className="size-3.5" />} disabled={busy} loading={pending === 'validate'} onClick={() => run('validate')}>
                Validate
              </Button>
            )}
            <Button variant="primary" icon={<RefreshCw className="size-3.5" />} disabled={busy} loading={busy || pending === 'update' || pending === 'install'} onClick={() => run(installed ? 'update' : 'install')}>
              {installed ? (live ? 'Update & restart' : 'Update') : 'Install'}
            </Button>
          </div>
        </div>
      </Card>

      <Section title="Location & branch" icon={<GitBranch />} bodyClassName="divide-y divide-line">
        <FieldRow label="Server folder" description="Where the server files live. Moving an install: stop the server, move the folder in Explorer, then point this at the new place." error={live && draft.installDir !== inst.installDir ? 'Stop the server first.' : undefined}>
          <div className="flex gap-2">
            <Input mono value={draft.installDir} onChange={(e) => patch((d) => void (d.installDir = e.target.value))} />
            <Button
              disabled={live}
              onClick={async () => {
                const p = await pickFolder('Server folder', draft.installDir);
                if (p) patch((d) => void (d.installDir = p));
              }}
            >
              Browse
            </Button>
          </div>
        </FieldRow>
        <FieldRow label="Steam branch" description="“public” for the normal release. Use a beta branch name only if Stunlock announces one for dedicated servers (some need a password).">
          <Input mono value={draft.branch} placeholder="public" onChange={(e) => patch((d) => void (d.branch = e.target.value.trim()))} />
        </FieldRow>
        {draft.branch && draft.branch !== 'public' && (
          <FieldRow label="Branch password" description="Only for password-protected beta branches.">
            <SecretInput value={draft.branchPassword} onChange={(v) => patch((d) => void (d.branchPassword = v))} />
          </FieldRow>
        )}
      </Section>

      <div className="grid grid-cols-2 gap-4">
        <Section title="Folders" icon={<FolderOpen />} bodyClassName="py-2">
          {folders.map((f) => (
            <button key={f.label} onClick={() => f.path && reveal(f.path)} className="flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left hover:bg-panel-2">
              <f.icon className="size-4 text-fg-4" />
              <div className="min-w-0 flex-1">
                <div className="text-[12.5px] text-fg">{f.label}</div>
                <div className="truncate font-mono text-[10.5px] text-fg-4">{f.path}</div>
              </div>
              <FolderOpen className="size-3.5 text-fg-4" />
            </button>
          ))}
        </Section>
        <Section title="Disk usage" icon={<HardDrive />} bodyClassName="py-4 space-y-3">
          {usage == null ? (
            <div className="text-[12px] text-fg-4">Measuring…</div>
          ) : (
            <>
              <div className="flex h-2.5 overflow-hidden rounded-full bg-panel-2">
                {[
                  { v: usage.install - usage.saves - usage.logs, c: '#475569' },
                  { v: usage.saves, c: '#e5485a' },
                  { v: usage.logs, c: '#8b7cf6' },
                  { v: usage.backups, c: '#b9801a' },
                ].map((s, i) => (
                  <div key={i} style={{ width: `${(Math.max(0, s.v) / Math.max(1, total)) * 100}%`, background: s.c }} className="h-full border-r-2 border-panel last:border-0" />
                ))}
              </div>
              {[
                { label: 'Game files', v: usage.install - usage.saves - usage.logs, c: '#475569' },
                { label: 'World saves', v: usage.saves, c: '#e5485a' },
                { label: 'Logs', v: usage.logs, c: '#8b7cf6' },
                { label: 'Backups', v: usage.backups, c: '#b9801a' },
              ].map((r) => (
                <div key={r.label} className="flex items-center gap-2 text-[12.5px]">
                  <span className="size-2 rounded-full" style={{ background: r.c }} />
                  <span className="text-fg-3">{r.label}</span>
                  <span className="ml-auto font-mono text-fg">{bytes(Math.max(0, r.v))}</span>
                </div>
              ))}
            </>
          )}
        </Section>
      </div>

      <Section title="Share & manage" icon={<Upload />} bodyClassName="py-4 flex flex-wrap gap-2">
        <Button icon={<Upload className="size-3.5" />} onClick={() => setDialog({ kind: 'export', id })}>
          Export server pack
        </Button>
        <Button icon={<Download className="size-3.5" />} onClick={() => setDialog({ kind: 'clone', id })}>
          Duplicate server
        </Button>
        <Button variant="danger" icon={<Trash2 className="size-3.5" />} className="ml-auto" onClick={() => setDialog({ kind: 'delete', id })}>
          Delete server
        </Button>
      </Section>
    </div>
  );
}
