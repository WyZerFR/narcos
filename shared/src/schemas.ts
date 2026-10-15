import { z } from 'zod';

/** Schémas zod des fichiers `shared/data/*.json`. Les types TS en sont inférés. */

const nonNeg = z.number().nonnegative();
const pos = z.number().positive();
/** Une valeur par type de meuble posable (pot, étendoir, table, lampe). */
const perFixtureType = <T extends z.ZodType>(s: T) =>
  z.object({ pot: s, drying_rack: s, cutting_table: s, lamp: s });
const act = z.number().int().min(1).max(4);

export const BoundsSchema = z
  .object({ minX: z.number(), maxX: z.number(), minZ: z.number(), maxZ: z.number() })
  .refine((b) => b.minX < b.maxX && b.minZ < b.maxZ, 'bornes min/max inversées');

const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'couleur #rrggbb attendue');

export const Vec2Schema = z.object({ x: z.number(), z: z.number() });

/** Rectangle aligné sur les axes : centre (x, z), largeur w (axe X), profondeur d (axe Z). */
export const RectSchema = z.object({ x: z.number(), z: z.number(), w: pos, d: pos });

export const PaletteKeySchema = z.enum(['sky', 'ground', 'street', 'wall', 'neon', 'vegetation']);

/**
 * Direction artistique : 6 couleurs de base, les nuances en sont dérivées ; `ok` / `danger`
 * servent aux retours d'interface (fantôme de placement valide / invalide).
 */
export const PaletteSchema = z.object({
  sky: hexColor,
  ground: hexColor,
  street: hexColor,
  wall: hexColor,
  neon: hexColor,
  vegetation: hexColor,
  ok: hexColor,
  danger: hexColor,
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
    /** Parties simultanées au plus sur le serveur (les parties restaurées comptent). */
    maxRooms: z.number().int().positive(),
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
  ui: z.object({
    /** Appui long avant de détacher un objet de l'inventaire (ms). */
    longPressMs: pos,
    /** Mouvement toléré avant la fin de l'appui long ; au-delà, c'est un défilement. */
    dragCancelPx: pos,
    /** Sans réponse du serveur à un dépôt après ce délai, le glisser est débloqué (ms). */
    moveTimeoutMs: pos,
    /** Meuble lâché à une position refusée : durée du retour animé à l'origine (ms). */
    returnMs: pos,
    /** Durée d'affichage du message d'entrée dans une area (ms). */
    areaBannerMs: pos,
  }),
  dialogue: z.object({
    /** Le pacte d'El Jefe est-il exigé par les choix `requires: pact` ? (pas encore en jeu) */
    requirePact: z.boolean(),
  }),
  persistence: z.object({
    /** Fréquence des sauvegardes JSON des parties (s). */
    snapshotSeconds: pos,
  }),
  debug: z.object({
    /** Le serveur accepte-t-il les commandes debug (donner, vider, accélérer) ? */
    commands: z.boolean(),
    timeScales: z.array(pos).min(1),
    /** « Équiper le labo » : nombre de meubles de chaque type placés automatiquement. */
    equipKit: perFixtureType(z.number().int().nonnegative()),
  }),
  /** Taille du sac d'un joueur et du futur stock commun (nombre de slots). */
  inventory: z.object({
    bagSlots: z.number().int().positive(),
    stockSlots: z.number().int().positive(),
  }),
  /** Mode placement des meubles (labo). */
  placement: z.object({
    /** Pas d'un appui sur une flèche (m). */
    stepM: pos,
    /** Bouton maintenu : délai avant répétition, puis intervalle (ms). */
    repeatDelayMs: pos,
    repeatMs: pos,
    /** Marge autour du fantôme où un appui l'attrape pour le glisser (m). */
    grabMarginM: z.number().nonnegative(),
    /** Hauteur dont un meuble glissé est soulevé (m). */
    liftM: z.number().nonnegative(),
    /** Caméra haute pendant le placement (le reste du réglage intérieur est conservé). */
    camera: z.object({ elevation: z.number().min(10).max(89.9), zoom: pos }),
  }),
  net: z.object({
    reconnectBackoffMs: z.array(pos).min(1),
    reconnectMaxDelayMs: pos,
  }),
  /** PNJ de la rue (acheteurs) : simulés par le serveur, diffusés à cadence réduite. */
  npc: z.object({
    /** Plafond de PNJ simulés (somme des `npcCount` de areas.json) : CPU du serveur. */
    maxTotal: z.number().int().positive(),
    /** Vitesse de marche (m/s, temps réel). */
    speed: pos,
    radius: pos,
    /** Fréquence d'écriture des positions dans l'état diffusé (Hz). */
    broadcastHz: pos,
    /** Pause entre deux trajets (s, temps réel). */
    pauseSeconds: z.tuple([nonNeg, nonNeg]),
    /** Distance max joueur ↔ PNJ pour lui vendre (m). */
    saleRadius: pos,
    /** Après une vente ou un refus, le PNJ s'en va puis revient avec une nouvelle demande (s de jeu). */
    cooldownSeconds: z.tuple([pos, pos]),
    /** Pas de la grille de navigation des PNJ (m). */
    navCellSize: pos,
    /** Acheteur de debug : distance d'apparition devant le joueur (m). */
    debugSpawnDistance: pos,
  }),
});

