// Every motion "strength" in one place. Values are read live each physics step, so the
// ?tune panel (src/ui/TunePanel.tsx) can adjust them without a reload.
//
// `motion` is a master dial: 1 = the tuned default, 0.5 = calmer, 1.5 = livelier.

export const physics = {
  motion: 1,

  rack: {
    /** Rail slide spring (N/m) and damping ratio. Lower stiffness = lazier slide = less swing. */
    slideStiffness: 18,
    slideDamping: 1.05,
    /** Hook yaw spring when turning to face (N·m/rad) and damping ratio. */
    turnStiffness: 0.55,
    turnDamping: 0.85,
    /** Air drag on the swing (1/s): higher settles faster. */
    swingDrag: 2.2,
    /** Cursor brush impulse per (m/s) of relative velocity, and per-step cap. */
    brushGain: 0.009,
    brushMax: 0.008,
  },

  rackCloth: {
    /** Hem inertia (how far the hem trails accelerations) and its wobble frequency (Hz). */
    lagGain: 1.2,
    lagFrequency: 1.5,
    lagDamping: 0.35,
    /** Lower body trailing the hanger's yaw. */
    twistGain: 0.45,
    twistDamping: 0.3,
    ripple: 0.6,
    flare: 0.5,
  },

  modal: {
    /** Pivot glide (critically damped) and how hard it may accelerate (m/s²). */
    glideStiffness: 30,
    glideMaxAccel: 3.5,
    /** Hook friction (1/s): how quickly the hanger's (physical) swing dies out. */
    swingDamping: 2,
    /** Yaw spring for flips. */
    flipStiffness: 12,
    flipDamping: 0.55,
    /** Pointer breeze strength. */
    wind: 0.7,
    /** Dihedral bending compliance (1/(N·m)): higher = floppier fabric. ~5e3 ≈ a heavy
     *  knit at this cage resolution. */
    bendCompliance: 5e3,
    /** How much of the Blender drape's curvature the fabric remembers (0 = rests flat). */
    bendRestKeep: 0.25,
    /** Quadratic air drag; ½ρC_d of real air is ≈ 0.6. */
    aero: 0.6,
    /** Grab-and-pull: attachment compliance (m/N, higher = looser grip), soft patch radius
     *  (m), max pull from where the fabric hangs (m), falloff toward the patch edge. */
    grabCompliance: 0.05,
    grabRadius: 0.05,
    grabMaxPull: 0.3,
    grabFalloff: 2,
    /** Deformation damping (1/s; rigid swing is never damped), optional extra after a drop. */
    damping: 1.2,
    releaseDamping: 0,
    releaseTime: 0.5,
    /** Stretch compliance in tension (≈ inextensible) and compression (soft: buckles). */
    stretchCompliance: 2e-8,
    compressionCompliance: 0.1,
    /** Self-collision thickness, as a fraction of the cage's mean edge (0 = off). */
    selfCollision: 0.65,
    /** Particle speed cap (m/s): a safety net only. */
    maxSpeed: 8,
  },
}

export type PhysicsConfig = typeof physics

/** Every knob that shapes how the modal jersey grabs, moves and settles. */
export const FEEL_KEYS = [
  'grabCompliance',
  'grabRadius',
  'grabMaxPull',
  'grabFalloff',
  'damping',
  'releaseDamping',
  'releaseTime',
  'maxSpeed',
  'aero',
  'bendCompliance',
  'bendRestKeep',
  'stretchCompliance',
  'compressionCompliance',
  'selfCollision',
  'swingDamping',
] as const
type ModalFeel = Pick<typeof physics.modal, (typeof FEEL_KEYS)[number]>

/** How the modal cloth feels to grab and drop (?tune → cloth feel). */
export const CLOTH_FEEL: Record<string, ModalFeel> = {
  'heavy knit': {
    grabCompliance: 0.08, grabRadius: 0.06, grabMaxPull: 0.25, grabFalloff: 1.6, damping: 2, releaseDamping: 0,
    releaseTime: 0.7, maxSpeed: 8, aero: 0.8, bendCompliance: 2e3, bendRestKeep: 0.35, stretchCompliance: 2e-8,
    compressionCompliance: 0.05, selfCollision: 0.7, swingDamping: 3,
  },
  default: {
    grabCompliance: 0.05, grabRadius: 0.05, grabMaxPull: 0.3, grabFalloff: 2, damping: 1.2, releaseDamping: 0,
    releaseTime: 0.5, maxSpeed: 8, aero: 0.6, bendCompliance: 5e3, bendRestKeep: 0.25, stretchCompliance: 2e-8,
    compressionCompliance: 0.1, selfCollision: 0.65, swingDamping: 2,
  },
  'light jersey': {
    grabCompliance: 0.03, grabRadius: 0.045, grabMaxPull: 0.35, grabFalloff: 2.4, damping: 0.7, releaseDamping: 0,
    releaseTime: 0.35, maxSpeed: 8, aero: 0.5, bendCompliance: 1.2e4, bendRestKeep: 0.15, stretchCompliance: 2e-8,
    compressionCompliance: 0.2, selfCollision: 0.6, swingDamping: 1.4,
  },
}

/** Scales a "strength" (gain, acceleration) by the master dial. */
export const m = (v: number) => v * physics.motion
