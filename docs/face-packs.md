# Face packs

A face pack is a portrait, a mouth-shape library, an eye library and some idle clips. The
bundled one (`assets/emma`) is ready to use. This document is for building your own — and
for the measurements behind each decision, because most of them are counter-intuitive and
were arrived at by getting them wrong first.

```
assets/<name>/
  base.png              the portrait, mouth closed, front on, flat lighting
  mouth-sprites/        8 RGBA tiles, feathered
  mouth-sprites.json    tile placement + shape coordinates + build stamp
  eyes/  eyes.json      3 tiles for blinking
  clips/                idle.mp4, thinking.mp4, … looped while quiet
```

## The portrait

Three prompt elements matter more than the rest:

- **lips gently closed** — the resting pose is the origin of the whole mouth sequence
- **soft even studio light, no harsh shadows** — the flatter the light, the less any sprite
  seam shows
- **symmetrical front view** — the squarer the head, the less the variants appear to shift

## Mouth shapes

Eight, spanning three axes: closed → open, spread, rounded. Rhubarb Lip Sync uses six to
nine and Preston Blair's classic set has ten, so eight is unremarkable — the count is not
what makes it work.

### Generate from a head crop, not from the portrait

Image-editing models redraw the whole picture. That is the premise, not a bug to route
around; what you can control is *how far* they drift, and it depends on how much of the
frame the face occupies.

Measured on the seam ring — the band where the sprite feathers into the base image — same
prompts, same seed:

| generated from | face size (eye distance) | seam ring difference |
|---|---|---|
| full-body portrait, 832×1216 | 105px | **20.50** |
| head crop scaled to 1024², matching a known-good pack | 169px | **5.20** |

Nearly a factor of four, purely from framing. So: crop a square around the head, scale it to
1024, generate there, then carry back **only the difference** (`edit − input`) onto the
untouched portrait. That keeps everything outside the mask bit-identical to the base —
verified at 0.0000 — which matters because frames swap at 30fps and any drift outside the
mouth reads as the whole face shimmering.

Two repairs that do *not* work, in case they look tempting: global ECC alignment of the edit
onto the base improved the seam by 2–11%, and avoiding the model's resolution snapping
improved it by 13%. Neither is close.

### The region has to include the jaw

Span the whole lower face — nose base to below the chin, about a jaw's width across
(measured as 1.12 × 0.88 eye-distances). An earlier build shrank this to the lips alone and
the result was a gaping mouth pasted onto a rigid face: the model's edits *do* drop the jaw,
lengthen the chin and lift the cheeks, and cropping to the lips throws all of that away.

The feather must ramp **inward**, so that the stated radius is where the base takes over
completely. Ramping outward pushes the region past its own declared size, and the sprite
cutter reads those same numbers — it will cut in the wrong place.

### Describe restraint, not shape

The model will always take the most extreme reading available.

> "lips stretched horizontally into a wide flat shape, corners pulled sideways"

produced a grin spanning half the face, which the runtime then picked for 20% of frames. The
prompt that works says what *not* to do:

> "spread just slightly wider than at rest … subtle and natural — her mouth stays the same
> width as normal, this is not a grin, not a smile, and the lip corners are not pulled
> outward"

### The closed shape is not the portrait

Tempting, since the portrait already has her mouth shut — but portraits usually smile, and
during speech the mouth closes constantly (measured at 24% of frames). A resting smile
flashing on and off between syllables reads as an expression, not as speech. Generate a
separate neutral closed mouth: level corners, no upward curve.

The portrait's own smile is not lost; it is what shows while she is quiet, when the video
layer is on screen.

### Shapes to leave out

A shouted "ah" measured 20.94 on the seam ring against 2.41–8.55 for everything else: the
jaw travels far enough that the model reworks the entire chin. It is also unreachable,
because the runtime caps openness well below it. Generate it if you like, but do not ship
it — it can only contribute its seam.

## Compositing, at runtime

Paint the nearest sprite **solid**, then fade the runner-up over it.

Painting both at partial alpha is the obvious reading of a two-frame blend and it is wrong:
neither fully covers, so the base portrait shows through both — and the base has her mouth
closed. The result is an open mouth with a closed one ghosting underneath. Barely visible
when the sprite is just the lips; unmissable once it spans the jaw.

## Reshaping the openness curve

Viseme models normalise against the loudest frame of their calibration clip, which puts
ordinary speech near the top of the scale. Measured over a real reply:

| | p25 | median | p95 | max |
|---|---|---|---|---|
| raw from the model | 0.39 | 0.66 | 0.95 | 1.00 |
| after gamma 2.0, gain 0.55 | 0.10 | 0.23 | 0.43 | 0.55 |

Fed in raw, the widest shapes dominate and the mouth hangs open between words — which reads
as overacting on a head that is otherwise still. Two knobs rather than one, because the ends
need opposite treatment: the gamma expands the bottom so gaps between syllables actually
close, the gain caps the top.

## Idle clips

Short loops of the same face doing nothing in particular. They carry the blinks, breath and
micro-expression that a 2D transform cannot fake.

Prepare them by cropping any letterboxing and playing forward-then-reversed, which makes the
loop seam exact by construction. Generate them with the portrait as the first frame if the
model allows it: that makes frame 0 nearly identical to the canvas at rest, so the handover
back from speech barely needs covering.

Head pose in generated clips wanders — measured at 13–19% in scale across a single take,
2–4% in position, up to 30° of total roll range. That is why the runtime blurs through the
layer swap rather than dissolving: at the worst frame and a 50/50 mix, the two heads are
plainly visible at once. 9px of blur is where the ghost stops resolving; 6px does not.

An attempt to fix this properly — stabilising every frame onto the base pose — made things
worse (mean difference to base went from 7.57 to 13.24), because a head is not rigidly
attached to a frame: aligning the face throws the body and background out, and they cover
more of the picture.

## Cache the pack by version, not by filename

Rebuilds keep their filenames while tiles change size and content. A stale tile drawn into a
fresh placement box does not look like a caching problem — it looks like a broken composite,
half-transparent with seams, and it will cost you an afternoon. Every manifest carries a
build stamp and the runtime appends it to every asset URL.
