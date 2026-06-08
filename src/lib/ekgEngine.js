// ekgEngine.js
//
// The mathematical core of Module 3. Generates EKG voltage values from a
// "Gaussian-sum" model: each wave (P, Q, R, S, T) is a bell curve with its
// own height, width, and position in the cardiac cycle. Adding them together
// produces one heartbeat's worth of waveform — repeat that on a loop and you
// get a continuously scrolling EKG strip.
//
// Reference: Boron & Boulpaep, Medical Physiology — normal sinus rhythm values.

// ─────────────────────────────────────────────────────────────────────────
// gaussian — the building block for every wave on the EKG
//
//   amplitude : peak height in millivolts (negative = downward deflection,
//               like the Q and S waves)
//   center    : the time (ms) within the cycle where the peak occurs
//   sigma     : standard deviation (ms) — controls how wide the bump is.
//               About 95% of a Gaussian's area falls within ±2*sigma of its
//               center, so we use "center ± 2*sigma" as a wave's effective
//               start/end when measuring intervals like PR and QRS.
// ─────────────────────────────────────────────────────────────────────────
function gaussian(tMs, amplitude, center, sigma) {
  const exponent = -((tMs - center) ** 2) / (2 * sigma ** 2)
  return amplitude * Math.exp(exponent)
}

// ─────────────────────────────────────────────────────────────────────────
// LEADS — the frontal-plane limb leads, and the axis each one "looks along".
//
// This is the hexaxial reference system from cardiology, expressed in the
// same plain-degrees convention every wave's `axisDeg` (added below) uses:
// 0° points along Lead I's axis (the patient's left shoulder), and angles
// increase the same direction the hexaxial system does — toward Lead II,
// then III, then aVF, sweeping down toward the feet.
//
//   Lead I    0°        aVL   -30°
//   Lead II  60°        aVR  -150°  (equivalently +210°)
//   Lead III 120°       aVF   90°
//
// Whichever lead is "selected" in the simulation supplies its axisDeg here
// as the second argument to cycleVoltage()/ekgVoltage() — that's the only
// thing that changes between leads; the underlying rhythm is identical.
// ─────────────────────────────────────────────────────────────────────────
export const LEADS = {
  I:   { id: 'I',   label: 'Lead I',   axisDeg:    0 },
  II:  { id: 'II',  label: 'Lead II',  axisDeg:   60 },
  III: { id: 'III', label: 'Lead III', axisDeg:  120 },
  aVR: { id: 'aVR', label: 'aVR',      axisDeg: -150 },
  aVL: { id: 'aVL', label: 'aVL',      axisDeg:  -30 },
  aVF: { id: 'aVF', label: 'aVF',      axisDeg:   90 },
}

// Display order for lead selectors — the conventional clinical reading order.
export const LEAD_ORDER = ['I', 'II', 'III', 'aVR', 'aVL', 'aVF']

// Lead II is the default: its +60° axis is almost exactly the normal QRS
// axis used below, so it's the lead a normally-conducting heart's main
// deflection points most directly at — which is exactly why it's the
// standard "rhythm strip" lead on real bedside monitors. (It's also why
// switching the default to it leaves this simulation looking essentially
// identical to the single-lead model these wave values were originally
// tuned against — see the note on NORMAL_SINUS_WAVES below.)
export const DEFAULT_LEAD_ID = 'II'

// ─────────────────────────────────────────────────────────────────────────
// projectionFactor — the single physical law this whole module exists to
// teach, made concrete: a lead never measures a deflection's "true"
// strength. It measures that strength's PROJECTION onto the lead's own
// axis — exactly the vector-projection idea from Physics Foundations
// (Module 1), now doing real work.
//
//   cos(0°)   = 1   → a deflection pointing straight along a lead's axis
//                     registers at full strength
//   cos(90°)  = 0   → one pointing perpendicular to the lead is INVISIBLE
//                     to it — contributes nothing to that lead's trace
//   cos(180°) = -1  → one pointing the opposite way registers at full
//                     strength but INVERTED — what reads as a tall positive
//                     spike in one lead can read as an equally deep negative
//                     dip in another, purely from the geometry of where
//                     you're "looking" from. (This is precisely why the
//                     same heartbeat produces a different-looking trace on
//                     every lead — nothing about the heart changes; only
//                     the angle of the observer does.)
//
// `sourceAxisDeg` is a deflection's mean electrical axis — the direction its
// underlying depolarization/repolarization wavefront travels — and
// `leadAxisDeg` is the axis of the lead doing the looking. Both use the same
// degree convention as LEADS above, so the difference between them is a
// meaningful angle to take the cosine of.
// ─────────────────────────────────────────────────────────────────────────
function projectionFactor(sourceAxisDeg, leadAxisDeg) {
  const angleBetweenDeg = sourceAxisDeg - leadAxisDeg
  return Math.cos((angleBetweenDeg * Math.PI) / 180)
}

