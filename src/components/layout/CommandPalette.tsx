import { useEffect } from 'react';
import { Command } from 'cmdk';
import { AnimatePresence, motion } from 'motion/react';
import { Download, Home, Play, Plus, RotateCw, Search, Server, Settings, Square } from 'lucide-react';
import { api, errMsg } from '@/lib/ipc';
import { useApp, type ViewId } from '@/store/app';
import { VIEWS } from '@/features/server/views';
import { StatusDot } from '@/components/ui/Surface';

export function CommandPalette() {
  const open = useApp((s) => s.palette);
  const setOpen = useApp((s) => s.setPalette);
  const instances = useApp((s) => s.instances);
  const statuses = useApp((s) => s.statuses);
  const active = useApp((s) => s.active);
  const { openServer, setActive, setDialog, toast } = useApp.getState();

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen(!useApp.getState().palette);
      }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [setOpen]);

  const run = (fn: () => unknown) => {
    setOpen(false);
    Promise.resolve(fn()).catch((e) => toast('error', errMsg(e)));
  };
  const current = instances.find((i) => i.id === active);

  const item = 'flex h-9 cursor-default items-center gap-2.5 rounded-lg px-2.5 text-[12.5px] text-fg-2 data-[selected=true]:bg-hover data-[selected=true]:text-fg [&_svg]:size-4 [&_svg]:text-fg-3';
  const group = '[&_[cmdk-group-heading]]:px-2.5 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:text-[10.5px] [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:tracking-[0.1em] [&_[cmdk-group-heading]]:text-fg-4 [&_[cmdk-group-heading]]:uppercase';

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-[70] flex items-start justify-center bg-black/50 pt-[12vh] backdrop-blur-[2px]"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.12 }}
          onMouseDown={(e) => e.target === e.currentTarget && setOpen(false)}
        >
          <motion.div initial={{ y: -8, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: -6, opacity: 0 }} transition={{ duration: 0.14 }} className="w-[600px]">
            <Command className="overflow-hidden rounded-2xl border border-line-strong bg-panel shadow-pop" loop onKeyDown={(e) => e.key === 'Escape' && setOpen(false)}>
              <div className="flex items-center gap-2.5 border-b border-line px-4">
                <Search className="size-4 text-fg-3" />
                <Command.Input autoFocus placeholder="Type a command or search…" className="h-12 flex-1 bg-transparent text-[14px] text-fg outline-none placeholder:text-fg-4" />
              </div>
              <Command.List className="max-h-[420px] overflow-y-auto p-1.5">
                <Command.Empty className="px-3 py-8 text-center text-[12.5px] text-fg-3">No results.</Command.Empty>
                {current && (
                  <Command.Group heading={current.name} className={group}>
                    {VIEWS.map((v) => (
                      <Command.Item key={v.id} value={`${current.name} go ${v.label}`} className={item} onSelect={() => run(() => openServer(current.id, v.id as ViewId))}>
                        <v.icon /> {v.label}
                      </Command.Item>
                    ))}
                  </Command.Group>
                )}
                <Command.Group heading="Servers" className={group}>
                  <Command.Item value="dashboard home" className={item} onSelect={() => run(() => setActive('home'))}>
                    <Home /> Dashboard
                  </Command.Item>
                  {instances.map((i) => (
                    <Command.Item key={i.id} value={`open ${i.name} ${i.config.name}`} className={item} onSelect={() => run(() => openServer(i.id))}>
                      <Server /> {i.name}
                      <span className="ml-auto flex items-center gap-1.5 text-[11px] text-fg-4">
                        <StatusDot state={statuses[i.id]?.state} />
                        {statuses[i.id]?.state}
                      </span>
                    </Command.Item>
                  ))}
                </Command.Group>
                <Command.Group heading="Actions" className={group}>
                  {instances.flatMap((i) => {
                    const st = statuses[i.id]?.state;
                    const running = st === 'running' || st === 'starting';
                    return running
                      ? [
                          <Command.Item key={`s-${i.id}`} value={`stop ${i.name}`} className={item} onSelect={() => run(() => api.stop(i.id))}>
                            <Square /> Stop {i.name}
                          </Command.Item>,
                          <Command.Item key={`r-${i.id}`} value={`restart ${i.name}`} className={item} onSelect={() => run(() => api.restart(i.id))}>
                            <RotateCw /> Restart {i.name}
                          </Command.Item>,
                        ]
                      : st !== 'notInstalled'
                        ? [
                            <Command.Item key={`p-${i.id}`} value={`start ${i.name}`} className={item} onSelect={() => run(() => api.start(i.id))}>
                              <Play /> Start {i.name}
                            </Command.Item>,
                          ]
                        : [];
                  })}
                  <Command.Item value="new create server" className={item} onSelect={() => run(() => setDialog({ kind: 'new' }))}>
                    <Plus /> Create a new server
                  </Command.Item>
                  <Command.Item value="import server pack folder" className={item} onSelect={() => run(() => setDialog({ kind: 'import' }))}>
                    <Download /> Import a server
                  </Command.Item>
                  <Command.Item value="app settings preferences steamcmd" className={item} onSelect={() => run(() => setDialog({ kind: 'settings' }))}>
                    <Settings /> App settings
                  </Command.Item>
                </Command.Group>
              </Command.List>
            </Command>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
