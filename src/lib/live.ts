// High-frequency data (telemetry samples, console lines) lives outside React state in ring
// buffers; components subscribe per key and re-render only for what they show.
import { useSyncExternalStore } from 'react';
import type { ProcSample, SystemSample } from './types';

type Fn = () => void;

class Channel {
  private subs = new Map<string, Set<Fn>>();
  private versions = new Map<string, number>();
  sub(key: string, fn: Fn) {
    const s = this.subs.get(key) ?? new Set();
    this.subs.set(key, s);
    s.add(fn);
    return () => {
      s.delete(fn);
    };
  }
  bump(key: string) {
    this.versions.set(key, (this.versions.get(key) ?? 0) + 1);
    this.subs.get(key)?.forEach((f) => f());
  }
  version(key: string) {
    return this.versions.get(key) ?? 0;
  }
}

// ---------------------------------------------------------------- telemetry

export const HISTORY = 3600; // samples kept per server (1 h at 1 s)

export interface Point extends ProcSample {
  ts: number;
}
export interface SysPoint extends SystemSample {
  ts: number;
}

const tele = new Channel();
const serverHist = new Map<string, Point[]>();
let sysHist: SysPoint[] = [];
const EMPTY: Point[] = [];

export function pushTelemetry(ts: number, system: SystemSample, servers: ProcSample[]) {
  sysHist = [...sysHist.slice(-(HISTORY - 1)), { ...system, ts }];
  const seen = new Set<string>();
  for (const s of servers) {
    seen.add(s.id);
    const h = serverHist.get(s.id) ?? [];
    serverHist.set(s.id, [...h.slice(-(HISTORY - 1)), { ...s, ts }]);
    tele.bump(s.id);
  }
  // Servers that stopped: add a zero sample so charts drop instead of freezing.
  for (const [id, h] of serverHist) {
    if (!seen.has(id) && h.length && h[h.length - 1].mem !== 0) {
      serverHist.set(id, [...h.slice(-(HISTORY - 1)), { id, ts, cpu: 0, mem: 0, virt: 0, readBps: 0, writeBps: 0, uptime: 0 }]);
      tele.bump(id);
    }
  }
  tele.bump('__system');
}

export function useServerHistory(id: string): Point[] {
  return useSyncExternalStore(
    (fn) => tele.sub(id, fn),
    () => serverHist.get(id) ?? EMPTY,
  );
}

export function useSystemHistory(): SysPoint[] {
  return useSyncExternalStore(
    (fn) => tele.sub('__system', fn),
    () => sysHist,
  );
}

export function latest(id: string): Point | undefined {
  const h = serverHist.get(id);
  return h?.[h.length - 1];
}

// ---------------------------------------------------------------- console

export interface LogLine {
  n: number;
  ts: number;
  source: string;
  text: string;
}

const MAX_LINES = 8000;
const logs = new Channel();
const logBuf = new Map<string, LogLine[]>();
const EMPTY_LINES: LogLine[] = [];
let seq = 0;

export function pushLines(id: string, source: string, lines: string[], ts: number) {
  const prev = logBuf.get(id) ?? [];
  const add = lines.map((text) => ({ n: ++seq, ts, source, text }));
  const next = prev.length + add.length > MAX_LINES ? [...prev, ...add].slice(-MAX_LINES) : [...prev, ...add];
  logBuf.set(id, next);
  logs.bump(id);
}

const seeded = new Set<string>();

/** Put the tail of the log file in front of whatever streamed in live (once per server). */
export function seedLines(id: string, lines: string[], ts = Date.now()) {
  if (seeded.has(id)) return;
  seeded.add(id);
  const live = logBuf.get(id) ?? [];
  // Drop file lines the live stream already delivered.
  const liveText = new Set(live.filter((l) => l.source === 'server').map((l) => l.text));
  const head = lines.filter((t) => !liveText.has(t)).map((text) => ({ n: ++seq, ts, source: 'server', text }));
  logBuf.set(id, [...head, ...live].slice(-MAX_LINES));
  logs.bump(id);
}

export function clearLines(id: string) {
  logBuf.set(id, []);
  logs.bump(id);
}

export function useLogLines(id: string): LogLine[] {
  return useSyncExternalStore(
    (fn) => logs.sub(id, fn),
    () => logBuf.get(id) ?? EMPTY_LINES,
  );
}

export type LineLevel = 'error' | 'warn' | 'display' | 'log';

/** Severity of a V Rising log line. Unity logs carry no level prefix, so this goes by wording. */
export function lineLevel(text: string): LineLevel {
  if (/Exception|Exiting!|Error parsing|Address already in use|^\s*Error\b|failed to connect/i.test(text)) return 'error';
  if (/^Warning|Unable to |Couldn't|Could not |deprecated|Timed out/i.test(text)) return 'warn';
  if (/Startup Completed|User '.+' (?:'|disconnected)|Finished Saving|SaveOnExit|OnApplicationQuit|Boot Time|connected to Steam|\[rcon\]|\[FileUserList\]|^RCON[>:]|^Announced/.test(text)) return 'display';
  return 'log';
}

/** Engine chatter that buries the useful lines (chunk streaming, prefab registration, archetype dumps). */
export function isNoise(text: string): boolean {
  return /^(Streamed scene|\[Server\] (Loaded|Request Load) Chunk|\[Server\] Registering|\[Server\] LoadSceneSystem|\[Server\] LoadSceneAsync|Loading GameData SubScene|Removing SceneTags|Instantiating SingletonPrefab|Registered WarEventMapNode|Spawn Script_|\* |#\d+: Entity|Resized NetBuffer|\s+(Peak|Requested|Used|Large|\[ALLOC))/.test(text);
}
