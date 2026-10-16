import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { cn } from '@/lib/cn';
import { clock } from '@/lib/format';

/** Series colors – validated with the dataviz validator on the dark surface #0e1319 (CVD ΔE 12.5, normal 24.3, lightness band OK). */
export const SERIES = ['#e5485a', '#8b7cf6'] as const;
export const SINGLE = '#e5485a';

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [w, setW] = useState(0);
  useLayoutEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([e]) => setW(Math.floor(e.contentRect.width)));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

function niceMax(v: number) {
  if (v <= 0) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  const n = v / p;
  const m = n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10;
  return m * p;
}

export interface Series {
  name: string;
  values: number[];
  color?: string;
}

/**
 * Live time-series area/line chart with a crosshair tooltip. One y-scale only; two series share
 * a unit (e.g. read vs write bytes/s).
 */
/** Bucket long series to ~one point per pixel, keeping each bucket's peak so spikes survive. */
function downsample(ts: number[], series: Series[], target: number): { ts: number[]; series: Series[] } {
  const n = ts.length;
  if (target <= 0 || n <= target) return { ts, series };
  const step = n / target;
  const outTs: number[] = [];
  const outVals = series.map(() => [] as number[]);
  for (let b = 0; b < target; b++) {
    const from = Math.floor(b * step);
    const to = Math.min(n, Math.floor((b + 1) * step));
    outTs.push(ts[to - 1]);
    series.forEach((s, si) => {
      let m = 0;
      for (let i = from; i < to; i++) if ((s.values[i] ?? 0) > m) m = s.values[i];
      outVals[si].push(m);
    });
  }
  return { ts: outTs, series: series.map((s, si) => ({ ...s, values: outVals[si] })) };
}

