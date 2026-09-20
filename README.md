# pelican-wedding

Preview gallery for the 501 photographs from our wedding at the
[Pelican Inn](https://www.pelicaninn.com/), Muir Beach — 8 August 2026.

- **Gallery:** https://traceypooh.github.io/pelican-wedding/
- **Full-size originals:** https://archive.org/details/pelican-wedding

This repo holds only the AVIF previews. Every frame links to its own full-size
original on archive.org, and the download button zips a selection straight to disk.


## Layout

Everything that isn't a photograph sits at the top level, so the repo is six
directories of imagery plus a short list of files:

```
make-thumbs         originals -> AVIF previews
build-index.js      AVIF previews -> index.html
clocks.json         clock corrections, so the timeline is one merged story
originals.json      501 stems -> the exact filename each has on archive.org
zip-on-the-fly.js   the pick-and-zip download button
index.html          generated -- do not hand-edit
og.jpg              generated -- the social-preview image
```

The imagery mirrors the archive.org item exactly — same directories, same
filenames, only the extension swapped for `.avif`:

```
wed/         116   Reenie Raschke — paid professional, Nikon Z 7_2 + D7500
wed-bokeh/    39   Russ — brother, pro A/V; Russian swirly-bokeh lens, Canon 5D II
wed-canon/   161   Tara / Jannah — Canon 70D, shared between the twin sisters
wed-misc/      5   friends on phones + three selfies
wed-mom/      75   Mom — Nikon D3500
wed-nikon/   105   Russ Nikon — Nikon D5200, Russ's second body
             ---
             501
```

That one-to-one naming is the whole point: `<dir>/<basename>` is a single key across
the archive.org item, the NAS mirror, the blog post and this repo. It is also what
lets `index.html` link each preview to its original without a hand-maintained table —
`originals.json` only records which extension each stem actually had
(`.JPG`, `.jpg`, `.heic`, `.heic.jpg`).

The item carries 503 originals, not 501. Two `wed-canon` frames exist twice: a stale
185KB 720×480 preview (`IMG_6836.JPG`) and the 2.5MB real original that replaced it
(`IMG_6836.heic.jpg`). Both reduce to the same `.avif`, so `make-thumbs` drops the
stale pair. Do not "fix" this by including them — `avif-blog-img` skips an output
that already exists, and `.JPG` sorts first, so the gallery would quietly fill with
720×480 thumbnails.


## Rebuilding

```sh
./make-thumbs        # NAS mirror -> ./wed*/**.avif + og.jpg   (~130MB at 1200px)
./build-index.js     # the AVIF tree -> index.html
```

`make-thumbs` takes the mirror path as its first argument and honours `LONG=` for the
long edge. Measured on 51 real frames, scaled to 501:

| long edge | avg/file | total |
|---|---|---|
| 800px | 153 KB | ~75 MB |
| **1200px** | **265 KB** | **~130 MB** |
| 2064px | 613 KB | ~301 MB |

1200px is the default because the grid runs 500–600px columns, making 1200 the exact
2× source for a retina display at that width.

Both scripts are re-runnable and skip work already done. That also means a preview is
never regenerated once it exists — **to re-encode a directory, delete it first**:

```sh
rm -rf wed-canon && ./make-thumbs        # e.g. once the real 70D originals turn up
```


### wed-canon is low resolution

161 of the 163 `wed-canon` frames are 720×480 camera previews — the real Canon 70D
originals have not yet been recovered. Only `IMG_6836` and `IMG_6844` are full size.

Nothing is broken by this: `-long` never upscales, so those frames come through at
native 720×480 with correct `width`/`height`, and the layout is exact. They simply
render soft once a column is wider than 720px, which is a third of the gallery.
`build-index.js` prints a count of everything under 1000px on the long edge at each
build, so it stays visible. If the originals ever surface, drop the directory and
re-run — the mirrored naming means nothing else has to change.


## Ordering

One merged timeline across all six cameras, so the day reads as a story rather than
as six separate rolls. Getting there needs the clock corrections worked out during
triage, which live in `clocks.json`:

- `wed` is the reference — the paid photographer, the only trustworthy clock,
  corroborated twice against the event (cake cut ~9:19pm == `DSC_0053` @ 21:19:33).
- `wed-nikon` is a flat −3.816h, from one matched pair.
- `wed-bokeh`, `wed-mom` and `wed-misc` were already correct.
- `wed-canon` had a dead coin cell and reset to the same instant on nearly every
  power-on — 43 times across 161 frames. Its stamps are worthless in absolute terms
  and over any long interval. **But within a single power-on the clock ran
  normally**, so each burst's internal timing is exact. `clock.js` keeps those
  durations and puts all the unknown time into the gaps between bursts.

  The obvious approach — interpolating across the frame counter between anchors —
  looks reasonable and is badly wrong: it spreads every burst evenly over the
  anchors bracketing it, so a 15-frame burst genuinely shot in **619 seconds** came
  out smeared across **4154**. Anchors say *when a burst happened*; they should not
  be deciding how long it took.
- the three selfies carry no EXIF at all and are placed outright, under `times`.

To move a frame, add or edit an entry under `times` in `clocks.json` and re-run
`build-index.js`. Frames that cannot be placed sort last rather than being
guessed into the middle of the evening, and the build prints them.


### Fixing a clock: `make-align.js`

```sh
./make-align.js     # -> align.html (gitignored), then serve the repo and open it
```

Every folder becomes a column on one shared time axis, the reference first, binned
at 15 minutes and 5 minutes across the busy evening. **Drag a photo into the bin
where it really happened.** What that means depends on the camera:

| camera state | a drop does |
|---|---|
| clock merely set wrong | solves for **one offset** and shifts that whole column |
| dead clock (`wed-canon`) | writes an **anchor**; times interpolate between anchors |
| no EXIF (the selfies) | pins **that one frame** |

Dragging individual frames of a working-clock camera is deliberately not offered: the
frame-to-frame spacing on those rolls is already correct and only the whole roll is
displaced, so per-frame placement would throw away good timing and turn three
decisions into three hundred.

This is how `wed-mom` was caught. It read `+0`, but `DSC_0187` sat at 8:17pm showing
guests seated on the lawn for the ceremony while the reference was shooting the
indoor dinner — and `DSC_0138` was stamped Friday 9:23pm in bright daylight, an hour
after sunset. Mom had flown in and her camera was still on Eastern time. One drop,
75 frames corrected.

`Export for clocks.json` prints the JSON to paste back in, then re-run
`build-index.js`.

Times are naive wall-clock seconds — EXIF parsed as though it were UTC — exactly as
poohbot's `bin/photo-index.js` does it. Every camera was in the same room, so only
their relative order matters, and a real zone would just add a conversion to get
wrong.


## The page

`index.html` is generated, not hand-edited. It is emitted statically rather than
rendered from JSON at runtime for three reasons: it works with JS off, the og:image
sits in the markup where scrapers can see it, and `zip-on-the-fly.js` scans the DOM
for `<a><img></a>` pairs at load — it would race a client-side render.

- Responsive CSS grid, ~500px minimum column, with Auto / 1 / 2 / 3 overrides in the
  header. The choice persists in `localStorage`, wrapped in try/catch because it
  throws outright in a private window rather than just coming back empty.
- Every `<img>` carries `loading="lazy"`, `decoding="async"` **and real
  `width`/`height`**. The dimensions are not optional: without them the box collapses
  to zero and the page jumps as each frame lands, which is worse than no lazy loading
  at all. `build-index.js` fails loudly rather than emit an unsized image.
- og:image is JPEG 4:4:4, not AVIF and not webp. Slack renders no AVIF preview at
  all, and lossy webp is mandatorily 4:2:0 8-bit so it cannot carry the 4:4:4 chroma
  the camera sources actually have.


## zip-on-the-fly.js

Copied from [poohbot](https://github.com/traceypooh/poohbot), with one fix that
should be ported back:

> `entry_name()` keeps only the basename, so two cameras both numbering
> `DSC_0145.JPG` collapse to one zip entry. Seven filenames exist in both `wed/` and
> `wed-mom/`, and most unzippers overwrite silently — a 501-file pick would yield
> 494 files with nothing saying so. The fix qualifies **only** the names that
> actually clash (`wed/DSC_0145.JPG`), so an ordinary pick still unzips flat.

It imports lit and client-zip from `esm.ext.archive.org` at runtime. The upstream
copy ships vendored fallbacks under its `js/vendor/`; they are deliberately **not** here,
to keep this repo mostly photographs.

It needs a `#site-nav` element to hang its button on. Below 425px its own CSS hides
that icon in favour of a text link inside `#site-nav-menu` — that is the Hugo theme's
mobile flyout, which this page has no equivalent of, so `index.html` overrides it and
keeps the icon at every width.
