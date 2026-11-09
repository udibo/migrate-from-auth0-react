import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  return {
    plugins: [react()],
    server: {
      port: 3000,
    },
    build: {
      outDir: 'dist',
    },
    define: {
      'process.env.OAUTH_ISSUER': JSON.stringify(env.OAUTH_ISSUER || process.env.OAUTH_ISSUER || ''),
      'process.env.OAUTH_CLIENT_ID': JSON.stringify(env.OAUTH_CLIENT_ID || process.env.OAUTH_CLIENT_ID || ''),
      'process.env.OAUTH_AUDIENCE': JSON.stringify(env.OAUTH_AUDIENCE || process.env.OAUTH_AUDIENCE || ''),
      'process.env.API_BASE_URL': JSON.stringify(env.API_BASE_URL || process.env.API_BASE_URL || ''),
    },
  }
})
