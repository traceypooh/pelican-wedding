#!/usr/bin/env -S deno run --allow-read --allow-write --allow-run

/*
  build-index -- turns the AVIF preview tree into a single static index.html.

  The tree mirrors the `pelican-wedding` archive.org item exactly: same directories,
  same filenames, only the extension swapped for .avif.  That one-to-one naming is
  what lets every preview link back to its own original without a lookup table of
  hand-maintained pairs -- `originals.json` just records which extension each
  stem actually had on the item (.JPG, .jpg, .heic, .heic.jpg).

  Ordering is one merged timeline across all six cameras, which is the whole point:
  the day reads as a story rather than as six separate rolls.  Getting there needs
  the clock corrections worked out during triage (see clocks.json):

    - `wed` is the reference -- the paid photographer, the only trustworthy clock.
    - `wed-nikon`, `wed-mom` and `wed-bokeh` were each merely set wrong, so one
      offset per camera fixes the whole roll.  wed-mom's was exactly three hours:
      she flew in and her camera was still on Eastern time.
    - `wed-canon` had a dead coin cell and reset on nearly every power-on, so its
      stamps are worthless in absolute terms and over any long interval.  But within
      a single power-on the clock ran normally, so each burst's internal timing is
      exact -- see clock.js, which keeps those durations and puts all the unknown
      time into the gaps between bursts.
    - the three selfies carry no EXIF at all and are placed outright.

  Times are naive wall-clock seconds -- EXIF parsed as though it were UTC -- exactly
  as poohbot's bin/photo-index.js does it.  Every camera was in the same room, so
  only their relative order matters, and a real zone would just add a conversion to
  get wrong.

  HTML is emitted statically rather than rendered from JSON at runtime, for three
  reasons: it works with JS off, the og:image is in the markup where scrapers can
  see it, and zip-on-the-fly.js scans the DOM for <a><img></a> pairs at load time --
  it would race a client-side render.

  Usage:
    build-index.js                # build from ./  (the repo itself)
    build-index.js --src DIR      # build from an AVIF tree somewhere else
    build-index.js --out FILE     # write somewhere other than ./index.html
*/

const REPO = new URL('.', import.meta.url).pathname.replace(/\/$/, '')
const arg = (name, fallback) => {
  const i = Deno.args.indexOf(name)
  return i === -1 ? fallback : (Deno.args[i + 1] ?? fallback)
}
const SRC = arg('--src', REPO).replace(/\/$/, '')
const OUT = arg('--out', `${REPO}/index.html`)

const ITEM = 'pelican-wedding'
const SERVE = `https://archive.org/serve/${ITEM}`
const DIRS = ['wed', 'wed-bokeh', 'wed-canon', 'wed-misc', 'wed-mom', 'wed-nikon']
const EXIF_BATCH = 200

const clocks = JSON.parse(Deno.readTextFileSync(`${REPO}/clocks.json`))
const originals = JSON.parse(Deno.readTextFileSync(`${REPO}/originals.json`))


// ------------------------------------------------------------------- utilities

/** @param {string[]} cmd */
async function run(cmd) {
  const p = new Deno.Command(cmd[0], {
    args: cmd.slice(1),
    stdout: 'piped',
    stderr: 'piped',
  })
  const { success, stdout, stderr } = await p.output()
  return {
    ok: success,
    out: new TextDecoder().decode(stdout),
    err: new TextDecoder().decode(stderr),
  }
}

const esc = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')

/**
 * EXIF stamps local wall-clock with no zone, so parse as naive seconds.
 * @param {string|undefined} s eg. '2026:08:08 21:19:33'
 * @returns {number|null}
 */
function parse_exif_time(s) {
  const m = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(s ?? '')
  if (!m)
    return null
  const [, y, mo, d, h, mi, sec] = m.map(Number)
  return Date.UTC(y, mo - 1, d, h, mi, sec) / 1000
}

