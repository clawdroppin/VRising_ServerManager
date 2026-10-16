import { useEffect, useState } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { Command, Copy, Minus, Square, X } from 'lucide-react';
import { inTauri } from '@/lib/ipc';
import { useApp } from '@/store/app';
import { Kbd } from '@/components/ui/Surface';

/** The mark: a blood drop with fangs under a crescent, inside a rune ring. */
export function Logo({ className = 'size-[18px]' }: { className?: string }) {
  return (
    <svg viewBox="0 0 64 64" className={className}>
      <defs>
        <linearGradient id="vrsm-blood" x1="0.5" y1="0" x2="0.5" y2="1">
          <stop offset="0" stopColor="#ff8a96" />
          <stop offset="0.45" stopColor="#e5304a" />
          <stop offset="1" stopColor="#8e1024" />
        </linearGradient>
      </defs>
      <circle cx="32" cy="32" r="28" fill="none" stroke="#e5485a" strokeOpacity="0.4" strokeWidth="2.5" strokeDasharray="5 4" />
      <path d="M44 11a12 12 0 1 1-13 17a10 10 0 1 0 13-17z" fill="#e9b65a" opacity="0.85" />
      <path d="M30 14c5 9 13 15 13 25a13 13 0 0 1-26 0c0-10 8-16 13-25z" fill="url(#vrsm-blood)" />
      <path d="M23 37l3 8 3-8zM31 37l3 8 3-8z" fill="#fff4f5" opacity="0.92" />
    </svg>
  );
}

export function TitleBar() {
  const [max, setMax] = useState(false);
  const setPalette = useApp((s) => s.setPalette);
  const win = inTauri() ? getCurrentWindow() : null;
  useEffect(() => {
    if (!win) return;
    win.isMaximized().then(setMax);
    const un = win.onResized(() => win.isMaximized().then(setMax));
    return () => {
      un.then((f) => f());
    };
  }, [win]);

  return (
    <div data-tauri-drag-region className="relative z-30 flex h-10 shrink-0 items-center border-b border-line bg-bg pl-3.5">
      <div data-tauri-drag-region className="flex items-center gap-2.5">
        <Logo />
        <span data-tauri-drag-region className="text-[12.5px] font-semibold tracking-tight text-fg">
          V Rising <span className="text-fg-3">Server Manager</span>
        </span>
      </div>
      <div data-tauri-drag-region className="flex flex-1 justify-center">
        <button
          onClick={() => setPalette(true)}
          className="flex h-7 w-[340px] items-center gap-2 rounded-lg border border-line bg-panel px-2.5 text-[12px] text-fg-4 transition-colors hover:border-line-strong hover:text-fg-3"
        >
          <Command className="size-3.5" />
          Search servers, actions, settings…
          <span className="ml-auto flex gap-0.5">
            <Kbd>Ctrl</Kbd>
            <Kbd>K</Kbd>
          </span>
        </button>
      </div>
      {win && (
        <div className="flex h-full">
          <button onClick={() => win.minimize()} className="flex h-full w-11 items-center justify-center text-fg-3 hover:bg-hover hover:text-fg">
            <Minus className="size-4" />
          </button>
          <button onClick={() => win.toggleMaximize()} className="flex h-full w-11 items-center justify-center text-fg-3 hover:bg-hover hover:text-fg">
            {max ? <Copy className="size-3.5 -scale-x-100" /> : <Square className="size-3.5" />}
          </button>
          <button onClick={() => win.close()} className="flex h-full w-11 items-center justify-center text-fg-3 hover:bg-err hover:text-white">
            <X className="size-4" />
          </button>
        </div>
      )}
    </div>
  );
}
