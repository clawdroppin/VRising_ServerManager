import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { AlertTriangle, Check, CheckCircle2, ChevronDown, Copy, ExternalLink, Globe2, Loader2, Router, ShieldCheck, Wand2, Wifi, XCircle } from 'lucide-react';
import { cn } from '@/lib/cn';
import { api, errMsg } from '@/lib/ipc';
import { lanAddress, netInfo, serverPorts } from '@/lib/net';
import { browse, copy } from '@/lib/shell';
import type { FirewallState, NetInfo, SteamListing, UpnpInfo } from '@/lib/types';
import { useApp, useInstance } from '@/store/app';
import { Button } from '@/components/ui/Button';
import { Toggle } from '@/components/ui/Field';
import { Badge, Callout, Card, PageHeader, Section } from '@/components/ui/Surface';
import { useDraft } from '../draft';

/** Where the setting usually lives. Menus differ between firmware versions, so this is a hint. */
const ROUTERS: { brand: string; path: string }[] = [
  { brand: 'TP-Link', path: 'Advanced → NAT Forwarding → Virtual Servers → Add' },
  { brand: 'Netgear / Orbi', path: 'Advanced → Advanced Setup → Port Forwarding / Port Triggering → Add Custom Service' },
  { brand: 'ASUS', path: 'WAN → Virtual Server / Port Forwarding → Add profile' },
  { brand: 'Linksys', path: 'Security → Apps and Gaming → Single Port Forwarding' },
  { brand: 'Google / Nest Wifi', path: 'Google Home app → Wi-Fi → Settings → Advanced networking → Port management' },
  { brand: 'eero', path: 'eero app → Settings → Network settings → Reservations & port forwarding' },
  { brand: 'Xfinity / Comcast', path: 'Xfinity app → WiFi → View WiFi equipment → Advanced settings → Port forwarding' },
  { brand: 'AT&T', path: 'http://192.168.1.254 → Firewall → NAT/Gaming → Custom Services' },
  { brand: 'Spectrum', path: 'My Spectrum app → Services → Router → Advanced settings → Port forwarding' },
  { brand: 'BT Smart Hub', path: 'Advanced settings → Firewall → Port forwarding' },
  { brand: 'Virgin Media Hub', path: 'Advanced settings → Security → Port forwarding' },
  { brand: 'FRITZ!Box', path: 'Internet → Permit Access → Port Sharing → Add Device for Sharing' },
];

function CopyCell({ value }: { value: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      onClick={() => {
        copy(value);
        setDone(true);
        setTimeout(() => setDone(false), 1100);
      }}
      className="group inline-flex items-center gap-1.5 rounded px-1 font-mono text-fg hover:bg-hover"
      title="Copy"
    >
      {value}
      {done ? <Check className="size-3 text-ok" /> : <Copy className="size-3 text-fg-4 opacity-0 group-hover:opacity-100" />}
    </button>
  );
}

function Step({ n, title, done, children }: { n: number; title: ReactNode; done?: boolean | null; children: ReactNode }) {
  return (
    <div className="flex gap-4 py-4">
      <div
        className={cn(
          'flex size-7 shrink-0 items-center justify-center rounded-full border text-[12px] font-semibold',
          done ? 'border-ok/40 bg-ok/10 text-ok' : 'border-accent/40 bg-accent/10 text-accent',
        )}
      >
        {done ? <Check className="size-3.5" /> : n}
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-semibold text-fg">{title}</div>
        <div className="mt-1.5 text-[12.5px] leading-relaxed text-fg-2">{children}</div>
      </div>
    </div>
  );
}

