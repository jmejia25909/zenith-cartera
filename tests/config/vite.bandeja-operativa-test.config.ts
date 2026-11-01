import {defineConfig} from 'vite';
export default defineConfig({build:{ssr:'tests/tasks/bandeja-operativa.integration.ts',target:'node20',outDir:'tests/.build/bandeja-operativa',emptyOutDir:true,rollupOptions:{external:['better-sqlite3','node:assert/strict','node:fs','node:path'],output:{format:'cjs',entryFileNames:'bandeja-operativa.integration.cjs'}}},ssr:{external:['better-sqlite3']}});
