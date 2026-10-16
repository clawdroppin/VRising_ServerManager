// Gameplay rules of ServerGameSettings.json, keyed by their flattened path
// (`GameTimeModifiers.DayDurationInSeconds`). Defaults are the values the dedicated server ships
// in VRisingServer_Data/StreamingAssets/Settings (v1.1.15.0); enum values are the names the server
// accepts. Keys missing here still round-trip untouched – they show up under "Other settings".

export type SettingKind = 'factor' | 'number' | 'bool' | 'enum' | 'duration' | 'hour';
export type SettingValue = number | string | boolean;

export interface GameSetting {
  key: string;
  label: string;
  description: string;
  kind: SettingKind;
  default: SettingValue;
  min?: number;
  max?: number;
  step?: number;
  /** For `number`: what the value counts. */
  unit?: string;
  options?: { value: string; label: string }[];
  group: GroupId;
}

export type GroupId = 'general' | 'pvp' | 'castle' | 'limits' | 'loot' | 'vampire' | 'units' | 'crafting' | 'time' | 'inactivity' | 'traders' | 'windows' | 'war';

export const GROUPS: { id: GroupId; label: string; blurb: string }[] = [
  { id: 'general', label: 'Game mode & social', blurb: 'PvP or PvE, difficulty, clans, chat and starting progression.' },
  { id: 'pvp', label: 'PvP & sieges', blurb: 'When players and castles can be attacked, siege golems and PvP protection for new players.' },
  { id: 'castle', label: 'Castles', blurb: 'Decay, raids, relocation and what a castle heart can be.' },
  { id: 'limits', label: 'Castle limits', blurb: 'How many castles, floors and servants each player or clan may have.' },
  { id: 'loot', label: 'Loot & resources', blurb: 'Drop rates, resource yield, stack sizes and what happens to items on death.' },
  { id: 'vampire', label: 'Vampires', blurb: 'Player stats, blood drain, sun and holy damage, durability.' },
  { id: 'units', label: 'Enemies & V Blood', blurb: 'Health, power and level of world creatures and V Blood bosses.' },
  { id: 'crafting', label: 'Crafting & building', blurb: 'Costs and speeds of building, crafting, research, refining and servants.' },
  { id: 'time', label: 'Day, night & blood moon', blurb: 'Length of a day, when the sun rises and sets, and blood moons.' },
  { id: 'inactivity', label: 'Inactivity & disconnects', blurb: 'What happens to offline players and abandoned characters.' },
  { id: 'traders', label: 'Traders', blurb: 'Merchant stock, prices and restocking.' },
  { id: 'windows', label: 'Raid & PvP windows', blurb: 'The hours “time restricted” PvP and castle damage are allowed.' },
  { id: 'war', label: 'Rift incursions (war events)', blurb: 'How often and how long rift incursions run, and their rewards per group size.' },
];

const opt = (...v: [string, string][]) => v.map(([value, label]) => ({ value, label }));
const f = (key: string, label: string, description: string, group: GroupId, def = 1, min = 0, max = 5, step = 0.05): GameSetting => ({ key, label, description, kind: 'factor', default: def, min, max, step, group });
const n = (key: string, label: string, description: string, group: GroupId, def: number, min: number, max: number, unit = '', step = 1): GameSetting => ({ key, label, description, kind: 'number', default: def, min, max, step, unit, group });
const b = (key: string, label: string, description: string, group: GroupId, def: boolean): GameSetting => ({ key, label, description, kind: 'bool', default: def, group });
const e = (key: string, label: string, description: string, group: GroupId, def: string, options: { value: string; label: string }[]): GameSetting => ({ key, label, description, kind: 'enum', default: def, options, group });
const d = (key: string, label: string, description: string, group: GroupId, def: number, min: number, max: number, step = 60): GameSetting => ({ key, label, description, kind: 'duration', default: def, min, max, step, group });
const h = (key: string, label: string, description: string, group: GroupId, def: number, max = 23): GameSetting => ({ key, label, description, kind: 'hour', default: def, min: 0, max, group });

