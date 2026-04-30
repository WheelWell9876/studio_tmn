<template>
  <div class="beatlight_tuning_root">
    <button
      class="beatlight_tuning_toggle"
      :class="{ 'is-open': open }"
      title="Open / close the tuning drawer"
      @click="open = !open"
    >
      🎛 Tuning
    </button>

    <transition name="beatlight-drawer">
      <aside
        v-if="open"
        class="beatlight_drawer"
      >
        <header class="beatlight_drawer_header">
          <h3>Tuning</h3>
          <button
            class="beatlight_drawer_close"
            @click="open = false"
          >
            ×
          </button>
        </header>

        <section
          v-for="grp in groupedKnobs"
          :key="grp.name"
          class="beatlight_drawer_group"
        >
          <h4>{{ grp.name }}</h4>
          <div
            v-for="entry in grp.entries"
            :key="entry.key"
            class="beatlight_knob_row"
          >
            <label :for="`knob_${entry.key}`">
              {{ entry.meta.label }}
              <span
                v-if="entry.key === 'liveBoost' && lastCalibrated != null"
                class="beatlight_knob_calibrated"
                :title="`Background calibration target: ${lastCalibrated.toFixed(2)}`"
              >
                (calibrated: {{ lastCalibrated.toFixed(2) }})
              </span>
            </label>

            <template v-if="entry.intro.type === 'number'">
              <input
                :id="`knob_${entry.key}`"
                v-model.number="knobs[entry.key]"
                type="range"
                :min="entry.intro.min"
                :max="entry.intro.max"
                :step="entry.meta.step ?? 0.01"
                @input="onChange(entry.key)"
              >
              <span class="beatlight_knob_value">{{ formatValue(entry.key) }}</span>
              <button
                v-if="entry.key === 'liveBoost'"
                class="beatlight_knob_recalibrate"
                title="Re-run background calibration"
                @click="recalibrate"
              >
                ↻
              </button>
            </template>

            <template v-else-if="entry.intro.type === 'boolean'">
              <input
                :id="`knob_${entry.key}`"
                v-model="knobs[entry.key]"
                type="checkbox"
                @change="onBoolChange(entry.key)"
              >
            </template>
          </div>
        </section>

        <footer class="beatlight_drawer_footer">
          <button
            class="beatlight_drawer_btn"
            @click="resetDefaults"
          >
            Reset to defaults
          </button>
          <button
            class="beatlight_drawer_btn"
            @click="saveAsPreset"
          >
            Save as preset…
          </button>
        </footer>
      </aside>
    </transition>

    <transition name="beatlight-modal">
      <div
        v-if="showEpilepsyModal"
        class="beatlight_modal_backdrop"
        @click.self="cancelHighFreqStrobe"
      >
        <div class="beatlight_modal">
          <h3>⚠ Photosensitive epilepsy warning</h3>
          <p>
            Strobing at 13–25 Hz can trigger seizures in people with
            photosensitive epilepsy. Keep this off for any audience that
            includes people who have not consented to high-frequency
            strobing.
          </p>
          <p>Are you sure you want to allow strobe rates above 12 Hz?</p>
          <div class="beatlight_modal_actions">
            <button
              class="beatlight_drawer_btn"
              @click="cancelHighFreqStrobe"
            >
              Cancel
            </button>
            <button
              class="beatlight_drawer_btn beatlight_drawer_btn_warn"
              @click="confirmHighFreqStrobe"
            >
              Allow
            </button>
          </div>
        </div>
      </div>
    </transition>
  </div>
</template>

<script>
import { debounce } from 'lodash';
import EventBus from '@/plugins/eventbus';
import { DEFAULT_TUNING, TuningKnobsSchema } from '@beatlight/cue-engine';

const KNOB_META = {
  // Kick
  kickFloor:        { group: 'Kick', label: 'Floor (DMX)', step: 1 },
  kickCeiling:      { group: 'Kick', label: 'Ceiling (DMX)', step: 1 },
  kickLiveBlend:    { group: 'Kick', label: 'Baked ↔ Live blend', step: 0.01 },
  // Build
  buildStrobeStartHz: { group: 'Build', label: 'Strobe start Hz', step: 0.5 },
  buildStrobeEndHz:   { group: 'Build', label: 'Strobe end Hz', step: 0.5 },
  // Drop
  preDropBlackoutSeconds: { group: 'Drop', label: 'Pre-drop blackout (s)', step: 0.05 },
  dropExplodeSeconds:     { group: 'Drop', label: 'Explode duration (s)', step: 0.05 },
  // Live overlay
  liveOverlayStrength: { group: 'Live overlay', label: 'Overlay strength', step: 0.01 },
  liveBoost:           { group: 'Live overlay', label: 'Live boost', step: 0.05 },
  // Safety
  allowHighFreqStrobe: { group: 'Safety', label: 'Allow >12 Hz strobe', step: undefined },
  // Color
  bassWashCeiling:     { group: 'Color', label: 'Bass wash ceiling', step: 0.01 },
  vocalChaseSpeed:     { group: 'Color', label: 'Vocal chase speed', step: 0.05 },
  saturationScale:     { group: 'Color', label: 'Saturation scale', step: 0.05 },
  valueScale:          { group: 'Color', label: 'Value scale', step: 0.05 },
};

