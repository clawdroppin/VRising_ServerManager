import { useCallback, useEffect, useState } from 'react';
import { Ban, Clock, Copy, Crown, ExternalLink, History, LogIn, LogOut, Megaphone, RefreshCw, Search, Send, UserX, Users } from 'lucide-react';
import { api, errMsg } from '@/lib/ipc';
import { ago, clock, dateTime, duration, mask } from '@/lib/format';
import { browse, copy } from '@/lib/shell';
import type { AccessView, OnlinePlayer, PlayerSummary, SessionRow } from '@/lib/types';
import { onlineCount, useApp, useInstance, useStatus } from '@/store/app';
import { Button, IconButton } from '@/components/ui/Button';
import { confirm } from '@/components/ui/Dialog';
import { Input, Segmented } from '@/components/ui/Field';
import { Badge, Callout, Empty, PageHeader, Section } from '@/components/ui/Surface';

const steamProfile = (steamId: string) => `https://steamcommunity.com/profiles/${steamId}`;

function Avatar({ name }: { name: string }) {
  // A stable hue per name so the same player always looks the same.
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) % 360;
  return (
    <div className="flex size-7 shrink-0 items-center justify-center rounded-full text-[12px] font-semibold text-white/90" style={{ background: `oklch(0.42 0.09 ${h})` }}>
      {name.slice(0, 1).toUpperCase()}
    </div>
  );
}

function Since({ ts }: { ts: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(t);
  }, []);
  return <>{duration((now - ts) / 1000)}</>;
}