function window(prefix: string, label: string): GameSetting[] {
  const p = `PlayerInteractionSettings.${prefix}`;
  return [
    h(`${p}.StartHour`, `${label} – start hour`, 'Local server time (see time zone).', 'windows', 20),
    h(`${p}.StartMinute`, `${label} – start minute`, '', 'windows', 0, 59),
    h(`${p}.EndHour`, `${label} – end hour`, '', 'windows', 22),
    h(`${p}.EndMinute`, `${label} – end minute`, '', 'windows', 0, 59),
  ];
}

function heart(level: number, floors: number, servants: number): GameSetting[] {
  const p = `CastleStatModifiers_Global.HeartLimits.Level${level}`;
  return [
    n(`${p}.FloorLimit`, `Heart level ${level} – floors`, 'Floor tiles a castle heart of this level supports.', 'limits', floors, 1, 2000, 'tiles'),
    n(`${p}.ServantLimit`, `Heart level ${level} – servants`, '', 'limits', servants, 0, 50, 'servants'),
    n(`${p}.HeightLimit`, `Heart level ${level} – height`, 'Storeys a castle may have.', 'limits', 3, 1, 10, 'floors'),
  ];
}

function warScaling(players: number, points: number): GameSetting[] {
  const p = `WarEventGameSettings.ScalingPlayers${players}`;
  const who = players === 1 ? 'Solo' : `${players} players`;
  return [f(`${p}.PointsModifier`, `${who} – points`, 'Incursion points when this many players take part.', 'war', points, 0, 3), f(`${p}.DropModifier`, `${who} – drops`, '', 'war', points, 0, 3)];
}

