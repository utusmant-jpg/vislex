import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  clearScreen: false,
  server: { port: 1420, strictPort: true, watch: { ignored: ['**/src-tauri/target/**', '**/artifacts/**', '**/workers/models/**', '**/.venv-worker/**', '**/.claude/**'] } },
  envPrefix: ['VITE_', 'TAURI_ENV_'],
  build: { target: 'es2022' },
  test: { setupFiles: ['src/testSetup.ts'], testTimeout: 15000, exclude: ['e2e/**', '**/node_modules/**', '**/dist/**', '**/artifacts/**', '**/.claude/**'] },
});
