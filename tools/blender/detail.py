"""Step 2 of the build: finish the raw drape into the render garment.

    import detail; detail.run()

raw drape → denoise (vertex-level solver jitter shows as quilting up close) → relax the
neckline → collar band → hem/cuff facings. Always starts from the stashed raw drape, so
it can be re-run freely.
"""

import bpy
import numpy as np

import collar
import drape
import facings


def denoise(obj, iters=8):
    """Taubin smoothing over the whole drape: removes per-vertex jitter (a few mm
    wavelength) without shrinking or flattening the folds (10 cm+)."""
    m = drape.mesh_arrays(obj)
    x = m["co"].copy()
    e = m["edges"]
    n = len(x)
    deg = np.bincount(e.ravel(), minlength=n).astype(float)
    fixed = m["pin"]

    def lap(x):
        acc = np.zeros_like(x)
        np.add.at(acc, e[:, 0], x[e[:, 1]])
        np.add.at(acc, e[:, 1], x[e[:, 0]])
        out = acc / np.maximum(deg, 1)[:, None] - x
        out[fixed] = 0
        return out

    for _ in range(iters):
        x += 0.5 * lap(x)
        x -= 0.53 * lap(x)
    obj.data.vertices.foreach_set("co", x.ravel())
    obj.data.update()


def run(obj_name="JerseyDrape"):
    obj = bpy.data.objects[obj_name]
    collar.restore_raw(obj)
    denoise(obj)
    band = collar.build(obj_name, keep_current=True)
    fac = facings.build(obj_name)
    return obj, band, fac