/**
 * The camera's frame counter.  Take the FIRST run of three or more digits, not the
 * last: a re-edited file can carry extra numbers afterwards, and
 * "IMG_2186-87-mashup-t-h-colorcorrect" then reads as frame 87 rather than 2186 --
 * which would sort it to the very front of its roll.
 */
function seq_of(file) {
  const stem = file.replace(/\.[^.]+$/, '')
  const m = /\d{3,}/.exec(stem) ?? /(\d+)(?!.*\d)/.exec(stem)
  return m ? Number(m[0]) : null
}

/** Naive-UTC seconds -> 'Sat 5:30pm'; the whole event is one weekend. */
function clock_label(t) {
  if (t === null)
    return ''
  const d = new Date(t * 1000)
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getUTCDay()]
  let h = d.getUTCHours()
  const ampm = h >= 12 ? 'pm' : 'am'
  h = h % 12 || 12
  return `${day} ${h}:${String(d.getUTCMinutes()).padStart(2, '0')}${ampm}`
}


// ------------------------------------------------------------------- the tree

/** @returns {{dir: string, file: string, stem: string, path: string}[]} */
function collect() {
  const out = []
  for (const dir of DIRS) {
    let entries
    try {
      entries = [...Deno.readDirSync(`${SRC}/${dir}`)]
    } catch {
      continue // a partial tree is fine -- useful for previewing a subset
    }
    for (const e of entries) {
      if (!e.isFile || !e.name.endsWith('.avif'))
        continue
      out.push({
        dir,
        file: e.name,
        stem: `${dir}/${e.name.replace(/\.avif$/, '')}`,
        path: `${SRC}/${dir}/${e.name}`,
      })
    }
  }
  return out
}

/**
 * One exiftool call per 200 files: spawning it 500 times costs about a minute of
 * pure process startup, and it batches natively.
 */
async function read_exif(items) {
  const by_path = new Map()
  for (let i = 0; i < items.length; i += EXIF_BATCH) {
    const batch = items.slice(i, i + EXIF_BATCH)
    const { out, err } = await run([
      'exiftool', '-json', '-q', '-m', '-n',
      '-DateTimeOriginal', '-Model', '-ImageWidth', '-ImageHeight',
      ...batch.map((b) => b.path),
    ])
    if (!out.trim())
      throw new Error(`exiftool produced nothing: ${err.slice(0, 300)}`)
    for (const rec of JSON.parse(out))
      by_path.set(rec.SourceFile, rec)
  }
  return by_path
}


// Placement lives in clock.js because align.html inlines that same source.  If the
// two drifted, the alignment tool would be showing a timeline the gallery never
// produces -- which is the one bug that would waste a whole afternoon's judgement.
import { place_all } from './clock.js'


// ------------------------------------------------------------------ rendering

function figure(p) {
  const orig = originals[p.stem]
  const href = orig ? `${SERVE}/${orig}` : null
  const who = clocks.photographers[p.dir]?.who ?? p.dir
  const when = clock_label(p.time)
  // Only the reference camera's clock was ever trustworthy.  Every other time on the
  // page is derived -- a flat offset, an interpolation between hand anchors, or a
  // placement made up outright -- and once all six rolls are interleaved those
  // derivations are what put a frame in the wrong part of the evening.  Marking them
  // is the honest thing: a reader can see which times to argue with.
  const estimated = p.dir !== clocks.reference_dir
  // The tilde is punctuation a screen reader would either skip or read as "tilde",
  // so the alt text says it in words instead.
  const alt = `Wedding photo by ${who}${when ? `, ${estimated ? 'about ' : ''}${when}` : ''}`
  const img = `<img src="${esc(p.stem)}.avif" width="${p.width}" height="${p.height}"`
    + ` alt="${esc(alt)}" loading="lazy" decoding="async">`

  return `<figure class="shot">`
    + (href ? `<a href="${esc(href)}" title="full-size original (${esc(orig.split('/').pop())})">${img}</a>` : img)
    + `<figcaption><span class="who">${esc(who)}</span>`
    + (when
      ? `<span class="when"${estimated ? ' title="estimated -- this camera\'s clock was not reliable"' : ''}>`
        + `${estimated ? '~' : ''}${esc(when)}</span>`
      : '')
    + `</figcaption></figure>`
}

