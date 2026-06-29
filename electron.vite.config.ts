import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    // @agent-socket/sdk is ESM-only; bundle it into the CJS main output instead
    // of externalizing (Electron's main can't require() an ESM-only package).
    // ws stays external (CJS, fine to require).
    plugins: [externalizeDepsPlugin({ exclude: ['@agent-socket/sdk'] })]
  },
  preload: {
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    // The BlitzOS Support backend base URL. Defaults to localhost for dev; the prod Cloudflare URL
    // (https://blitzos-support.app.blitz.dev) is injected via SUPPORT_API_URL at package time.
    define: {
      'import.meta.env.VITE_SUPPORT_API': JSON.stringify(process.env.SUPPORT_API_URL || 'http://localhost:8787')
    },
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src')
      }
    },
    plugins: [react()]
  }
})
