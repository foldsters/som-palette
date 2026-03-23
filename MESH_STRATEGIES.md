# Mesh Parametrization Strategies

Notes on techniques discovered while building topology meshes.

---

## Flip u↔v (transpose)

The texture `repeat`/`offset` API can't do a true transpose. Instead:

- Store both `uv` and `uvTransposed` (with `tu`/`tv` swapped) as buffer attributes in `buildParametric`
- Save the original as `uvNormal` on first toggle, then swap `geometry.uv` between the two
- This is a true coordinate transpose, not a mirror

---

## Culling triangles from a parametric mesh

Sending unwanted vertices to a far-away position (e.g. `[0, 1000, 0]`) does NOT remove geometry — the triangles still exist and their edges stretch across the screen.

To actually remove triangles, pass a `keepFn` to `buildParametric` that returns `false` for unwanted `(i, j)` cells. The index builder skips those cells entirely.

```ts
buildParametric(fn, nu, nv, uvFn, (i, j, nu, nv) => condition)
```

---

## Cross-cap (T:K / K:T): single-cover parametrization

The standard cross-cap parametrization double-covers the surface — `tw ∈ [0, 0.5]` and `tw ∈ [0.5, 1]` produce identical geometry. There is no UV remapping that fixes this; both halves must render to get a seamless look but only one is needed for a single cover.

**Solution:** cull `tw > 0.5` via `keepFn`, and remap the UV so the full palette (`tw: 0..1`) squeezes into the visible half (`tw: 0..0.5`) by multiplying the tw UV coordinate by 2.

```ts
uvFn:    (i, j, nu, nv) => [(i / nu) * 2, j / nv]  // hTwist case
keepFn:  (i, j, nu, nv) => (i / nu) <= 0.5
```

The K identification means `tw=0` and `tw=1` are the same point topologically, so nothing is lost.

---

## Deriving a parametrization step by step

When the standard formula gives wrong palette placement, build up the shape interactively:

1. **Fold** — use a triangle wave (`0.5 - |tw - 0.5|`) to fold the twist axis onto itself
2. **Bulge** — separate the two folded layers in z using `side = tw < 0.5 ? 1 : -1`, scaled by how far from the crease
3. **Scale bulge by cl** — multiply by `sin(cl * π)` so the fold closes at the collapsed ends
4. **Bend** — replace linear `y = cl` with a circular arc so `cl=0` and `cl=1` meet
5. **Collapse** — multiply width by `sin(cl * π)` to pinch the K edges to a point

Each step can be verified visually before proceeding to the next.

---

## UV canvas resize bug

When rows/cols change, the palette `<canvas>` is the same DOM element but its `.width`/`.height` change. A `THREE.CanvasTexture` caches the image reference — checking `tex.image !== canvas` never fires.

**Fix:** track the canvas dimensions separately in a ref (`texSizeRef`). Recreate the texture whenever the stored size differs from the current canvas size.
