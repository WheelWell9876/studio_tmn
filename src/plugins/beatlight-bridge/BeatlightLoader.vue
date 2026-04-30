<template>
  <uk-flex
    center-v
    class="beatlight_loader"
  >
    <button
      class="beatlight_button"
      :disabled="busy"
      @click="pickShow"
    >
      {{ buttonLabel }}
    </button>
    <button
      v-if="show"
      class="beatlight_button beatlight_button_secondary"
      :disabled="busy"
      @click="loadNewShow"
      title="Tear down current show and load a new one"
    >
      Load New Show
    </button>
    <button
      class="beatlight_button beatlight_button_secondary"
      title="Cycle visualizer quality (low → medium → high). Bloom & god-rays are off at low for max FPS."
      @click="cycleQuality"
    >
      Q: {{ quality }}
    </button>
    <div
      v-if="status"
      class="beatlight_status"
    >
      {{ status }}
    </div>
    <div
      v-if="calibrating"
      class="beatlight_pill"
      title="Sampling live overlay levels — adjusts liveBoost based on the song"
    >
      Calibrating live overlay…
    </div>
    <div
      v-if="calibratedBoost != null && !calibrating"
      class="beatlight_pill beatlight_pill_quiet"
      :title="`Auto-calibrated liveBoost: ${calibratedBoost.toFixed(2)}`"
    >
      boost {{ calibratedBoost.toFixed(2) }}
    </div>
    <div
      v-if="audioEl"
      class="beatlight_playback"
    >
      <span
        class="beatlight_live_dot"
        :style="{ opacity: 0.3 + 0.7 * liveRms }"
        title="Live RMS — pulses with the audio"
      />
      <span class="beatlight_playback_section">
        {{ currentSectionLabel }}
      </span>
      <span
        v-if="timeToNextDrop != null"
        class="beatlight_playback_drop"
      >
        next drop in {{ timeToNextDrop.toFixed(1) }}s
      </span>
    </div>
    <input
      ref="showInput"
      type="file"
      accept=".json"
      hidden
      @change="onShowSelected"
    >
    <input
      ref="audioInput"
      type="file"
      accept="audio/*"
      hidden
      @change="onAudioSelected"
    >
    <button
      v-if="needsPlayClick"
      class="beatlight_play_button"
      @click="resumePlayback"
    >
      ▶ Click to play
    </button>
  </uk-flex>
</template>

<script>
import { markRaw } from 'vue';
import EventBus from '@/plugins/eventbus';
import beatlightAdapter from '@/services/BeatlightAdapter';
import meydaService from '@/services/MeydaService';
import CueWorker from '@/workers/beatlight-cue.worker.js?worker';
import RebakeWorker from '@/workers/beatlight-rebake.worker.js?worker';

/** Smoothly ramp `liveBoost` toward target — caps rate-of-change to ~1/sec. */
const BOOST_RAMP_PER_SEC = 1.0;
const BOOST_RAMP_INTERVAL_MS = 50;
const CALIBRATION_WINDOW_SECONDS = 10;

