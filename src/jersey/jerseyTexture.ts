import * as THREE from 'three'
import type { FlagPattern, Jersey } from '../data/jerseys'
import { BOUNDS, LANDMARKS, SILHOUETTE } from './silhouette'

// Kit art is drawn in garment metres ("viewer space": x right, y up, origin at the
// collar) onto a two-panel atlas: front on the left half, back on the right half.
//
// The same drawing code runs three passes so every map lines up exactly:
//   color  – albedo
//   height – bump: raised tackle-twill lettering with stitched edges, rib knit at the
//            collar/cuffs/hem, perforated vent panels, sewn seams
//   rough  – roughness: matte knit, glossier twill and patches

const WORD_FONT = '"Oswald", "Arial Narrow", sans-serif'
const NUMBER_FONT = '"Graduate", "Oswald", serif'

type Pass = 'color' | 'height' | 'rough'

// height / roughness levels (0–1)
const H = { knit: 0.42, seam: 0.3, rib: 0.55, ribGroove: 0.35, twillOutline: 0.72, twill: 0.88, stitch: 0.6, patch: 0.7, vent: 0.12 }
const R = { knit: 0.84, twill: 0.52, patch: 0.6, rib: 0.88, vent: 0.92 }

export async function ensureKitFonts(): Promise<void> {
  if (typeof document === 'undefined' || !document.fonts) return
  await Promise.all([
    document.fonts.load(`700 64px ${WORD_FONT}`),
    document.fonts.load(`400 64px ${NUMBER_FONT}`),
  ]).catch(() => undefined)
}

const crestCache = new Map<string, Promise<HTMLImageElement | null>>()
function loadCrest(url: string) {
  if (!crestCache.has(url)) {
    crestCache.set(
      url,
      new Promise((resolve) => {
        const img = new Image()
        img.crossOrigin = 'anonymous'
        img.onload = () => resolve(img)
        img.onerror = () => resolve(null)
        img.src = url
      }),
    )
  }
  return crestCache.get(url)!
}

type Ctx = CanvasRenderingContext2D
const gray = (v: number) => {
  const c = Math.round(Math.min(1, Math.max(0, v)) * 255)
  return `rgb(${c},${c},${c})`
}

/** Picks the fill for the current pass. */
class Painter {
  constructor(
    readonly ctx: Ctx,
    readonly pass: Pass,
  ) {}
  style(color: string, height: number, rough: number) {
    if (this.pass === 'color') return color
    return gray(this.pass === 'height' ? height : rough)
  }
}

function silhouettePath(ctx: Ctx) {
  ctx.beginPath()
  SILHOUETTE.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)))
  ctx.closePath()
}

/** Run `fn` with y flipped back so text and images draw upright at (x, y). */
function upright(ctx: Ctx, x: number, y: number, rot: number, fn: () => void) {
  ctx.save()
  ctx.translate(x, y)
  ctx.rotate(rot)
  ctx.scale(1, -1)
  fn()
  ctx.restore()
}

// Canvas text sizes must be in pixels; text is drawn in a local pixel space.
const TEXT_PX = 200

/** Tackle-twill lettering: outline layer, fill layer, and a tack stitch on the fill's edge. */
function twillText(p: Painter, text: string, x: number, y: number, heightM: number, rot: number, font: string, j: Jersey, weight = 700) {
  const { ctx } = p
  upright(ctx, x, y, rot, () => {
    const s = heightM / TEXT_PX
    ctx.scale(s, s)
    ctx.font = `${weight} ${TEXT_PX}px ${font}`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.lineJoin = 'round'
    ctx.lineWidth = TEXT_PX * 0.16
    ctx.strokeStyle = p.style(j.textOutline, H.twillOutline, R.twill)
    ctx.strokeText(text, 0, 0)
    ctx.fillStyle = p.style(j.text, H.twill, R.twill)
    ctx.fillText(text, 0, 0)
    if (p.pass !== 'rough') {
      ctx.save()
      ctx.setLineDash([TEXT_PX * 0.03, TEXT_PX * 0.025])
      ctx.lineWidth = TEXT_PX * 0.012
      ctx.strokeStyle = p.pass === 'color' ? 'rgba(0,0,0,0.28)' : gray(H.stitch)
      ctx.strokeText(text, 0, 0)
      ctx.restore()
    }
  })
}

