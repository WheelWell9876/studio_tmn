/**
 * @file MeydaService — real-time Web Audio analyser that produces a
 *       cue-engine-shaped `LiveFeatures` snapshot at ~86 Hz (FFT 1024 / hop
 *       512 @ 44.1 kHz).
 *
 * Per Plan 19 §B2/B3 and §16.1 / §16.4 of the impl plan.
 *
 * Public surface:
 *   - attach(audioEl, audioContext)   wires Meyda onto a playing HTMLAudioElement
 *   - detach()                        tears down nodes; safe to call multiple times
 *   - read()                          last analyser frame as cloned `LiveFeatures`
 *   - calibrateBoost(opts)            background calibration → Promise<number>
 *   - cancelCalibration()             user-override hook (Tuning Knobs Panel)
 *
 * Bands → LiveFeatures (Bark spectrum has 24 bands):
 *
 *   sub     band 0       ≈ 0–100 Hz   (closest fit for the 20–60 Hz target)
 *   low     bands 0–1    ≈ 0–200
 *   lowMid  bands 2–4    ≈ 200–510
 *   mid     bands 5–12   ≈ 510–2000
 *   highMid bands 13–18  ≈ 2000–5300
 *   high    bands 19–22  ≈ 5300–12000
 *
 * Meyda's `loudness.specific` returns sone-like values per band; we sum
 * within a range and divide by an empirical cap (`BARK_BAND_REF`) to land
 * roughly in [0, 1] for typical music. `liveBoost` (per-song calibration)
 * does the rest of the work.
 */

import Meyda from 'meyda';

/** Inclusive band ranges for each LiveFeatures bucket. */
const BAND_RANGES = {
  sub: [0, 0],
  low: [0, 1],
  lowMid: [2, 4],
  mid: [5, 12],
  highMid: [13, 18],
  high: [19, 22],
};

/**
 * Per-band loudness divisor. Bark loudness bands typically read 0–30 sones
 * for moderate music; this brings the bucket sum into ~[0, 1] so liveBoost
 * × 2 is a sensible default. Per-song calibration overrides if needed.
 */
const BARK_BAND_REF = 12;

const ZERO_SNAPSHOT = {
  rms: 0,
  centroid: 0,
  flux: 0,
  sub: 0,
  low: 0,
  lowMid: 0,
  mid: 0,
  highMid: 0,
  high: 0,
};

