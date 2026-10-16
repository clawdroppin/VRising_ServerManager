import { useCallback, useEffect, useMemo, useState } from 'react';
import { BookmarkPlus, Copy, Download, RotateCcw, Search, X } from 'lucide-react';
import { cn } from '@/lib/cn';
import { ago, plural } from '@/lib/format';
import { api, errMsg } from '@/lib/ipc';
import { GAME_SETTINGS, GROUPS, KNOWN_DIFFICULTIES, KNOWN_PRESETS, SETTING_BY_KEY, isDefault, presetLabel, secondsLabel, settingValue, type GameSetting, type SettingValue } from '@/data/gameplay';
import type { Presets, RulePreset } from '@/lib/types';
import { useApp } from '@/store/app';
import { Button } from '@/components/ui/Button';
import { confirm } from '@/components/ui/Dialog';
import { Input, NumberInput, Segmented, Select, Slider, Toggle } from '@/components/ui/Field';
import { Badge, Callout, PageHeader, Section } from '@/components/ui/Surface';
import { useDraft } from '../draft';

function pctLabel(v: number) {
  return `${Math.round(v * 100)}%`;
}

function Control({ s, value, onChange }: { s: GameSetting; value: SettingValue; onChange: (v: SettingValue) => void }) {
  if (s.kind === 'bool') return <Toggle checked={value === true || value === 'true'} onChange={onChange} />;
  if (s.kind === 'enum') {
    const opts = s.options!;
    if (opts.length > 4)
      return (
        <Select value={String(value)} onChange={(e) => onChange(e.target.value)}>
          {opts.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
          {!opts.some((o) => o.value === String(value)) && <option value={String(value)}>{String(value)}</option>}
        </Select>
      );
    return <Segmented size="sm" value={String(value)} onChange={onChange} options={opts.map((o) => ({ value: o.value, label: o.label }))} className="flex-wrap" />;
  }
  const v = Number(value);
  if (s.kind === 'duration')
    return (
      <div className="flex items-center gap-3">
        <Slider value={Math.min(s.max!, Math.max(s.min!, v))} min={s.min!} max={s.max!} step={s.step ?? 60} onChange={onChange} />
        <span className="w-16 text-right font-mono text-[12.5px] text-fg">{secondsLabel(v)}</span>
      </div>
    );
  if (s.kind === 'number' || s.kind === 'hour')
    return (
      <div className="flex justify-end">
        <NumberInput value={v} min={s.min} max={s.max} step={s.step ?? 1} suffix={s.unit} onChange={onChange} className="w-44" />
      </div>
    );
  return (
    <div className="flex items-center gap-3">
      <Slider value={Math.min(s.max!, Math.max(s.min!, v))} min={s.min!} max={s.max!} step={s.step ?? 0.05} onChange={(x) => onChange(Math.round(x * 1000) / 1000)} />
      <span className={cn('w-14 text-right font-mono text-[12.5px]', v > (Number(s.default) || 0) + 1e-3 ? 'text-gold' : v < (Number(s.default) || 0) - 1e-3 ? 'text-info' : 'text-fg')}>
        {s.max! > 5 ? `${v}×` : pctLabel(v)}
      </span>
    </div>
  );
}

function Row({ s, value, onChange, onReset, dirty }: { s: GameSetting; value: SettingValue; onChange: (v: SettingValue) => void; onReset: () => void; dirty: boolean }) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_minmax(240px,360px)] items-center gap-x-8 py-3">
      <div className="min-w-0">
        <div className="flex items-center gap-2 text-[13px] font-medium text-fg">
          {s.label}
          {dirty && (
            <button title="Back to default" onClick={onReset} className="flex items-center gap-1 rounded-md border border-accent/25 bg-accent/10 px-1.5 text-[10.5px] text-accent hover:bg-accent/20">
              <RotateCcw className="size-2.5" /> changed
            </button>
          )}
        </div>
        <div className="mt-0.5 text-[12px] leading-relaxed text-fg-3">
          {s.description}
          <span className="ml-1.5 font-mono text-[10.5px] text-fg-4">{s.key}</span>
        </div>
      </div>
      <div className={cn(s.kind === 'bool' && 'flex justify-end')}>
        <Control s={s} value={value} onChange={onChange} />
      </div>
    </div>
  );
}

