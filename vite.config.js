import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig(({ command }) => ({
  // Project page lives at https://tailvis.github.io/TailVis/ — assets need that base
  // on build. Dev server stays at '/'.
  base: command === 'build' ? '/TailVis/' : '/',
  plugins: [react()],
  // Pre-bundle the heavy viz stack once so dev first-load doesn't stall on
  // on-demand esbuild optimization of vega-lite/vega/d3.
  optimizeDeps: {
    include: ['vega', 'vega-lite', 'vega-embed', 'd3'],
  },
  server: {
    host: '0.0.0.0',
    port: 5104,
    // If serving over a public domain, add its hostname here, e.g. ['example.com']
    allowedHosts: [],
    proxy: {
      '/api': {
        target: 'http://localhost:5105',
        changeOrigin: true
      }
    }
  }
}))
