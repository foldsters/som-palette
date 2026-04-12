# Palettopes

A **palettope** is a 2D palette grid with edge assignments that define its topology — how edges pinch and join. The SOM trains on the palette using its intrinsic geometry, and the 3D mesh visualizes the resulting shape.

---

## Edge Controls

Each of the four edges has a circular hotspot at its midpoint. The current edge state is shown as an arrow glyph inside the circle.

**Interaction:**
- **Click** — clear the edge to neutral (no cascade to opposite edge)
- **Click and drag** — drag away from the hotspot in a direction to set the edge state; release to commit. The drag direction is interpreted relative to the edge:
  - Away from palette center → outward
  - Toward palette center → inward
  - Along the edge (either direction) → lateral join
  - Release within the dead zone (no drag) → neutral

Other hotspots show a ghost preview of what they would be forced to during a drag, before you commit.

The arrow meaning depends on which edge it's on. "Outward" means away from the palette center; "inward" means toward it.

| Edge   | Outward (pinch+join) | Inward (pinch only) | Lateral (join only) | Neutral |
|--------|---------------------|---------------------|---------------------|---------|
| Top    | ↑                   | ↓                   | ← / →               | ·       |
| Bottom | ↓                   | ↑                   | ← / →               | ·       |
| Left   | ←                   | →                   | ↑ / ↓               | ·       |
| Right  | →                   | ←                   | ↑ / ↓               | ·       |

- **Outward**: the edge collapses to a point and joins with its opposite (both become the same pole).
- **Inward**: the edge collapses to a point independently, no join with the opposite.
- **Lateral**: the edge joins with its opposite. Same direction on both = wrap; opposite directions = twist.
- **Neutral**: the edge is open and free.

---

## Axis States

Each axis (H = left↔right, V = top↔bottom) has a state derived from its two edge arrows:

| State | Edges | Join |
|-------|-------|------|
| **open** | both neutral | free |
| **half-pinched** | one inward, one neutral | free |
| **pinched** | both inward | free |
| **wrapped** | both lateral, same direction | wrap |
| **twisted** | both lateral, opposite directions | twist |
| **pinched-joined** | both outward | joined (wrap = twist) |

The topology key is `H-axis:V-axis`, e.g. `wrapped:open` = Cylinder.

---

## Forcing Rules

Selecting an arrow on one edge may force the opposite to stay consistent:

| Action | Effect on opposite edge |
|--------|------------------------|
| Outward | Force opposite outward |
| Inward (opposite was outward) | Force opposite inward |
| Inward (opposite was lateral) | Clear opposite to neutral |
| Lateral | Force opposite to same direction (wrap), unless already the other direction (twist) |
| Neutral (opposite was outward) | Force opposite inward |
| Neutral (opposite was inward, unpaired) | Clear opposite to neutral |
| Neutral (opposite was lateral) | Clear opposite to neutral |

### Corner adjacency (auto-join)

If **3 or more edges** are pinched, any axis with both edges pinched is **forced joined** — because shared corners mean those poles are topologically the same point. The hotspot shows ↕ (top/bottom) or ↔ (left/right) to indicate the forced join; clicking resets that edge to neutral.

### Navigation shortcuts

These rules make common transitions feel natural:

| From | Action | To |
|------|--------|----|
| Teardrop | Set one edge neutral | Saucière (opposite goes inward) |
| Cannoli | Set one outward edge inward | Both go inward |
| Saucière | Set the single inward edge neutral | Cannoli (pinched-joined axis forces outward) |

---

## Palettope Catalogue

### Free axes

| Key | Name | Description |
|-----|------|-------------|
| `open:open` | **Rectangle** | Flat, no pinching or joining |
| `half-pinched:open` | **Ogive** | One edge pinched |
| `pinched:open` | **Lens** | Both edges of one axis pinched |
| `half-pinched:half-pinched` | **Canoe** | One edge pinched on each axis |
| `half-pinched:pinched-joined` | **Saucière** | One axis pinched-joined, other half-pinched (forced by corner adjacency) |
| `pinched-joined:pinched-joined` | **Quadrupole** | Both axes pinched-joined (forced by corner adjacency); self-intersecting 4-lobe shape |

### Wrapped

| Key | Name |
|-----|------|
| `wrapped:open` | **Cylinder** |
| `wrapped:half-pinched` | **Dome** |
| `wrapped:pinched` | **Sphere** |
| `wrapped:wrapped` | **Torus** |
| `wrapped:pinched-joined` | **Horn Torus** |
| `pinched-joined:open` | **Cannoli** |
| `pinched-joined:pinched-joined` | **Quadrupole** | (see Free axes — same key, same topology) |

### Twisted

| Key | Name |
|-----|------|
| `twisted:open` | **Möbius** |
| `twisted:wrapped` | **Klein** |
| `twisted:twisted` | **Boy's Surface** |
| `twisted:pinched-joined` | **Cross-cap** |
| `twisted:half-pinched` | **Nautilus** |

---

