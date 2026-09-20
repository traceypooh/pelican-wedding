/*
  clock -- where each photo sits on the timeline, once the cameras are reconciled.

  Shared deliberately: build-index.js imports this, and make-align.js inlines this
  same source into align.html.  If the tool and the build disagreed about placement,
  the tool would be showing you a timeline the gallery never produces.

  Three kinds of clock, in order of how much the camera still knows:

  1. Correct, or merely set wrong.  The frame-to-frame spacing is intact and only the
     whole roll is displaced, so one offset fixes every frame.

  2. Dead.  wed-canon's coin cell was flat, so it reset to the same instant on nearly
     every power-on -- 43 times across 161 frames.  Its absolute stamps are worthless
     AND its long intervals are worthless.  But *within* one power-on the clock ran
     normally, so a burst's internal timing is exact.  See place_dead().

  3. No timestamp at all (the selfies).  Nothing to offset or interpolate; these are
     placed by hand and stored in `times`.
*/

/** A burst: consecutive frames from one power-on, whose internal timing is trusted. */
const MAX_BURST_STEP = 3600 // a jump larger than this is a reset, not a pause
const MAX_SEQ_STEP = 6 // ... and the frame counter must be roughly continuous
const EDGE_GAP = 600 // assumed gap when extrapolating past the outermost anchor

/**
 * Split a camera's frames into power-on bursts.
 * @param {{seq: number, exif: number}[]} frames sorted by seq, all with exif
 */
export function detect_bursts(frames) {
  if (!frames.length) return []
  const bursts = []
  let cur = [frames[0]]
  for (let i = 1; i < frames.length; i++) {
    const prev = frames[i - 1]
    const now = frames[i]
    const step = now.exif - prev.exif
    // time must move forward, plausibly, and in step with the frame counter
    if (step >= 0 && step < MAX_BURST_STEP && now.seq - prev.seq <= MAX_SEQ_STEP) {
      cur.push(now)
    } else {
      bursts.push(cur)
      cur = [now]
    }
  }
  bursts.push(cur)
  return bursts
}

/**
 * Place the frames of a camera whose clock died.
 *
 * The anchors say "frame N happened at T".  Between two anchors we know exactly how
 * much of the elapsed time was spent shooting -- that is the sum of the burst
 * durations -- and the remainder is time the camera spent switched off.  So the
 * bursts keep the duration they recorded and ALL the slack is shared out between
 * them.
 *
 * Interpolating across the frame counter instead (the obvious approach, and what
 * this replaced) spreads every burst evenly over the anchors that bracket it: a
 * 15-frame burst genuinely shot in 619 seconds came out stretched across 4154.
 *
 * @param {{stem: string, seq: number|null, exif: number|null}[]} list
 * @param {{seq: number, time: number}[]} anchor_list
 * @returns {Map<string, number|null>}
 */
export function place_dead(list, anchor_list) {
  const out = new Map(list.map((p) => [p.stem, null]))
  const timed = list.filter((p) => p.exif !== null && p.seq !== null)
    .sort((a, b) => a.seq - b.seq)
  if (!timed.length) return out

  const bursts = detect_bursts(timed)
  const dur = bursts.map((b) => b[b.length - 1].exif - b[0].exif)
  /** seq -> [burst index, seconds into that burst] */
  const where = new Map()
  bursts.forEach((b, i) => {
    for (const f of b) where.set(f.seq, [i, f.exif - b[0].exif])
  })

  const anchors = anchor_list
    .filter((a) => Number.isFinite(a.seq) && Number.isFinite(a.time) && where.has(a.seq))
    .sort((a, b) => a.seq - b.seq)
  // One anchor fixes the offset of its own burst but says nothing about the gaps, so
  // it cannot place anything else.  Two is the minimum that constrains a rate.
  if (anchors.length < 2) return out

  /** start time of each burst */
  const start = new Array(bursts.length).fill(null)
  for (const a of anchors) {
    const [bi, bo] = where.get(a.seq)
    start[bi] = a.time - bo
  }
  const known = start.map((v, i) => (v === null ? -1 : i)).filter((i) => i >= 0)

  for (let k = 0; k < known.length - 1; k++) {
    const a = known[k]
    const b = known[k + 1]
    let shooting = 0
    for (let i = a; i < b; i++) shooting += dur[i]
    // Negative slack means the anchors are closer together than the frames they
    // bracket could possibly fit.  Rather than run the bursts backwards, close the
    // gaps entirely and let them overlap -- the anchors are what is wrong there, and
    // the overlap is the visible symptom that says so.
    const gap = Math.max(0, ((start[b] - start[a]) - shooting) / (b - a))
    let t = start[a]
    for (let i = a; i < b; i++) {
      if (start[i] === null) start[i] = t
      t = start[i] + dur[i] + gap
    }
  }
  // Outside the anchors there is nothing to divide, so assume a typical gap.  This
  // is extrapolation and the least trustworthy part of the result.
  for (let i = known[0] - 1; i >= 0; i--) start[i] = start[i + 1] - dur[i] - EDGE_GAP
  for (let i = known[known.length - 1] + 1; i < bursts.length; i++) {
    start[i] = start[i - 1] + dur[i - 1] + EDGE_GAP
  }

  for (const f of timed) {
    const [bi, bo] = where.get(f.seq)
    out.set(f.stem, start[bi] + bo)
  }

  // Frames with no timestamp at all belong to no burst.  Put them between their
  // neighbours by frame number, which is at least the right order.
  const placed = timed.map((f) => ({ seq: f.seq, t: out.get(f.stem) }))
  for (const p of list) {
    if (out.get(p.stem) !== null || p.seq === null) continue
    let lo = null
    let hi = null
    for (const q of placed) {
      if (q.seq <= p.seq) lo = q
      if (q.seq >= p.seq && hi === null) hi = q
    }
    if (lo && hi && hi.seq !== lo.seq) {
      out.set(p.stem, lo.t + (p.seq - lo.seq) * ((hi.t - lo.t) / (hi.seq - lo.seq)))
    } else if (lo) out.set(p.stem, lo.t)
    else if (hi) out.set(p.stem, hi.t)
  }
  return out
}

/**
 * Place every photo.
 * @param {{stem: string, dir: string, seq: number|null, exif: number|null}[]} photos
 * @param {{offsets: object, anchors: object, times: object, broken: string[]}} state
 * @returns {Map<string, number|null>} stem -> naive-UTC seconds
 */
export function place_all(photos, state) {
  const out = new Map()
  const by_dir = {}
  for (const p of photos) (by_dir[p.dir] ??= []).push(p)

  for (const [dir, list] of Object.entries(by_dir)) {
    if ((state.broken ?? []).includes(dir)) {
      for (const [stem, t] of place_dead(list, state.anchors?.[dir] ?? [])) out.set(stem, t)
    } else {
      const off = state.offsets?.[dir] ?? 0
      for (const p of list) out.set(p.stem, p.exif === null ? null : p.exif + off)
    }
  }
  // A hand-set time wins over everything: no offset or interpolation can rescue a
  // frame that never carried a timestamp to begin with.
  for (const [stem, t] of Object.entries(state.times ?? {})) {
    if (Number.isFinite(t)) out.set(stem, t)
  }
  return out
}