export const GAME_SETTINGS: GameSetting[] = [
  // ------------------------------------------------------------------ general
  e('GameModeType', 'Game mode', 'PvP lets players fight each other and raid castles; PvE turns player damage off.', 'general', 'PvP', opt(['PvP', 'PvP'], ['PvE', 'PvE'])),
  e('GameDifficulty', 'Difficulty', 'The base difficulty. A difficulty preset (top of the page) overrides parts of it.', 'general', 'Normal', opt(['Easy', 'Easy'], ['Normal', 'Normal'], ['Brutal', 'Brutal'])),
  n('ClanSize', 'Clan size', 'Maximum players per clan.', 'general', 4, 1, 50, 'players'),
  b('AllowGlobalChat', 'Global chat', 'Players can use the global chat channel.', 'general', true),
  b('AllWaypointsUnlocked', 'All waypoints unlocked', 'Every waygate is unlocked from the start.', 'general', false),
  n('StartingProgressionLevel', 'Starting progression', 'Gear level new characters start with (0 = from scratch).', 'general', 0, 0, 100, 'level'),
  n('StarterEquipmentId', 'Starter equipment set', 'Id of a starter equipment kit (0 = none).', 'general', 0, -2147483648, 2147483647),
  n('StarterResourcesId', 'Starter resources set', 'Id of a starter resource kit (0 = none).', 'general', 0, -2147483648, 2147483647),
  n('WeaponSlots', 'Weapon slots', 'Weapon slots on the action bar.', 'general', 8, 1, 8, 'slots'),
  n('JournalVBloodSourceUnitMaxDistance', 'V Blood tracking distance', 'How close you must be for the journal to track a V Blood carrier.', 'general', 25, 0, 200, 'm'),

  // ------------------------------------------------------------------ pvp & sieges
  e('PlayerDamageMode', 'Player damage', 'When players can hurt each other.', 'pvp', 'Always', opt(['Always', 'Always'], ['TimeRestricted', 'In PvP window'])),
  e('CastleDamageMode', 'Castle damage', 'When castles can be damaged by players.', 'pvp', 'Never', opt(['Never', 'Never'], ['Always', 'Always'], ['TimeRestricted', 'In raid window'])),
  e('PvPProtectionMode', 'New player PvP protection', 'How long fresh characters are safe from other players.', 'pvp', 'Medium', opt(['Disabled', 'Off'], ['VeryShort', 'Very short'], ['Short', 'Short'], ['Medium', 'Medium'], ['Long', 'Long'])),
  e('SiegeWeaponHealth', 'Siege golem health', 'Health of siege golems.', 'pvp', 'Normal', opt(['VeryLow', 'Very low'], ['Low', 'Low'], ['Normal', 'Normal'], ['High', 'High'], ['VeryHigh', 'Very high'])),
  f('PvPVampireRespawnModifier', 'PvP respawn time', 'Respawn time after being killed by a player.', 'pvp', 1, 0, 5),
  b('AnnounceSiegeWeaponSpawn', 'Announce siege golems', 'Everyone is told when a siege golem is summoned.', 'pvp', true),
  b('ShowSiegeWeaponMapIcon', 'Siege golems on the map', 'Show active siege golems on everyone’s map.', 'pvp', false),
  b('FreeCastleRaid', 'Free castle raid', 'Castles can be raided without siege golems.', 'pvp', false),
  b('FreeCastleClaim', 'Free castle claim', 'Breached castle hearts can be claimed freely.', 'pvp', false),
  b('FreeCastleDestroy', 'Free castle destroy', 'Breached castles can be destroyed freely.', 'pvp', false),

  // ------------------------------------------------------------------ castles
  e('CastleHeartDamageMode', 'Castle hearts', 'What other players can do to a castle heart.', 'castle', 'CanBeDestroyedByPlayers', opt(['CanBeDestroyedOnlyWhenDecaying', 'Destroy only when decaying'], ['CanBeDestroyedByPlayers', 'Destroy'], ['CanBeSeizedOrDestroyedByPlayers', 'Seize or destroy'])),
  f('CastleDecayRateModifier', 'Castle decay speed', 'How fast unfed castles decay.', 'castle', 1, 0, 5),
  f('CastleBloodEssenceDrainModifier', 'Blood essence drain', 'How fast castle hearts consume blood essence.', 'castle', 1, 0, 5),
  d('CastleSiegeTimer', 'Siege duration', 'How long a siege lasts once a heart is breached.', 'castle', 420, 60, 7200),
  d('CastleUnderAttackTimer', 'Under-attack timer', 'How long a castle counts as under attack after damage.', 'castle', 60, 10, 1800, 10),
  d('CastleRaidTimer', 'Raid duration', 'Length of a raid.', 'castle', 600, 60, 7200),
  d('CastleRaidProtectionTime', 'Raid protection', 'Protection after a castle was raided.', 'castle', 1800, 0, 86400),
  d('CastleExposedFreeClaimTimer', 'Exposed free-claim time', 'How long an exposed heart can be claimed freely.', 'castle', 300, 0, 7200),
  b('CastleRelocationEnabled', 'Castle relocation', 'Players can move their castle to another plot.', 'castle', true),
  d('CastleRelocationCooldown', 'Relocation cooldown', 'Time between castle relocations.', 'castle', 10800, 0, 604800, 600),
  n('CastleMinimumDistanceInFloors', 'Distance between castles', 'Minimum gap between two castles.', 'castle', 2, 0, 20, 'floors'),
  b('CanLootEnemyContainers', 'Loot enemy containers', 'Players can loot chests in other players’ castles.', 'castle', true),
  f('CastleStatModifiers_Global.TickPeriod', 'Castle tick period', 'Seconds between castle updates (decay, production).', 'castle', 5, 1, 60, 1),

  // ------------------------------------------------------------------ limits
  e('CastleStatModifiers_Global.CastleHeartLimitType', 'Castle limit applies to', 'Count castles per player or per clan.', 'limits', 'User', opt(['User', 'Per player'], ['Clan', 'Per clan'])),
  n('CastleStatModifiers_Global.CastleLimit', 'Castles', 'Castle hearts per player (or clan).', 'limits', 2, 1, 20, 'castles'),
  ...heart(1, 50, 1),
  ...heart(2, 140, 3),
  ...heart(3, 240, 5),
  ...heart(4, 360, 7),
  ...heart(5, 550, 8),
  n('CastleStatModifiers_Global.SafetyBoxLimit', 'Vampire lockboxes', '', 'limits', 1, 0, 20),
  n('CastleStatModifiers_Global.EyeStructuresLimit', 'Eye of Mortium', '', 'limits', 1, 0, 20),
  n('CastleStatModifiers_Global.TombLimit', 'Tombs', '', 'limits', 12, 0, 100),
  n('CastleStatModifiers_Global.VerminNestLimit', 'Vermin nests', '', 'limits', 4, 0, 100),
  n('CastleStatModifiers_Global.PrisonCellLimit', 'Prison cells', '', 'limits', 24, 0, 200),
  n('CastleStatModifiers_Global.NetherGateLimit', 'Nether gates', '', 'limits', 1, 0, 20),
  n('CastleStatModifiers_Global.ThroneOfDarknessLimit', 'Thrones of Darkness', '', 'limits', 1, 0, 20),
  n('CastleStatModifiers_Global.ArenaStationLimit', 'Arena stations', '', 'limits', 5, 0, 50),
  n('CastleStatModifiers_Global.RoutingStationLimit', 'Routing stations', '', 'limits', 10, 0, 100),

  // ------------------------------------------------------------------ loot
  f('DropTableModifier_General', 'Loot drops', 'Amount of loot from enemies and containers.', 'loot', 1, 0, 10),
  f('DropTableModifier_Missions', 'Servant mission loot', 'Loot servants bring back from hunts.', 'loot', 1, 0, 10),
  f('DropTableModifier_StygianShards', 'Stygian shards', 'Stygian shard drops.', 'loot', 1, 0, 10),
  f('MaterialYieldModifier_Global', 'Resource yield', 'Resources from trees, rocks and plants.', 'loot', 1, 0, 10),
  f('BloodEssenceYieldModifier', 'Blood essence yield', 'Blood essence from kills.', 'loot', 1, 0, 10),
  f('InventoryStacksModifier', 'Stack size', 'How many items fit in one inventory slot.', 'loot', 1, 0.25, 10, 0.25),
  e('RelicSpawnType', 'Soul shards', 'Unique: one shard of each kind exists on the server. Plentiful: every player can own one.', 'loot', 'Unique', opt(['Unique', 'Unique'], ['Plentiful', 'Plentiful'])),
  f('SoulShard_DurabilityLossRate', 'Soul shard decay', 'How fast soul shards lose durability.', 'loot', 1, 0, 5),
  e('DeathContainerPermission', 'Who can loot your remains', 'Who may take items from a player’s death container.', 'loot', 'Anyone', opt(['Anyone', 'Anyone'], ['ClanMembers', 'Clan members'], ['OnlySelf', 'Only you'])),
  b('BloodBoundEquipment', 'Blood-bound equipment', 'Equipped gear stays with the player on death.', 'loot', true),
  b('TeleportBoundItems', 'Teleport-bound items', 'Some items (like ore) block using waygates.', 'loot', true),
  b('BatBoundItems', 'Bat-bound items', 'The same items block bat form.', 'loot', false),
  b('BatBoundShards', 'Bat-bound soul shards', 'Carrying a soul shard blocks bat form.', 'loot', false),
  f('Death_DurabilityFactorLoss', 'Durability lost on death', 'Share of gear durability lost on death (0.125 = 12.5%).', 'loot', 0.125, 0, 1, 0.025),
  f('Death_DurabilityLossFactorAsResources', 'Lost durability dropped as resources', 'Share of lost durability returned as resources.', 'loot', 1, 0, 1),

  // ------------------------------------------------------------------ vampire
  f('VampireStatModifiers.MaxHealthModifier', 'Vampire health', '', 'vampire', 1, 0.1, 5),
  f('VampireStatModifiers.PhysicalPowerModifier', 'Physical power', '', 'vampire', 1, 0.1, 5),
  f('VampireStatModifiers.SpellPowerModifier', 'Spell power', '', 'vampire', 1, 0.1, 5),
  f('VampireStatModifiers.ResourcePowerModifier', 'Resource gathering power', '', 'vampire', 1, 0.1, 5),
  f('VampireStatModifiers.SiegePowerModifier', 'Siege power', '', 'vampire', 1, 0.1, 5),
  f('VampireStatModifiers.DamageReceivedModifier', 'Damage taken', '', 'vampire', 1, 0.1, 5),
  f('VampireStatModifiers.ReviveCancelDelay', 'Revive cancel delay', 'Seconds before a downed vampire can cancel a revive.', 'vampire', 5, 0, 30, 0.5),
  f('BloodDrainModifier', 'Blood drain', 'How fast vampires get hungry.', 'vampire', 1, 0, 5),
  f('DurabilityDrainModifier', 'Durability drain', 'How fast gear wears out.', 'vampire', 1, 0, 5),
  f('SunDamageModifier', 'Sun damage', '', 'vampire', 1, 0, 5),
  f('GarlicAreaStrengthModifier', 'Garlic strength', '', 'vampire', 1, 0, 5),
  f('HolyAreaStrengthModifier', 'Holy area strength', '', 'vampire', 1, 0, 5),
  f('SilverStrengthModifier', 'Silver strength', '', 'vampire', 1, 0, 5),
  f('EquipmentStatModifiers_Global.MaxHealthModifier', 'Gear: health bonus', 'Scales stats from equipment.', 'vampire', 1, 0, 5),
  f('EquipmentStatModifiers_Global.ResourceYieldModifier', 'Gear: resource yield', '', 'vampire', 1, 0, 5),
  f('EquipmentStatModifiers_Global.PhysicalPowerModifier', 'Gear: physical power', '', 'vampire', 1, 0, 5),
  f('EquipmentStatModifiers_Global.SpellPowerModifier', 'Gear: spell power', '', 'vampire', 1, 0, 5),
  f('EquipmentStatModifiers_Global.SiegePowerModifier', 'Gear: siege power', '', 'vampire', 1, 0, 5),
  f('EquipmentStatModifiers_Global.MovementSpeedModifier', 'Gear: movement speed', '', 'vampire', 1, 0, 5),

  // ------------------------------------------------------------------ units
  f('UnitStatModifiers_Global.MaxHealthModifier', 'Creature health', 'All world creatures except V Blood bosses.', 'units', 1, 0.1, 5),
  f('UnitStatModifiers_Global.PowerModifier', 'Creature damage', '', 'units', 1, 0.1, 5),
  n('UnitStatModifiers_Global.LevelIncrease', 'Creature level bonus', 'Levels added to every creature.', 'units', 0, -20, 50, 'levels'),
  f('UnitStatModifiers_VBlood.MaxHealthModifier', 'V Blood health', '', 'units', 1, 0.1, 5),
  f('UnitStatModifiers_VBlood.PowerModifier', 'V Blood damage', '', 'units', 1, 0.1, 5),
  n('UnitStatModifiers_VBlood.LevelIncrease', 'V Blood level bonus', '', 'units', 0, -20, 50, 'levels'),

  // ------------------------------------------------------------------ crafting
  f('BuildCostModifier', 'Building cost', '', 'crafting', 1, 0, 5),
  f('RecipeCostModifier', 'Crafting cost', '', 'crafting', 1, 0, 5),
  f('CraftRateModifier', 'Crafting speed', 'Higher = faster.', 'crafting', 1, 0.1, 10),
  f('ResearchCostModifier', 'Research cost', '', 'crafting', 1, 0, 5),
  f('ResearchTimeModifier', 'Research time', '', 'crafting', 1, 0, 5),
  f('RefinementCostModifier', 'Refining cost', '', 'crafting', 1, 0, 5),
  f('RefinementRateModifier', 'Refining speed', 'Higher = faster.', 'crafting', 1, 0.1, 10),
  f('DismantleResourceModifier', 'Dismantle refund', 'Share of resources returned when dismantling.', 'crafting', 1, 0, 1),
  f('ServantConvertRateModifier', 'Servant conversion speed', 'Higher = faster.', 'crafting', 1, 0.1, 10),
  f('RepairCostModifier', 'Repair cost', '', 'crafting', 1, 0, 5),

  // ------------------------------------------------------------------ time
  d('GameTimeModifiers.DayDurationInSeconds', 'Length of a day', 'Real time for one full in-game day and night.', 'time', 1080, 120, 7200),
  h('GameTimeModifiers.DayStartHour', 'Sunrise hour', 'In-game hour the sun comes up.', 'time', 9),
  h('GameTimeModifiers.DayStartMinute', 'Sunrise minute', '', 'time', 0, 59),
  h('GameTimeModifiers.DayEndHour', 'Sunset hour', 'In-game hour the sun goes down.', 'time', 17),
  h('GameTimeModifiers.DayEndMinute', 'Sunset minute', '', 'time', 0, 59),
  n('GameTimeModifiers.BloodMoonFrequency_Min', 'Blood moon every – at least', 'Fewest in-game days between blood moons.', 'time', 10, 1, 255, 'days'),
  n('GameTimeModifiers.BloodMoonFrequency_Max', 'Blood moon every – at most', 'Most in-game days between blood moons.', 'time', 18, 1, 255, 'days'),
  f('GameTimeModifiers.BloodMoonBuff', 'Blood moon buff', 'Bonus vampires get during a blood moon (0.2 = 20%).', 'time', 0.2, 0, 1),

  // ------------------------------------------------------------------ inactivity
  b('InactivityKillEnabled', 'Remove inactive players', 'Characters of long-inactive players die and their castles decay.', 'inactivity', true),
  d('InactivityKillTimeMin', 'Inactivity – minimum', 'Shortest inactivity before removal (for low-level characters).', 'inactivity', 3600, 0, 2592000, 3600),
  d('InactivityKillTimeMax', 'Inactivity – maximum', 'Longest inactivity before removal (for max-level characters).', 'inactivity', 604800, 0, 7776000, 3600),
  d('InactivityKillSafeTimeAddition', 'Safe time added', 'Extra grace time added on top.', 'inactivity', 172800, 0, 2592000, 3600),
  n('InactivityKillTimerMaxItemLevel', 'Gear level for the maximum', 'Gear level at which the maximum inactivity time applies.', 'inactivity', 84, 0, 120, 'level'),
  b('DisableDisconnectedDeadEnabled', 'Remove disconnected bodies', 'Characters left in the world after a disconnect are removed.', 'inactivity', true),
  d('DisableDisconnectedDeadTimer', 'Remove after', '', 'inactivity', 60, 0, 3600, 10),
  d('DisconnectedSunImmunityTime', 'Sun immunity after disconnect', 'Time a disconnected character is safe from the sun.', 'inactivity', 300, 0, 3600, 30),

  // ------------------------------------------------------------------ traders
  f('TraderModifiers.StockModifier', 'Trader stock', '', 'traders', 1, 0, 10),
  f('TraderModifiers.PriceModifier', 'Trader prices', '', 'traders', 1, 0, 10),
  f('TraderModifiers.RestockTimerModifier', 'Restock time', 'Higher = slower restocking.', 'traders', 1, 0, 10),

  // ------------------------------------------------------------------ windows
  e('PlayerInteractionSettings.TimeZone', 'Time zone', 'Time zone of the windows below.', 'windows', 'Local', opt(['Local', 'Server PC'], ['UTC', 'UTC'], ['PST', 'PST'], ['EST', 'EST'], ['CET', 'CET'], ['CST', 'CST'])),
  ...window('VSPlayerWeekdayTime', 'PvP weekdays'),
  ...window('VSPlayerWeekendTime', 'PvP weekends'),
  ...window('VSCastleWeekdayTime', 'Raids weekdays'),
  ...window('VSCastleWeekendTime', 'Raids weekends'),

  // ------------------------------------------------------------------ war events
  n('WarEventGameSettings.Interval', 'Incursion interval', 'How often rift incursions start (0 = default rhythm).', 'war', 0, 0, 10, ''),
  n('WarEventGameSettings.MajorDuration', 'Major incursion duration', '', 'war', 1, 0, 10, ''),
  n('WarEventGameSettings.MinorDuration', 'Minor incursion duration', '', 'war', 1, 0, 10, ''),
  ...warScaling(1, 1),
  ...warScaling(2, 0.5),
  ...warScaling(3, 0.25),
  ...warScaling(4, 0.25),
];

