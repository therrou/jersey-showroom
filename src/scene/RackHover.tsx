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
export const rackView = { portrait: false, pan: 0, panLimit: 0, touch: false }

const TOP = RAIL_Y + 0.05
const BOTTOM = RAIL_Y - JERSEY_DROP - 0.86
/** Half-width the turned jersey keeps the hover for (its torso), vs. a side-on slot. */
const HOLD = 0.3
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
/** Carousel: a horizontal swipe this long steps one jersey. */
const SWIPE_PX = 40

/**
 * Hover by rail position rather than raycasting slivers of fabric: the nearest hanger
 * wins, and the turned-out jersey holds the hover across its full width, so moving
 * across the rack never flickers through gaps.
 *
 * Touch (landscape): tap turns a jersey out, a second tap opens it.
 * Carousel (portrait, any pointer): the active jersey faces you; tapping it flips it,
 * tapping a neighbour or swiping steps to another one. There's no modal.
 */
export function RackHover() {
  const gl = useThree((s) => s.gl)
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera

  // Mouse: hover follows the pointer every frame.
  useFrame(() => {
    const { hovered, phase, setHovered, carousel } = useRack.getState()
    if (phase !== 'closed' || rackView.touch) return
    const next = cursor.active ? pick(cursor.pos.x, cursor.pos.y, hovered) : null
    if (carousel) {
      // the active slide only changes on a tap/swipe/arrow, never on hover
      gl.domElement.style.cursor = next !== null ? 'pointer' : ''
      return
    }
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
    const drag = { id: -1, x0: 0, y0: 0, moved: false }

    const down = (e: PointerEvent) => {
      rackView.touch = e.pointerType === 'touch'
      if (!rackView.touch && !useRack.getState().carousel) return
      drag.id = e.pointerId
      drag.x0 = e.clientX
      drag.y0 = e.clientY
      drag.moved = false
    }
    const move = (e: PointerEvent) => {
      if (e.pointerId !== drag.id) return
      if (Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) > TAP_SLOP) drag.moved = true
    }
    const up = (e: PointerEvent) => {
      if (e.pointerId !== drag.id) return
      drag.id = -1
      const { hovered, carousel, setHovered, openJersey, showSlide, stepSlide, flipSlide } = useRack.getState()
      if (e.type === 'pointercancel') return
      if (drag.moved) {
        // carousel: a horizontal swipe steps one jersey (swipe left = next)
        const dx = e.clientX - drag.x0
        if (carousel && Math.abs(dx) > SWIPE_PX && Math.abs(dx) > Math.abs(e.clientY - drag.y0)) stepSlide(dx < 0 ? 1 : -1)
        return
      }
      const p = toWorld(e)
      const next = p ? pick(p.x, p.y, hovered) : null
      if (carousel) {
        // tap the active jersey to flip it, a neighbour to make it the active one
        if (next === null) return
        if (next === hovered) flipSlide()
        else showSlide(next)
        return
      }
      // tap: first tap turns a jersey out, a second tap on the same one opens it
      if (next !== null && next === hovered) openJersey(next)
      else setHovered(next)
    }
    const click = (e: MouseEvent) => {
      if (rackView.touch) return
      const { hovered, openJersey, carousel } = useRack.getState()
      if (carousel) return
      if (hovered !== null && (e as PointerEvent).pointerType !== 'touch') openJersey(hovered)
    }
    const key = (e: KeyboardEvent) => {
      const s = useRack.getState()
      if (!s.carousel || s.phase !== 'closed') return
      if (e.key === 'ArrowRight') s.stepSlide(1)
      else if (e.key === 'ArrowLeft') s.stepSlide(-1)
      else if (e.key.toLowerCase() === 'f') s.flipSlide()
    }
    el.addEventListener('pointerdown', down)
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
    el.addEventListener('pointercancel', up)
    el.addEventListener('click', click)
    window.addEventListener('keydown', key)
    return () => {
      window.removeEventListener('keydown', key)
      el.removeEventListener('pointerdown', down)
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
      el.removeEventListener('pointercancel', up)
      el.removeEventListener('click', click)
    }
  }, [gl, camera])

  return null
}
