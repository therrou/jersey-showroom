import { JERSEYS } from '../data/jerseys'
import { buildProceduralJersey, type JerseyMesh } from './JerseyGeometry'
import { createJerseyKit, type JerseyKit } from './jerseyTexture'

// Swap point for a GLB-backed implementation of JerseyMesh.
let rackMesh: JerseyMesh | null = null
export function getRackJerseyMesh(): JerseyMesh {
  rackMesh ??= buildProceduralJersey({ cols: 60, rows: 44 })
  return rackMesh
}

const clothMeshes = new Map<string, JerseyMesh>()
export function getClothJerseyMesh(cols: number, rows: number): JerseyMesh {
  const key = `${cols}x${rows}`
  if (!clothMeshes.has(key)) clothMeshes.set(key, buildProceduralJersey({ cols, rows }))
  return clothMeshes.get(key)!
}

const kits = new Map<string, Promise<JerseyKit>>()
/** Kit maps for jersey `index` at colour-atlas width `width` (cached; safe to call early to warm). */
export function jerseyKit(index: number, width: number): Promise<JerseyKit> {
  const key = `${index}@${width}`
  if (!kits.has(key)) kits.set(key, createJerseyKit(JERSEYS[index], width))
  return kits.get(key)!
}
