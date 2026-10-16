// Fake backend for `npm run dev` in a plain browser. Never loaded inside Tauri (see main.tsx).
// Log lines and settings shapes are copied from a real VRisingServer.exe v1.1.15.0 run.
import { installMock, mockEmit } from './ipc';
import { defaultConfig } from './defaults';
import { GAME_SETTINGS, KNOWN_DIFFICULTIES, KNOWN_PRESETS } from '@/data/gameplay';
import type { AccessView, AppSettings, BackupInfo, EventRow, MetricRow, ServerConfig, ServerInstance, ServerStatus, World } from './types';

const now = Date.now();
const DEFAULTS = Object.fromEntries(GAME_SETTINGS.map((s) => [s.key, s.default]));

function makeInstance(id: string, name: string, port: number, color: string, extra: Partial<ServerInstance> = {}): ServerInstance {
  return {
    id,
    name,
    color,
    installDir: `D:\\VRisingServers\\${name.replace(/\W+/g, '-')}`,
    createdAt: now - 86400000 * 3,
    notes: '',
    branch: 'public',
    branchPassword: '',
    config: defaultConfig({
      name,
      description: 'PvE · friendly · weekly events',
      port,
      queryPort: port + 1,
      rconPort: 25575 + (port - 9876) / 10,
      rconPassword: 'Crypt7Kq2xPzVb4m',
      maxConnectedUsers: 20,
      gameSettings: { ...DEFAULTS, GameModeType: 'PvE', ClanSize: 4 },
    }),
    launch: { dataDir: './save-data', upnp: false, showConsole: false, priority: 'normal', affinity: [], extraArgs: '' },
    automation: {
      autoStart: false,
      autoRestart: true,
      restartDelaySecs: 10,
      crashLimit: 3,
      stopTimeoutSecs: 60,
      schedules: [{ enabled: true, time: '05:00', days: [], action: 'restart' }],
      backupIntervalMins: 60,
      backupKeep: 24,
      backupOnStop: true,
      backupBeforeUpdate: true,
      updateOnStart: false,
      updateCheckMins: 60,
      autoUpdate: false,
      waitForEmpty: false,
      memoryLimitMb: 0,
      maxUptimeHours: 0,
      idleStopMins: 0,
      restartWarningMins: 5,
      announcements: [{ enabled: true, message: 'Join our Discord: discord.gg/crimson', everyMins: 60 }],
    },
    ...extra,
  };
}

let instances: ServerInstance[] = [makeInstance('a1b2c3d4-0001', 'Crimson Covenant', 9876, 'blood'), makeInstance('a1b2c3d4-0002', 'Brutal Duo PvP', 9886, 'vblood')];
let rulePresets: { name: string; createdAt: number; settings: Record<string, number | string | boolean> }[] = [
  { name: 'Friends PvE', createdAt: Date.now() - 86400_000 * 3, settings: { GameModeType: 'PvE', ClanSize: 6, 'CastleStatModifiers_Global.CastleLimit': 3 } },
];
instances[1].config.gameSettingsPreset = 'DuoPvP';
instances[1].config.gameDifficultyPreset = 'Difficulty_Brutal';

