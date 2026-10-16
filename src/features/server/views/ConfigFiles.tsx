import { useCallback, useEffect, useMemo, useState } from 'react';
import CodeMirror from '@uiw/react-codemirror';
import { StreamLanguage, HighlightStyle, indentUnit, syntaxHighlighting } from '@codemirror/language';
import { json } from '@codemirror/legacy-modes/mode/javascript';
import { EditorView } from '@codemirror/view';
import { tags as t } from '@lezer/highlight';
import { AlertTriangle, FileCode2, FolderOpen, History, RotateCcw, Save } from 'lucide-react';
import { cn } from '@/lib/cn';
import { api, errMsg } from '@/lib/ipc';
import { ago, dateTime } from '@/lib/format';
import { reveal } from '@/lib/shell';
import type { ConfigFile, ConfigFileKind } from '@/lib/types';
import { useApp, useStatus } from '@/store/app';
import { Button, IconButton } from '@/components/ui/Button';
import { Segmented, Select } from '@/components/ui/Field';
import { Callout } from '@/components/ui/Surface';

const theme = EditorView.theme(
  {
    '&': { backgroundColor: 'transparent', color: '#ecdfe2' },
    '.cm-content': { caretColor: '#f2596b', padding: '12px 0' },
    '.cm-gutters': { backgroundColor: 'transparent', color: '#5c4b51', border: 'none' },
    '.cm-activeLine': { backgroundColor: 'rgb(245 214 220 / 0.03)' },
    '.cm-activeLineGutter': { backgroundColor: 'transparent', color: '#c4b3b8' },
    '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': { backgroundColor: 'rgb(215 38 61 / 0.28) !important' },
    '.cm-cursor': { borderLeftColor: '#f2596b' },
    '.cm-searchMatch': { backgroundColor: 'rgb(250 204 21 / 0.25)' },
    '.cm-panels': { backgroundColor: '#1a1115', color: '#ecdfe2' },
  },
  { dark: true },
);

const highlight = HighlightStyle.define([
  { tag: [t.propertyName, t.definition(t.propertyName)], color: '#f59aa5' },
  { tag: t.string, color: '#e9b65a' },
  { tag: t.number, color: '#a99cf8' },
  { tag: [t.bool, t.atom, t.keyword], color: '#7dd3fc' },
  { tag: t.punctuation, color: '#8a777d' },
]);

const jsonExtensions = [StreamLanguage.define(json), syntaxHighlighting(highlight), theme, indentUnit.of('  '), EditorView.lineWrapping];
const textExtensions = [theme, EditorView.lineWrapping];

const FILES: { id: ConfigFileKind; name: string; blurb: string }[] = [
  { id: 'host', name: 'ServerHostSettings.json', blurb: 'Name, ports, password, saves, RCON. Edits flow back into Server Settings. Read at start – a save while running applies at the next restart.' },
  { id: 'game', name: 'ServerGameSettings.json', blurb: 'Game rules. Edits flow back into Game Rules. Ignored by the server while a rules preset is set. Read at start.' },
  { id: 'admins', name: 'adminlist.txt', blurb: 'One SteamID64 per line. The running server reloads it within seconds.' },
  { id: 'bans', name: 'banlist.txt', blurb: 'One SteamID64 per line. The running server reloads it within seconds.' },
];

function checkList(text: string): { line: number; message: string } | null {
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].trim();
    if (l && !/^7656\d{13}$/.test(l)) return { line: i + 1, message: `“${l.slice(0, 24)}” isn't a SteamID64` };
  }
  return null;
}

/** JSON.parse with a line number, like the server's "Failed to parse Config". */
function check(text: string): { line: number; message: string } | null {
  try {
    const v = JSON.parse(text);
    if (typeof v !== 'object' || Array.isArray(v) || v === null) return { line: 1, message: 'The file must be one JSON object { … }' };
    return null;
  } catch (e) {
    const m = String((e as Error).message);
    const pos = /position (\d+)/.exec(m)?.[1];
    const line = pos ? text.slice(0, +pos).split('\n').length : 1;
    return { line, message: m.replace(/^JSON\.parse: /, '').replace(/ in JSON at position \d+.*$/, '') };
  }
}

