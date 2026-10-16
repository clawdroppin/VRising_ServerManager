// Mirrors src-tauri/src/models.rs (serde camelCase).

export interface AppSettings {
  steamcmdDir: string | null;
  defaultInstallRoot: string | null;
  backupDir: string | null;
  lastDataDir?: string | null;
  telemetryIntervalMs: number;
  confirmDestructive: boolean;
  reduceMotion: boolean;
  checkUpdatesOnLaunch: boolean;
  accent: string;
  closeToTray: boolean;
  desktopNotifications: boolean;
  streamerMode: boolean;
  webhookUrl: string;
  webhookLevels: string[];
  metricsRetentionDays: number;
}

export type SettingValue = number | string | boolean;

export interface ServerConfig {
  name: string;
  description: string;
  /** Bind address; empty = all interfaces. */
  address: string;
  port: number;
  queryPort: number;
  maxConnectedUsers: number;
  maxConnectedAdmins: number;
  serverFps: number;
  saveName: string;
  password: string;
  secure: boolean;
  listOnSteam: boolean;
  listOnEos: boolean;
  lanMode: boolean;
  hideIpAddress: boolean;
  autoSaveCount: number;
  autoSaveInterval: number;
  compressSaveFiles: boolean;
  /** A GameSettingPresets file name – when set the server ignores gameSettings. */
  gameSettingsPreset: string;
  gameDifficultyPreset: string;
  adminOnlyDebugEvents: boolean;
  disableDebugEvents: boolean;
  rconEnabled: boolean;
  rconPort: number;
  rconPassword: string;
  apiEnabled: boolean;
  apiPort: number;
  /** ServerGameSettings.json flattened: `GameTimeModifiers.DayDurationInSeconds` → value. */
  gameSettings: Record<string, SettingValue>;
}

export interface LaunchSettings {
  /** -persistentDataPath; relative = inside the install folder. */
  dataDir: string;
  upnp: boolean;
  showConsole: boolean;
  priority: 'idle' | 'belowNormal' | 'normal' | 'aboveNormal' | 'high' | string;
  affinity: number[];
  extraArgs: string;
}

export type ScheduleAction = 'restart' | 'backup' | 'update' | 'stop' | 'start';

export interface ScheduleEntry {
  enabled: boolean;
  time: string;
  days: number[];
  action: ScheduleAction | string;
}

export interface AutomationSettings {
  autoStart: boolean;
  autoRestart: boolean;
  restartDelaySecs: number;
  crashLimit: number;
  stopTimeoutSecs: number;
  schedules: ScheduleEntry[];
  backupIntervalMins: number;
  backupKeep: number;
  backupOnStop: boolean;
  backupBeforeUpdate: boolean;
  updateOnStart: boolean;
  updateCheckMins: number;
  autoUpdate: boolean;
  waitForEmpty: boolean;
  memoryLimitMb: number;
  maxUptimeHours: number;
  idleStopMins: number;
  restartWarningMins: number;
  announcements: Announcement[];
}

export interface Announcement {
  enabled: boolean;
  message: string;
  everyMins: number;
}

export interface ServerInstance {
  id: string;
  name: string;
  color: string;
  installDir: string;
  createdAt: number;
  notes: string;
  branch: string;
  branchPassword: string;
  config: ServerConfig;
  launch: LaunchSettings;
  automation: AutomationSettings;
}

export type ServerState = 'notInstalled' | 'stopped' | 'installing' | 'updating' | 'starting' | 'running' | 'stopping' | 'restarting' | 'crashed';

export interface OnlinePlayer {
  /** Character name – empty for a brand-new player until they create a character. */
  name: string;
  since: number;
  steamId: string | null;
}

export interface ServerStatus {
  id: string;
  state: ServerState;
  pid: number | null;
  startedAt: number | null;
  readyAt: number | null;
  installedBuild: string | null;
  latestBuild: string | null;
  gameVersion: string | null;
  daysRunning: number | null;
  crashCount: number;
  crashLoop: boolean;
  pendingRestart: boolean;
  players: OnlinePlayer[];
  queryPlayers: number | null;
  nextSchedule: { at: number; action: string } | null;
  lastBackup: number | null;
  lastExitCode: number | null;
  busy: string | null;
  rconOk: boolean | null;
  steamId: string | null;
  publicIp: string | null;
  lastSave: number | null;
  waiting: string | null;
  countdown: { at: number; action: string } | null;
}

export interface ProcSample {
  id: string;
  cpu: number;
  mem: number;
  virt: number;
  readBps: number;
  writeBps: number;
  uptime: number;
}

export interface SystemSample {
  cpu: number;
  memUsed: number;
  memTotal: number;
  rxBps: number;
  txBps: number;
  cores: number;
  perCore: number[];
}

export interface TelemetryEvent {
  ts: number;
  system: SystemSample;
  servers: ProcSample[];
}

export interface TaskEvent {
  taskId: string;
  instanceId: string | null;
  kind: string;
  title: string;
  message: string;
  progress: number | null;
  done: boolean;
  error: string | null;
}

