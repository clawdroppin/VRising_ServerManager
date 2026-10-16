// Shared network helpers and a short-lived cache for slow lookups.
import { api } from './ipc';
import type { NetInfo, ServerInstance } from './types';

export interface PortRow {
  port: number;
  label: string;
  purpose: string;
  required: boolean;
  protocol: 'UDP' | 'TCP';
}

/** Every port the server binds (verified with netstat: UDP game + query; TCP RCON/API when on). */
export function serverPorts(inst: ServerInstance): PortRow[] {
  const rows: PortRow[] = [
    { port: inst.config.port, label: 'Game', purpose: 'Player traffic – forward it so players can connect', required: true, protocol: 'UDP' },
    { port: inst.config.queryPort, label: 'Query', purpose: 'Steam server browser and player count', required: true, protocol: 'UDP' },
  ];
  if (inst.config.rconEnabled) rows.push({ port: inst.config.rconPort, label: 'RCON', purpose: 'Remote admin – only forward it if you administer from outside your network', required: false, protocol: 'TCP' });
  if (inst.config.apiEnabled) rows.push({ port: inst.config.apiPort, label: 'HTTP API', purpose: 'Metrics endpoint – usually keep it local', required: false, protocol: 'TCP' });
  return rows;
}

let netCache: { at: number; value: Promise<NetInfo> } | null = null;

/** Public IP + LAN addresses + gateway, cached for 5 minutes (the public IP lookup is an HTTP call). */
export function netInfo(force = false): Promise<NetInfo> {
  if (!force && netCache && Date.now() - netCache.at < 300_000) return netCache.value;
  const value = api.netInfo().catch((e) => {
    netCache = null;
    throw e;
  });
  netCache = { at: Date.now(), value };
  return value;
}

/** The LAN address players' traffic should be forwarded to. */
export function lanAddress(inst: ServerInstance, net: NetInfo | null): string | null {
  if (inst.config.address && inst.config.address !== '0.0.0.0') return inst.config.address;
  return net?.local[0]?.ip ?? null;
}
