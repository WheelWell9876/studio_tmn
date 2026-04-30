/* eslint-disable no-restricted-globals */
/**
 * @file beatlight-cue.worker.js — pre-baked DMX frame lookup worker.
 *
 * v1 message protocol:
 *   { type: 'init', show }
 *     - Decodes show.pre_baked_dmx.frames_b64 once into a Uint8Array.
 *     - Stashes rate, channelCount, totalTicks for fast lookup.
 *
 *   { type: 'tick', t }
 *     - Look up the frame at index Math.floor(t * rate). Posts the 2048-byte
 *       channels slice back as a transferable ArrayBuffer.
 *
 * v1 is lookup-only — no `tick(ctx)` invocation, no live overlay. Prompt 3
 * adds the live merge path; the cue-engine `tick` import is wired here so
 * Prompt 3 can flip the switch without a structural rewrite.
 */

// eslint-disable-next-line no-unused-vars
import { tick } from '@beatlight/cue-engine';

let baked = null;
let rateHz = 44;
let channelCount = 2048;
let totalTicks = 0;

function base64ToUint8Array(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

self.addEventListener('message', (e) => {
  const data = e.data;
  if (!data || !data.type) return;

  if (data.type === 'init') {
    const dmx = data.show && data.show.pre_baked_dmx;
    if (!dmx) {
      self.postMessage({ type: 'error', message: 'show.pre_baked_dmx missing' });
      return;
    }
    baked = base64ToUint8Array(dmx.frames_b64);
    rateHz = dmx.rate_hz || 44;
    channelCount = dmx.channel_count || 2048;
    totalTicks = Math.floor(baked.length / channelCount);
    self.postMessage({ type: 'ready', totalTicks, rateHz, channelCount });
    return;
  }

  if (data.type === 'tick') {
    if (!baked) return;
    const t = typeof data.t === 'number' ? data.t : 0;
    let idx = Math.floor(t * rateHz);
    if (idx < 0) idx = 0;
    if (idx >= totalTicks) idx = totalTicks - 1;
    // Copy into a fresh ArrayBuffer so we can transfer ownership and
    // avoid corrupting the master baked buffer.
    const start = idx * channelCount;
    const buf = new ArrayBuffer(channelCount);
    new Uint8Array(buf).set(baked.subarray(start, start + channelCount));
    self.postMessage({ type: 'frame', t, idx, buffer: buf }, [buf]);
  }
});
