<template>
  <div class="beatlight_relabel_root">
    <button
      v-if="hasShow"
      class="beatlight_relabel_toggle"
      :class="{ 'is-open': open }"
      title="Re-label timeline sections (verse → drop, etc.) and re-bake"
      @click="open = !open"
    >
      📝 Sections
    </button>

    <transition name="beatlight-leftdrawer">
      <aside
        v-if="open"
        class="beatlight_leftdrawer"
      >
        <header class="beatlight_leftdrawer_header">
          <h3>Timeline sections</h3>
          <button
            class="beatlight_leftdrawer_close"
            @click="open = false"
          >
            ×
          </button>
        </header>

        <p
          v-if="rebaking"
          class="beatlight_relabel_status"
        >
          Re-baking…
        </p>
        <p
          v-else-if="sections.length === 0"
          class="beatlight_relabel_status"
        >
          No sections in this show.
        </p>

        <div
          v-for="(sec, i) in sections"
          :key="i"
          class="beatlight_section_row"
        >
          <span class="beatlight_section_label">{{ autoLabel(i, sec) }}</span>
          <span class="beatlight_section_time">
            {{ sec.start.toFixed(1) }}s – {{ sec.end.toFixed(1) }}s
          </span>
          <select
            v-model="sec.kind"
            class="beatlight_section_select"
            @change="markDirty"
          >
            <option
              v-for="kind in SECTION_KINDS"
              :key="kind"
              :value="kind"
            >
              {{ kind }}
            </option>
          </select>
        </div>

        <footer class="beatlight_leftdrawer_footer">
          <button
            class="beatlight_drawer_btn"
            :disabled="!dirty || rebaking"
            @click="applyRebake"
          >
            Apply &amp; re-bake
          </button>
          <button
            class="beatlight_drawer_btn"
            :disabled="!dirty || rebaking"
            @click="discardChanges"
          >
            Discard
          </button>
        </footer>
      </aside>
    </transition>
  </div>
</template>

<script>
import EventBus from '@/plugins/eventbus';

const SECTION_KINDS = [
  'intro',
  'verse',
  'build',
  'drop',
  'chorus',
  'breakdown',
  'bridge',
  'outro',
  'unknown',
];

function slugify(s) {
  if (!s) return 'song';
  return String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 32) || 'song';
}

export default {
  name: 'SectionRelabelPanel',
  data() {
    return {
      open: false,
      hasShow: false,
      sections: [],          // local editable copy
      _origKinds: [],        // snapshot of kinds at load — used for dirty check
      trackTitleStem: 'song',
      dirty: false,
      rebaking: false,
      SECTION_KINDS,
    };
  },
  created() {
    EventBus.on('beatlight:show-loaded', this._onShowLoaded);
    EventBus.on('beatlight:show-unloaded', this._onShowUnloaded);
    EventBus.on('beatlight:rebake-complete', this._onRebakeComplete);
    EventBus.on('beatlight:rebake-failed', this._onRebakeFailed);
  },
  beforeUnmount() {
    EventBus.off('beatlight:show-loaded', this._onShowLoaded);
    EventBus.off('beatlight:show-unloaded', this._onShowUnloaded);
    EventBus.off('beatlight:rebake-complete', this._onRebakeComplete);
    EventBus.off('beatlight:rebake-failed', this._onRebakeFailed);
  },
  methods: {
    _onShowLoaded(payload) {
      const tl = payload && payload.timeline ? payload.timeline : null;
      const title = payload && payload.trackTitle ? payload.trackTitle : 'song';
      if (!tl || !Array.isArray(tl.sections)) {
        this.hasShow = false;
        this.sections = [];
        this._origKinds = [];
        return;
      }
      this.hasShow = true;
      this.trackTitleStem = slugify(title);
      // Local editable copy — we mutate `kind` directly via v-model.
      this.sections = tl.sections.map((s) => ({ ...s }));
      this._origKinds = tl.sections.map((s) => s.kind);
      this.dirty = false;
    },
    _onShowUnloaded() {
      this.open = false;
      this.hasShow = false;
      this.sections = [];
      this._origKinds = [];
      this.dirty = false;
      this.rebaking = false;
    },
    _onRebakeComplete() {
      this.rebaking = false;
      // Lock in the changes — origKinds catches up so dirty resets.
      this._origKinds = this.sections.map((s) => s.kind);
      this.dirty = false;
    },
    _onRebakeFailed() {
      this.rebaking = false;
      // Keep dirty = true so user can retry.
    },
    autoLabel(i, sec) {
      const idx = String(i).padStart(2, '0');
      return `${this.trackTitleStem}_${idx}_${sec.kind}`;
    },
    markDirty() {
      this.dirty = this.sections.some(
        (s, i) => s.kind !== this._origKinds[i],
      );
    },
    applyRebake() {
      if (!this.dirty || this.rebaking) return;
      this.rebaking = true;
      // Send the full updated sections array; bridge composes the new
      // timeline + spawns the rebake worker.
      EventBus.emit('beatlight:rebake', {
        sections: this.sections.map((s) => ({ ...s })),
      });
    },
    discardChanges() {
      // Revert all kinds back to the loaded snapshot.
      this.sections = this.sections.map((s, i) => ({
        ...s,
        kind: this._origKinds[i] ?? s.kind,
      }));
      this.dirty = false;
    },
  },
};
</script>

