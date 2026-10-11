/* Smooths the head pose with a One Euro filter: heavy smoothing when the head is
 * still (kills jitter), light smoothing when it moves fast (avoids lag).
 * See https://gery.casiez.net/1euro/ */

import * as THREE from 'three';

function smoothingAlpha(cutoffHz, dt) {
  const tau = 1 / (2 * Math.PI * cutoffHz);
  return 1 / (1 + tau / dt);
}

export class PoseFilter {
  constructor({ minCutoff = 1.2, beta = 0.08, derivCutoff = 1.0 } = {}) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.derivCutoff = derivCutoff;
    this.position = new THREE.Vector3();
    this.quaternion = new THREE.Quaternion();
    this.scale = new THREE.Vector3(1, 1, 1);
    this.speed = 0; // filtered speed in cm/s (rotation converted to an equivalent speed)
    this.initialized = false;
    this._pos = new THREE.Vector3();
    this._quat = new THREE.Quaternion();
    this._scale = new THREE.Vector3();
  }

  reset() {
    this.initialized = false;
  }

  /** Filters a raw pose matrix and writes the smoothed pose into `out`. */
  filter(rawMatrix, dt, out) {
    rawMatrix.decompose(this._pos, this._quat, this._scale);
    if (!this.initialized) {
      this.position.copy(this._pos);
      this.quaternion.copy(this._quat);
      this.scale.copy(this._scale);
      this.speed = 0;
      this.initialized = true;
    } else {
      // Rotation is converted to cm/s at roughly head radius so one cutoff covers both.
      const linear = this._pos.distanceTo(this.position) / dt;
      const angular = (this.quaternion.angleTo(this._quat) * 10) / dt;
      const rawSpeed = linear + angular;
      this.speed += smoothingAlpha(this.derivCutoff, dt) * (rawSpeed - this.speed);

      const alpha = smoothingAlpha(this.minCutoff + this.beta * this.speed, dt);
      this.position.lerp(this._pos, alpha);
      this.quaternion.slerp(this._quat, alpha);
      this.scale.lerp(this._scale, alpha);
    }
    return out.compose(this.position, this.quaternion, this.scale);
  }
}
