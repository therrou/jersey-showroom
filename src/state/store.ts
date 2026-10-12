import { create } from 'zustand'
import { JERSEYS } from '../data/jerseys'

export type Quality = 'high' | 'low'

/** closed → opening (snapshot + lift-off) → open → closing (put back) → closed */
export type ModalPhase = 'closed' | 'opening' | 'open' | 'closing'

/** Where a jersey sits on screen in the rack: pivot in NDC, scale, and its yaw. */
export interface ScreenPose {
  ndcX: number
  ndcY: number
  /** Pixels per metre at the pivot's depth. */
  pxPerM: number
  yaw: number
}

const prefersLow =
  typeof window !== 'undefined' &&
  (window.matchMedia('(pointer: coarse)').matches || window.innerWidth < 768)

interface RackState {
  hovered: number | null
  /** Jersey shown in the modal. */
  open: number | null
  phase: ModalPhase
  /** Jersey hidden on the rack because it's in the modal. */
  lifted: number | null
  /** Rack pose the modal jersey lifts off from (set by the rack when opening). */
  openFrom: ScreenPose | null
  quality: Quality
  /** Rack render scale, adapted to the measured frame rate before dropping quality. */
  dpr: number
  setDpr: (dpr: number) => void
  /** Modal: showing the back of the jersey. */
  flipped: boolean
  /** Modal: direction of the last ←/→ step, for the transition. */
  stepDir: 1 | -1
  toggleFlip: () => void
  /** Portrait screens browse the rack itself as a carousel (no modal): `hovered` is the
   *  active slide, turned out facing front, or back while `rackFlipped`. */
  carousel: boolean
  rackFlipped: boolean
  setCarousel: (on: boolean) => void
  /** Carousel: make jersey `i` the active slide (front first). */
  showSlide: (i: number) => void
  /** Carousel: step to the next/previous jersey, wrapping around. */
  stepSlide: (dir: 1 | -1) => void
  flipSlide: () => void
  setHovered: (i: number | null) => void
  openJersey: (i: number) => void
  /** The modal cloth is ready at the rack pose: hide the rack's copy. */
  liftOff: () => void
  /** Rack finished its snapshot: the modal takes over. */
  opened: () => void
  close: () => void
  /** Modal finished putting the jersey back. */
  closed: () => void
  step: (dir: 1 | -1) => void
  setQuality: (q: Quality) => void
}

export const useRack = create<RackState>((set, get) => ({
  hovered: null,
  open: null,
  phase: 'closed',
  lifted: null,
  openFrom: null,
  quality: prefersLow ? 'low' : 'high',
  dpr: prefersLow ? 1 : Math.min(1.5, typeof window !== 'undefined' ? window.devicePixelRatio : 1),
  setDpr: (dpr) => set({ dpr }),
  flipped: false,
  stepDir: 1,
  toggleFlip: () => set({ flipped: !get().flipped }),
  carousel: false,
  rackFlipped: false,
  setCarousel: (on) => {
    if (on === get().carousel) return
    // entering: the first jersey is the active slide; leaving: back to the plain rack
    if (on) set({ carousel: true, rackFlipped: false, hovered: get().hovered ?? 0 })
    else set({ carousel: false, rackFlipped: false })
  },
  showSlide: (i) => set({ hovered: i, rackFlipped: false }),
  stepSlide: (dir) => {
    const n = JERSEYS.length
    set({ hovered: ((get().hovered ?? 0) + dir + n) % n, rackFlipped: false })
  },
  flipSlide: () => set({ rackFlipped: !get().rackFlipped }),
  setHovered: (i) => set({ hovered: i }),
  openJersey: (i) => {
    if (get().phase !== 'closed') return
    set({ open: i, phase: 'opening', flipped: false })
  },
  liftOff: () => {
    if (get().phase === 'opening') set({ lifted: get().open })
  },
  opened: () => {
    if (get().phase === 'opening') set({ phase: 'open', hovered: null })
  },
  close: () => {
    // the jersey being viewed goes back as the rack's turned-out one: the rack makes room
    // for it while it's carried back, so it lands exactly where its rack copy will be
    if (get().phase === 'open' || get().phase === 'opening') set({ phase: 'closing', hovered: get().open })
  },
  closed: () => set({ phase: 'closed', open: null, lifted: null, openFrom: null }),
  step: (dir) => {
    const { open, phase } = get()
    if (open === null || phase !== 'open') return
    const next = (open + dir + JERSEYS.length) % JERSEYS.length
    // the rack shows the old one again, hides the new one
    set({ open: next, lifted: next, stepDir: dir, flipped: false })
  },
  setQuality: (q) => set({ quality: q }),
}))

if (import.meta.env.DEV) (window as unknown as { __store: typeof useRack }).__store = useRack
