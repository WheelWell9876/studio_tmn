import BeatlightLoader from './BeatlightLoader.vue';
import SectionRelabelPanel from './SectionRelabelPanel.vue';
import TuningKnobsPanel from './TuningKnobsPanel.vue';

/**
 * Beatlight Bridge Vue plugin.
 *
 * Registers global components mounted by the toolbar fragment:
 *   - <BeatlightLoader />        show + audio pickers, RAF tick loop
 *   - <TuningKnobsPanel />       right-side drawer with live-tunable cue knobs
 *   - <SectionRelabelPanel />    left-side drawer for re-labelling sections
 *
 * Imperative ASLS integration lives in `@/services/BeatlightAdapter`;
 * cue-engine playback lives in `@/workers/beatlight-cue.worker.js`;
 * offline re-bake lives in `@/workers/beatlight-rebake.worker.js`;
 * real-time audio analysis lives in `@/services/MeydaService`.
 *
 * Per Plan 18 §14.3 + Plan 19 §3B.
 */
export const BeatlightBridge = {
  install(app) {
    app.component('BeatlightLoader', BeatlightLoader);
    app.component('TuningKnobsPanel', TuningKnobsPanel);
    app.component('SectionRelabelPanel', SectionRelabelPanel);
  },
};

export default BeatlightBridge;
