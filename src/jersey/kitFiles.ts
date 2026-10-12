/**
 * Pre-painted kit atlases shipped as KTX2 (public/kits/), built by tools/kit-bake.html +
 * tools/kits/encode.sh. Two tiers, power-of-two sizes (UVs are normalised, so the
 * painter's aspect is simply resampled):
 *   r  rack, and the modal on phones
 *   m  modal on desktop
 */
export const KIT_TIERS = {
  r: { color: [2048, 1024], height: [1024, 512], rough: [512, 256] },
  m: { color: [4096, 2048], height: [2048, 1024], rough: [1024, 512] },
} as const

export type KitTier = keyof typeof KIT_TIERS
export type KitMap = 'color' | 'height' | 'rough'

/** Colour-atlas width → tier (the painter's widths: 1024/2048 rack, 2048/4096 modal). */
export const kitTier = (width: number): KitTier => (width > 2048 ? 'm' : 'r')

export const kitUrl = (code: string, map: KitMap, tier: KitTier) => `/kits/${code}_${map}_${tier}.ktx2`