function archedTwill(p: Painter, text: string, cy: number, radius: number, heightM: number, j: Jersey) {
  const { ctx } = p
  const s = heightM / TEXT_PX
  ctx.save()
  ctx.font = `700 ${TEXT_PX}px ${WORD_FONT}`
  const letters = [...text]
  const widths = letters.map((l) => ctx.measureText(l).width * s * 1.06)
  ctx.restore()
  const total = widths.reduce((a, b) => a + b, 0)
  let angle = -total / radius / 2
  letters.forEach((l, i) => {
    const half = widths[i] / 2 / radius
    angle += half
    twillText(p, l, Math.sin(angle) * radius, cy + Math.cos(angle) * radius, heightM, -angle, WORD_FONT, j)
    angle += half
  })
}

function drawFlag(p: Painter, flag: FlagPattern, w: number, h: number) {
  const { ctx } = p
  if (p.pass !== 'color') {
    // a sewn patch: raised, slightly glossy, stitched border
    ctx.fillStyle = p.style('', H.patch, R.patch)
    ctx.fillRect(-w / 2, -h / 2, w, h)
    if (p.pass === 'height') {
      ctx.setLineDash([0.003, 0.002])
      ctx.lineWidth = 0.0012
      ctx.strokeStyle = gray(H.stitch)
      ctx.strokeRect(-w / 2 + 0.002, -h / 2 + 0.002, w - 0.004, h - 0.004)
      ctx.setLineDash([])
    }
    return
  }
  ctx.save()
  ctx.translate(-w / 2, -h / 2)
  const rect = (c: string, rx: number, ry: number, rw: number, rh: number) => {
    ctx.fillStyle = c
    ctx.fillRect(rx, ry, rw, rh)
  }
  // y is up, so "top" bands sit at higher ry
  switch (flag.kind) {
    case 'swiss': {
      rect('#d52b1e', 0, 0, w, h)
      const a = h * 0.18
      rect('#fff', w / 2 - a / 2, h * 0.2, a, h * 0.6)
      rect('#fff', w / 2 - h * 0.3, h / 2 - a / 2, h * 0.6, a)
      break
    }
    case 'nordic': {
      rect(flag.field, 0, 0, w, h)
      const a = h * 0.22
      rect(flag.cross, w * 0.36 - a / 2, 0, a, h)
      rect(flag.cross, 0, h / 2 - a / 2, w, a)
      break
    }
    case 'horizontal': {
      const ratios = flag.ratios ?? flag.bands.map(() => 1)
      const sum = ratios.reduce((a, b) => a + b, 0)
      let top = h
      flag.bands.forEach((c, i) => {
        const bh = (ratios[i] / sum) * h
        rect(c, 0, top - bh, w, bh)
        top -= bh
      })
      break
    }
    case 'czech': {
      rect('#ffffff', 0, h / 2, w, h / 2)
      rect('#d7141a', 0, 0, w, h / 2)
      ctx.fillStyle = '#11457e'
      ctx.beginPath()
      ctx.moveTo(0, 0)
      ctx.lineTo(w * 0.5, h / 2)
      ctx.lineTo(0, h)
      ctx.fill()
      break
    }
    case 'slovak': {
      rect('#ffffff', 0, (h * 2) / 3, w, h / 3)
      rect('#0b4ea2', 0, h / 3, w, h / 3)
      rect('#ee1c25', 0, 0, w, h / 3)
      ctx.fillStyle = '#ee1c25'
      ctx.strokeStyle = '#fff'
      ctx.lineWidth = h * 0.04
      ctx.beginPath()
      ctx.moveTo(w * 0.18, h * 0.8)
      ctx.lineTo(w * 0.42, h * 0.8)
      ctx.lineTo(w * 0.42, h * 0.38)
      ctx.quadraticCurveTo(w * 0.3, h * 0.12, w * 0.18, h * 0.38)
      ctx.closePath()
      ctx.fill()
      ctx.stroke()
      break
    }
    case 'leaf': {
      rect('#d52b1e', 0, 0, w * 0.25, h)
      rect('#ffffff', w * 0.25, 0, w * 0.5, h)
      rect('#d52b1e', w * 0.75, 0, w * 0.25, h)
      ctx.fillStyle = '#d52b1e'
      ctx.beginPath()
      const cx = w / 2
      const cy = h * 0.52
      const r = h * 0.34
      ctx.moveTo(cx, cy + r)
      ctx.lineTo(cx + r * 0.35, cy + r * 0.25)
      ctx.lineTo(cx + r * 0.8, cy + r * 0.45)
      ctx.lineTo(cx + r * 0.6, cy - r * 0.1)
      ctx.lineTo(cx + r * 0.15, cy - r * 0.45)
      ctx.lineTo(cx + r * 0.05, cy - r * 0.95)
      ctx.lineTo(cx - r * 0.05, cy - r * 0.95)
      ctx.lineTo(cx - r * 0.15, cy - r * 0.45)
      ctx.lineTo(cx - r * 0.6, cy - r * 0.1)
      ctx.lineTo(cx - r * 0.8, cy + r * 0.45)
      ctx.lineTo(cx - r * 0.35, cy + r * 0.25)
      ctx.closePath()
      ctx.fill()
      break
    }
    case 'stars-stripes': {
      for (let i = 0; i < 7; i++) rect(i % 2 ? '#ffffff' : '#b22234', 0, (i * h) / 7, w, h / 7)
      rect('#3c3b6e', 0, h * 0.46, w * 0.42, h * 0.54)
      ctx.fillStyle = '#fff'
      for (let r = 0; r < 3; r++)
        for (let c = 0; c < 4; c++) {
          ctx.beginPath()
          ctx.arc(w * (0.06 + c * 0.1), h * (0.56 + r * 0.15), h * 0.025, 0, Math.PI * 2)
          ctx.fill()
        }
      break
    }
  }
  ctx.restore()
  ctx.strokeStyle = 'rgba(0,0,0,0.3)'
  ctx.lineWidth = h * 0.03
  ctx.strokeRect(-w / 2, -h / 2, w, h)
}

