/* Live face shape in head space.
 *
 * MediaPipe's landmarks are 2D image positions. We give each one the depth of
 * its matching canonical vertex under the current head pose, lift it into 3D
 * along the camera ray, and bring it back into head space. The difference to
 * the canonical model is how *your* face differs right now (jaw open, smile,
 * face shape), which the beard uses to deform. The same points also drive a
 * depth-only face mesh so things behind your face are hidden.
 */

import * as THREE from 'three';
import { CANONICAL_VERTICES, CANONICAL_TRIANGLES } from './canonicalFace.js';

export const FACE_VERTEX_COUNT = CANONICAL_VERTICES.length / 3;
const OCCLUDER_INSET = 0.3; // cm, keeps the occluder just under the skin
const OCCLUDER_CENTER = new THREE.Vector3(0, -1, -3);

const _p = new THREE.Vector3();
const _inv = new THREE.Matrix4();

export class FaceRig {
  constructor(head, { debug = false } = {}) {
    this.live = new Float32Array(CANONICAL_VERTICES);
    this.displacement = new Float32Array(CANONICAL_VERTICES.length);
    this.hasData = false;

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      'position',
      new THREE.BufferAttribute(new Float32Array(CANONICAL_VERTICES), 3).setUsage(THREE.DynamicDrawUsage)
    );
    geometry.setIndex(new THREE.BufferAttribute(CANONICAL_TRIANGLES, 1));
    this.occluder = new THREE.Mesh(
      geometry,
      debug
        ? new THREE.MeshBasicMaterial({ color: 0xff00ff, wireframe: true })
        : new THREE.MeshBasicMaterial({ colorWrite: false, side: THREE.DoubleSide })
    );
    this.occluder.renderOrder = -3;
    this.occluder.frustumCulled = false;
    head.add(this.occluder);
  }

  reset() {
    this.hasData = false;
  }

  /**
   * @param landmarks MediaPipe normalized landmarks for one face
   * @param pose head pose (head space -> camera space)
   * @param camera the perspective camera the pose was estimated for
   * @param smoothing 0..1, how much of the new measurement to take this frame
   */
  update(landmarks, pose, camera, smoothing = 0.5) {
    const tanHalf = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
    _inv.copy(pose).invert();
    const alpha = this.hasData ? smoothing : 1;
    const occ = this.occluder.geometry.attributes.position;

    for (let k = 0; k < FACE_VERTEX_COUNT; k++) {
      const i = k * 3;
      _p.set(CANONICAL_VERTICES[i], CANONICAL_VERTICES[i + 1], CANONICAL_VERTICES[i + 2]).applyMatrix4(pose);
      const depth = -_p.z;
      const lm = landmarks[k];
      _p.set(
        (lm.x * 2 - 1) * depth * tanHalf * camera.aspect,
        (1 - lm.y * 2) * depth * tanHalf,
        -depth
      ).applyMatrix4(_inv);

      for (let c = 0; c < 3; c++) {
        const v = this.live[i + c] + (_p.getComponent(c) - this.live[i + c]) * alpha;
        this.live[i + c] = v;
        this.displacement[i + c] = v - CANONICAL_VERTICES[i + c];
      }

      _p.fromArray(this.live, i);
      const len = _p.distanceTo(OCCLUDER_CENTER);
      _p.lerp(OCCLUDER_CENTER, OCCLUDER_INSET / len);
      occ.setXYZ(k, _p.x, _p.y, _p.z);
    }
    occ.needsUpdate = true;
    this.hasData = true;
  }
}

/** Precomputes skinning: each point follows its `count` nearest canonical vertices. */
export function bindToFace(points, candidates, count = 4) {
  const indices = new Uint16Array(points.length * count);
  const weights = new Float32Array(points.length * count);
  const dist = new Float32Array(candidates.length);
  const order = candidates.map((_, i) => i);

  points.forEach((p, n) => {
    candidates.forEach((k, i) => {
      dist[i] = p.distanceToSquared(_p.fromArray(CANONICAL_VERTICES, k * 3));
    });
    order.sort((a, b) => dist[a] - dist[b]);
    let total = 0;
    for (let j = 0; j < count; j++) {
      const w = 1 / (dist[order[j]] + 0.5);
      indices[n * count + j] = candidates[order[j]];
      weights[n * count + j] = w;
      total += w;
    }
    for (let j = 0; j < count; j++) weights[n * count + j] /= total;
  });
  return { indices, weights, count };
}

/** Writes rest positions + skinned face displacement into `out` (a position array). */
export function applyFaceSkin(rest, binding, displacement, out) {
  const { indices, weights, count } = binding;
  for (let n = 0; n < rest.length / 3; n++) {
    let dx = 0, dy = 0, dz = 0;
    for (let j = 0; j < count; j++) {
      const k = indices[n * count + j] * 3;
      const w = weights[n * count + j];
      dx += displacement[k] * w;
      dy += displacement[k + 1] * w;
      dz += displacement[k + 2] * w;
    }
    out[n * 3] = rest[n * 3] + dx;
    out[n * 3 + 1] = rest[n * 3 + 1] + dy;
    out[n * 3 + 2] = rest[n * 3 + 2] + dz;
  }
}