<style scoped>
.beatlight_relabel_root {
  display: contents;
}
.beatlight_relabel_toggle {
  background: var(--secondary-dark, #2c3a48);
  color: var(--accent-sea-green, #4ec9b0);
  border: 1px solid var(--accent-sea-green, #4ec9b0);
  border-radius: 4px;
  padding: 5px 10px;
  font-size: 11px;
  font-weight: 600;
  cursor: pointer;
  margin-left: 8px;
}
.beatlight_relabel_toggle.is-open {
  background: var(--accent-sea-green, #4ec9b0);
  color: #000;
}
.beatlight_leftdrawer {
  position: fixed;
  top: 40px;
  left: 0;
  bottom: 0;
  width: 360px;
  background: var(--primary-light, #1f2a36);
  border-right: 1px solid var(--primary-dark, #15202b);
  color: var(--primary-text, #ddd);
  z-index: 30;
  overflow-y: auto;
  padding: 12px;
  box-shadow: 4px 0 12px rgba(0, 0, 0, 0.3);
}
.beatlight_leftdrawer_header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 12px;
  border-bottom: 1px solid var(--primary-dark, #15202b);
  padding-bottom: 8px;
}
.beatlight_leftdrawer_header h3 {
  margin: 0;
  font-size: 13px;
  letter-spacing: 0.5px;
}
.beatlight_leftdrawer_close {
  background: transparent;
  border: none;
  color: var(--primary-text, #ddd);
  font-size: 18px;
  cursor: pointer;
  padding: 0 6px;
}
.beatlight_relabel_status {
  font-size: 12px;
  color: var(--accent-gold, #d4a017);
  text-align: center;
  margin: 16px 0;
}
.beatlight_section_row {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 4px 8px;
  margin-bottom: 10px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.05);
  padding-bottom: 6px;
}
.beatlight_section_label {
  grid-column: 1 / span 2;
  font-size: 11px;
  color: var(--accent-sea-green, #4ec9b0);
  font-family: monospace;
  letter-spacing: 0.5px;
}
.beatlight_section_time {
  grid-column: 1;
  font-size: 11px;
  color: var(--primary-text, #ddd);
  align-self: center;
  font-variant-numeric: tabular-nums;
}
.beatlight_section_select {
  grid-column: 2;
  background: var(--secondary-dark, #2c3a48);
  color: var(--primary-text, #ddd);
  border: 1px solid var(--primary-dark, #15202b);
  font-size: 11px;
  padding: 2px 4px;
  border-radius: 3px;
}
.beatlight_leftdrawer_footer {
  display: flex;
  gap: 8px;
  border-top: 1px solid var(--primary-dark, #15202b);
  padding-top: 12px;
  margin-top: 12px;
}
.beatlight_drawer_btn {
  background: var(--secondary-dark, #2c3a48);
  color: var(--primary-text, #ddd);
  border: 1px solid var(--primary-dark, #15202b);
  border-radius: 3px;
  padding: 6px 10px;
  font-size: 11px;
  cursor: pointer;
}
.beatlight_drawer_btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.beatlight_drawer_btn:hover:not(:disabled) {
  filter: brightness(1.15);
}
.beatlight-leftdrawer-enter-active,
.beatlight-leftdrawer-leave-active {
  transition: transform 0.18s ease-out;
}
.beatlight-leftdrawer-enter-from,
.beatlight-leftdrawer-leave-to {
  transform: translateX(-100%);
}
</style>
