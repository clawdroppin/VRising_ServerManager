import type { ServerConfig } from './types';

/** A fresh profile's ServerHostSettings values (mirrors ServerConfig::default in models.rs). */
export function defaultConfig(over: Partial<ServerConfig> = {}): ServerConfig {
  return {
    name: 'V Rising Server',
    description: '',
    address: '',
    port: 9876,
    queryPort: 9877,
    maxConnectedUsers: 40,
    maxConnectedAdmins: 4,
    serverFps: 30,
    saveName: 'world1',
    password: '',
    secure: true,
    listOnSteam: true,
    listOnEos: false,
    lanMode: false,
    hideIpAddress: false,
    autoSaveCount: 20,
    autoSaveInterval: 120,
    compressSaveFiles: true,
    gameSettingsPreset: '',
    gameDifficultyPreset: '',
    adminOnlyDebugEvents: true,
    disableDebugEvents: false,
    rconEnabled: true,
    rconPort: 25575,
    rconPassword: '',
    apiEnabled: false,
    apiPort: 9090,
    gameSettings: {},
    ...over,
  };
}
