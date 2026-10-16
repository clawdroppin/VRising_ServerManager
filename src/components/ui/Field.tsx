import { forwardRef, isValidElement, useState, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import { Check, ChevronDown, Copy, Eye, EyeOff, Minus, Plus, Sparkles } from 'lucide-react';
import { cn } from '@/lib/cn';
import { copy as copyText } from '@/lib/shell';
import { generatePassword } from '@/lib/format';

const inputBase =
  'w-full rounded-lg border border-line-strong bg-bg-raised px-2.5 text-[12.5px] text-fg placeholder:text-fg-4 outline-none transition-[border,box-shadow] duration-150 hover:border-fg-4/50 focus:border-accent/70 focus:shadow-[0_0_0_3px_rgb(215_38_61/0.15)] disabled:opacity-50';

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean; mono?: boolean }>(
  function Input({ className, invalid, mono, ...rest }, ref) {
    return <input ref={ref} spellCheck={false} className={cn(inputBase, 'h-8', mono && 'font-mono text-[12px]', invalid && 'border-err/60 focus:border-err', className)} {...rest} />;
  },
);

export function TextArea({ className, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea spellCheck={false} className={cn(inputBase, 'min-h-20 resize-y py-2 leading-relaxed', className)} {...rest} />;
}

export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <div className={cn('relative', className)}>
      <select className={cn(inputBase, 'h-8 appearance-none pr-8')} {...rest}>
        {children}
      </select>
      <ChevronDown className="pointer-events-none absolute top-1/2 right-2.5 size-3.5 -translate-y-1/2 text-fg-3" />
    </div>
  );
}

export function Toggle({ checked, onChange, disabled, size = 'md' }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; size?: 'sm' | 'md' }) {
  const sm = size === 'sm';
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative inline-flex shrink-0 items-center rounded-full border transition-colors duration-150 disabled:opacity-40',
        sm ? 'h-4 w-7' : 'h-5 w-9',
        checked ? 'border-accent-strong bg-accent-strong' : 'border-line-strong bg-panel-2',
      )}
    >
      <span
        className={cn(
          'absolute rounded-full bg-white shadow transition-transform duration-150',
          sm ? 'size-3 left-0.5' : 'size-3.5 left-0.5',
          checked && (sm ? 'translate-x-3' : 'translate-x-4'),
        )}
      />
    </button>
  );
}

export function Checkbox({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label?: ReactNode; disabled?: boolean }) {
  return (
    <label className={cn('inline-flex items-center gap-2 text-[12.5px] text-fg-2', disabled && 'opacity-50')}>
      <button
        type="button"
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cn(
          'flex size-4 items-center justify-center rounded border transition-colors',
          checked ? 'border-accent-strong bg-accent-strong text-[#03201b]' : 'border-line-strong bg-bg-raised',
        )}
      >
        {checked && <Check className="size-3" strokeWidth={3} />}
      </button>
      {label}
    </label>
  );
}

export function NumberInput({
  value,
  onChange,
  min,
  max,
  step = 1,
  suffix,
  className,
  disabled,
}: {
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
  suffix?: string;
  className?: string;
  disabled?: boolean;
}) {
  const clamp = (v: number) => Math.min(max ?? Infinity, Math.max(min ?? -Infinity, v));
  const [text, setText] = useState<string | null>(null);
  return (
    <div className={cn('flex h-8 items-center rounded-lg border border-line-strong bg-bg-raised focus-within:border-accent/70', disabled && 'opacity-50', className)}>
      <button type="button" disabled={disabled} onClick={() => onChange(clamp(+(value - step).toFixed(4)))} className="flex h-full w-7 items-center justify-center text-fg-3 hover:text-fg">
        <Minus className="size-3" />
      </button>
      <input
        type="number"
        disabled={disabled}
        value={text ?? String(value)}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => {
          if (text != null && text.trim() !== '' && !isNaN(+text)) onChange(clamp(+text));
          setText(null);
        }}
        onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
        className="h-full w-full min-w-0 bg-transparent text-center font-mono text-[12px] text-fg outline-none"
      />
      {suffix && <span className="pr-1 text-[11px] text-fg-4">{suffix}</span>}
      <button type="button" disabled={disabled} onClick={() => onChange(clamp(+(value + step).toFixed(4)))} className="flex h-full w-7 items-center justify-center text-fg-3 hover:text-fg">
        <Plus className="size-3" />
      </button>
    </div>
  );
}

