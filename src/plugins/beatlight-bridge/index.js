import BeatlightLoader from './BeatlightLoader.vue';

/**
 * Beatlight Bridge Vue plugin.
 *
 * Registers a single global component, `<BeatlightLoader />`, which the
 * toolbar fragment mounts. The plugin keeps the surface tiny on purpose —
 * imperative ASLS integration lives in `@/services/BeatlightAdapter`,
 * cue-engine playback lives in `@/workers/beatlight-cue.worker.js`.
 *
 * Per Plan 18 §14.3.
 */
export const BeatlightBridge = {
  install(app) {
    app.component('BeatlightLoader', BeatlightLoader);
  },
};

export default BeatlightBridge;