function page(photos, stats) {
  const og = 'og.jpg'
  const title = 'Pelican Inn Wedding'
  const desc = `${photos.length} photographs from our wedding at the Pelican Inn, `
    + `Muir Beach -- August 8, 2026.  Click any frame for the full-size original.`

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">

<!-- Keep this out of search results.  This meta tag, not robots.txt, is what does
     the work here: robots.txt is only read at the ORIGIN root, so for a project page
     under traceypooh.github.io/ it is the user site's file that applies, not this
     repo's.  noindex also does strictly more than a Disallow would -- a disallowed
     URL can still be indexed from an inbound link, whereas noindex drops it. -->
<meta name="robots" content="noindex, nofollow, noarchive, noimageindex">

<meta property="og:type" content="website">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:image" content="https://traceypooh.github.io/${ITEM}/${og}">
<meta name="twitter:card" content="summary_large_image">

<link rel="icon" href="data:,">
<style>
:root {
  --bg: #fbfaf8; --fg: #1b1a18; --dim: #6d6862; --line: #e2ddd6;
  --bar: #fffefc; --accent: #4CAF50;
  --gap: 14px; --col: 500px;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --bg: #14130f; --fg: #ece8e1; --dim: #9a938a; --line: #2f2c27; --bar: #1b1a16;
  }
}
:root[data-theme="dark"] {
  --bg: #14130f; --fg: #ece8e1; --dim: #9a938a; --line: #2f2c27; --bar: #1b1a16;
}
* { box-sizing: border-box }
body {
  background: var(--bg); color: var(--fg); margin: 0;
  font: 16px/1.5 ui-sans-serif, system-ui, -apple-system, "Helvetica Neue", sans-serif;
  -webkit-text-size-adjust: 100%;
}
a { color: inherit }

/* ---- header.  #site-nav is what zip-on-the-fly.js looks for to hang its button on */
header {
  position: sticky; top: 0; z-index: 10; background: var(--bar);
  border-bottom: 1px solid var(--line); padding: 10px 16px;
  display: flex; flex-wrap: wrap; align-items: center; gap: 10px 18px;
}
h1 { font-size: 17px; font-weight: 600; margin: 0; letter-spacing: .01em }
h1 small { color: var(--dim); font-weight: 400; margin-left: .5em; font-size: 13px }
#site-nav { margin-left: auto; display: flex; align-items: center; gap: 6px }

.cols { display: flex; gap: 2px; background: var(--line); border-radius: 7px; padding: 2px }
.cols button {
  font: inherit; font-size: 13px; line-height: 1; color: var(--dim);
  background: none; border: 0; border-radius: 5px; padding: 6px 11px; cursor: pointer;
}
.cols button[aria-pressed="true"] { background: var(--bar); color: var(--fg); font-weight: 600 }

/* zip-on-the-fly.js renders <i class="fas fa-download">, which is a Font Awesome
   glyph this repo does not load -- 70KB of webfont for one icon.  Draw it instead. */
.zotf-toggle { color: var(--fg); text-decoration: none }
.zotf-toggle .fa-download::before { content: "\\2193"; font-style: normal; font-size: 20px }
.zotf-toggle.zotf-armed { color: var(--accent) }
/* Below 425px ZOTF hides its icon and shows a text link inside #site-nav-menu
   instead -- that is the Hugo theme's mobile flyout, which this page has no
   equivalent of, so the button would simply vanish on a phone.  Keep the icon at
   every width and drop the flyout link.  !important is needed because ZOTF injects
   its stylesheet at runtime, landing after this one. */
#site-nav > .zotf-toggle { display: block !important }
#site-nav-menu { display: none }

