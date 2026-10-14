import { z } from 'zod';

/** Schémas zod des fichiers `shared/data/*.json`. Les types TS en sont inférés. */

const nonNeg = z.number().nonnegative();
const pos = z.number().positive();
const act = z.number().int().min(1).max(4);

export const BoundsSchema = z
  .object({ minX: z.number(), maxX: z.number(), minZ: z.number(), maxZ: z.number() })
  .refine((b) => b.minX < b.maxX && b.minZ < b.maxZ, 'bornes min/max inversées');

const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'couleur #rrggbb attendue');

export const Vec2Schema = z.object({ x: z.number(), z: z.number() });

/** Rectangle aligné sur les axes : centre (x, z), largeur w (axe X), profondeur d (axe Z). */
export const RectSchema = z.object({ x: z.number(), z: z.number(), w: pos, d: pos });

export const PaletteKeySchema = z.enum(['sky', 'ground', 'street', 'wall', 'neon', 'vegetation']);

/** Direction artistique : 6 couleurs de base, les nuances en sont dérivées. */
export const PaletteSchema = z.object({
  sky: hexColor,
  ground: hexColor,
  street: hexColor,
  wall: hexColor,
  neon: hexColor,
  vegetation: hexColor,
});

/** Faim, soif, santé (0..max). */
export const VitalsSchema = z.object({ hunger: nonNeg, thirst: nonNeg, health: nonNeg });

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

/** Bornes de réglage de la découpe des bâtiments devant le joueur (mètres). */
export const CUTOUT_LIMITS = {
  radius: { min: 0.5, max: 6 },
  softness: { min: 0, max: 2 },
} as const;

/** Trou percé dans les façades entre la caméra et le joueur local. */
export const CutoutSchema = z.object({
  enabled: z.boolean(),
  radius: range(CUTOUT_LIMITS.radius),
  softness: range(CUTOUT_LIMITS.softness),
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
  world: z.object({
    bounds: BoundsSchema,
    playerSize: pos,
    playerRadius: pos,
    /** Marge (m) accordée par le serveur sur le rayon d'interaction (latence). */
    interactTolerance: nonNeg,
  }),
  players: z.object({
    colors: z.array(hexColor).min(1),
    /** Point de départ : un carton dans la rue. */
    spawn: Vec2Schema,
    spawnSpread: nonNeg,
  }),
  palette: PaletteSchema,
  map: z.object({
    roads: z.array(RectSchema.extend({ id: z.string().min(1) })).min(1),
    sidewalkWidth: nonNeg,
    crosswalks: z.array(
      z.object({ x: z.number(), z: z.number(), axis: z.enum(['x', 'z']), length: pos, width: pos }),
    ),
  }),
  decor: z.object({
    /** Part des fenêtres allumées (0-1). */
    windowLitRatio: z.number().min(0).max(1),
    streetlights: z.object({ spacing: pos, inset: nonNeg }),
    carSize: z.object({ length: pos, width: pos, height: pos }),
    cars: z.array(
      Vec2Schema.extend({
        rotation: z.union([z.literal(0), z.literal(90)]),
        color: PaletteKeySchema,
      }),
    ),
    trees: z.array(Vec2Schema.extend({ scale: pos })),
    bins: z.array(Vec2Schema),
    crates: z.array(Vec2Schema),
    cartons: z.array(Vec2Schema),
  }),
  /** Cadrage retenu. `zoom` = distance caméra → cible (m) ; en ortho, cadrage équivalent. */
  camera: CameraSchema,
  /** Caméra dans les intérieurs (pièces plus petites, vue plus plongeante). */
  cameraInterior: CameraSchema,
  cameraRig: z.object({ followStiffness: pos, near: pos, far: pos }),
  cutout: CutoutSchema,
  persistence: z.object({
    /** Fréquence des sauvegardes JSON des parties (s). */
    snapshotSeconds: pos,
  }),
  debug: z.object({
    /** Le serveur accepte-t-il les commandes debug (donner, vider, accélérer) ? */
    commands: z.boolean(),
    timeScales: z.array(pos).min(1),
  }),
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
  'drink',
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
  /** Texte affiché dans le détail de l'inventaire. */
  description: z.string().min(1),
  /** Pictogramme (emoji) affiché dans l'inventaire. */
  icon: z.string().min(1),
  /** Consommable : points de faim/soif rendus (plafonnés au max). */
  restores: z.object({ hunger: nonNeg.optional(), thirst: nonNeg.optional() }).optional(),
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
    hungerPerMinute: nonNeg,
    thirstPerMinute: nonNeg,
    /** Sous ce seuil (faim ou soif) : vitesse réduite et jauge qui clignote. */
    lowThreshold: nonNeg,
    lowSpeedFactor: z.number().gt(0).max(1),
    /** Perte de santé par minute tant que la faim ou la soif est à 0. */
    healthLossPerMinuteAtZero: nonNeg,
    start: VitalsSchema,
    /** Jauges après un KO (réapparition au carton). */
    koRecovery: VitalsSchema,
    koDirtyCashLossPercent: z.number().min(0).max(100),
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
  /** Labo : postes de production et stock commun. */
  lab: z.object({
    startPots: z.number().int().nonnegative(),
    startingStock: z.array(
      z.object({ itemId: z.string().min(1), qty: z.number().int().positive() }),
    ),
    waterPerWatering: z.number().int().positive(),
    waterPerTap: z.number().int().positive(),
    rackCapacity: z.number().int().positive(),
    cuttingSeconds: pos,
    tableBatchMax: z.number().int().positive(),
  }),
  upgrades: z.record(
    z.string(),
    z.object({ name: z.string(), bagSlots: z.number().int().positive() }),
  ),
  services: z.record(z.string(), z.object({ name: z.string(), durationMinutes: pos })),
});