// Sleeve geometry (right sleeve, viewer space); mirrored for the left.
const SHOULDER = LANDMARKS.shoulder
const SLEEVE_LEN = Math.hypot(LANDMARKS.cuffOuter[0] - SHOULDER[0], LANDMARKS.cuffOuter[1] - SHOULDER[1])
const SLEEVE_DIR: [number, number] = [
  (LANDMARKS.cuffOuter[0] - SHOULDER[0]) / SLEEVE_LEN,
  (LANDMARKS.cuffOuter[1] - SHOULDER[1]) / SLEEVE_LEN,
]
const SLEEVE_ANGLE = Math.atan2(SLEEVE_DIR[1], SLEEVE_DIR[0])
/** Unit vector across the right sleeve, from its top edge toward the underarm. */
const SLEEVE_ACROSS: [number, number] = [SLEEVE_DIR[1], -SLEEVE_DIR[0]]
const CUFF_MID: [number, number] = [
  (LANDMARKS.cuffOuter[0] + LANDMARKS.cuffInner[0]) / 2,
  (LANDMARKS.cuffOuter[1] + LANDMARKS.cuffInner[1]) / 2,
]

/** Run fn in each sleeve's frame (mirrored on the left): origin on the sleeve's top edge
 *  `along` metres from the shoulder, +x down the sleeve, -y across toward the underarm.
 *  Only for symmetric marks — text drawn here would read mirrored on the left. */
function eachSleeve(ctx: Ctx, along: number, fn: () => void) {
  for (const m of [1, -1]) {
    ctx.save()
    ctx.scale(m, 1)
    ctx.translate(SHOULDER[0] + SLEEVE_DIR[0] * along, SHOULDER[1] + SLEEVE_DIR[1] * along)
    ctx.rotate(SLEEVE_ANGLE)
    fn()
    ctx.restore()
  }
}

