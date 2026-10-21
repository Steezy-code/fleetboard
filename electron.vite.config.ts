import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: { '@shared': resolve('src/shared') } }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: { rollupOptions: { output: { format: 'cjs', entryFileNames: '[name].cjs' } } }
  },
  renderer: {
    plugins: [react()],
    resolve: { alias: { '@shared': resolve('src/shared'), '@': resolve('src/renderer/src') } },
    worker: { format: 'es' },
    build: {
      // A worklet has to stay a file. Inlined as a data: URL (which is what happens to any asset under
      // the size limit) it would need script-src data: — the same grant as the blob: it replaced, and
      // the whole point was to stop script-src naming a scheme that turns a string into code.
      assetsInlineLimit: (file: string) => (file.endsWith('.worklet.js') ? false : undefined)
    },
    optimizeDeps: { exclude: ['@huggingface/transformers', 'kokoro-js'] }
  }
})
