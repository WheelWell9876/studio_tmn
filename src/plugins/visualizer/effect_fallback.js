import * as THREE from 'three';

/**
 * EffectFallback — used when `Fixture.category` doesn't match any known
 * mesh class. Renders a small wireframe box with an emissive front face so
 * the user sees SOMETHING at the fixture's position. Logs a one-time warn
 * per unique category so unknown roles don't disappear silently.
 */

let scene_handle = null;
const instances = [];
const _warnedCategories = new Set();

class EffectFallback {
  constructor(data = {}) {
    if (data.category && !_warnedCategories.has(data.category)) {
      _warnedCategories.add(data.category);
      // eslint-disable-next-line no-console
      console.warn('[Beatlight] unknown fixture category, using fallback', data.category);
    }
    const geometry = new THREE.BoxGeometry(0.3, 0.3, 0.3);
    const material = new THREE.MeshStandardMaterial({
      color: 0x666666,
      emissive: 0x333333,
      emissiveIntensity: 0.2,
      roughness: 0.5,
      metalness: 0.4,
      wireframe: false,
    });
    this._mesh = new THREE.Mesh(geometry, material);
    this._dummy = new THREE.Object3D();
    this._dummy.add(this._mesh);
    if (scene_handle) scene_handle.add(this._dummy);
    instances.push(this);
  }

  set position(p) { if (p) this._dummy.position.set(p.x, p.y, Math.max(p.z, 0.5)); }
  get position() { return this._dummy.position; }
  set rotation(r) { if (r) this._dummy.rotation.set(r.x, r.y, r.z); }
  get rotation() { return this._dummy.rotation; }

  set intensity(v) {
    const x = Math.min(Math.max(v || 0, 0), 1);
    this._mesh.material.emissiveIntensity = 0.2 + 0.6 * x;
  }
  get intensity() { return (this._mesh.material.emissiveIntensity - 0.2) / 0.6; }

  set color(c) {
    const tc = c instanceof THREE.Color ? c : new THREE.Color(c);
    this._mesh.material.emissive.copy(tc);
  }
  set colorIntensity(_) { /* noop */ }
  set colorPreset(c) { if (c) this.color = c; }
  set colorWheelSlot(_) { /* noop */ }
  set colorTemp(_) { /* noop */ }
  set strobeFrequency(_) { /* noop */ }

  static prepareInstanciation(_camera, scene) { scene_handle = scene; }
  static update(_t) { /* no time-dependent state */ }

  static deleteInstance(instance) {
    if (!instance) return;
    if (scene_handle) scene_handle.remove(instance._dummy);
    instance._mesh.geometry.dispose();
    instance._mesh.material.dispose();
    const idx = instances.indexOf(instance);
    if (idx >= 0) instances.splice(idx, 1);
  }
}

export default EffectFallback;
