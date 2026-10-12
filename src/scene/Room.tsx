import { useLayoutEffect, useMemo, useRef } from 'react'
import { Environment, Lightformer, MeshReflectorMaterial } from '@react-three/drei'
import * as THREE from 'three'
import { useRack } from '../state/store'
import { RAIL_LENGTH, RAIL_Y } from './rackLayout'

export const WALL_Z = -0.55
export const FLOOR_Y = -0.62
export const RINK_BLUE = '#2fb2ff'

const chrome = new THREE.MeshStandardMaterial({ color: '#e8ecf0', roughness: 0.08, metalness: 1 })

/** Dark slatwall: horizontal grooves every 15 cm with a metal insert lip. */
function useSlatwallTextures() {
  return useMemo(() => {
    const W = 64
    const H = 512
    const c = document.createElement('canvas')
    c.width = W
    c.height = H
    const ctx = c.getContext('2d')!
    const b = document.createElement('canvas')
    b.width = W
    b.height = H
    const bctx = b.getContext('2d')!
    // 4 slats per texture tile
    const slat = H / 4
    for (let i = 0; i < 4; i++) {
      const y = i * slat
      const g = ctx.createLinearGradient(0, y, 0, y + slat)
      g.addColorStop(0, '#2a2f36')
      g.addColorStop(0.5, '#23272d')
      g.addColorStop(1, '#1d2025')
      ctx.fillStyle = g
      ctx.fillRect(0, y, W, slat)
      // groove + aluminium insert
      ctx.fillStyle = '#0c0d0f'
      ctx.fillRect(0, y + slat - 14, W, 10)
      ctx.fillStyle = '#5b636d'
      ctx.fillRect(0, y + slat - 14, W, 2)
      bctx.fillStyle = '#ffffff'
      bctx.fillRect(0, y, W, slat)
      bctx.fillStyle = '#000000'
      bctx.fillRect(0, y + slat - 14, W, 10)
    }
    const map = new THREE.CanvasTexture(c)
    map.colorSpace = THREE.SRGBColorSpace
    const bump = new THREE.CanvasTexture(b)
    for (const t of [map, bump]) {
      t.wrapS = t.wrapT = THREE.RepeatWrapping
      t.repeat.set(40, 4.2)
      t.anisotropy = 8
    }
    return { map, bump }
  }, [])
}

