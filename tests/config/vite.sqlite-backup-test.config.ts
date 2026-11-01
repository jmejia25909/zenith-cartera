import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    ssr: 'tests/sqlite/sqlite-backup.integration.ts',
    target: 'node20',
    outDir: 'tests/.build/sqlite-backup',
    emptyOutDir: true,
    rollupOptions: {
      external: ['better-sqlite3', 'node:assert/strict', 'node:fs', 'node:os', 'node:path'],
      output: { format: 'cjs', entryFileNames: 'sqlite-backup.integration.cjs' },
    },
  },
  ssr: { external: ['better-sqlite3'] },
});