// ─────────────────────────────────────────────────────────────────────────
// NORMAL_SINUS_WAVES — default shape for a normal sinus rhythm at ~75 bpm
// (cycle length 800 ms). All times are milliseconds measured from the start
// of the cycle; all amplitudes are millivolts as they'd appear viewed
// face-on along their own electrical axis (see `axisDeg` below — these are
// the numbers projectionFactor scales by lead).
//
// These five entries are the whole "personality" of the rhythm — tweak the
// timing/shape numbers and watch the measured intervals (computed by
// measureIntervals, below) move toward or away from the normal ranges:
//
//   PR interval   120 - 200 ms   →  this model measures ~149 ms
//   QRS duration  <   120 ms     →  this model measures ~71 ms
//   QT interval   ~350 - 400 ms at this heart rate → this model measures ~357 ms
//                 (QT shortens as heart rate rises — Bazett's correction
//                  predicts ~358 ms at 75 bpm for a "normal" 400 ms QTc)
//
// `axisDeg` is new: it's each deflection's mean electrical axis (see LEADS
// and projectionFactor above for what that means and how it's used). A
// normal P wave, QRS complex, and T wave each have their own textbook-normal
// axis — roughly +60°, +60°, and +45° — which is what's used here. Note Q
// and S keep their NEGATIVE amplitudes despite sharing the QRS's +60° axis:
// that's intentional and correct. `amplitude`'s sign encodes whether a
// component points WITH that shared axis (positive, like R) or AGAINST it
// (negative, like Q and S); projectionFactor handles the rest.
//
// These `amplitude` values are calibrated to read at face value through a
// lead aligned with the relevant axis — i.e. close to full strength on
// Lead II (+60°, almost exactly the normal QRS axis — see DEFAULT_LEAD_ID
// above), which is why this still looks like the original single-lead
// prototype by default. Switch to a different lead and the SAME heartbeat
// produces a visibly different trace — sometimes smaller, sometimes
// inverted — purely from the change in viewing angle. Nothing about the
// rhythm definition changes; only `leadAxisDeg` does.
// ─────────────────────────────────────────────────────────────────────────
export const NORMAL_SINUS_WAVES = [
  { name: 'P', amplitude:  0.15, center:  80, sigma: 25, axisDeg: 60 },
  { name: 'Q', amplitude: -0.10, center: 195, sigma:  8, axisDeg: 60 },
  { name: 'R', amplitude:  1.20, center: 213, sigma: 12, axisDeg: 60 },
  { name: 'S', amplitude: -0.25, center: 230, sigma: 10, axisDeg: 60 },
  { name: 'T', amplitude:  0.30, center: 440, sigma: 48, axisDeg: 45 },
]

export const DEFAULT_HEART_RATE_BPM = 75

// ─────────────────────────────────────────────────────────────────────────
// RHYTHMS — the rhythm library (Tier 1: "same engine, different numbers").
//
// Each entry is fully self-contained: its own heart rate AND its own wave
// set. That keeps every rhythm independently tunable and independently
// checkable with measureIntervals() — no shared state to accidentally break
// another rhythm while tuning one.
//
// These six are all still "one regular, repeating P-QRS-T cycle" — only the
// timing and shape numbers differ. Rhythms where the cycle itself becomes
// irregular (2nd/3rd-degree block, AFib, PACs/PVCs, VTach, ...) need a
// fundamentally different generation strategy and will arrive in a later
// phase ("Tier 2").
//
// NOTE: for the pathological rhythms below, the "abnormal" reading is the
// whole point — e.g. selecting "1st-degree AV block" SHOULD make the PR
// interval card read outside the normal range. That's the model correctly
// reproducing the diagnostic finding, not a bug.
// ─────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────
// placeBeat — schedules one beat's waves at an absolute time.
//
// `template` is a small array of {name, amplitude, center, sigma} — exactly
// like the Tier-1 wave sets above — except its `center` values are measured
// relative to the BEAT's own start, not the cycle's. placeBeat shifts every
// center by `onsetMs`, producing waves with absolute positions that can be
// flattened together with other beats into one long array.
//
// This is the trick that lets "irregular" rhythms reuse the exact same
// cycleVoltage()/ekgVoltage() machinery as the regular ones: an irregular
// rhythm is just a longer "macro-cycle" built by laying several
// independently-timed, independently-shaped beats end to end. The engine
// never needs to know it's looking at anything other than a list of Gaussians.
// ─────────────────────────────────────────────────────────────────────────
function placeBeat(onsetMs, template) {
  return template.map(wave => ({ ...wave, center: wave.center + onsetMs }))
}

// ── Reusable beat templates (centers relative to each beat's own onset) ──

// A normal, narrow P-QRS-T complex — the same shape as NORMAL_SINUS_WAVES,
// reused as a building block for rhythms that are "mostly normal" beats
// punctuated by something abnormal (e.g. PVCs).
const NORMAL_BEAT_TEMPLATE = NORMAL_SINUS_WAVES

// A lone P wave — for rhythms where atrial activity needs to be scheduled
// independently of (and without regard to) ventricular activity.
const ATRIAL_P_TEMPLATE = [
  { name: 'P', amplitude: 0.15, center: 40, sigma: 22, axisDeg: 60 }, // normal P axis
]

// A wide, low-amplitude QRS-T with a large discordant T wave — the
// signature of a beat that originates in the ventricle (an "escape" rhythm
// pacemaker, or an ectopic PVC focus) rather than conducting down from a
// normal supraventricular impulse through the fast Purkinje network.
//
// `axisDeg` here is deliberately far from the normal QRS axis (+60°): an
// impulse that originates inside the ventricle — rather than spreading down
// through the normal His-Purkinje pathway — depolarizes the heart along an
// abnormal route, which is exactly what produces "axis deviation". A
// leftward/superior axis like this is the textbook finding for ventricular
// escape rhythms; the T wave's axis sits roughly opposite the QRS's, giving
// the "discordant T" look real wide-complex beats have.
const WIDE_VENTRICULAR_QRS_TEMPLATE = [
  { name: 'Q', amplitude: -0.20, center:   0, sigma: 20, axisDeg: -75 },
  { name: 'R', amplitude:  0.80, center:  50, sigma: 28, axisDeg: -75 },
  { name: 'S', amplitude: -0.30, center: 110, sigma: 24, axisDeg: -75 },
  { name: 'T', amplitude:  0.40, center: 300, sigma: 70, axisDeg: 105 },
]

