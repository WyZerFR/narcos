/**
 * Audit des collisions (`npm run collisions`) : milliers de déplacements aléatoires et dirigés
 * avec la fonction de collision partagée, par zone. La version courte tourne dans `npm test`.
 * Usage : `npm run collisions -- 4000` (tirages par zone, défaut 3000).
 */
import { auditOptions, auditZone, auditZones, gameData, type AuditCounts } from '@narco/shared';

const samples = Number(process.argv[2]) || 3000;
const opts = auditOptions(gameData, samples);
const keys: (keyof AuditCounts)[] = [
  'stuck',
  'slideLoss',
  'tunnel',
  'entryBlocked',
  'falseCorrection',
  'insideAfterValidate',
  'narrowGaps',
  'furnitureTrap',
];
console.log(`Audit des collisions : ${samples} tirages par zone, rayon ${opts.radius} m`);
console.log(['zone'.padEnd(26), 'tirages', ...keys].join(' | '));
const total: Record<string, number> = {};
for (const z of auditZones(gameData)) {
  const c = auditZone(z, opts);
  for (const k of keys) total[k] = (total[k] ?? 0) + c[k];
  console.log(
    [
      z.id.padEnd(26),
      String(c.samples).padStart(7),
      ...keys.map((k) => String(c[k]).padStart(k.length)),
    ].join(' | '),
  );
}
console.log(
  [
    'TOTAL'.padEnd(26),
    ''.padStart(7),
    ...keys.map((k) => String(total[k]).padStart(k.length)),
  ].join(' | '),
);