export function Slider({
  value,
  onChange,
  min,
  max,
  step = 1,
  marks,
  warnAbove,
}: {
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
  step?: number;
  marks?: number[];
  warnAbove?: number;
}) {
  const p = ((value - min) / (max - min)) * 100;
  const warn = warnAbove != null && value > warnAbove;
  return (
    <div className="relative w-full">
      <div className="pointer-events-none absolute top-1/2 h-1 w-full -translate-y-1/2 rounded-full bg-panel-2">
        <div className={cn('h-full rounded-full', warn ? 'bg-warn' : 'bg-flame')} style={{ width: `${p}%` }} />
      </div>
      <input type="range" className="range relative" min={min} max={max} step={step} value={value} onChange={(e) => onChange(+e.target.value)} />
      {marks && (
        <div className="mt-0.5 flex justify-between px-0.5 font-mono text-[10px] text-fg-4">
          {marks.map((m) => (
            <span key={m}>{m}</span>
          ))}
        </div>
      )}
    </div>
  );
}

export function Segmented<T extends string>({
  value,
  onChange,
  options,
  size = 'md',
  className,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: ReactNode; icon?: ReactNode }[];
  size?: 'sm' | 'md';
  className?: string;
}) {
  return (
    <div className={cn('inline-flex rounded-lg border border-line-strong bg-bg-raised p-0.5', className)}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className={cn(
            'inline-flex items-center gap-1.5 rounded-md font-medium transition-colors duration-150',
            size === 'sm' ? 'h-6 px-2 text-[11.5px]' : 'h-7 px-3 text-[12px]',
            value === o.value ? 'bg-panel-2 text-fg shadow-[0_0_0_1px_rgb(214_245_240/0.08)]' : 'text-fg-3 hover:text-fg-2',
          )}
        >
          {o.icon}
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function SecretInput({
  value,
  onChange,
  placeholder,
  generate,
  invalid,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  generate?: boolean;
  invalid?: boolean;
}) {
  const [show, setShow] = useState(false);
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex gap-1.5">
      <div className="relative flex-1">
        <Input type={show ? 'text' : 'password'} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} mono invalid={invalid} className="pr-16" />
        <div className="absolute top-1/2 right-1 flex -translate-y-1/2">
          <button type="button" title={show ? 'Hide' : 'Show'} onClick={() => setShow(!show)} className="flex size-6 items-center justify-center rounded text-fg-3 hover:text-fg">
            {show ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
          </button>
          <button
            type="button"
            title="Copy"
            disabled={!value}
            onClick={() => {
              copyText(value);
              setCopied(true);
              setTimeout(() => setCopied(false), 1200);
            }}
            className="flex size-6 items-center justify-center rounded text-fg-3 hover:text-fg disabled:opacity-30"
          >
            {copied ? <Check className="size-3.5 text-ok" /> : <Copy className="size-3.5" />}
          </button>
        </div>
      </div>
      {generate && (
        <button
          type="button"
          title="Generate a strong password"
          onClick={() => {
            onChange(generatePassword(14));
            setShow(true);
          }}
          className="flex h-8 items-center gap-1 rounded-lg border border-line-strong px-2 text-[11.5px] text-fg-2 hover:bg-hover hover:text-fg"
        >
          <Sparkles className="size-3.5 text-accent" /> Generate
        </button>
      )}
    </div>
  );
}

/** Label + description on the left, control on the right. */
export function FieldRow({
  label,
  description,
  children,
  hint,
  error,
  stacked,
  badge,
}: {
  label: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  stacked?: boolean;
  badge?: ReactNode;
}) {
  return (
    <div className={cn('grid gap-x-8 gap-y-2 py-3.5', stacked ? 'grid-cols-1' : 'grid-cols-[minmax(0,1fr)_minmax(220px,340px)] items-start')}>
      <div className="min-w-0">
        <div className="flex items-center gap-2 text-[13px] font-medium text-fg">
          {label}
          {badge}
        </div>
        {description && <div className="mt-0.5 text-[12px] leading-relaxed text-fg-3">{description}</div>}
      </div>
      <div className="min-w-0">
        {isValidElement(children) && children.type === Toggle ? <div className="flex justify-end pt-0.5">{children}</div> : children}
        {error ? <div className="mt-1.5 text-[11.5px] text-err">{error}</div> : hint ? <div className="mt-1.5 text-[11.5px] text-fg-4">{hint}</div> : null}
      </div>
    </div>
  );
}

export function Label({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('mb-1.5 text-[11.5px] font-medium tracking-wide text-fg-3 uppercase', className)}>{children}</div>;
}