// ---------- npcs.json ----------
const minMax = (schema: z.ZodNumber) =>
  z.tuple([schema, schema]).refine(([a, b]) => a <= b, 'intervalle [min, max] inversé');

/** Profil d'acheteur : chance d'être intéressé, demande, budget, patience, apparence. */
export const NpcProfileSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  /** Poids du tirage du profil. */
  weight: pos,
  interestChance: z.number().min(0).max(1),
  /** Variétés de pochon demandées. */
  strains: z.array(z.string().min(1)).min(1),
  /** Pochons voulus (1 à 3). */
  qty: minMax(z.number().int().min(1).max(3)),
  /** Argent sur lui ($) : borne la quantité qu'il peut payer. */
  budget: minMax(pos),
  /** Temps qu'il attend devant une offre ouverte (s de jeu). */
  patienceSeconds: minMax(pos),
  /** Teinte du corps : couleur de la palette × facteur. */
  color: PaletteKeySchema,
  shade: pos,
});

export const NpcsFileSchema = z.object({
  names: z.array(z.string().min(1)).min(10),
  profiles: z.array(NpcProfileSchema).min(1),
  /** Points de passage sur les trottoirs (rue). */
  waypoints: z.array(Vec2Schema).min(4),
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
  'furniture',
  'cash_dirty',
  'cash_clean',
]);

/** Types de meuble posable dans le labo. */
export const FixtureTypeSchema = z.enum(['pot', 'drying_rack', 'cutting_table', 'lamp']);

/** Meuble posable : type, empreinte (avant rotation), hauteur, pose au sol ou au plafond. */
export const PlaceableSchema = z.object({
  type: FixtureTypeSchema,
  w: pos,
  d: pos,
  height: pos,
  /** `ceiling` : suspendu, ne bloque pas le sol (lampes). */
  mount: z.enum(['floor', 'ceiling']),
  /** Distance d'interaction mesurée depuis le centre du meuble. */
  interactRadius: pos,
});

/** Bouton d'usage dans le détail de l'inventaire (les consommables gardent le leur). */
export const ItemUseSchema = z.object({
  action: z.enum(['place']),
  label: z.string().min(1),
});

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
  /** Mobilier posable librement dans le labo. */
  placeable: PlaceableSchema.optional(),
  use: ItemUseSchema.optional(),
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

/** Lieux de blanchiment : la banque (guichets) et la cave du blanchisseur (Quartier Sud). */
export const LaunderVenueSchema = z.enum(['bank', 'cellar']);

/** Règles d'un lieu de blanchiment ; chaque lieu a son propre plafond glissant. */
export const LaunderRulesSchema = z.object({
  /** Commission prélevée sur la somme sale (0.5 = 50 %). */
  fee: z.number().min(0).lt(1),
  /** Somme sale blanchissable par joueur sur la fenêtre glissante ($). */
  cap: z.number().int().positive(),
  /** Durée de la fenêtre glissante du plafond (s de temps de jeu, gelée sans joueur). */
  windowSeconds: pos,
  /** Compte bancaire ouvert exigé (le net est versé sur le compte). */
  requireAccount: z.boolean(),
  /** Refus affiché sans compte. */
  noAccountText: z.string().min(1),
});