const GROUP_ORDER = ['Kick', 'Build', 'Drop', 'Live overlay', 'Safety', 'Color'];

/** Pull min/max/default from a (possibly defaulted) zod field. */
function introspect(field) {
  const inner = field._def && field._def.innerType
    ? field._def.innerType
    : field;
  let min = -Infinity;
  let max = Infinity;
  if (inner._def && inner._def.typeName === 'ZodNumber') {
    for (const check of inner._def.checks || []) {
      if (check.kind === 'min') min = check.value;
      if (check.kind === 'max') max = check.value;
    }
    return { type: 'number', min, max };
  }
  if (inner._def && inner._def.typeName === 'ZodBoolean') {
    return { type: 'boolean' };
  }
  return { type: 'unknown' };
}

const HF_STROBE_ACK_KEY = 'beatlight_high_freq_acknowledged';
const PRESETS_KEY = 'beatlight_presets';

export default {
  name: 'TuningKnobsPanel',
  data() {
    return {
      open: false,
      knobs: { ...DEFAULT_TUNING },
      lastCalibrated: null,
      showEpilepsyModal: false,
    };
  },
  computed: {
    introspected() {
      const out = {};
      for (const key of Object.keys(KNOB_META)) {
        out[key] = introspect(TuningKnobsSchema.shape[key]);
      }
      return out;
    },
    groupedKnobs() {
      const groups = {};
      for (const key of Object.keys(KNOB_META)) {
        const meta = KNOB_META[key];
        if (!groups[meta.group]) groups[meta.group] = [];
        groups[meta.group].push({ key, meta, intro: this.introspected[key] });
      }
      return GROUP_ORDER
        .filter((g) => groups[g] && groups[g].length > 0)
        .map((g) => ({ name: g, entries: groups[g] }));
    },
  },
  created() {
    this._debouncedEmit = debounce((partial) => {
      EventBus.emit('beatlight:set-knobs', partial);
    }, 16);
    EventBus.on('beatlight:show-loaded', this._onShowLoaded);
    EventBus.on('beatlight:show-unloaded', this._onShowUnloaded);
    EventBus.on('beatlight:liveBoost-calibrated', this._onCalibrated);
  },
  beforeUnmount() {
    EventBus.off('beatlight:show-loaded', this._onShowLoaded);
    EventBus.off('beatlight:show-unloaded', this._onShowUnloaded);
    EventBus.off('beatlight:liveBoost-calibrated', this._onCalibrated);
    if (this._debouncedEmit && this._debouncedEmit.cancel) {
      this._debouncedEmit.cancel();
    }
  },
  methods: {
    _onShowLoaded(payload) {
      const incoming = (payload && payload.knobs) || {};
      this.knobs = { ...DEFAULT_TUNING, ...incoming };
      this.lastCalibrated = null;
    },
    _onShowUnloaded() {
      this.knobs = { ...DEFAULT_TUNING };
      this.lastCalibrated = null;
    },
    _onCalibrated(payload) {
      const boost = payload && typeof payload.boost === 'number' ? payload.boost : null;
      if (boost == null) return;
      this.lastCalibrated = boost;
      // Smooth ramp is handled by BeatlightLoader; just update display.
      this.knobs.liveBoost = boost;
    },
    onChange(key) {
      // User touched the liveBoost slider mid-calibration → cancel.
      if (key === 'liveBoost') {
        EventBus.emit('beatlight:cancel-calibration');
      }
      this._debouncedEmit({ [key]: this.knobs[key] });
    },
    onBoolChange(key) {
      // Special-case: high-freq strobe needs an epilepsy ACK on first toggle.
      if (key === 'allowHighFreqStrobe' && this.knobs[key] === true) {
        if (!this._hasEpilepsyAck()) {
          this.showEpilepsyModal = true;
          // Hold the slider state until the user confirms; revert on cancel.
          return;
        }
      }
      this._debouncedEmit({ [key]: this.knobs[key] });
    },
    _hasEpilepsyAck() {
      try {
        return window.localStorage.getItem(HF_STROBE_ACK_KEY) === '1';
      } catch (_) {
        return false;
      }
    },
    confirmHighFreqStrobe() {
      try { window.localStorage.setItem(HF_STROBE_ACK_KEY, '1'); } catch (_) { /* noop */ }
      this.showEpilepsyModal = false;
      this._debouncedEmit({ allowHighFreqStrobe: true });
    },
    cancelHighFreqStrobe() {
      this.showEpilepsyModal = false;
      this.knobs.allowHighFreqStrobe = false;
    },
    recalibrate() {
      EventBus.emit('beatlight:recalibrate');
    },
    resetDefaults() {
      this.knobs = { ...DEFAULT_TUNING };
      EventBus.emit('beatlight:set-knobs', { ...DEFAULT_TUNING });
    },
    saveAsPreset() {
      // eslint-disable-next-line no-alert
      const name = window.prompt('Save current tuning as preset name:');
      if (!name) return;
      let presets = {};
      try {
        const raw = window.localStorage.getItem(PRESETS_KEY);
        if (raw) presets = JSON.parse(raw);
      } catch (_) { /* noop */ }
      presets[name] = { ...this.knobs };
      try {
        window.localStorage.setItem(PRESETS_KEY, JSON.stringify(presets));
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[Beatlight] localStorage write failed', err);
      }
    },
    formatValue(key) {
      const v = this.knobs[key];
      if (typeof v !== 'number') return String(v);
      const step = KNOB_META[key]?.step ?? 0.01;
      if (step >= 1) return v.toFixed(0);
      if (step >= 0.1) return v.toFixed(2);
      return v.toFixed(2);
    },
  },
};
</script>

