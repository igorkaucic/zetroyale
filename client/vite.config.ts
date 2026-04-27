import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import fs from 'fs'

export default defineConfig({
  base: './',
  plugins: [react()],
  build: {
    outDir: '../public_v2',
    emptyOutDir: true,
  },
  server: {
    host: true,
    https: {
      key: fs.readFileSync('../localhost-key.pem'),
      cert: fs.readFileSync('../localhost.pem'),
    },
    proxy: {
      '/api': {
        target: 'https://localhost:3268',
        changeOrigin: true,
        secure: false,
      },
    },
  },
})
