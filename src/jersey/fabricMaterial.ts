import * as THREE from 'three'
import { getKnitHeightMap, type JerseyKit } from './jerseyTexture'

/**
 * Jersey fabric, shared by the rack and the modal:
 *  - kit bump (raised twill, stitching, rib, vents) + tiled knit micro-relief, combined in
 *    one surface-gradient bump so both read at any distance without shimmer
 *  - roughness map: matte knit, glossier twill
 *  - per-vertex baked AO (armpits, sleeve/body gap, collar) applied to ambient and,
 *    partially, to direct light, so the underarms read even under a strong key
 *  - optional rack "fake cloth" vertex motion (see useClothFake in HangerRig):
 *      uLag hem inertia, uTwist trailing twist, uRipple speed ripples, uFlare sleeve flare,
 *      uSeed per-jersey static drape folds
 *  - uFade for the modal carousel reveal
 */
export interface FabricUniforms {
  uTime: { value: number }
  uLag: { value: THREE.Vector3 }
  uTwist: { value: number }
  uRipple: { value: number }
  uFlare: { value: number }
  uSeed: { value: number }
  uFold: { value: number }
}

export function createFabricUniforms(seed: number): FabricUniforms {
  return {
    uTime: { value: 0 },
    uLag: { value: new THREE.Vector3() },
    uTwist: { value: 0 },
    uRipple: { value: 0 },
    uFlare: { value: 0 },
    uSeed: { value: seed },
    uFold: { value: 1 },
  }
}

const DISPLACE_GLSL = /* glsl */ `
uniform float uTime;
uniform vec3 uLag;
uniform float uTwist;
uniform float uRipple;
uniform float uFlare;
uniform float uSeed;
uniform float uFold;

vec3 clothDisplace(vec3 p) {
  float hang = clamp(-p.y / 0.84, 0.0, 1.0);
  float h2 = hang * hang;

  // static drape: soft vertical folds that deepen toward the hem, hem gathers in
  float folds = sin(p.x * 11.0 + uSeed * 3.1) * 0.6 + sin(p.x * 23.0 + uSeed * 7.7 + p.y * 3.0) * 0.4;
  p.z += folds * 0.015 * hang * uFold;
  p.x *= 1.0 - 0.04 * h2 * uFold;

  // trailing twist (lower body lags the hanger's yaw)
  float a = uTwist * h2;
  float ca = cos(a), sa = sin(a);
  p.xz = mat2(ca, sa, -sa, ca) * p.xz;

  // sleeves flare on fast turns
  float sleeve = smoothstep(0.3, 0.55, abs(p.x));
  p.x += sign(p.x) * uFlare * sleeve * 0.05;
  p.y += uFlare * sleeve * 0.03;

  // speed-driven ripples running across the fabric
  float w = sin(p.x * 14.0 + uTime * 6.0 + p.y * 5.0 + uSeed) * 0.6
          + sin(p.x * 25.0 - uTime * 4.6 + uSeed * 2.0) * 0.4;
  p.z += w * uRipple * h2;

  p += uLag * h2;
  return p;
}
`

function patchDisplacement(shader: THREE.WebGLProgramParametersWithUniforms, uniforms: FabricUniforms, withNormals: boolean) {
  Object.assign(shader.uniforms, uniforms)
  shader.vertexShader = shader.vertexShader.replace('#include <common>', `#include <common>\n${DISPLACE_GLSL}`)
  if (withNormals) {
    shader.vertexShader = shader.vertexShader.replace(
      '#include <beginnormal_vertex>',
      /* glsl */ `#include <beginnormal_vertex>
      {
        // finite-difference the displacement in the garment plane and apply the change in
        // slope as a perturbation; faded out on the rounded edges (normal.z → 0)
        const float e = 0.006;
        vec3 p0 = position;
        vec3 d0 = clothDisplace(p0) - p0;
        vec3 dx = clothDisplace(p0 + vec3(e, 0.0, 0.0)) - (p0 + vec3(e, 0.0, 0.0));
        vec3 dy = clothDisplace(p0 + vec3(0.0, e, 0.0)) - (p0 + vec3(0.0, e, 0.0));
        float side = objectNormal.z >= 0.0 ? 1.0 : -1.0;
        vec3 tx = vec3(1.0, 0.0, 0.0) + (dx - d0) / e;
        vec3 ty = vec3(0.0, 1.0, 0.0) + (dy - d0) / e;
        vec3 nNew = normalize(cross(tx, ty)) * side;
        objectNormal = normalize(objectNormal + (nNew - vec3(0.0, 0.0, side)) * abs(objectNormal.z));
      }`,
    )
  }
  shader.vertexShader = shader.vertexShader.replace(
    '#include <begin_vertex>',
    '#include <begin_vertex>\ntransformed = clothDisplace(transformed);',
  )
}

export interface FabricOptions {
  /** Rack: drive the fake-cloth vertex motion from these uniforms. */
  displacement?: FabricUniforms
  /** Modal: fade uniform (0–1) for the carousel reveal. */
  fade?: { value: number }
  /** Repeats of the knit tile across the atlas (one tile ≈ 18 mm, 16 loop columns). */
  knitRepeat?: number
  /** Baked garment maps on UV1 (GLB mesh): tangent-space normal (folds, seams, wrinkles)
   *  and ambient occlusion (replaces the per-vertex `aAO`). */
  maps?: { normal: THREE.Texture; ao: THREE.Texture }
  /** Render both sides; the inside of the tube shows the kit colour at that spot shaded
   *  down, nudged toward this colour (the kit's base). */
  inside?: string
}