export function Players({ id }: { id: string }) {
  const inst = useInstance(id)!;
  const st = useStatus(id);
  const events = useApp((s) => s.players[id]) ?? [];
  const toast = useApp((s) => s.toast);
  const streamer = useApp((s) => s.settings?.streamerMode ?? false);
  const [access, setAccess] = useState<AccessView | null>(null);
  const [msg, setMsg] = useState('');
  const [sending, setSending] = useState(false);
  const [known, setKnown] = useState<PlayerSummary[]>([]);
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [tab, setTab] = useState<'players' | 'sessions'>('players');
  const [q, setQ] = useState('');
  const running = st?.state === 'running' || st?.state === 'starting';
  const count = onlineCount(st);

  const load = useCallback(() => {
    api.getAccess(id).then(setAccess).catch((e) => toast('error', errMsg(e)));
    api.knownPlayers(id).then(setKnown).catch(() => {});
    api.playerSessions(id, 300).then(setSessions).catch(() => {});
  }, [id, toast]);
  useEffect(load, [load, events.length, st?.state]);

  const isAdmin = (sid: string | null) => !!sid && !!access?.admins.some((a) => a.steamId === sid);
  const isBanned = (sid: string | null) => !!sid && !!access?.bans.some((a) => a.steamId === sid);
  const display = (p: { name: string; steamId: string | null }) => p.name || (p.steamId ? `New player ${mask(p.steamId, streamer).slice(-6)}` : 'Unknown');

  const setList = async (list: 'admins' | 'bans', sid: string, add: boolean, who: string) => {
    if (list === 'bans' && add) {
      const r = await confirm({ title: `Ban ${who}?`, message: 'Adds their SteamID to banlist.txt – the server reloads it within seconds. They are kicked now if RCON is on.', confirm: 'Ban', danger: true });
      if (!r.ok) return;
    }
    try {
      await api.setAccess(id, list, sid, add);
      toast('success', `${who}: ${list === 'admins' ? (add ? 'now an admin' : 'admin removed') : add ? 'banned' : 'unbanned'}`, id);
      load();
    } catch (err) {
      toast('error', errMsg(err), id);
    }
  };
  const kick = async (p: OnlinePlayer) => {
    try {
      await api.kickPlayer(id, p.name);
      toast('success', `Kick sent for ${p.name}`, id);
    } catch (err) {
      toast('error', errMsg(err), id);
    }
  };
  const announce = async () => {
    if (!msg.trim()) return;
    setSending(true);
    try {
      await api.announce(id, msg);
      toast('success', 'Announced to everyone online', id);
      setMsg('');
    } catch (err) {
      toast('error', errMsg(err), id);
    } finally {
      setSending(false);
    }
  };
  const needle = q.trim().toLowerCase();
  const filteredKnown = known.filter((p) => !needle || p.name.toLowerCase().includes(needle));
  const filteredSessions = sessions.filter((s) => !needle || s.name.toLowerCase().includes(needle));
  const unnamed = running && st && st.queryPlayers != null && st.queryPlayers > st.players.length;

  return (
    <div className="mx-auto max-w-[1100px] space-y-5 p-6">
      <PageHeader
        title="Players"
        description="Who's online, everyone who has played here, and quick moderation."
        actions={
          <Button size="sm" icon={<RefreshCw className="size-3.5" />} onClick={load}>
            Refresh
          </Button>
        }
      />
      <div className="grid grid-cols-[1fr_380px] gap-4">
        <Section
          title={
            <span className="flex items-center gap-2">
              Online now <Badge tone={count ? 'ok' : 'neutral'}>{running ? `${count} / ${inst.config.maxConnectedUsers}` : 'offline'}</Badge>
            </span>
          }
          description={inst.config.listOnSteam ? 'Names and SteamIDs from the server log; the count comes from the server itself (Steam query).' : 'From the server log (the server answers Steam queries only while listed on Steam).'}
          icon={<Users />}
          bodyClassName="py-3"
        >
          {!running ? (
            <Empty title="Server offline" description="Start the server to see who's connected." className="py-8" />
          ) : st?.players.length || unnamed ? (
            <div className="space-y-2">
              {st!.players.map((p) => (
                <div key={p.steamId ?? p.name} className="flex items-center gap-2.5 rounded-lg border border-line bg-bg-raised px-3 py-2">
                  <Avatar name={display(p)} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5 truncate text-[12.5px] font-medium text-fg">
                      {display(p)}
                      {isAdmin(p.steamId) && <Crown className="size-3.5 text-gold" />}
                    </div>
                    <div className="selectable truncate font-mono text-[10.5px] text-fg-4">
                      <Clock className="mr-1 inline size-2.5" />
                      <Since ts={p.since} />
                      {p.steamId ? ` · ${mask(p.steamId, streamer)}` : ''}
                    </div>
                  </div>
                  {p.steamId && (
                    <IconButton label="Copy SteamID" onClick={() => copy(p.steamId!)}>
                      <Copy className="size-3.5" />
                    </IconButton>
                  )}
                  {p.steamId && (
                    <IconButton label="Open Steam profile" onClick={() => browse(steamProfile(p.steamId!))}>
                      <ExternalLink className="size-3.5" />
                    </IconButton>
                  )}
                  {p.steamId && (
                    <Button size="sm" variant="ghost" icon={<Crown className="size-3.5" />} onClick={() => setList('admins', p.steamId!, !isAdmin(p.steamId), display(p))}>
                      {isAdmin(p.steamId) ? 'Unadmin' : 'Admin'}
                    </Button>
                  )}
                  <Button size="sm" variant="ghost" icon={<UserX className="size-3.5" />} disabled={!inst.config.rconEnabled || !p.name} title={inst.config.rconEnabled ? 'Kick (sent through the server console)' : 'Needs RCON (Server Settings)'} onClick={() => kick(p)}>
                    Kick
                  </Button>
                  {p.steamId && (
                    <Button size="sm" variant="ghost" className="text-err" icon={<Ban className="size-3.5" />} onClick={() => setList('bans', p.steamId!, true, display(p))}>
                      Ban
                    </Button>
                  )}
                </div>
              ))}
              {unnamed && (
                <div className="rounded-lg border border-dashed border-line-strong px-3 py-2 text-[12px] text-fg-3">
                  +{st!.queryPlayers! - st!.players.length} more online – they joined before the manager was watching the log.
                </div>
              )}
            </div>
          ) : (
            <Empty title="Nobody online" description="Players show up here a few seconds after they join." className="py-8" />
          )}
        </Section>
        <Section title="This session" icon={<LogIn />} bodyClassName="py-2 max-h-[260px] overflow-y-auto">
          {events.length === 0 ? (
            <div className="py-6 text-center text-[12px] text-fg-4">No joins or leaves since the manager opened.</div>
          ) : (
            [...events].reverse().map((e, i) => (
              <div key={i} className="flex items-center gap-2.5 py-1.5 text-[12.5px]">
                {e.kind === 'join' ? <LogIn className="size-3.5 text-ok" /> : <LogOut className="size-3.5 text-fg-4" />}
                <span className="text-fg">{e.name}</span>
                <span className="text-fg-3">{e.kind === 'join' ? 'joined' : 'left'}</span>
                <span className="ml-auto font-mono text-[11px] text-fg-4">{clock(e.ts)}</span>
              </div>
            ))
          )}
        </Section>
      </div>

      <Section title="Announce" description="Send a message to everyone online (RCON announce)." icon={<Megaphone />} bodyClassName="py-3">
        {!inst.config.rconEnabled ? (
          <div className="text-[12px] text-fg-3">Turn on RCON under Server Settings to send announcements from here (it applies at the next start).</div>
        ) : (
          <div className="flex items-center gap-2">
            <Input value={msg} maxLength={240} onChange={(e) => setMsg(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && announce()} placeholder={running ? 'e.g. Castle siege event starts in 10 minutes!' : 'Start the server to announce'} disabled={!running} className="flex-1" />
            <Button variant="primary" size="md" icon={<Send className="size-3.5" />} loading={sending} disabled={!running || !msg.trim()} onClick={announce}>
              Announce
            </Button>
          </div>
        )}
      </Section>

      <Section
        title="History"
        description="Every player the manager has seen on this server, kept in its own database."
        icon={<History />}
        actions={
          <>
            <div className="relative w-56">
              <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-fg-4" />
              <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter by name" className="h-7 pl-8" />
            </div>
            <Segmented
              size="sm"
              value={tab}
              onChange={setTab}
              options={[
                { value: 'players', label: `Players (${known.length})` },
                { value: 'sessions', label: 'Sessions' },
              ]}
            />
          </>
        }
        bodyClassName="py-2"
      >
        {tab === 'players' ? (
          filteredKnown.length === 0 ? (
            <div className="py-6 text-center text-[12px] text-fg-4">Nobody yet – players are recorded as they join.</div>
          ) : (
            <table className="w-full text-[12.5px]">
              <thead>
                <tr className="text-left text-[10.5px] tracking-wide text-fg-4 uppercase">
                  <th className="py-2 font-medium">Player</th>
                  <th className="font-medium">SteamID</th>
                  <th className="font-medium">Sessions</th>
                  <th className="font-medium">Play time</th>
                  <th className="font-medium">First seen</th>
                  <th className="text-right font-medium">Last seen</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {filteredKnown.map((p) => {
                  const on = st?.players.some((x) => x.name === p.name || (!!p.steamId && x.steamId === p.steamId));
                  return (
                    <tr key={p.name}>
                      <td className="py-2">
                        <span className="flex items-center gap-2">
                          <Avatar name={p.name} />
                          <span className="font-medium text-fg">{p.name}</span>
                          {on && <Badge tone="ok">online</Badge>}
                          {isAdmin(p.steamId) && <Crown className="size-3.5 text-gold" />}
                          {isBanned(p.steamId) && <Badge tone="err">banned</Badge>}
                        </span>
                      </td>
                      <td className="selectable font-mono text-[11.5px] text-fg-3">
                        {p.steamId ? (
                          <span className="flex items-center gap-1">
                            {mask(p.steamId, streamer)}
                            <IconButton label="Copy SteamID" onClick={() => copy(p.steamId!)}>
                              <Copy className="size-3" />
                            </IconButton>
                            <IconButton label="Open Steam profile" onClick={() => browse(steamProfile(p.steamId!))}>
                              <ExternalLink className="size-3" />
                            </IconButton>
                          </span>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td className="font-mono text-fg-2">{p.sessions}</td>
                      <td className="font-mono text-fg-2">{duration(p.totalMs / 1000)}</td>
                      <td className="text-fg-3">{dateTime(p.firstSeen)}</td>
                      <td className="text-right text-fg-3">{on ? 'now' : ago(p.lastSeen)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )
        ) : filteredSessions.length === 0 ? (
          <div className="py-6 text-center text-[12px] text-fg-4">No sessions recorded yet.</div>
        ) : (
          <div className="max-h-[420px] divide-y divide-line overflow-y-auto">
            {filteredSessions.map((s) => (
              <div key={s.id} className="flex items-center gap-3 py-2 text-[12.5px]">
                <Avatar name={s.name} />
                <span className="font-medium text-fg">{s.name}</span>
                <span className="text-fg-3">{dateTime(s.joinedAt)}</span>
                <span className="ml-auto font-mono text-[11.5px] text-fg-2">{s.leftAt ? duration((s.leftAt - s.joinedAt) / 1000) : <Badge tone="ok">playing</Badge>}</span>
              </div>
            ))}
          </div>
        )}
      </Section>

      <Callout tone="info" title="How players are tracked">
        Joins and leaves come from the server log (“User … connected as ID …”), which carries each player’s SteamID and character name. A brand-new player has no character name
        until they create one. Kicks go through RCON’s server console (it gives no feedback); bans use banlist.txt and apply live.
      </Callout>
    </div>
  );
}