const SkillSchema = z.object({ maxRank: z.number().int().positive(), effectPerRank: z.number() });

export const EconomySchema = z.object({
  calendar: z.object({ realMinutesPerGameDay: pos, gameDaysPerWeek: z.number().int().positive() }),
  /** Argent de départ par joueur : sale dans le sac, propre sur un compte (fermé au départ). */
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
  elJefe: z.object({ salesTaxRate: z.number().min(0).max(1) }),
  /** Pacte d'El Jefe : graines données une fois par joueur à l'acceptation. */
  pact: z.object({ startSeeds: z.number().int().positive(), seedItemId: z.string().min(1) }),
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
  /** Vente de rue : prix = pouchSellPrice × (1 ± priceVariance), arrondi au dollar. */
  sale: z.object({
    priceVariance: z.number().min(0).lt(1),
  }),
  /** Blanchiment de l'argent sale du sac vers le compte propre, par lieu (banque, cave). */
  launder: z.object({
    /** Pas des boutons − / + du panneau ($). */
    step: z.number().int().positive(),
    /** Montants rapides proposés au guichet ($). */
    quickAmounts: z.array(z.number().int().positive()),
    venues: z.object({ bank: LaunderRulesSchema, cellar: LaunderRulesSchema }),
  }),
  /** Labo : postes de production. */
  lab: z.object({
    waterPerWatering: z.number().int().positive(),
    waterPerTap: z.number().int().positive(),
    rackCapacity: z.number().int().positive(),
    cuttingSeconds: pos,
    tableBatchMax: z.number().int().positive(),
    /** Graines prévues dans le kit de départ (pot + étendoir + table + graines), vérifié par test. */
    starterKitSeeds: z.number().int().nonnegative(),
    /** Lampes : chaque lampe à portée d'un pot réduit sa durée de pousse (cumul plafonné). */
    lamp: z.object({
      growReductionPerLamp: z.number().min(0).lt(1),
      range: pos,
      maxLamps: z.number().int().nonnegative(),
    }),
    /** Placement libre : plafond par type, dégagement autour de la porte (m). */
    furniture: z.object({
      maxPerType: perFixtureType(z.number().int().positive()),
      doorClearance: nonNeg,
    }),
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
  'lamp',
  /** Personnage à qui parler (dialogue de dialogues.json). */
  'talk',
  /** Guichet de banque : blanchiment. */
  'teller',
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
  /** Poste `talk` : id du dialogue (dialogues.json). */
  dialogue: z.string().min(1).optional(),
  /** Poste où l'on blanchit (défaut : guichet `teller` = banque). */
  launderVenue: LaunderVenueSchema.optional(),
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
  /** On peut y poser librement des meubles (labo). */
  furnishable: z.boolean().default(false),
});

export const ZonesFileSchema = z.object({ interiors: z.array(InteriorSchema) });

// ---------- shops.json ----------
/**
 * Monnaie d'un article : `dirty` = espèces du sac, `clean` = compte en banque,
 * `any` = compte s'il couvre, sinon espèces (voir `splitCart`).
 */
export const CurrencySchema = z.enum(['dirty', 'clean', 'any']);

/** Une étagère vend un objet ; `stock: null` = illimité. Le prix ne vit qu'ici (et côté serveur). */
export const ShelfSchema = z.object({
  stationId: z.string().min(1),
  itemId: z.string().min(1),
  price: z.number().int().nonnegative(),
  stock: z.number().int().nonnegative().nullable(),
  currency: CurrencySchema.default('dirty'),
});

export const ShopSchema = z.object({
  interiorId: z.string().min(1),
  shelves: z.array(ShelfSchema).min(1),
});

export const ShopsFileSchema = z.object({ shops: z.array(ShopSchema) });

// ---------- dialogues.json ----------
/**
 * Conditions d'un choix : `account` = compte ouvert, `no_account` = pas de compte,
 * `pact` / `no_pact` = pacte d'El Jefe conclu ou non (toujours conclu si
 * config.dialogue.requirePact est faux).
 */
export const DialogueConditionSchema = z.enum(['account', 'no_account', 'pact', 'no_pact']);
/** Actions exécutées par le serveur quand le choix est validé. */
export const DialogueActionSchema = z.enum(['open_account', 'accept_pact', 'open_launder']);

export const DialogueChoiceSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  /** Nœud suivant ; null = fin du dialogue. */
  next: z.string().min(1).nullable(),
  requires: z.array(DialogueConditionSchema).optional(),
  action: DialogueActionSchema.optional(),
});

