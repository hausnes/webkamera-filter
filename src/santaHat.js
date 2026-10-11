/* A 3D Santa hat attached to MediaPipe's head pose.
 *
 * Coordinates: everything in "head space" uses MediaPipe's canonical face model
 * (centimetres, +y up, +z out of the face, origin roughly mid-head). The pose
 * matrix maps head space into camera space, which is also our world space.
 *
 * Pieces:
 *  - an invisible head ellipsoid that only writes depth, so the parts of the
 *    hat behind your head are hidden (occlusion),
 *  - a furry brim and pom-pom (shell fur, see fur.js),
 *  - a velvet hat body rebuilt every frame around a spine whose upper part is a
 *    verlet-simulated chain, so the floppy tip swings when you move your head.
 */

import * as THREE from 'three';
import { createFurGeometry, createFurMaterial } from './fur.js';

// Head ellipsoid fitted to the canonical face model (forehead, brows and ears
// all lie within ~3% of its surface).
const HEAD_CENTER = new THREE.Vector3(0, 1.5, -3);
const HEAD_RADII = new THREE.Vector3(7.8, 11, 9.5);

// The brim sits tilted back: low on the forehead, lower still at the back of the head.
const BRIM_TILT = THREE.MathUtils.degToRad(12);
const BRIM_CENTER = new THREE.Vector3(0, 5.8, -3);
const BRIM_RADII = { x: 8.3, z: 10.0 };
const BRIM_TUBE = 2.0;

// Hat body
const TIP_SEGMENTS = 9;
const TIP_SEGMENT_LENGTH = 2.8;
const RINGS = 80;
const RADIAL = 40;
const POMPOM_RADIUS = 2.6;
const FUR_DENSITY = 7; // strands per cm

// Physics (cm, seconds)
const GRAVITY = new THREE.Vector3(0, -650, 0);
const DAMPING = 3.0; // 1/s
const SUBSTEPS = 3;
const CONSTRAINT_ITERATIONS = 4;

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _q = new THREE.Quaternion();

export class SantaHat {
  constructor(scene, { debug = false } = {}) {
    this.scene = scene;
    this.headMatrix = new THREE.Matrix4();
    this.headMatrixInv = new THREE.Matrix4();
    this.headQuat = new THREE.Quaternion();
    this.simReady = false;

    // --- Head-space group, driven directly by the pose matrix
    this.head = new THREE.Group();
    this.head.matrixAutoUpdate = false;
    scene.add(this.head);

    const ellipsoid = new THREE.SphereGeometry(1, 48, 32);
    this.occluder = new THREE.Mesh(
      ellipsoid,
      debug
        ? new THREE.MeshBasicMaterial({ color: 0x00ff88, wireframe: true })
        : new THREE.MeshBasicMaterial({ colorWrite: false })
    );
    this.occluder.position.copy(HEAD_CENTER);
    this.occluder.scale.copy(HEAD_RADII).multiplyScalar(0.98);
    this.occluder.renderOrder = -1;
    this.head.add(this.occluder);

    // --- Furry brim
    this.brimFrame = new THREE.Group();
    this.brimFrame.position.copy(BRIM_CENTER);
    this.brimFrame.rotation.x = -BRIM_TILT;
    this.head.add(this.brimFrame);

    const brimPath = new THREE.EllipseCurve(0, 0, BRIM_RADII.x, BRIM_RADII.z);
    const brimCurve = new THREE.CatmullRomCurve3(
      brimPath.getSpacedPoints(64).slice(0, -1).map((p) => new THREE.Vector3(p.x, 0, p.y)),
      true
    );
    const brimBase = new THREE.TubeGeometry(brimCurve, 180, BRIM_TUBE, 20, true);
    const brimLength = brimCurve.getLength();
    this.brimMaterial = createFurMaterial({
      furLength: 0.9,
      uvScale: new THREE.Vector2(brimLength * FUR_DENSITY, 2 * Math.PI * BRIM_TUBE * FUR_DENSITY)
    });
    this.brim = new THREE.Mesh(createFurGeometry(brimBase, 32), this.brimMaterial);
    this.brimFrame.add(this.brim);

    // --- Hat body (geometry rewritten every frame)
    this.bodyGeometry = createGridGeometry(RINGS, RADIAL);
    this.body = new THREE.Mesh(
      this.bodyGeometry,
      new THREE.MeshPhysicalMaterial({
        color: 0xb5121b,
        roughness: 0.78,
        sheen: 1,
        sheenColor: new THREE.Color(0xff7070),
        sheenRoughness: 0.4,
        side: THREE.DoubleSide
      })
    );
    this.body.frustumCulled = false;
    scene.add(this.body);

    // --- Pom-pom
    this.pompomMaterial = createFurMaterial({
      furLength: 1.1,
      uvScale: new THREE.Vector2(2 * Math.PI * POMPOM_RADIUS * FUR_DENSITY, Math.PI * POMPOM_RADIUS * FUR_DENSITY)
    });
    this.pompom = new THREE.Mesh(
      createFurGeometry(new THREE.SphereGeometry(POMPOM_RADIUS, 40, 28), 28),
      this.pompomMaterial
    );
    scene.add(this.pompom);

    this.buildRestShape();
    this.setVisible(false);
  }

