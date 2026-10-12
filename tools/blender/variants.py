"""Drape variants for the rack: the same garment re-draped with other seeded folds, sleeve
hang and solver noise, so the jerseys on the rail don't all share one set of creases.

    import variants
    variants.drape_variant(1)   # ~2.5 min each, for 1..len(VARIANTS)
    import export; export.run() # adds them as shape keys → glTF morph targets

Each variant is a full drape of the same tube ('JerseyDrapeVar<i>': same topology and
pattern coordinates as 'JerseyDrape', denoised like it). The export maps every render
vertex through the pattern onto each variant and stores the difference as a shape key on
JerseyRender / JerseyRenderLow; the collar band and facings follow the nearest body
vertices. The web blends them per jersey (HangerRig). The cages, bakes and the modal's
cloth all stay on the base drape.
"""

import bpy
import numpy as np
from mathutils.kdtree import KDTree

import detail
import drape
import garment
from patmap import PatternMap

VARIANTS = [
    dict(phase=(2.3, 0.4, 1.1), hang=18, forward=0.055, fold=0.05, seed=2),
    dict(phase=(-0.9, 3.4, 0.2), hang=30, forward=0.035, fold=0.065, seed=3),
    dict(phase=(1.6, -1.8, 2.7), hang=22, forward=0.05, fold=0.04, seed=4),
]
NEAREST = 4  # body vertices a collar/facing vertex follows


def name(i):
    return f"JerseyDrapeVar{i}"


def drape_variant(i):
    v = VARIANTS[i - 1]
    saved = (garment.FOLD_PHASE, garment.FOLD_DEPTH, garment.SLEEVE_FORWARD, drape.SLEEVE_HANG_DEG)
    try:
        garment.FOLD_PHASE = v["phase"]
        garment.FOLD_DEPTH = v["fold"]
        garment.SLEEVE_FORWARD = v["forward"]
        drape.SLEEVE_HANG_DEG = v["hang"]
        log = drape.run(name=name(i), seed=v["seed"])
    finally:
        garment.FOLD_PHASE, garment.FOLD_DEPTH, garment.SLEEVE_FORWARD, drape.SLEEVE_HANG_DEG = saved
    obj = bpy.data.objects[name(i)]
    detail.denoise(obj)
    obj.hide_set(True)
    obj.hide_render = True
    return log


def available():
    """Variant drapes present in the file (in order, stopping at the first missing one)."""
    out = []
    for i in range(1, len(VARIANTS) + 1):
        o = bpy.data.objects.get(name(i))
        if o is None:
            break
        out.append(o)
    return out


def _co(obj):
    co = np.empty(len(obj.data.vertices) * 3)
    obj.data.vertices.foreach_get("co", co)
    return co.reshape(-1, 3)


def add_shape_keys(obj, drapes):
    """Shape keys 'drape<i>' on a render object: its base positions moved by each
    variant's difference from the base drape at the same pattern point."""
    base = drape.mesh_arrays(bpy.data.objects["JerseyDrape"])
    pm = PatternMap(base["co"], base["px"], base["py"], base["tris"], base["face_front"])
    var_co = []
    for d in drapes:
        c = _co(d)
        assert c.shape == base["co"].shape, (d.name, c.shape, base["co"].shape)
        var_co.append(c)
    me = obj.data
    n = len(me.vertices)
    get = lambda k: np.array([a.value for a in me.attributes[k].data])
    px, py, side, part = get("pat_x"), get("pat_y"), get("side").astype(int), get("part").astype(int)
    co = _co(obj)
    deltas = [np.zeros((n, 3)) for _ in drapes]
    body = np.where(part == 0)[0]
    for v in body:
        s = 0 if side[v] == 2 else side[v]
        t, bc = pm.locate(s, np.array([px[v], py[v]]))
        tri = pm.sides[s]["T"][t]
        for d, c in zip(deltas, var_co):
            d[v] = bc @ (c[tri] - base["co"][tri])
    # collar band + facings: follow the nearest body vertices
    kd = KDTree(len(body))
    for k, v in enumerate(body):
        kd.insert(co[v], k)
    kd.balance()
    for v in np.where(part != 0)[0]:
        near = kd.find_n(co[v], NEAREST)
        w = np.array([1 / (dist + 1e-4) for _, _, dist in near])
        idx = body[[k for _, k, _ in near]]
        for d in deltas:
            d[v] = (w[:, None] * d[idx]).sum(0) / w.sum()
    if me.shape_keys:
        obj.shape_key_clear()
    obj.shape_key_add(name="Basis", from_mix=False)
    for i, d in enumerate(deltas, 1):
        key = obj.shape_key_add(name=f"drape{i}", from_mix=False)
        key.data.foreach_set("co", (co + d).ravel())
    return [float(np.abs(d).max()) for d in deltas]
