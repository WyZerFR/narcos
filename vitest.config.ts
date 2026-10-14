import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: ['shared', 'server'],
    // sortie courte : un point par test, logs des tests affichés seulement en cas d'échec
    reporters: ['dot'],
    silent: 'passed-only',
  },
});