export const DialogueNodeSchema = z.object({
  id: z.string().min(1),
  speaker: z.string().min(1),
  /** Texte ; `{fee}` etc. remplacés par les valeurs des JSON (voir `dialogueVars`). */
  text: z.string().min(1),
  choices: z.array(DialogueChoiceSchema).min(1),
});

export const DialogueSchema = z.object({
  id: z.string().min(1),
  /** Lieu de blanchiment dont {fee}, {cap} et {window} sont tirés (banque par défaut). */
  venue: LaunderVenueSchema.optional(),
  /** Nœud d'entrée : le premier dont les conditions sont remplies. */
  start: z
    .array(
      z.object({ node: z.string().min(1), requires: z.array(DialogueConditionSchema).optional() }),
    )
    .min(1),
  nodes: z.array(DialogueNodeSchema).min(1),
});

export const DialoguesFileSchema = z.object({ dialogues: z.array(DialogueSchema) });

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
  'bank',
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
  /**
   * Réplique renvoyée en entrant : seulement pour un lieu à intérieur (zones.json). Un lieu
   * sans intérieur ni dialogue n'est qu'un repère (étiquette, pas de bouton ACTION).
   */
  enterText: z.string().min(1).optional(),
  /** Lieu sans intérieur où l'on parle à quelqu'un depuis la rue (dialogues.json). */
  dialogue: z.string().min(1).optional(),
  /** Libellé du bouton ACTION devant ce lieu (défaut « Entrer : nom »). */
  actionLabel: z.string().min(1).optional(),
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
export type FixtureType = z.infer<typeof FixtureTypeSchema>;
export type Placeable = z.infer<typeof PlaceableSchema>;
export type Shelf = z.infer<typeof ShelfSchema>;
export type Currency = z.infer<typeof CurrencySchema>;
export type NpcProfile = z.infer<typeof NpcProfileSchema>;
export type NpcsFile = z.infer<typeof NpcsFileSchema>;
export type Shop = z.infer<typeof ShopSchema>;
export type LocationsFile = z.infer<typeof LocationsFileSchema>;
export type DialogueCondition = z.infer<typeof DialogueConditionSchema>;
export type DialogueAction = z.infer<typeof DialogueActionSchema>;
export type DialogueChoice = z.infer<typeof DialogueChoiceSchema>;
export type DialogueNode = z.infer<typeof DialogueNodeSchema>;
export type Dialogue = z.infer<typeof DialogueSchema>;
export type LaunderVenue = z.infer<typeof LaunderVenueSchema>;
export type LaunderRules = z.infer<typeof LaunderRulesSchema>;

// ---------- areas.json ----------
/** Qui tient une area (lu plus tard par le conflit et la police) ; null = personne. */
export const AreaControlSchema = z.enum(['eljefe', 'cartel']).nullable();

/**
 * Area de la rue : rectangle aligné sur la grille, thème, et réglages de vente / danger.
 * `street` = la rue centrale ; les quartiers (impasses) sont générés via `quartiers.json`.
 */
export const AreaSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  /** Message affiché en haut de l'écran en entrant dans l'area. */
  banner: z.string().min(1),
  bounds: BoundsSchema,
  themeColor: hexColor,
  /** Multiplicateur du prix proposé par les PNJ de l'area. */
  priceMultiplier: z.number().min(0.5).max(3),
  npcCount: z.number().int().nonnegative(),
  /** Multiplicateur de la chance qu'un PNJ soit intéressé (plafonnée à 1). */
  demandRate: z.number().min(0).max(3),
  /** 0 (calme) à 5 (très dangereux) : lu par la police plus tard. */
  dangerLevel: z.number().int().min(0).max(5),
  controlledBy: AreaControlSchema,
});

