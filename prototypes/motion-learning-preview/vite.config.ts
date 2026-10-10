import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
const here=dirname(fileURLToPath(import.meta.url))
export default defineConfig({
  root:here,
  publicDir:resolve(here,'../../apps/web/public'),
  plugins:[react()],
  build:{
    outDir:resolve(here,'dist'),
    emptyOutDir:true,
    sourcemap:false,
    rollupOptions:{input:resolve(here,'index.html')}
  },
  server:{port:4321,host:'127.0.0.1'}
})
