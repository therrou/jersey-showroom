import { useEffect, useMemo } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import * as THREE from 'three'

const PLANE = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0)
/** Pointer speed cap (m/s on the rail plane); synthetic jumps can't turn into hammer blows. */
const MAX_SPEED = 4

/**
 * Shared pointer state on the rail plane. Each HangerRig reads it in its physics step
 * and applies a contact impulse where the cursor touches its fabric (see brushJersey).
 */
export const cursor = {
  active: false,
  pos: new THREE.Vector3(0, -50, 0),
  vel: new THREE.Vector3(),
  radius: 0.05,
}

/** Tracks the pointer as a physical brush: position + smoothed, clamped velocity. */
export function CursorTracker() {
  const gl = useThree((s) => s.gl)

  useEffect(() => {
    const el = gl.domElement
    const enter = () => (cursor.active = true)
    const leave = () => {
      cursor.active = false
      cursor.vel.set(0, 0, 0)
    }
    el.addEventListener('pointermove', enter)
    el.addEventListener('pointerleave', leave)
    return () => {
      el.removeEventListener('pointermove', enter)
      el.removeEventListener('pointerleave', leave)
    }
  }, [gl])

  const st = useMemo(
    () => ({ ray: new THREE.Raycaster(), hit: new THREE.Vector3(), tmp: new THREE.Vector3(), primed: false }),
    [],
  )
  useFrame(({ pointer, camera }, rawDt) => {
    const dt = Math.max(rawDt, 1 / 240)
    st.ray.setFromCamera(pointer, camera)
    if (!st.ray.ray.intersectPlane(PLANE, st.hit)) return
    if (!st.primed) {
      cursor.pos.copy(st.hit)
      st.primed = true
    }
    const v = st.tmp.copy(st.hit).sub(cursor.pos).divideScalar(dt).clampLength(0, MAX_SPEED)
    // light smoothing so a single jittery frame doesn't spike the impulse
    cursor.vel.lerp(v, 0.6)
    cursor.pos.copy(st.hit)
  })
  return null
}
