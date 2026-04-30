/**
 * @file BeatlightAdapter — bridges a parsed Beatlight `.show.json` into ASLS
 *       Studio's universe / fixture model and pumps DMX frames at playback time.
 *
 * Per `docs/asls-internals.md` (§14.6 reconnaissance). The two methods live
 * on a single instance reused across loads:
 *
 *   - `loadShow(show)`  — clears any prior show, instantiates the fixtures
 *                         in our pre-baked stage by patching them straight
 *                         into ASLS's `Show.fixturePool` + `Show.universePool`,
 *                         skipping the studio's UI.
 *   - `applyFrame(channels)` — slices the 2048-byte cue-engine frame into
 *                              four 512-byte chunks and assigns each to
 *                              `universe.DMX512Data` (the universe-write
 *                              entry-point identified by recon).
 *
 * The studio's stock 3D renderer only handles `category === "Moving Head"`;
 * the show-builder's canonical-fixtures profile maps every Beatlight role
 * to the bundled `chauvet-dj/intimidator-spot-260` 14-channel mode so all
 * 28 cones render. The cue-engine uses the same channel layout for the
 * pre-bake, so the channel writes land on the right OFL channels.
 */

import axios from 'axios';
import ShowSingleton from '@/singletons/show.singleton';

const FALLBACK_OFL_KEY = 'chauvet-dj/intimidator-spot-260';
const FALLBACK_OFL_MODE = '14-channel';

/**
 * @typedef {Object} BeatlightShowFixture
 * @property {string} id
 * @property {string} role
 * @property {string} profileId
 * @property {number} universe
 * @property {number} address              1-based DMX address
 * @property {{x:number,y:number,z:number}} position
 * @property {{x:number,y:number,z:number}} rotation
 */

/**
 * @typedef {Object} BeatlightShow
 * @property {number} schema_version
 * @property {string} title
 * @property {Object} stage
 * @property {Array<BeatlightShowFixture>} stage.fixtures
 * @property {{widthMeters:number,depthMeters:number,heightMeters:number}} stage.dimensions
 * @property {Object} fixture_profiles     keyed by profileId; each entry has
 *                                         `oflKey` and `oflMode`
 * @property {Object} timeline             passthrough from the analyzer
 * @property {Object} pre_baked_dmx
 * @property {string} audio_file
 */

/** Keep one cached OFL JSON per (manufacturer, model) so loads stay snappy. */
const oflCache = new Map();

async function fetchOfl(oflKey) {
  if (oflCache.has(oflKey)) return oflCache.get(oflKey);
  const url = `/fixtures/${oflKey}.json`;
  const res = await axios.get(url);
  oflCache.set(oflKey, res.data);
  return res.data;
}

class BeatlightAdapter {
  constructor() {
    /** @type {Map<number, import('@/models/DMX/universe.model').default>} */
    this._universesById = new Map();
    /** @type {boolean} */
    this._loaded = false;
  }

  /**
   * Patch every fixture from the show into ASLS's models. Replaces any
   * pre-existing show data — `clearShowData` runs first so the user can
   * load multiple Beatlight shows in a session without artefacts.
   *
   * @param {BeatlightShow} show
   */
  async loadShow(show) {
    ShowSingleton.clearShowData();
    this._universesById.clear();

    // Group fixtures by universe so we patch into a fresh universe per group.
    const byUniverse = new Map();
    for (const f of show.stage.fixtures) {
      if (!byUniverse.has(f.universe)) byUniverse.set(f.universe, []);
      byUniverse.get(f.universe).push(f);
    }

    // Resolve every distinct OFL profile up-front. Show may inline profile
    // metadata under `show.fixture_profiles[profileId].oflKey` — fall back
    // to the bundled moving-head profile when the show's profile isn't
    // routed to a real OFL fixture.
    const profileToOfl = new Map();
    for (const f of show.stage.fixtures) {
      if (profileToOfl.has(f.profileId)) continue;
      const meta = show.fixture_profiles?.[f.profileId];
      const oflKey = (meta && meta.oflKey) || FALLBACK_OFL_KEY;
      const oflMode = (meta && meta.oflMode) || FALLBACK_OFL_MODE;
      const oflData = await fetchOfl(oflKey);
      profileToOfl.set(f.profileId, { oflKey, oflMode, oflData });
    }

    for (const [universeId, fixtures] of byUniverse.entries()) {
      const universe = ShowSingleton.universePool.addRaw({ id: universeId });
      this._universesById.set(universeId, universe);

      // Sort by address so fixturePool IDs map predictably to the slot
      // ordering and patch attempts don't fight each other.
      fixtures.sort((a, b) => a.address - b.address);

      for (const f of fixtures) {
        const profile = profileToOfl.get(f.profileId);
        const [manufacturer, model] = profile.oflKey.split('/');
        const aslsFixtureData = {
          OFLData: profile.oflData,
          manufacturer,
          model,
          mode: profile.oflMode,
          // ASLS auto-assigns id via fixturePool.genFixtureId — supplied id
          // is overwritten. We don't need the ID round-tripped on our side.
          id: 0,
          chStart: f.address - 1, // ASLS uses 0-based chStart
          universe: universeId,
          position: f.position,
          rotation: f.rotation,
        };
        const fixture = ShowSingleton.fixturePool.addRaw(aslsFixtureData);
        universe.patchFixture(fixture);
      }
    }

    this._loaded = true;
  }

  /**
   * Pump a 2048-byte DMX frame from the cue-engine into the studio. Slices
   * into 512-byte chunks and assigns each to `universe.DMX512Data`.
   *
   * Tolerant of frames smaller than 2048 bytes (only writes the universes
   * that have data) and of universes that aren't part of the loaded show
   * (silently skipped — happens when a show file targets fewer universes
   * than we naively iterate).
   *
   * @param {Uint8Array} channels
   */
  applyFrame(channels) {
    if (!this._loaded) return;
    if (!(channels instanceof Uint8Array)) {
      // Detached transferable buffers come back as ArrayBuffer in some
      // worker→main message paths; wrap to Uint8Array view.
      // eslint-disable-next-line no-param-reassign
      channels = new Uint8Array(channels);
    }
    const totalUniverses = Math.floor(channels.length / 512);
    for (let u = 0; u < totalUniverses; u++) {
      const universe = this._universesById.get(u);
      if (!universe) continue;
      universe.DMX512Data = channels.subarray(u * 512, (u + 1) * 512);
    }
  }

  /** True if a show has been mounted; false until `loadShow` resolves. */
  get isLoaded() {
    return this._loaded;
  }

  /**
   * Tear down the currently mounted show: zero every patched universe so
   * each fixture's `setChannel` cascade pulls visuals to dark, await one
   * render frame so the meshes actually update, then call ASLS's pool-clear
   * which invokes each fixture's `deleteInstance` static (each mesh class
   * is responsible for its own Three.js geometry/material disposal).
   *
   * Safe to call when no show is loaded.
   */
  async unloadShow() {
    if (!this._loaded) return;
    for (const universe of this._universesById.values()) {
      try {
        universe.DMX512Data = new Uint8Array(512);
      } catch (_) { /* universe might already be detached; ignore */ }
    }
    await new Promise((r) => requestAnimationFrame(r));
    try {
      ShowSingleton.clearShowData();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[BeatlightAdapter] clearShowData threw on unload', err);
    }
    this._universesById.clear();
    this._loaded = false;
  }
}

// Singleton — there's one studio per page; keeping a single adapter avoids
// stale references after a show reload.
const beatlightAdapter = new BeatlightAdapter();
export default beatlightAdapter;