/** Point on a sleeve: `along` from the shoulder, `across` in from the top edge. */
function sleevePoint(m: 1 | -1, along: number, across: number): [number, number] {
  return [
    m * (SHOULDER[0] + SLEEVE_DIR[0] * along + SLEEVE_ACROSS[0] * across),
    SHOULDER[1] + SLEEVE_DIR[1] * along + SLEEVE_ACROSS[1] * across,
  ]
}

function stripeSet(j: Jersey, draw: (offset: number, width: number, color: string) => void) {
  const main = 0.062
  const pin = 0.01
  const gap = 0.01
  draw(0, main, j.stripe)
  draw(main / 2 + gap + pin / 2, pin, j.pinstripe)
  draw(-(main / 2 + gap + pin / 2), pin, j.pinstripe)
}

function seamLine(p: Painter, points: [number, number][], strength = 1) {
  const { ctx } = p
  if (p.pass === 'rough') return
  ctx.save()
  // the seam itself: a soft groove
  ctx.lineWidth = 0.004
  ctx.strokeStyle = p.pass === 'color' ? `rgba(0,0,0,${0.16 * strength})` : gray(H.seam)
  ctx.beginPath()
  points.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)))
  ctx.stroke()
  // twin-needle cover stitch either side
  ctx.setLineDash([0.004, 0.003])
  ctx.lineWidth = 0.0012
  ctx.strokeStyle = p.pass === 'color' ? `rgba(0,0,0,${0.22 * strength})` : gray(H.stitch)
  for (const off of [-0.004, 0.004]) {
    ctx.beginPath()
    points.forEach(([x, y], i) => (i ? ctx.lineTo(x + off, y + off) : ctx.moveTo(x + off, y + off)))
    ctx.stroke()
  }
  ctx.restore()
}

/** Both sleeves, from the shoulder seam line down to the cuffs. */
function sleevesPath(ctx: Ctx) {
  const { shoulder, cuffOuter, cuffInner, armpit } = LANDMARKS
  ctx.beginPath()
  for (const m of [1, -1]) {
    ctx.moveTo(m * (shoulder[0] - 0.02), shoulder[1] + 0.03)
    ctx.lineTo(m * (cuffOuter[0] + 0.03), cuffOuter[1] + 0.01)
    ctx.lineTo(m * (cuffInner[0] + 0.01), cuffInner[1] - 0.03)
    ctx.lineTo(m * (armpit[0] - 0.012), armpit[1] - 0.01)
    ctx.closePath()
  }
}

const YOKE_RIGHT: [number, number][] = [
  [0.095, 0.0],
  [0.235, -0.05],
  [0.556, -0.509],
  [0.501, -0.55],
  [0.205, -0.16],
  [0.0, -0.14],
]
function yokePath(ctx: Ctx) {
  ctx.beginPath()
  YOKE_RIGHT.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)))
  for (let i = YOKE_RIGHT.length - 2; i >= 0; i--) ctx.lineTo(-YOKE_RIGHT[i][0], YOKE_RIGHT[i][1])
  ctx.closePath()
}

/** Rib-knit band (collar, cuffs, hem). Ridges run along x when `alongX`, else along y. */
function ribFill(p: Painter, x: number, y: number, w: number, h: number, color: string, alongX = false) {
  const { ctx } = p
  ctx.fillStyle = p.style(color, H.rib, R.rib)
  ctx.fillRect(x, y, w, h)
  if (p.pass === 'rough') return
  ctx.fillStyle = p.pass === 'color' ? 'rgba(0,0,0,0.08)' : gray(H.ribGroove)
  if (alongX) for (let ry = y; ry < y + h; ry += 0.003) ctx.fillRect(x, ry, w, 0.001)
  else for (let rx = x; rx < x + w; rx += 0.003) ctx.fillRect(rx, y, 0.001, h)
}