export function ConfigFiles({ id }: { id: string }) {
  const st = useStatus(id);
  const toast = useApp((s) => s.toast);
  const upsert = useApp((s) => s.upsertInstance);
  const [loaded, setLoaded] = useState<ConfigFile | null>(null);
  const [text, setText] = useState('');
  const [saving, setSaving] = useState(false);
  const [history, setHistory] = useState<[string, number][]>([]);
  const [file, setFile] = useState<ConfigFileKind>('host');
  const meta = FILES.find((f) => f.id === file)!;
  const isJson = file === 'host' || file === 'game';
  const dirty = loaded != null && text !== loaded.text;

  const load = useCallback(async () => {
    try {
      const c = await api.readConfig(id, file);
      setLoaded(c);
      setText(c.text);
      api.configHistory(id, file).then(setHistory).catch(() => setHistory([]));
    } catch (e) {
      toast('error', errMsg(e));
    }
  }, [id, file, toast]);
  useEffect(() => {
    load();
  }, [load, st?.state]);

  const problem = useMemo(() => (!text.trim() ? null : isJson ? check(text) : checkList(text)), [text, isJson]);

  const save = useCallback(async () => {
    setSaving(true);
    try {
      const r = await api.writeConfig(id, file, text);
      upsert(r.instance);
      toast('success', r.restartNeeded ? `${meta.name} saved – restart the server to apply` : `${meta.name} saved`, id);
      await load();
    } catch (e) {
      toast('error', errMsg(e), id);
    } finally {
      setSaving(false);
    }
  }, [id, file, meta.name, text, load, toast, upsert]);

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key.toLowerCase() === 's' && dirty && !problem) {
        e.preventDefault();
        save();
      }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [dirty, problem, save]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center gap-3 border-b border-line px-4 py-2.5">
        <FileCode2 className="size-4 text-accent" />
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-semibold text-fg">{meta.name}</div>
          <div className="text-[11px] text-fg-4">{loaded?.modified ? `Modified ${ago(loaded.modified)}` : 'Not created yet'}</div>
        </div>
        <Segmented
          size="sm"
          value={file}
          onChange={async (v) => {
            if (dirty) {
              const { confirm } = await import('@/components/ui/Dialog');
              const r = await confirm({ title: 'Discard unsaved edits?', message: `Your changes to ${meta.name} are lost.`, confirm: 'Discard', danger: true });
              if (!r.ok) return;
            }
            setFile(v);
          }}
          options={FILES.map((f) => ({ value: f.id, label: f.name.replace(/^Server|Settings\.json$|\.txt$/g, '') || f.name }))}
        />
        {history.length > 0 && (
          <Select
            value=""
            className="w-48"
            onChange={async (e) => {
              if (!e.target.value) return;
              try {
                setText(await api.readTextFile(id, e.target.value));
                toast('info', 'Loaded an earlier version – review it and Save to restore');
              } catch (err) {
                toast('error', errMsg(err));
              }
            }}
          >
            <option value="">History ({history.length})</option>
            {history.map(([p, ts]) => (
              <option key={p} value={p}>
                {dateTime(ts)} · {ago(ts)}
              </option>
            ))}
          </Select>
        )}
        <IconButton label="Open folder" onClick={() => loaded && reveal(loaded.path.replace(/[\\/][^\\/]+$/, ''))}>
          <FolderOpen />
        </IconButton>
        <Button size="sm" variant="ghost" icon={<RotateCcw className="size-3.5" />} disabled={!dirty} onClick={() => setText(loaded?.text ?? '')}>
          Revert
        </Button>
        <Button size="sm" variant="primary" icon={<Save className="size-3.5" />} disabled={!dirty || !!problem} loading={saving} onClick={save}>
          Save
        </Button>
      </div>
      <div className="space-y-2 px-4 pt-3">
        {(st?.state === 'running' || st?.state === 'starting') && isJson && <Callout tone="info">The server is running. It reads this file only at start, so a save takes effect on the next restart.</Callout>}
        <div className="text-[11.5px] leading-relaxed text-fg-4">
          {meta.blurb} Keys the manager doesn’t know are left exactly as they are. The previous 30 versions of each file are kept.
        </div>
        {loaded && !loaded.exists && <Callout tone="info">The file doesn’t exist yet{isJson ? ' – shown are the defaults the server ships, which it uses until the manager writes the file on the next start' : ''}.</Callout>}
      </div>
      <div className="m-4 flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-line bg-bg/70">
        <div className="min-h-0 flex-1 overflow-auto">
          <CodeMirror value={text} onChange={setText} extensions={isJson ? jsonExtensions : textExtensions} theme="none" basicSetup={{ foldGutter: true, highlightActiveLine: true }} height="100%" style={{ height: '100%' }} />
        </div>
        <div className="flex shrink-0 items-center gap-4 border-t border-line px-4 py-1.5 font-mono text-[10.5px] text-fg-4">
          <span className="truncate">{loaded?.path}</span>
          {problem ? (
            <span className={cn('ml-auto flex items-center gap-1.5 text-err')}>
              <AlertTriangle className="size-3" /> Line {problem.line}: {problem.message}
            </span>
          ) : (
            <span className="ml-auto text-ok">{isJson ? 'Valid JSON' : 'Valid list'}</span>
          )}
          {history.length > 0 && (
            <span className="flex items-center gap-1">
              <History className="size-3" /> {history.length} versions kept
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