  /** Spine in head space: three rigid points over the skull, then the floppy tip. */
  buildRestShape() {
    const up = new THREE.Vector3(0, Math.cos(BRIM_TILT), -Math.sin(BRIM_TILT));
    const r0 = BRIM_CENTER.clone();
    const r1 = r0.clone().addScaledVector(up, 5);
    const r2 = new THREE.Vector3(0.6, 16.0, -5.2);
    this.rigidLocal = [r0, r1, r2];

    // The tip rises a little, then flops over to the side where it stays visible.
    const startDir = r2.clone().sub(r1).normalize();
    const flopDir = new THREE.Vector3(0.9, -0.4, -0.2).normalize();
    this.tipLocal = [];
    const p = r2.clone();
    for (let i = 1; i <= TIP_SEGMENTS; i++) {
      const s = Math.pow(i / TIP_SEGMENTS, 0.9);
      const dir = startDir.clone().lerp(flopDir, s).normalize();
      p.addScaledVector(dir, TIP_SEGMENT_LENGTH);
      this.tipLocal.push(p.clone());
    }

    // Springs towards the rest shape: stiff near the head, loose at the tip.
    this.stiffness = this.tipLocal.map((_, i) => {
      const s = i / (TIP_SEGMENTS - 1);
      return 320 * Math.pow(1 - s, 2) + 14;
    });
    this.tipRadius = this.tipLocal.map((_, i) => tipRadiusAt((i + 1) / TIP_SEGMENTS));

    this.rigidWorld = this.rigidLocal.map(() => new THREE.Vector3());
    this.tipPos = this.tipLocal.map(() => new THREE.Vector3());
    this.tipPrev = this.tipLocal.map(() => new THREE.Vector3());
    this.tipRest = this.tipLocal.map(() => new THREE.Vector3());

    const rigidLength = r1.distanceTo(r0) + r2.distanceTo(r1);
    this.rigidFraction = rigidLength / (rigidLength + TIP_SEGMENTS * TIP_SEGMENT_LENGTH);
  }

  setVisible(visible) {
    this.head.visible = visible;
    this.body.visible = visible;
    this.pompom.visible = visible;
    if (!visible) this.simReady = false;
  }

  get furMaterials() {
    return [this.brimMaterial, this.pompomMaterial];
  }

  update(headMatrix, dt) {
    this.headMatrix.copy(headMatrix);
    this.headMatrixInv.copy(headMatrix).invert();
    this.head.matrix.copy(headMatrix);
    this.head.matrixWorldNeedsUpdate = true;
    headMatrix.decompose(_v, this.headQuat, _v2);

    for (let i = 0; i < this.rigidLocal.length; i++) {
      this.rigidWorld[i].copy(this.rigidLocal[i]).applyMatrix4(headMatrix);
    }
    for (let i = 0; i < TIP_SEGMENTS; i++) {
      this.tipRest[i].copy(this.tipLocal[i]).applyMatrix4(headMatrix);
    }

    if (!this.simReady) {
      for (let i = 0; i < TIP_SEGMENTS; i++) {
        this.tipPos[i].copy(this.tipRest[i]);
        this.tipPrev[i].copy(this.tipRest[i]);
      }
      this.simReady = true;
    } else {
      const h = Math.min(dt, 1 / 20) / SUBSTEPS;
      for (let s = 0; s < SUBSTEPS; s++) this.step(h);
    }

    this.rebuildBody();
    this.placePompom();
    this.updateFurGravity();
  }

  step(h) {
    const keep = Math.exp(-DAMPING * h);
    for (let i = 0; i < TIP_SEGMENTS; i++) {
      const p = this.tipPos[i];
      const prev = this.tipPrev[i];
      const vx = (p.x - prev.x) * keep;
      const vy = (p.y - prev.y) * keep;
      const vz = (p.z - prev.z) * keep;
      _v.copy(this.tipRest[i]).sub(p).multiplyScalar(this.stiffness[i]).add(GRAVITY);
      prev.copy(p);
      p.x += vx + _v.x * h * h;
      p.y += vy + _v.y * h * h;
      p.z += vz + _v.z * h * h;
    }

    const anchor = this.rigidWorld[this.rigidWorld.length - 1];
    for (let it = 0; it < CONSTRAINT_ITERATIONS; it++) {
      for (let i = 0; i < TIP_SEGMENTS; i++) {
        const a = i === 0 ? anchor : this.tipPos[i - 1];
        const b = this.tipPos[i];
        _v.subVectors(b, a);
        const d = _v.length() || 1e-6;
        const diff = (d - TIP_SEGMENT_LENGTH) / d;
        if (i === 0) {
          b.addScaledVector(_v, -diff);
        } else {
          a.addScaledVector(_v, diff * 0.5);
          b.addScaledVector(_v, -diff * 0.5);
        }
      }
      for (let i = 0; i < TIP_SEGMENTS; i++) this.collideWithHead(this.tipPos[i], this.tipRadius[i]);
    }
  }