export function Gameplay({ id }: { id: string }) {
  const { draft, patch } = useDraft(id);
  const toast = useApp((s) => s.toast);
  const [q, setQ] = useState('');
  const [presets, setPresets] = useState<Presets>({ settings: KNOWN_PRESETS, difficulty: KNOWN_DIFFICULTIES });
  const gs = draft?.config.gameSettings ?? {};
  const preset = draft?.config.gameSettingsPreset ?? '';
  const changed = useMemo(() => GAME_SETTINGS.filter((s) => !isDefault(gs, s)).length, [gs]);
  const unknown = useMemo(() => Object.keys(gs).filter((k) => !SETTING_BY_KEY[k]).sort(), [gs]);

  const [mine, setMine] = useState<RulePreset[]>([]);
  const loadMine = useCallback(() => api.listRulePresets().then(setMine).catch(() => {}), []);

  useEffect(() => {
    api.listPresets(id).then((p) => p.settings.length && setPresets(p)).catch(() => {});
    loadMine();
  }, [id, loadMine]);
  if (!draft) return null;

  /** Save the custom rules (every key of ServerGameSettings) under a name, for any server. */
  const saveMine = async () => {
    const r = await confirm({
      title: 'Save these rules as a preset',
      message: 'Stores every custom rule of this server under a name. Apply it to any of your servers later from here. An existing preset with the same name is replaced.',
      input: '',
      inputPlaceholder: 'Preset name – e.g. Weekend PvP',
      confirm: 'Save preset',
    });
    if (!r.ok) return;
    try {
      await api.saveRulePreset(r.value, gs);
      toast('success', `Saved preset “${r.value}”`, id);
      loadMine();
    } catch (e) {
      toast('error', errMsg(e), id);
    }
  };
  const applyMine = (p: RulePreset) => {
    patch((d) => {
      d.config.gameSettings = { ...d.config.gameSettings, ...p.settings };
      d.config.gameSettingsPreset = '';
    });
    toast('success', `Applied “${p.name}” – review and save`, id);
  };
  const deleteMine = async (p: RulePreset) => {
    const r = await confirm({ title: `Delete preset “${p.name}”?`, message: 'Servers that use these rules keep them – only the saved preset is removed.', confirm: 'Delete', danger: true });
    if (!r.ok) return;
    try {
      await api.deleteRulePreset(p.name);
      loadMine();
    } catch (e) {
      toast('error', errMsg(e), id);
    }
  };

  const set = (key: string, v: SettingValue) => patch((d) => void (d.config.gameSettings = { ...d.config.gameSettings, [key]: v }));
  const resetAll = () =>
    patch((d) => {
      const next = { ...d.config.gameSettings };
      for (const s of GAME_SETTINGS) next[s.key] = s.default;
      d.config.gameSettings = next;
    });
  /** Copy what a preset sets into the custom values and switch the preset off. */
  const copyPreset = async () => {
    try {
      const values = await api.readPreset(id, 'settings', preset);
      patch((d) => {
        d.config.gameSettings = { ...d.config.gameSettings, ...values };
        d.config.gameSettingsPreset = '';
      });
      toast('success', `Copied ${Object.keys(values).length} values from ${presetLabel(preset)} – now edit them freely`, id);
    } catch (e) {
      toast('error', errMsg(e), id);
    }
  };
  const needle = q.trim().toLowerCase();
  const visible = (s: GameSetting) => !needle || s.label.toLowerCase().includes(needle) || s.description.toLowerCase().includes(needle) || s.key.toLowerCase().includes(needle);

  return (
    <div className="mx-auto max-w-[1000px] space-y-5 p-6 pb-24">
      <PageHeader
        title="Game rules"
        description="Everything in ServerGameSettings.json: PvP or PvE, castle raids, loot, day length, V Blood strength and more. Changes are written to the file and apply at the next start – existing worlds pick them up too."
      />

      <Section title="Presets" description="Stunlock’s ready-made rule sets, read from the installed server. A rules preset replaces every custom value below; a difficulty preset adjusts difficulty on top.">
        <div className="grid grid-cols-2 gap-4">
          <div>
            <div className="mb-1.5 text-[12px] font-medium text-fg-2">Rules preset</div>
            <Select value={preset} onChange={(e) => patch((d) => void (d.config.gameSettingsPreset = e.target.value))}>
              <option value="">None – use my custom rules</option>
              {presets.settings.map((p) => (
                <option key={p} value={p}>
                  {presetLabel(p)}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <div className="mb-1.5 text-[12px] font-medium text-fg-2">Difficulty preset</div>
            <Select value={draft.config.gameDifficultyPreset} onChange={(e) => patch((d) => void (d.config.gameDifficultyPreset = e.target.value))}>
              <option value="">None – use the Difficulty setting below</option>
              {presets.difficulty.map((p) => (
                <option key={p} value={p}>
                  {presetLabel(p)}
                </option>
              ))}
            </Select>
          </div>
        </div>
      </Section>

      <Section
        title="My presets"
        description="Your own rule sets, shared by all your servers. Applying one fills in the custom rules below (and turns a Stunlock rules preset off); nothing is written until you save."
        actions={
          <Button size="sm" icon={<BookmarkPlus className="size-3.5" />} disabled={!!preset} onClick={saveMine}>
            Save current rules…
          </Button>
        }
        bodyClassName="py-3"
      >
        {mine.length === 0 ? (
          <div className="text-[12px] text-fg-4">No presets yet. Set up the rules the way you like them, then “Save current rules…”.</div>
        ) : (
          <div className="flex flex-wrap gap-2">
            {mine.map((p) => (
              <div key={p.name} className="group flex items-center gap-1 rounded-lg border border-line bg-bg-raised py-1 pr-1 pl-3">
                <div className="mr-1">
                  <div className="text-[12.5px] font-medium text-fg">{p.name}</div>
                  <div className="text-[10.5px] text-fg-4">
                    {plural(Object.keys(p.settings).length, 'rule')} · saved {ago(p.createdAt)}
                  </div>
                </div>
                <Button size="xs" variant="outline" icon={<Download className="size-3" />} onClick={() => applyMine(p)}>
                  Apply
                </Button>
                <button title="Delete preset" onClick={() => deleteMine(p)} className="flex size-6 items-center justify-center rounded text-fg-4 hover:bg-hover hover:text-err">
                  <X className="size-3.5" />
                </button>
              </div>
            ))}
          </div>
        )}
      </Section>

      {preset && (
        <Callout
          tone="warn"
          title={`“${presetLabel(preset)}” decides the rules`}
          action={
            <Button size="sm" variant="outline" icon={<Copy className="size-3.5" />} onClick={copyPreset}>
              Copy into custom rules
            </Button>
          }
        >
          While a rules preset is set, the server ignores ServerGameSettings.json completely (verified). Copy the preset into your custom rules to start from it and tweak.
        </Callout>
      )}

      <div className="flex items-center gap-3">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-fg-4" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a rule – e.g. clan, raid, sun, loot" className="pl-8" />
        </div>
        <Badge tone={changed ? 'accent' : 'neutral'}>{changed ? `${changed} changed from default` : 'All default'}</Badge>
        <Button size="md" variant="outline" icon={<RotateCcw className="size-3.5" />} disabled={!changed} onClick={resetAll}>
          Reset all
        </Button>
      </div>

      <div className={cn('space-y-5 transition-opacity', preset && 'opacity-55')}>
        {GROUPS.map((g) => {
          const items = GAME_SETTINGS.filter((s) => s.group === g.id && visible(s));
          if (!items.length) return null;
          return (
            <Section key={g.id} title={g.label} description={g.blurb} bodyClassName="divide-y divide-line">
              {items.map((s) => (
                <Row key={s.key} s={s} value={settingValue(gs, s)} dirty={!isDefault(gs, s)} onChange={(x) => set(s.key, x)} onReset={() => set(s.key, s.default)} />
              ))}
            </Section>
          );
        })}
        {unknown.length > 0 && !needle && (
          <Section title="Other settings" description="Keys in your file the manager has no description for (newer game versions, mods). They're kept as they are – edit them here or in Config Files." bodyClassName="divide-y divide-line">
            {unknown.map((k) => {
              const v = gs[k];
              return (
                <div key={k} className="grid grid-cols-[minmax(0,1fr)_minmax(240px,360px)] items-center gap-x-8 py-2.5">
                  <div className="truncate font-mono text-[12px] text-fg-2">{k}</div>
                  <div className="flex justify-end">
                    {typeof v === 'boolean' ? (
                      <Toggle checked={v} onChange={(x) => set(k, x)} />
                    ) : typeof v === 'number' ? (
                      <NumberInput value={v} step={Number.isInteger(v) ? 1 : 0.1} onChange={(x) => set(k, x)} className="w-44" />
                    ) : (
                      <Input value={String(v ?? '')} onChange={(e) => set(k, e.target.value)} className="w-56" />
                    )}
                  </div>
                </div>
              );
            })}
          </Section>
        )}
      </div>
    </div>
  );
}