// A premature ventricular contraction: even wider and more bizarre than an
// escape beat (a single dominant deflection rather than distinct Q/R/S),
// with NO preceding P wave and a tall, sharply discordant (inverted) T wave.
//
// Its axis is pushed even further from normal than the escape template's —
// an "extreme" axis is part of what makes a PVC look so visually alarming
// against the normal beats around it (and is itself a real diagnostic clue:
// ectopic ventricular foci can fire from almost anywhere in the ventricle,
// and the resulting axis can land anywhere on the compass).
const PVC_TEMPLATE = [
  { name: 'R', amplitude:  1.30, center:  70, sigma: 35, axisDeg: -100 },
  { name: 'S', amplitude: -0.50, center: 140, sigma: 30, axisDeg: -100 },
  { name: 'T', amplitude: -0.35, center: 290, sigma: 55, axisDeg:   80 },
]

// One "flutter wave" — a small biphasic (up-then-down) blip. A continuous
// train of these, evenly spaced and overlapping slightly, produces the
// classic atrial-flutter "sawtooth" baseline in place of discrete P waves.
// Its axis is given a distinct value of its own — a reentrant circuit racing
// around the atria isn't depolarizing them the normal way, so there's no
// reason to expect it to share the normal P wave's axis.
const FLUTTER_WAVE_TEMPLATE = [
  { name: 'F', amplitude:  0.12, center: 20, sigma: 12, axisDeg: -15 },
  { name: 'F', amplitude: -0.10, center: 55, sigma: 14, axisDeg: -15 },
]

// A normal, narrow QRS-T — used for the conducted beats in atrial flutter
// AND for both 2nd-degree block rhythms below, since all three involve
// completely normal ventricular conduction; the trouble lies upstream
// (in the atria or the AV node), not in the ventricles themselves. Same
// normal QRS/T axes as NORMAL_SINUS_WAVES, for the same reason.
const NARROW_QRS_T_TEMPLATE = [
  { name: 'Q', amplitude: -0.10, center:  15, sigma:  6, axisDeg: 60 },
  { name: 'R', amplitude:  1.10, center:  28, sigma:  9, axisDeg: 60 },
  { name: 'S', amplitude: -0.20, center:  42, sigma:  8, axisDeg: 60 },
  { name: 'T', amplitude:  0.25, center: 140, sigma: 32, axisDeg: 45 },
]

// A premature ATRIAL contraction's P wave: smaller and narrower than a
// normal sinus P wave, because it spreads outward from an ectopic atrial
// focus along a different path through the atria rather than from the SA
// node — a subtly different "shape" AND a subtly different axis (here +30°
// instead of the normal +60°), not the absence of a shape (contrast this
// with PVCs, which have NO P wave at all). The QRS-T that follows is
// completely normal — conduction below the atria is unaffected — so PACs
// reuse NORMAL_BEAT_TEMPLATE's Q/R/S/T centers, just with this P wave type.
const PAC_P_TEMPLATE = [
  { name: 'P', amplitude: 0.10, center: 30, sigma: 16, axisDeg: 30 },
]

// ─────────────────────────────────────────────────────────────────────────
// buildFibrillatoryBaseline — generates the chaotic, undulating baseline of
// atrial fibrillation: a long run of small, irregularly-spaced "f-wave"
// bumps standing in for the disorganized electrical static of a fibrillating
// atrium (no organized depolarization survives to form a real P wave).
//
// This has to look chaotic but, like ekgNoise/warpTime above, can't actually
// BE random — the same "value noise" constraint applies (re-evaluating the
// same instant on every redraw must always produce the same voltage, or the
// trace flickers instead of scrolling). So spacing and amplitude are derived
// from sine functions evaluated at each step's index `i`: the result marches
// along in a sequence that never lands on a repeating pattern within the
// length of one macro-cycle, while remaining perfectly reproducible.
// ─────────────────────────────────────────────────────────────────────────
function buildFibrillatoryBaseline(durationMs) {
  const waves = []
  let onsetMs = 0
  let i = 0
  while (onsetMs < durationMs) {
    const spacingMs = 90 + 35 * Math.sin(i * 2.39 + 0.7)   // ~55-125 ms apart
    const amplitude = 0.05 + 0.025 * Math.sin(i * 1.61 + 2.2) // tiny, irregular heights
    // chaotic per-wavelet axis — fibrillating atrial tissue has no organized
    // depolarization wavefront, so its net electrical direction wanders
    // continuously rather than settling on a "P axis" the way healthy atria do
    const axisDeg = 180 * Math.sin(i * 1.91 + 1.0)
    waves.push({ name: 'f', amplitude, center: onsetMs, sigma: 7, axisDeg })
    onsetMs += spacingMs
    i++
  }
  return waves
}

