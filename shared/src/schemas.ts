import { z } from 'zod';

/** Schémas zod des fichiers `shared/data/*.json`. Les types TS en sont inférés. */

const nonNeg = z.number().nonnegative();
const pos = z.number().positive();
const act = z.number().int().min(1).max(4);

export const BoundsSchema = z
  .object({ minX: z.number(), maxX: z.number(), minZ: z.number(), maxZ: z.number() })
  .refine((b) => b.minX < b.maxX && b.minZ < b.maxZ, 'bornes min/max inversées');

// ---------- config.json ----------
/** Bornes de réglage de la caméra (degrés), partagées par la validation et le panneau debug. */
export const CAMERA_LIMITS = {
  elevation: { min: 10, max: 85 },
  rotation: { min: 0, max: 360 },
  fov: { min: 20, max: 80 },
} as const;

const range = (r: { min: number; max: number }) => z.number().min(r.min).max(r.max);

export const CameraSchema = z.object({
  type: z.enum(['perspective', 'ortho']),
  elevation: range(CAMERA_LIMITS.elevation),
  rotation: range(CAMERA_LIMITS.rotation),
  zoom: pos,
  fov: range(CAMERA_LIMITS.fov),
});

export const ConfigSchema = z.object({
  room: z.object({
    maxPlayers: z.number().int().min(1).max(8),
    codeLength: z.number().int().min(3).max(8),
    codeAlphabet: z.string().min(10),
    emptyRoomTtlSeconds: pos,
    patchRateMs: pos,
  }),
  movement: z.object({
    walkSpeed: pos,
    runSpeed: pos,
    toleranceFactor: z.number().min(1),
    maxBurstMs: pos,
    clientSendRateHz: pos,
  }),
  world: z.object({ bounds: BoundsSchema, playerSize: pos }),
  players: z.object({
    colors: z.array(z.string().regex(/^#[0-9a-fA-F]{6}$/)).min(1),
    spawnLocationId: z.string(),
    spawnSpread: nonNeg,
  }),
  /** Cadrage retenu. `zoom` = distance caméra → cible (m) ; en ortho, cadrage équivalent. */
  camera: CameraSchema,
  cameraRig: z.object({ followStiffness: pos, near: pos, far: pos }),
  net: z.object({
    reconnectBackoffMs: z.array(pos).min(1),
    reconnectMaxDelayMs: pos,
  }),
});

// ---------- items.json ----------
export const ItemCategorySchema = z.enum([
  'seed',
  'plant_fresh',
  'plant_dried',
  'pouch',
  'water',
  'food',
  'tool',
  'cash_dirty',
  'cash_clean',
]);

export const ItemDefSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  category: ItemCategorySchema,
  /** `slot` = occupe un slot de sac/stock ; `account` = solde (argent propre). */
  storage: z.enum(['slot', 'account']),
  stackMax: z.number().int().nonnegative(),
  /** Marchandise illégale : déclenche une sanction en fouille. */
  contraband: z.boolean(),
  /** Saisie par la police en fouille. */
  confiscable: z.boolean(),
  strain: z.string().optional(),
});

export const ItemsFileSchema = z.object({ items: z.array(ItemDefSchema).min(1) });

// ---------- economy.json ----------
export const StrainSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  unlockAct: act,
  growSeconds: pos,
  waterEverySeconds: pos,
  dryingSeconds: pos,
  freshPerPlant: z.number().int().positive(),
  pouchesPerDried: z.number().int().positive(),
  pouchSellPrice: nonNeg,
});

const SkillSchema = z.object({ maxRank: z.number().int().positive(), effectPerRank: z.number() });

export const EconomySchema = z.object({
  inventory: z.object({
    bagSlots: z.number().int().positive(),
    stockSlots: z.number().int().positive(),
  }),
  calendar: z.object({ realMinutesPerGameDay: pos, gameDaysPerWeek: z.number().int().positive() }),
  startingMoney: z.object({ dirty: nonNeg, clean: nonNeg }),
  survival: z.object({
    max: pos,
    hungerDecayPerMinute: nonNeg,
    thirstDecayPerMinute: nonNeg,
    foodRestore: nonNeg,
    waterRestore: nonNeg,
  }),
  strains: z.array(StrainSchema).min(1),
  elJefe: z.object({ salesTaxRate: z.number().min(0).max(1), starterSeeds: nonNeg }),
  dealer: z.object({
    weeklyCost: nonNeg,
    pouchesSoldPerGameDay: nonNeg,
    maxDealersAct2: z.number().int().nonnegative(),
  }),
  xp: z.object({
    perPouchSold: nonNeg,
    perHarvest: nonNeg,
    levelThresholds: z.array(nonNeg).min(1),
    skillPointsPerLevel: z.number().int().nonnegative(),
  }),
  skills: z.object({ growTime: SkillSchema, moveSpeed: SkillSchema, bagSize: SkillSchema }),
  heat: z.object({
    max: pos,
    perSale: nonNeg,
    perRunSpotted: nonNeg,
    perStockUnitPerMinute: nonNeg,
    decayPerMinute: nonNeg,
    raidThreshold: nonNeg,
  }),
  police: z.object({
    fineRateOfBagValue: z.number().min(0).max(1),
    arrestSeconds: nonNeg,
    bribeCost: nonNeg,
    bribeHeatReduction: nonNeg,
    lookoutRiskReduction: z.number().min(0).max(1),
  }),
  upgrades: z.record(
    z.string(),
    z.object({ name: z.string(), bagSlots: z.number().int().positive() }),
  ),
  services: z.record(z.string(), z.object({ name: z.string(), durationMinutes: pos })),
});

// ---------- locations.json ----------
export const LocationFunctionSchema = z.enum([
  'base',
  'grocery',
  'supplier',
  'street_sales',
  'relay',
  'shop',
  'laundromat',
  'bank',
  'dealership',
  'front_store',
  'factory',
  'gunshop',
  'airport',
]);

export const CatalogEntrySchema = z.object({
  kind: z.enum(['item', 'upgrade', 'service']),
  id: z.string().min(1),
  price: nonNeg,
  unlockAct: act.optional(),
});

export const ZoneSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  unlockAct: act,
  bounds: BoundsSchema,
});

export const LocationSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  zone: z.string().min(1),
  function: LocationFunctionSchema,
  position: z.object({ x: z.number(), z: z.number() }),
  size: z.object({ w: pos, d: pos }),
  interactRadius: pos,
  catalog: z.array(CatalogEntrySchema),
});

export const LocationsFileSchema = z.object({
  zones: z.array(ZoneSchema).min(1),
  locations: z.array(LocationSchema).min(1),
});

export type Bounds = z.infer<typeof BoundsSchema>;
export type GameConfig = z.infer<typeof ConfigSchema>;
export type CameraConfig = z.infer<typeof CameraSchema>;
export type ItemCategory = z.infer<typeof ItemCategorySchema>;
export type ItemDef = z.infer<typeof ItemDefSchema>;
export type Strain = z.infer<typeof StrainSchema>;
export type Economy = z.infer<typeof EconomySchema>;
export type CatalogEntry = z.infer<typeof CatalogEntrySchema>;
export type Zone = z.infer<typeof ZoneSchema>;
export type GameLocation = z.infer<typeof LocationSchema>;
export type LocationsFile = z.infer<typeof LocationsFileSchema>;