/** Perforated "air-knit" vent panel pattern, 5 mm pitch. */
function ventFill(p: Painter, color: string) {
  const tile = document.createElement('canvas')
  tile.width = tile.height = 20
  const t = tile.getContext('2d')!
  t.fillStyle = p.style(color, H.knit, R.vent)
  t.fillRect(0, 0, 20, 20)
  // the holes show the same fabric a layer down: a faint tone in colour, the real
  // perforation lives in the height pass (dark dots read as dirt on light kits)
  t.fillStyle = p.pass === 'color' ? 'rgba(0,0,0,0.1)' : gray(H.vent)
  for (const [cx, cy] of [
    [5, 5],
    [15, 15],
  ]) {
    t.beginPath()
    t.arc(cx, cy, 2.4, 0, Math.PI * 2)
    t.fill()
  }
  const pat = p.ctx.createPattern(tile, 'repeat')!
  pat.setTransform(new DOMMatrix().scale(0.005 / 10))
  return pat
}

/** Underarm gussets: mesh panel down the side seam and into the sleeve underside. */
function ventPanels(p: Painter, j: Jersey) {
  const { ctx } = p
  const { armpit, cuffInner } = LANDMARKS
  const fill = ventFill(p, j.base)
  for (const m of [1, -1]) {
    ctx.save()
    ctx.scale(m, 1)
    ctx.beginPath()
    ctx.moveTo(armpit[0] - 0.065, armpit[1] + 0.03)
    ctx.lineTo(armpit[0] + 0.04, armpit[1] + 0.06)
    ctx.lineTo(cuffInner[0] + 0.005, cuffInner[1] + 0.13)
    ctx.lineTo(cuffInner[0] - 0.02, cuffInner[1] + 0.12)
    ctx.lineTo(armpit[0] + 0.004, armpit[1] - 0.02)
    ctx.lineTo(0.334, -0.58)
    ctx.lineTo(0.272, -0.58)
    ctx.lineTo(armpit[0] - 0.065, armpit[1] - 0.03)
    ctx.closePath()
    ctx.fillStyle = fill
    ctx.fill()
    ctx.restore()
  }
  seamLine(p, [[-0.272, -0.31], [-0.272, -0.58]], 0.6)
  seamLine(p, [[0.272, -0.31], [0.272, -0.58]], 0.6)
}

