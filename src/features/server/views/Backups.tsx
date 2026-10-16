import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Archive, ArchiveRestore, FolderOpen, Plus, RefreshCw, ShieldCheck, Trash2 } from 'lucide-react';
import { api, errMsg, listen } from '@/lib/ipc';
import { ago, bytes, dateTime } from '@/lib/format';
import { reveal } from '@/lib/shell';
import type { BackupInfo, VerifyResult } from '@/lib/types';
import { useApp, useInstance, useStatus } from '@/store/app';
import { Button, IconButton } from '@/components/ui/Button';
import { confirm, Dialog } from '@/components/ui/Dialog';
import { Checkbox, Input } from '@/components/ui/Field';
import { Badge, Callout, Card, Empty, PageHeader, Stat } from '@/components/ui/Surface';

export function Backups({ id }: { id: string }) {
  const inst = useInstance(id)!;
  const st = useStatus(id);
  const toast = useApp((s) => s.toast);
  const setView = useApp((s) => s.setView);
  const [list, setList] = useState<BackupInfo[] | null>(null);
  const [dir, setDir] = useState('');
  const [label, setLabel] = useState('');
  const [creating, setCreating] = useState(false);
  const [restore, setRestore] = useState<BackupInfo | null>(null);
  const [withConfig, setWithConfig] = useState(false);
  const [verified, setVerified] = useState<Record<string, VerifyResult>>({});
  const [verifying, setVerifying] = useState<string | null>(null);

  const verify = async (b: BackupInfo) => {
    setVerifying(b.path);
    try {
      const v = await api.verifyBackup(id, b.path);
      setVerified((m) => ({ ...m, [b.path]: v }));
      if (v.ok) toast('success', `Backup is intact – ${v.worlds.length ? v.worlds.map((w) => w.replace(/^v\d+\//, '')).join(', ') : 'settings only'}${v.hasSettings && v.worlds.length ? ' + settings' : ''}`, id);
      else toast('error', `Backup is damaged: ${v.error}`, id);
    } catch (e) {
      toast('error', errMsg(e), id);
    } finally {
      setVerifying(null);
    }
  };
  const running = st?.state === 'running' || st?.state === 'starting' || st?.state === 'stopping';

  const load = useCallback(() => {
    api.listBackups(id).then(setList).catch((e) => toast('error', errMsg(e)));
    api.backupDir(id).then(setDir).catch(() => {});
  }, [id, toast]);
  useEffect(load, [load]);
  useEffect(() => {
    const off = listen<BackupInfo>('backup-created', () => load());
    return () => {
      off.then((f) => f());
    };
  }, [load]);

  const create = async () => {
    setCreating(true);
    try {
      const b = await api.createBackup(id, label);
      toast('success', `Backup created (${bytes(b.size)})`, id);
      setLabel('');
      load();
    } catch (e) {
      toast('error', errMsg(e), id);
    } finally {
      setCreating(false);
    }
  };

  const total = (list ?? []).reduce((s, b) => s + b.size, 0);
  const a = inst.automation;

  return (
    <div className="mx-auto max-w-[1100px] space-y-5 p-6">
      <PageHeader
        title="Backups"
        description="Zip snapshots of the world saves and config files. Restores always back up the current state first and move replaced files to quarantine."
        actions={
          <>
            <Button size="sm" icon={<RefreshCw className="size-3.5" />} onClick={load}>
              Refresh
            </Button>
            <Button size="sm" icon={<FolderOpen className="size-3.5" />} disabled={!dir} onClick={() => reveal(dir)}>
              Open folder
            </Button>
          </>
        }
      />
      <div className="grid grid-cols-3 gap-4">
        <Stat label="Backups" icon={<Archive />} value={list?.length ?? '—'} sub={`${bytes(total)} total`} />
        <Stat label="Last backup" value={<span className="text-[17px]">{ago(list?.[0]?.createdAt)}</span>} sub={list?.[0] ? dateTime(list[0].createdAt) : 'No backups yet'} />
        <Stat
          label="Automatic"
          value={<span className="text-[17px]">{a.backupIntervalMins > 0 ? `Every ${a.backupIntervalMins}m` : 'Off'}</span>}
          sub={
            <button className="text-accent hover:underline" onClick={() => setView(id, 'automation')}>
              Keep newest {a.backupKeep} automatic · {a.backupOnStop ? 'on stop' : 'not on stop'} →
            </button>
          }
        />
      </div>
      <Card className="flex items-center gap-3 p-4">
        <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Label (optional) – e.g. before the Kindlewastes boss" onKeyDown={(e) => e.key === 'Enter' && create()} />
        <Button variant="primary" icon={<Plus className="size-4" />} loading={creating} onClick={create}>
          Back up now
        </Button>
      </Card>
      {running && <Callout tone="info">Backups work while the server runs. Restoring needs it stopped.</Callout>}
      <Card className="overflow-hidden">
        {list === null ? (
          <div className="py-10 text-center text-[12px] text-fg-4">Loading…</div>
        ) : list.length === 0 ? (
          <Empty icon={<Archive />} title="No backups yet" description="Create one now, or let automation take them on a schedule." />
        ) : (
          <table className="w-full text-left text-[12.5px]">
            <thead className="border-b border-line bg-bg-raised/60 text-[11px] font-medium tracking-wide text-fg-4 uppercase">
              <tr>
                <th className="px-4 py-2.5 font-medium">Backup</th>
                <th className="px-4 py-2.5 font-medium">Type</th>
                <th className="px-4 py-2.5 font-medium">Created</th>
                <th className="px-4 py-2.5 text-right font-medium">Size</th>
                <th className="w-36 px-4 py-2.5" />
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {list.map((b) => (
                <tr key={b.path} className="group hover:bg-panel-2/60">
                  <td className="px-4 py-2.5">
                    <div className="font-medium text-fg">{b.label}</div>
                    <div className="flex items-center gap-2 font-mono text-[11px] text-fg-4">
                      {b.name}
                      {verified[b.path] &&
                        (verified[b.path].ok ? (
                          <Badge tone="ok" title={verified[b.path].worlds.join(', ')}>
                            <ShieldCheck /> Verified
                          </Badge>
                        ) : (
                          <Badge tone="err" title={verified[b.path].error ?? ''}>
                            <AlertTriangle /> Damaged
                          </Badge>
                        ))}
                    </div>
                  </td>
                  <td className="px-4 py-2.5">
                    <Badge tone={b.kind === 'manual' ? 'accent' : 'neutral'}>{b.kind === 'manual' ? 'Manual' : 'Automatic'}</Badge>
                  </td>
                  <td className="px-4 py-2.5 text-fg-2">
                    {dateTime(b.createdAt)} <span className="text-fg-4">· {ago(b.createdAt)}</span>
                  </td>
                  <td className="px-4 py-2.5 text-right font-mono text-fg-2">{bytes(b.size)}</td>
                  <td className="px-4 py-2.5">
                    <div className="flex justify-end gap-1">
                      <IconButton label="Verify backup (reads every file)" disabled={verifying === b.path} className={verifying === b.path ? 'animate-pulse' : undefined} onClick={() => verify(b)}>
                        <ShieldCheck />
                      </IconButton>
                      <Button size="xs" variant="outline" icon={<ArchiveRestore className="size-3" />} disabled={running} onClick={() => setRestore(b)}>
                        Restore
                      </Button>
                      <IconButton
                        label="Delete backup"
                        className="hover:text-err"
                        onClick={async () => {
                          const r = await confirm({ title: 'Delete this backup?', message: `${b.label} (${bytes(b.size)}) is permanently deleted.`, confirm: 'Delete', danger: true });
                          if (!r.ok) return;
                          try {
                            await api.deleteBackup(id, b.path);
                            load();
                          } catch (e) {
                            toast('error', errMsg(e));
                          }
                        }}
                      >
                        <Trash2 />
                      </IconButton>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      <div className="text-[11.5px] text-fg-4">Manual backups are never deleted automatically. Location: {dir}</div>

      <Dialog
        open={!!restore}
        onClose={() => setRestore(null)}
        title="Restore backup?"
        icon={<ArchiveRestore />}
        description={restore ? `${restore.label} · ${dateTime(restore.createdAt)}` : ''}
        width={480}
        footer={
          <>
            <Button variant="ghost" onClick={() => setRestore(null)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={async () => {
                const b = restore!;
                setRestore(null);
                try {
                  const n = await api.restoreBackup(id, b.path, withConfig);
                  toast('success', `Restored ${n} files`, id);
                  load();
                } catch (e) {
                  toast('error', errMsg(e), id);
                }
              }}
            >
              Restore
            </Button>
          </>
        }
      >
        <div className="space-y-3 text-[12.5px] text-fg-2">
          <p>The current world saves are backed up and moved to quarantine, then the backup's saves are put back.</p>
          <Checkbox checked={withConfig} onChange={setWithConfig} label="Also restore the settings files (host & game settings, admins, bans)" />
        </div>
      </Dialog>
    </div>
  );
}
