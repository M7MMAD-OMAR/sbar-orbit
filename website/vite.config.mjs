import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { analyticsTag, recorderTag } from './analytics.config.mjs';

const analyticsPlugin = { name: 'orbit-analytics-tag', transformIndexHtml: { order: 'post', handler: (html) => html.replace('</head>', `    ${analyticsTag()}\n    ${recorderTag()}\n  </head>`) } };
export default defineConfig({
  plugins: [react(), analyticsPlugin],
  build: { outDir: 'dist', target: 'es2022' },
  server: { host: '127.0.0.1', port: 4196, strictPort: true },
  preview: { host: '127.0.0.1', port: 4196, strictPort: true },
});
