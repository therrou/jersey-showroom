import { Leva, button, folder, useControls } from 'leva'
import { CLOTH_FEEL, FEEL_KEYS, physics } from '../config/physics'

const enabled = typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('tune')

type FeelKey = (typeof FEEL_KEYS)[number]

/** Slider ranges + labels for the grab & drop knobs (all live: change them mid-grab). */
const FEEL_UI: Record<FeelKey, { min: number; max: number; step?: number; label: string; scale?: number }> = {
  grabCompliance: { min: 0.005, max: 0.3, step: 0.005, label: 'grab looseness (m/N)' },
  grabRadius: { min: 0.02, max: 0.12, label: 'grab radius (m)' },
  grabMaxPull: { min: 0.03, max: 0.5, label: 'max pull (m)' },
  grabFalloff: { min: 0.5, max: 4, label: 'grab falloff' },
  damping: { min: 0, max: 6, label: 'deformation damping' },
  releaseDamping: { min: 0, max: 20, label: 'calm after drop' },
  releaseTime: { min: 0, max: 2, label: 'calm time (s)' },
  maxSpeed: { min: 1, max: 12, label: 'speed cap (m/s)' },
  aero: { min: 0, max: 3, label: 'air drag' },
  // compliances span decades: shown scaled so the sliders read as plain numbers
  bendCompliance: { min: 0.1, max: 50, step: 0.1, scale: 1e-3, label: 'bend softness ×1e3' },
  bendRestKeep: { min: 0, max: 1, step: 0.01, label: 'fold memory' },
  stretchCompliance: { min: 0, max: 10, step: 0.01, scale: 1e6, label: 'stretch ×1e-6' },
  compressionCompliance: { min: 0, max: 1, step: 0.005, label: 'compression softness' },
  selfCollision: { min: 0, max: 1.2, step: 0.05, label: 'self-collision thickness' },
  swingDamping: { min: 0, max: 6, label: 'hook friction' },
}

/** Physics values → what the sliders display. */
const shown = (values: Partial<Record<FeelKey, number>>) =>
  Object.fromEntries(Object.entries(values).map(([k, v]) => [k, (v as number) * (FEEL_UI[k as FeelKey].scale ?? 1)]))