const statuses: Record<string, ServerStatus> = {};
function status(id: string, patch: Partial<ServerStatus> = {}): ServerStatus {
  const s: ServerStatus = statuses[id] ?? {
    id,
    state: 'stopped',
    pid: null,
    startedAt: null,
    readyAt: null,
    installedBuild: '25169871',
    latestBuild: '25169871',
    gameVersion: null,
    daysRunning: null,
    crashCount: 0,
    crashLoop: false,
    pendingRestart: false,
    players: [],
    queryPlayers: null,
    nextSchedule: { at: now + 3600_000 * 5, action: 'restart' },
    lastBackup: now - 1800_000,
    lastExitCode: null,
    busy: null,
    rconOk: null,
    steamId: null,
    publicIp: null,
    lastSave: null,
    waiting: null,
    countdown: null,
  };
  statuses[id] = { ...s, ...patch };
  return statuses[id];
}
status('a1b2c3d4-0001', {
  state: 'running',
  pid: 18580,
  startedAt: now - 3600_000 * 2.3,
  readyAt: now - 3600_000 * 2.2,
  gameVersion: '1.1.15.0-r101082-b2',
  daysRunning: 14,
  rconOk: true,
  steamId: '90294949908879360',
  publicIp: '203.0.113.42',
  lastSave: now - 70_000,
  queryPlayers: 3,
  players: [
    { name: 'Vlad', since: now - 3600_000 * 1.2, steamId: '76561198000000001' },
    { name: 'Mina', since: now - 1200_000, steamId: '76561198000000002' },
    { name: '', since: now - 60_000, steamId: '76561198000000009' },
  ],
});
status('a1b2c3d4-0002');

let settings: AppSettings = {
  steamcmdDir: null,
  defaultInstallRoot: null,
  backupDir: null,
  telemetryIntervalMs: 1000,
  confirmDestructive: true,
  reduceMotion: false,
  checkUpdatesOnLaunch: true,
  accent: 'blood',
  closeToTray: true,
  desktopNotifications: true,
  streamerMode: false,
  webhookUrl: '',
  webhookLevels: ['success', 'error'],
  metricsRetentionDays: 30,
};

const access: Record<string, AccessView> = {
  'a1b2c3d4-0001': {
    admins: [{ steamId: '76561198000000001', name: 'Vlad', online: true }],
    bans: [{ steamId: '76561198000000666', name: 'Griefer', online: false }],
  },
};

function hostText(c: ServerConfig) {
  return (
    JSON.stringify(
      {
        Name: c.name,
        Description: c.description,
        Port: c.port,
        QueryPort: c.queryPort,
        MaxConnectedUsers: c.maxConnectedUsers,
        MaxConnectedAdmins: c.maxConnectedAdmins,
        ServerFps: c.serverFps,
        SaveName: c.saveName,
        Password: c.password,
        Secure: c.secure,
        ListOnSteam: c.listOnSteam,
        ListOnEOS: c.listOnEos,
        AutoSaveCount: c.autoSaveCount,
        AutoSaveInterval: c.autoSaveInterval,
        CompressSaveFiles: c.compressSaveFiles,
        GameSettingsPreset: c.gameSettingsPreset,
        GameDifficultyPreset: c.gameDifficultyPreset,
        AdminOnlyDebugEvents: c.adminOnlyDebugEvents,
        DisableDebugEvents: c.disableDebugEvents,
        API: { Enabled: c.apiEnabled, BindPort: c.apiPort },
        Rcon: { Enabled: c.rconEnabled, Port: c.rconPort, Password: c.rconPassword },
      },
      null,
      2,
    ) + '\n'
  );
}

const backups: BackupInfo[] = Array.from({ length: 6 }, (_, i) => ({
  path: `D:\\VRisingServers\\Crimson-Covenant\\Backups\\2026-10-0${9 - i}_auto.zip`,
  name: `2026-10-0${9 - i}_04-00-00_${i === 2 ? 'manual' : 'auto'}.zip`,
  size: 7_100_000 + i * 120_000,
  createdAt: now - i * 3600_000 * 7,
  label: i === 2 ? 'Before Dracula' : 'Interval',
  kind: i === 2 ? 'manual' : 'auto',
  files: 6,
}));

const world = (dir: string, name: string, active: boolean, age: number, count = 6): World => ({
  name,
  version: 'v4',
  active,
  savedAt: now - age,
  startDate: '10/01/2026',
  hasSettings: !active,
  size: count * 7_000_000,
  dir,
  saves: Array.from({ length: count }, (_, k) => ({ file: `AutoSave_${120 - k * (k > 2 ? 9 : 1)}.save.gz`, number: 120 - k * (k > 2 ? 9 : 1), size: 7_043_043 - k * 9000, modified: now - age - k * 120_000 * (k > 2 ? 9 : 1), latest: k === 0 })),
});

