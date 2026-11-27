import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: { host: '127.0.0.1', port: 1420, strictPort: true,
    watch: { ignored: ['**/src-tauri/target/**'] } },
  envPrefix: ['VITE_', 'TAURI_ENV_*'],
  // The desktop window and the page the app serves to the phone.
  build: { rollupOptions: { input: { main: 'index.html', mobile: 'mobile.html' } } },
  test: { environment: 'jsdom', include: ['src/**/*.test.tsx'] },
});
