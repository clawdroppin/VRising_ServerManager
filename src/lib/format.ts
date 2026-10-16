export function bytes(n: number | null | undefined, digits = 1): string {
  if (n == null || !isFinite(n)) return '–';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(i === 0 ? 0 : digits)} ${u[i]}`;
}

export function rate(n: number | null | undefined): string {
  if (n == null) return '–';
  return `${bytes(n)}/s`;
}

export function pct(n: number | null | undefined, digits = 0): string {
  if (n == null || !isFinite(n)) return '–';
  return `${n.toFixed(digits)}%`;
}

export function duration(secs: number): string {
  if (!isFinite(secs) || secs < 0) return '–';
  const d = Math.floor(secs / 86400);
  const h = Math.floor((secs % 86400) / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = Math.floor(secs % 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function inFuture(s: number): string {
  if (s < 60) return `in ${s}s`;
  if (s < 3600) return `in ${Math.floor(s / 60)}m`;
  if (s < 86400) return `in ${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  return `in ${Math.floor(s / 86400)}d`;
}

export function ago(ts: number | null | undefined, now = Date.now()): string {
  if (!ts) return 'never';
  const s = Math.round((now - ts) / 1000);
  if (s < 0) return inFuture(-s);
  if (s < 10) return 'just now';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function until(ts: number, now = Date.now()): string {
  return inFuture(Math.max(0, Math.round((ts - now) / 1000)));
}

export function dateTime(ts: number | null | undefined): string {
  if (!ts) return '–';
  return new Date(ts).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

export function clock(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function plural(n: number, word: string, many?: string) {
  return `${n} ${n === 1 ? word : (many ?? word + 's')}`;
}

/** Random password from an unambiguous alphabet. */
export function generatePassword(len = 16): string {
  const a = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  const buf = new Uint32Array(len);
  crypto.getRandomValues(buf);
  return Array.from(buf, (x) => a[x % a.length]).join('');
}

/** Mask a value in streamer mode (keeps the shape so layouts don't jump). */
export function mask(v: string | null | undefined, on: boolean): string {
  if (!v) return '–';
  if (!on) return v;
  return v.replace(/[0-9A-Za-z]/g, '•');
}

/** Nanoseconds (the game's duration unit) → minutes. */
export const nsToMin = (ns: number) => ns / 60_000_000_000;
export const minToNs = (m: number) => Math.round(m * 60) * 1_000_000_000;
