import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url))

/**
 * Build statica dell'interfaccia: finisce in public/app di Laravel e viene servita
 * dalla rotta di fallback (routes/web.php). In sviluppo /api è inoltrato a `php artisan serve`.
 */
export default defineConfig({
  base: '/app/',
  plugins: [react()],
  resolve: {
    alias: [
      { find: /^next\/link$/, replacement: r('./shims/next-link.tsx') },
      { find: /^next\/navigation$/, replacement: r('./shims/next-navigation.ts') },
      { find: /^@foodcost\/domain$/, replacement: r('./packages/domain/index.ts') },
      { find: /^@\//, replacement: r('./') + '/' },
    ],
  },
  build: {
    outDir: r('../../public/app'),
    emptyOutDir: true,
    sourcemap: false,
    chunkSizeWarningLimit: 800,
  },
  server: {
    port: 5173,
    proxy: { '/api': { target: process.env.API_URL ?? 'http://127.0.0.1:8000', changeOrigin: false } },
  },
})
