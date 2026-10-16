import { useEffect, useState } from 'react';
import { Copy, Download, FolderOpen, Package, Settings, Trash2, Upload } from 'lucide-react';
import { api, errMsg, inTauri } from '@/lib/ipc';
import { disable, enable, isEnabled } from '@tauri-apps/plugin-autostart';
import { dateTime } from '@/lib/format';
import { pickFile, pickFolder, pickSave, reveal } from '@/lib/shell';
import type { AppSettings, PackManifest } from '@/lib/types';
import { useApp } from '@/store/app';
import { discardDraft } from '@/features/server/draft';
import { Button } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';
import { Checkbox, FieldRow, Input, Label, NumberInput, Segmented, Select, Toggle } from '@/components/ui/Field';
import { Badge, Callout } from '@/components/ui/Surface';

// --------------------------------------------------------------------------- import

export function ImportDialog() {
  const dialog = useApp((s) => s.dialog);
  const setDialog = useApp((s) => s.setDialog);
  const open = dialog?.kind === 'import';
  const [tab, setTab] = useState<'pack' | 'folder'>('pack');
  const [packPath, setPackPath] = useState('');
  const [manifest, setManifest] = useState<PackManifest | null>(null);
  const [folder, setFolder] = useState('');
  const [found, setFound] = useState<string[]>([]);
  const [name, setName] = useState('');
  const [dest, setDest] = useState('');
  const [installNow, setInstallNow] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setTab(dialog?.kind === 'import' ? (dialog.tab ?? 'pack') : 'pack');
    setPackPath('');
    setManifest(null);
    setFolder('');
    setName('');
    setDest('');
    setError(null);
    api.findExistingInstalls().then(setFound).catch(() => setFound([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const choosePack = async () => {
    const p = await pickFile('Choose a server pack', ['vrising', 'zip'], 'V Rising server pack');
    if (!p) return;
    setPackPath(p);
    setError(null);
    try {
      const m = await api.readPack(p);
      setManifest(m);
      setName(m.instance.name);
    } catch (e) {
      setManifest(null);
      setError(errMsg(e));
    }
  };

  const doImport = async () => {
    setBusy(true);
    setError(null);
    try {
      const inst = tab === 'pack' ? await api.importPack(packPath, name, dest || null, installNow) : await api.importExisting(folder, name || undefined);
      useApp.getState().upsertInstance(inst);
      setDialog(null);
      useApp.getState().openServer(inst.id, 'overview');
      useApp.getState().toast('success', `${inst.name} imported`, inst.id);
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={() => setDialog(null)}
      title="Import a server"
      description="Bring in a server pack exported from this app, or adopt a server that's already installed."
      icon={<Download />}
      width={600}
      footer={
        <>
          <Button variant="ghost" onClick={() => setDialog(null)}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} disabled={tab === 'pack' ? !manifest : !folder} onClick={doImport}>
            Import
          </Button>
        </>
      }
    >
      <Segmented
        value={tab}
        onChange={setTab}
        className="mb-4"
        options={[
          { value: 'pack', label: 'Server pack (.vrising)', icon: <Package className="size-3.5" /> },
          { value: 'folder', label: 'Existing install', icon: <FolderOpen className="size-3.5" /> },
        ]}
      />
      {tab === 'pack' ? (
        <div className="space-y-4">
          <div className="flex gap-2">
            <Input mono readOnly value={packPath} placeholder="No file chosen" />
            <Button onClick={choosePack}>Choose…</Button>
          </div>
          {manifest && (
            <div className="rounded-xl border border-line bg-bg-raised p-4 text-[12.5px]">
              <div className="flex items-center gap-2">
                <span className="font-semibold text-fg">{manifest.instance.name}</span>
                <span className="text-fg-4">exported {dateTime(manifest.exportedAt)}</span>
              </div>
              <div className="mt-2 flex flex-wrap gap-1.5">
                <Badge tone={manifest.hasConfig ? 'ok' : 'neutral'}>Config files</Badge>
                <Badge tone={manifest.hasSaves ? 'ok' : 'neutral'}>{manifest.hasSaves ? 'World saves' : 'No saves'}</Badge>
                <Badge tone={manifest.includesSecrets ? 'warn' : 'neutral'}>{manifest.includesSecrets ? 'Includes passwords' : 'Passwords removed'}</Badge>
              </div>
              {!manifest.includesSecrets && <div className="mt-2 text-[11.5px] text-fg-4">Set a new admin password after importing.</div>}
            </div>
          )}
          {manifest && (
            <>
              <div>
                <Label>Name</Label>
                <Input value={name} onChange={(e) => setName(e.target.value)} />
              </div>
              <div>
                <Label>Install folder</Label>
                <div className="flex gap-2">
                  <Input mono value={dest} onChange={(e) => setDest(e.target.value)} placeholder="Automatic" />
                  <Button
                    onClick={async () => {
                      const p = await pickFolder('Install folder');
                      if (p) setDest(p);
                    }}
                  >
                    Browse
                  </Button>
                </div>
              </div>
              <Checkbox checked={installNow} onChange={setInstallNow} label="Download the server files right away" />
            </>
          )}
        </div>
      ) : (
        <div className="space-y-4">
          {found.length > 0 && (
            <div>
              <Label>Found on this PC</Label>
              <div className="space-y-1.5">
                {found.map((f) => (
                  <button key={f} onClick={() => setFolder(f)} className={`flex w-full items-center gap-2.5 rounded-lg border px-3 py-2 text-left ${folder === f ? 'border-accent/60 bg-accent/8' : 'border-line hover:border-line-strong'}`}>
                    <FolderOpen className="size-4 text-fg-4" />
                    <span className="truncate font-mono text-[12px] text-fg">{f}</span>
                    <Badge className="ml-auto">Steam</Badge>
                  </button>
                ))}
              </div>
            </div>
          )}
          <div>
            <Label>Server folder</Label>
            <div className="flex gap-2">
              <Input mono value={folder} onChange={(e) => setFolder(e.target.value)} placeholder="Folder containing VRisingServer.exe" />
              <Button
                onClick={async () => {
                  const p = await pickFolder('V Rising server folder');
                  if (p) setFolder(p);
                }}
              >
                Browse
              </Button>
            </div>
          </div>
          <div>
            <Label>Name (optional)</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Uses the server name from ServerHostSettings.json" />
          </div>
          <Callout tone="info">Settings, admins and bans are read from the existing data folder (save-data next to the server, or the default under AppData\LocalLow\Stunlock Studios\VRisingServer). Nothing is moved, and the worlds stay where they are.</Callout>
        </div>
      )}
      {error && <Callout tone="err" className="mt-4">{error}</Callout>}
    </Dialog>
  );
}

// --------------------------------------------------------------------------- export

export function ExportDialog() {
  const dialog = useApp((s) => s.dialog);
  const setDialog = useApp((s) => s.setDialog);
  const inst = useApp((s) => (dialog?.kind === 'export' ? s.instances.find((i) => i.id === dialog.id) : undefined));
  const toast = useApp((s) => s.toast);
  const [saves, setSaves] = useState(true);
  const [secrets, setSecrets] = useState(false);
  const [busy, setBusy] = useState(false);

  const run = async () => {
    if (!inst) return;
    const dest = await pickSave('Export server pack', `${inst.name.replace(/[^\w\- ]/g, '')}.vrising`, ['vrising'], 'V Rising server pack');
    if (!dest) return;
    setBusy(true);
    try {
      await api.exportPack(inst.id, dest, { includeSaves: saves, includeSecrets: secrets });
      toast('success', 'Server pack exported', inst.id);
      setDialog(null);
      reveal(dest.replace(/[\\/][^\\/]+$/, ''));
    } catch (e) {
      toast('error', errMsg(e), inst.id);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={!!inst}
      onClose={() => setDialog(null)}
      title={`Export ${inst?.name ?? ''}`}
      description="A single .vrising file with the profile and settings – import it on another PC or keep it as a template."
      icon={<Upload />}
      width={500}
      footer={
        <>
          <Button variant="ghost" onClick={() => setDialog(null)}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} onClick={run}>
            Export…
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Checkbox checked={saves} onChange={setSaves} label="Include world saves" />
        <Checkbox checked={secrets} onChange={setSecrets} label="Include role passwords" />
        {secrets && <Callout tone="warn">Anyone with the file can see the passwords. Only share it with people you trust.</Callout>}
        <div className="text-[11.5px] text-fg-4">Server files aren’t included – the importer downloads them from Steam.</div>
      </div>
    </Dialog>
  );
}

// --------------------------------------------------------------------------- clone

export function CloneDialog() {
  const dialog = useApp((s) => s.dialog);
  const setDialog = useApp((s) => s.setDialog);
  const inst = useApp((s) => (dialog?.kind === 'clone' ? s.instances.find((i) => i.id === dialog.id) : undefined));
  const [name, setName] = useState('');
  const [saves, setSaves] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (inst) {
      setName(`${inst.name} (copy)`);
      setError(null);
    }
  }, [inst]);
  const run = async () => {
    if (!inst) return;
    setBusy(true);
    try {
      const c = await api.cloneInstance(inst.id, name, saves);
      useApp.getState().upsertInstance(c);
      setDialog(null);
      useApp.getState().openServer(c.id, 'overview');
      useApp.getState().toast('success', `${c.name} created – install its files to run it`, c.id);
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={!!inst}
      onClose={() => setDialog(null)}
      title="Duplicate server"
      description="Copies all settings and config into a new server with its own folder and port."
      icon={<Copy />}
      width={460}
      footer={
        <>
          <Button variant="ghost" onClick={() => setDialog(null)}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} onClick={run} disabled={!name.trim()}>
            Duplicate
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <div>
          <Label>Name</Label>
          <Input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        </div>
        <Checkbox checked={saves} onChange={setSaves} label="Also copy the world saves" />
        {error && <Callout tone="err">{error}</Callout>}
      </div>
    </Dialog>
  );
}

// --------------------------------------------------------------------------- delete

export function DeleteDialog() {
  const dialog = useApp((s) => s.dialog);
  const setDialog = useApp((s) => s.setDialog);
  const inst = useApp((s) => (dialog?.kind === 'delete' ? s.instances.find((i) => i.id === dialog.id) : undefined));
  const [files, setFiles] = useState(false);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setFiles(false);
    setTyped('');
  }, [inst]);
  const run = async () => {
    if (!inst) return;
    setBusy(true);
    try {
      await api.deleteInstance(inst.id, files);
      discardDraft(inst.id);
      useApp.getState().removeInstance(inst.id);
      useApp.getState().toast('success', `${inst.name} removed`);
      setDialog(null);
    } catch (e) {
      useApp.getState().toast('error', errMsg(e), inst.id);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={!!inst}
      onClose={() => setDialog(null)}
      title={`Delete ${inst?.name ?? ''}?`}
      icon={<Trash2 />}
      width={480}
      footer={
        <>
          <Button variant="ghost" onClick={() => setDialog(null)}>
            Cancel
          </Button>
          <Button variant="danger" loading={busy} disabled={files && typed !== inst?.name} onClick={run}>
            {files ? 'Delete server and files' : 'Remove from manager'}
          </Button>
        </>
      }
    >
      <div className="space-y-3 text-[12.5px] text-fg-2">
        <p>The server is stopped (if running) and removed from the manager.</p>
        <Checkbox checked={files} onChange={setFiles} label="Also delete the server folder from disk" />
        {files && (
          <>
            <Callout tone="err">
              Deletes <span className="font-mono">{inst?.installDir}</span> including its worlds. Backups in the server folder are moved to the manager’s data folder first.
            </Callout>
            <div>
              <Label>Type the server name to confirm</Label>
              <Input value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={inst?.name} />
            </div>
          </>
        )}
      </div>
    </Dialog>
  );
}

// --------------------------------------------------------------------------- app settings

const WEBHOOK_LEVELS = [
  { value: 'success', label: 'Online & updates' },
  { value: 'error', label: 'Crashes & errors' },
  { value: 'warn', label: 'Warnings' },
  { value: 'info', label: 'Player joins & info' },
];

export function AppSettingsDialog() {
  const [autostart, setAutostart] = useState<boolean | null>(null);
  const [testing, setTesting] = useState(false);
  const dialog = useApp((s) => s.dialog);
  const setDialog = useApp((s) => s.setDialog);
  const settings = useApp((s) => s.settings);
  const info = useApp((s) => s.info);
  const save = useApp((s) => s.saveSettings);
  const open = dialog?.kind === 'settings';
  const [d, setD] = useState<AppSettings | null>(null);
  useEffect(() => {
    if (open && settings) setD(structuredClone(settings));
    if (open && inTauri()) isEnabled().then(setAutostart).catch(() => setAutostart(null));
  }, [open, settings]);
  if (!d) return null;
  const folder = (k: 'steamcmdDir' | 'defaultInstallRoot' | 'backupDir', label: string, desc: string, placeholder: string) => (
    <FieldRow label={label} description={desc} stacked>
      <div className="flex gap-2">
        <Input mono value={d[k] ?? ''} placeholder={placeholder} onChange={(e) => setD({ ...d, [k]: e.target.value || null })} />
        <Button
          onClick={async () => {
            const p = await pickFolder(label, d[k] ?? undefined);
            if (p) setD({ ...d, [k]: p });
          }}
        >
          Browse
        </Button>
      </div>
    </FieldRow>
  );
  return (
    <Dialog
      open={open}
      onClose={() => setDialog(null)}
      title="App settings"
      icon={<Settings />}
      width={620}
      footer={
        <>
          <Button variant="ghost" onClick={() => setDialog(null)}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={async () => {
              try {
                await save(d);
                setDialog(null);
                useApp.getState().toast('success', 'Settings saved');
              } catch (e) {
                useApp.getState().toast('error', errMsg(e));
              }
            }}
          >
            Save
          </Button>
        </>
      }
    >
      <div className="divide-y divide-line">
        {folder('defaultInstallRoot', 'Default server folder', 'New servers are installed in a subfolder here.', `${info?.dataDir ?? ''}\\servers`)}
        {folder('backupDir', 'Backup folder', 'Leave empty to keep backups inside each server folder (\\Backups). Set a folder on another drive for safety.', 'Inside each server folder')}
        {folder('steamcmdDir', 'SteamCMD folder', 'Downloaded automatically on first install. Point at an existing SteamCMD to share it.', `${info?.dataDir ?? ''}\\steamcmd`)}
        <FieldRow label="Keep running in the tray" description="Closing the window hides the manager to the system tray so crash recovery, schedules and backups keep working. Quit from the tray icon.">
          <Toggle checked={d.closeToTray} onChange={(v) => setD({ ...d, closeToTray: v })} />
        </FieldRow>
        <FieldRow label="Start with Windows" description="Launch the manager minimised to the tray when you sign in – combine with “Start with the manager” on a server for hands-off hosting.">
          <Toggle
            checked={!!autostart}
            disabled={autostart === null}
            onChange={async (v) => {
              try {
                if (v) await enable();
                else await disable();
                setAutostart(await isEnabled());
              } catch (e) {
                useApp.getState().toast('error', errMsg(e));
              }
            }}
          />
        </FieldRow>
        <FieldRow label="Notifications webhook" description="Paste a Discord (or Slack) webhook URL to get server events in a channel." stacked>
          <div className="flex gap-2">
            <Input mono value={d.webhookUrl} placeholder="https://discord.com/api/webhooks/…" onChange={(e) => setD({ ...d, webhookUrl: e.target.value })} />
            <Button
              loading={testing}
              disabled={!d.webhookUrl.trim()}
              onClick={async () => {
                setTesting(true);
                try {
                  await api.testWebhook(d.webhookUrl);
                  useApp.getState().toast('success', 'Test message sent');
                } catch (e) {
                  useApp.getState().toast('error', errMsg(e));
                } finally {
                  setTesting(false);
                }
              }}
            >
              Send test
            </Button>
          </div>
          <div className="mt-2.5 flex flex-wrap gap-x-4 gap-y-2">
            {WEBHOOK_LEVELS.map((l) => (
              <Checkbox
                key={l.value}
                label={l.label}
                checked={d.webhookLevels.includes(l.value)}
                onChange={(v) => setD({ ...d, webhookLevels: v ? [...d.webhookLevels, l.value] : d.webhookLevels.filter((x) => x !== l.value) })}
              />
            ))}
          </div>
        </FieldRow>
        <FieldRow label="Live update rate" description="How often performance and status refresh.">
          <Select value={String(d.telemetryIntervalMs)} onChange={(e) => setD({ ...d, telemetryIntervalMs: +e.target.value })}>
            <option value="500">Every 0.5 s</option>
            <option value="1000">Every second</option>
            <option value="2000">Every 2 s</option>
            <option value="5000">Every 5 s</option>
          </Select>
        </FieldRow>
        <FieldRow label="Check for server updates on launch" description="Look up the latest build for each server when the manager opens.">
          <Toggle checked={d.checkUpdatesOnLaunch} onChange={(v) => setD({ ...d, checkUpdatesOnLaunch: v })} />
        </FieldRow>
        <FieldRow label="Confirm stops and restarts" description="Ask before stopping a running server.">
          <Toggle checked={d.confirmDestructive} onChange={(v) => setD({ ...d, confirmDestructive: v })} />
        </FieldRow>
        <FieldRow label="Reduce motion" description="Turn off animations.">
          <Toggle checked={d.reduceMotion} onChange={(v) => setD({ ...d, reduceMotion: v })} />
        </FieldRow>
        <FieldRow label="Windows notifications" description="Toasts for crashes, warnings, players joining and servers coming online – only while the manager window isn’t in front.">
          <Toggle checked={d.desktopNotifications} onChange={(v) => setD({ ...d, desktopNotifications: v })} />
        </FieldRow>
        <FieldRow label="Streamer mode" description="Hide IP addresses, passwords and account ids in the interface – for streaming or screenshots.">
          <Toggle checked={d.streamerMode} onChange={(v) => setD({ ...d, streamerMode: v })} />
        </FieldRow>
        <FieldRow label="Keep history for" description="Per-minute performance and player history in the manager’s database (Performance → 24h / 7d / 30d).">
          <NumberInput value={d.metricsRetentionDays} min={1} max={365} suffix="days" onChange={(v) => setD({ ...d, metricsRetentionDays: v })} />
        </FieldRow>
        <div className="flex items-center justify-between py-3.5 text-[12px] text-fg-3">
          <span>
            v{info?.version} · {info?.portable ? 'Portable' : 'Installed'} · Steam app {info?.appId}
          </span>
          <button className="text-accent hover:underline" onClick={() => info && reveal(info.dataDir)}>
            Open data folder
          </button>
        </div>
      </div>
    </Dialog>
  );
}