function drawSide(p: Painter, j: Jersey, side: 'front' | 'back', crest: HTMLImageElement | null) {
  const { ctx } = p
  const darker = new THREE.Color(j.base).multiplyScalar(0.62).getStyle()

  // Fill well beyond the outline so the mesh edge never samples empty texels.
  ctx.fillStyle = p.style(j.base, H.knit, R.knit)
  ctx.fillRect(BOUNDS.minX - 0.05, BOUNDS.minY - 0.05, BOUNDS.width + 0.1, BOUNDS.height + 0.1)
  ctx.save()
  silhouettePath(ctx)
  ctx.clip()

  if (j.yoke) {
    ctx.fillStyle = p.style(j.yoke, H.knit, R.knit)
    yokePath(ctx)
    ctx.fill()
  }
  ventPanels(p, j)

  // Hem and sleeve stripes: knit-in, so flat in height.
  stripeSet(j, (o, w, c) => {
    ctx.fillStyle = p.style(c, H.knit, R.knit)
    ctx.fillRect(-0.4, -0.7 + o - w / 2, 0.8, w)
  })
  // sleeve stripes, clipped to the sleeves so they never spill onto the body
  ctx.save()
  sleevesPath(ctx)
  ctx.clip()
  stripeSet(j, (o, w, c) =>
    eachSleeve(ctx, SLEEVE_LEN * 0.72 + o, () => {
      ctx.fillStyle = p.style(c, H.knit, R.knit)
      ctx.fillRect(-w / 2, -0.4, w, 0.44)
    }),
  )
  ctx.restore()

  // Rib-knit hem and cuffs.
  ribFill(p, -0.4, BOUNDS.minY - 0.01, 0.8, 0.038, darker)
  for (const m of [1, -1]) {
    ctx.save()
    ctx.scale(m, 1)
    ctx.translate(CUFF_MID[0], CUFF_MID[1])
    ctx.rotate(SLEEVE_ANGLE)
    ribFill(p, -0.032, -0.15, 0.05, 0.3, darker, true)
    ctx.restore()
  }
  seamLine(p, [[-0.34, BOUNDS.minY + 0.028], [0.34, BOUNDS.minY + 0.028]])

  // Collar: rib band, V on the front, scooped on the back.
  ctx.save()
  ctx.beginPath()
  if (side === 'front') {
    ctx.moveTo(-0.105, 0.01)
    ctx.lineTo(0, -0.12)
    ctx.lineTo(0.105, 0.01)
    ctx.lineTo(0.074, 0.01)
    ctx.lineTo(0, -0.083)
    ctx.lineTo(-0.074, 0.01)
  } else {
    ctx.moveTo(-0.105, 0.01)
    ctx.quadraticCurveTo(0, -0.04, 0.105, 0.01)
    ctx.lineTo(0.105, -0.014)
    ctx.quadraticCurveTo(0, -0.066, -0.105, -0.014)
  }
  ctx.closePath()
  ctx.clip()
  ribFill(p, -0.12, -0.13, 0.24, 0.15, j.stripe)
  ctx.restore()

  // Raglan / yoke seams.
  seamLine(p, [[-0.501, -0.55], [-0.205, -0.16], [0, -0.14], [0.205, -0.16], [0.501, -0.55]], j.yoke ? 1 : 0.5)

  if (side === 'front') {
    if (crest) {
      if (p.pass === 'color') {
        upright(ctx, 0, -0.37, 0, () => {
          const h = 0.26
          const w = (crest.width / crest.height) * h
          ctx.drawImage(crest, -w / 2, -h / 2, w, h)
        })
      } else {
        ctx.fillStyle = p.style('', H.twill, R.twill)
        ctx.fillRect(-0.13, -0.5, 0.26, 0.26)
      }
    } else if (j.wordmarkStyle === 'arch') {
      archedTwill(p, j.wordmark, -0.69, 0.42, j.wordmark.length > 8 ? 0.072 : 0.09, j)
    } else if (j.wordmarkStyle === 'diagonal') {
      twillText(p, j.wordmark, 0, -0.33, 0.135, 0.2, WORD_FONT, j)
    } else {
      twillText(p, j.wordmark, 0, -0.3, j.wordmark.length > 8 ? 0.058 : 0.095, 0, WORD_FONT, j)
    }
    if (!crest) twillText(p, String(j.rank), 0, -0.48, 0.105, 0, NUMBER_FONT, j, 400)
    // flag patch on the wearer's right shoulder (viewer's left)
    const [fx, fy] = sleevePoint(-1, SLEEVE_LEN * 0.16, 0.07)
    ctx.save()
    ctx.translate(fx, fy)
    ctx.rotate(-SLEEVE_ANGLE * 0.45)
    drawFlag(p, j.flag, 0.07, 0.047)
    ctx.restore()
  } else {
    twillText(p, 'PLAYER', 0, -0.135, 0.052, 0, WORD_FONT, j)
    twillText(p, String(j.rank), 0, -0.37, 0.24, 0, NUMBER_FONT, j, 400)
  }

  // Sleeve numbers on the upper sleeves, tilted with the hang.
  for (const m of [1, -1] as const) {
    const [x, y] = sleevePoint(m, SLEEVE_LEN * 0.42, 0.115)
    twillText(p, String(j.rank), x, y, 0.068, m * SLEEVE_ANGLE * 0.35, NUMBER_FONT, j, 400)
  }

  if (p.pass === 'color') {
    // the fabric darkens a touch where it rolls over the edge fold
    ctx.lineWidth = 0.024
    ctx.strokeStyle = 'rgba(0,0,0,0.12)'
    silhouettePath(ctx)
    ctx.stroke()
  }
  ctx.restore()
}

/** Painted here as canvases, or loaded pre-painted as KTX2 (src/jersey/assets.ts). */
export interface JerseyKit {
  map: THREE.Texture
  bump: THREE.Texture
  rough: THREE.Texture
}

/**
 * Grow each panel's edge colours outward past the outline. Seam vertices sit exactly on
 * the outline, so bilinear filtering and mipmaps sample just outside it: without this the
 * fill there (the kit's base colour) bleeds in as a thin line along every seam.
 */