export interface LogBatch {
  id: string;
  source: 'server' | 'manager' | 'steamcmd' | string;
  lines: string[];
  ts: number;
}

export interface ServerEvent {
  id: string;
  level: 'info' | 'success' | 'warn' | 'error';
  message: string;
  ts: number;
}

export interface PlayerEvent {
  id: string;
  name: string;
  kind: 'join' | 'leave';
  ts: number;
}

export interface BackupInfo {
  path: string;
  name: string;
  size: number;
  createdAt: number;
  label: string;
  kind: string;
  files: number;
}

export interface AutoSave {
  file: string;
  number: number;
  size: number;
  modified: number;
  latest: boolean;
}

export interface SaveCheck {
  file: string;
  number: number;
  ok: boolean;
  bytes: number;
  error: string | null;
}

export interface VerifyResult {
  ok: boolean;
  files: number;
  worlds: string[];
  hasSettings: boolean;
  bytes: number;
  error: string | null;
}

export interface RulePreset {
  name: string;
  createdAt: number;
  settings: Record<string, SettingValue>;
}

export interface World {
  name: string;
  version: string;
  active: boolean;
  saves: AutoSave[];
  savedAt: number | null;
  startDate: string | null;
  hasSettings: boolean;
  size: number;
  dir: string;
}

export interface LocalWorld {
  world: World;
  source: string;
}

export interface ConfigFile {
  path: string;
  exists: boolean;
  text: string;
  modified: number | null;
  pending: boolean;
}

export type ConfigFileKind = 'host' | 'game' | 'admins' | 'bans';

export interface ConfigIssue {
  level: 'error' | 'warn' | 'info';
  message: string;
}

export interface AccessEntry {
  steamId: string;
  name: string | null;
  online: boolean;
}

export interface AccessView {
  admins: AccessEntry[];
  bans: AccessEntry[];
}

export interface PortSet {
  port: number;
  queryPort: number;
  rconPort: number;
}

export interface Presets {
  settings: string[];
  difficulty: string[];
}

export interface PackManifest {
  format: number;
  appVersion: string;
  exportedAt: number;
  instance: ServerInstance;
  hasSaves: boolean;
  hasConfig: boolean;
  includesSecrets: boolean;
}

export interface DiagCheck {
  id: string;
  title: string;
  level: 'ok' | 'warn' | 'error' | 'info';
  detail: string;
  fix: '' | 'firewall' | 'install' | 'validate' | 'settings' | 'admins' | 'config' | 'ports' | 'update' | 'log' | 'rcon' | string;
}

export interface AppInfo {
  version: string;
  dataDir: string;
  portable: boolean;
  appId: number;
  cores: number;
  totalMemory: number;
  os: string;
  hostname: string;
  lostSecrets: string[];
}

export interface FolderProbe {
  exists: boolean;
  writable: boolean;
  empty: boolean;
  hasServer: boolean;
  freeBytes: number | null;
}

export interface FirewallState {
  ruleExists: boolean;
  portsOk: boolean;
  rulePorts: string;
  programRule: boolean;
  blockedBy: string[];
}

export interface NetInfo {
  publicIp: string | null;
  local: { interface: string; ip: string }[];
  gateway: string | null;
}

export interface UpnpMapping {
  externalPort: number;
  internalPort: number;
  internalClient: string;
  description: string;
  enabled: boolean;
}

export interface UpnpInfo {
  found: boolean;
  gateway: string | null;
  routerName: string | null;
  manufacturer: string | null;
  model: string | null;
  externalIp: string | null;
  wanKind: 'public' | 'private' | 'cgnat' | 'unknown';
  mappings: UpnpMapping[];
  error: string | null;
}

export interface SteamListing {
  addr: string;
  gameport: number;
  appid: number;
  steamid: string;
}

export interface A2sInfo {
  name: string;
  players: number;
  maxPlayers: number;
  version: string;
  password: boolean;
  keywords: string;
  pingMs: number;
}

export interface QueryResult {
  info: A2sInfo | null;
  players: { name: string; score: number; durationSecs: number }[];
}

export interface LogFile {
  path: string;
  name: string;
  size: number;
  modified: number;
}

export interface DiskUsage {
  install: number;
  saves: number;
  backups: number;
  logs: number;
}

export interface MetricRow {
  ts: number;
  cpu: number;
  mem: number;
  readBps: number;
  writeBps: number;
  players: number;
}

export interface EventRow {
  id: number;
  serverId: string | null;
  ts: number;
  level: 'info' | 'success' | 'warn' | 'error' | string;
  kind: string;
  message: string;
}

export interface SessionRow {
  id: number;
  name: string;
  joinedAt: number;
  leftAt: number | null;
  steamId: string | null;
}

export interface PlayerSummary {
  name: string;
  sessions: number;
  totalMs: number;
  firstSeen: number;
  lastSeen: number;
  steamId: string | null;
}

export interface BuildRow {
  buildId: string;
  branch: string;
  ts: number;
}
