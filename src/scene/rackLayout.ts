// World layout of the rack. Units are metres; the rail runs along x at z = 0.

export const RAIL_Y = 0.95
export const RAIL_LENGTH = 2.85
/** Hook pivot → top of the collar. */
export const JERSEY_DROP = 0.13
/** Rail space taken by a jersey hanging side-on vs turned to face the viewer. */
export const SLOT_SIDE = 0.165
export const SLOT_FACE = 0.82
/** Side-on yaw: the jersey's front points along +x. */
export const SIDE_YAW = Math.PI / 2

export function slotPositions(count: number, hovered: number | null): number[] {
  const widths = Array.from({ length: count }, (_, i) => (i === hovered ? SLOT_FACE : SLOT_SIDE))
  const total = widths.reduce((a, b) => a + b, 0)
  let x = -total / 2
  return widths.map((w) => {
    const c = x + w / 2
    x += w
    return c
  })
}

// Collision groups: jerseys bump each other; the hanger bar and trolley collide with nothing.
const bits = (memberships: number[], filters: number[]) =>
  (memberships.reduce((m, g) => m | (1 << g), 0) << 16) | filters.reduce((m, g) => m | (1 << g), 0)
export const GROUP_JERSEY = bits([0], [0])
export const GROUP_NONE = 0
