import path from 'node:path'
import type { NextConfig } from 'next'

/**
 * In sviluppo l'interfaccia inoltra /api/* all'API locale.
 * In produzione /api/* è instradato direttamente all'API dal reverse proxy (Caddy):
 * si costruisce con API_REWRITE=off e il rewrite non viene generato.
 */
const API_URL = process.env.API_URL ?? 'http://127.0.0.1:4000'
const rewrite = process.env.API_REWRITE !== 'off'

const nextConfig: NextConfig = {
  // il pacchetto di dominio è TypeScript sorgente: Next lo compila
  transpilePackages: ['@foodcost/domain'],
  // server autonomo e leggero per l'immagine Docker
  output: 'standalone',
  outputFileTracingRoot: path.join(__dirname, '../../'),
  poweredByHeader: false,
  reactStrictMode: true,
  async rewrites() {
    return rewrite ? [{ source: '/api/:path*', destination: `${API_URL}/api/:path*` }] : []
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'same-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
        ],
      },
    ]
  },
}

export default nextConfig