export function LiveChart({
  ts: rawTs,
  series: rawSeries,
  height = 160,
  format,
  max: fixedMax,
  className,
  timeFormat = clock,
}: {
  ts: number[];
  series: Series[];
  height?: number;
  format: (v: number) => string;
  max?: number;
  className?: string;
  /** Axis / tooltip time label (default HH:MM:SS). */
  timeFormat?: (ts: number) => string;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const padL = 68;
  const padR = 8;
  const padT = 8;
  const padB = 20;
  const w = Math.max(0, width - padL - padR);
  const h = height - padT - padB;
  const { ts, series } = useMemo(() => downsample(rawTs, rawSeries, Math.floor(w / 1.5)), [rawTs, rawSeries, w]);
  const n = ts.length;

  const yMax = useMemo(() => {
    if (fixedMax != null) return fixedMax;
    let m = 0;
    for (const s of series) for (const v of s.values) if (v > m) m = v;
    return niceMax(m * 1.1);
  }, [series, fixedMax]);

  const x = (i: number) => padL + (n <= 1 ? w : (i / (n - 1)) * w);
  const y = (v: number) => padT + h - (Math.min(v, yMax) / yMax) * h;

  const paths = series.map((s, si) => {
    if (n === 0) return { line: '', area: '', color: s.color ?? SERIES[si] ?? SINGLE };
    let line = '';
    for (let i = 0; i < n; i++) line += `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(s.values[i] ?? 0).toFixed(1)}`;
    const area = `${line}L${x(n - 1).toFixed(1)},${padT + h}L${x(0).toFixed(1)},${padT + h}Z`;
    return { line, area, color: s.color ?? (series.length === 1 ? SINGLE : SERIES[si]) };
  });

  const ticks = [0, 0.5, 1].map((f) => yMax * f);
  const hi = hover != null && n > 0 ? Math.min(n - 1, Math.max(0, hover)) : null;

  return (
    <div ref={ref} className={cn('relative w-full select-none', className)} style={{ height }}>
      {width > 0 && (
        <svg
          width={width}
          height={height}
          className="block"
          onMouseMove={(e) => {
            const r = (e.currentTarget as SVGElement).getBoundingClientRect();
            const px = e.clientX - r.left - padL;
            if (n < 1 || px < -4) return setHover(null);
            setHover(Math.round((px / Math.max(1, w)) * (n - 1)));
          }}
          onMouseLeave={() => setHover(null)}
        >
          <defs>
            {paths.map((p, i) => (
              <linearGradient key={i} id={`g-${i}-${p.color.slice(1)}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" stopColor={p.color} stopOpacity={series.length > 1 ? 0.16 : 0.28} />
                <stop offset="1" stopColor={p.color} stopOpacity="0" />
              </linearGradient>
            ))}
          </defs>
          {ticks.map((t, i) => (
            <g key={i}>
              <line x1={padL} x2={padL + w} y1={y(t)} y2={y(t)} stroke="#1d2731" strokeDasharray={i === 0 ? undefined : '2 4'} />
              <text x={padL - 8} y={y(t) + 3.5} textAnchor="end" className="fill-fg-4 font-mono text-[10px]">
                {format(t)}
              </text>
            </g>
          ))}
          {n > 1 && (
            <>
              <text x={padL} y={height - 5} className="fill-fg-4 font-mono text-[10px]">
                {timeFormat(ts[0])}
              </text>
              <text x={padL + w} y={height - 5} textAnchor="end" className="fill-fg-4 font-mono text-[10px]">
                {timeFormat(ts[n - 1])}
              </text>
            </>
          )}
          {paths.map((p, i) => (
            <g key={i}>
              <path d={p.area} fill={`url(#g-${i}-${p.color.slice(1)})`} />
              <path d={p.line} fill="none" stroke={p.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
            </g>
          ))}
          {hi != null && (
            <g>
              <line x1={x(hi)} x2={x(hi)} y1={padT} y2={padT + h} stroke="#74838f" strokeOpacity={0.5} />
              {series.map((s, si) => (
                <circle key={si} cx={x(hi)} cy={y(s.values[hi] ?? 0)} r={4} fill={paths[si].color} stroke="#0e1319" strokeWidth={2} />
              ))}
            </g>
          )}
        </svg>
      )}
      {hi != null && width > 0 && (
        <div
          className="pointer-events-none absolute top-1 z-10 min-w-32 rounded-lg border border-line-strong bg-panel-2/95 px-2.5 py-1.5 shadow-pop"
          style={{ left: Math.min(width - 150, Math.max(padL, x(hi) + 10)) }}
        >
          <div className="font-mono text-[10.5px] text-fg-3">{timeFormat(ts[hi])}</div>
          {series.map((s, si) => (
            <div key={si} className="mt-0.5 flex items-center gap-2 text-[11.5px]">
              <span className="size-2 rounded-full" style={{ background: paths[si].color }} />
              <span className="text-fg-3">{s.name}</span>
              <span className="ml-auto font-mono text-fg tabular-nums">{format(s.values[hi] ?? 0)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function Legend({ items }: { items: { name: string; color: string; value?: string }[] }) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
      {items.map((it) => (
        <div key={it.name} className="flex items-center gap-1.5 text-[11.5px] text-fg-3">
          <span className="size-2 rounded-full" style={{ background: it.color }} />
          {it.name}
          {it.value && <span className="font-mono text-fg tabular-nums">{it.value}</span>}
        </div>
      ))}
    </div>
  );
}

/** Tiny trend line for stat tiles (no axes). */
export function Sparkline({
  values,
  max,
  height = 32,
  color = SINGLE,
  className,
  fit,
}: {
  values: number[];
  max?: number;
  height?: number;
  color?: string;
  className?: string;
  /** Scale to the data's own range instead of from zero (for slow-moving values like memory). */
  fit?: boolean;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const n = values.length;
  let lo = 0;
  let m = max ?? Math.max(1e-9, ...values) * 1.15;
  if (fit && n > 1) {
    const vmin = Math.min(...values);
    const vmax = Math.max(...values);
    const pad = Math.max((vmax - vmin) * 0.25, vmax * 0.02, 1e-9);
    lo = Math.max(0, vmin - pad);
    m = vmax + pad;
  }
  const span = Math.max(1e-9, m - lo);
  const pts = values.map((v, i) => `${n <= 1 ? width : (i / (n - 1)) * width},${height - 1 - ((Math.min(v, m) - lo) / span) * (height - 3)}`);
  const id = useMemo(() => `sp-${Math.random().toString(36).slice(2)}`, []);
  return (
    <div ref={ref} className={cn('w-full', className)} style={{ height }}>
      {width > 0 && n > 1 && (
        <svg width={width} height={height} className="block overflow-visible">
          <defs>
            <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor={color} stopOpacity="0.3" />
              <stop offset="1" stopColor={color} stopOpacity="0" />
            </linearGradient>
          </defs>
          <path d={`M${pts.join('L')}L${width},${height}L0,${height}Z`} fill={`url(#${id})`} />
          <polyline points={pts.join(' ')} fill="none" stroke={color} strokeWidth={1.75} strokeLinejoin="round" strokeLinecap="round" />
        </svg>
      )}
    </div>
  );
}

/** Ring gauge for a single 0–100 % value. */
export function Gauge({ value, size = 64, label, sub }: { value: number; size?: number; label?: string; sub?: string }) {
  const r = size / 2 - 5;
  const c = 2 * Math.PI * r;
  const v = Math.max(0, Math.min(100, value));
  const color = v > 90 ? '#f87171' : v > 75 ? '#facc15' : SINGLE;
  return (
    <div className="flex items-center gap-3">
      <div className="relative" style={{ width: size, height: size }}>
        <svg width={size} height={size} className="-rotate-90">
          <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="#1d2731" strokeWidth={5} />
          <circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            stroke={color}
            strokeWidth={5}
            strokeLinecap="round"
            strokeDasharray={c}
            strokeDashoffset={c * (1 - v / 100)}
            style={{ transition: 'stroke-dashoffset 400ms ease, stroke 300ms' }}
          />
        </svg>
        <div className="absolute inset-0 flex items-center justify-center font-mono text-[12.5px] font-semibold text-fg tabular-nums">{Math.round(v)}%</div>
      </div>
      {(label || sub) && (
        <div className="min-w-0">
          <div className="text-[12px] font-medium text-fg-2">{label}</div>
          {sub && <div className="mt-0.5 font-mono text-[11px] text-fg-4">{sub}</div>}
        </div>
      )}
    </div>
  );
}

/** Per-core usage as a strip of cells (sequential single hue). */
export function CoreGrid({ values }: { values: number[] }) {
  return (
    <div className="grid gap-1" style={{ gridTemplateColumns: `repeat(${Math.min(16, Math.max(4, values.length))}, minmax(0,1fr))` }}>
      {values.map((v, i) => (
        <div
          key={i}
          title={`Core ${i}: ${v.toFixed(0)}%`}
          className="h-5 rounded-[4px] border border-line"
          style={{ background: `color-mix(in oklab, #e5485a ${Math.round(Math.max(4, Math.min(100, v)))}%, #1a1115)` }}
        />
      ))}
    </div>
  );
}
