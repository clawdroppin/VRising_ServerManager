import { Copy, Download, EyeOff, FolderOpen, Megaphone, MoreHorizontal, Play, RefreshCw, RotateCw, ShieldCheck, Skull, Square, Terminal, Trash2, Upload } from 'lucide-react';
import { Button, IconButton } from '@/components/ui/Button';
import { Menu } from '@/components/ui/Menu';
import { useServerActions } from '@/hooks/useServerActions';
import { api } from '@/lib/ipc';
import { reveal } from '@/lib/shell';
import { useApp, useInstance, useStatus } from '@/store/app';

export function ServerControls({ id, size = 'md', compact }: { id: string; size?: 'sm' | 'md' | 'lg'; compact?: boolean }) {
  const st = useStatus(id);
  const inst = useInstance(id);
  const { run, pending } = useServerActions(id);
  const state = st?.state ?? 'stopped';
  const setDialog = useApp((s) => s.setDialog);
  if (!inst) return null;

  const live = state === 'running' || state === 'starting';
  const transitioning = state === 'stopping' || state === 'restarting' || state === 'installing' || state === 'updating';

  return (
    <div className="flex items-center gap-1.5">
      {state === 'notInstalled' ? (
        <Button variant="primary" size={size} icon={<Download className="size-4" />} loading={pending === 'install'} onClick={() => run('install')}>
          Install server
        </Button>
      ) : live || state === 'stopping' || state === 'restarting' ? (
        <>
          <Button variant="secondary" size={size} icon={<Square className="size-3.5 fill-current" />} loading={pending === 'stop' || state === 'stopping'} disabled={transitioning} onClick={() => run('stop')}>
            {compact ? null : state === 'stopping' ? 'Stopping…' : 'Stop'}
          </Button>
          <Button variant="secondary" size={size} icon={<RotateCw className="size-3.5" />} loading={pending === 'restart' || state === 'restarting'} disabled={transitioning} onClick={() => run('restart')}>
            {compact ? null : 'Restart'}
          </Button>
        </>
      ) : (
        <Button variant="primary" size={size} icon={<Play className="size-3.5 fill-current" />} loading={pending === 'start'} disabled={transitioning} onClick={() => run('start')}>
          {compact ? null : transitioning ? (state === 'installing' ? 'Installing…' : 'Updating…') : 'Start'}
        </Button>
      )}
      {!compact && (
        <Menu
          width={240}
          trigger={() => <IconButton label="More actions" className="size-8 border border-line-strong bg-panel-2"><MoreHorizontal /></IconButton>}
          items={[
            {
              label: `Restart with ${inst.automation.restartWarningMins || 5}-min warning`,
              icon: <Megaphone />,
              disabled: !live || !inst.config.rconEnabled || !!st?.countdown,
              onSelect: () => run('warnRestart'),
            },
            { label: 'Force stop (no save)', icon: <Skull />, danger: true, disabled: !live && state !== 'stopping', onSelect: () => run('forceStop') },
            { label: 'Show console window', icon: <Terminal />, disabled: !live, onSelect: () => api.setConsoleVisible(id, true) },
            { label: 'Hide console window', icon: <EyeOff />, disabled: !live, onSelect: () => api.setConsoleVisible(id, false) },
            { separator: true, label: '' },
            { label: 'Update server', icon: <RefreshCw />, disabled: state === 'notInstalled' || transitioning, onSelect: () => run('update') },
            { label: 'Validate files', icon: <ShieldCheck />, disabled: state === 'notInstalled' || transitioning, onSelect: () => run('validate') },
            { separator: true, label: '' },
            { label: 'Open server folder', icon: <FolderOpen />, onSelect: () => reveal(inst.installDir) },
            { label: 'Export server…', icon: <Upload />, onSelect: () => setDialog({ kind: 'export', id }) },
            { label: 'Duplicate server…', icon: <Copy />, onSelect: () => setDialog({ kind: 'clone', id }) },
            { separator: true, label: '' },
            { label: 'Delete server…', icon: <Trash2 />, danger: true, onSelect: () => setDialog({ kind: 'delete', id }) },
          ]}
        />
      )}
    </div>
  );
}