function SteamCheck({ id, ports }: { id: string; ports: number[] }) {
  const [res, setRes] = useState<SteamListing[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const listed = res?.find((s) => ports.includes(s.gameport));
  return (
    <div className="mt-2.5 flex flex-wrap items-center gap-3 rounded-lg border border-line bg-bg-raised px-3 py-2">
      <Button
        size="sm"
        icon={<Wifi className="size-3.5" />}
        loading={busy}
        onClick={async () => {
          setBusy(true);
          setErr(null);
          try {
            setRes(await api.steamListing(id));
          } catch (e) {
            setErr(errMsg(e));
          } finally {
            setBusy(false);
          }
        }}
      >
        Ask Steam if it’s listed
      </Button>
      {err && <span className="text-[12px] text-err">{err}</span>}
      {res &&
        (listed ? (
          <span className="flex items-center gap-1.5 text-[12px] text-ok">
            <CheckCircle2 className="size-3.5" /> Listed at {listed.addr} – players can find it.
          </span>
        ) : (
          <span className="flex items-center gap-1.5 text-[12px] text-warn">
            <XCircle className="size-3.5" />
            {res.length ? `Steam knows ${res.length} other V Rising server(s) at your address, but not this one.` : 'Not listed (yet). It can take a minute after start – if it stays missing, check the firewall and the forward.'}
          </span>
        ))}
    </div>
  );
}

export function PortForwarding({ id }: { id: string }) {
  const inst = useInstance(id)!;
  const toast = useApp((s) => s.toast);
  const setView = useApp((s) => s.setView);
  const { draft, patch } = useDraft(id);
  const [net, setNet] = useState<NetInfo | null>(null);
  const [upnp, setUpnp] = useState<UpnpInfo | null>(null);
  const [fw, setFw] = useState<FirewallState | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [routersOpen, setRoutersOpen] = useState(false);

  const ports = serverPorts(inst);
  const lan = lanAddress(inst, net);

  const load = useCallback(async () => {
    netInfo().then(setNet).catch(() => {});
    api.firewallState(id).then(setFw).catch(() => {});
    setUpnp(null);
    api.upnpProbe().then(setUpnp).catch((e) => setUpnp({ found: false, gateway: null, routerName: null, manufacturer: null, model: null, externalIp: null, wanKind: 'unknown', mappings: [], error: errMsg(e) }));
  }, [id]);
  useEffect(() => {
    load();
  }, [load]);

  const act = async (what: 'map' | 'unmap' | 'firewall') => {
    setBusy(what);
    try {
      if (what === 'map') {
        const lines = await api.upnpMap(id);
        toast('success', lines.join(' · '), id);
      } else if (what === 'unmap') {
        await api.upnpUnmap(id);
        toast('success', 'Router port forwards removed', id);
      } else {
        await api.addFirewallRules(id);
        toast('success', 'Windows Firewall now allows the server', id);
      }
      await load();
    } catch (e) {
      toast('error', errMsg(e), id);
    } finally {
      setBusy(null);
    }
  };

  const mapped = (port: number) => upnp?.mappings.find((m) => m.externalPort === port);
  const allMappedHere = !!upnp?.found && ports.filter((p) => p.required).every((p) => mapped(p.port)?.internalClient === lan);
  const fwOk = fw ? (fw.portsOk || fw.programRule) && fw.blockedBy.length === 0 : null;
  const gateway = upnp?.gateway ?? net?.gateway ?? null;

  // NAT diagnosis: the router's WAN address vs the address the internet sees.
  let nat: { tone: 'ok' | 'warn' | 'err'; title: string; text: ReactNode } | null = null;
  if (upnp?.found && upnp.externalIp) {
    if (upnp.wanKind === 'cgnat') {
      nat = {
        tone: 'err',
        title: 'Your ISP uses carrier-grade NAT (CGNAT)',
        text: (
          <>
            Your router’s internet address <span className="font-mono">{upnp.externalIp}</span> is shared by the ISP, so port forwarding on your router can’t reach you. Ask your ISP for a public (or static) IPv4 address – many do it for free – or use a tunnelling service such as playit.gg or a VPS. (Players on Steam can sometimes still connect through Steam’s relay network.)
          </>
        ),
      };
    } else if (upnp.wanKind === 'private') {
      nat = {
        tone: 'warn',
        title: 'Double NAT – there is another router in front of this one',
        text: (
          <>
            This router’s internet address <span className="font-mono">{upnp.externalIp}</span> is a private address, so another device (often the ISP modem) sits in front of it. Either put the ISP modem in <b className="text-fg">bridge / modem mode</b>, or forward the same ports on <b className="text-fg">both</b> devices (the outer one to this router’s address).
          </>
        ),
      };
    } else if (net?.publicIp && upnp.externalIp !== net.publicIp) {
      nat = {
        tone: 'warn',
        title: 'Your public address differs from the router’s',
        text: (
          <>
            The router reports <span className="font-mono">{upnp.externalIp}</span> but the internet sees <span className="font-mono">{net.publicIp}</span> – there is NAT beyond your router (or a VPN is active on this PC). Forwarding may not be enough; check with your ISP and turn off VPNs while hosting.
          </>
        ),
      };
    } else {
      nat = { tone: 'ok', title: 'Direct internet connection', text: <>Your router holds the public address <span className="font-mono">{upnp.externalIp}</span> – port forwarding will work.</> };
    }
  }

  return (
    <div className="mx-auto max-w-[1000px] space-y-5 p-6 pb-24">
      <PageHeader
        title="Port Forwarding"
        description="Players outside your home network can only join if your router passes these UDP ports to this PC. Friends on the same Wi-Fi don’t need it."
        actions={
          <Button size="sm" icon={busy ? <Loader2 className="size-3.5 animate-spin" /> : <Wifi className="size-3.5" />} onClick={load}>
            Re-check
          </Button>
        }
      />

      <Section title="What to forward" icon={<Globe2 />} description="V Rising binds two UDP ports: game (9876) and query (9877). A second server on this PC uses the next free pair (9886/9887 …). RCON is TCP and only needs forwarding for remote admin." bodyClassName="py-2">
        <table className="w-full text-left text-[12.5px]">
          <thead className="text-[11px] tracking-wide text-fg-4 uppercase">
            <tr>
              <th className="py-2 font-medium">Service</th>
              <th className="py-2 font-medium">Protocol</th>
              <th className="py-2 font-medium">External & internal port</th>
              <th className="py-2 font-medium">Forward to (this PC)</th>
              <th className="py-2 text-right font-medium">Router status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {ports.map((p) => {
              const m = mapped(p.port);
              return (
                <tr key={p.port}>
                  <td className="py-3">
                    <div className="font-medium text-fg">
                      {p.label} {!p.required && <span className="text-fg-4">(optional)</span>}
                    </div>
                    <div className="text-[11.5px] text-fg-4">{p.purpose}</div>
                  </td>
                  <td className="py-3">
                    <Badge tone={p.protocol === 'UDP' ? 'info' : 'neutral'}>{p.protocol}</Badge>
                  </td>
                  <td className="py-3">
                    <CopyCell value={String(p.port)} />
                  </td>
                  <td className="py-3">{lan ? <CopyCell value={lan} /> : <span className="text-fg-4">detecting…</span>}</td>
                  <td className="py-3 text-right">
                    {!upnp ? (
                      <span className="text-fg-4">…</span>
                    ) : !upnp.found ? (
                      <span className="text-[11.5px] text-fg-4">unknown (no UPnP)</span>
                    ) : m ? (
                      m.internalClient === lan ? (
                        <Badge tone="ok">
                          <CheckCircle2 /> Forwarded here
                        </Badge>
                      ) : (
                        <Badge tone="err" className="max-w-full">
                          <XCircle /> Points to {m.internalClient}
                        </Badge>
                      )
                    ) : (
                      <Badge tone="warn">Not forwarded</Badge>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <div className="border-t border-line py-2.5 text-[11.5px] text-fg-4">
          Use the same number for external and internal port. TCP is not needed. Players can often still join without forwarding through Steam’s relay network, but a forwarded port gives the best connection and makes the server show up reliably.
        </div>
      </Section>

      {nat && (
        <Callout tone={nat.tone === 'ok' ? 'ok' : nat.tone === 'warn' ? 'warn' : 'err'} title={nat.title}>
          {nat.text}
        </Callout>
      )}

      <Section
        title={
          <span className="flex items-center gap-2">
            Automatic (UPnP)
            {upnp?.found && <Badge tone="ok">Router found</Badge>}
            {upnp && !upnp.found && <Badge tone="warn">Not available</Badge>}
          </span>
        }
        description="Most home routers can open ports on request. One click, no router login."
        icon={<Wand2 />}
        bodyClassName="py-4 space-y-4"
      >
        {!upnp ? (
          <div className="flex items-center gap-2 text-[12.5px] text-fg-3">
            <Loader2 className="size-4 animate-spin" /> Looking for your router…
          </div>
        ) : upnp.found ? (
          <>
            <div className="grid grid-cols-3 gap-3 text-[12.5px]">
              <div className="rounded-lg border border-line bg-bg-raised px-3 py-2">
                <div className="text-[10.5px] tracking-wide text-fg-4 uppercase">Router</div>
                <div className="truncate text-fg">{[upnp.manufacturer, upnp.routerName ?? upnp.model].filter(Boolean).join(' ') || 'Unknown model'}</div>
              </div>
              <div className="rounded-lg border border-line bg-bg-raised px-3 py-2">
                <div className="text-[10.5px] tracking-wide text-fg-4 uppercase">Router address</div>
                <div className="font-mono text-fg">{upnp.gateway}</div>
              </div>
              <div className="rounded-lg border border-line bg-bg-raised px-3 py-2">
                <div className="text-[10.5px] tracking-wide text-fg-4 uppercase">Internet address</div>
                <div className="font-mono text-fg">{upnp.externalIp ?? '—'}</div>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="primary" icon={<Wand2 className="size-3.5" />} loading={busy === 'map'} onClick={() => act('map')}>
                {allMappedHere ? 'Refresh port forwards' : 'Forward ports automatically'}
              </Button>
              {ports.some((p) => mapped(p.port)) && (
                <Button variant="ghost" loading={busy === 'unmap'} onClick={() => act('unmap')}>
                  Remove forwards
                </Button>
              )}
              <label className="ml-auto flex items-center gap-2.5 text-[12.5px] text-fg-2">
                Re-apply every time the server starts
                <Toggle checked={draft.launch.upnp} onChange={(v) => patch((d) => void (d.launch.upnp = v))} />
              </label>
            </div>
            {draft.launch.upnp !== inst.launch.upnp && <div className="text-[11.5px] text-accent">Save (Ctrl+S) to keep this setting.</div>}
          </>
        ) : (
          <Callout tone="warn" title="Your router didn’t answer UPnP">
            {upnp.error ?? 'UPnP may be turned off.'} You can switch UPnP on in the router settings (often under Advanced → UPnP), or forward the ports by hand with the steps below.
          </Callout>
        )}
      </Section>

      <Section title="Manual setup" icon={<Router />} description="If UPnP isn’t available – or you prefer a permanent rule – set it up once in your router." bodyClassName="divide-y divide-line">
        <Step n={1} title="Give this PC a fixed LAN address">
          In the router’s <b className="text-fg">DHCP / LAN</b> settings, reserve <span className="font-mono text-fg">{lan ?? 'this PC’s address'}</span> for this computer (often called “Address reservation” or “Static lease”). Otherwise the forward breaks when the address changes.
        </Step>
        <Step n={2} title="Open your router’s settings">
          <div className="flex flex-wrap items-center gap-2">
            {gateway ? (
              <>
                Go to
                <Button size="sm" icon={<ExternalLink className="size-3.5" />} onClick={() => browse(`http://${gateway}`)}>
                  http://{gateway}
                </Button>
                and sign in (the password is often on a sticker on the router, or use the router’s phone app).
              </>
            ) : (
              <>Open your router’s admin page (usually http://192.168.0.1 or http://192.168.1.1) and sign in.</>
            )}
          </div>
        </Step>
        <Step n={3} title="Add a port-forward rule for each port">
          Look for <b className="text-fg">Port Forwarding</b>, <b className="text-fg">Virtual Server</b>, <b className="text-fg">NAT</b> or <b className="text-fg">Gaming</b>. Create:
          <div className="mt-2 overflow-hidden rounded-lg border border-line">
            <table className="w-full text-[12px]">
              <thead className="bg-bg-raised/60 text-[10.5px] tracking-wide text-fg-4 uppercase">
                <tr>
                  <th className="px-3 py-1.5 text-left font-medium">Name</th>
                  <th className="px-3 py-1.5 text-left font-medium">Protocol</th>
                  <th className="px-3 py-1.5 text-left font-medium">External port</th>
                  <th className="px-3 py-1.5 text-left font-medium">Internal port</th>
                  <th className="px-3 py-1.5 text-left font-medium">Device / IP</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {ports
                  .filter((p) => p.required)
                  .map((p) => (
                    <tr key={p.port}>
                      <td className="px-3 py-1.5">
                        <CopyCell value={`V Rising ${p.label} ${p.port}`} />
                      </td>
                      <td className="px-3 py-1.5 font-mono">{p.protocol}</td>
                      <td className="px-3 py-1.5">
                        <CopyCell value={String(p.port)} />
                      </td>
                      <td className="px-3 py-1.5">
                        <CopyCell value={String(p.port)} />
                      </td>
                      <td className="px-3 py-1.5">{lan ? <CopyCell value={lan} /> : '—'}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
          <button onClick={() => setRoutersOpen(!routersOpen)} className="mt-3 flex items-center gap-1.5 text-[12px] text-accent hover:underline">
            <ChevronDown className={cn('size-3.5 transition-transform', routersOpen && 'rotate-180')} /> Where is it on my router?
          </button>
          {routersOpen && (
            <div className="mt-2 grid grid-cols-2 gap-x-6 gap-y-1.5 rounded-lg border border-line bg-bg-raised/60 p-3 text-[12px]">
              {ROUTERS.map((r) => (
                <div key={r.brand}>
                  <span className="font-medium text-fg">{r.brand}:</span> <span className="text-fg-3">{r.path}</span>
                </div>
              ))}
              <div className="col-span-2 pt-1 text-[11px] text-fg-4">Menus vary by firmware – if it isn’t there, search your router model + “port forwarding”.</div>
            </div>
          )}
        </Step>
        <Step n={4} title="Allow the server through Windows Firewall" done={fwOk}>
          {fwOk ? (
            'An inbound rule already allows the server.'
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              {fw?.blockedBy.length ? <span className="text-err">A Windows Block rule is stopping the server.</span> : 'No inbound rule yet.'}
              <Button size="sm" variant="primary" icon={<ShieldCheck className="size-3.5" />} loading={busy === 'firewall'} onClick={() => act('firewall')}>
                {fw?.blockedBy.length ? 'Unblock & allow' : 'Allow through firewall'}
              </Button>
            </div>
          )}
        </Step>
        <Step n={5} title="Test it">
          Start the server and check that Steam lists it – the in-game server browser comes from Steam’s server list. Then ask a friend on a <b className="text-fg">different</b> network to open Online Play → Find Servers and search <b className="font-mono text-fg">{inst.config.name}</b>.
          <SteamCheck id={id} ports={[inst.config.port, inst.config.queryPort]} />
          <div className="mt-2 flex items-center gap-1.5 text-[11.5px] text-fg-4">
            <AlertTriangle className="size-3.5" /> Testing from your own PC through your public address often fails even when forwarding works (many routers don’t support “NAT loopback”).
          </div>
        </Step>
      </Section>

      <Card className="flex items-center justify-between gap-4 p-4 text-[12.5px] text-fg-3">
        Changing the port? Set it under Server Settings → Network, then update the forward and firewall rule here.
        <Button size="sm" onClick={() => setView(id, 'settings')}>
          Server Settings
        </Button>
      </Card>
    </div>
  );
}