const LOG_SAMPLES = [
  'Triggering AutoSave 121!',
  "PersistenceV2 - Finished Saving to 'D:\\VRisingServers\\Crimson-Covenant\\save-data\\Saves\\v4\\world1\\AutoSave_121.save.gz'. Total Persistent ChunkCount 2659.",
  '[Server] Loaded Chunk 7,21',
  "User '{Steam 76561198000000002}' '76561198000000002', approvedUserIndex: 1, Character: 'Mina' connected as ID '1,1', Entity '27583,1'.",
  '[rcon] 127.0.0.1 sent packet ExecCommand!',
  'Streamed scene with    5ms latency from D:/VRisingServers/Crimson-Covenant/VRisingServer_Data/StreamingAssets/EntityScenes/cd01.0.entities',
];

function emitTelemetry() {
  const t = Date.now() / 1000;
  const running = instances.filter((i) => statuses[i.id]?.state === 'running' || statuses[i.id]?.state === 'starting');
  mockEmit('telemetry', {
    ts: Date.now(),
    system: {
      cpu: 22 + Math.sin(t / 7) * 8 + Math.random() * 6,
      memUsed: 24.2e9 + Math.sin(t / 30) * 4e8,
      memTotal: 68.4e9,
      rxBps: 180_000 + Math.random() * 90_000,
      txBps: 260_000 + Math.random() * 120_000,
      cores: 24,
      perCore: Array.from({ length: 24 }, (_, i) => Math.max(1, 25 + Math.sin(t / 3 + i) * 20 + Math.random() * 12)),
    },
    servers: running.map((i, k) => ({
      id: i.id,
      cpu: 4 + k * 3 + Math.sin(t / 5) * 2.5 + Math.random() * 2,
      mem: 2.7e9 + k * 6e8 + Math.sin(t / 40) * 1.2e8,
      virt: 5.6e9,
      readBps: Math.random() < 0.2 ? Math.random() * 2e6 : Math.random() * 40_000,
      writeBps: Math.random() < 0.1 ? 4e6 + Math.random() * 3e6 : Math.random() * 120_000,
      uptime: Math.round((Date.now() - (statuses[i.id].startedAt ?? Date.now())) / 1000),
    })),
  });
}

function emitStatus(id: string, patch: Partial<ServerStatus>) {
  mockEmit('server-status', status(id, patch));
}

function log(id: string, source: string, line: string) {
  mockEmit('log-lines', { id, source, lines: [line], ts: Date.now() });
}

const events: EventRow[] = [
  { id: 6, serverId: 'a1b2c3d4-0001', ts: now - 1200_000, level: 'info', kind: 'player', message: 'Mina joined Crimson Covenant' },
  { id: 5, serverId: 'a1b2c3d4-0001', ts: now - 3600_000 * 1.2, level: 'info', kind: 'player', message: 'Vlad joined Crimson Covenant' },
  { id: 4, serverId: 'a1b2c3d4-0001', ts: now - 3600_000 * 2.2, level: 'success', kind: 'lifecycle', message: 'Crimson Covenant is online' },
  { id: 3, serverId: 'a1b2c3d4-0001', ts: now - 3600_000 * 2.3, level: 'success', kind: 'update', message: 'Updated to build 25169871' },
  { id: 2, serverId: 'a1b2c3d4-0001', ts: now - 3600_000 * 26, level: 'error', kind: 'crash', message: 'Crimson Covenant stopped unexpectedly – restarting in 10s' },
  { id: 1, serverId: 'a1b2c3d4-0001', ts: now - 3600_000 * 30, level: 'info', kind: 'config', message: 'Admin added: 76561198000000001' },
];

