import { useEffect, useState } from 'react';
import { Gamepad2, Globe2, HardDriveDownload, IdCard, KeyRound, Network, Palette, TerminalSquare, Wand2 } from 'lucide-react';
import { cn } from '@/lib/cn';
import { api } from '@/lib/ipc';
import { netInfo } from '@/lib/net';
import { SERVER_COLORS } from '@/lib/colors';
import { secondsLabel } from '@/data/gameplay';
import type { NetInfo, ServerInstance } from '@/lib/types';
import { useApp } from '@/store/app';
import { Button } from '@/components/ui/Button';
import { FieldRow, Input, NumberInput, SecretInput, Select, Slider, TextArea, Toggle } from '@/components/ui/Field';
import { Badge, PageHeader, Section } from '@/components/ui/Surface';
import { useDraft } from '../draft';

function usedPorts(i: ServerInstance) {
  const v = [i.config.port, i.config.queryPort];
  if (i.config.rconEnabled) v.push(i.config.rconPort);
  if (i.config.apiEnabled) v.push(i.config.apiPort);
  return v;
}

export function Settings({ id }: { id: string }) {
  const { draft, patch } = useDraft(id);
  const instances = useApp((s) => s.instances);
  const [net, setNet] = useState<NetInfo | null>(null);
  useEffect(() => {
    netInfo().then(setNet).catch(() => {});
  }, []);
  if (!draft) return null;
  const c = draft.config;
  const mine = usedPorts(draft);
  const clash = instances.filter((o) => o.id !== id && usedPorts(o).some((p) => mine.includes(p)));
  const badSave = !c.saveName.trim() || /[\\/:*?"<>|]/.test(c.saveName) || c.saveName.startsWith('.');

  return (
    <div className="mx-auto max-w-[1000px] space-y-5 p-6 pb-24">
      <PageHeader
        title="Server Settings"
        description="ServerHostSettings.json – listing, password, ports, saves and RCON. Written into the file for you; the server reads it when it starts, so most changes made while it runs apply at the next restart. Name, description and join password apply right away over RCON."
      />

      <Section title="Listing" description="What players see in the server browser." icon={<Globe2 />} bodyClassName="divide-y divide-line">
        <FieldRow label="Server name" description="Shown in the server list – this is what players search for. Changes apply live while the server runs (RCON)." badge={<Badge tone="err">Required</Badge>} error={!c.name.trim() ? 'The server needs a name.' : undefined}>
          <Input value={c.name} invalid={!c.name.trim()} maxLength={80} onChange={(e) => patch((d) => void (d.config.name = e.target.value))} />
        </FieldRow>
        <FieldRow label="Description" description="Shown in the server details. Rules, Discord link, wipe schedule…" stacked>
          <TextArea value={c.description} maxLength={500} onChange={(e) => patch((d) => void (d.config.description = e.target.value))} placeholder="PvE · friendly · weekly events · discord.gg/…" />
        </FieldRow>
        <FieldRow label="List on Steam" description="Players can find the server in the in-game browser. Off = join by IP only (Direct Connect). The manager's live player count via Steam query also needs this.">
          <Toggle checked={c.listOnSteam} onChange={(v) => patch((d) => void (d.config.listOnSteam = v))} />
        </FieldRow>
        <FieldRow label="List on Epic (EOS)" description="Also list for crossplay through Epic Online Services.">
          <Toggle checked={c.listOnEos} onChange={(v) => patch((d) => void (d.config.listOnEos = v))} />
        </FieldRow>
        <FieldRow label="Max players" description="MaxConnectedUsers – 40 is the default. Plan ~8 GB of RAM for a busy server.">
          <div className="flex items-center gap-3">
            <Slider value={c.maxConnectedUsers} min={1} max={128} marks={[1, 10, 40, 60, 128]} onChange={(v) => patch((d) => void (d.config.maxConnectedUsers = v))} />
            <span className="w-9 text-right font-mono text-[13px] text-fg">{c.maxConnectedUsers}</span>
          </div>
        </FieldRow>
        <FieldRow label="Admin slots" description="MaxConnectedAdmins – extra slots only admins can use when the server is full.">
          <NumberInput value={c.maxConnectedAdmins} min={0} max={20} onChange={(v) => patch((d) => void (d.config.maxConnectedAdmins = v))} className="w-40" />
        </FieldRow>
      </Section>

      <Section title="Access" description="Who can join. Admins and bans are managed under Admins & Bans." icon={<KeyRound />} bodyClassName="divide-y divide-line">
        <FieldRow label="Join password" description="Empty = anyone can join. Players type it when they connect. Applies live while the server runs (RCON).">
          <SecretInput value={c.password} onChange={(v) => patch((d) => void (d.config.password = v))} placeholder="No password" generate />
        </FieldRow>
        <FieldRow label="VAC secure" description="Secure – Valve Anti-Cheat. Leave on unless you have a reason.">
          <Toggle checked={c.secure} onChange={(v) => patch((d) => void (d.config.secure = v))} />
        </FieldRow>
        <FieldRow label="LAN mode" description="Only players on your local network can join (no Steam authentication).">
          <Toggle checked={c.lanMode} onChange={(v) => patch((d) => void (d.config.lanMode = v))} />
        </FieldRow>
        <FieldRow label="Hide IP address" description="Don't show the server's IP in the browser details.">
          <Toggle checked={c.hideIpAddress} onChange={(v) => patch((d) => void (d.config.hideIpAddress = v))} />
        </FieldRow>
        <FieldRow label="Debug events for admins only" description="AdminOnlyDebugEvents – only admins can trigger debug events.">
          <Toggle checked={c.adminOnlyDebugEvents} onChange={(v) => patch((d) => void (d.config.adminOnlyDebugEvents = v))} />
        </FieldRow>
        <FieldRow label="Disable debug events" description="DisableDebugEvents – nobody can use them.">
          <Toggle checked={c.disableDebugEvents} onChange={(v) => patch((d) => void (d.config.disableDebugEvents = v))} />
        </FieldRow>
      </Section>

      <Section
        title="Network"
        description="Two UDP ports: game and query. Forward both for players outside your network – see Port Forwarding."
        icon={<Network />}
        actions={
          <Button
            size="sm"
            icon={<Wand2 className="size-3.5" />}
            onClick={async () => {
              const p = await api.suggestPorts(id);
              patch((d) => {
                d.config.port = p.port;
                d.config.queryPort = p.queryPort;
                d.config.rconPort = p.rconPort;
              });
            }}
          >
            Pick free ports
          </Button>
        }
        bodyClassName="divide-y divide-line"
      >
        <FieldRow label="Game port" description="UDP, default 9876. A second server on this PC gets 9886, and so on." error={clash.length ? `Ports overlap with ${clash.map((x) => x.name).join(', ')} – they can't run at the same time.` : undefined}>
          <NumberInput value={c.port} min={1024} max={65535} onChange={(v) => patch((d) => void (d.config.port = v))} className="w-44" />
        </FieldRow>
        <FieldRow label="Query port" description="UDP, default 9877 – Steam server browser." error={c.port === c.queryPort ? 'Must differ from the game port.' : undefined}>
          <NumberInput value={c.queryPort} min={1024} max={65535} onChange={(v) => patch((d) => void (d.config.queryPort = v))} className="w-44" />
        </FieldRow>
        <FieldRow label="Bind to IP" description="Address – only for PCs with several network adapters. Empty listens on all of them.">
          <Select value={c.address} onChange={(e) => patch((d) => void (d.config.address = e.target.value))}>
            <option value="">All interfaces (default)</option>
            {net?.local.map((n) => (
              <option key={n.ip + n.interface} value={n.ip}>
                {n.ip} — {n.interface}
              </option>
            ))}
            {c.address && !net?.local.some((n) => n.ip === c.address) && <option value={c.address}>{c.address}</option>}
          </Select>
        </FieldRow>
        <FieldRow label="Server FPS" description="ServerFps – simulation rate. 30 is the default; higher costs CPU.">
          <NumberInput value={c.serverFps} min={10} max={120} step={5} onChange={(v) => patch((d) => void (d.config.serverFps = v))} className="w-40" />
        </FieldRow>
      </Section>

      <Section title="World & saves" description="Which world the server loads and how often it saves. Switch, import and roll back worlds under Worlds." icon={<HardDriveDownload />} bodyClassName="divide-y divide-line">
        <FieldRow label="Save name" description="The world folder under Saves\v4. A new name starts a fresh world on the next start." error={badSave ? 'Use a plain folder name.' : undefined}>
          <Input value={c.saveName} invalid={badSave} maxLength={64} onChange={(e) => patch((d) => void (d.config.saveName = e.target.value))} />
        </FieldRow>
        <FieldRow label="Autosave every" description="AutoSaveInterval – also saved on every clean stop.">
          <div className="flex items-center gap-3">
            <Slider value={c.autoSaveInterval} min={30} max={1800} step={30} onChange={(v) => patch((d) => void (d.config.autoSaveInterval = v))} />
            <span className="w-16 text-right font-mono text-[12.5px] text-fg">{secondsLabel(c.autoSaveInterval)}</span>
          </div>
        </FieldRow>
        <FieldRow label="Autosaves kept" description="AutoSaveCount – rolling autosaves per world (each one ~7 MB compressed).">
          <NumberInput value={c.autoSaveCount} min={1} max={200} onChange={(v) => patch((d) => void (d.config.autoSaveCount = v))} className="w-40" />
        </FieldRow>
        <FieldRow label="Compress saves" description="CompressSaveFiles – .save.gz instead of .save (about 5× smaller).">
          <Toggle checked={c.compressSaveFiles} onChange={(v) => patch((d) => void (d.config.compressSaveFiles = v))} />
        </FieldRow>
      </Section>

      <Section title="RCON & API" description="RCON lets the manager announce messages, warn players before restarts and kick. Keep these ports closed on your router unless you administer remotely." icon={<TerminalSquare />} bodyClassName="divide-y divide-line">
        <FieldRow label="RCON" description="Rcon.Enabled – recommended. Applies at the next start.">
          <Toggle checked={c.rconEnabled} onChange={(v) => patch((d) => void (d.config.rconEnabled = v))} />
        </FieldRow>
        <FieldRow label="RCON port" description="TCP, default 25575.">
          <NumberInput value={c.rconPort} min={1024} max={65535} disabled={!c.rconEnabled} onChange={(v) => patch((d) => void (d.config.rconPort = v))} className="w-44" />
        </FieldRow>
        <FieldRow label="RCON password" description="Encrypted in the manager's own files; the server needs it in plain text in its settings file." error={c.rconEnabled && !c.rconPassword ? 'RCON needs a password.' : undefined}>
          <SecretInput value={c.rconPassword} onChange={(v) => patch((d) => void (d.config.rconPassword = v))} placeholder="Required for RCON" generate />
        </FieldRow>
        <FieldRow label="HTTP API" description="API.Enabled – the server's metrics endpoint (Prometheus format).">
          <Toggle checked={c.apiEnabled} onChange={(v) => patch((d) => void (d.config.apiEnabled = v))} />
        </FieldRow>
        <FieldRow label="API port" description="TCP, default 9090.">
          <NumberInput value={c.apiPort} min={1024} max={65535} disabled={!c.apiEnabled} onChange={(v) => patch((d) => void (d.config.apiPort = v))} className="w-44" />
        </FieldRow>
      </Section>

      <Section title="Manager profile" description="Only used by this app – not sent to the game." icon={<IdCard />} bodyClassName="divide-y divide-line">
        <FieldRow label="Display name" description="Name of this profile in tabs and the sidebar.">
          <Input value={draft.name} onChange={(e) => patch((d) => void (d.name = e.target.value))} />
        </FieldRow>
        <FieldRow
          label={
            <span className="flex items-center gap-2">
              <Palette className="size-3.5 text-fg-3" /> Tag colour
            </span>
          }
          description="Helps tell servers apart at a glance."
        >
          <div className="flex flex-wrap gap-2">
            {Object.entries(SERVER_COLORS).map(([k, col]) => (
              <button
                key={k}
                title={col.label}
                onClick={() => patch((d) => void (d.color = k))}
                className={cn('size-7 rounded-full border-2 transition-transform hover:scale-110', draft.color === k ? 'border-fg' : 'border-transparent')}
                style={{ background: col.hex }}
              />
            ))}
          </div>
        </FieldRow>
        <FieldRow
          label={
            <span className="flex items-center gap-2">
              <Gamepad2 className="size-3.5 text-fg-3" /> Notes
            </span>
          }
          description="Anything you want to remember about this server."
          stacked
        >
          <TextArea value={draft.notes} onChange={(e) => patch((d) => void (d.notes = e.target.value))} placeholder="Discord invite, wipe dates, who the admins are…" />
        </FieldRow>
      </Section>
    </div>
  );
}
