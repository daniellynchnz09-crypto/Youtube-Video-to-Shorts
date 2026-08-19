import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@shared': resolve('shared')
      }
    },
    build: {
      rollupOptions: {
        input: resolve('app/main/index.ts')
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: resolve('app/preload/index.ts')
      }
    }
  },
  renderer: {
    root: resolve('app/renderer'),
    resolve: {
      alias: {
        '@shared': resolve('shared')
      }
    },
    plugins: [react()],
    build: {
      rollupOptions: {
        input: resolve('app/renderer/index.html')
      }
    }
  }
})