function metrics(since: number): MetricRow[] {
  const out: MetricRow[] = [];
  for (let ts = Math.max(since, now - 7 * 86400_000); ts < now; ts += 60_000 * 5) {
    const h = new Date(ts).getHours();
    const evening = h >= 18 && h <= 23 ? 1 : h >= 12 ? 0.5 : 0.1;
    const players = Math.max(0, Math.round(evening * 9 + Math.sin(ts / 3.6e6) * 2.5));
    out.push({ ts, cpu: 3 + players * 1.1 + Math.random(), mem: 2.6e9 + players * 9e7, readBps: Math.random() * 6e4, writeBps: Math.random() * 1.6e5, players });
  }
  return out;
}

export function installDevMock() {
  const find = (id: unknown) => instances.find((i) => i.id === id)!;
  const acc = (id: unknown) => (access[id as string] ??= { admins: [], bans: [] });
  installMock({
    get_app_info: () => ({ version: '1.0.0', dataDir: 'C:\\Users\\me\\AppData\\Roaming\\com.vrisingservermanager.app', portable: false, appId: 1829350, cores: 24, totalMemory: 68.4e9, os: 'Windows 11 Pro', hostname: 'CASTLE-PC', lostSecrets: [] }),
    get_settings: () => settings,
    save_settings: ({ settings: s }) => void (settings = s as AppSettings),
    cancel_task: () => undefined,
    test_webhook: () => undefined,
    app_quit: () => undefined,
    window_hide: () => undefined,
    probe_folder: () => ({ exists: true, writable: true, empty: true, hasServer: false, freeBytes: 812e9 }),
    list_instances: () => instances,
    get_statuses: () => instances.map((i) => status(i.id)),
    suggest_ports: () => ({ port: 9876 + instances.length * 10, queryPort: 9877 + instances.length * 10, rconPort: 25575 + instances.length }),
    create_instance: ({ input }) => {
      const inp = input as { name: string; color: string; config: ServerConfig; installNow: boolean };
      const inst = makeInstance(`mock-${Date.now()}`, inp.name, inp.config.port, inp.color);
      inst.config = inp.config;
      instances = [...instances, inst];
      status(inst.id, { state: inp.installNow ? 'installing' : 'notInstalled', installedBuild: null });
      if (inp.installNow) {
        const task = `t-${Date.now()}`;
        let p = 0;
        const iv = setInterval(() => {
          p += 0.1;
          mockEmit('task', { taskId: task, instanceId: inst.id, kind: 'steamcmd', title: `Installing ${inst.name}`, message: `Downloading – ${(p * 100).toFixed(1)}% (${(p * 0.3).toFixed(2)} / 0.30 GB)`, progress: Math.min(1, p), done: p >= 1, error: null });
          if (p >= 1) {
            clearInterval(iv);
            emitStatus(inst.id, { state: 'stopped', installedBuild: '25169871' });
          }
        }, 400);
      }
      return inst;
    },
    update_instance: ({ instance }) => {
      const i = instance as ServerInstance;
      instances = instances.map((x) => (x.id === i.id ? i : x));
      if (statuses[i.id]?.state === 'running') emitStatus(i.id, { pendingRestart: true });
      return i;
    },
    validate_config: ({ config }) => {
      const c = config as ServerConfig;
      const out: { level: string; message: string }[] = [];
      if (c.port === c.queryPort) out.push({ level: 'error', message: 'The game and query ports must be different.' });
      if (c.rconEnabled && !c.rconPassword) out.push({ level: 'error', message: 'RCON needs a password.' });
      return out;
    },
    reorder_instances: () => undefined,
    delete_instance: ({ id }) => void (instances = instances.filter((i) => i.id !== id)),
    clone_instance: ({ id, name }) => {
      const src = find(id);
      const c = { ...structuredClone(src), id: `mock-${Date.now()}`, name: name as string, config: { ...structuredClone(src.config), port: 9876 + instances.length * 10, queryPort: 9877 + instances.length * 10 } };
      instances = [...instances, c];
      status(c.id, { state: 'notInstalled', installedBuild: null });
      return c;
    },
    find_existing_installs: () => ['G:\\SteamLibrary\\steamapps\\common\\VRisingDedicatedServer'],
    import_existing: ({ path }) => {
      const c = makeInstance(`mock-${Date.now()}`, 'Imported Server', 9906, 'sky', { installDir: path as string });
      instances = [...instances, c];
      status(c.id);
      return c;
    },
    install_server: ({ id }) => {
      emitStatus(id as string, { state: 'updating' });
      setTimeout(() => emitStatus(id as string, { state: 'stopped' }), 2500);
    },
    check_update: () => false,
    start_server: ({ id }) => {
      const sid = id as string;
      emitStatus(sid, { state: 'starting', pid: 4242, startedAt: Date.now(), players: [] });
      log(sid, 'manager', 'Launching VRisingServer.exe (PID 4242) -persistentDataPath "…\\save-data" -logFile "…\\logs\\VRisingServer.log"');
      setTimeout(() => {
        log(sid, 'server', 'Bootstrap - Boot Time: 2026-10-15 11:54:59 UTC, Version: VRisingServer v1.1.15.0-r101082-b2 (202609071358) (Build) (Release) (m)');
        log(sid, 'server', 'PlatformSystemBase - Server connected to Steam successfully!');
        log(sid, 'server', '[Server] Startup Completed - Disabling Scene Loading Systems');
        emitStatus(sid, { state: 'running', readyAt: Date.now(), queryPlayers: 0, gameVersion: '1.1.15.0-r101082-b2', publicIp: '203.0.113.42', rconOk: true });
        mockEmit('server-event', { id: sid, level: 'success', message: `${find(sid).name} is online`, ts: Date.now() });
      }, 2500);
    },
    stop_server: ({ id }) => {
      const sid = id as string;
      emitStatus(sid, { state: 'stopping' });
      log(sid, 'manager', 'Asking the server to save and shut down…');
      setTimeout(() => {
        log(sid, 'server', 'GameBootstrap.OnApplicationQuit()');
        log(sid, 'server', 'SaveOnExit() - Saving the world on exit!');
        log(sid, 'server', 'SaveOnExit() - Finished saving the world on exit!');
        log(sid, 'manager', 'Server saved and stopped.');
        emitStatus(sid, { state: 'stopped', pid: null, startedAt: null, players: [], queryPlayers: null, pendingRestart: false, rconOk: null });
      }, 1800);
    },
    restart_server: ({ id, warnMins }) => {
      const sid = id as string;
      if (warnMins) {
        emitStatus(sid, { countdown: { at: Date.now() + (warnMins as number) * 60_000, action: 'restart' } });
        log(sid, 'manager', `Players warned: restart in ${warnMins} minute(s).`);
        return;
      }
      emitStatus(sid, { state: 'restarting' });
      setTimeout(() => emitStatus(sid, { state: 'running', startedAt: Date.now(), pendingRestart: false }), 3000);
    },
    cancel_deferred: ({ id }) => emitStatus(id as string, { waiting: null, countdown: null }),
    get_launch_line: ({ id }) => `"${find(id).installDir}\\VRisingServer.exe" -persistentDataPath "${find(id).installDir}\\save-data" -logFile "${find(id).installDir}\\logs\\VRisingServer.log"`,
    set_console_visible: () => 1,
    clear_crash_state: () => undefined,
    query_server: ({ id }) => ({
      info: statuses[id as string]?.state === 'running' ? { name: find(id).config.name, players: statuses[id as string].queryPlayers ?? 0, maxPlayers: find(id).config.maxConnectedUsers, version: '0.0.0.1', password: !!find(id).config.password, keywords: 'pve,cs4,hc,ded,dif_no', pingMs: 1 } : null,
      players: (statuses[id as string]?.players ?? []).filter((p) => p.name).map((p) => ({ name: p.name, score: 0, durationSecs: (Date.now() - p.since) / 1000 })),
    }),
    read_config: ({ id, file }) => {
      const i = find(id);
      const dir = `${i.installDir}\\save-data\\Settings`;
      const a = acc(id);
      const text = file === 'host' ? hostText(i.config) : file === 'game' ? JSON.stringify({ GameModeType: 'PvE', ClanSize: 4, SunDamageModifier: 1.0, GameTimeModifiers: { DayDurationInSeconds: 1080.0 } }, null, 2) + '\n' : (file === 'admins' ? a.admins : a.bans).map((x) => x.steamId).join('\n') + '\n';
      const name = { host: 'ServerHostSettings.json', game: 'ServerGameSettings.json', admins: 'adminlist.txt', bans: 'banlist.txt' }[file as string];
      return { path: `${dir}\\${name}`, exists: true, text, modified: now - 60000, pending: false };
    },
    write_config: ({ id }) => ({ restartNeeded: statuses[id as string]?.state === 'running', instance: find(id) }),
    list_config_history: () => [['D:\\x\\_config-history\\ServerHostSettings.20261009-101500.json', now - 3600_000]],
    read_text_file: ({ id }) => hostText(find(id).config),
    list_presets: () => ({ settings: KNOWN_PRESETS, difficulty: KNOWN_DIFFICULTIES }),
    read_preset: () => ({ GameModeType: 'PvP', ClanSize: 2, 'CastleStatModifiers_Global.CastleLimit': 1 }),
    get_access: ({ id }) => acc(id),
    set_access: ({ id, list, steamId, add }) => {
      const a = acc(id);
      const arr = list === 'admins' ? a.admins : a.bans;
      const has = arr.some((x) => x.steamId === steamId);
      if (add && !has) arr.push({ steamId: steamId as string, name: null, online: false });
      if (!add && has) arr.splice(arr.findIndex((x) => x.steamId === steamId), 1);
      return add !== has;
    },
    rcon_command: ({ command }) => (command === 'help' ? 'announce        - sends a free form announcement to all connected clients\nannouncerestart - Sends an announcement that the server will go down for restart' : command === 'version' ? 'v1.1.15.0-r101082-b2 (202609071358)' : ''),
    announce: () => undefined,
    kick_player: () => undefined,
    read_log_tail: () => [
      'Loaded VersionDataSettings:',
      'PersistentDataPath: D:\\VRisingServers\\Crimson-Covenant\\save-data root: D:\\VRisingServers\\Crimson-Covenant\\save-data\\Saves',
      'Bootstrap - Boot Time: 2026-10-15 09:31:12 UTC, Version: VRisingServer v1.1.15.0-r101082-b2 (202609071358) (Build) (Release) (m)',
      'PlatformSystemBase - Steam GameServer Initialized!',
      'SteamNetworking - Successfully logged in with the SteamGameServer API. SteamID: 90294949908879360',
      'PlatformSystemBase - Server connected to Steam successfully!',
      'CreateAndHostServer - SaveDirectory:D:\\VRisingServers\\Crimson-Covenant\\save-data\\Saves\\v4\\world1, Loaded Save:AutoSave_118.save.gz',
      'Starting RCON listener, binding to: 0.0.0.0, on port: 25575, timeout: 300',
      'Opening SteamIPv4 socket on port: 9876. Socket: 131073',
      'PlatformSystemBase - OnPolicyResponse - Public IP: 203.0.113.42',
      '[Server] Startup Completed - Disabling Scene Loading Systems',
      "User '{Steam 76561198000000001}' '76561198000000001', approvedUserIndex: 0, Character: 'Vlad' connected as ID '0,1', Entity '27581,1'.",
      ...LOG_SAMPLES,
    ],
    list_log_files: () => [{ path: 'D:\\x\\logs\\backup\\VRisingServer_2026-10-14T07-14-49.log', name: 'VRisingServer_2026-10-14T07-14-49.log', size: 1_263_168, modified: now - 86400_000 }],
    list_worlds: ({ id }) => {
      const i = find(id);
      const base = `${i.installDir}\\save-data\\Saves\\v4`;
      return i.id === 'a1b2c3d4-0001' ? [world(`${base}\\world1`, 'world1', true, 70_000), world(`${base}\\season-1`, 'season-1', false, 86400_000 * 20, 4)] : [];
    },
    list_local_worlds: () => [{ world: world('C:\\Users\\me\\AppData\\LocalLow\\Stunlock Studios\\VRising\\Saves\\v4\\7f3c9a1b-2d44', '7f3c9a1b-2d44', false, 86400_000 * 2, 3), source: 'Local saves' }],
    scan_world_folder: ({ path }) => [world(path as string, 'my-old-world', false, 86400_000 * 5, 3)],
    import_world: ({ name }) => ({ name, files: 5 }),
    restore_autosave: () => 'AutoSave_121.save.gz',
    export_world: () => 8,
    duplicate_world: ({ newName }) => newName,
    rename_world: ({ newName }) => newName,
    check_world: () =>
      world('', 'world1', true, 0).saves.map((x, k) => ({ file: x.file, number: x.number, ok: k !== 4, bytes: k === 4 ? 0 : 41_200_512 - k * 9000, error: k === 4 ? 'damaged (corrupt deflate stream)' : null })),
    list_rule_presets: () => rulePresets,
    save_rule_preset: ({ name, settings }) => {
      const p = { name: name as string, createdAt: Date.now(), settings: settings as Record<string, number | string | boolean> };
      rulePresets = [...rulePresets.filter((x) => x.name.toLowerCase() !== p.name.toLowerCase()), p];
      return p;
    },
    delete_rule_preset: ({ name }) => {
      rulePresets = rulePresets.filter((x) => x.name !== name);
    },
    delete_world: () => undefined,
    reset_world: () => null,
    activate_world: ({ id, name }) => {
      const i = find(id);
      i.config = { ...i.config, saveName: name as string };
      return i;
    },
    metrics_history: ({ since }) => metrics(since as number),
    event_history: ({ id }) => events.filter((e) => !id || e.serverId === id),
    player_sessions: () => [
      { id: 3, name: 'Mina', joinedAt: now - 1200_000, leftAt: null, steamId: '76561198000000002' },
      { id: 2, name: 'Vlad', joinedAt: now - 3600_000 * 1.2, leftAt: null, steamId: '76561198000000001' },
      { id: 1, name: 'Mina', joinedAt: now - 86400_000, leftAt: now - 86400_000 + 5400_000, steamId: '76561198000000002' },
    ],
    known_players: () => [
      { name: 'Mina', sessions: 7, totalMs: 3600_000 * 11.5, firstSeen: now - 86400_000 * 6, lastSeen: now, steamId: '76561198000000002' },
      { name: 'Vlad', sessions: 12, totalMs: 3600_000 * 26, firstSeen: now - 86400_000 * 9, lastSeen: now, steamId: '76561198000000001' },
      { name: 'Griefer', sessions: 2, totalMs: 3600_000 * 1.7, firstSeen: now - 86400_000 * 4, lastSeen: now - 86400_000 * 3, steamId: '76561198000000666' },
    ],
    build_history: () => [{ buildId: '25169871', branch: 'public', ts: now - 3600_000 * 2.3 }],
    create_backup: ({ label }) => {
      const b = { ...backups[0], name: 'new.zip', path: `D:\\x\\${Date.now()}.zip`, createdAt: Date.now(), label: (label as string) || 'Manual backup', kind: 'manual' };
      backups.unshift(b);
      return b;
    },
    list_backups: () => backups,
    get_backup_dir: () => 'D:\\VRisingServers\\Crimson-Covenant\\Backups',
    restore_backup: () => 6,
    verify_backup: () => ({ ok: true, files: 6, worlds: ['v4/world1', 'v4/season-1'], hasSettings: true, bytes: 82_400_000, error: null }),
    delete_backup: ({ path }) => {
      const i = backups.findIndex((b) => b.path === path);
      if (i >= 0) backups.splice(i, 1);
    },
    export_pack: () => undefined,
    read_pack: () => ({ format: 1, appVersion: '1.0.0', exportedAt: now - 86400_000, instance: makeInstance('x', 'Friend’s Server', 9876, 'gold'), hasSaves: true, hasConfig: true, includesSecrets: false }),
    import_pack: ({ name }) => {
      const c = makeInstance(`mock-${Date.now()}`, (name as string) || 'Imported', 9916, 'gold');
      instances = [...instances, c];
      status(c.id, { state: 'notInstalled', installedBuild: null });
      return c;
    },
    firewall_state: () => ({ ruleExists: true, portsOk: true, rulePorts: '9876,9877', programRule: true, blockedBy: [] }),
    add_firewall_rules: () => undefined,
    remove_firewall_rules: () => undefined,
    net_info: () => ({ publicIp: '203.0.113.42', local: [{ interface: 'Ethernet', ip: '192.168.1.20' }], gateway: '192.168.1.1' }),
    steam_listing: () => [{ addr: '203.0.113.42:9877', gameport: 9876, appid: 1604030, steamid: '90294949908879360' }],
    upnp_probe: () => ({
      found: true,
      gateway: '192.168.1.1',
      routerName: 'Archer AX55',
      manufacturer: 'TP-Link',
      model: 'AX3000',
      externalIp: '203.0.113.42',
      wanKind: 'public',
      mappings: [
        { externalPort: 9876, internalPort: 9876, internalClient: '192.168.1.20', description: 'V Rising Crimson Covenant (9876)', enabled: true },
        { externalPort: 9877, internalPort: 9877, internalClient: '192.168.1.20', description: 'V Rising Crimson Covenant (9877)', enabled: true },
      ],
      error: null,
    }),
    upnp_map: ({ id }) => [`UDP ${find(id).config.port} → 192.168.1.20:${find(id).config.port} forwarded`, `UDP ${find(id).config.queryPort} → 192.168.1.20:${find(id).config.queryPort} forwarded`],
    upnp_unmap: () => undefined,
    run_diagnostics: () => [
      { id: 'install', title: 'Server files', level: 'ok', detail: 'D:\\VRisingServers\\Crimson-Covenant\\VRisingServer.exe', fix: '' },
      { id: 'hostfile', title: 'ServerHostSettings.json', level: 'ok', detail: 'The file parses as valid JSON.', fix: '' },
      { id: 'gamefile', title: 'ServerGameSettings.json', level: 'ok', detail: 'The file parses as valid JSON.', fix: '' },
      { id: 'settings', title: 'Server settings', level: 'ok', detail: 'Everything the manager can check looks right.', fix: '' },
      { id: 'admins', title: 'Admins', level: 'ok', detail: '1 admin(s) in adminlist.txt.', fix: '' },
      { id: 'ports', title: 'Ports', level: 'ok', detail: 'UDP 9876 (game) and 9877 (query) are available (used by this server).', fix: '' },
      { id: 'rcon', title: 'RCON', level: 'ok', detail: 'Answering on TCP 25575 (v1.1.15.0-r101082-b2). Announcements and restart warnings work.', fix: '' },
      { id: 'firewall', title: 'Windows Firewall', level: 'warn', detail: 'No inbound rule for this server – players outside your PC may not reach it.', fix: 'firewall' },
      { id: 'ram', title: 'Memory', level: 'ok', detail: '63.8 GB installed – 8 GB recommended for 20 players.', fix: '' },
      { id: 'listing', title: 'Steam server list', level: 'ok', detail: 'Listed at 203.0.113.42 – players can find “Crimson Covenant” in the server browser.', fix: '' },
    ],
    disk_usage: () => ({ install: 2.1e9, saves: 180e6, backups: 42e6, logs: 6.2e6 }),
  });

  setInterval(emitTelemetry, 1000);
  let k = 0;
  setInterval(() => {
    for (const i of instances) if (statuses[i.id]?.state === 'running') log(i.id, 'server', LOG_SAMPLES[k++ % LOG_SAMPLES.length]);
  }, 1700);
}
