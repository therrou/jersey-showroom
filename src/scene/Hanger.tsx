import { useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import { JERSEY_DROP } from './rackLayout'

// The bar sits inside the jersey and is only ever seen through the neck opening, where
// the fabric keeps most light off it: a dim, matte wood instead of the lit, glossy one.
const innerWood = new THREE.MeshStandardMaterial({ color: '#2e1c12', roughness: 0.7, envMapIntensity: 0.35 })
const chrome = new THREE.MeshStandardMaterial({ color: '#dfe3e8', roughness: 0.12, metalness: 1 })

const _q = new THREE.Quaternion()
const _f = new THREE.Vector3()

/** Hook centreline radius: clears the 16 mm rail with the wire's thickness to spare. */
const HOOK_WIRE = 0.003
const HOOK_R = 0.016 + HOOK_WIRE + 0.0015

class HookCurve extends THREE.Curve<THREE.Vector3> {
  constructor() {
    super()
  }

  getPoint(t: number, out = new THREE.Vector3()) {
    // angle from straight up toward the front (+z): bottom (π) → front → top → back
    const a = Math.PI - t * (Math.PI * 1.72)
    return out.set(0, HOOK_R * Math.cos(a), HOOK_R * Math.sin(a))
  }
}

function useHangerGeometry() {
  return useMemo(() => {
    const y = -JERSEY_DROP
    // sits ~3 cm inside the shoulders so it never pokes through the fabric
    const barCurve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(-0.19, y - 0.066, 0),
      new THREE.Vector3(-0.1, y - 0.045, 0),
      new THREE.Vector3(0, y - 0.034, 0),
      new THREE.Vector3(0.1, y - 0.045, 0),
      new THREE.Vector3(0.19, y - 0.066, 0),
    ])
    const bar = new THREE.TubeGeometry(barCurve, 40, 0.011, 10, false)
    bar.scale(1, 1, 0.45)
    // A hanger hook round the rail (radius 0.016, along x): the rod comes up under the
    // rail, curves up the front, over the top and down the back to the open end, so
    // from the room you see the hook in front of the rail, not the rail on top of it.
    const R = HOOK_R
    const hook = new THREE.TubeGeometry(new HookCurve(), 48, HOOK_WIRE, 8, false)
    const rodLength = JERSEY_DROP - R + 0.004
    const rod = new THREE.CylinderGeometry(HOOK_WIRE, HOOK_WIRE, rodLength, 8)
    rod.translate(0, -R - rodLength / 2 + 0.002, 0)
    return { bar, hook, rod }
  }, [])
}

/** Wooden hanger with a chrome hook. Origin = the rail's axis, where the hook pivots.
 *  Pass `fade` (0–1) to fade it with the modal jersey. */
export function Hanger({ fade }: { fade?: { value: number } }) {
  const { bar, hook, rod } = useHangerGeometry()
  const mats = useMemo(() => {
    if (!fade) return { wood: innerWood, chrome }
    return {
      wood: Object.assign(innerWood.clone(), { transparent: true }),
      chrome: Object.assign(chrome.clone(), { transparent: true }),
    }
  }, [fade])
  const hookRef = useRef<THREE.Mesh>(null)
  useFrame(() => {
    // the hook swivels: whichever way the hanger turns, it stays wrapped across the rail
    const h = hookRef.current
    if (h?.parent) {
      h.parent.getWorldQuaternion(_q)
      _f.set(0, 0, 1).applyQuaternion(_q)
      h.rotation.y = -Math.atan2(_f.x, _f.z)
    }
    if (!fade) return
    mats.wood.opacity = mats.chrome.opacity = fade.value
  })
  return (
    <group>
      <mesh geometry={bar} material={mats.wood} castShadow receiveShadow />
      <mesh ref={hookRef} geometry={hook} material={mats.chrome} castShadow />
      <mesh geometry={rod} material={mats.chrome} castShadow />
    </group>
  )
}
