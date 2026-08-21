import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: Number(process.env.WEB_PORT ?? 4311),
    // In development the SPA runs on its own port and proxies the API, so the
    // session cookie stays same-origin.
    proxy: { '/api': { target: `http://127.0.0.1:${process.env.API_PORT ?? 4310}`, changeOrigin: false } },
  },
  build: { outDir: 'dist', emptyOutDir: true, sourcemap: false },
})