function bleedEdges(canvas: HTMLCanvasElement, x0: number, w: number, h: number, s: number) {
  const tmp = document.createElement('canvas')
  tmp.width = w
  tmp.height = h
  const t = tmp.getContext('2d')!
  t.setTransform(s, 0, 0, -s, -BOUNDS.minX * s, BOUNDS.maxY * s)
  silhouettePath(t)
  t.setTransform(1, 0, 0, 1, 0, 0)
  t.save()
  t.clip()
  t.drawImage(canvas, x0, 0, w, h, 0, 0, w, h)
  t.restore()
  t.globalCompositeOperation = 'destination-over'
  for (const r of [1, 2, 4, 8, 16, 32]) {
    for (const [dx, dy] of [
      [1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1],
    ]) {
      t.drawImage(tmp, dx * r, dy * r)
    }
  }
  const ctx = canvas.getContext('2d')!
  ctx.save()
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.beginPath()
  ctx.rect(x0, 0, w, h)
  ctx.clip()
  ctx.drawImage(tmp, x0, 0)
  ctx.restore()
}

function paintAtlas(j: Jersey, width: number, pass: Pass, crest: HTMLImageElement | null) {
  const half = width / 2
  const height = Math.round((half * BOUNDS.height) / BOUNDS.width)
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')!
  const s = half / BOUNDS.width
  const painter = new Painter(ctx, pass)
  ;(['front', 'back'] as const).forEach((side, i) => {
    // keep each panel's overspill out of its neighbour
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.save()
    ctx.beginPath()
    ctx.rect(i * half, 0, half, height)
    ctx.clip()
    // metres → pixels, y up, origin at the collar of this panel
    ctx.setTransform(s, 0, 0, -s, i * half - BOUNDS.minX * s, BOUNDS.maxY * s)
    drawSide(painter, j, side, crest)
    ctx.restore()
    bleedEdges(canvas, i * half, half, height, s)
  })
  const tex = new THREE.CanvasTexture(canvas)
  tex.anisotropy = 8
  tex.colorSpace = pass === 'color' ? THREE.SRGBColorSpace : THREE.NoColorSpace
  return tex
}

const nextTask = () => new Promise((r) => setTimeout(r))

/** Paints the kit maps for one jersey. `width` is the colour atlas width in px; height
 *  and roughness are painted smaller (they carry less detail per pixel). */
export async function createJerseyKit(j: Jersey, width: number): Promise<JerseyKit> {
  await ensureKitFonts()
  const crest = j.crestUrl ? await loadCrest(j.crestUrl) : null
  const map = paintAtlas(j, width, 'color', crest)
  // yield between passes so a 4K paint never blocks a frame for long
  await nextTask()
  const bump = paintAtlas(j, Math.max(1024, width / 2), 'height', crest)
  await nextTask()
  const rough = paintAtlas(j, Math.max(512, width / 4), 'rough', crest)
  return { map, bump, rough }
}

/** Tiling knit height (columns of interlocking loops), sampled as micro-detail in the shader. */
let knitHeight: THREE.DataTexture | null = null
export function getKnitHeightMap(): THREE.DataTexture {
  if (knitHeight) return knitHeight
  const N = 128
  const data = new Uint8Array(N * N * 4)
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const u = (x / N) * Math.PI * 2
      const v = (y / N) * Math.PI * 2
      const col = Math.abs(Math.sin(u * 8))
      const loop = 0.5 + 0.5 * Math.cos(v * 16 + Math.sign(Math.sin(u * 8)) * 2.2)
      const h = col ** 0.7 * (0.55 + 0.45 * loop)
      const i = (y * N + x) * 4
      data[i] = data[i + 1] = data[i + 2] = h * 255
      data[i + 3] = 255
    }
  }
  knitHeight = new THREE.DataTexture(data, N, N, THREE.RGBAFormat)
  knitHeight.wrapS = knitHeight.wrapT = THREE.RepeatWrapping
  knitHeight.generateMipmaps = true
  knitHeight.minFilter = THREE.LinearMipmapLinearFilter
  knitHeight.magFilter = THREE.LinearFilter
  knitHeight.needsUpdate = true
  return knitHeight
}
