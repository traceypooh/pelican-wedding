#!/usr/bin/env -S deno run --allow-read --allow-write --allow-run

/*
  make-align -- builds align.html, a working tool for fixing the camera clocks.

  Not part of the published gallery (align.html is gitignored).  It exists because
  six cameras disagreed about what time it was, and the only reliable way to settle
  that is to look at what two cameras shot at the same moment.

  Every folder becomes a column on one shared time axis, the reference camera first.
  Bins are 15 minutes, tightening to 5 minutes across the busy evening, because that
  is where a minute actually matters.

  The whole interaction is one gesture -- drag a photo into the bin where it really
  happened -- which means different things depending on what is wrong with that
  camera's clock:

    - working clock (just set wrong): the frame-to-frame spacing is already correct
      and only the whole roll is displaced, so the drop solves for ONE offset and
      shifts every frame in that column by it.  This is how wed-mom's three-hour
      error was found: one frame moved onto the ceremony, and 75 frames followed.

    - dead clock (wed-canon reset on nearly every power-on): no offset can fix a
      camera whose intervals are also meaningless, so the drop records an anchor
      -- "frame N happened at T" -- and times are interpolated between anchors
      across the frame counter.  More anchors, better placement.

    - no EXIF at all (the three selfies): nothing to offset or interpolate, so the
      drop just pins that one frame outright.

  Dragging individual frames of a working-clock camera would throw away timing that
  is already good and turn three decisions into three hundred, so the tool doesn't
  offer it.

  Usage:  ./make-align.js        then open align.html and export into clocks.json
*/

const REPO = new URL('.', import.meta.url).pathname.replace(/\/$/, '')
const DIRS = ['wed', 'wed-bokeh', 'wed-canon', 'wed-misc', 'wed-mom', 'wed-nikon']
const EXIF_BATCH = 200

// Bin sizes.  A wedding is not uniform: the hours around the ceremony and dinner
// hold most of the frames and all of the moments worth lining up, so they get finer
// bins than the long quiet stretches either side.
const COARSE_MIN = 15
const FINE_MIN = 5
const FINE_FROM = 17 // 5pm, local wall clock
const FINE_TO = 22 // 10pm

const clocks = JSON.parse(Deno.readTextFileSync(`${REPO}/clocks.json`))

async function run(cmd) {
  const { success, stdout, stderr } = await new Deno.Command(cmd[0], {
    args: cmd.slice(1), stdout: 'piped', stderr: 'piped',
  }).output()
  return {
    ok: success,
    out: new TextDecoder().decode(stdout),
    err: new TextDecoder().decode(stderr),
  }
}

/**
 * Embed JSON inside a <script> block.  A literal "</script>" anywhere in the data
 * would close the block early and break the page, so escape every "<" as its
 * unicode escape -- which a JSON parser reads back as exactly the same string.
 */
const embed = (o) => JSON.stringify(o).replace(/</g, '\\u003c')