export const RHYTHMS = {
  normalSinus: {
    id: 'normalSinus',
    label: 'Normal sinus rhythm',
    description:
      'Regular rhythm originating in the SA node at a normal resting rate, with normal conduction through the AV node and ventricles. Every interval falls inside the textbook normal range.',
    heartRateBpm: 75,
    waves: NORMAL_SINUS_WAVES,
  },

  sinusTachycardia: {
    id: 'sinusTachycardia',
    label: 'Sinus tachycardia',
    description:
      'Same SA-node origin and normal conduction pathway as a normal sinus rhythm — just faster (>100 bpm). Every interval compresses, and the QT interval rate-corrects shorter (Bazett).',
    heartRateBpm: 130,
    waves: [
      { name: 'P', amplitude:  0.15, center:  40, sigma: 12, axisDeg: 60 },
      { name: 'Q', amplitude: -0.10, center: 150, sigma:  6, axisDeg: 60 },
      { name: 'R', amplitude:  1.20, center: 160, sigma:  8, axisDeg: 60 },
      { name: 'S', amplitude: -0.25, center: 172, sigma:  7, axisDeg: 60 },
      { name: 'T', amplitude:  0.30, center: 340, sigma: 35, axisDeg: 45 },
    ],
  },

  sinusBradycardia: {
    id: 'sinusBradycardia',
    label: 'Sinus bradycardia',
    description:
      'Same SA-node origin and normal conduction pathway — just slower (<60 bpm). The extra cycle time shows up mostly as a longer pause between beats (the flat segment between T and the next P).',
    heartRateBpm: 50,
    waves: [
      { name: 'P', amplitude:  0.15, center: 100, sigma: 28, axisDeg: 60 },
      { name: 'Q', amplitude: -0.10, center: 250, sigma:  9, axisDeg: 60 },
      { name: 'R', amplitude:  1.20, center: 265, sigma: 12, axisDeg: 60 },
      { name: 'S', amplitude: -0.25, center: 280, sigma: 11, axisDeg: 60 },
      { name: 'T', amplitude:  0.30, center: 520, sigma: 65, axisDeg: 45 },
    ],
  },

  firstDegreeBlock: {
    id: 'firstDegreeBlock',
    label: '1st-degree AV block',
    description:
      'Every atrial impulse still reaches the ventricles — but the AV node delays each one more than normal, by a fixed extra amount. The result: a PR interval that is constant from beat to beat, but prolonged beyond 200 ms.',
    heartRateBpm: 75,
    waves: [
      { name: 'P', amplitude:  0.15, center:  80, sigma: 25, axisDeg: 60 },
      { name: 'Q', amplitude: -0.10, center: 266, sigma:  8, axisDeg: 60 },
      { name: 'R', amplitude:  1.20, center: 284, sigma: 12, axisDeg: 60 },
      { name: 'S', amplitude: -0.25, center: 301, sigma: 10, axisDeg: 60 },
      { name: 'T', amplitude:  0.30, center: 511, sigma: 48, axisDeg: 45 },
    ],
  },

  // lbbb/rbbb axisDeg values: bundle branch blocks are a textbook cause of
  // axis deviation — losing the fast Purkinje pathway down one side forces
  // depolarization to detour through working myocardium, shifting WHICH WAY
  // the QRS net vector points (not just how long it takes). LBBB classically
  // drags the QRS axis leftward/superior (-45° here, "left axis deviation");
  // RBBB commonly shifts it rightward (+90°). Both also show "discordant" T
  // waves — the abnormal depolarization sequence drags repolarization with
  // it — so each T axis sits roughly opposite its QRS axis.
  lbbb: {
    id: 'lbbb',
    label: 'Left bundle branch block',
    description:
      "The left ventricle can no longer depolarize via the fast Purkinje network — it has to activate slowly, cell-to-cell, which widens the QRS complex beyond 120 ms. (Simplified: a real LBBB also produces a notched/slurred R wave that a five-Gaussian model can't reproduce — the widening is the diagnostic feature this model captures.)",
    heartRateBpm: 75,
    waves: [
      { name: 'P', amplitude:  0.15, center:  80, sigma: 25, axisDeg:  60 },
      { name: 'Q', amplitude: -0.15, center: 200, sigma: 18, axisDeg: -45 },
      { name: 'R', amplitude:  1.00, center: 230, sigma: 22, axisDeg: -45 },
      { name: 'S', amplitude: -0.35, center: 260, sigma: 20, axisDeg: -45 },
      { name: 'T', amplitude:  0.30, center: 460, sigma: 50, axisDeg: 135 },
    ],
  },

  rbbb: {
    id: 'rbbb',
    label: 'Right bundle branch block',
    description:
      "The right ventricle depolarizes late, again widening the QRS complex beyond 120 ms — typically seen as a broad, slurred terminal S wave on a lateral lead like Lead I. (Simplified: a real RBBB also produces an RSR' \"rabbit-ears\" pattern over the right side of the heart, which a single-lead model can't show.)",
    heartRateBpm: 75,
    waves: [
      { name: 'P', amplitude:  0.15, center:  80, sigma: 25, axisDeg: 60 },
      { name: 'Q', amplitude: -0.08, center: 195, sigma: 10, axisDeg: 90 },
      { name: 'R', amplitude:  0.90, center: 218, sigma: 14, axisDeg: 90 },
      { name: 'S', amplitude: -0.40, center: 255, sigma: 22, axisDeg: 90 },
      { name: 'T', amplitude:  0.30, center: 450, sigma: 48, axisDeg: -90 },
    ],
  },

  // ─────────────────────────────────────────────────────────────────────
  // Tier 2: irregular rhythms — built from placeBeat() "macro-cycles"
  //
  // These rhythms don't repeat one P-QRS-T shape on a fixed schedule; the
  // whole POINT is that successive beats differ in timing, shape, or both.
  // So instead of one wave set sampled on a loop, each of these lays out
  // several independently-timed beats end to end (via placeBeat) and
  // flattens them into one long `waves` array spanning a longer
  // "macro-cycle" — which the existing cycleVoltage/ekgVoltage functions
  // then sample exactly as before, with no changes needed.
  //
  // Two new fields appear here:
  //   cycleMs     — overrides the heart-rate-derived cycle length, since
  //                 these macro-cycles' true repeat length isn't simply
  //                 60000 / heartRateBpm (the rate varies beat to beat).
  //   measurable  — set to `false` to tell the prototype (and eventually
  //                 Module 3) that measureIntervals()'s "one PR/QRS/QT
  //                 per cycle" model doesn't apply: these rhythms have
  //                 multiple/irregular complexes, and that beat-to-beat
  //                 variability IS the diagnostic finding, not something
  //                 to average away.
  // ─────────────────────────────────────────────────────────────────────

  thirdDegreeBlock: {
    id: 'thirdDegreeBlock',
    label: '3rd-degree (complete) AV block',
    description:
      'No atrial impulse makes it through the AV node at all — the atria and ventricles beat completely independently, each driven by its own pacemaker. P waves continue at a normal atrial rate (~100 bpm here) and "march through" the QRS-T complexes with no fixed relationship, while a slow ventricular escape pacemaker (~33 bpm) fires on its own, producing wide, bizarre QRS complexes. This total dissociation between P waves and QRS complexes — not any single interval — is the diagnostic finding, which is why per-beat PR/QRS/QT numbers aren\'t shown for this rhythm.',
    heartRateBpm: 33,
    cycleMs: 1800,
    measurable: false,
    waves: [
      ...placeBeat(60,   ATRIAL_P_TEMPLATE),            // P waves keep marching at their
      ...placeBeat(660,  ATRIAL_P_TEMPLATE),            // own ~600ms (100bpm) atrial rhythm,
      ...placeBeat(1260, ATRIAL_P_TEMPLATE),            // oblivious to the ventricles below
      ...placeBeat(900,  WIDE_VENTRICULAR_QRS_TEMPLATE), // independent escape pacemaker:
    ],                                                   // one wide QRS per 1800ms cycle (~33bpm)
  },

  atrialFlutter: {
    id: 'atrialFlutter',
    label: 'Atrial flutter (2:1 conduction)',
    description:
      'A reentrant electrical circuit races around the atria roughly 300 times per minute, replacing distinct P waves with a continuous, sawtooth "flutter wave" baseline. The AV node can\'t conduct every one of these impulses through to the ventricles — here, every other flutter wave gets through (2:1 conduction), producing a regular ventricular rate of about 150 bpm with normal, narrow QRS complexes riding on top of the sawtooth. Because the underlying atrial activity has no discrete P wave to measure from, per-beat PR/QRS/QT numbers aren\'t shown for this rhythm — the sawtooth baseline itself is the finding.',
    heartRateBpm: 150,
    cycleMs: 800,
    measurable: false,
    waves: [
      ...placeBeat(0,   FLUTTER_WAVE_TEMPLATE),     // continuous sawtooth: four flutter
      ...placeBeat(200, FLUTTER_WAVE_TEMPLATE),     // waves per 800ms cycle ≈ 300 bpm
      ...placeBeat(400, FLUTTER_WAVE_TEMPLATE),     // atrial rate — the reentrant circuit
      ...placeBeat(600, FLUTTER_WAVE_TEMPLATE),     // never "rests" between beats
      ...placeBeat(100, NARROW_QRS_T_TEMPLATE),     // only every OTHER flutter wave
      ...placeBeat(500, NARROW_QRS_T_TEMPLATE),     // conducts through (2:1) → 150 bpm QRS
    ],
  },

  pvcs: {
    id: 'pvcs',
    label: 'Premature ventricular contractions (PVCs)',
    description:
      'An irritable focus inside the ventricle occasionally fires on its own, ahead of schedule — producing a wide, bizarre complex with no preceding P wave and a tall T wave that points the opposite direction from the QRS ("discordance"). Critically, this ectopic beat does NOT reset the SA node: the atria keep marching to their own regular rhythm underneath, so the next normal sinus beat arrives exactly on the schedule it would have anyway — creating a pause that is precisely twice the normal beat-to-beat interval (a "fully compensatory pause"). Because this rhythm mixes a normal complex with a completely different ectopic one, per-beat PR/QRS/QT numbers aren\'t shown — the contrast between the two shapes, and the pause itself, are the findings to observe.',
    heartRateBpm: 75,
    cycleMs: 4000,
    measurable: false,
    waves: [
      ...placeBeat(0,    NORMAL_BEAT_TEMPLATE),  // three normal sinus beats at the
      ...placeBeat(800,  NORMAL_BEAT_TEMPLATE),  // regular underlying rate (800ms / 75bpm)
      ...placeBeat(1600, NORMAL_BEAT_TEMPLATE),
      ...placeBeat(2100, PVC_TEMPLATE),          // PVC fires early — only 500ms after
                                                 // the last normal beat, with no P wave
      ...placeBeat(3200, NORMAL_BEAT_TEMPLATE),  // sinus rhythm resumes on its original
    ],                                           // schedule: 3200 - 1600 = 1600ms = 2 normal
                                                 // RR intervals → fully compensatory pause
  },

  pacs: {
    id: 'pacs',
    label: 'Premature atrial contractions (PACs)',
    description:
      'An ectopic focus elsewhere in the atria occasionally fires early — producing a P wave with a subtly different shape than the sinus P (it spreads outward along a different path through the atria) but a completely normal-looking QRS-T, since conduction below the atria is unaffected. The key contrast with PVCs: this impulse DOES reach and reset the SA node, so the pause that follows is brief and "non-compensatory" — the next sinus beat lands close to its expected time rather than waiting out a full extra cycle. Watch for the early beat\'s slightly different P wave and the shorter-than-PVC pause that follows.',
    heartRateBpm: 75,
    cycleMs: 3200,
    measurable: false,
    waves: [
      ...placeBeat(0,    NORMAL_BEAT_TEMPLATE),               // two normal sinus beats at the
      ...placeBeat(800,  NORMAL_BEAT_TEMPLATE),               // regular underlying rate (800ms)
      ...placeBeat(1500, PAC_P_TEMPLATE),                     // PAC's P wave fires early — only
      ...placeBeat(1500 + 145, [                              // 700ms after the last beat — with
        { name: 'Q', amplitude: -0.10, center: 0,  sigma: 8,  axisDeg: 60 }, // a normal QRS-T riding right behind it
        { name: 'R', amplitude:  1.20, center: 18, sigma: 12, axisDeg: 60 },
        { name: 'S', amplitude: -0.25, center: 35, sigma: 10, axisDeg: 60 },
        { name: 'T', amplitude:  0.30, center: 245, sigma: 48, axisDeg: 45 },
      ]),
      ...placeBeat(2400, NORMAL_BEAT_TEMPLATE),               // resumes 900ms later — a brief,
    ],                                                        // NON-compensatory pause (900ms,
  },                                                          // not a full 1600ms compensatory one)

  mobitzI: {
    id: 'mobitzI',
    label: '2nd-degree AV block — Mobitz I (Wenckebach)',
    description:
      "The AV node conducts each successive atrial impulse a little more slowly than the last — the PR interval visibly lengthens, beat after beat — until one impulse finally fails to make it through at all (a P wave with no QRS behind it: a 'dropped' beat). The node then recovers, the next PR interval snaps back to its shortest value, and the whole progressive pattern repeats — a distinctive 'grouped beating' rhythm. That progressive lengthening, visible only by comparing several consecutive beats (never on any single beat alone), is exactly what separates this from Mobitz II.",
    heartRateBpm: 75,
    cycleMs: 2400,
    measurable: false,
    waves: [
      // The atria fire on a steady, regular schedule — every 600 ms (100 bpm) —
      // completely unaware that the AV node below is struggling to keep up:
      ...placeBeat(0,    ATRIAL_P_TEMPLATE),
      ...placeBeat(600,  ATRIAL_P_TEMPLATE),
      ...placeBeat(1200, ATRIAL_P_TEMPLATE),
      ...placeBeat(1800, ATRIAL_P_TEMPLATE),  // ← conducts to NOTHING: the dropped beat
      // ...but each one takes longer to conduct through than the last:
      ...placeBeat(160,  NARROW_QRS_T_TEMPLATE),  // PR ≈ 160 ms (shortest — node just "rested")
      ...placeBeat(820,  NARROW_QRS_T_TEMPLATE),  // PR ≈ 220 ms (longer...)
      ...placeBeat(1480, NARROW_QRS_T_TEMPLATE),  // PR ≈ 280 ms (longer still — about to fail)
      // (the 4th P wave at 1800 has no QRS following — conduction failed completely;
      //  the cycle then restarts with a short PR again, as if nothing happened)
    ],
  },

  mobitzII: {
    id: 'mobitzII',
    label: '2nd-degree AV block — Mobitz II',
    description:
      "Conducted beats here look completely normal and identical to one another — the PR interval is fixed, with no lengthening and no warning sign of trouble. But every so often, an atrial impulse simply fails to conduct through the AV node at all, and a QRS is dropped without notice (a P wave with nothing behind it). Because there's no progressive PR lengthening to telegraph the coming block — the defining contrast with Mobitz I/Wenckebach — this pattern is considered more dangerous clinically: it can progress to complete heart block suddenly and with little warning.",
    heartRateBpm: 67,
    cycleMs: 1800,
    measurable: false,
    waves: [
      // Atria fire on a steady 600ms (100bpm) schedule, same as Wenckebach above —
      // the difference is entirely in how the AV node responds to them:
      ...placeBeat(0,    ATRIAL_P_TEMPLATE),
      ...placeBeat(600,  ATRIAL_P_TEMPLATE),
      ...placeBeat(1200, ATRIAL_P_TEMPLATE),  // ← conducts to NOTHING: sudden, unannounced drop
      // The two beats that DO conduct have IDENTICAL PR intervals — no warning:
      ...placeBeat(160,  NARROW_QRS_T_TEMPLATE),  // PR ≈ 160 ms
      ...placeBeat(760,  NARROW_QRS_T_TEMPLATE),  // PR ≈ 160 ms — exactly the same as before
    ],
  },

  atrialFibrillation: {
    id: 'atrialFibrillation',
    label: 'Atrial fibrillation',
    description:
      'Multiple chaotic electrical circuits sweep through the atria simultaneously — too disorganized to ever produce a real, repeatable P wave. Instead the baseline becomes a fine, irregular fibrillatory ripple. The AV node, bombarded by this chaos, lets an unpredictable subset of impulses through to the ventricles — producing the hallmark of this rhythm: an "irregularly irregular" ventricular response, where no two beat-to-beat (RR) intervals match and no pattern ever emerges, no matter how long you watch. (Contrast this with atrial flutter\'s 2:1 conduction above — same disorganized atria, but flutter\'s reentrant circuit is at least organized enough to produce a fixed conduction ratio and a regular ventricular rate; AFib has neither.)',
    heartRateBpm: 90,
    cycleMs: 4000,
    measurable: false,
    waves: [
      ...buildFibrillatoryBaseline(4000),          // chaotic fibrillatory baseline —
                                                    // replaces P waves entirely
      ...placeBeat(50,   NARROW_QRS_T_TEMPLATE),    // QRS complexes land at unpredictable,
      ...placeBeat(700,  NARROW_QRS_T_TEMPLATE),    // ever-changing intervals — 650, 750,
      ...placeBeat(1450, NARROW_QRS_T_TEMPLATE),    // 700, 650, 700, 550(wrap) ms — no two
      ...placeBeat(2150, NARROW_QRS_T_TEMPLATE),    // alike, no pattern, ever
      ...placeBeat(2800, NARROW_QRS_T_TEMPLATE),
      ...placeBeat(3500, NARROW_QRS_T_TEMPLATE),
    ],
  },

  // ─────────────────────────────────────────────────────────────────────
  // ventricularPaced — a "device rhythm": not a disturbance the heart's
  // own conduction system produces, but evidence of a man-made one taking
  // over for it. Structurally this is actually simpler than the rest of
  // this Tier-2 section — it's one shape repeating on a steady schedule,
  // just like the Tier-1 rhythms at the top of this file, with no
  // placeBeat() macro-cycle needed. It lives down here, and is flagged
  // `measurable: false`, for a single reason: it has no native P wave for
  // measureIntervals() to find — the device, not the SA node, launches
  // every beat — so a "PR interval" simply doesn't exist to measure.
  // ─────────────────────────────────────────────────────────────────────
  ventricularPaced: {
    id: 'ventricularPaced',
    label: 'Ventricular-paced rhythm (pacemaker)',
    description:
      "An implanted pacemaker steps in when the heart's own conduction system can't reliably start or carry a beat. Each one begins with a sharp, narrow 'pacer spike' — the device's electrical stimulus, an artificial signal with no biological counterpart, often barely visible as anything more than a thin vertical tick. Because that impulse starts at the lead's tip (typically in the right ventricle) and has to spread through the heart muscle the slow way — cell to cell, not via the fast Purkinje network — every paced beat produces a wide, bizarre QRS with a discordant T wave, much like a bundle branch block or a PVC. And notice what's missing just as much as what's present: there's no native P wave before it. The device, not the SA node, is what launches every single beat.",
    heartRateBpm: 70,
    measurable: false,
    waves: [
      // Spike's axisDeg is arbitrary (0°) — it's a man-made electrical
      // artifact, not a biological deflection, so it has no physiological
      // "direction" for a lead to project; Q/R/S get a leftward axis (-75°)
      // typical of pacing from a right-ventricular-apex lead tip, and T is
      // discordant (roughly opposite the QRS axis), same convention as the
      // other wide-complex rhythms above (lbbb, rbbb, pvcs).
      { name: 'Spike', amplitude:  2.50, center: 190, sigma:  2, axisDeg:    0 }, // the pacer artifact: tall,
                                                                    // razor-narrow — nothing
                                                                    // the heart itself produces
                                                                    // looks like this
      { name: 'Q',     amplitude: -0.20, center: 215, sigma: 18, axisDeg: -75 }, // wide ventricular complex —
      { name: 'R',     amplitude:  0.85, center: 260, sigma: 26, axisDeg: -75 }, // slow cell-to-cell spread,
      { name: 'S',     amplitude: -0.30, center: 315, sigma: 22, axisDeg: -75 }, // not fast Purkinje conduction
      { name: 'T',     amplitude:  0.40, center: 500, sigma: 65, axisDeg:  105 }, // — and a discordant T wave
    ],                                                              // (no P wave precedes any of it)
  },
}

