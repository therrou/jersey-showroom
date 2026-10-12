// Every motion "strength" in one place. Values are read live each physics step, so the
// ?tune panel (src/ui/TunePanel.tsx) can adjust them without a reload.
//
// `motion` is a master dial: 1 = the tuned default, 0.5 = calmer, 1.5 = livelier.

export const physics = {
  motion: 1,

  rack: {
    /** Rail slide spring (N/m) and damping ratio. Lower stiffness = lazier slide = less swing. */
    slideStiffness: 26,
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
    swingDamping: 4.5,
    /** Yaw spring for flips. */
    flipStiffness: 12,
    flipDamping: 0.55,
    /** Pointer breeze strength. */
    wind: 0.7,
    /** Fabric: lower bend compliance = stiffer, crisper folds. */
    bendCompliance: 6e-4,
    aero: 1.4,
    /** Grab-and-pull: pull per substep (0–1), soft patch radius (m), max pull from where
     *  the fabric hangs (m). Lower = heavier, calmer fabric. */
    grabStrength: 0.2,
    grabRadius: 0.05,
    grabMaxPull: 0.14,
    /** Velocity damping (1/s), plus extra for half a second after letting go. */
    damping: 1.1,
    releaseDamping: 5,
    /** Front↔back volume links pulling back to the rest depth (higher = softer). */
    volumeCompliance: 4e-3,
  },
}

export type PhysicsConfig = typeof physics

/** Scales a "strength" (gain, acceleration) by the master dial. */
export const m = (v: number) => v * physics.motion
