# Brief: a real hockey jersey model, built in Blender, driven by our physics

## Context
`~/hockey-jersey-rack` is a React Three Fiber POC (Vite + React 19 + TS + pnpm; R3F, drei,
@react-three/rapier, postprocessing, zustand, leva). Run with `pnpm dev`; `?tune` opens the
physics panel. Read `README.md` first — it explains the architecture.

Ten national-team hockey jerseys (IIHF top 10, inspired-by kits, no federation/brand logos)
hang on a rail. Hover turns a jersey to face you (Rapier hangers), the cursor brushes them,
click lifts it into a modal with real XPBD cloth in a Web Worker (grab-and-pull, flip to the
back, fade/rise carousel, put-back on close). Desktop-first, graceful on phones.

**The problem:** the jersey mesh is procedural (`src/jersey/JerseyGeometry.ts`): a flat
pattern inflated into two sheets. It reads as stylised CG — side-on it looks like a surfboard,
cuffs collapse to points, sleeves stick out rigidly, no real armholes or tube volume, no drape.

## Goal
Build a realistic hockey jersey garment in Blender (via the Blender MCP, which is connected),
export it, and make the existing physics drive it — without losing any current feature.

## Garment spec
- Units metres. Garment local frame (matches the code): origin at the top of the collar,
  +y up, +x to the viewer's right, front faces +z. The hanger hook pivot is 0.13 m above the
  collar (`JERSEY_DROP` in `src/scene/rackLayout.ts`).
- Adult L replica, hockey cut: boxy, ~66 cm chest, ~82 cm body, wide sleeves (~56 cm long,
  ~27 cm wide at the armpit), V-neck front with a rib collar band, rib cuffs and hem.
- **Construction (important, keeps the kit art working):** two main pattern pieces, FRONT and
  BACK, each the outline in `src/jersey/silhouette.ts` (`SILHOUETTE`, body + sleeves in one
  piece, kimono-sleeve style). Sew them along: shoulder/sleeve top (collar edge → outer cuff),
  sleeve underside (inner cuff → armpit), side seams (armpit → hem corner). Leave open: the
  neck, the hem, both cuffs. Add a separate collar band piece.
- **UVs = the flat pattern, in the existing atlas convention** (see `pushVertex` in
  `JerseyGeometry.ts`): FRONT in u∈[0,0.5], BACK in u∈[0.5,1] mirrored, both scaled by
  `BOUNDS` from `silhouette.ts`. Then `src/jersey/jerseyTexture.ts` (the kit painter) works
  unchanged for all 10 teams. Put the collar band in a spare UV strip and tell me where.
- Drape it with Blender cloth (sewing springs + gravity) onto a hanger collider matching
  `src/scene/Hanger.tsx` (wooden bar ±0.19 m, ~3 cm below the shoulder line). Sleeves should
  fall close to vertical along the body; the body should hang with natural vertical folds and
  real depth (a tube, not two sheets).

## Deliverables
1. `public/models/jersey.glb` (compressed with meshopt or Draco, aim < 3 MB) containing:
   - `JerseyRender`: ~15–25k tris, UV0 as above, plus baked **normal** (fine wrinkles, seams)
     and **AO** maps (armpits, under collar, inside folds) as textures in the GLB or alongside.
   - `JerseyCage`: a simulation cage of ~1.5–3k vertices following the same surface, with a
     vertex group/attribute marking the **pins** (vertices resting on the hanger bar).
2. A loader that implements the existing `JerseyMesh` interface from the GLB:
   cage → `particles`, `edges`, `bends` (across interior edges), `pins`, plus cross-links
   front↔back so the tube keeps its volume (replacing `thickness`); render mesh bound to the
   cage (each render vertex: cage triangle + barycentric + normal offset), reconstructed each
   frame after the solver step. Swap it in at `src/jersey/assets.ts`, keep the procedural
   mesh as a fallback (flag or query param).
3. The rack (`src/scene/HangerRig.tsx` + the vertex shader in `src/jersey/fabricMaterial.ts`)
   should use the render mesh directly (the shader displaces by height on the garment, so it
   should mostly just work); feed the baked AO in place of the `aAO` attribute.

## Process (check in with me at each ✋)
1. `get_addon_status` + `get_scene_info`; read `silhouette.ts`, `JerseyGeometry.ts`,
   `jerseyTexture.ts`, `Hanger.tsx`, `ClothSolver.ts`.
2. Build pattern pieces + hanger collider, sew, simulate. Show me `look` renders: front,
   side, three-quarter. ✋
3. Detail pass (collar band, rib cuffs/hem, wrinkle detail), bake normal + AO. Show renders
   with a test kit texture applied, to prove the UVs line up with the kit painter. ✋
4. Build the cage, export the GLB, write the loader + binding, wire it in.
5. Verify in the browser (rack hover, brush, modal open/grab/flip/carousel/close) at desktop
   and phone size; report frame rates. ✋

## Acceptance
- Side-on on the rack it reads as a real hanging garment: tube volume, no pointed cuffs,
  sleeves hanging down, natural folds. Up close in the modal it holds up.
- All 10 kits render correctly from the existing painter (no per-team manual work).
- Every current interaction still works; desktop ~60 fps, phones smooth on the low tier.

## Constraints
- No purchases or downloads of third-party assets without asking me first.
- Inspired-by kits only (no federation crests or manufacturer logos).
- Don't regress existing features; keep the procedural mesh as a fallback.
- Material polish also pending, do it if time allows: matte the fabric (the current sheen
  glows on edges), soften the rim/bloom halo on white kits, real cut-out vent holes.
