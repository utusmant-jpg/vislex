import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
export default defineConfig({ plugins: [react()], clearScreen: false, server: { port: 1420, strictPort: true, watch: { ignored: ['**/src-tauri/target/**', '**/artifacts/**', '**/workers/models/**', '**/.venv-worker/**'] } }, envPrefix: ['VITE_', 'TAURI_ENV_'], build: { target: 'es2022' }, test: { exclude: ['e2e/**', '**/node_modules/**', '**/dist/**'] } });