// Display order for selectors — independent of object-key iteration order,
// and groups related rhythms together (normal → rate variants → conduction
// defects → irregular/Tier-2 rhythms).
export const RHYTHM_ORDER = [
  'normalSinus',
  'sinusTachycardia',
  'sinusBradycardia',
  'firstDegreeBlock',
  'lbbb',
  'rbbb',
  'thirdDegreeBlock',
  'atrialFlutter',
  'pvcs',
  'pacs',
  'mobitzI',
  'mobitzII',
  'atrialFibrillation',
  'ventricularPaced',
]

// Converts a heart rate (beats per minute) into a cycle length (ms).
// 75 bpm → 800 ms per beat.
export function cycleLengthMs(heartRateBpm) {
  return 60000 / heartRateBpm
}

// Bazett's formula relates the QT interval to heart rate:
//   QTc = QT / sqrt(RR in seconds)   ⇒   QT = QTc * sqrt(RR in seconds)
// A "normal" corrected QT (QTc) is roughly 400 ms regardless of rate — but
// the *raw* QT shortens at fast heart rates and lengthens at slow ones.
// This gives us a rate-aware expected QT to compare each rhythm against,
// instead of a single fixed number that's only valid at ~60 bpm.
export function expectedQtMs(heartRateBpm, qtcMs = 400) {
  const rrSeconds = cycleLengthMs(heartRateBpm) / 1000
  return qtcMs * Math.sqrt(rrSeconds)
}