/* ---- the grid */
.grid {
  display: grid; gap: var(--gap); padding: var(--gap);
  grid-template-columns: repeat(auto-fill, minmax(min(100%, var(--col)), 1fr));
  align-items: start;
}
body[data-cols="1"] .grid { grid-template-columns: 1fr }
body[data-cols="2"] .grid { grid-template-columns: repeat(2, 1fr) }
body[data-cols="3"] .grid { grid-template-columns: repeat(3, 1fr) }

.shot { margin: 0; position: relative }
.shot img {
  display: block; width: 100%; height: auto; border-radius: 5px;
  background: var(--line);  /* holds the reserved box while it loads */
}
.shot figcaption {
  display: flex; justify-content: space-between; gap: 8px;
  font-size: 11.5px; color: var(--dim); padding: 4px 2px 0;
}
.who { overflow: hidden; text-overflow: ellipsis; white-space: nowrap }
.when { flex: none; font-variant-numeric: tabular-nums }

footer { color: var(--dim); font-size: 13px; padding: 26px 16px 50px; text-align: center }
footer a { color: var(--accent) }

@media (max-width: 600px) {
  :root { --gap: 8px }
  h1 small { display: none }
}
</style>
</head>
<body>

<header>
  <h1>${esc(title)} <small>${photos.length} photos &middot; Muir Beach &middot; 8 Aug 2026</small></h1>
  <div class="cols" role="group" aria-label="Columns">
    <button data-cols="auto" aria-pressed="true">Auto</button>
    <button data-cols="1" aria-pressed="false">1</button>
    <button data-cols="2" aria-pressed="false">2</button>
    <button data-cols="3" aria-pressed="false">3</button>
  </div>
  <!-- zip-on-the-fly.js mounts itself here: an icon directly in #site-nav for
       desktop, and a text link inside #site-nav-menu that its own CSS reveals only
       below 425px.  Both must exist and be visible, or the button vanishes on
       phones -- which is where "download the lot" is most likely to be wanted. -->
  <nav id="site-nav"><span id="site-nav-menu"></span></nav>
</header>

<main class="grid">
${photos.map(figure).join('\n')}
</main>

<footer>
<p>Every frame links to its full-size original on
<a href="https://archive.org/details/${ITEM}">archive.org</a>.
Use the <strong>&darr;</strong> button above to pick several and download them as one zip.</p>
<p><strong>~</strong> before a time means it is estimated. Only
${esc(clocks.photographers[clocks.reference_dir]?.who ?? clocks.reference_dir)}&rsquo;s
camera kept reliable time; the others are placed by a measured offset, or&mdash;where
the clock was beyond saving&mdash;by hand.</p>
<p>${esc(stats)}</p>
</footer>

<script>
// Column override.  Persisted per-viewer, and wrapped because localStorage throws
// outright in a private window rather than just coming back empty.
{
  const KEY = 'pw-cols'
  const buttons = [...document.querySelectorAll('.cols button')]
  const apply = (v) => {
    if (v === 'auto') document.body.removeAttribute('data-cols')
    else document.body.dataset.cols = v
    for (const b of buttons) b.setAttribute('aria-pressed', String(b.dataset.cols === v))
  }
  let saved = 'auto'
  try { saved = localStorage.getItem(KEY) || 'auto' } catch { /* private window */ }
  apply(saved)
  for (const b of buttons) {
    b.addEventListener('click', () => {
      apply(b.dataset.cols)
      try { localStorage.setItem(KEY, b.dataset.cols) } catch { /* ignore */ }
    })
  }
}
</script>
<script type="module" src="zip-on-the-fly.js"></script>

