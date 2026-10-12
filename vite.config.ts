import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

/** Dev only: tools/kit-export.html posts painted kit atlases here so the Blender build
 *  can preview the real painter output on the GLB (see tools/blender/README.md). */
function kitExport(): Plugin {
  const dir = resolve(import.meta.dirname, 'tools/blender/kits')
  return {
    name: 'kit-export',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__kit-export', (req, res) => {
        const name = new URL(req.url ?? '', 'http://x').searchParams.get('name') ?? ''
        if (req.method !== 'POST' || !/^[\w-]+\.png$/.test(name)) {
          res.statusCode = 400
          res.end()
          return
        }
        const chunks: Buffer[] = []
        req.on('data', (c: Buffer) => chunks.push(c))
        req.on('end', () => {
          mkdirSync(dir, { recursive: true })
          writeFileSync(resolve(dir, name), Buffer.concat(chunks))
          res.end('ok')
        })
      })
    },
  }
}

export default defineConfig({
  plugins: [react(), kitExport()],
  worker: { format: 'es' },
})
