import * as THREE from 'three';

/**
 * StrobePanel — emissive plane that flashes when its dimmer rises. Drives
 * the channel writes routed to it by `Fixture.setChannel` (see
 * `fixture.model.js:642`): `colorIntensity`, `intensity`, `strobeFrequency`,
 * direct-prop-set fallthrough for everything else.
 *
 * Visualization is intentionally simple — a 0.6 m × 0.4 m plane with
 * additive blending. The cue engine drives `intensity` 0..1; the panel's
 * emissive color is multiplied by that and an internal strobe-shutter
 * envelope so the panel visibly pulses when a strobe cue fires.
 */

let scene_handle = null;
const instances = [];

const PANEL_W = 0.6;
const PANEL_H = 0.4;

class StrobePanel {
  constructor() {
    this._color = new THREE.Color('white');
    this._intensity = 0;
    this._strobeFrequency = 0;
    this._shutter = 1;
    this._activeColorPreset = false;

    const geometry = new THREE.PlaneGeometry(PANEL_W, PANEL_H);
    const material = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0,
      side: THREE.DoubleSide,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
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
    this._intensity = Math.min(Math.max(v || 0, 0), 1);
    this._updateOpacity();
  }
  get intensity() { return this._intensity; }

  set strobeFrequency(hz) {
    this._strobeFrequency = Math.max(hz || 0, 0);
  }

  set color(c) {
    this._color = c instanceof THREE.Color ? c : new THREE.Color(c);
    this._mesh.material.color.copy(this._color);
  }
  get color() { return this._color; }

  set colorIntensity(channelData) {
    if (this._activeColorPreset) return;
    const channel = channelData.color.toLowerCase().charAt(0);
    const c = this._color;
    if (channel === 'r' || channel === 'g' || channel === 'b') {
      c[channel] = Math.max(channelData.colorBrightness, 0.00001);
      this._mesh.material.color.copy(c);
    }
  }
  set colorPreset(value) {
    if (value) {
      this._activeColorPreset = true;
      this.color = value;
    } else {
      this._activeColorPreset = false;
    }
  }
  // Wheel slot — strobes generally don't have one, but Fixture may still
  // call this; no-op gracefully.
  set colorWheelSlot(_slotId) { /* noop */ }
  set colorTemp(_temp) { /* noop — strobes are emissive panels, no warmth */ }

  _updateOpacity() {
    const baseOpacity = this._intensity * this._shutter;
    this._mesh.material.opacity = baseOpacity;
  }

  update(t) {
    if (this._strobeFrequency > 0) {
      this._shutter = Math.sin(2 * Math.PI * this._strobeFrequency * t) > 0 ? 1 : 0;
    } else {
      this._shutter = 1;
    }
    this._updateOpacity();
  }

  static prepareInstanciation(_camera, scene) { scene_handle = scene; }

  static update(t) {
    for (const inst of instances) inst.update(t);
  }

  static deleteInstance(instance) {
    if (!instance) return;
    if (scene_handle) scene_handle.remove(instance._dummy);
    instance._mesh.geometry.dispose();
    instance._mesh.material.dispose();
    const idx = instances.indexOf(instance);
    if (idx >= 0) instances.splice(idx, 1);
  }
}

export default StrobePanel;