// ---------- zones.json (intérieurs) ----------
export const StationKindSchema = z.enum([
  'pot',
  'water',
  'rack',
  'table',
  'stock',
  'exit',
  'shelf',
  'counter',
]);

/** Poste physique d'un intérieur (coordonnées locales à la pièce, centre = origine). */
export const StationSchema = z.object({
  id: z.string().min(1),
  kind: StationKindSchema,
  label: z.string().min(1),
  position: Vec2Schema,
  size: z.object({ w: pos, d: pos }),
  /** Distance d'interaction, mesurée depuis le centre du poste. */
  interactRadius: pos,
  /** Bloque le passage (devient un obstacle de collision). */
  solid: z.boolean(),
  /** Comptoir : nom du vendeur affiché derrière. */
  vendor: z.string().min(1).optional(),
});

/** Pièce intérieure : une « zone » où le joueur passe en franchissant la porte d'un lieu. */
export const InteriorSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  /** Lieu de la rue dont la porte mène ici (retour devant cette porte en sortant). */
  entranceLocationId: z.string().min(1),
  /** Dimensions intérieures ; la pièce est centrée sur l'origine. */
  size: z.object({ w: pos, d: pos }),
  wallHeight: pos,
  spawn: Vec2Schema,
  obstacles: z.array(RectSchema),
  stations: z.array(StationSchema).min(1),
});

export const ZonesFileSchema = z.object({ interiors: z.array(InteriorSchema) });

// ---------- shops.json ----------
/** Une étagère vend un objet ; `stock: null` = illimité. Le prix ne vit qu'ici (et côté serveur). */
export const ShelfSchema = z.object({
  stationId: z.string().min(1),
  itemId: z.string().min(1),
  price: z.number().int().nonnegative(),
  stock: z.number().int().nonnegative().nullable(),
});

export const ShopSchema = z.object({
  interiorId: z.string().min(1),
  shelves: z.array(ShelfSchema).min(1),
});

export const ShopsFileSchema = z.object({ shops: z.array(ShopSchema) });

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

export const SilhouetteSchema = z.enum([
  'warehouse',
  'corner_shop',
  'villa_tower',
  'hardware',
  'kiosk',
  'alley',
]);

export const DoorSideSchema = z.enum(['north', 'south', 'east', 'west']);

export const LocationSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  zone: z.string().min(1),
  /** building = bâtiment solide ; area = zone au sol (ruelle), traversable. */
  kind: z.enum(['building', 'area']),
  function: LocationFunctionSchema,
  silhouette: SilhouetteSchema,
  position: Vec2Schema,
  size: z.object({ w: pos, d: pos }),
  height: pos,
  color: hexColor,
  neonColor: hexColor,
  /** Face portant la porte (obligatoire pour un bâtiment). Nord = -Z. */
  door: DoorSideSchema.optional(),
  interactRadius: pos,
  /** Réplique renvoyée par le serveur quand on entre. */
  enterText: z.string().min(1),
  catalog: z.array(CatalogEntrySchema),
});

/** Immeuble de remplissage (sans fonction) : ferme les îlots, crée les ruelles. */
export const BlockSchema = z.object({
  id: z.string().min(1),
  position: Vec2Schema,
  size: z.object({ w: pos, d: pos }),
  height: pos,
  color: hexColor.optional(),
});

export const LocationsFileSchema = z.object({
  zones: z.array(ZoneSchema).min(1),
  locations: z.array(LocationSchema).min(1),
  blocks: z.array(BlockSchema),
});

export type Bounds = z.infer<typeof BoundsSchema>;
export type GameConfig = z.infer<typeof ConfigSchema>;
export type CameraConfig = z.infer<typeof CameraSchema>;
export type CutoutConfig = z.infer<typeof CutoutSchema>;
export type ItemCategory = z.infer<typeof ItemCategorySchema>;
export type ItemDef = z.infer<typeof ItemDefSchema>;
export type Strain = z.infer<typeof StrainSchema>;
export type Economy = z.infer<typeof EconomySchema>;
export type Vitals = z.infer<typeof VitalsSchema>;
export type SurvivalRules = Economy['survival'];
export type CatalogEntry = z.infer<typeof CatalogEntrySchema>;
export type Zone = z.infer<typeof ZoneSchema>;
export type GameLocation = z.infer<typeof LocationSchema>;
export type Block = z.infer<typeof BlockSchema>;
export type Palette = z.infer<typeof PaletteSchema>;
export type PaletteKey = z.infer<typeof PaletteKeySchema>;
export type Silhouette = z.infer<typeof SilhouetteSchema>;
export type DoorSide = z.infer<typeof DoorSideSchema>;
export type Vec2Data = z.infer<typeof Vec2Schema>;
export type StationKind = z.infer<typeof StationKindSchema>;
export type Station = z.infer<typeof StationSchema>;
export type Interior = z.infer<typeof InteriorSchema>;
export type Shelf = z.infer<typeof ShelfSchema>;
export type Shop = z.infer<typeof ShopSchema>;
export type LocationsFile = z.infer<typeof LocationsFileSchema>;
