import { useMemo } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import { JERSEY_DROP } from './rackLayout'

const wood = new THREE.MeshPhysicalMaterial({ color: '#6e4128', roughness: 0.38, clearcoat: 0.5, clearcoatRoughness: 0.35 })
const chrome = new THREE.MeshStandardMaterial({ color: '#dfe3e8', roughness: 0.12, metalness: 1 })

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
    // starts under the rail, wraps round the back, over the top and down the front
    const hook = new THREE.TorusGeometry(0.02, 0.0028, 8, 32, Math.PI * 1.4)
    hook.rotateZ(-Math.PI / 2)
    hook.rotateY(Math.PI / 2)
    const rodLength = JERSEY_DROP + 0.01
    const rod = new THREE.CylinderGeometry(0.0028, 0.0028, rodLength, 8)
    rod.translate(0, -0.02 - rodLength / 2, 0)
    return { bar, hook, rod }
  }, [])
}

/** Wooden hanger with a chrome hook. Origin = the rail's axis, where the hook pivots.
 *  Pass `fade` (0–1) to fade it with the modal jersey. */
export function Hanger({ fade }: { fade?: { value: number } }) {
  const { bar, hook, rod } = useHangerGeometry()
  const mats = useMemo(() => {
    if (!fade) return { wood, chrome }
    return {
      wood: Object.assign(wood.clone(), { transparent: true }),
      chrome: Object.assign(chrome.clone(), { transparent: true }),
    }
  }, [fade])
  useFrame(() => {
    if (!fade) return
    mats.wood.opacity = mats.chrome.opacity = fade.value
  })
  return (
    <group>
      <mesh geometry={bar} material={mats.wood} castShadow />
      <mesh geometry={hook} material={mats.chrome} castShadow />
      <mesh geometry={rod} material={mats.chrome} castShadow />
    </group>
  )
}
