import type { ReactNode } from 'react';
import { AlertTriangle, CheckCircle2, Info, XCircle } from 'lucide-react';
import { cn } from '@/lib/cn';
import type { ServerState } from '@/lib/types';

export function Card({ children, className, interactive, onClick }: { children: ReactNode; className?: string; interactive?: boolean; onClick?: () => void }) {
  return (
    <div
      onClick={onClick}
      className={cn(
        'rounded-xl border border-line bg-panel',
        interactive && 'transition-[border,background,transform] duration-150 hover:border-line-strong hover:bg-panel-2',
        className,
      )}
    >
      {children}
    </div>
  );
}

export function Section({
  title,
  description,
  icon,
  actions,
  children,
  className,
  bodyClassName,
}: {
  title: ReactNode;
  description?: ReactNode;
  icon?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <Card className={cn('overflow-hidden', className)}>
      <div className="flex items-start gap-3 border-b border-line px-5 py-3.5">
        {icon && <div className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg bg-accent-dim/60 text-accent [&_svg]:size-4">{icon}</div>}
        <div className="min-w-0 flex-1">
          <div className="text-[13.5px] font-semibold text-fg">{title}</div>
          {description && <div className="mt-0.5 text-[12px] leading-relaxed text-fg-3">{description}</div>}
        </div>
        {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </div>
      <div className={cn('px-5', bodyClassName)}>{children}</div>
    </Card>
  );
}

type Tone = 'neutral' | 'accent' | 'ok' | 'warn' | 'err' | 'info' | 'violet';
const tones: Record<Tone, string> = {
  neutral: 'bg-panel-2 text-fg-2 border-line-strong',
  accent: 'bg-accent/10 text-accent border-accent/25',
  ok: 'bg-ok/10 text-ok border-ok/25',
  warn: 'bg-warn/10 text-warn border-warn/25',
  err: 'bg-err/10 text-err border-err/25',
  info: 'bg-info/10 text-info border-info/25',
  violet: 'bg-violet/10 text-violet border-violet/25',
};

export function Badge({ children, tone = 'neutral', className, title }: { children: ReactNode; tone?: Tone; className?: string; title?: string }) {
  return (
    <span title={title} className={cn('inline-flex h-5 items-center gap-1 rounded-md border px-1.5 text-[11px] font-medium whitespace-nowrap [&_svg]:size-3', tones[tone], className)}>
      {children}
    </span>
  );
}

export const STATE_META: Record<ServerState, { label: string; tone: Tone; dot: string; pulse?: boolean }> = {
  notInstalled: { label: 'Not installed', tone: 'neutral', dot: 'bg-fg-4' },
  stopped: { label: 'Stopped', tone: 'neutral', dot: 'bg-fg-4' },
  installing: { label: 'Installing', tone: 'info', dot: 'bg-info', pulse: true },
  updating: { label: 'Updating', tone: 'info', dot: 'bg-info', pulse: true },
  starting: { label: 'Starting', tone: 'warn', dot: 'bg-warn', pulse: true },
  running: { label: 'Online', tone: 'ok', dot: 'bg-ok' },
  stopping: { label: 'Stopping', tone: 'warn', dot: 'bg-warn', pulse: true },
  restarting: { label: 'Restarting', tone: 'warn', dot: 'bg-warn', pulse: true },
  crashed: { label: 'Crashed', tone: 'err', dot: 'bg-err' },
};

export function StatusDot({ state, className }: { state?: ServerState; className?: string }) {
  const m = STATE_META[state ?? 'stopped'];
  return (
    <span className={cn('relative inline-flex size-2 shrink-0', className)}>
      {state === 'running' && <span className="absolute inset-0 animate-ping rounded-full bg-ok/50 [animation-duration:2.4s]" />}
      <span className={cn('relative inline-flex size-2 rounded-full', m.dot, m.pulse && 'animate-pulse-soft')} />
    </span>
  );
}

export function StatusPill({ state, busy }: { state?: ServerState; busy?: string | null }) {
  const m = STATE_META[state ?? 'stopped'];
  return (
    <Badge tone={m.tone} className="h-6 gap-1.5 px-2 text-[11.5px]">
      <StatusDot state={state} />
      {busy && (state === 'running' || state === 'stopped') ? busy : m.label}
    </Badge>
  );
}

export function Empty({ icon, title, description, action, className }: { icon?: ReactNode; title: ReactNode; description?: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <div className={cn('flex flex-col items-center justify-center px-6 py-12 text-center', className)}>
      {icon && <div className="mb-3 flex size-11 items-center justify-center rounded-xl border border-line bg-panel-2 text-fg-3 [&_svg]:size-5">{icon}</div>}
      <div className="text-[13.5px] font-semibold text-fg">{title}</div>
      {description && <div className="mt-1 max-w-md text-[12.5px] leading-relaxed text-fg-3">{description}</div>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="inline-flex h-5 min-w-5 items-center justify-center rounded border border-line-strong bg-panel-2 px-1 font-mono text-[10.5px] text-fg-3">{children}</kbd>;
}

export function Progress({ value, className, tone = 'accent' }: { value: number | null; className?: string; tone?: 'accent' | 'ok' | 'warn' | 'err' | 'info' }) {
  const color = { accent: 'bg-flame', ok: 'bg-ok', warn: 'bg-warn', err: 'bg-err', info: 'bg-info' }[tone];
  return (
    <div className={cn('h-1.5 overflow-hidden rounded-full bg-panel-2', className)}>
      {value == null ? <div className="shimmer-bar h-full w-full" /> : <div className={cn('h-full rounded-full transition-[width] duration-300', color)} style={{ width: `${Math.max(2, Math.min(100, value * 100))}%` }} />}
    </div>
  );
}

export function Callout({ tone = 'info', title, children, action, className }: { tone?: 'info' | 'warn' | 'err' | 'ok'; title?: ReactNode; children?: ReactNode; action?: ReactNode; className?: string }) {
  const Icon = { info: Info, warn: AlertTriangle, err: XCircle, ok: CheckCircle2 }[tone];
  const c = { info: 'border-info/25 bg-info/6 text-info', warn: 'border-warn/25 bg-warn/6 text-warn', err: 'border-err/25 bg-err/6 text-err', ok: 'border-ok/25 bg-ok/6 text-ok' }[tone];
  return (
    <div className={cn('flex items-start gap-3 rounded-xl border px-4 py-3', c, className)}>
      <Icon className="mt-0.5 size-4 shrink-0" />
      <div className="min-w-0 flex-1 text-[12.5px] leading-relaxed text-fg-2">
        {title && <div className="mb-0.5 font-semibold text-fg">{title}</div>}
        {children}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}

export function Stat({ label, value, sub, icon, className, children }: { label: ReactNode; value: ReactNode; sub?: ReactNode; icon?: ReactNode; className?: string; children?: ReactNode }) {
  return (
    <Card className={cn('relative overflow-hidden p-4', className)}>
      <div className="flex items-center gap-2 text-[11.5px] font-medium tracking-wide text-fg-3 uppercase [&_svg]:size-3.5">
        {icon}
        {label}
      </div>
      <div className="mt-1.5 font-mono text-[22px] leading-none font-semibold tracking-tight text-fg tabular-nums">{value}</div>
      {sub && <div className="mt-1.5 text-[11.5px] text-fg-3">{sub}</div>}
      {children}
    </Card>
  );
}

export function PageHeader({ title, description, actions }: { title: ReactNode; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-5 flex items-end justify-between gap-4">
      <div className="min-w-0">
        <h1 className="text-[19px] font-semibold tracking-tight text-fg">{title}</h1>
        {description && <p className="mt-1 max-w-3xl text-[12.5px] leading-relaxed text-fg-3">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}
