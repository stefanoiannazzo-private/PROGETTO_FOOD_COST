import type { NextConfig } from 'next'

const API_URL = process.env.API_URL ?? 'http://127.0.0.1:4000'

const nextConfig: NextConfig = {
  // il pacchetto di dominio è TypeScript sorgente: Next lo compila
  transpilePackages: ['@foodcost/domain'],
  poweredByHeader: false,
  reactStrictMode: true,
  // stessa origine per browser e API: cookie di sessione semplici e niente CORS
  async rewrites() {
    return [{ source: '/api/:path*', destination: `${API_URL}/api/:path*` }]
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'same-origin' },
        ],
      },
    ]
  },
}

export default nextConfig
