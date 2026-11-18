import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Em dev, /api vai para o Express local (PORT padrao 3000).
export default defineConfig({
  plugins: [react()],
  server: { proxy: { '/api': 'http://localhost:3000' } },
});