/** Live physics tuning (open the app with ?tune). Writes straight into `physics`. */
function Controls() {
  const set = <K extends keyof typeof physics>(group: K, key: string) => (v: number) => {
    ;(physics[group] as Record<string, number>)[key] = v
  }

  // Grab & drop first: everything that decides how the modal jersey grabs, moves and settles.
  // (the sliders are built from FEEL_KEYS, which leva's types can't follow: type the setter)
  const [, setFeel] = useControls('grab & drop', () => ({
    preset: {
      options: Object.keys(CLOTH_FEEL),
      value: 'default',
      onChange: (name: string) => {
        const p = CLOTH_FEEL[name]
        if (!p) return
        Object.assign(physics.modal, p)
        setFeel(shown(p))
      },
    },
    ...Object.fromEntries(
      FEEL_KEYS.map((k) => {
        const { scale = 1, ...ui } = FEEL_UI[k]
        return [k, { value: physics.modal[k] * scale, ...ui, onChange: (v: number) => (physics.modal[k] = v / scale) }]
      }),
    ),
    'copy settings': button(() => {
      const values = Object.fromEntries(FEEL_KEYS.map((k) => [k, physics.modal[k]]))
      void navigator.clipboard?.writeText(JSON.stringify(values, null, 2))
      console.info('[tune] grab & drop settings', values)
    }),
    reset: button(() => {
      Object.assign(physics.modal, CLOTH_FEEL.default)
      setFeel({ ...shown(CLOTH_FEEL.default), preset: 'default' })
    }),
  })) as unknown as [unknown, (values: Record<string, unknown>) => void]

  useControls({
    motion: { value: physics.motion, min: 0, max: 2, step: 0.05, label: 'motion (master)', onChange: (v: number) => (physics.motion = v) },
    rack: folder(
      {
        slideStiffness: { value: physics.rack.slideStiffness, min: 5, max: 80, onChange: set('rack', 'slideStiffness') },
        slideDamping: { value: physics.rack.slideDamping, min: 0.3, max: 2, onChange: set('rack', 'slideDamping') },
        turnStiffness: { value: physics.rack.turnStiffness, min: 0.1, max: 2, onChange: set('rack', 'turnStiffness') },
        turnDamping: { value: physics.rack.turnDamping, min: 0.3, max: 2, onChange: set('rack', 'turnDamping') },
        swingDrag: { value: physics.rack.swingDrag, min: 0.2, max: 6, onChange: set('rack', 'swingDrag') },
        brushGain: { value: physics.rack.brushGain, min: 0, max: 0.03, step: 0.001, onChange: set('rack', 'brushGain') },
      },
      { collapsed: true },
    ),
    'rack cloth': folder(
      {
        lagGain: { value: physics.rackCloth.lagGain, min: 0, max: 3, onChange: set('rackCloth', 'lagGain') },
        twistGain: { value: physics.rackCloth.twistGain, min: 0, max: 1.5, onChange: set('rackCloth', 'twistGain') },
        ripple: { value: physics.rackCloth.ripple, min: 0, max: 2, onChange: set('rackCloth', 'ripple') },
        flare: { value: physics.rackCloth.flare, min: 0, max: 2, onChange: set('rackCloth', 'flare') },
      },
      { collapsed: true },
    ),
    'modal hanger': folder(
      {
        glideMaxAccel: { value: physics.modal.glideMaxAccel, min: 1, max: 12, onChange: set('modal', 'glideMaxAccel') },
        flipStiffness: { value: physics.modal.flipStiffness, min: 2, max: 40, onChange: set('modal', 'flipStiffness') },
        flipDamping: { value: physics.modal.flipDamping, min: 0.2, max: 1.5, onChange: set('modal', 'flipDamping') },
        wind: { value: physics.modal.wind, min: 0, max: 3, onChange: set('modal', 'wind') },
      },
      { collapsed: true },
    ),
    // the Rapier soft-body cloth (default solver; ?solver=xpbd uses the "grab & drop" stretch/bend knobs instead)
    'rapier cloth': folder(
      {
        substeps: { value: physics.rapierCloth.substeps, min: 2, max: 20, step: 1, onChange: set('rapierCloth', 'substeps') },
        pgsIterations: { value: physics.rapierCloth.pgsIterations, min: 0, max: 6, step: 1, label: 'pgs iterations', onChange: set('rapierCloth', 'pgsIterations') },
        stretchHz: { value: physics.rapierCloth.stretchHz, min: 10, max: 1e5, step: 10, label: 'stretch (Hz)', onChange: set('rapierCloth', 'stretchHz') },
        stretchDamping: { value: physics.rapierCloth.stretchDamping, min: 0, max: 3, label: 'stretch damping', onChange: set('rapierCloth', 'stretchDamping') },
        bendHz: { value: physics.rapierCloth.bendHz, min: 0.2, max: 30, step: 0.1, label: 'bend (Hz)', onChange: set('rapierCloth', 'bendHz') },
        bendDamping: { value: physics.rapierCloth.bendDamping, min: 0, max: 3, label: 'bend damping', onChange: set('rapierCloth', 'bendDamping') },
        grabTime: { value: physics.rapierCloth.grabTime, min: 0.02, max: 0.3, step: 0.005, label: 'grab follow (s)', onChange: set('rapierCloth', 'grabTime') },
      },
      { collapsed: false },
    ),
  })
  return null
}

export function TunePanel() {
  if (!enabled) return null
  return (
    <>
      <Leva collapsed={false} titleBar={{ title: 'physics' }} theme={{ sizes: { rootWidth: '360px', controlWidth: '150px' } }} />
      <Controls />
    </>
  )
}
