import * as THREE from 'three';

/**
 * ColorChangerPar — squat cylinder with an emissive front face. Used for
 * `Color Changer` and `Wash` categories. RGB/CMY/wheel channel writes flow
 * through `colorIntensity`, `colorPreset`, `colorWheelSlot` setters; the
 * front-face emissive color is updated directly so the par changes hue at
 * playback rate.
 */

let scene_handle = null;
const instances = [];

const RADIUS = 0.18;
const HEIGHT = 0.25;

class ColorChangerPar {
  constructor(data = {}) {
    this._color = new THREE.Color('white');
    this._intensity = 0;
    this._activeColorPreset = false;
    this._colorWheel = data.colorWheel || [];

    // Body: dark cylinder so the par is visible even at zero intensity.
    const bodyGeo = new THREE.CylinderGeometry(RADIUS, RADIUS, HEIGHT, 24, 1, false);
    const bodyMat = new THREE.MeshStandardMaterial({
      color: 0x222222,
      roughness: 0.5,
      metalness: 0.6,
    });
    this._body = new THREE.Mesh(bodyGeo, bodyMat);

    // Front face: emissive disc that takes the channel-driven color.
    const faceGeo = new THREE.CircleGeometry(RADIUS * 0.9, 24);
    const faceMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0,
      side: THREE.DoubleSide,
      toneMapped: false,
    });
    this._face = new THREE.Mesh(faceGeo, faceMat);
    // Cylinder axis is Y by default; orient face along the cylinder top.
    this._face.position.y = HEIGHT / 2 + 0.001;
    this._face.rotation.x = -Math.PI / 2;

    this._dummy = new THREE.Object3D();
    this._dummy.add(this._body);
    this._dummy.add(this._face);
    // Lay the par flat (axis along Z) so position.z = mounting height.
    this._dummy.rotation.x = Math.PI / 2;
    if (scene_handle) scene_handle.add(this._dummy);
    instances.push(this);
  }

  set position(p) { if (p) this._dummy.position.set(p.x, p.y, Math.max(p.z, 0.5)); }
  get position() { return this._dummy.position; }
  set rotation(r) {
    if (r) {
      // Compose user rotation onto the base Math.PI / 2 X-tilt that lays
      // the cylinder flat.
      this._dummy.rotation.set(Math.PI / 2 + r.x, r.y, r.z);
    }
  }
  get rotation() { return this._dummy.rotation; }

  set intensity(v) {
    this._intensity = Math.min(Math.max(v || 0, 0), 1);
    this._face.material.opacity = this._intensity;
  }
  get intensity() { return this._intensity; }

  set color(c) {
    this._color = c instanceof THREE.Color ? c : new THREE.Color(c);
    this._face.material.color.copy(this._color);
  }
  get color() { return this._color; }

  set colorIntensity(channelData) {
    if (this._activeColorPreset) return;
    const channel = channelData.color.toLowerCase().charAt(0);
    const c = this._color.clone();
    switch (channel) {
      case 'r': case 'g': case 'b':
        c[channel] = Math.max(channelData.colorBrightness, 0.00001);
        break;
      case 'c':
        c.r = Math.max(1.0 - channelData.colorBrightness, 0.00001);
        break;
      case 'm':
        c.g = Math.max(1.0 - channelData.colorBrightness, 0.00001);
        break;
      case 'y':
        c.b = Math.max(1.0 - channelData.colorBrightness, 0.00001);
        break;
      default: return;
    }
    this.color = c;
  }

  set colorPreset(value) {
    if (value) {
      this._activeColorPreset = true;
      this.color = value;
    } else {
      this._activeColorPreset = false;
    }
  }

  set colorWheelSlot(slotId) {
    if (this._colorWheel.length && slotId < this._colorWheel.length) {
      const slot = this._colorWheel[slotId];
      if (slot && slot.type === 'Color') {
        this.color = slot.colors ? slot.colors[0] : 'white';
      }
    }
  }

  set colorTemp(_temp) { /* noop — direct color drives the par instead */ }
  set strobeFrequency(_hz) { /* noop — strobing pars not visualized in v1 */ }

  static prepareInstanciation(_camera, scene) { scene_handle = scene; }
  static update(_t) { /* per-tick state already reflected via setters */ }

  static deleteInstance(instance) {
    if (!instance) return;
    if (scene_handle) scene_handle.remove(instance._dummy);
    instance._body.geometry.dispose();
    instance._body.material.dispose();
    instance._face.geometry.dispose();
    instance._face.material.dispose();
    const idx = instances.indexOf(instance);
    if (idx >= 0) instances.splice(idx, 1);
  }
}

export default ColorChangerPar;