export const SETTING_BY_KEY: Record<string, GameSetting> = Object.fromEntries(GAME_SETTINGS.map((s) => [s.key, s]));

/** Fallback when the server isn't installed yet (the real list comes from its StreamingAssets). */
export const KNOWN_PRESETS = [
  'StandardPvP', 'StandardPvE', 'SoloPvP', 'DuoPvP', 'TrioPvP', 'HardcorePvP', 'HardcoreDuoPvP', 'HardcoreTrioPvP',
  'StandardPvP_DailySiege', 'StandardPvP_WeekendSiege', 'StandardPvP_NoSiege',
  'Level30PvE', 'Level40PvE', 'Level50PvE', 'Level60PvE', 'Level70PvE', 'Level80PvE', 'Level90PvE',
  'Level30PvP', 'Level40PvP', 'Level50PvP', 'Level60PvP', 'Level70PvP', 'Level80PvP', 'Level90PvP',
];
export const KNOWN_DIFFICULTIES = ['Difficulty_Easy', 'Difficulty_Normal', 'Difficulty_Brutal'];

export function presetLabel(p: string) {
  return p
    .replace(/^Difficulty_/, '')
    .replace(/_/g, ' · ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/(\d+)/g, ' $1 ')
    .replace(/\s+/g, ' ')
    .replace(/P v P/g, 'PvP')
    .replace(/P v E/g, 'PvE')
    .trim();
}

/** Value of a setting, falling back to the shipped default. */
export function settingValue(gs: Record<string, SettingValue>, s: GameSetting): SettingValue {
  return gs[s.key] ?? s.default;
}

export function isDefault(gs: Record<string, SettingValue>, s: GameSetting) {
  const v = settingValue(gs, s);
  return typeof v === 'number' && typeof s.default === 'number' ? Math.abs(v - s.default) < 1e-6 : String(v) === String(s.default);
}

/** Seconds → "18 min", "3 h", "7 days". */
export function secondsLabel(s: number) {
  if (s >= 86400 && s % 3600 === 0) return s % 86400 === 0 ? `${s / 86400} d` : `${(s / 86400).toFixed(1)} d`;
  if (s >= 3600) return s % 3600 === 0 ? `${s / 3600} h` : `${(s / 3600).toFixed(1)} h`;
  if (s >= 60) return s % 60 === 0 ? `${s / 60} min` : `${(s / 60).toFixed(1)} min`;
  return `${s} s`;
}

export const PRIORITIES = [
  { value: 'idle', label: 'Low' },
  { value: 'belowNormal', label: 'Below normal' },
  { value: 'normal', label: 'Normal' },
  { value: 'aboveNormal', label: 'Above normal' },
  { value: 'high', label: 'High' },
];