export function Room() {
  const quality = useRack((s) => s.quality)
  const { map, bump } = useSlatwallTextures()
  const railGeo = useMemo(() => new THREE.CylinderGeometry(0.016, 0.016, RAIL_LENGTH, 32).rotateZ(Math.PI / 2), [])
  const bracketLen = -WALL_Z
  const rim = useRef<THREE.SpotLight>(null)
  const down = useRef<THREE.SpotLight>(null)
  useLayoutEffect(() => {
    // targets aren't in the scene graph, so update their matrices by hand
    rim.current?.target.position.set(0, 0.2, 0.6)
    rim.current?.target.updateMatrixWorld()
    down.current?.target.position.set(0, 0.25, 0)
    down.current?.target.updateMatrixWorld()
  }, [])

  return (
    <>
      {/* reflections for chrome + sheen; no network HDR needed */}
      <Environment resolution={256} frames={1} environmentIntensity={0.45}>
        <Lightformer intensity={2.2} position={[0, 4, 4]} scale={[8, 3, 1]} />
        <Lightformer intensity={1} position={[-5, 1, 2]} rotation-y={Math.PI / 2} scale={[4, 2, 1]} />
        <Lightformer intensity={1} position={[5, 1, 2]} rotation-y={-Math.PI / 2} scale={[4, 2, 1]} />
        <Lightformer intensity={3} color={RINK_BLUE} position={[0, 1.4, -2]} scale={[8, 0.2, 1]} />
      </Environment>

      <hemisphereLight args={['#dfe8ff', '#121418', 0.16]} />
      {/* key: high, front-left, so sleeves, collars and folds throw real shadows */}
      <directionalLight
        position={[-1.3, 3.4, 2.6]}
        intensity={2.2}
        castShadow
        shadow-mapSize={quality === 'high' ? [2048, 2048] : [1024, 1024]}
        shadow-bias={-0.0003}
        shadow-normalBias={0.008}
        shadow-camera-left={-2.4}
        shadow-camera-right={2.4}
        shadow-camera-top={2}
        shadow-camera-bottom={-1.2}
        shadow-camera-near={0.5}
        shadow-camera-far={9}
      />
      {/* rink-blue rim from the wall, catches jersey edges */}
      <spotLight
        ref={rim}
        position={[0, 1.55, WALL_Z + 0.08]}
        angle={1.1}
        penumbra={1}
        intensity={7}
        distance={4}
        color={RINK_BLUE}
      />
      {/* retail downlight over the rail: bright shoulders falling off toward the hems */}
      <spotLight ref={down} position={[0, 2.6, 1.1]} angle={0.62} penumbra={0.9} intensity={22} decay={2} color="#fff4e6" />

      {/* slatwall */}
      <mesh position={[0, 1.1, WALL_Z]} receiveShadow>
        <planeGeometry args={[12, 4.2]} />
        <meshStandardMaterial map={map} bumpMap={bump} bumpScale={1.5} roughness={0.7} metalness={0.15} />
      </mesh>
      {/* LED accent strip above the rail */}
      <mesh position={[0, RAIL_Y + 0.3, WALL_Z + 0.012]}>
        <boxGeometry args={[RAIL_LENGTH + 0.6, 0.012, 0.012]} />
        <meshBasicMaterial color={RINK_BLUE} toneMapped={false} />
      </mesh>
      {/* yellow kick plate, a nod to rink boards */}
      <mesh position={[0, FLOOR_Y + 0.05, WALL_Z + 0.006]}>
        <boxGeometry args={[12, 0.1, 0.012]} />
        <meshStandardMaterial color="#f2c230" roughness={0.45} />
      </mesh>
      <mesh position={[0, FLOOR_Y + 0.006, WALL_Z + 0.03]}>
        <boxGeometry args={[12, 0.012, 0.04]} />
        <meshBasicMaterial color={RINK_BLUE} toneMapped={false} />
      </mesh>

      {/* ice floor */}
      <mesh rotation-x={-Math.PI / 2} position={[0, FLOOR_Y, 2]} receiveShadow>
        <planeGeometry args={[12, 6]} />
        {quality === 'high' ? (
          <MeshReflectorMaterial
            resolution={512}
            blur={[400, 100]}
            mixBlur={1}
            mixStrength={1.4}
            mirror={0.5}
            roughness={0.55}
            depthScale={0.6}
            minDepthThreshold={0.4}
            maxDepthThreshold={1.2}
            color="#dfe7ee"
            metalness={0.05}
          />
        ) : (
          <meshStandardMaterial color="#dfe7ee" roughness={0.35} metalness={0.05} />
        )}
      </mesh>

      {/* rail, end caps, wall brackets */}
      <mesh geometry={railGeo} material={chrome} position={[0, RAIL_Y, 0]} castShadow />
      {[-1, 1].map((s) => (
        <group key={s} position={[(s * RAIL_LENGTH) / 2, RAIL_Y, 0]}>
          <mesh material={chrome} castShadow>
            <sphereGeometry args={[0.026, 24, 16]} />
          </mesh>
          <mesh material={chrome} position={[0, 0, -bracketLen / 2]} rotation-x={Math.PI / 2} castShadow>
            <cylinderGeometry args={[0.012, 0.012, bracketLen, 16]} />
          </mesh>
          <mesh material={chrome} position={[0, 0, -bracketLen + 0.006]} rotation-x={Math.PI / 2}>
            <cylinderGeometry args={[0.045, 0.045, 0.012, 32]} />
          </mesh>
        </group>
      ))}
    </>
  )
}