function parse_exif_time(s) {
  const m = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(s ?? '')
  if (!m) return null
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

// ------------------------------------------------------------------ collect

const found = []
for (const dir of DIRS) {
  let entries
  try {
    entries = [...Deno.readDirSync(`${REPO}/${dir}`)]
  } catch {
    continue
  }
  for (const e of entries) {
    if (!e.isFile || !e.name.endsWith('.avif')) continue
    found.push({ dir, file: e.name, path: `${dir}/${e.name}` })
  }
}
if (!found.length) {
  console.error('no previews found -- run ./make-thumbs first')
  Deno.exit(1)
}

console.error(`reading exif from ${found.length} previews ...`)
const exif = new Map()
for (let i = 0; i < found.length; i += EXIF_BATCH) {
  const batch = found.slice(i, i + EXIF_BATCH)
  const { out } = await run([
    'exiftool', '-json', '-q', '-m', '-n', '-DateTimeOriginal',
    ...batch.map((b) => `${REPO}/${b.path}`),
  ])
  for (const rec of JSON.parse(out || '[]')) exif.set(rec.SourceFile, rec)
}

const photos = found.map((p) => ({
  d: p.dir,
  p: p.path,
  s: `${p.dir}/${p.file.replace(/\.avif$/, '')}`,
  e: parse_exif_time(exif.get(`${REPO}/${p.path}`)?.DateTimeOriginal),
  q: seq_of(p.file),
})).sort((a, b) => (a.p < b.p ? -1 : 1))

const n_exif = photos.filter((p) => p.e !== null).length
console.error(`  ${photos.length} previews, ${n_exif} with a capture time`)

// ------------------------------------------------------------------- output

const data = {
  // the untouched file, so Export can hand back a complete clocks.json
  full: clocks,
  ref: clocks.reference_dir,
  broken: clocks.broken_clocks,
  dirs: DIRS.filter((d) => photos.some((p) => p.d === d)),
  who: Object.fromEntries(Object.entries(clocks.photographers).map(([k, v]) => [k, v.who])),
  offsets: clocks.offsets,
  anchors: clocks.anchors,
  times: Object.fromEntries(
    Object.entries(clocks.times).filter(([k]) => !k.startsWith('_')),
  ),
  photos,
  coarse: COARSE_MIN,
  fine: FINE_MIN,
  fine_from: FINE_FROM,
  fine_to: FINE_TO,
}

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>clock alignment</title>
<style>
:root { --bg:#14130f; --fg:#ece8e1; --dim:#9a938a; --line:#2f2c27; --bar:#1b1a16; --accent:#4CAF50; --warn:#e0a03a;
  --percell:2;    /* frames side by side per bin; set live from the header */
  --zoom:1;       /* 2 = crop into the middle at twice the pixel scale */
  --tcol:44px }   /* time gutter: day and time stack, so it stays out of the way */
* { box-sizing: border-box }
body { margin:0; background:var(--bg); color:var(--fg);
  font:13px/1.4 ui-sans-serif, system-ui, -apple-system, sans-serif }

header { position:sticky; top:0; z-index:30; background:var(--bar);
  border-bottom:1px solid var(--line); padding:8px 12px }
h1 { font-size:15px; margin:0 0 8px }
h1 small { color:var(--dim); font-weight:400; margin-left:.6em }

/* Leading --tcol cell matches the table's time gutter, so each card sits directly
   over the column whose offset it controls. */
.cams { display:grid; gap:6px }
.cam { border:1px solid var(--line); border-radius:6px; padding:6px 8px; background:var(--bg) }
.cam.isref { border-color:var(--accent) }
.cam b { display:block; font-size:12px }
.cam .who { color:var(--dim); font-size:11px }
.cam .off { font-variant-numeric:tabular-nums; font-size:12px; margin-top:3px }
.cam .off.changed { color:var(--warn); font-weight:600 }
.cam .btns { display:flex; gap:2px; margin-top:4px; flex-wrap:wrap }
.cam button { font:inherit; font-size:10px; padding:2px 5px; cursor:pointer;
  background:var(--line); color:var(--fg); border:0; border-radius:3px }
.cam button:hover { background:#3d3a33 }
.mode { font-size:10px; color:var(--dim); margin-top:3px }

.tools { display:flex; gap:6px; align-items:center; margin-top:8px; flex-wrap:wrap }
.tools button { font:inherit; font-size:12px; padding:4px 10px; cursor:pointer;
  background:var(--accent); color:#fff; border:0; border-radius:4px }
.tools button.sec { background:var(--line); color:var(--fg) }

table { border-collapse:collapse; width:100%; table-layout:fixed }
/* NOT sticky: <header> is already pinned at top:0, and a second sticky layer just
   slides underneath it.  The camera cards up there are the column labels now --
   they share the grid template below, so each card sits over its own column. */
th { background:var(--bar); font-size:11px; color:var(--dim);
  padding:4px; border-bottom:1px solid var(--line) }
td { border-top:1px solid #201e1a; padding:1px 2px; vertical-align:top }
/* Must match on the <th> too: table-layout:fixed takes every column width from the
   FIRST row, so a rule scoped to td.t alone is read after the widths are decided --
   the gutter then falls back to an equal share and the cards above line up with
   nothing. */
.t { width:var(--tcol); color:var(--dim); font-size:10px; font-variant-numeric:tabular-nums;
  line-height:1.1; text-align:right; padding-right:5px }
.t .d { color:#6d6862 }
tr.fine td.t { color:#c8c0b4 }
tr.hour td { border-top:1px solid var(--line) }
tr.empty td { height:7px }
tr.over td { background:#23301f }

/* A fixed number of frames side by side, so each one is as large as the column
   allows -- widen the window and every thumbnail grows with it. */
.cell { display:grid; grid-template-columns:repeat(var(--percell), 1fr); gap:2px; min-height:7px }
.th { position:relative; width:100%; aspect-ratio:3/2; overflow:hidden;
  border-radius:2px; background:#222; display:block; cursor:grab }
/* object-fit:cover alone barely crops a 3:2 frame into a 3:2 box, so scaling inside
   the clipped box is what actually gets you closer to the faces. */
.th img { width:100%; height:100%; object-fit:cover; display:block;
  transform:scale(var(--zoom)); transform-origin:center }
.th.pin { outline:2px solid var(--warn); outline-offset:-2px }
.th.drag { opacity:.35 }
.th.armed { outline:3px solid var(--accent); outline-offset:-3px }
.armedbar { color:var(--accent); font-weight:600 }

#out { position:fixed; inset:5% 10%; z-index:50; background:var(--bar); border:1px solid var(--line);
  border-radius:8px; padding:14px; display:none; flex-direction:column }
#out.show { display:flex }
#out textarea { flex:1; width:100%; background:var(--bg); color:var(--fg); border:1px solid var(--line);
  border-radius:4px; font:12px ui-monospace, monospace; padding:8px; margin:8px 0 }
</style>
</head>
<body>

<header>
<h1>Clock alignment <small>drag a photo into the bin where it really happened</small></h1>
<div class="cams" id="cams"></div>
<div class="tools">
  <button id="export">Export for clocks.json</button>
  <button class="sec" id="resetall">Reset all</button>
  <span style="color:var(--dim)">per bin:</span>
  <button class="sec sz" data-percell="1">1</button>
  <button class="sec sz" data-percell="2">2</button>
  <button class="sec sz" data-percell="3">3</button>
  <button class="sec sz" data-percell="4">4</button>
  <button class="sec" id="zoom">crop 1&times;</button>
  <span style="color:var(--dim)" id="status"></span>
</div>
</header>

<table id="grid"><thead><tr id="head"></tr></thead><tbody id="body"></tbody></table>

<div id="out">
  <b>This is the complete clocks.json &mdash; save it over the file</b>
  <textarea id="outtext" spellcheck="false"></textarea>
  <div class="tools">
    <button id="copy">Copy</button>
    <button class="sec" id="close">Close</button>
  </div>
</div>

<script>
/* ---- clock.js, inlined verbatim (minus its export keywords) ---- */
${Deno.readTextFileSync(`${REPO}/clock.js`).replace(/^export /gm, '')}
/* ---- end clock.js ---- */

const D = ${embed(data)}

// live, editable state -- deep-copied so "Reset all" has something to go back to
const START = {
  offsets: structuredClone(D.offsets),
  anchors: structuredClone(D.anchors),
  times: structuredClone(D.times),
}
let offsets = structuredClone(D.offsets)
let anchors = structuredClone(D.anchors)
let times = structuredClone(D.times)

/*
  Work in progress survives a reload.

  Without this the page is a scratchpad that silently empties itself: aligning six
  cameras is not one sitting, and losing an afternoon's judgement to an accidental
  refresh is the kind of thing that stops you trying again.  "Reset all" clears the
  saved copy too, so going back to clocks.json never means clearing site data by
  hand.  localStorage throws outright in a private window rather than just coming
  back empty, hence the try/catch on both sides.
*/
const LSKEY = 'align-state'
function save() {
  try {
    localStorage.setItem(LSKEY, JSON.stringify({ offsets, anchors, times }))
  } catch { /* private window */ }
}
try {
  const s = JSON.parse(localStorage.getItem(LSKEY) || 'null')
  if (s) {
    offsets = s.offsets ?? offsets
    anchors = s.anchors ?? anchors
    times = s.times ?? times
  }
} catch { /* private window, or a saved copy from an older shape */ }

const isBroken = (d) => D.broken.includes(d)
const hasExif = (p) => p.e !== null

/* Placement comes from clock.js, inlined verbatim above -- the same code
   build-index.js imports, so the tool and the gallery cannot disagree. */
let PLACED = new Map()
function recompute() {
  PLACED = place_all(
    D.photos.map((p) => ({ stem: p.s, dir: p.d, seq: p.q, exif: p.e })),
    { offsets, anchors, times, broken: D.broken },
  )
}
function placed(p) {
  const t = PLACED.get(p.s)
  return t === undefined ? null : t
}

const pad = (n) => String(n).padStart(2, '0')
const DAY = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat']
function fmt(t) {
  const d = new Date(t * 1000)
  const h = d.getUTCHours()
  return DAY[d.getUTCDay()] + ' ' + (h % 12 || 12) + ':' + pad(d.getUTCMinutes())
    + (h >= 12 ? 'pm' : 'am')
}

/** Same instant for the gutter: day over time, so the column can stay ~44px wide. */
function fmtCell(t) {
  const d = new Date(t * 1000)
  const h = d.getUTCHours()
  return '<span class="d">' + DAY[d.getUTCDay()] + '</span><br>'
    + (h % 12 || 12) + ':' + pad(d.getUTCMinutes()) + (h >= 12 ? 'p' : 'a')
}
function dur(s) {
  const sign = s < 0 ? '-' : '+'
  s = Math.abs(Math.round(s))
  return sign + Math.floor(s / 3600) + 'h ' + pad(Math.floor(s % 3600 / 60)) + 'm ' + pad(s % 60) + 's'
}

// ---- bins.  Absolute wall clock, so they do NOT move when an offset changes.
let BINS = []
function buildBins() {
  recompute()
  const ts = D.photos.map(placed).filter((t) => t !== null)
  // Padded generously: a column can be dragged hours from where it sits now, and a
  // frame that lands outside every bin would simply vanish from the grid.
  const lo = Math.floor((Math.min(...ts) - 6 * 3600) / 3600) * 3600
  const hi = Math.ceil((Math.max(...ts) + 6 * 3600) / 3600) * 3600
  BINS = []
  for (let t = lo; t < hi;) {
    const h = new Date(t * 1000).getUTCHours()
    const fine = h >= D.fine_from && h < D.fine_to
    const len = (fine ? D.fine : D.coarse) * 60
    BINS.push({ t, len, fine })
    t += len
  }
}

function binIndex(t) {
  let lo = 0, hi = BINS.length - 1, best = 0
  while (lo <= hi) {
    const m = (lo + hi) >> 1
    if (BINS[m].t <= t) { best = m; lo = m + 1 } else hi = m - 1
  }
  return best
}

// ---- render
function renderCams() {
  document.getElementById('cams').style.gridTemplateColumns =
    'var(--tcol) repeat(' + D.dirs.length + ', 1fr)'
  document.getElementById('cams').innerHTML = '<div class="gut"></div>' + D.dirs.map((d) => {
    const ref = d === D.ref
    const mode = ref ? 'reference &mdash; never moves'
      : isBroken(d) ? 'dead clock &mdash; drop writes an anchor'
      : 'drop sets this column&rsquo;s offset'
    const off = offsets[d] ?? 0
    const changed = off !== (START.offsets[d] ?? 0)
    return '<div class="cam' + (ref ? ' isref' : '') + '">'
      + '<b>' + d + '</b><span class="who">' + (D.who[d] ?? '') + '</span>'
      + (ref ? '' : '<div class="off' + (changed ? ' changed' : '') + '" id="off-' + d + '">'
        + (isBroken(d) ? (anchors[d] ?? []).length + ' anchors' : dur(off)) + '</div>')
      + (ref || isBroken(d) ? '' : '<div class="btns">'
        + [['-1h',-3600],['-5m',-300],['-1m',-60],['+1m',60],['+5m',300],['+1h',3600]]
          .map(([l, v]) => '<button data-d="' + d + '" data-nudge="' + v + '">' + l + '</button>').join('')
        + '<button data-d="' + d + '" data-reset="1">reset</button></div>')
      + '<div class="mode">' + mode + '</div></div>'
  }).join('')
}

function render() {
  // offsets/anchors/times may have just changed, and every placement depends on them
  recompute()
  renderCams()
  document.getElementById('head').innerHTML = '<th class="t"></th>'
    + D.dirs.map((d) => '<th>' + d + '</th>').join('')

  const cells = BINS.map(() => D.dirs.map(() => []))
  let unplaced = 0
  for (const p of D.photos) {
    const t = placed(p)
    if (t === null) { unplaced++; continue }
    const bi = binIndex(t)
    const ci = D.dirs.indexOf(p.d)
    if (ci >= 0) cells[bi][ci].push(p)
  }

  const rows = []
  for (let i = 0; i < BINS.length; i++) {
    const b = BINS[i]
    const any = cells[i].some((c) => c.length)
    const d = new Date(b.t * 1000)
    const onHour = d.getUTCMinutes() === 0
    const cls = [any ? '' : 'empty', b.fine ? 'fine' : '', onHour ? 'hour' : ''].join(' ')
    rows.push('<tr class="' + cls + '" data-bin="' + i + '">'
      + '<td class="t">' + (any || onHour ? fmtCell(b.t) : '') + '</td>'
      + cells[i].map((list) => '<td><div class="cell">' + list.map((p) =>
          '<span class="th' + (Number.isFinite(times[p.s]) ? ' pin' : '')
          + (armed && armed.s === p.s ? ' armed' : '') + '"'
          + ' draggable="true" data-s="' + p.s + '" title="' + p.s + '">'
          + '<img loading="lazy" src="' + p.p + '" alt=""></span>').join('')
          + '</div></td>').join('')
      + '</tr>')
  }
  document.getElementById('body').innerHTML = rows.join('')

  const changed = D.dirs.filter((d) => (offsets[d] ?? 0) !== (START.offsets[d] ?? 0)).length
  document.getElementById('status').innerHTML = armed
    ? '<span class="armedbar">placing ' + armed.s.split('/')[1]
      + ' &mdash; click a bin, or Esc to cancel</span>'
    : (unplaced ? unplaced + ' frame(s) unplaced &middot; ' : '')
      + (changed ? changed + ' column(s) changed &mdash; not yet in clocks.json' : 'matches clocks.json')
  save()
}

// ---- drag: one gesture, three meanings (see the header comment)
let dragging = null
document.addEventListener('dragstart', (ev) => {
  const th = ev.target.closest('.th')
  if (!th) return
  dragging = D.photos.find((p) => p.s === th.dataset.s)
  th.classList.add('drag')
  ev.dataTransfer.effectAllowed = 'move'
})
document.addEventListener('dragend', () => {
  document.querySelectorAll('.th.drag').forEach((e) => e.classList.remove('drag'))
  document.querySelectorAll('tr.over').forEach((e) => e.classList.remove('over'))
  dragging = null
})
document.addEventListener('dragover', (ev) => {
  const tr = ev.target.closest('tr[data-bin]')
  if (!tr || !dragging) return
  ev.preventDefault()
  document.querySelectorAll('tr.over').forEach((e) => e.classList.remove('over'))
  tr.classList.add('over')
})
document.addEventListener('drop', (ev) => {
  const tr = ev.target.closest('tr[data-bin]')
  if (!tr || !dragging) return
  ev.preventDefault()
  place(dragging, +tr.dataset.bin)
})

/** @param p photo  @param bi index into BINS */
function place(p, bi) {
  // land on the MIDDLE of the bin: the frame is somewhere inside it, and the
  // midpoint is the least wrong guess available at this resolution
  const b = BINS[bi]
  const t = b.t + Math.round(b.len / 2)

  if (p.d === D.ref) {
    alert('The reference camera defines the timeline -- move the others to it instead.')
  } else if (!hasExif(p)) {
    times[p.s] = t                                  // nothing to offset; pin outright
  } else if (isBroken(p.d)) {
    // Replace any anchor already inside this frame's burst, not merely one on the
    // same frame.  A burst moves as a rigid unit, so two anchors in it are two
    // answers to one question -- and since place_dead() walks anchors in frame
    // order, the one that would win is whichever has the higher frame number, not
    // the one you just dropped.  Re-placing a burst should mean what it looks like.
    const timed = D.photos
      .filter((x) => x.d === p.d && x.e !== null && x.q !== null)
      .map((x) => ({ seq: x.q, exif: x.e, stem: x.s }))
      .sort((x, y) => x.seq - y.seq)
    const mine = detect_bursts(timed).find((b) => b.some((f) => f.seq === p.q))
    const seqs = new Set(mine ? mine.map((f) => f.seq) : [p.q])
    const a = (anchors[p.d] ??= []).filter((x) => !seqs.has(x.seq))
    a.push({ seq: p.q, time: t, from: 'align.html', to: p.s })
    anchors[p.d] = a.sort((x, y) => x.seq - y.seq)
  } else {
    offsets[p.d] = t - p.e                          // one pairing moves the whole roll
  }
  armed = null
  render()
}

/*
  Click to arm, click a bin to place.

  Dragging cannot cross more than about a screenful: the browser's auto-scroll gives
  out, and a camera that is three hours wrong needs the frame carried far further
  than that.  Arming a frame first lets you scroll as far as you like -- past a whole
  night, if that is where it belongs -- before choosing the bin.
*/
let armed = null
document.addEventListener('click', (ev) => {
  const th = ev.target.closest('.th')
  if (th) {
    const p = D.photos.find((x) => x.s === th.dataset.s)
    armed = armed && armed.s === p.s ? null : p       // clicking it again disarms
    render()
    return
  }
  if (!armed) return
  const tr = ev.target.closest('tr[data-bin]')
  if (tr) place(armed, +tr.dataset.bin)
})
document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape' && armed) {
    armed = null
    render()
  }
})

// ---- nudges
document.addEventListener('click', (ev) => {
  const b = ev.target.closest('button')
  if (!b) return
  if (b.dataset.nudge) {
    offsets[b.dataset.d] = (offsets[b.dataset.d] ?? 0) + Number(b.dataset.nudge)
    render()
  } else if (b.dataset.reset) {
    offsets[b.dataset.d] = START.offsets[b.dataset.d] ?? 0
    render()
  }
})

document.getElementById('resetall').onclick = () => {
  if (!confirm('Discard every change and go back to clocks.json?')) return
  offsets = structuredClone(START.offsets)
  anchors = structuredClone(START.anchors)
  times = structuredClone(START.times)
  armed = null
  try { localStorage.removeItem(LSKEY) } catch { /* private window */ }
  render()   // re-saves the clocks.json state, which is what we now want kept
}
document.getElementById('export').onclick = () => {
  const clean = {}
  for (const [k, v] of Object.entries(anchors))
    clean[k] = v.map(({ seq, time, from, to }) => ({ seq, time: Math.round(time), from, to }))
  // Emit the WHOLE file, not just the three keys that change here.  Exporting only
  // the edited sections invites saving that over clocks.json, which silently drops
  // reference_dir, broken_clocks and photographers -- and the next build then fails
  // on a camera having no name.  Round-tripping everything makes that impossible.
  const out = {
    ...D.full,
    offsets: Object.fromEntries(Object.entries(offsets).map(([k, v]) => [k, Math.round(v)])),
    anchors: clean,
    times: {
      ...(D.full.times?._note ? { _note: D.full.times._note } : {}),
      ...Object.fromEntries(Object.entries(times).map(([k, v]) => [k, Math.round(v)])),
    },
  }
  document.getElementById('outtext').value = JSON.stringify(out, null, 2)
  document.getElementById('out').classList.add('show')
}
document.getElementById('copy').onclick = async () => {
  try { await navigator.clipboard.writeText(document.getElementById('outtext').value) } catch {}
}
document.getElementById('close').onclick = () =>
  document.getElementById('out').classList.remove('show')

// ---- view controls.  Purely per-viewer comfort, so localStorage is the right home
// -- and it throws outright in a private window, hence the try/catch.
function setView(percell, zoom) {
  document.documentElement.style.setProperty('--percell', percell)
  document.documentElement.style.setProperty('--zoom', zoom)
  document.getElementById('zoom').textContent = 'crop ' + zoom + '\\u00d7'
  for (const b of document.querySelectorAll('.sz'))
    b.style.background = b.dataset.percell === String(percell) ? 'var(--accent)' : ''
  try {
    localStorage.setItem('align-view', JSON.stringify({ percell, zoom }))
  } catch { /* private window */ }
}
let view = { percell: 2, zoom: 1 }
try {
  view = { ...view, ...JSON.parse(localStorage.getItem('align-view') || '{}') }
} catch { /* private window */ }

document.addEventListener('click', (ev) => {
  const b = ev.target.closest('.sz')
  if (!b) return
  view.percell = Number(b.dataset.percell)
  setView(view.percell, view.zoom)
})
document.getElementById('zoom').onclick = () => {
  view.zoom = view.zoom >= 4 ? 1 : view.zoom * 2
  setView(view.percell, view.zoom)
}

buildBins()
render()
setView(view.percell, view.zoom)
</script>
</body>
</html>
`

Deno.writeTextFileSync(`${REPO}/align.html`, html)
console.error(`\nwrote ${REPO}/align.html`)
console.error('  serve the repo and open align.html, then export into clocks.json')
