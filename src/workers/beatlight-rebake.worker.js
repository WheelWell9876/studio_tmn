/* eslint-disable no-restricted-globals */
/**
 * @file beatlight-rebake.worker.js — offline re-bake of the pre-baked DMX
 *       track when the user re-labels timeline sections via the
 *       SectionRelabelPanel.
 *
 * Lazy-loaded: spawned only when the user actually re-labels a section, so
 * the cue-engine bundle (~30 KB gz) doesn't tax cold-start time.
 *
 * Message protocol:
 *   { type: 'rebake', timeline, stage, knobs }
 *     - Re-runs the cue-engine across all ticks at the same TICK_RATE_HZ
 *       used by the show-builder pre-bake.
 *     - Replies with `{type:'rebaked', frames}` where `frames` is a
 *       transferable Uint8Array — avoids the base64 round-trip.
 *
 * Re-bake is purely a function of (timeline, stage, knobs) — no live data
 * involvement (live overlay is a separate runtime concern).
 */

import {
  DEFAULT_TUNING,
  TICK_RATE_HZ,
  TOTAL_CHANNELS,
  buildContext,
  makeFeatureGetter,
  tick,
} from '@beatlight/cue-engine';

self.addEventListener('message', (e) => {
  const data = e.data;
  if (!data || data.type !== 'rebake') return;
  const { timeline, stage } = data;
  if (!timeline || !stage) {
    self.postMessage({ type: 'error', message: 'rebake requires timeline + stage' });
    return;
  }
  const knobs = { ...DEFAULT_TUNING, ...(data.knobs || {}) };
  const totalTicks = Math.ceil(timeline.track.duration_seconds * TICK_RATE_HZ);
  const buffer = new Uint8Array(totalTicks * TOTAL_CHANNELS);
  const feature = makeFeatureGetter(timeline);
  for (let i = 0; i < totalTicks; i += 1) {
    const t = i / TICK_RATE_HZ;
    const ctx = buildContext({
      timeline,
      stage,
      t,
      feature,
      knobs,
    });
    const frame = tick(ctx);
    buffer.set(frame.channels, i * TOTAL_CHANNELS);
  }
  // Transfer ownership of the underlying ArrayBuffer to the bridge to avoid
  // a copy of the (potentially ~28 MB) result.
  self.postMessage(
    { type: 'rebaked', totalTicks, frames: buffer.buffer },
    [buffer.buffer],
  );
});