</body>
</html>
`
}


// ----------------------------------------------------------------------- main

const found = collect()
if (!found.length) {
  console.error(`no .avif found under ${SRC}/{${DIRS.join(',')}}`)
  console.error('generate them first -- see README.md')
  Deno.exit(1)
}
console.error(`reading exif from ${found.length} previews ...`)
const exif = await read_exif(found)

const photos = found.map((p) => {
  const e = exif.get(p.path) ?? {}
  return {
    ...p,
    seq: seq_of(p.file),
    exif_time: parse_exif_time(e.DateTimeOriginal),
    width: e.ImageWidth ?? null,
    height: e.ImageHeight ?? null,
  }
})
const placed = place_all(
  photos.map((p) => ({ stem: p.stem, dir: p.dir, seq: p.seq, exif: p.exif_time })),
  {
    offsets: clocks.offsets,
    anchors: clocks.anchors,
    times: clocks.times,
    broken: clocks.broken_clocks,
  },
)
for (const p of photos)
  p.time = placed.get(p.stem) ?? null

// Unsized images defeat the whole point of lazy loading: without width/height the
// box collapses to zero and the page jumps as each one lands.  Better to fail loudly.
const unsized = photos.filter((p) => !p.width || !p.height)
if (unsized.length) {
  console.error(`${unsized.length} preview(s) have no readable dimensions:`)
  for (const p of unsized.slice(0, 10)) console.error(`  ${p.stem}.avif`)
  Deno.exit(1)
}

const unlinked = photos.filter((p) => !originals[p.stem])
const unplaced = photos.filter((p) => p.time === null)

// Unplaced frames sort last rather than being guessed into the middle of the evening.
photos.sort((a, b) => {
  if (a.time === null && b.time === null) return a.stem < b.stem ? -1 : 1
  if (a.time === null) return 1
  if (b.time === null) return -1
  return a.time - b.time || (a.stem < b.stem ? -1 : 1)
})

const by_dir = {}
for (const p of photos) by_dir[p.dir] = (by_dir[p.dir] ?? 0) + 1
// by_dir is built by walking the photos in time order, so its keys come out in
// whatever order the evening happened to start each camera -- which reads as random.
// Biggest contributor first is the order a credit list wants.
const ranked = Object.entries(by_dir).sort((a, b) => b[1] - a[1])
const stats = ranked
  .map(([d, n]) => `${clocks.photographers[d]?.who ?? d}: ${n}`).join(' · ')

Deno.writeTextFileSync(OUT, page(photos, stats))

console.error(`\nwrote ${OUT}`)
console.error(`  ${photos.length} photos`)
for (const [d, n] of ranked)
  console.error(`    ${d.padEnd(11)} ${String(n).padStart(4)}  ${clocks.photographers[d]?.who ?? ''}`)
if (unlinked.length) {
  console.error(`\n  WARNING: ${unlinked.length} preview(s) have no original on the item`)
  for (const p of unlinked.slice(0, 10)) console.error(`    ${p.stem}.avif`)
}
if (unplaced.length) {
  console.error(`\n  ${unplaced.length} frame(s) could not be placed in time (sorted last):`)
  for (const p of unplaced.slice(0, 10)) console.error(`    ${p.stem}.avif`)
  console.error('    -- add an entry under "times" in clocks.json to place one by hand')
}

// Some sources are themselves low resolution -- most of wed-canon is 720x480 camera
// previews, the real 70D originals never having been recovered.  -long never
// upscales, so these come through at native size and simply render soft once a
// column is wider than they are.  Nothing is broken, but it is worth saying out loud
// at every build, because the fix is external (get the originals) and easy to forget.
const SOFT_BELOW = 1000
const soft = photos.filter((p) => Math.max(p.width, p.height) < SOFT_BELOW)
if (soft.length) {
  const by = {}
  for (const p of soft) by[p.dir] = (by[p.dir] ?? 0) + 1
  console.error(`\n  ${soft.length} preview(s) under ${SOFT_BELOW}px on the long edge`
    + ` -- soft in a wide column:`)
  for (const [d, n] of Object.entries(by))
    console.error(`    ${d.padEnd(11)} ${String(n).padStart(4)} of ${by_dir[d]}`)
  console.error('    -- the sources are that size; re-run make-thumbs after replacing them')
}