// Sums every wave's contribution at a given time within ONE cycle, AS SEEN
// BY A SPECIFIC LEAD. `waves` is an array of { amplitude, center, sigma,
// axisDeg } objects (see NORMAL_SINUS_WAVES above for what each means).
//
// Each wave's Gaussian envelope — its time-varying magnitude, calculated
// exactly as before — gets multiplied by a single, TIME-INDEPENDENT
// projectionFactor before being added to the total. That factor depends only
// on the angle between where the deflection points (`axisDeg`) and which way
// the lead is looking (`leadAxisDeg`); because that angle never changes
// during one deflection, the projection just scales (and possibly inverts)
// the whole Gaussian shape uniformly — it doesn't distort it.
//
// `leadAxisDeg` defaults to Lead I's axis (0°) so any code that doesn't care
// about leads (e.g. measureIntervals' callers, or a wave with no `axisDeg`
// of its own) keeps behaving exactly as it did before this function learned
// about leads at all.
export function cycleVoltage(tInCycleMs, waves, leadAxisDeg = LEADS.I.axisDeg) {
  return waves.reduce((total, wave) => {
    const sourceAxisDeg = wave.axisDeg ?? LEADS.I.axisDeg
    const envelope      = gaussian(tInCycleMs, wave.amplitude, wave.center, wave.sigma)
    return total + envelope * projectionFactor(sourceAxisDeg, leadAxisDeg)
  }, 0)
}

