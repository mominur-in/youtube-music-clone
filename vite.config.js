import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],

  server: {
    host: '0.0.0.0',
    port: 3001,
    strictPort: true,
    allowedHosts: ['music.devhubx.org'],
    proxy: {
      '/api': {
        target: 'http://localhost:3002',
        changeOrigin: true,
        timeout: 120000,
        proxyTimeout: 120000,
      },
    },
  },

  preview: {
    host: '0.0.0.0',
    port: 3001,
    strictPort: true,
  },

  build: {
    outDir: 'dist',
    sourcemap: false,
    minify: 'esbuild',
  },
});