export const AreasFileSchema = z.object({ areas: z.array(AreaSchema).min(1) });

// ---------- quartiers.json ----------
const chance = z.number().min(0).max(1);
export const RoofSchema = z.enum(['flat', 'gable', 'sawtooth']);

/** Paramètres du générateur d'une impasse (logique pure, déterministe par `seed`). */
export const QuartierSchema = z.object({
  id: z.string().min(1),
  /** Area (areas.json) que l'impasse remplit ; elle doit toucher la rue au nord ou au sud. */
  areaId: z.string().min(1),
  /** Lieu au bout de l'impasse (porte tournée vers la rue). */
  landmarkLocationId: z.string().min(1),
  seed: z.string().min(1),
  street: z.object({
    /** Chaussée roulante, toujours libre (≥ 6 m). */
    roadWidth: z.number().min(6),
    /** Bande de stationnement de chaque côté de la chaussée. */
    parkingWidth: nonNeg,
    sidewalkWidth: pos,
    /** Bande libre entre le bord de l'area et la première maison. */
    entranceClear: nonNeg,
    /** Longueur de la rangée de maisons. */
    housesLength: pos,
    /** Placette dégagée entre les dernières maisons et le bâtiment du bout. */
    plazaDepth: pos,
    plazaWidth: pos,
    /** Points de passage des PNJ sur la chaussée, tous les N m. */
    npcWaypointSpacing: pos,
  }),
  houses: z.object({
    perSide: minMax(z.number().int().positive()),
    width: minMax(pos),
    gap: minMax(pos),
    depth: minMax(pos),
    /** Hauteur du rez-de-chaussée. */
    height: minMax(pos),
    /** Retrait de la façade derrière le trottoir (jardinet). */
    setback: minMax(pos),
    roofs: z.array(RoofSchema).min(1),
    porchChance: chance,
    garageChance: chance,
    storeyChance: chance,
    storeyHeight: pos,
    windowLitChance: chance,
  }),
  palette: z.object({
    facades: z.array(hexColor).min(1),
    roofs: z.array(hexColor).min(1),
    doors: z.array(hexColor).min(1),
    neon: hexColor,
    windows: hexColor,
    lamp: hexColor,
    ground: hexColor,
    sidewalk: hexColor,
    road: hexColor,
  }),
  decor: z.object({
    /** Distance minimale entre deux lampadaires (m). */
    streetlightSpacing: pos,
    /** Probabilités par maison. */
    binChance: chance,
    carChance: chance,
    treeChance: chance,
    crateChance: chance,
    fenceChance: chance,
    /** Guirlandes au-dessus de la chaussée tous les N m (0 = aucune). */
    garlandSpacing: nonNeg,
  }),
  /** Arche d'entrée avec enseigne néon. */
  arch: z.object({ label: z.string().min(1), height: pos }),
  /** Bâtiment du bout : portail, gardes statiques, guirlandes sur la placette. */
  landmark: z.object({
    gate: z.boolean(),
    guards: z.number().int().min(0).max(4),
    garlands: z.boolean(),
  }),
});

export const QuartiersFileSchema = z.object({
  /** Emprises de collision du décor des quartiers (m). */
  colliders: z.object({
    lampSize: pos,
    trunkSize: pos,
    binSize: z.object({ w: pos, d: pos }),
    crateSize: pos,
    fenceThickness: pos,
    /** Passage laissé dans la clôture devant la porte. */
    fenceDoorGap: pos,
  }),
  quartiers: z.array(QuartierSchema),
});

export type AreaControl = z.infer<typeof AreaControlSchema>;
export type Area = z.infer<typeof AreaSchema>;
export type Roof = z.infer<typeof RoofSchema>;
export type QuartierParams = z.infer<typeof QuartierSchema>;
export type QuartiersFile = z.infer<typeof QuartiersFileSchema>;
export type QuartierColliders = QuartiersFile['colliders'];
