/* eslint-disable no-restricted-globals */
/**
 * @file beatlight-cue.worker.js — pre-baked DMX frame lookup with live overlay.
 *
 * Message protocol:
 *   { type: 'init', show }
 *     - Decodes show.pre_baked_dmx.frames_b64 once into a Uint8Array.
 *     - Stashes timeline, stage, knobs (defaulting to DEFAULT_TUNING) for
 *       the live-overlay tick path.
 *
 *   { type: 'tick', t, live? }
 *     - `live` is a LiveFeatures snapshot from MeydaService; defaults to
 *       ZERO_LIVE when absent (Prompt-2 lookup-only behaviour).
 *     - Looks up the baked frame at index Math.floor(t * rate).
 *     - Calls tickLive(ctx) and HTP-merges with the baked frame, scaling
 *       the live frame by knobs.liveOverlayStrength first.
 *     - Posts the resulting 2048-byte frame back as a transferable.
 *
 *   { type: 'set-knobs', knobs }
 *     - Partial knob update (e.g. from the Tuning Knobs Panel or background
 *       calibration). Merged into the stashed knobs, next tick uses new
 *       values.
 *
 *   { type: 'replace-prebake', frames_b64 }
 *     - Section relabel re-bake — swaps the baked buffer mid-playback.
 *
 * Live-overlay math is HTP (highest takes precedence): the live frame can
 * only raise a channel above its baked value, never lower it. This keeps the
 * pre-bake as a deterministic floor and adds reactive sparkle on top.
 */

import {
  DEFAULT_TUNING,
  buildContext,
  tickLive,
} from '@beatlight/cue-engine';

let baked = null;
let rateHz = 44;
let channelCount = 2048;
let totalTicks = 0;
let timeline = null;
let stage = null;
let knobs = DEFAULT_TUNING;

function base64ToUint8Array(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

function applyPrebake(input) {
  if (input instanceof Uint8Array) {
    baked = input;
  } else if (input instanceof ArrayBuffer) {
    baked = new Uint8Array(input);
  } else if (typeof input === 'string') {
    baked = base64ToUint8Array(input);
  } else {
    return;
  }
  totalTicks = Math.floor(baked.length / channelCount);
}

self.addEventListener('message', (e) => {
  const data = e.data;
  if (!data || !data.type) return;

  if (data.type === 'init') {
    const show = data.show;
    const dmx = show && show.pre_baked_dmx;
    if (!dmx) {
      self.postMessage({ type: 'error', message: 'show.pre_baked_dmx missing' });
      return;
    }
    rateHz = dmx.rate_hz || 44;
    channelCount = dmx.channel_count || 2048;
    applyPrebake(dmx.frames_b64);
    timeline = show.timeline || null;
    stage = show.stage || null;
    // Prompt-2-era shows have no `knobs`; merge any caller-provided onto the
    // schema defaults so partial overrides are well-defined.
    knobs = { ...DEFAULT_TUNING, ...(show.knobs || {}) };
    self.postMessage({ type: 'ready', totalTicks, rateHz, channelCount });
    return;
  }

  if (data.type === 'set-knobs') {
    if (data.knobs && typeof data.knobs === 'object') {
      knobs = { ...knobs, ...data.knobs };
    }
    return;
  }

  if (data.type === 'replace-prebake') {
    if (data.frames) {
      applyPrebake(data.frames);
    } else if (typeof data.frames_b64 === 'string') {
      applyPrebake(data.frames_b64);
    } else {
      return;
    }
    if (data.timeline) timeline = data.timeline;
    self.postMessage({ type: 'rebaked', totalTicks });
    return;
  }

  if (data.type === 'tick') {
    if (!baked) return;
    const t = typeof data.t === 'number' ? data.t : 0;
    let idx = Math.floor(t * rateHz);
    if (idx < 0) idx = 0;
    if (idx >= totalTicks) idx = totalTicks - 1;
    const start = idx * channelCount;

    const out = new Uint8Array(channelCount);
    out.set(baked.subarray(start, start + channelCount));

    // Live overlay path — only when timeline + stage are stashed (they are
    // after init; this guards against `tick` arriving before init lands).
    const live = data.live || null;
    const haveLive =
      live && (live.rms || live.low || live.flux || live.mid || live.highMid);
    if (haveLive && timeline && stage) {
      const ctx = buildContext({
        timeline,
        stage,
        t,
        live,
        knobs,
      });
      const frame = tickLive(ctx);
      const strength = knobs.liveOverlayStrength;
      if (strength > 0) {
        const liveBytes = frame.channels;
        for (let i = 0; i < channelCount; i += 1) {
          // Scale + round-with-bias: (x*s + 0.5) | 0 is ~3× faster than
          // Math.round per byte and equivalent for non-negative inputs.
          const l = (liveBytes[i] * strength + 0.5) | 0;
          if (l > out[i]) out[i] = l;
        }
      }
    } else if (haveLive && (!timeline || !stage)) {
      // tick fired before init completed — ignore the live overlay this
      // frame; the baked frame still posts so playback doesn't stall.
    }

    // Post in the existing v1 envelope so BeatlightAdapter.applyFrame
    // contracts don't change.
    const buf = out.buffer;
    self.postMessage({ type: 'frame', t, idx, buffer: buf }, [buf]);
  }
});