export function createFabricMaterial(kit: JerseyKit, opts: FabricOptions = {}): THREE.MeshPhysicalMaterial {
  const knit = getKnitHeightMap()
  const repeat = opts.knitRepeat ?? 60
  const fade = opts.fade ?? { value: 1 }
  const mat = new THREE.MeshPhysicalMaterial({
    map: kit.map,
    bumpMap: kit.bump,
    bumpScale: 2.2,
    roughnessMap: kit.rough,
    roughness: 1,
    metalness: 0,
    // knit polyester is matte: a little soft sheen, no glowing rims
    sheen: 0.25,
    sheenRoughness: 0.8,
    sheenColor: new THREE.Color(0.26, 0.26, 0.28),
    envMapIntensity: 0.6,
    transparent: !!opts.fade,
  })
  if (opts.maps) {
    mat.normalMap = opts.maps.normal
    mat.normalScale.set(1, 1)
    mat.aoMap = opts.maps.ao
    mat.aoMapIntensity = 1
  }
  const inside = new THREE.Color(opts.inside ?? '#000000')
  if (opts.inside) mat.side = THREE.DoubleSide
  mat.onBeforeCompile = (shader) => {
    if (opts.displacement) patchDisplacement(shader, opts.displacement, true)
    shader.uniforms.uKnit = { value: knit }
    // the atlas is two panels side by side, so the tile is twice as dense in u
    shader.uniforms.uKnitRepeat = { value: new THREE.Vector2(repeat * 2, repeat * 0.7) }
    shader.uniforms.uKnitScale = { value: 0.35 }
    shader.uniforms.uFade = fade
    shader.uniforms.uInside = { value: inside }

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aAO;\nvarying float vAO;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvAO = aAO;')

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        '#include <common>\nuniform sampler2D uKnit;\nuniform vec2 uKnitRepeat;\nuniform float uKnitScale;\nuniform float uFade;\nuniform vec3 uInside;\nvarying float vAO;',
      )
      .replace(
        '#include <map_fragment>',
        /* glsl */ `#include <map_fragment>
        #ifdef DOUBLE_SIDED
          // inside of the tube: the same fabric, shaded down (sublimated colour prints
          // through). Using the map's own colour means nothing contrasts where a back
          // face peeks out along a tight seam fold.
          if (!gl_FrontFacing) diffuseColor.rgb = mix(diffuseColor.rgb, uInside, 0.15) * 0.62;
        #endif`,
      )
      .replace(
        '#include <normal_fragment_maps>',
        /* glsl */ `
        #ifdef USE_NORMALMAP_TANGENTSPACE
          // baked garment detail first; the kit bump + knit ride on top of it
          vec3 mapN = texture2D(normalMap, vNormalMapUv).xyz * 2.0 - 1.0;
          mapN.xy *= normalScale;
          normal = normalize(tbn * mapN);
        #endif
        #ifdef USE_BUMPMAP
          vec2 dH = dHdxy_fwd();
          vec2 kuv = vBumpMapUv * uKnitRepeat;
          vec2 kdx = dFdx(kuv);
          vec2 kdy = dFdy(kuv);
          float k0 = texture2D(uKnit, kuv).r;
          vec2 dK = vec2(texture2D(uKnit, kuv + kdx).r - k0, texture2D(uKnit, kuv + kdy).r - k0);
          // knit loops smaller than ~2px would only shimmer: fade them with distance
          float tilePx = max(length(kdx), length(kdy));
          dH += dK * uKnitScale * (1.0 - smoothstep(0.25, 0.6, tilePx));
          normal = perturbNormalArb(-vViewPosition, normal, dH, faceDirection);
        #endif
        `,
      )
      .replace(
        '#include <aomap_fragment>',
        /* glsl */ `#include <aomap_fragment>
        reflectedLight.indirectDiffuse *= vAO;
        reflectedLight.indirectSpecular *= vAO;
        reflectedLight.directDiffuse *= mix(1.0, vAO, 0.55);
        reflectedLight.directSpecular *= vAO;
        #ifdef USE_AOMAP
          reflectedLight.directDiffuse *= mix(1.0, ambientOcclusion, 0.55);
          reflectedLight.directSpecular *= ambientOcclusion;
        #endif`,
      )
      .replace('#include <dithering_fragment>', '#include <dithering_fragment>\ngl_FragColor.a *= uFade;')
  }
  mat.customProgramCacheKey = () =>
    `fabric-${opts.displacement ? 'rack' : 'cloth'}-${opts.fade ? 'fade' : 'opaque'}-${opts.maps ? 'baked' : 'plain'}-${opts.inside ? '2s' : '1s'}`
  return mat
}

/** Shadow caster that follows the rack displacement. */
export function createFabricDepthMaterial(uniforms: FabricUniforms): THREE.MeshDepthMaterial {
  const mat = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking })
  mat.onBeforeCompile = (shader) => patchDisplacement(shader, uniforms, false)
  mat.customProgramCacheKey = () => 'fabric-rack-depth'
  return mat
}