<style scoped>
.beatlight_tuning_root {
  display: contents;
}
.beatlight_tuning_toggle {
  background: var(--secondary-dark, #2c3a48);
  color: var(--accent-gold, #d4a017);
  border: 1px solid var(--accent-gold, #d4a017);
  border-radius: 4px;
  padding: 5px 10px;
  font-size: 11px;
  font-weight: 600;
  cursor: pointer;
  margin-left: 8px;
}
.beatlight_tuning_toggle.is-open {
  background: var(--accent-gold, #d4a017);
  color: #000;
}
.beatlight_drawer {
  position: fixed;
  top: 40px;
  right: 0;
  bottom: 0;
  width: 340px;
  background: var(--primary-light, #1f2a36);
  border-left: 1px solid var(--primary-dark, #15202b);
  color: var(--primary-text, #ddd);
  z-index: 30;
  overflow-y: auto;
  padding: 12px;
  box-shadow: -4px 0 12px rgba(0, 0, 0, 0.3);
}
.beatlight_drawer_header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 12px;
  border-bottom: 1px solid var(--primary-dark, #15202b);
  padding-bottom: 8px;
}
.beatlight_drawer_header h3 {
  margin: 0;
  font-size: 13px;
  letter-spacing: 0.5px;
}
.beatlight_drawer_close {
  background: transparent;
  border: none;
  color: var(--primary-text, #ddd);
  font-size: 18px;
  cursor: pointer;
  padding: 0 6px;
}
.beatlight_drawer_group {
  margin-bottom: 16px;
}
.beatlight_drawer_group h4 {
  margin: 0 0 6px 0;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 1px;
  color: var(--accent-sea-green, #4ec9b0);
}
.beatlight_knob_row {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 6px 8px;
  align-items: center;
  margin-bottom: 6px;
  font-size: 11px;
}
.beatlight_knob_row label {
  grid-column: 1 / span 2;
  color: var(--primary-text, #ddd);
}
.beatlight_knob_row input[type="range"] {
  grid-column: 1;
  width: 100%;
}
.beatlight_knob_row input[type="checkbox"] {
  grid-column: 2;
  justify-self: end;
}
.beatlight_knob_value {
  grid-column: 2;
  font-variant-numeric: tabular-nums;
  color: var(--accent-gold, #d4a017);
  font-size: 11px;
  min-width: 40px;
  text-align: right;
}
.beatlight_knob_calibrated {
  font-size: 10px;
  color: var(--accent-sea-green, #4ec9b0);
  margin-left: 4px;
}
.beatlight_knob_recalibrate {
  background: transparent;
  border: 1px solid var(--accent-sea-green, #4ec9b0);
  color: var(--accent-sea-green, #4ec9b0);
  border-radius: 3px;
  padding: 0 4px;
  font-size: 10px;
  cursor: pointer;
  grid-column: 2;
}
.beatlight_drawer_footer {
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
.beatlight_drawer_btn:hover {
  filter: brightness(1.15);
}
.beatlight_drawer_btn_warn {
  background: var(--accent-gold, #d4a017);
  color: #000;
}
.beatlight_modal_backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.55);
  display: flex;
  justify-content: center;
  align-items: center;
  z-index: 100;
}
.beatlight_modal {
  background: var(--primary-light, #1f2a36);
  color: var(--primary-text, #ddd);
  padding: 20px 24px;
  border-radius: 6px;
  max-width: 460px;
  border: 1px solid var(--accent-gold, #d4a017);
}
.beatlight_modal h3 {
  margin: 0 0 12px 0;
  color: var(--accent-gold, #d4a017);
}
.beatlight_modal p {
  font-size: 13px;
  line-height: 1.4;
}
.beatlight_modal_actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 16px;
}
.beatlight-drawer-enter-active,
.beatlight-drawer-leave-active {
  transition: transform 0.18s ease-out;
}
.beatlight-drawer-enter-from,
.beatlight-drawer-leave-to {
  transform: translateX(100%);
}
.beatlight-modal-enter-active,
.beatlight-modal-leave-active {
  transition: opacity 0.12s;
}
.beatlight-modal-enter-from,
.beatlight-modal-leave-to {
  opacity: 0;
}
</style>
