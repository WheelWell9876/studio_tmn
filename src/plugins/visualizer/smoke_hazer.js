import * as THREE from 'three';

/**
 * SmokeHazer — small low-emissive box stand-in. Hazers are the "fog
 * machines" that make the volumetric beams visible; v1 doesn't simulate the
 * actual particle system (deferred to a Plan-02 quality option), but the
 * fixture still needs SOMETHING to render so the user can see where the
 * hazer sits.
 *
 * The cue engine `hazePulse` preset writes to the fan/output channels; the
 * default-prop-set fallthrough in `Fixture.setChannel` lands those on
 * `this._3DModel.fan` and `.output`, which we expose as setters that update
 * the box's emissive intensity.
 */

let scene_handle = null;
const instances = [];

class SmokeHazer {
  constructor() {
    const bodyGeo = new THREE.BoxGeometry(0.4, 0.3, 0.25);
    const bodyMat = new THREE.MeshStandardMaterial({
      color: 0x444444,
      emissive: 0x222244,
      emissiveIntensity: 0.1,
      roughness: 0.7,
      metalness: 0.5,
    });
    this._mesh = new THREE.Mesh(bodyGeo, bodyMat);
    this._dummy = new THREE.Object3D();
    this._dummy.add(this._mesh);
    if (scene_handle) scene_handle.add(this._dummy);
    instances.push(this);

    this._fan = 0;
    this._output = 0;
  }

  set position(p) { if (p) this._dummy.position.set(p.x, p.y, Math.max(p.z, 0.5)); }
  get position() { return this._dummy.position; }
  set rotation(r) { if (r) this._dummy.rotation.set(r.x, r.y, r.z); }
  get rotation() { return this._dummy.rotation; }

  set intensity(v) {
    const x = Math.min(Math.max(v || 0, 0), 1);
    this._mesh.material.emissiveIntensity = 0.1 + 0.5 * x;
  }
  get intensity() { return (this._mesh.material.emissiveIntensity - 0.1) / 0.5; }

  set fan(v) { this._fan = v || 0; }
  set output(v) {
    this._output = v || 0;
    // Output channel drives the haze "fog" volume; expose through emissive
    // so a sustained output pulse looks visibly different from a single
    // burst.
    const norm = (typeof v === 'number') ? Math.min(Math.max(v / 255, 0), 1) : v;
    this._mesh.material.emissiveIntensity = 0.1 + 0.5 * norm;
  }

  set color(_c) { /* noop — hazers don't emit user-set color */ }
  set colorIntensity(_) { /* noop */ }
  set colorPreset(_) { /* noop */ }
  set colorWheelSlot(_) { /* noop */ }
  set colorTemp(_) { /* noop */ }
  set strobeFrequency(_) { /* noop */ }

  static prepareInstanciation(_camera, scene) { scene_handle = scene; }
  static update(_t) { /* nothing time-dependent in v1 */ }

  static deleteInstance(instance) {
    if (!instance) return;
    if (scene_handle) scene_handle.remove(instance._dummy);
    instance._mesh.geometry.dispose();
    instance._mesh.material.dispose();
    const idx = instances.indexOf(instance);
    if (idx >= 0) instances.splice(idx, 1);
  }
}

export default SmokeHazer;
