import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

/** Dev only: tools/kit-export.html posts painted kit atlases here so the Blender build
 *  can preview the real painter output on the GLB (see tools/blender/README.md);
 *  tools/kit-bake.html posts the shipped kit atlases (`?to=bake`, see README → Kit art). */
function kitExport(): Plugin {
  const dirs = {
    blender: resolve(import.meta.dirname, 'tools/blender/kits'),
    bake: resolve(import.meta.dirname, 'assets-src/kits'),
  }
  return {
    name: 'kit-export',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__kit-export', (req, res) => {
        const params = new URL(req.url ?? '', 'http://x').searchParams
        const name = params.get('name') ?? ''
        const dir = params.get('to') === 'bake' ? dirs.bake : dirs.blender
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
