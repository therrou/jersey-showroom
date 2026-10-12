"""The whole garment build, in order (run inside Blender with tools/blender on sys.path):

    import build; build.run()

1. drape   pattern → sewn tube → drape on the hanger (numpy XPBD)       ~2.5 min
2. detail  denoise, collar band, rib facings
3. bake    JerseyRender + bake UVs, high-poly detail, normal + AO bake  ~1 min
4. export  cages, JerseyRenderLow, public/models/jersey.glb + WebP maps
"""

import os
import time

import bake
import detail
import drape
import export

TEXTURES = os.path.join(export.ROOT, "assets-src", "textures")


def run():
    t = time.time()
    log = [drape.run()]
    detail.run()
    log.append(f"uv overlap {bake.run(TEXTURES):.4f}")
    log.append(str(export.run()))
    log.append(f"total {time.time() - t:.0f}s")
    return "\n".join(log)
