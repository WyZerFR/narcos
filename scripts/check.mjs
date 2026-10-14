// `npm run check` : typecheck, lint et tests enchaînés, sortie courte.
// Succès = une ligne ; échec = sortie de l'étape fautive seulement (40 dernières lignes).
import { spawnSync } from 'node:child_process';

const steps = [
  ['typecheck', 'npm run -s typecheck'],
  ['lint', 'npx eslint . --quiet'],
  ['tests', 'npx vitest run --reporter=dot --silent=passed-only'],
];

for (const [name, cmd] of steps) {
  const r = spawnSync(cmd, { shell: true, encoding: 'utf8' });
  if (r.status !== 0) {
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim().split('\n');
    console.error(`✗ ${name}\n${out.slice(-40).join('\n')}`);
    process.exit(1);
  }
}
console.log('✓ check : typecheck, lint, tests OK');
