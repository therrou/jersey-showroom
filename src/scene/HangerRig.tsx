import { use, useEffect, useLayoutEffect, useMemo, useRef, type RefObject } from 'react'
import { useFrame } from '@react-three/fiber'
import {
  BallCollider,
  CuboidCollider,
  RigidBody,
  useBeforePhysicsStep,
  useSphericalJoint,
  type RapierCollider,
  type RapierRigidBody,
} from '@react-three/rapier'
import * as THREE from 'three'
import { m, physics } from '../config/physics'
import { JERSEYS } from '../data/jerseys'
import { jerseyAssets, jerseyKit } from '../jersey/assets'
import { createFabricDepthMaterial, createFabricMaterial, createFabricUniforms } from '../jersey/fabricMaterial'
import { sleeveRig } from '../jersey/sleeves'
import { useRack } from '../state/store'
import { cursor } from './CursorTracker'
import { Hanger } from './Hanger'
import { hangerX, hangerYaw } from './RackHover'
import { GROUP_JERSEY, GROUP_NONE, JERSEY_DROP, RAIL_Y, SIDE_YAW, slotPositions } from './rackLayout'

// Masses the springs are tuned against (trolley + hanger + jersey, and hanger yaw inertia).
const SLIDE_MASS = 0.95
const YAW_INERTIA = 0.018
// Hangers can't spin up or flip over the rail.
const MAX_SPIN = 10
const TILT_LIMIT = THREE.MathUtils.degToRad(40)
const TILT_K = 3
// After the put-back, the jersey only starts colliding again once its neighbours have slid
// clear: it lands in its turned-out slot while they're still making room.
const REJOIN_MS = 1400
// Side-on jerseys draw the light mesh; the turned-out one swaps to the detailed mesh at
// once, and back only after it has turned side-on again (so the swap is never seen).
const LOD_DOWN_MS = 1100
// Per-jersey drape variety (side-on only; a turned-out jersey eases back to the shared
// drape, which is what the modal's cloth starts from). Sleeves hang just in front of the
// body's sides, so they swing mostly forward, and always splay out a little.
const SWING = [-0.05, 0.16] // rad, + = cuff forward
const SPLAY = [0.025, 0.09] // rad, cuff outward
const HEM_TILT_Z = 0.22 // ± drop per metre toward the front
const HEM_TILT_X = 0.05 // ± drop per metre to the side
const FOLD = [0.55, 1.6] // × the base fold depth
const BODY_TWIST = 0.1 // ± rad at the hem
const HEM_OPEN = 0.35 // ± × the tube's depth at the hem
const HEM_SHIFT = 0.015 // ± m forward/back at the hem
const EDGE_WAVE = 0.012 // up to m
const VARIETY_RATE = 6 // 1/s, easing in/out of the variety
// Drape variants baked in Blender (morph targets): each jersey mostly hangs in one of the
// base + N drapes (neighbours never share it), with a little of another mixed in.
const DRAPE_MIX = [0.15, 0.35]

/** Morph weights over the variant drapes for jersey `index` (base drape = the rest). */
function drapeWeights(index: number, seed: number, variants: number) {
  const w = new Array<number>(variants).fill(0)
  if (!variants) return w
  const n = variants + 1
  const main = (index * 3 + 1) % n
  const other = (main + 1 + Math.floor(hash(seed, 12) * (n - 1))) % n
  const share = lerp(DRAPE_MIX[0], DRAPE_MIX[1], hash(seed, 13))
  if (main) w[main - 1] += 1 - share
  if (other) w[other - 1] += share
  return w
}

/** Deterministic 0–1 noise from a seed and a channel. */
const hash = (seed: number, k: number) => {
  const x = Math.sin(seed * 127.1 + k * 311.7) * 43758.5453
  return x - Math.floor(x)
}
const lerp = THREE.MathUtils.lerp

const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a))
const _q = new THREE.Quaternion()
const _qi = new THREE.Quaternion()
const _f = new THREE.Vector3()
const _v = new THREE.Vector3()
const _l = new THREE.Vector3()
const _w = new THREE.Vector3()
const _up = new THREE.Vector3()
const UP = new THREE.Vector3(0, 1, 0)

