import { useEffect } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import * as THREE from 'three'
import { useRack } from '../state/store'
import { cursor } from './CursorTracker'
import { JERSEY_DROP, RAIL_Y, SLOT_SIDE } from './rackLayout'

/** Live x of each hanger on the rail, written by HangerRig every frame. */
export const hangerX: number[] = []
/** Live yaw of each hanger (0 = facing the viewer). */
export const hangerYaw: number[] = []

/** Portrait/touch view state shared with the camera rig. */
export const rackView = { portrait: false, pan: 0, panLimit: 0, dragging: false, touch: false }

const TOP = RAIL_Y + 0.05
const BOTTOM = RAIL_Y - JERSEY_DROP - 0.86
/** Half-width the turned jersey keeps the hover for (its torso), vs. a side-on slot. */
const HOLD = 0.34
const CATCH = SLOT_SIDE * 0.6

/** The jersey under rail position (x, y), with the turned-out one holding its width. */
function pick(x: number, y: number, hovered: number | null): number | null {
  if (y > TOP || y < BOTTOM) return null
  if (hovered !== null && Math.abs(x - hangerX[hovered]) < HOLD) return hovered
  let next: number | null = null
  let best = Infinity
  hangerX.forEach((hx, i) => {
    const d = Math.abs(x - hx)
    if (d < best && d < CATCH) {
      best = d
      next = i
    }
  })
  // inside the gap the turned-out jersey leaves, keep the current one
  if (next === null && hovered !== null && Math.abs(x - hangerX[hovered]) < HOLD + CATCH) return hovered
  return next
}

const PLANE = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0)
const TAP_SLOP = 8 // px

/**
 * Hover by rail position rather than raycasting slivers of fabric: the nearest hanger
 * wins, and the turned-out jersey holds the hover across its full width, so moving
 * across the rack never flickers through gaps.
 *
 * Touch: tap turns a jersey out, a second tap opens it; swipes pan the rail in portrait.
 */
export function RackHover() {
  const gl = useThree((s) => s.gl)
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera

  // Mouse: hover follows the pointer every frame.
  useFrame(() => {
    const { hovered, phase, setHovered } = useRack.getState()
    if (phase !== 'closed' || rackView.touch) return
    const next = cursor.active ? pick(cursor.pos.x, cursor.pos.y, hovered) : null
    if (next !== hovered) setHovered(next)
    gl.domElement.style.cursor = next !== null ? 'pointer' : ''
  })

  useEffect(() => {
    const el = gl.domElement
    const ray = new THREE.Raycaster()
    const ndc = new THREE.Vector2()
    const hit = new THREE.Vector3()
    const toWorld = (e: PointerEvent) => {
      const r = el.getBoundingClientRect()
      ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1)
      ray.setFromCamera(ndc, camera)
      return ray.ray.intersectPlane(PLANE, hit)
    }
    const drag = { id: -1, x0: 0, pan0: 0, moved: false }

    const down = (e: PointerEvent) => {
      rackView.touch = e.pointerType === 'touch'
      if (!rackView.touch) return
      drag.id = e.pointerId
      drag.x0 = e.clientX
      drag.pan0 = rackView.pan
      drag.moved = false
    }
    const move = (e: PointerEvent) => {
      if (e.pointerId !== drag.id) return
      const dx = e.clientX - drag.x0
      if (Math.abs(dx) > TAP_SLOP) drag.moved = true
      if (!drag.moved || !rackView.portrait) return
      // swipe pans the camera along the rail (1:1 with the finger at the rail plane)
      const vfov = THREE.MathUtils.degToRad(camera.fov)
      const worldPerPx = (2 * camera.position.z * Math.tan(vfov / 2)) / el.clientHeight
      rackView.dragging = true
      rackView.pan = drag.pan0 - dx * worldPerPx
      if (useRack.getState().hovered !== null) useRack.getState().setHovered(null)
    }
    const up = (e: PointerEvent) => {
      if (e.pointerId !== drag.id) return
      drag.id = -1
      rackView.dragging = false
      if (drag.moved) return
      // tap: first tap turns a jersey out, a second tap on the same one opens it
      const p = toWorld(e)
      const { hovered, setHovered, openJersey } = useRack.getState()
      const next = p ? pick(p.x, p.y, hovered) : null
      if (next !== null && next === hovered) openJersey(next)
      else setHovered(next)
    }
    const click = (e: MouseEvent) => {
      if (rackView.touch) return
      const { hovered, openJersey } = useRack.getState()
      if (hovered !== null && (e as PointerEvent).pointerType !== 'touch') openJersey(hovered)
    }
    el.addEventListener('pointerdown', down)
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
    el.addEventListener('pointercancel', up)
    el.addEventListener('click', click)
    return () => {
      el.removeEventListener('pointerdown', down)
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
      el.removeEventListener('pointercancel', up)
      el.removeEventListener('click', click)
    }
  }, [gl, camera])

  return null
}
