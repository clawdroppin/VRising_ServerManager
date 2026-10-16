import { useRef, type MutableRefObject } from 'react';
import { motion } from 'motion/react';
import { LayoutDashboard, Plus, X } from 'lucide-react';
import { cn } from '@/lib/cn';
import { serverColor } from '@/lib/colors';
import { useApp } from '@/store/app';
import { StatusDot } from '@/components/ui/Surface';

function Tab({ id, idx, drag }: { id: string; idx: number; drag: MutableRefObject<number | null> }) {
  const inst = useApp((s) => s.instances.find((i) => i.id === id));
  const state = useApp((s) => s.statuses[id]?.state);
  const on = useApp((s) => s.active === id);
  const { setActive, closeTab, moveTab } = useApp.getState();
  if (!inst) return null;
  return (
    <div
      draggable
      onDragStart={() => (drag.current = idx)}
      onDragOver={(e) => e.preventDefault()}
      onDrop={() => {
        if (drag.current != null && drag.current !== idx) moveTab(drag.current, idx);
        drag.current = null;
      }}
      onMouseDown={(e) => {
        if (e.button === 1) {
          e.preventDefault();
          closeTab(id);
        }
      }}
      onClick={() => setActive(id)}
      className={cn(
        'group relative flex h-full max-w-[220px] min-w-[120px] items-center gap-2 border-r border-line px-3 text-[12.5px] transition-colors',
        on ? 'bg-panel/80 text-fg' : 'text-fg-3 hover:bg-panel/40 hover:text-fg-2',
      )}
    >
      {on && <motion.span layoutId="tab-accent" className="absolute inset-x-0 top-0 h-[2px]" style={{ background: serverColor(inst.color) }} transition={{ duration: 0.18 }} />}
      <StatusDot state={state} />
      <span className="truncate font-medium">{inst.name}</span>
      <button
        onClick={(e) => {
          e.stopPropagation();
          closeTab(id);
        }}
        title="Close tab (Ctrl+W) – the server keeps running"
        className={cn('ml-auto flex size-5 shrink-0 items-center justify-center rounded text-fg-4 hover:bg-hover hover:text-fg', !on && 'opacity-0 group-hover:opacity-100')}
      >
        <X className="size-3" />
      </button>
    </div>
  );
}

export function TabBar() {
  const tabs = useApp((s) => s.tabs);
  const homeActive = useApp((s) => s.active === 'home');
  const { setActive, setDialog } = useApp.getState();
  const drag = useRef<number | null>(null);

  return (
    <div className="flex h-9 shrink-0 items-stretch border-b border-line bg-bg">
      <button
        onClick={() => setActive('home')}
        className={cn('relative flex items-center gap-2 border-r border-line px-3.5 text-[12.5px] font-medium transition-colors', homeActive ? 'bg-panel/80 text-fg' : 'text-fg-3 hover:text-fg-2')}
      >
        {homeActive && <motion.span layoutId="tab-accent" className="bg-flame absolute inset-x-0 top-0 h-[2px]" transition={{ duration: 0.18 }} />}
        <LayoutDashboard className="size-3.5" />
        Home
      </button>
      <div className="flex min-w-0 flex-1 overflow-x-auto [scrollbar-width:none]">
        {tabs.map((id, idx) => (
          <Tab key={id} id={id} idx={idx} drag={drag} />
        ))}
        <button onClick={() => setDialog({ kind: 'new' })} title="New server" className="flex w-9 shrink-0 items-center justify-center text-fg-4 hover:text-accent">
          <Plus className="size-4" />
        </button>
      </div>
    </div>
  );
}
