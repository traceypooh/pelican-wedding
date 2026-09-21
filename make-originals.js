#!/usr/bin/env -S deno run --allow-net --allow-read --allow-write

/*
  make-originals -- regenerate originals.json from the archive.org item.

  originals.json maps each preview's stem to the exact filename its original has on
  the item.  It exists because the extension is the one thing the mirrored naming
  cannot carry: previews are all `.avif`, while the originals are variously `.JPG`,
  `.jpg`, `.heic` and `.heic.jpg`, and the gallery has to link the real one.

  Re-run this whenever the item gains or loses files -- adding the rest of the
  photographer's frames, say -- then ./make-thumbs and ./build-index.js.

  Usage:  ./make-originals.js [--item pelican-wedding] [--dry-run]
*/

const REPO = new URL('.', import.meta.url).pathname.replace(/\/$/, '')
const arg = (n, d) => {
  const i = Deno.args.indexOf(n)
  return i === -1 ? d : (Deno.args[i + 1] ?? d)
}
const ITEM = arg('--item', 'pelican-wedding')
const DRY = Deno.args.includes('--dry-run')
const DIRS = ['wed', 'wed-bokeh', 'wed-canon', 'wed-misc', 'wed-mom', 'wed-nikon']

/*
  Two frames exist TWICE on the item: a stale 185KB 720x480 camera preview
  (IMG_6836.JPG) and the 2.5MB real original that replaced it (IMG_6836.heic.jpg).
  Both reduce to the same stem, so one has to be dropped -- and it must be the small
  one, or the gallery links the thumbnail instead of the photograph.
*/
const STALE = new Set(['wed-canon/IMG_6836.JPG', 'wed-canon/IMG_6844.JPG'])

/** Strip EVERY trailing image extension: "IMG_6836.heic.jpg" -> "IMG_6836". */
function stem_of(name) {
  const cut = name.lastIndexOf('/')
  const dir = name.slice(0, cut)
  let base = name.slice(cut + 1)
  while (/\.(jpg|jpeg|heic|heif|png|tiff?|avif|webp)$/i.test(base)) {
    base = base.replace(/\.[^.]+$/, '')
  }
  return `${dir}/${base}`
}

console.error(`fetching archive.org metadata for ${ITEM} ...`)
const res = await fetch(`https://archive.org/metadata/${ITEM}`)
if (!res.ok) {
  console.error(`  metadata fetch failed: ${res.status}`)
  Deno.exit(1)
}
const meta = await res.json()
if (!meta.files?.length) {
  console.error('  item has no files -- wrong identifier?')
  Deno.exit(1)
}

const out = {}
const collisions = []
let skipped_stale = 0
for (const f of meta.files) {
  // derivatives are the archive's own thumbnails and xml, not our photographs
  if (f.source !== 'original' || !f.name.includes('/')) continue
  if (!DIRS.includes(f.name.split('/')[0])) continue
  if (STALE.has(f.name)) {
    skipped_stale++
    continue
  }
  const stem = stem_of(f.name)
  if (out[stem]) collisions.push([stem, out[stem], f.name])
  else out[stem] = f.name
}

// A collision means two originals would claim one preview filename -- the gallery
// would silently link whichever won.  Better to stop and be told.
if (collisions.length) {
  console.error(`\n${collisions.length} filename collision(s) -- refusing to write:`)
  for (const [stem, a, b] of collisions) console.error(`  ${stem}  <-  ${a}  AND  ${b}`)
  console.error('\nAdd the stale one to STALE in this script, or rename it on the item.')
  Deno.exit(1)
}

const sorted = Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : 1)))
const n = Object.keys(sorted).length

let prev = {}
try {
  prev = JSON.parse(Deno.readTextFileSync(`${REPO}/originals.json`))
} catch { /* first run */ }
const added = Object.keys(sorted).filter((k) => !(k in prev))
const gone = Object.keys(prev).filter((k) => !(k in sorted))

console.error(`\n  ${n} originals across ${DIRS.length} directories`)
if (skipped_stale) console.error(`  ${skipped_stale} stale duplicate(s) skipped`)
if (added.length) {
  console.error(`  +${added.length} new:`)
  for (const k of added.slice(0, 12)) console.error(`      ${k}`)
  if (added.length > 12) console.error(`      ... and ${added.length - 12} more`)
}
if (gone.length) {
  console.error(`  -${gone.length} no longer on the item:`)
  for (const k of gone.slice(0, 12)) console.error(`      ${k}`)
}
if (!added.length && !gone.length) console.error('  no change')

if (DRY) {
  console.error('\n--dry-run: nothing written')
} else {
  Deno.writeTextFileSync(`${REPO}/originals.json`, JSON.stringify(sorted, null, 0))
  console.error(`\nwrote ${REPO}/originals.json`)
  if (added.length) console.error('next:  ./make-thumbs   then   ./build-index.js')
}