interface Props {
  index: number
  homeX: number
}

export function HangerRig({ index, homeX }: Props) {
  const trolley = useRef<RapierRigidBody>(null)
  const hanger = useRef<RapierRigidBody>(null)
  const group = useRef<THREE.Group>(null)
  const body = useRef<RapierCollider>(null)
  useSphericalJoint(trolley as RefObject<RapierRigidBody>, hanger as RefObject<RapierRigidBody>, [
    [0, 0, 0],
    [0, 0, 0],
  ])

  const quality = useRack((s) => s.quality)
  const kit = use(jerseyKit(index, quality === 'high' ? 2048 : 1024))
  const assets = use(jerseyAssets())
  const mesh = assets.rack(quality)
  const farMesh = assets.rackFar(quality)
  const fabric = useRef<THREE.Mesh>(null)
  // small per-jersey irregularity so the rack doesn't look cloned
  const seed = useMemo(() => index * 1.37 + 0.31, [index])
  const yawJitter = useMemo(() => Math.sin(seed * 12.9) * 0.1, [seed])
  const uniforms = useMemo(() => {
    const u = createFabricUniforms(seed)
    // the GLB garment already hangs in real folds: the shader's seeded ones only add a
    // little per-jersey variety so the rack doesn't look cloned
    u.uFold.value = mesh.draped ? 0.33 : 1
    const rig = sleeveRig(mesh)
    sleeveRig(farMesh) // (same drape: only its weights are needed)
    u.uPivotR.value.copy(rig.pivotR)
    u.uPivotL.value.copy(rig.pivotL)
    return u
  }, [seed, mesh, farMesh])
  // this jersey's own sleeve pose, hem and folds, applied ×`variety.mix`
  const variety = useMemo(() => {
    const v = {
      sleeve: new THREE.Vector4(
        lerp(SWING[0], SWING[1], hash(seed, 1)),
        lerp(SPLAY[0], SPLAY[1], hash(seed, 2)),
        lerp(SWING[0], SWING[1], hash(seed, 3)),
        lerp(SPLAY[0], SPLAY[1], hash(seed, 4)),
      ),
      hem: new THREE.Vector2((hash(seed, 5) * 2 - 1) * HEM_TILT_Z, (hash(seed, 6) * 2 - 1) * HEM_TILT_X),
      body: new THREE.Vector4(
        (hash(seed, 8) * 2 - 1) * BODY_TWIST,
        (hash(seed, 9) * 2 - 1) * HEM_OPEN,
        (hash(seed, 10) * 2 - 1) * HEM_SHIFT,
        hash(seed, 11) * EDGE_WAVE,
      ),
      fold: lerp(FOLD[0], FOLD[1], hash(seed, 7)),
      drapes: drapeWeights(index, seed, mesh.geometry.morphAttributes.position?.length ?? 0),
      base: uniforms.uFold.value,
      mix: 1,
    }
    // start in it (applyVariety's job from then on)
    uniforms.uSleeve.value.copy(v.sleeve)
    uniforms.uHem.value.copy(v.hem)
    uniforms.uBody.value.copy(v.body)
    uniforms.uFold.value = v.base * v.fold
    return v
  }, [seed, uniforms, index, mesh])
  const material = useMemo(
    () =>
      createFabricMaterial(kit, {
        displacement: uniforms,
        maps: mesh.maps,
        inside: mesh.draped ? JERSEYS[index].base : undefined,
      }),
    [kit, uniforms, mesh, index],
  )
  // Rapier box around the hanging garment (garment space → hanger space)
  const box = useMemo(() => {
    // procedural fallback: its flat-pattern bounds include outstretched sleeves
    if (!mesh.draped) return { args: [0.3, 0.36, 0.035] as [number, number, number], y: -JERSEY_DROP - 0.46, z: 0 }
    const b = mesh.bounds
    const c = b.getCenter(new THREE.Vector3())
    const h = b.getSize(new THREE.Vector3()).multiplyScalar(0.5)
    return { args: [h.x * 0.85, h.y * 0.9, Math.max(h.z * 0.7, 0.035)] as [number, number, number], y: c.y - JERSEY_DROP, z: c.z }
  }, [mesh])
  const depthMaterial = useMemo(() => createFabricDepthMaterial(uniforms), [uniforms])

  const target = useRef({ x: homeX, yaw: SIDE_YAW + yawJitter, hovered: false })

  useEffect(() => {
    let lodT = 0
    const lod = (near: boolean) => {
      window.clearTimeout(lodT)
      const show = (m: typeof mesh) => fabric.current && (fabric.current.geometry = m.geometry)
      if (near) show(mesh)
      else lodT = window.setTimeout(() => show(farMesh), LOD_DOWN_MS)
    }
    const apply = (hovered: number | null, flipped: boolean) => {
      target.current.x = slotPositions(JERSEYS.length, hovered)[index]
      // turned out: front to the viewer, or its back (carousel flip)
      target.current.yaw = hovered === index ? (flipped ? Math.PI : 0) : SIDE_YAW + yawJitter
      target.current.hovered = hovered === index
      lod(hovered === index)
    }
    apply(useRack.getState().hovered, useRack.getState().rackFlipped)
    // the jersey lifted into the modal disappears from the rack until it's put back, and
    // stops colliding: it's placed straight into its slot for the put-back, which would
    // otherwise overlap the neighbours and fling them
    let rejoin = 0
    const show = (lifted: number | null) => {
      if (group.current) group.current.visible = lifted !== index
      window.clearTimeout(rejoin)
      if (lifted === index) body.current?.setCollisionGroups(GROUP_NONE)
      else rejoin = window.setTimeout(() => body.current?.setCollisionGroups(GROUP_JERSEY), REJOIN_MS)
    }
    show(useRack.getState().lifted)
    const off = useRack.subscribe((s, prev) => {
      if (s.hovered !== prev.hovered || s.rackFlipped !== prev.rackFlipped) apply(s.hovered, s.rackFlipped)
      if (s.lifted !== prev.lifted && (s.lifted === index || prev.lifted === index)) show(s.lifted)
    })
    return () => {
      off()
      window.clearTimeout(rejoin)
      window.clearTimeout(lodT)
    }
  }, [index, yawJitter, mesh, farMesh])

  useBeforePhysicsStep((world) => {
    const t = trolley.current
    const h = hanger.current
    if (!t || !h) return
    const dt = world.timestep
    const cfg = physics.rack
    const soft = 0.55 + 0.45 * physics.motion // calmer dial = lazier springs, less swing

    // trolley → slot
    const k = cfg.slideStiffness * soft
    const c = 2 * cfg.slideDamping * Math.sqrt(k * SLIDE_MASS)
    const fx = k * (target.current.x - t.translation().x) - c * t.linvel().x
    t.applyImpulse({ x: fx * dt, y: 0, z: 0 }, true)

    // hook yaw → face / side-on
    const r = h.rotation()
    _q.set(r.x, r.y, r.z, r.w)
    _f.set(0, 0, 1).applyQuaternion(_q)
    const yaw = Math.atan2(_f.x, _f.z)
    const ky = cfg.turnStiffness * soft
    const cy = 2 * cfg.turnDamping * Math.sqrt(ky * YAW_INERTIA)
    const tau = ky * wrap(target.current.yaw - yaw) - cy * h.angvel().y
    h.applyTorqueImpulse({ x: 0, y: tau * dt, z: 0 }, true)
    if (h.angularDamping() !== cfg.swingDrag) h.setAngularDamping(cfg.swingDrag)

    // soft stop: past ~40° of tilt the hook binds on the rail and pushes back
    _up.copy(UP).applyQuaternion(_q)
    const tilt = _up.angleTo(UP)
    if (tilt > TILT_LIMIT) {
      _w.crossVectors(_up, UP).normalize().multiplyScalar(TILT_K * (tilt - TILT_LIMIT) * dt)
      h.applyTorqueImpulse(_w, true)
    }
    const av = h.angvel()
    _w.set(av.x, av.y, av.z)
    if (_w.length() > MAX_SPIN) h.setAngvel(_w.setLength(MAX_SPIN), true)

    // Cursor brush: if the pointer is inside this jersey's fabric, push the fabric at
    // that point with the cursor's velocity relative to the cloth there (capped).
    if (!cursor.active || target.current.hovered) return
    const p = h.translation()
    _l.copy(cursor.pos).sub(p as THREE.Vector3Like).applyQuaternion(_qi.copy(_q).invert())
    const depth = 0.05 + cursor.radius - Math.abs(_l.z)
    if (depth <= 0) return
    const inside = mesh.outline(_l.x, _l.y + JERSEY_DROP) + cursor.radius
    if (inside <= 0) return
    // velocity of the fabric under the cursor ≈ v + ω × r
    _v.copy(cursor.pos).sub(p as THREE.Vector3Like)
    _f.copy(_w).cross(_v).add(h.linvel() as THREE.Vector3Like)
    const falloff = Math.min(1, depth / 0.05) * Math.min(1, inside / 0.04)
    const j = _v.copy(cursor.vel).sub(_f).multiplyScalar(m(cfg.brushGain) * falloff).clampLength(0, m(cfg.brushMax))
    h.applyImpulseAtPoint(j, cursor.pos, true)
  })

  // Secondary cloth motion, integrated at render rate from the body's measured motion.
  const sim = useRef({
    prevV: new THREE.Vector3(),
    prevWy: 0,
    lag: new THREE.Vector3(),
    lagV: new THREE.Vector3(),
    twist: 0,
    twistV: 0,
  })
  const applyVariety = () => {
    const v = variety
    uniforms.uSleeve.value.copy(v.sleeve).multiplyScalar(v.mix)
    uniforms.uHem.value.copy(v.hem).multiplyScalar(v.mix)
    uniforms.uBody.value.copy(v.body).multiplyScalar(v.mix)
    uniforms.uFold.value = v.base * lerp(1, v.fold, v.mix)
    const f = fabric.current
    if (f && v.drapes.length) {
      f.morphTargetInfluences ??= v.drapes.map(() => 0)
      for (let k = 0; k < v.drapes.length; k++) f.morphTargetInfluences[k] = v.drapes[k] * v.mix
    }
  }
  // the fabric mesh mounts after the memo above: give it its drape blend before its first
  // frame (R3F sets the geometry after construction, so three never sized the weights)
  useLayoutEffect(applyVariety)

  // Put-back: the moment the modal starts carrying this jersey home, its (hidden) rack
  // copy is placed exactly where it will end up — in its turned-out slot, facing, at rest,
  // fake-cloth motion cleared — so the flight has a fixed target and nothing is still
  // sliding or turning when the two copies swap.
  useEffect(
    () =>
      useRack.subscribe((s, prev) => {
        if (s.phase !== 'closing' || prev.phase === 'closing' || s.open !== index) return
        const t = trolley.current
        const h = hanger.current
        if (!t || !h) return
        const x = slotPositions(JERSEYS.length, index)[index]
        const zero = { x: 0, y: 0, z: 0 }
        t.setTranslation({ x, y: RAIL_Y, z: 0 }, true)
        t.setLinvel(zero, true)
        h.setTranslation({ x, y: RAIL_Y, z: 0 }, true)
        h.setRotation({ x: 0, y: 0, z: 0, w: 1 }, true)
        h.setLinvel(zero, true)
        h.setAngvel(zero, true)
        target.current.x = x
        target.current.yaw = 0
        target.current.hovered = true
        const st = sim.current
        st.prevV.set(0, 0, 0)
        st.prevWy = 0
        st.lag.set(0, 0, 0)
        st.lagV.set(0, 0, 0)
        st.twist = st.twistV = 0
        uniforms.uLag.value.set(0, 0, 0)
        uniforms.uTwist.value = 0
        uniforms.uRipple.value = 0
        uniforms.uFlare.value = 0
        variety.mix = 0
        applyVariety()
        // publish the final pose now, so the modal aims at it from the first frame
        hangerX[index] = x
        hangerYaw[index] = 0
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [index, uniforms, variety],
  )

  useFrame((_, rawDelta) => {
    const h = hanger.current
    if (!h) return
    const tr = h.translation()
    hangerX[index] = tr.x
    const dt = Math.min(rawDelta, 1 / 30)
    const s = sim.current
    const cfg = physics.rackCloth
    const r = h.rotation()
    _q.set(r.x, r.y, r.z, r.w)
    _qi.copy(_q).invert()
    _f.set(0, 0, 1).applyQuaternion(_q)
    hangerYaw[index] = Math.atan2(_f.x, _f.z)

    const lv = h.linvel()
    _v.set(lv.x, lv.y, lv.z)
    const acc = _f.copy(_v).sub(s.prevV).divideScalar(Math.max(dt, 1e-4))
    s.prevV.copy(_v)
    acc.clampLength(0, 20).applyQuaternion(_qi)
    const lagK = (2 * Math.PI * cfg.lagFrequency) ** 2
    const lagC = 2 * cfg.lagDamping * Math.sqrt(lagK)
    // spring-damper per axis, driven opposite to the acceleration
    for (const k of ['x', 'y', 'z'] as const) {
      const a = -lagK * s.lag[k] - lagC * s.lagV[k] - acc[k] * m(cfg.lagGain)
      s.lagV[k] += a * dt
      s.lag[k] += s.lagV[k] * dt
    }
    s.lag.y *= 0.5 // fabric barely stretches vertically
    s.lag.clampLength(0, 0.07)

    const av = h.angvel()
    const wy = av.y
    const alpha = THREE.MathUtils.clamp((wy - s.prevWy) / Math.max(dt, 1e-4), -60, 60)
    s.prevWy = wy
    const twistK = (2 * Math.PI * 1.1) ** 2
    const twistC = 2 * cfg.twistDamping * Math.sqrt(twistK)
    s.twistV += (-twistK * s.twist - twistC * s.twistV - alpha * m(cfg.twistGain)) * dt
    s.twist = THREE.MathUtils.clamp(s.twist + s.twistV * dt, -0.5, 0.5)

    const speed = _v.length() + Math.hypot(av.x, av.z) * 0.5
    const rippleTarget = Math.min(speed * 0.01 + Math.abs(wy) * 0.0015, 0.01) * m(cfg.ripple)
    const u = uniforms
    u.uRipple.value += (rippleTarget - u.uRipple.value) * (rippleTarget > u.uRipple.value ? 0.2 : 0.035)
    const flareTarget = THREE.MathUtils.clamp((Math.abs(wy) - 2.5) / 6, 0, 1) * m(cfg.flare)
    u.uFlare.value += (flareTarget - u.uFlare.value) * 0.1
    u.uTwist.value = s.twist
    u.uLag.value.copy(s.lag)
    u.uTime.value += dt

    // drape variety: on while side-on, eased off while turned out
    const want = target.current.hovered ? 0 : 1
    if (variety.mix !== want) {
      variety.mix += (want - variety.mix) * (1 - Math.exp(-dt * VARIETY_RATE))
      if (Math.abs(want - variety.mix) < 1e-3) variety.mix = want
      applyVariety()
    }
  })

  return (
    <>
      <RigidBody
        ref={trolley}
        position={[homeX, RAIL_Y, 0]}
        colliders={false}
        enabledRotations={[false, false, false]}
        enabledTranslations={[true, false, false]}
        gravityScale={0}
        canSleep={false}
      >
        <BallCollider args={[0.02]} mass={0.3} collisionGroups={GROUP_NONE} />
      </RigidBody>
      <RigidBody
        ref={hanger}
        position={[homeX, RAIL_Y, 0]}
        rotation={[0, SIDE_YAW + yawJitter, 0]}
        colliders={false}
        angularDamping={physics.rack.swingDrag}
        linearDamping={0.4}
        canSleep={false}
      >
        <CuboidCollider
          ref={body}
          args={box.args}
          position={[0, box.y, box.z]}
          mass={0.5}
          friction={0.08}
          restitution={0}
          collisionGroups={GROUP_JERSEY}
        />
        <CuboidCollider args={[0.2, 0.02, 0.02]} position={[0, -JERSEY_DROP - 0.02, 0]} mass={0.15} collisionGroups={GROUP_NONE} />
        <group ref={group}>
          <mesh
            ref={fabric}
            position={[0, -JERSEY_DROP, 0]}
            geometry={farMesh.geometry}
            material={material}
            customDepthMaterial={depthMaterial}
            castShadow
            receiveShadow
          />
          <Hanger />
        </group>
      </RigidBody>
    </>
  )
}
