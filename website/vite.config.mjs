import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({
  plugins: [react()],
  build: { outDir: 'dist', target: 'es2022' },
  server: { host: '127.0.0.1', port: 4196, strictPort: true },
  preview: { host: '127.0.0.1', port: 4196, strictPort: true },
});