// ─────────────────────────────────────────────────────────────────────────
// "Naturalness" layer — ekgNoise() and warpTime()
//
// A textbook-perfect Gaussian sum repeats EXACTLY the same shape on EXACTLY
// the same schedule forever, which reads as artificial — real hearts aren't
// metronomes, and real electrical traces aren't perfectly clean. These two
// helpers add a bit of organic imperfection back in.
//
// The constraint that shapes both of them: the canvas does NOT remember
// previously-drawn pixels and scroll them leftward. Every frame, drawWaveform
// redraws the ENTIRE visible window from scratch by calling ekgVoltage() at
// each pixel's corresponding timestamp (see EKGWaveformPrototype.jsx). That
// means the SAME instant in time gets re-sampled on every single frame as it
// crosses the canvas. If ekgVoltage() returned something different each time
// for the same `elapsedMs` — e.g. by calling Math.random() — the trace would
// "boil": every redraw would jitter the already-drawn portion of the strip
// instead of smoothly scrolling it.
//
// So instead of true randomness, both helpers use a classic "value noise"
// trick: sum a handful of sine waves whose frequencies share no common
// factor. The combined wave never repeats on any human timescale and looks
// organic and irregular — but for any given `tMs`, it always evaluates to
// exactly the same number. That keeps ekgVoltage a pure function of time,
// which is what makes the whole engine scrubbable and synchronizable in the
// first place (see the file header and ekgVoltage's own comment below).
// ─────────────────────────────────────────────────────────────────────────