## Practical Uses

### Color palette design

- **Ogive** (`half-pinched:open`): one axis tapers to a point while the other remains open. The geometry resembles HSV/HSB color pickers — the pole is a natural anchor for a single convergence point (whatever the source image's dominant color or neutral is), with variation spreading outward toward the free edge. Good for palettes that need one end to funnel into a single tone.

- **Lens** (`pinched:open`): both ends of one axis pinch to separate poles, the other axis open. The geometry resembles a double-cone color model, with two convergence points at opposite ends and a band of variation across the middle — though what occupies those poles depends on the source.

- **Sphere** (`wrapped:pinched`): a fully closed surface with two poles. Approximates a full 3D color solid mapped onto a 2D palette — the two poles and the equatorial band give the SOM a natural hierarchy of neighborhoods, though what colors land where depends on the source image. Particularly well-suited for normal maps, since the space of unit normals is itself a sphere — the palettope geometry matches the domain of the data.

- **Quadrupole** (`pinched-joined:pinched-joined`): all four edges collapse and join, producing a self-intersecting 4-lobe shape. Good for palettes where all four corners share the same dominant color anchor.

### Texture and pattern generation

- **Cylinder** (`wrapped:open`): the most natural palette for seamlessly tiling textures in one direction. Colors wrap horizontally with no seam; the top and bottom edges are free (good for a gradient band).

- **Torus** (`wrapped:wrapped`): tiles seamlessly in both directions. Ideal for textures that need to repeat without any visible edge — wallpapers, fabric patterns, terrain.

- **Cannoli** (`pinched-joined:open`): wraps in one direction but both ends of the wrap axis collapse to the same pole. Useful for textures where you want a seam-free horizontal wrap but the top and bottom can share a common color anchor — like a label wrapped around a bottle where the top and bottom edges meet at the same trim color. The open V-axis also lets you randomize the vertical offset between repeating tiles without introducing a visible seam at the join.

- **Horn Torus** (`wrapped:pinched-joined`): a torus that passes through a single degenerate point. Useful when you want torus-like tiling but with one "pinch point" where all palette paths converge — can create interesting vortex-like pattern effects.

### Non-orientable / special surfaces

- **Möbius** (`twisted:open`): the palette has only one side — traversing the full horizontal extent flips you to the "other side." Useful for color gradients that should reverse smoothly at the halfway point, or for procedural patterns that need a single-sided band structure.

- **Klein** (`twisted:wrapped`): a closed surface with no boundary and no inside/outside. Because it is a double cover of the Möbius band, a Klein palette naturally produces patterns that are "see-through" in the sense that opposite sides of the palette are related by a flip — useful for translucent or iridescent material appearances where the color seen from the front is the complement of the color seen from behind.

- **Boy's Surface / Cross-cap**: both immersions of $\mathbb{RP}^2$ — the palette has the property that every straight path eventually returns to its starting point with reversed orientation. Useful for highly symmetric, self-referential palettes, or for exploring what a SOM learns when given a fundamentally non-orientable distance geometry.

- **Nautilus** (`twisted:half-pinched`): a Möbius-like surface with one edge pinched to a point and one free edge. The free edge is a single closed curve that returns to itself after a full twist — like a seashell opening. Good for palettes with a single convergence point and a gradient that reverses orientation as it spreads outward.

### Summary table

| Goal | Palettope |
|------|-----------|
| HSV-style with neutral pole | Ogive |
| Black–white neutral poles, saturated equator | Lens / Sphere |
| Seamless 1D tiling | Cylinder / Cannoli |
| Seamless 2D tiling | Torus |
| Gradient that reverses at midpoint | Möbius |
| "See-through" torus / double-cover | Klein |
| Single dominant color anchor | Quadrupole |
| Vortex / converging point in tiling | Horn Torus |

---

## Theoretical Connections

### Quotient topology

A palettope is formally a **quotient space** of the unit square $I^2 = [0,1]^2$. Each edge identification is an equivalence relation on boundary points:

- **Lateral wrap**: $(0, t) \sim (1, t)$ — left and right points at the same height are glued together. This is the standard cylinder/torus construction.
- **Lateral twist**: $(0, t) \sim (1, 1-t)$ — left and right are glued with orientation reversed. This produces Möbius-type identifications.
- **Outward pinch**: all points on an edge collapse to a single point, and that point is identified with the collapsed point on the opposite edge. The edge pair becomes a single pole.
- **Inward pinch**: all points on an edge collapse to a single point, but that point remains distinct from the opposite edge's pole (if any).

The resulting quotient $I^2 / {\sim}$ is a compact topological space whose homeomorphism type is determined entirely by the combination of identifications — this is exactly what the topology key encodes.

### Orbifolds

When edges are **pinched without joining**, the collapsed poles are **cone points** in the intrinsic 2D geometry of the palette surface. This is purely a property of the grid's metric — independent of the 3D mesh visualization, which is just one possible embedding.

At a cone point, the total angle around the point (summing the interior angles of all grid cells converging there) is less than $2\pi$. This is a **2D cone singularity**: the surface is flat everywhere except at the pole, where it behaves like the tip of a cone laid flat. The Ogive, for example, is intrinsically a flat 2D surface with a single cone point — completely flat everywhere else, not a 3D pointed shape (that's just one way to embed it).

The cone angle depends on how much of the boundary converges at the pole:
- A single pinched edge (e.g. one end of an Ogive) produces a cone angle proportional to the fraction of the boundary that collapses there — for a square grid, approximately $\pi$.
- Two adjacent pinched edges sharing a corner (e.g. Lens, Teardrop) collapse to a sharper cone — two boundary segments meet, giving approximately $\pi/2$.
- In the **pinched-joined** state, two poles that would otherwise be distinct are identified into one. The cone angle at that combined pole is the sum of the two individual cone angles — for Cannoli, two $\pi$ cones merge into a $2\pi$ cone, which is intrinsically smooth (a flat point), though the 3D embedding may still look pointed.

Shapes without twisting and with only inward pinches (Rectangle, Ogive, Lens, Canoe, Saucière, Teardrop) are **orbifolds** — spaces locally homeomorphic to $\mathbb{R}^2$ everywhere except at finitely many cone points, where they are locally homeomorphic to $\mathbb{R}^2 / \mathbb{Z}_n$ for some $n$.

Note: once 3 or more edges are pinched, corner adjacency forces all doubly-pinched axes to `pinched-joined`, so the states `pinched:pinched` and `half-pinched:pinched` are not independently reachable — they always resolve to `pinched-joined:pinched-joined` and `half-pinched:pinched-joined` respectively.

### Non-orientable surfaces

Lateral **twist** identifications produce **non-orientable** surfaces — those without a consistent notion of "inside" and "outside":

- **Möbius** (`twisted:open`): the simplest non-orientable surface, a band with one half-twist. It has one boundary edge.
- **Klein** (`twisted:wrapped`): a closed non-orientable surface, the canonical Klein bottle. No boundary, Euler characteristic 0.
- **Boy's Surface** (`twisted:twisted`): a non-orientable closed surface (a quotient of the real projective plane $\mathbb{RP}^2$) that cannot be embedded in $\mathbb{R}^3$ without self-intersection.
- **Cross-cap** (`twisted:pinched-joined`): another immersion of $\mathbb{RP}^2$, obtained by identifying antipodal boundary points of a disk.
- **Nautilus** (`twisted:half-pinched`): a non-orientable surface with one boundary circle (the free edge) and one cone point (the pinched pole). Note: `twisted:pinched` is not independently reachable — the twist identification forces opposite pinched edges to join, collapsing it to `twisted:pinched-joined` (Cross-cap).

### Classification of surfaces

The compact surfaces without boundary that appear in the catalogue correspond exactly to the classical classification theorem:

| Orientable ($g$ = genus) | Non-orientable ($k$ = crosscap number) |
|--------------------------|----------------------------------------|
| Sphere ($g=0$, $\chi=2$) | $\mathbb{RP}^2$ ($k=1$, $\chi=1$) — Cross-cap, Boy's Surface |
| Torus ($g=1$, $\chi=0$)  | Klein bottle ($k=2$, $\chi=0$) |

Note: Boy's Surface and the Cross-cap are both immersions of the same topological space ($\mathbb{RP}^2$, $k=1$) into $\mathbb{R}^3$ — they differ in how they self-intersect, not in their intrinsic topology. The Klein bottle shares Euler characteristic with the torus but is non-orientable with crosscap number 2.

Surfaces with boundary (Cylinder, Möbius, Cannoli, Nautilus, etc.) correspond to compact surfaces with one or more boundary circles.

### Corner adjacency as a topological constraint

The forced-join rule for 3+ pinched edges is not merely a UI convenience — it reflects a genuine topological necessity. If three edges meeting at a corner are all pinched, the corner point is shared by all three collapsed poles simultaneously. Two poles sharing a point are, by definition, the same point in the quotient space. The identification is forced by the topology of the construction, not by user choice.

---

## Implementation Notes

- Arrow state is stored as `Arrows { top, bottom, left, right }` where each is `'up' | 'down' | 'left' | 'right' | 'none'`.
- Each edge has a circular hotspot at its midpoint; click to clear, click-drag to set. A global `pointermove`/`pointerup` listener handles release outside the element.
- During drag, `setArrow` is called speculatively to compute `previewArrows`, shown as ghost glyphs on non-dragged hotspots.
- Forced-join axes display ↕ (V axis) or ↔ (H axis) instead of the arrow glyph.
- `EdgeConfig` is derived from arrows via `arrowsToCfg()` and drives the SOM distance metric (`gridDistance`) and 3D mesh builder.
- Mesh builders are keyed by topology string in `TOPOLOGY_MESH_BUILDERS`.
- The SOM distance metric generates image positions for wrapped/twisted axes and through-pole paths for pinched ones.
