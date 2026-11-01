import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    ssr: 'tests/crm/promesa-document-associations.integration.ts',
    target: 'node20',
    outDir: 'tests/.build/promesa-documents',
    emptyOutDir: true,
    rollupOptions: {
      external: ['better-sqlite3', 'node:assert/strict', 'node:fs', 'node:os', 'node:path'],
      output: { format: 'cjs', entryFileNames: 'promesa-document-associations.integration.cjs' },
    },
  },
  ssr: { external: ['better-sqlite3'] },
});