export default {
  name: 'BeatlightLoader',
  data() {
    return {
      status: '',
      busy: false,
      show: null,
      audioEl: null,
      audioObjectUrl: null,
      audioContext: null,
      worker: null,
      rafHandle: null,
      lastTickIdx: -1,
      ready: false,
      needsPlayClick: false,
      calibrating: false,
      calibratedBoost: null,
      // Playback indicator state (polled, not RAF) — see _startStatusPoll.
      currentTime: 0,
      liveRms: 0,
      // Visualizer quality (bloom + god-rays gating). Hydrated from the
      // visualizer instance once it mounts.
      quality: 'low',
      _liveErrorReported: false,
      _boostRampHandle: null,
      _statusPollHandle: null,
    };
  },
  computed: {
    buttonLabel() {
      if (!this.show) return '1. Pick .show.json';
      if (!this.audioEl) return '2. Pick audio (mp3/wav)';
      return 'Reload audio';
    },
    currentSectionLabel() {
      if (!this.show || !this.show.timeline || !Array.isArray(this.show.timeline.sections)) {
        return '—';
      }
      const t = this.currentTime;
      const sec = this.show.timeline.sections.find(
        (s) => t >= s.start && t < s.end,
      );
      return sec ? sec.kind : '—';
    },
    timeToNextDrop() {
      if (!this.show || !this.show.timeline || !Array.isArray(this.show.timeline.drops)) {
        return null;
      }
      const t = this.currentTime;
      const next = this.show.timeline.drops.find((d) => d.time > t);
      return next ? next.time - t : null;
    },
  },
  mounted() {
    this._onSetKnobs = (partial) => this._postKnobs(partial);
    this._onRecalibrate = () => this._startBackgroundCalibration();
    this._onCancelCal = () => meydaService.cancelCalibration();
    this._onRebake = (payload) => this._handleRebake(payload);
    this._onVisualizerLoaded = () => this._syncQualityFromVisualizer();
    this._currentKnobs = null; // last applied knobs cache, used during rebake
    EventBus.on('beatlight:set-knobs', this._onSetKnobs);
    EventBus.on('beatlight:recalibrate', this._onRecalibrate);
    EventBus.on('beatlight:cancel-calibration', this._onCancelCal);
    EventBus.on('beatlight:rebake', this._onRebake);
    EventBus.on('visualizer_loaded', this._onVisualizerLoaded);
    // Hydrate immediately if visualizer is already mounted (race-safe).
    this._syncQualityFromVisualizer();
    // Expose a small debug surface for Playwright e2e specs and console
    // debugging. Read-only-ish — tests should drive UI, not mutate state
    // directly, but having visibility into the live state helps assertions.
    window.__beatlight = {
      get worker() { return /** @type {any} */ (window.__beatlight)._workerRef || null; },
      get adapter() { return beatlightAdapter; },
      get meyda() { return meydaService; },
      get show() { return /** @type {any} */ (window.__beatlight)._showRef || null; },
      get quality() {
        const viz = (window.$show || {}).visualizerHandle;
        return viz ? viz.quality : null;
      },
    };
  },
  beforeUnmount() {
    EventBus.off('beatlight:set-knobs', this._onSetKnobs);
    EventBus.off('beatlight:recalibrate', this._onRecalibrate);
    EventBus.off('beatlight:cancel-calibration', this._onCancelCal);
    EventBus.off('beatlight:rebake', this._onRebake);
    EventBus.off('visualizer_loaded', this._onVisualizerLoaded);
    this.teardown();
  },
  methods: {
    pickShow() {
      if (this.busy) return;
      if (this.show && !this.audioEl) {
        // Show is loaded, audio next.
        this.$refs.audioInput.click();
        return;
      }
      // Reset state if we already had a show — user wants to load a new one.
      this.teardown().then(() => {
        this.$refs.showInput.click();
      });
    },

    async loadNewShow() {
      if (this.busy) return;
      await this.teardown();
      this.$refs.showInput.click();
    },

    cycleQuality() {
      const order = ['low', 'medium', 'high'];
      const idx = order.indexOf(this.quality);
      const next = order[(idx + 1) % order.length];
      this.quality = next;
      const viz = this.$show && this.$show.visualizerHandle;
      if (viz) viz.quality = next;
    },

    _syncQualityFromVisualizer() {
      const viz = this.$show && this.$show.visualizerHandle;
      if (viz && viz.quality) this.quality = viz.quality;
    },

    async onShowSelected(e) {
      const file = e.target.files && e.target.files[0];
      // Allow re-picking the same file later.
      e.target.value = '';
      if (!file) return;
      this.busy = true;
      this.status = `Reading ${file.name}…`;
      try {
        const text = await file.text();
        const parsed = JSON.parse(text);
        // markRaw prevents Vue 3 from wrapping the show in a reactive
        // Proxy. Reactive proxies are NOT structured-cloneable by
        // postMessage (the worker init step) — Vue's get-trap returns
        // sub-proxies instead of plain values, which the structured-clone
        // algorithm rejects as "could not be cloned".
        this.show = markRaw(parsed);
        this.status = `Patching ${parsed.stage.fixtures.length} fixtures into ${this.universeCount(parsed)} universes…`;
        await beatlightAdapter.loadShow(parsed);
        this.spawnWorker(parsed);
        EventBus.emit('beatlight:show-loaded', {
          knobs: parsed.knobs || null,
          timeline: parsed.timeline,
          trackTitle: (parsed.timeline && parsed.timeline.track && parsed.timeline.track.title) || parsed.title || 'song',
        });
        this.status = 'Show loaded. Pick audio file to start playback.';
        this.busy = false;
        this.$refs.audioInput.click();
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[Beatlight] show load failed', err);
        this.status = `Error loading show: ${err.message || err}`;
        this.busy = false;
        this.show = null;
      }
    },

    async onAudioSelected(e) {
      const file = e.target.files && e.target.files[0];
      e.target.value = '';
      if (!file) return;
      if (!this.show || !this.worker || !this.ready) {
        this.status = 'Load a show first.';
        return;
      }
      this.busy = true;
      this.needsPlayClick = false;
      this.status = `Loading audio ${file.name} (${(file.size / 1024 / 1024).toFixed(1)} MB, ${file.type || 'unknown type'})…`;
      // eslint-disable-next-line no-console
      console.log('[Beatlight] audio file picked', { name: file.name, size: file.size, type: file.type });
      try {
        if (this.audioObjectUrl) URL.revokeObjectURL(this.audioObjectUrl);
        this.audioObjectUrl = URL.createObjectURL(file);
        const audio = new Audio();
        audio.preload = 'auto';
        // Wait for `loadedmetadata` (fires once duration + format are known —
        // much earlier than `canplaythrough`, which sometimes never fires for
        // large or unusually-encoded files). 8 s timeout is a generous upper
        // bound for blob:-URL loads on local disk.
        const ready = new Promise((resolve, reject) => {
          const timeout = setTimeout(() => {
            const code = audio.error ? audio.error.code : null;
            reject(new Error(`timed out waiting for loadedmetadata (audio.error.code=${code}, networkState=${audio.networkState}, readyState=${audio.readyState})`));
          }, 8000);
          audio.addEventListener('loadedmetadata', () => {
            clearTimeout(timeout);
            // eslint-disable-next-line no-console
            console.log('[Beatlight] loadedmetadata', { duration: audio.duration });
            resolve();
          }, { once: true });
          audio.addEventListener('error', () => {
            clearTimeout(timeout);
            const err = audio.error;
            const codeMap = { 1: 'ABORTED', 2: 'NETWORK', 3: 'DECODE', 4: 'SRC_NOT_SUPPORTED' };
            const codeName = err ? (codeMap[err.code] || `code ${err.code}`) : 'unknown';
            reject(new Error(`audio error: ${codeName}${err && err.message ? ` — ${err.message}` : ''}`));
          }, { once: true });
        });
        audio.src = this.audioObjectUrl;
        audio.load();
        await ready;
        this.audioEl = audio;
        // Construct AudioContext inside the same user-gesture call chain that
        // handled the file pick — autoplay rules permit Web Audio creation
        // here, which they wouldn't on a later async tick.
        this.audioContext = new AudioContext();
        // `audio.play()` returns a promise that may reject due to browser
        // autoplay policy. Surface that as a "click to play" button rather
        // than failing silently.
        try {
          await audio.play();
          await this._attachMeydaAndStart();
          this.status = `Playing — ${file.name}`;
        } catch (playErr) {
          // eslint-disable-next-line no-console
          console.warn('[Beatlight] autoplay blocked, awaiting user gesture', playErr);
          this.needsPlayClick = true;
          this.status = `Audio loaded — click ▶ to play (browser blocked autoplay).`;
        }
        this.busy = false;
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[Beatlight] audio load failed', err);
        this.status = `Error loading audio: ${err.message || err}`;
        this.busy = false;
        this.needsPlayClick = false;
      }
    },

    async resumePlayback() {
      if (!this.audioEl) return;
      try {
        await this.audioEl.play();
        this.needsPlayClick = false;
        await this._attachMeydaAndStart();
        this.status = `Playing — ${this.audioEl.src.split('/').pop()}`;
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[Beatlight] play() rejected on user click', err);
        this.status = `Could not start playback: ${err.message || err}`;
      }
    },

    /**
     * Wire Meyda onto the playing audio element, kick off background
     * calibration (no UX wait), and start the RAF tick loop.
     *
     * Idempotent — safe to call after `resumePlayback` re-runs play().
     */
    async _attachMeydaAndStart() {
      if (!meydaService.isAttached) {
        try {
          await meydaService.attach(this.audioEl, this.audioContext);
        } catch (err) {
          // eslint-disable-next-line no-console
          console.warn('[Beatlight] Meyda attach failed; live overlay disabled', err);
          this.status = 'Live overlay disabled — Meyda attach failed.';
        }
      }
      this.startTickLoop();
      this._startBackgroundCalibration();
      this._startStatusPoll();
    },

    /**
     * Poll currentTime + liveRms at 10 Hz for the playback indicator. Cheap
     * (two reactive writes per 100 ms) and decoupled from the worker tick
     * loop, which runs at 60 Hz (too fast for the UI).
     */
    _startStatusPoll() {
      if (this._statusPollHandle) clearInterval(this._statusPollHandle);
      this._statusPollHandle = setInterval(() => {
        if (!this.audioEl) return;
        this.currentTime = this.audioEl.currentTime;
        try {
          this.liveRms = meydaService.read().rms || 0;
        } catch (_) {
          this.liveRms = 0;
        }
      }, 100);
    },

    _startBackgroundCalibration() {
      if (this.calibrating) return;
      if (!meydaService.isAttached) return;
      this.calibrating = true;
      meydaService.calibrateBoost({
        windowSeconds: CALIBRATION_WINDOW_SECONDS,
        timeline: this.show ? this.show.timeline : null,
      })
        .then((boost) => {
          this.calibrating = false;
          if (boost == null) return; // user-overridden
          this.calibratedBoost = boost;
          EventBus.emit('beatlight:liveBoost-calibrated', { boost });
          this._rampBoost(boost);
        })
        .catch((err) => {
          this.calibrating = false;
          // eslint-disable-next-line no-console
          console.warn('[Beatlight] calibration failed', err);
        });
    },

    /**
     * Smoothly transition `knobs.liveBoost` from its current value (default
     * 2.0) to `target`. Step every BOOST_RAMP_INTERVAL_MS by an amount that
     * caps overall rate at BOOST_RAMP_PER_SEC.
     */
    _rampBoost(target) {
      if (this._boostRampHandle) {
        clearInterval(this._boostRampHandle);
        this._boostRampHandle = null;
      }
      let current = 2.0; // Schema default — mirrors DEFAULT_TUNING.liveBoost.
      const step = (BOOST_RAMP_PER_SEC * BOOST_RAMP_INTERVAL_MS) / 1000;
      this._boostRampHandle = setInterval(() => {
        const delta = target - current;
        if (Math.abs(delta) <= step) {
          current = target;
          this._postKnobs({ liveBoost: current });
          clearInterval(this._boostRampHandle);
          this._boostRampHandle = null;
          return;
        }
        current += Math.sign(delta) * step;
        this._postKnobs({ liveBoost: current });
      }, BOOST_RAMP_INTERVAL_MS);
    },

    _postKnobs(partial) {
      if (!this.worker) return;
      this.worker.postMessage({ type: 'set-knobs', knobs: partial });
      // Cache the last-applied knobs so rebake worker uses the same tuning
      // (otherwise rebake would always use the show file's defaults).
      this._currentKnobs = { ...(this._currentKnobs || {}), ...partial };
    },

    /**
     * Handle a section-relabel event: build a new timeline with the updated
     * section kinds, spawn the rebake worker, hot-swap the playback worker's
     * baked frames + timeline so the live overlay also picks up the new
     * section layout. Audio playback is uninterrupted.
     */
    _handleRebake(payload) {
      if (!this.show || !this.worker) return;
      const sections = (payload && payload.sections) || null;
      if (!Array.isArray(sections)) return;
      const newTimeline = {
        ...this.show.timeline,
        sections,
      };
      const stage = this.show.stage;
      const knobs = this._currentKnobs || this.show.knobs || null;
      this.status = 'Re-baking with new section layout…';
      const rebakeWorker = new RebakeWorker();
      rebakeWorker.addEventListener('message', (e) => {
        const m = e.data;
        if (!m) return;
        if (m.type === 'rebaked') {
          // Forward to playback worker as a transferable.
          this.worker.postMessage(
            { type: 'replace-prebake', frames: m.frames, timeline: newTimeline },
            [m.frames],
          );
          // Mutate local show to keep state in sync (sections + timeline).
          this.show.timeline = markRaw(newTimeline);
          EventBus.emit('beatlight:rebake-complete');
          this.status = 'Re-bake complete.';
          rebakeWorker.terminate();
        } else if (m.type === 'error') {
          // eslint-disable-next-line no-console
          console.error('[Beatlight] rebake worker error', m.message);
          this.status = `Re-bake failed: ${m.message}`;
          EventBus.emit('beatlight:rebake-failed', { message: m.message });
          rebakeWorker.terminate();
        }
      });
      rebakeWorker.postMessage({
        type: 'rebake',
        timeline: newTimeline,
        stage,
        knobs,
      });
    },

    spawnWorker(rawShow) {
      if (this.worker) {
        this.worker.terminate();
        this.worker = null;
      }
      const worker = new CueWorker();
      worker.addEventListener('message', (e) => {
        const m = e.data;
        if (!m) return;
        if (m.type === 'ready') {
          this.ready = true;
          this.status = `Worker ready (${m.totalTicks} ticks @ ${m.rateHz} Hz).`;
        } else if (m.type === 'frame') {
          if (m.idx === this.lastTickIdx) return; // dedupe
          this.lastTickIdx = m.idx;
          beatlightAdapter.applyFrame(new Uint8Array(m.buffer));
        } else if (m.type === 'rebaked') {
          this.status = `Re-baked (${m.totalTicks} ticks).`;
        } else if (m.type === 'error') {
          this.status = `Worker error: ${m.message}`;
        }
      });
      // Pass the raw parsed object (NOT this.show) — postMessage uses
      // structured clone, which rejects Vue's reactive Proxy.
      worker.postMessage({ type: 'init', show: rawShow });
      this.worker = worker;
      this.ready = false;
      // Update the debug surface so e2e specs can find the live worker.
      if (window.__beatlight) {
        window.__beatlight._workerRef = worker;
        window.__beatlight._showRef = rawShow;
      }
    },

    startTickLoop() {
      const tick = () => {
        if (!this.audioEl || !this.worker) return;
        if (!this.audioEl.paused && !this.audioEl.ended) {
          let live = null;
          try {
            live = meydaService.read();
          } catch (err) {
            if (!this._liveErrorReported) {
              this._liveErrorReported = true;
              // eslint-disable-next-line no-console
              console.error('[Beatlight] meydaService.read() threw — live overlay disabled', err);
              this.status = 'Live overlay disabled — Meyda error.';
            }
            live = null;
          }
          this.worker.postMessage({
            type: 'tick',
            t: this.audioEl.currentTime,
            live,
          });
        }
        this.rafHandle = requestAnimationFrame(tick);
      };
      if (this.rafHandle != null) cancelAnimationFrame(this.rafHandle);
      this.rafHandle = requestAnimationFrame(tick);
    },

    universeCount(show) {
      const ids = new Set();
      for (const f of show.stage.fixtures) ids.add(f.universe);
      return ids.size;
    },

    async teardown() {
      if (this.rafHandle != null) {
        cancelAnimationFrame(this.rafHandle);
        this.rafHandle = null;
      }
      if (this._boostRampHandle) {
        clearInterval(this._boostRampHandle);
        this._boostRampHandle = null;
      }
      if (this._statusPollHandle) {
        clearInterval(this._statusPollHandle);
        this._statusPollHandle = null;
      }
      this.currentTime = 0;
      this.liveRms = 0;
      meydaService.detach();
      if (this.worker) {
        this.worker.terminate();
        this.worker = null;
      }
      if (this.audioEl) {
        try { this.audioEl.pause(); } catch (_) { /* noop */ }
        this.audioEl = null;
      }
      if (this.audioObjectUrl) {
        URL.revokeObjectURL(this.audioObjectUrl);
        this.audioObjectUrl = null;
      }
      // audioContext is closed by meydaService.detach() since attach took
      // ownership of it; null the field so a fresh context is built next load.
      this.audioContext = null;
      try {
        await beatlightAdapter.unloadShow();
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('[Beatlight] unloadShow threw', err);
      }
      this.show = null;
      this.ready = false;
      this.lastTickIdx = -1;
      this.calibrating = false;
      this.calibratedBoost = null;
      this._liveErrorReported = false;
      this.status = '';
      EventBus.emit('beatlight:show-unloaded');
    },
  },
};
</script>