// A small amount of high-frequency "fuzz" riding on top of the clean signal —
// the everyday texture every real EKG trace has from muscle tremor, electrode
// contact, and tiny ambient interference. Amplitudes are in millivolts and
// deliberately tiny (this should read as "texture", not "static").
function ekgNoise(tMs) {
  return (
    0.012 * Math.sin(tMs * 0.0157 + 1.7) +
    0.008 * Math.sin(tMs * 0.0421 + 4.1) +
    0.005 * Math.sin(tMs * 0.1093 + 0.3)
  )
}

// Nudges the time axis forward and backward by a few tens of milliseconds,
// drifting slowly and irregularly over many seconds. Feeding this "warped"
// time into the cycle sampler — instead of raw elapsed time — is what makes
// beat-to-beat spacing breathe in and out rather than land on the exact same
// millisecond every cycle: real heart rate is never perfectly constant, even
// at rest (this is "heart rate variability" — part reflex, part just the
// natural noisiness of a biological pacemaker).
//
// The wobble amplitude (~±40 ms total) is deliberately small relative to even
// the shortest clinically-meaningful interval (a PR interval is ~150 ms) —
// enough to feel "alive" without smearing the carefully-tuned wave shapes, or
// distorting the deliberate timing relationships baked into the Tier-2
// macro-cycles (e.g. a PVC's compensatory pause).
function warpTime(tMs) {
  return (
    tMs +
    30 * Math.sin(tMs * 0.00073 + 0.9) +
    12 * Math.sin(tMs * 0.00211 + 3.4)
  )
}

// The function the scrolling strip calls every frame: voltage (mV) at any
// elapsed time, looping the single-cycle waveform forever via the modulo
// operator. `waves` are defined relative to one cycle of length `cycleMs`,
// and `leadAxisDeg` (passed straight through to cycleVoltage — see its
// comment for the lead-projection math) selects which lead is "looking".
//
// The double-modulo (`((x % n) + n) % n`) keeps the result positive even
// when elapsedMs is negative — handy if we ever scrub the strip backwards.
//
// Two "naturalness" touches are layered on here (see the big comment block
// above for why both have to be deterministic functions of time rather than
// genuinely random): warpTime() nudges WHERE in the cycle we sample from, so
// beat timing drifts slightly rather than repeating like a metronome, and
// ekgNoise() adds a bit of organic fuzz on top of the clean summed voltage.
// (Noise is added AFTER projection — it represents ambient electrical
// interference picked up at the electrode, not a real cardiac source with
// its own axis, so every lead picks up the same texture.)
export function ekgVoltage(elapsedMs, cycleMs, waves, leadAxisDeg = LEADS.I.axisDeg) {
  const warpedMs = warpTime(elapsedMs)
  const tInCycle = ((warpedMs % cycleMs) + cycleMs) % cycleMs
  return cycleVoltage(tInCycle, waves, leadAxisDeg) + ekgNoise(elapsedMs)
}

// ─────────────────────────────────────────────────────────────────────────
// measureIntervals — derives the clinically-meaningful intervals (PR, QRS,
// QT) directly from the wave parameters above, using "center ± 2*sigma" as
// each wave's onset/offset. This is what lets us tune the five Gaussians by
// checking printed numbers against the B&B reference ranges instead of
// just eyeballing the curve.
//
// Assumes `waves` contains entries named 'P', 'Q', 'R', 'S', 'T'.
// ─────────────────────────────────────────────────────────────────────────
export function measureIntervals(waves) {
  const byName = Object.fromEntries(waves.map(w => [w.name, w]))
  const onset  = w => w.center - 2 * w.sigma
  const offset = w => w.center + 2 * w.sigma

  const pOnset    = onset(byName.P)
  const qrsOnset  = onset(byName.Q)
  const qrsOffset = offset(byName.S)
  const tOffset   = offset(byName.T)

  return {
    prIntervalMs:  qrsOnset - pOnset,
    qrsDurationMs: qrsOffset - qrsOnset,
    qtIntervalMs:  tOffset - qrsOnset,
  }
}
