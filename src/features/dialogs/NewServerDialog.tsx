import { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { ArrowLeft, ArrowRight, Check, Crown, Feather, FolderOpen, Globe2, Moon, Rocket, Server, Shield, Skull, Swords } from 'lucide-react';
import { cn } from '@/lib/cn';
import { api, errMsg } from '@/lib/ipc';
import { bytes, generatePassword } from '@/lib/format';
import { SERVER_COLORS } from '@/lib/colors';
import { pickFolder } from '@/lib/shell';
import { defaultConfig } from '@/lib/defaults';
import type { FolderProbe, PortSet } from '@/lib/types';
import { useApp } from '@/store/app';
import { Button } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';
import { Checkbox, Input, Label, NumberInput, SecretInput, Select, Slider, Toggle } from '@/components/ui/Field';
import { Callout } from '@/components/ui/Surface';

const STEPS = [
  { title: 'Server', icon: Server },
  { title: 'World & players', icon: Globe2 },
  { title: 'Admin', icon: Crown },
  { title: 'Launch', icon: Rocket },
];

type Mode = 'PvE' | 'PvP';
type Difficulty = 'Easy' | 'Normal' | 'Brutal';

const MODES: { id: Mode; label: string; icon: typeof Shield; blurb: string }[] = [
  { id: 'PvE', label: 'PvE', icon: Shield, blurb: 'Players can’t hurt each other or raid castles' },
  { id: 'PvP', label: 'PvP', icon: Swords, blurb: 'Full-loot fights and castle sieges' },
];

const DIFFICULTIES: { id: Difficulty; label: string; icon: typeof Feather; blurb: string }[] = [
  { id: 'Easy', label: 'Easy', icon: Feather, blurb: 'Relaxed' },
  { id: 'Normal', label: 'Normal', icon: Moon, blurb: 'As designed' },
  { id: 'Brutal', label: 'Brutal', icon: Skull, blurb: 'Harder bosses, tougher world' },
];

const isSteamId = (s: string) => /^7656\d{13}$/.test(s.trim());

export function NewServerDialog() {
  const dialog = useApp((s) => s.dialog);
  const setDialog = useApp((s) => s.setDialog);
  const instances = useApp((s) => s.instances);
  const open = dialog?.kind === 'new';
  const [step, setStep] = useState(0);
  const [name, setName] = useState('');
  const [serverName, setServerName] = useState('');
  const [color, setColor] = useState('blood');
  const [dir, setDir] = useState('');
  const [ports, setPorts] = useState<PortSet>({ port: 9876, queryPort: 9877, rconPort: 25575 });
  const [slots, setSlots] = useState(10);
  const [mode, setMode] = useState<Mode>('PvE');
  const [difficulty, setDifficulty] = useState<Difficulty>('Normal');
  const [password, setPassword] = useState('');
  const [listed, setListed] = useState(true);
  const [adminId, setAdminId] = useState('');
  const [rcon, setRcon] = useState(true);
  const [rconPassword, setRconPassword] = useState(generatePassword(16));
  const [template, setTemplate] = useState('');
  const [installNow, setInstallNow] = useState(true);
  const [probe, setProbe] = useState<FolderProbe | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    const n = instances.length + 1;
    setStep(0);
    setName(n === 1 ? 'My V Rising Server' : `V Rising Server ${n}`);
    setServerName('');
    setColor(Object.keys(SERVER_COLORS)[instances.length % Object.keys(SERVER_COLORS).length]);
    setDir('');
    setTemplate(dialog?.kind === 'new' ? (dialog.templateId ?? '') : '');
    setSlots(10);
    setMode('PvE');
    setDifficulty('Normal');
    setPassword('');
    setListed(true);
    setAdminId('');
    setRcon(true);
    setRconPassword(generatePassword(16));
    setInstallNow(true);
    setError(null);
    api.suggestPorts().then(setPorts).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!dir) return setProbe(null);
    const t = setTimeout(() => api.probeFolder(dir).then(setProbe).catch(() => setProbe(null)), 250);
    return () => clearTimeout(t);
  }, [dir]);

  const listName = serverName.trim() || name.trim();
  const taken = (o: (typeof instances)[number]) => [o.config.port, o.config.queryPort, ...(o.config.rconEnabled ? [o.config.rconPort] : [])];
  const mine = [ports.port, ports.queryPort, ...(rcon ? [ports.rconPort] : [])];
  const portClash = instances.find((i) => taken(i).some((p) => mine.includes(p)));
  const badPorts = ports.port === ports.queryPort;
  const canNext = step === 0 ? name.trim().length > 0 && !portClash && !badPorts : step === 1 ? listName.length > 0 : step === 2 ? (!adminId || isSteamId(adminId)) && (!rcon || rconPassword.length >= 8) : true;

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const base = template ? instances.find((i) => i.id === template)?.config : undefined;
      const inst = await api.createInstance({
        name: name.trim(),
        installDir: dir || null,
        color,
        config: defaultConfig({
          ...(base ? { gameSettings: base.gameSettings, gameSettingsPreset: base.gameSettingsPreset, gameDifficultyPreset: base.gameDifficultyPreset, autoSaveCount: base.autoSaveCount, autoSaveInterval: base.autoSaveInterval } : {}),
          name: listName,
          port: ports.port,
          queryPort: ports.queryPort,
          rconPort: ports.rconPort,
          rconEnabled: rcon,
          rconPassword: rcon ? rconPassword : '',
          maxConnectedUsers: slots,
          password,
          listOnSteam: listed,
          gameSettings: { ...(base?.gameSettings ?? {}), GameModeType: mode, GameDifficulty: difficulty, ...(mode === 'PvE' ? { CastleDamageMode: 'Never', PlayerDamageMode: 'Always' } : {}) },
        }),
        installNow,
        templateId: template || null,
      });
      useApp.getState().upsertInstance(inst);
      if (adminId.trim()) await api.setAccess(inst.id, 'admins', adminId.trim(), true).catch(() => {});
      setDialog(null);
      useApp.getState().openServer(inst.id, 'overview');
      useApp.getState().toast('success', installNow ? `${inst.name} created – downloading server files…` : `${inst.name} created`, inst.id);
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
      title="Create a V Rising server"
      description="Four quick steps. Everything can be changed later."
      icon={<Rocket />}
      width={680}
      footer={
        <>
          {step > 0 && (
            <Button variant="ghost" icon={<ArrowLeft className="size-3.5" />} onClick={() => setStep(step - 1)}>
              Back
            </Button>
          )}
          <div className="flex-1" />
          {step < STEPS.length - 1 ? (
            <Button variant="primary" iconRight={<ArrowRight className="size-3.5" />} disabled={!canNext} onClick={() => setStep(step + 1)}>
              Continue
            </Button>
          ) : (
            <Button variant="primary" icon={<Check className="size-4" />} loading={busy} onClick={create}>
              {installNow ? 'Create & install' : 'Create server'}
            </Button>
          )}
        </>
      }
    >
      <div className="mb-5 flex items-center gap-2">
        {STEPS.map((s, i) => (
          <div key={s.title} className="flex flex-1 items-center gap-2">
            <button
              disabled={i > step}
              onClick={() => setStep(i)}
              className={cn('flex items-center gap-2 rounded-lg px-2 py-1 text-[12px] font-medium whitespace-nowrap transition-colors', i === step ? 'text-fg' : i < step ? 'text-ok' : 'text-fg-4')}
            >
              <span className={cn('flex size-6 items-center justify-center rounded-full border text-[11px]', i === step ? 'border-accent bg-accent/15 text-accent' : i < step ? 'border-ok/40 bg-ok/10' : 'border-line-strong')}>
                {i < step ? <Check className="size-3" /> : i + 1}
              </span>
              {s.title}
            </button>
            {i < STEPS.length - 1 && <div className={cn('h-px flex-1', i < step ? 'bg-ok/40' : 'bg-line')} />}
          </div>
        ))}
      </div>

      <AnimatePresence mode="wait">
        <motion.div key={step} initial={{ opacity: 0, x: 8 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -8 }} transition={{ duration: 0.13 }} className="space-y-4">
          {step === 0 && (
            <>
              <div>
                <Label>Profile name</Label>
                <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="My V Rising Server" />
              </div>
              <div>
                <Label>Colour</Label>
                <div className="flex gap-2">
                  {Object.entries(SERVER_COLORS).map(([k, c]) => (
                    <button key={k} title={c.label} onClick={() => setColor(k)} className={cn('size-7 rounded-full border-2 transition-transform hover:scale-110', color === k ? 'border-fg' : 'border-transparent')} style={{ background: c.hex }} />
                  ))}
                </div>
              </div>
              <div>
                <Label>Install folder</Label>
                <div className="flex gap-2">
                  <Input mono value={dir} onChange={(e) => setDir(e.target.value)} placeholder="Automatic (inside the manager’s data folder)" />
                  <Button
                    icon={<FolderOpen className="size-3.5" />}
                    onClick={async () => {
                      const p = await pickFolder('Choose where to install the server');
                      if (p) setDir(p);
                    }}
                  >
                    Browse
                  </Button>
                </div>
                {probe && (
                  <div className={cn('mt-1.5 text-[11.5px]', !probe.writable ? 'text-err' : probe.hasServer ? 'text-ok' : 'text-fg-4')}>
                    {!probe.writable
                      ? 'This folder is not writable.'
                      : probe.hasServer
                        ? 'A V Rising server is already installed here – its worlds and settings are kept.'
                        : `${probe.empty ? 'Empty folder' : 'Folder has files'}${probe.freeBytes != null ? ` · ${bytes(probe.freeBytes)} free (needs ~3 GB)` : ''}`}
                  </div>
                )}
              </div>
              <div className="grid grid-cols-3 gap-4">
                <div>
                  <Label>Game port (UDP)</Label>
                  <NumberInput value={ports.port} min={1024} max={65535} onChange={(v) => setPorts({ ...ports, port: v })} />
                </div>
                <div>
                  <Label>Query port (UDP)</Label>
                  <NumberInput value={ports.queryPort} min={1024} max={65535} onChange={(v) => setPorts({ ...ports, queryPort: v })} />
                </div>
                <div>
                  <Label>RCON port (TCP)</Label>
                  <NumberInput value={ports.rconPort} min={1024} max={65535} disabled={!rcon} onChange={(v) => setPorts({ ...ports, rconPort: v })} />
                </div>
              </div>
              {portClash ? (
                <div className="-mt-2 text-[11.5px] text-err">Ports overlap with {portClash.name}.</div>
              ) : badPorts ? (
                <div className="-mt-2 text-[11.5px] text-err">Game and query ports must differ.</div>
              ) : (
                <div className="-mt-2 text-[11.5px] text-fg-4">Defaults 9876 / 9877 – a free set is picked for you.</div>
              )}
              {instances.length > 0 && (
                <div>
                  <Label>Copy game rules & automation from</Label>
                  <Select value={template} onChange={(e) => setTemplate(e.target.value)}>
                    <option value="">Defaults</option>
                    {instances.map((i) => (
                      <option key={i.id} value={i.id}>
                        {i.name}
                      </option>
                    ))}
                  </Select>
                </div>
              )}
            </>
          )}
          {step === 1 && (
            <>
              <div>
                <Label>Name in the server list</Label>
                <Input value={serverName} placeholder={name} onChange={(e) => setServerName(e.target.value)} maxLength={80} />
                <div className="mt-1.5 text-[11.5px] text-fg-4">Players search for this under Online Play → Find Servers.</div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label>Join password (optional)</Label>
                  <SecretInput value={password} onChange={setPassword} placeholder="Open server" generate />
                </div>
                <div>
                  <Label>Max players · {slots}</Label>
                  <Slider value={slots} min={1} max={60} onChange={setSlots} marks={[1, 10, 20, 40, 60]} />
                </div>
              </div>
              <div>
                <Label>Game mode</Label>
                <div className="grid grid-cols-2 gap-2">
                  {MODES.map((p) => (
                    <button
                      key={p.id}
                      onClick={() => setMode(p.id)}
                      className={cn('flex items-start gap-3 rounded-xl border p-3 text-left transition-colors', mode === p.id ? 'border-accent/60 bg-accent/[0.07]' : 'border-line hover:border-line-strong')}
                    >
                      <p.icon className={cn('mt-0.5 size-4', mode === p.id ? 'text-accent' : 'text-fg-3')} />
                      <div>
                        <div className="text-[12.5px] font-semibold text-fg">{p.label}</div>
                        <div className="text-[11px] text-fg-4">{p.blurb}</div>
                      </div>
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <Label>Difficulty</Label>
                <div className="grid grid-cols-3 gap-2">
                  {DIFFICULTIES.map((p) => (
                    <button
                      key={p.id}
                      onClick={() => setDifficulty(p.id)}
                      className={cn('flex flex-col items-start gap-1.5 rounded-xl border p-3 text-left transition-colors', difficulty === p.id ? 'border-accent/60 bg-accent/[0.07]' : 'border-line hover:border-line-strong')}
                    >
                      <p.icon className={cn('size-4', difficulty === p.id ? 'text-accent' : 'text-fg-3')} />
                      <div className="text-[12.5px] font-semibold text-fg">{p.label}</div>
                      <div className="text-[11px] text-fg-4">{p.blurb}</div>
                    </button>
                  ))}
                </div>
                <div className="mt-1.5 text-[11.5px] text-fg-4">Every other rule – clan size, loot, day length, raid windows – is under Game Rules afterwards, with Stunlock’s presets too.</div>
              </div>
              <label className="flex items-center justify-between rounded-lg border border-line px-3 py-2 text-[12.5px] text-fg-2">
                List on Steam (players can find it in the server browser)
                <Toggle size="sm" checked={listed} onChange={setListed} />
              </label>
            </>
          )}
          {step === 2 && (
            <>
              <div>
                <Label>Your SteamID64 (optional)</Label>
                <Input mono value={adminId} onChange={(e) => setAdminId(e.target.value.trim())} placeholder="76561198…" invalid={!!adminId && !isSteamId(adminId)} />
                <div className="mt-1.5 text-[11.5px] text-fg-4">Added to adminlist.txt so you can use admin commands in-game (type adminauth in the console). Find it in your Steam profile URL.</div>
              </div>
              <label className="flex items-center justify-between rounded-lg border border-line px-3 py-2 text-[12.5px] text-fg-2">
                RCON – lets the manager announce messages, warn players before restarts and kick
                <Toggle size="sm" checked={rcon} onChange={setRcon} />
              </label>
              {rcon && (
                <div>
                  <Label>RCON password</Label>
                  <SecretInput value={rconPassword} onChange={setRconPassword} generate invalid={rconPassword.length < 8} />
                  <div className="mt-1.5 text-[11.5px] text-fg-4">Generated for you and stored encrypted. RCON stays on this PC unless you forward its port.</div>
                </div>
              )}
            </>
          )}
          {step === 3 && (
            <>
              <div className="rounded-xl border border-line bg-bg-raised p-4">
                <dl className="grid grid-cols-[140px_1fr] gap-y-2 text-[12.5px]">
                  <dt className="text-fg-3">Profile</dt>
                  <dd className="text-fg">{name}</dd>
                  <dt className="text-fg-3">Server name</dt>
                  <dd className="text-fg">{listName}</dd>
                  <dt className="text-fg-3">Ports</dt>
                  <dd className="font-mono text-fg">
                    UDP {ports.port}/{ports.queryPort}
                    {rcon && ` · RCON TCP ${ports.rconPort}`}
                  </dd>
                  <dt className="text-fg-3">Game</dt>
                  <dd className="text-fg">
                    {mode} · {difficulty} · up to {slots} players{password ? ' · password' : ''}
                  </dd>
                  <dt className="text-fg-3">Admin</dt>
                  <dd className="font-mono text-fg">{adminId || 'none yet'}</dd>
                  <dt className="text-fg-3">Folder</dt>
                  <dd className="truncate font-mono text-[11.5px] text-fg">{dir || 'automatic'}</dd>
                </dl>
              </div>
              <Checkbox checked={installNow} onChange={setInstallNow} label="Download the server files now with SteamCMD (about 300 MB download, 2 GB on disk, no Steam login needed)" />
              <Callout tone="info">
                After the download, press <b className="text-fg">Start</b>. The first start creates a fresh world. To host a world from a private game you played, bring it over under <b className="text-fg">Worlds</b> before starting.
              </Callout>
              {error && <Callout tone="err">{error}</Callout>}
            </>
          )}
        </motion.div>
      </AnimatePresence>
    </Dialog>
  );
}
