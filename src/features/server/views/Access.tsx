import { useCallback, useEffect, useState } from 'react';
import { Ban, Copy, Crown, ExternalLink, Plus, RefreshCw, ShieldCheck, Trash2, UserPlus } from 'lucide-react';
import { api, errMsg, listen } from '@/lib/ipc';
import { copy, browse } from '@/lib/shell';
import { mask } from '@/lib/format';
import type { AccessEntry, AccessView } from '@/lib/types';
import { useApp, useStatus } from '@/store/app';
import { Button, IconButton } from '@/components/ui/Button';
import { confirm } from '@/components/ui/Dialog';
import { Input } from '@/components/ui/Field';
import { Badge, Callout, Empty, PageHeader, Section } from '@/components/ui/Surface';

const isSteamId = (s: string) => /^7656\d{13}$/.test(s.trim());

function Avatar({ seed }: { seed: string }) {
  let h = 0;
  for (const c of seed) h = (h * 31 + c.charCodeAt(0)) % 360;
  return (
    <div className="flex size-7 shrink-0 items-center justify-center rounded-full text-[12px] font-semibold text-white/90" style={{ background: `oklch(0.42 0.09 ${h})` }}>
      {(seed[0] ?? '?').toUpperCase()}
    </div>
  );
}

function AddRow({ placeholder, label, onAdd }: { placeholder: string; label: string; onAdd: (sid: string) => Promise<void> }) {
  const [v, setV] = useState('');
  const [busy, setBusy] = useState(false);
  const ok = isSteamId(v);
  const submit = async () => {
    if (!ok) return;
    setBusy(true);
    try {
      await onAdd(v.trim());
      setV('');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex items-center gap-2">
      <Input mono value={v} onChange={(e) => setV(e.target.value.replace(/\s/g, ''))} onKeyDown={(e) => e.key === 'Enter' && submit()} placeholder={placeholder} invalid={!!v && !ok} className="flex-1" />
      <Button size="md" variant="primary" icon={<Plus className="size-3.5" />} disabled={!ok} loading={busy} onClick={submit}>
        {label}
      </Button>
    </div>
  );
}

function EntryRow({ e, streamer, onRemove, removeLabel }: { e: AccessEntry; streamer: boolean; onRemove: () => void; removeLabel: string }) {
  return (
    <div className="flex items-center gap-3 py-2.5">
      <Avatar seed={e.name ?? e.steamId} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 text-[12.5px] font-medium text-fg">
          {e.name ?? <span className="text-fg-3">Not seen on this server yet</span>}
          {e.online && <Badge tone="ok">online</Badge>}
        </div>
        <div className="selectable mt-0.5 font-mono text-[11px] text-fg-4">{mask(e.steamId, streamer)}</div>
      </div>
      <IconButton label="Copy SteamID" onClick={() => copy(e.steamId)}>
        <Copy className="size-3.5" />
      </IconButton>
      <IconButton label="Steam profile" onClick={() => browse(`https://steamcommunity.com/profiles/${e.steamId}`)}>
        <ExternalLink className="size-3.5" />
      </IconButton>
      <Button size="sm" variant="outline" icon={<Trash2 className="size-3.5" />} onClick={onRemove}>
        {removeLabel}
      </Button>
    </div>
  );
}

export function Access({ id }: { id: string }) {
  const st = useStatus(id);
  const toast = useApp((s) => s.toast);
  const streamer = useApp((s) => s.settings?.streamerMode ?? false);
  const [view, setView] = useState<AccessView | null>(null);
  const running = st?.state === 'running' || st?.state === 'starting';

  const load = useCallback(() => {
    api.getAccess(id).then(setView).catch((e) => toast('error', errMsg(e), id));
  }, [id, toast]);
  useEffect(() => {
    load();
    const un = listen<string>('access-changed', (sid) => sid === id && load());
    return () => void un.then((f) => f());
  }, [id, load]);

  const edit = async (list: 'admins' | 'bans', sid: string, add: boolean, ask?: string) => {
    if (ask) {
      const r = await confirm({ title: ask, message: list === 'admins' ? 'They lose admin rights immediately (the server reloads the list within seconds).' : 'They can join again right away.', confirm: 'Remove' });
      if (!r.ok) return;
    }
    try {
      const changed = await api.setAccess(id, list, sid, add);
      if (changed) toast('success', `${list === 'admins' ? (add ? 'Admin added' : 'Admin removed') : add ? 'Banned' : 'Unbanned'} – ${running ? 'applied live' : 'saved'}`, id);
      else toast('info', 'Nothing changed – already on the list', id);
      load();
    } catch (e) {
      toast('error', errMsg(e), id);
    }
  };

  return (
    <div className="mx-auto max-w-[1000px] space-y-5 p-6 pb-16">
      <PageHeader
        title="Admins & bans"
        description="adminlist.txt and banlist.txt – one SteamID64 per line. The running server reloads both files within seconds, so changes apply without a restart."
        actions={
          <Button size="sm" icon={<RefreshCw className="size-3.5" />} onClick={load}>
            Refresh
          </Button>
        }
      />

      <Section
        title={
          <span className="flex items-center gap-2">
            Admins <Badge tone={view?.admins.length ? 'accent' : 'neutral'}>{view?.admins.length ?? 0}</Badge>
          </span>
        }
        description="Admins can use the in-game console after typing adminauth (open it with the ` key). They also get the admin slots (Max admins in Server Settings)."
        icon={<Crown />}
        bodyClassName="space-y-3 py-3"
      >
        <AddRow placeholder="SteamID64 – e.g. 76561198012345678" label="Make admin" onAdd={(sid) => edit('admins', sid, true)} />
        {!view ? (
          <div className="py-4 text-center text-[12px] text-fg-4">Loading…</div>
        ) : view.admins.length === 0 ? (
          <Empty icon={<ShieldCheck />} title="No admins yet" description="Add your own SteamID64 so you can manage the server in-game." className="py-6" />
        ) : (
          <div className="divide-y divide-line">
            {view.admins.map((e) => (
              <EntryRow key={e.steamId} e={e} streamer={streamer} removeLabel="Remove" onRemove={() => edit('admins', e.steamId, false, `Remove ${e.name ?? e.steamId} as admin?`)} />
            ))}
          </div>
        )}
      </Section>

      <Section
        title={
          <span className="flex items-center gap-2">
            Banned <Badge tone={view?.bans.length ? 'err' : 'neutral'}>{view?.bans.length ?? 0}</Badge>
          </span>
        }
        description="Banned players can't connect. Banning someone who's online also kicks them (over RCON, when it's on). In-game bans by admins land in this list too."
        icon={<Ban />}
        bodyClassName="space-y-3 py-3"
      >
        <AddRow placeholder="SteamID64 to ban" label="Ban" onAdd={(sid) => edit('bans', sid, true)} />
        {!view ? null : view.bans.length === 0 ? (
          <div className="py-4 text-center text-[12px] text-fg-4">Nobody is banned.</div>
        ) : (
          <div className="divide-y divide-line">
            {view.bans.map((e) => (
              <EntryRow key={e.steamId} e={e} streamer={streamer} removeLabel="Unban" onRemove={() => edit('bans', e.steamId, false, `Unban ${e.name ?? e.steamId}?`)} />
            ))}
          </div>
        )}
      </Section>

      <Callout tone="info" title="Finding a SteamID64">
        <UserPlus className="mr-1 inline size-3.5" /> Players who joined this server are listed under Players with their SteamID – use the buttons there. Otherwise open the player’s Steam
        profile: the number in <span className="font-mono">steamcommunity.com/profiles/7656…</span> is it (for custom URLs use a SteamID lookup site).
      </Callout>
    </div>
  );
}
