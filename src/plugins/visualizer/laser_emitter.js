import * as THREE from 'three';
import { Line2 } from 'three/examples/jsm/lines/Line2.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js';

/**
 * LaserEmitter — thin emissive line stand-in for a laser fixture. The line
 * extends from the fixture's position outward along the direction encoded
 * by the `pan` / `tilt` channels, with thickness driven by `intensity` and
 * color taken from the channel writes.
 *
 * Implementation uses `Line2` for screen-space-thickness rendering so the
 * laser stays visible regardless of distance/angle.
 */

let scene_handle = null;
const instances = [];

const LASER_LENGTH = 30; // metres
const PAN_RANGE_DEG = 540; // typical laser pan range
const TILT_RANGE_DEG = 270; // typical laser tilt range
const RESOLUTION = new THREE.Vector2(1, 1); // updated on resize via setResolution()

class LaserEmitter {
  constructor() {
    this._color = new THREE.Color('red');
    this._intensity = 0;
    this._pan = 128; // 0..255 → 0..PAN_RANGE_DEG
    this._tilt = 128;

    const geometry = new LineGeometry();
    geometry.setPositions([0, 0, 0, 0, LASER_LENGTH, 0]);
    this._geometry = geometry;
    this._material = new LineMaterial({
      color: 0xff0000,
      linewidth: 3, // pixels (Line2 / LineMaterial uses screen-space units)
      transparent: true,
      opacity: 0,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
      resolution: RESOLUTION,
    });
    this._line = new Line2(geometry, this._material);
    this._line.computeLineDistances();
    this._dummy = new THREE.Object3D();
    this._dummy.add(this._line);
    if (scene_handle) scene_handle.add(this._dummy);
    instances.push(this);
  }

  set position(p) { if (p) this._dummy.position.set(p.x, p.y, Math.max(p.z, 0.5)); }
  get position() { return this._dummy.position; }
  set rotation(r) { if (r) this._dummy.rotation.set(r.x, r.y, r.z); }
  get rotation() { return this._dummy.rotation; }

  set intensity(v) {
    this._intensity = Math.min(Math.max(v || 0, 0), 1);
    this._material.opacity = this._intensity;
  }
  get intensity() { return this._intensity; }

  set color(c) {
    this._color = c instanceof THREE.Color ? c : new THREE.Color(c);
    this._material.color.copy(this._color);
  }
  get color() { return this._color; }

  set colorIntensity(channelData) {
    const channel = channelData.color.toLowerCase().charAt(0);
    const c = this._color.clone();
    switch (channel) {
      case 'r': case 'g': case 'b':
        c[channel] = Math.max(channelData.colorBrightness, 0.00001);
        break;
      default: return;
    }
    this.color = c;
  }
  set colorPreset(value) { if (value) this.color = value; }
  set colorWheelSlot(_) { /* noop */ }
  set colorTemp(_) { /* noop */ }
  set strobeFrequency(_) { /* lasers fire continuously in v1 */ }

  set pan(v) {
    this._pan = v;
    this._updateOrientation();
  }
  set panFine(_) { /* coarse precision is enough for visual */ }
  set tilt(v) {
    this._tilt = v;
    this._updateOrientation();
  }
  set tiltFine(_) { /* coarse precision is enough for visual */ }

  _updateOrientation() {
    const panDeg = (this._pan / 255) * PAN_RANGE_DEG - PAN_RANGE_DEG / 2;
    const tiltDeg = (this._tilt / 255) * TILT_RANGE_DEG - TILT_RANGE_DEG / 2;
    this._line.rotation.set(
      THREE.MathUtils.degToRad(tiltDeg),
      0,
      THREE.MathUtils.degToRad(panDeg),
    );
  }

  static prepareInstanciation(_camera, scene) { scene_handle = scene; }
  static update(_t) { /* state already reflected via setters */ }

  static onResize(width, height) {
    RESOLUTION.set(width, height);
    for (const inst of instances) {
      inst._material.resolution = RESOLUTION;
    }
  }

  static deleteInstance(instance) {
    if (!instance) return;
    if (scene_handle) scene_handle.remove(instance._dummy);
    instance._geometry.dispose();
    instance._material.dispose();
    const idx = instances.indexOf(instance);
    if (idx >= 0) instances.splice(idx, 1);
  }
}

export default LaserEmitter;