function clamp01(x) {
  if (!Number.isFinite(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

function bandAvg(specific, [start, end]) {
  let sum = 0;
  for (let i = start; i <= end; i += 1) sum += specific[i] || 0;
  const count = end - start + 1;
  return sum / count;
}

class MeydaService {
  constructor() {
    /** @type {AudioContext|null} */
    this._audioContext = null;
    /** @type {MediaElementAudioSourceNode|null} */
    this._source = null;
    /** @type {ReturnType<typeof Meyda.createMeydaAnalyzer>|null} */
    this._analyzer = null;
    /** @type {HTMLAudioElement|null} */
    this._audioEl = null;
    /** Latest analysed snapshot. Reset to ZERO_SNAPSHOT on detach. */
    this._latest = { ...ZERO_SNAPSHOT };
    /** Calibration sample buffer (rolling). */
    this._calSamples = [];
    /** Calibration in-flight resolver, if any. */
    this._calResolve = null;
    /** Calibration timer id. */
    this._calTimer = null;
    /** Set true when user manually overrides liveBoost — cancels active calibration. */
    this._userOverride = false;
  }

  get isAttached() {
    return this._analyzer != null;
  }

  /**
   * Wire Meyda onto a playing HTMLAudioElement. Construct the AudioContext
   * inside the same user-gesture call chain that handled the file pick so
   * autoplay rules are satisfied. Resumes a suspended context.
   */
  async attach(audioEl, audioContext) {
    if (this._analyzer) this.detach();
    this._audioEl = audioEl;
    this._audioContext = audioContext || new AudioContext();
    if (this._audioContext.state === 'suspended') {
      try {
        await this._audioContext.resume();
      } catch (err) {
        // Autoplay policy may still block — surfacing to the caller via
        // analyser absence is enough; the bridge falls back to ZERO_LIVE.
        // eslint-disable-next-line no-console
        console.warn('[MeydaService] AudioContext resume rejected', err);
      }
    }
    // createMediaElementSource throws if the element already has a source —
    // catch and reuse if possible (only one source per element per context).
    try {
      this._source = this._audioContext.createMediaElementSource(audioEl);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[MeydaService] reusing existing media-element source', err);
      // No reliable way to recover the existing source; bail out. The bridge
      // will read ZERO_LIVE.
      return;
    }
    // Fan out so audio still reaches speakers AND the analyser.
    this._source.connect(this._audioContext.destination);

    this._analyzer = Meyda.createMeydaAnalyzer({
      audioContext: this._audioContext,
      source: this._source,
      bufferSize: 1024,
      featureExtractors: ['rms', 'spectralCentroid', 'spectralFlux', 'loudness'],
      callback: (features) => this._onFeatures(features),
    });
    this._analyzer.start();
  }

  detach() {
    this.cancelCalibration();
    if (this._analyzer) {
      try { this._analyzer.stop(); } catch (_) { /* noop */ }
      this._analyzer = null;
    }
    if (this._source) {
      try { this._source.disconnect(); } catch (_) { /* noop */ }
      this._source = null;
    }
    if (this._audioContext) {
      try { this._audioContext.close(); } catch (_) { /* noop */ }
      this._audioContext = null;
    }
    this._audioEl = null;
    this._latest = { ...ZERO_SNAPSHOT };
  }

  /** Returns a *cloned* snapshot — workers post structured-clone, mutate freely. */
  read() {
    return { ...this._latest };
  }

  _onFeatures(features) {
    if (!features) return;
    const specific =
      features.loudness && features.loudness.specific
        ? features.loudness.specific
        : null;
    const sub = specific ? bandAvg(specific, BAND_RANGES.sub) / BARK_BAND_REF : 0;
    const low = specific ? bandAvg(specific, BAND_RANGES.low) / BARK_BAND_REF : 0;
    const lowMid = specific ? bandAvg(specific, BAND_RANGES.lowMid) / BARK_BAND_REF : 0;
    const mid = specific ? bandAvg(specific, BAND_RANGES.mid) / BARK_BAND_REF : 0;
    const highMid = specific ? bandAvg(specific, BAND_RANGES.highMid) / BARK_BAND_REF : 0;
    const high = specific ? bandAvg(specific, BAND_RANGES.high) / BARK_BAND_REF : 0;

    // spectralCentroid is reported in FFT bin index (0..bufferSize/2). Divide
    // by Nyquist bin to get 0..1.
    const centroid = clamp01(
      (features.spectralCentroid || 0) / (1024 / 2),
    );

    this._latest = {
      rms: clamp01(features.rms || 0),
      centroid,
      flux: Math.max(0, features.spectralFlux || 0),
      sub: clamp01(sub),
      low: clamp01(low),
      lowMid: clamp01(lowMid),
      mid: clamp01(mid),
      highMid: clamp01(highMid),
      high: clamp01(high),
    };

    // Record into the calibration buffer if active.
    if (this._calResolve) {
      this._calSamples.push({
        t: this._audioEl ? this._audioEl.currentTime : 0,
        low: this._latest.low,
      });
    }
  }

  /**
   * Background calibration: sample `live.low` for `windowSeconds` of real
   * playback, return a `liveBoost` value that puts the 90th-percentile of
   * `live.low * boost` at `target`. Section-aware: if the loaded show's
   * timeline has `drop` or `chorus` sections within the window, only those
   * samples count. Clamped to [0.5, 5.0].
   *
   * Returns a Promise that resolves with the boost. If the user manually
   * changes `liveBoost` mid-calibration, the Promise rejects with
   * `Error('user-override')`.
   *
   * @param {Object}   opts
   * @param {number}  [opts.windowSeconds=10]  rolling sample window
   * @param {number}  [opts.target=0.7]        target p90 of low*boost
   * @param {number}  [opts.percentile=0.9]    percentile to fit
   * @param {Object}  [opts.timeline]          section-aware refinement input
   * @returns {Promise<number>}
   */
  calibrateBoost({
    windowSeconds = 10,
    target = 0.7,
    percentile = 0.9,
    timeline = null,
  } = {}) {
    this.cancelCalibration();
    this._userOverride = false;
    this._calSamples = [];

    return new Promise((resolve, reject) => {
      this._calResolve = resolve;
      this._calTimer = setTimeout(() => {
        const samples = this._calSamples;
        this._calSamples = [];
        this._calTimer = null;
        const wasResolve = this._calResolve;
        this._calResolve = null;
        if (this._userOverride) {
          reject(new Error('user-override'));
          return;
        }
        const boost = computeBoost({
          samples,
          target,
          percentile,
          timeline,
        });
        wasResolve(boost);
      }, Math.max(1, windowSeconds) * 1000);
    });
  }

  /** Mark the active calibration as overridden — cancels its timer. */
  cancelCalibration() {
    this._userOverride = true;
    if (this._calTimer) {
      clearTimeout(this._calTimer);
      this._calTimer = null;
    }
    if (this._calResolve) {
      const r = this._calResolve;
      this._calResolve = null;
      this._calSamples = [];
      // Resolve with `null` rather than reject so callers can use a single
      // `.then(boost => ...)` path; null = no-op (don't update knobs).
      r(null);
    }
  }
}

function percentile(values, p) {
  if (values.length === 0) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const idx = Math.min(
    sorted.length - 1,
    Math.max(0, Math.floor(p * sorted.length)),
  );
  return sorted[idx];
}

/**
 * Compute the `liveBoost` value from a sample window. Section-aware: prefers
 * samples falling inside a `drop` or `chorus` if any are available — those
 * sections have the hot per-band distribution we actually want to calibrate
 * against, so a quiet intro doesn't trap the boost too high.
 */
export function computeBoost({ samples, target, percentile: p, timeline }) {
  if (!samples || samples.length === 0) return 2.0;

  let lows = samples.map((s) => s.low);
  if (timeline && Array.isArray(timeline.sections) && timeline.sections.length > 0) {
    const hot = samples.filter((s) =>
      timeline.sections.some(
        (sec) =>
          s.t >= sec.start
          && s.t < sec.end
          && (sec.kind === 'drop' || sec.kind === 'chorus'),
      ),
    );
    if (hot.length >= 8) {
      lows = hot.map((s) => s.low);
    }
  }

  const p90 = percentile(lows, p);
  const raw = target / Math.max(p90, 0.05);
  return Math.min(5.0, Math.max(0.5, raw));
}

const meydaService = new MeydaService();
export default meydaService;