<style scoped>
.beatlight_loader {
  height: 100%;
  padding: 0 16px;
  border-left: 1px solid var(--primary-dark);
  gap: 8px;
}
.beatlight_button {
  background: var(--accent-sea-green);
  color: #fff;
  border: none;
  border-radius: 4px;
  padding: 6px 14px;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.5px;
  cursor: pointer;
}
.beatlight_button_secondary {
  background: var(--secondary-dark, #555);
}
.beatlight_button:disabled {
  opacity: 0.5;
  cursor: progress;
}
.beatlight_button:hover:not(:disabled) {
  background: var(--accent-sea-green-light, var(--accent-sea-green));
  filter: brightness(1.1);
}
.beatlight_status {
  color: var(--primary-text, #ddd);
  font-size: 11px;
  max-width: 280px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.beatlight_pill {
  background: var(--primary-light, #1f2a36);
  color: var(--accent-gold, #d4a017);
  font-size: 10px;
  letter-spacing: 0.5px;
  border: 1px solid var(--accent-gold, #d4a017);
  padding: 3px 8px;
  border-radius: 10px;
  white-space: nowrap;
}
.beatlight_pill_quiet {
  color: var(--primary-text, #ddd);
  border-color: var(--primary-dark, #333);
}
.beatlight_play_button {
  background: var(--accent-gold, #d4a017);
  color: #000;
  border: none;
  border-radius: 4px;
  padding: 6px 14px;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  margin-left: 8px;
}
.beatlight_play_button:hover {
  filter: brightness(1.1);
}
.beatlight_playback {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  padding: 0 8px;
  border-left: 1px solid var(--primary-dark, #15202b);
}
.beatlight_live_dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--accent-sea-green, #4ec9b0);
  display: inline-block;
  transition: opacity 0.05s linear;
}
.beatlight_playback_section {
  color: var(--accent-sea-green, #4ec9b0);
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}
.beatlight_playback_drop {
  color: var(--accent-gold, #d4a017);
  font-variant-numeric: tabular-nums;
}
</style>
