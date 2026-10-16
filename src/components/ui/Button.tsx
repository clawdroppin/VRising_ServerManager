import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { Loader2 } from 'lucide-react';
import { cn } from '@/lib/cn';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'success' | 'outline';
type Size = 'xs' | 'sm' | 'md' | 'lg';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  icon?: ReactNode;
  iconRight?: ReactNode;
}

const variants: Record<Variant, string> = {
  primary:
    'bg-flame text-white font-semibold shadow-[0_1px_0_rgb(255_255_255/0.2)_inset,0_6px_20px_-8px_rgb(215_38_61/0.7)] hover:brightness-110 active:brightness-95',
  secondary: 'bg-panel-2 text-fg border border-line-strong hover:bg-hover hover:border-fg-4/60',
  outline: 'border border-line-strong text-fg-2 hover:text-fg hover:bg-hover',
  ghost: 'text-fg-2 hover:text-fg hover:bg-hover',
  danger: 'bg-err/12 text-err border border-err/30 hover:bg-err/20',
  success: 'bg-ok/12 text-ok border border-ok/30 hover:bg-ok/20',
};

const sizes: Record<Size, string> = {
  xs: 'h-6 px-2 text-[11.5px] gap-1 rounded-md',
  sm: 'h-7 px-2.5 text-[12px] gap-1.5 rounded-md',
  md: 'h-8 px-3 text-[12.5px] gap-2 rounded-lg',
  lg: 'h-10 px-4 text-[13.5px] gap-2 rounded-lg',
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', loading, icon, iconRight, className, children, disabled, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      disabled={disabled || loading}
      className={cn(
        'inline-flex shrink-0 items-center justify-center whitespace-nowrap font-medium transition-[background,color,border,filter,transform] duration-150 select-none active:scale-[0.98] disabled:pointer-events-none disabled:opacity-45',
        variants[variant],
        sizes[size],
        className,
      )}
      {...rest}
    >
      {loading ? <Loader2 className="size-3.5 animate-spin" /> : icon}
      {children}
      {iconRight}
    </button>
  );
});

export function IconButton({
  className,
  label,
  active,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; active?: boolean }) {
  return (
    <button
      aria-label={label}
      title={label}
      className={cn(
        'inline-flex size-7 shrink-0 items-center justify-center rounded-md text-fg-3 transition-colors duration-150 hover:bg-hover hover:text-fg disabled:pointer-events-none disabled:opacity-40 [&_svg]:size-4',
        active && 'bg-hover text-fg',
        className,
      )}
      {...rest}
    />
  );
}
