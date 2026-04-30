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
      accept=".json,application/json"
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
  </uk-flex>
</template>

<script>
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
    };
  },
  computed: {
    buttonLabel() {
      if (!this.show) return 'Load Beatlight Show';
      if (!this.audioEl) return 'Pick Audio…';
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
        this.show = parsed;
        this.status = `Patching ${parsed.stage.fixtures.length} fixtures into ${this.universeCount(parsed)} universes…`;
        await beatlightAdapter.loadShow(parsed);
        this.spawnWorker();
        this.status = 'Show loaded. Pick audio file to start playback.';
        this.busy = false;
        this.$refs.audioInput.click();
      } catch (err) {
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
      this.status = `Loading audio ${file.name}…`;
      try {
        if (this.audioObjectUrl) URL.revokeObjectURL(this.audioObjectUrl);
        this.audioObjectUrl = URL.createObjectURL(file);
        const audio = new Audio(this.audioObjectUrl);
        audio.preload = 'auto';
        await new Promise((resolve, reject) => {
          audio.addEventListener('canplaythrough', resolve, { once: true });
          audio.addEventListener('error', reject, { once: true });
        });
        this.audioEl = audio;
        audio.play();
        this.startTickLoop();
        this.status = `Playing — ${file.name}`;
        this.busy = false;
      } catch (err) {
        this.status = `Error loading audio: ${err.message || err}`;
        this.busy = false;
      }
    },

    spawnWorker() {
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
      worker.postMessage({ type: 'init', show: this.show });
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
</style>