  /** Pushes a world-space point out of the head ellipsoid (inflated by `radius`). */
  collideWithHead(p, radius) {
    _v.copy(p).applyMatrix4(this.headMatrixInv).sub(HEAD_CENTER);
    _v.x /= HEAD_RADII.x + radius;
    _v.y /= HEAD_RADII.y + radius;
    _v.z /= HEAD_RADII.z + radius;
    const len = _v.length();
    if (len >= 1 || len === 0) return;
    _v.divideScalar(len);
    _v.x *= HEAD_RADII.x + radius;
    _v.y *= HEAD_RADII.y + radius;
    _v.z *= HEAD_RADII.z + radius;
    p.copy(_v.add(HEAD_CENTER)).applyMatrix4(this.headMatrix);
  }

  rebuildBody() {
    const spine = new THREE.CatmullRomCurve3([...this.rigidWorld, ...this.tipPos], false, 'centripetal');
    const pos = this.bodyGeometry.attributes.position.array;
    const nrm = this.bodyGeometry.attributes.normal.array;

    // Start the ring frame on the head's x axis so the elliptical base lines up with the brim.
    const normal = new THREE.Vector3(1, 0, 0).applyQuaternion(this.headQuat);
    const binormal = new THREE.Vector3();
    const tangent = new THREE.Vector3();
    const center = new THREE.Vector3();
    const dir = new THREE.Vector3();

    let k = 0;
    for (let r = 0; r <= RINGS; r++) {
      const u = r / RINGS;
      spine.getPointAt(u, center);
      spine.getTangentAt(u, tangent);
      // Parallel transport keeps the rings from twisting along the curve.
      normal.addScaledVector(tangent, -normal.dot(tangent)).normalize();
      binormal.crossVectors(tangent, normal);

      const [rx, rz] = this.radiusAt(u);
      for (let a = 0; a <= RADIAL; a++) {
        const theta = (a / RADIAL) * Math.PI * 2;
        const c = Math.cos(theta);
        const s = Math.sin(theta);
        pos[k] = center.x + normal.x * rx * c + binormal.x * rz * s;
        pos[k + 1] = center.y + normal.y * rx * c + binormal.y * rz * s;
        pos[k + 2] = center.z + normal.z * rx * c + binormal.z * rz * s;
        dir.copy(normal).multiplyScalar(c / rx).addScaledVector(binormal, s / rz).normalize();
        nrm[k] = dir.x;
        nrm[k + 1] = dir.y;
        nrm[k + 2] = dir.z;
        k += 3;
      }
    }
    this.bodyGeometry.attributes.position.needsUpdate = true;
    this.bodyGeometry.attributes.normal.needsUpdate = true;
    this.bodyGeometry.computeBoundingSphere();
    this.spine = spine;
  }

  /** Cross-section radii (x, z) along the spine: puffy over the skull, tapering to the tip. */
  radiusAt(u) {
    if (u <= this.rigidFraction) {
      const t = u / this.rigidFraction;
      const e = t * t * (3 - 2 * t);
      return [THREE.MathUtils.lerp(7.6, 5.6, e), THREE.MathUtils.lerp(9.2, 5.6, e)];
    }
    const r = tipRadiusAt((u - this.rigidFraction) / (1 - this.rigidFraction));
    return [r, r];
  }

  placePompom() {
    const tip = this.tipPos[TIP_SEGMENTS - 1];
    const prev = this.tipPos[TIP_SEGMENTS - 2];
    _v.subVectors(tip, prev).normalize();
    this.pompom.position.copy(tip).addScaledVector(_v, POMPOM_RADIUS * 0.6);
    this.pompom.quaternion.copy(this.headQuat);
  }

  updateFurGravity() {
    this.brimFrame.updateWorldMatrix(true, false);
    this.brimFrame.getWorldQuaternion(_q).invert();
    this.brimMaterial.uniforms.gravityDir.value.set(0, -1, 0).applyQuaternion(_q);
    _q.copy(this.pompom.quaternion).invert();
    this.pompomMaterial.uniforms.gravityDir.value.set(0, -1, 0).applyQuaternion(_q);
  }
}

function tipRadiusAt(s) {
  return 0.7 + (5.6 - 0.7) * Math.pow(1 - s, 1.4);
}

/** An indexed (rings+1) x (radial+1) grid whose positions/normals are filled in later. */
function createGridGeometry(rings, radial) {
  const count = (rings + 1) * (radial + 1);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 3), 3).setUsage(THREE.DynamicDrawUsage));
  geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(count * 3), 3).setUsage(THREE.DynamicDrawUsage));
  const index = [];
  for (let r = 0; r < rings; r++) {
    for (let a = 0; a < radial; a++) {
      const i0 = r * (radial + 1) + a;
      const i1 = i0 + radial + 1;
      index.push(i0, i1, i0 + 1, i1, i1 + 1, i0 + 1);
    }
  }
  geo.setIndex(index);
  return geo;
}
