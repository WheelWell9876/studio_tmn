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
    <div
      v-if="status"
      class="beatlight_status"
    >
      {{ status }}
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
import beatlightAdapter from '@/services/BeatlightAdapter';
import CueWorker from '@/workers/beatlight-cue.worker.js?worker';

export default {
  name: 'BeatlightLoader',
  data() {
    return {
      status: '',
      busy: false,
      show: null,
      audioEl: null,
      audioObjectUrl: null,
      worker: null,
      rafHandle: null,
      lastTickIdx: -1,
      ready: false,
      needsPlayClick: false,
    };
  },
  computed: {
    buttonLabel() {
      if (!this.show) return '1. Pick .show.json';
      if (!this.audioEl) return '2. Pick audio (mp3/wav)';
      return 'Reload';
    },
  },
  beforeUnmount() {
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
      this.teardown();
      this.$refs.showInput.click();
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
        // `audio.play()` returns a promise that may reject due to browser
        // autoplay policy. Surface that as a "click to play" button rather
        // than failing silently.
        try {
          await audio.play();
          this.startTickLoop();
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
        this.startTickLoop();
        this.status = `Playing — ${this.audioEl.src.split('/').pop()}`;
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[Beatlight] play() rejected on user click', err);
        this.status = `Could not start playback: ${err.message || err}`;
      }
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
        } else if (m.type === 'error') {
          this.status = `Worker error: ${m.message}`;
        }
      });
      // Pass the raw parsed object (NOT this.show) — postMessage uses
      // structured clone, which rejects Vue's reactive Proxy.
      worker.postMessage({ type: 'init', show: rawShow });
      this.worker = worker;
      this.ready = false;
    },

    startTickLoop() {
      const tick = () => {
        if (!this.audioEl || !this.worker) return;
        if (!this.audioEl.paused && !this.audioEl.ended) {
          this.worker.postMessage({ type: 'tick', t: this.audioEl.currentTime });
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

    teardown() {
      if (this.rafHandle != null) {
        cancelAnimationFrame(this.rafHandle);
        this.rafHandle = null;
      }
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
      this.show = null;
      this.ready = false;
      this.lastTickIdx = -1;
      this.status = '';
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
</style>
