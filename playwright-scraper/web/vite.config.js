import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dev: `npm run dev` here + `node src/app.js` in the parent; API calls proxy to it.
export default defineConfig({
  plugins: [react()],
  server: { port: 5173, proxy: { '/jobs': 'http://localhost:3000', '/presets': 'http://localhost:3000', '/healthz': 'http://localhost:3000' } },
  build: { outDir: 'dist', emptyOutDir: true, sourcemap: false }
});
