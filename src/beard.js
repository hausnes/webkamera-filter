/* A furry 3D Santa beard and mustache that deform with your face.
 *
 * Both are built once in canonical head space (cm) and bound to the nearest
 * face-model vertices. Every frame the live face displacement from FaceRig is
 * applied, so the beard drops when you open your mouth and the mustache rides
 * on your upper lip when you smile.
 *
 * The beard is a grid: columns run along the jaw line from ear to ear, rows run
 * from the top edge on the cheeks (sideburns at the sides, just under the lower
 * lip in the middle) down to the jaw, then hang below the chin.
 */

import * as THREE from 'three';
import { CANONICAL_VERTICES } from './canonicalFace.js';
import { FACE_VERTEX_COUNT, bindToFace, applyFaceSkin } from './faceRig.js';
import { createFurGeometry, createFurMaterial, updateFurGeometry } from './fur.js';

// Face-oval landmarks along the jaw, from the left ear via the chin to the right ear.
const JAW = [234, 93, 132, 58, 172, 136, 150, 149, 176, 148, 152, 377, 400, 378, 379, 365, 397, 288, 361, 323, 454];
const COLUMNS = 31;
const FACE_ROWS = 9;
const HANG_ROWS = 12;
const BEARD_LENGTH = 9.5; // cm below the chin
const SURFACE_OFFSET = 0.35; // cm above the skin
const FUR_DENSITY = 5;

const _q = new THREE.Quaternion();

const canonical = (k) => new THREE.Vector3().fromArray(CANONICAL_VERTICES, k * 3);

// Lower-face vertices the beard may follow.
const LOWER_FACE = [];
for (let k = 0; k < FACE_VERTEX_COUNT; k++) {
  if (CANONICAL_VERTICES[k * 3 + 1] < 4.5 && CANONICAL_VERTICES[k * 3 + 2] > -3.5) LOWER_FACE.push(k);
}

/** Height of the beard's top edge: under the lower lip, up the cheeks, into sideburns. */
function topEdgeY(x) {
  const ax = Math.abs(x);
  const cheek = THREE.MathUtils.smoothstep(ax, 3.0, 5.0);
  const sideburn = THREE.MathUtils.smoothstep(ax, 5.6, 7.4);
  return -5.9 + cheek * 4.3 + sideburn * 5.6;
}

/** Depth of the face surface at (x, y), interpolated from the nearest canonical vertices. */
function surfaceZ(x, y) {
  const best = [];
  for (const k of LOWER_FACE) {
    const dx = CANONICAL_VERTICES[k * 3] - x;
    const dy = CANONICAL_VERTICES[k * 3 + 1] - y;
    best.push([dx * dx + dy * dy, CANONICAL_VERTICES[k * 3 + 2]]);
  }
  best.sort((a, b) => a[0] - b[0]);
  let z = 0, total = 0;
  for (const [d, vz] of best.slice(0, 4)) {
    const w = 1 / (d + 0.05);
    z += vz * w;
    total += w;
  }
  return z / total;
}

function outward(p) {
  return new THREE.Vector3(p.x, (p.y + 1) * 0.3, p.z + 3).normalize();
}

function buildBeardRest() {
  const jaw = new THREE.CatmullRomCurve3(JAW.map(canonical), false, 'centripetal');
  const rows = FACE_ROWS + HANG_ROWS;
  const points = [];
  const uvs = [];

  for (let c = 0; c < COLUMNS; c++) {
    const u = c / (COLUMNS - 1);
    const J = jaw.getPointAt(u);
    const xn = Math.min(Math.abs(J.x) / 7.7, 1);
    const top = new THREE.Vector2(J.x * 0.96, topEdgeY(J.x));

    for (let r = 0; r < FACE_ROWS; r++) {
      const t = r / (FACE_ROWS - 1);
      const x = THREE.MathUtils.lerp(top.x, J.x, t);
      const y = THREE.MathUtils.lerp(top.y, J.y, t);
      const z = r === FACE_ROWS - 1 ? J.z : surfaceZ(x, y);
      const p = new THREE.Vector3(x, y, z);
      points.push(p.addScaledVector(outward(p), SURFACE_OFFSET));
    }

    // Hang below the jaw: long at the chin, short towards the ears, with a full, rounded bottom.
    const length = BEARD_LENGTH * Math.sqrt(Math.max(0, 1 - xn * xn));
    const base = points[points.length - 1].clone();
    for (let r = 1; r <= HANG_ROWS; r++) {
      const s = r / HANG_ROWS;
      points.push(new THREE.Vector3(
        base.x * (1 + 0.25 * s - 0.4 * s * s),
        base.y - length * s,
        base.z + (2.5 * s - 1.0 * s * s) * (1 - xn)
      ));
    }

    for (let r = 0; r < rows; r++) uvs.push(u, r / (rows - 1));
  }

  const index = [];
  for (let c = 0; c < COLUMNS - 1; c++) {
    for (let r = 0; r < rows - 1; r++) {
      const a = c * rows + r;
      const b = a + rows;
      index.push(a, a + 1, b, b, a + 1, b + 1);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(points.flatMap((p) => p.toArray()), 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(index);
  orientOutward(geometry);
  return { geometry, points, size: new THREE.Vector2(jaw.getLength(), 18) };
}

function buildMustacheRest() {
  // Over the upper lip, drooping past the mouth corners.
  const half = [
    [0, -2.95, 6.55],
    [-0.7, -2.8, 6.45],
    [-1.9, -3.05, 5.8],
    [-3.2, -3.85, 4.75],
    [-4.2, -4.9, 3.6]
  ];
  const pts = [...half.slice(1).reverse().map(([x, y, z]) => [-x, y, z]), ...half].reverse();
  const curve = new THREE.CatmullRomCurve3(pts.map((p) => new THREE.Vector3(...p)));
  const segments = 48;
  const radial = 12;
  const geometry = new THREE.TubeGeometry(curve, segments, 1, radial, false);

  // Shape the cross-section: thin in the middle, full at the sides, tapered tips.
  const pos = geometry.attributes.position;
  const center = new THREE.Vector3();
  const p = new THREE.Vector3();
  for (let i = 0; i <= segments; i++) {
    const u = i / segments;
    const s = Math.abs(2 * u - 1);
    const radius = (0.55 + 0.5 * Math.sin(Math.PI * Math.min(s * 1.1, 1))) * (1 - 0.7 * Math.pow(s, 4));
    curve.getPointAt(u, center);
    for (let j = 0; j <= radial; j++) {
      const k = i * (radial + 1) + j;
      p.fromBufferAttribute(pos, k).sub(center);
      p.y *= 0.8; // a bit flatter than it is deep
      pos.setXYZ(k, center.x + p.x * radius, center.y + p.y * radius, center.z + p.z * radius);
    }
  }
  geometry.computeVertexNormals();
  const points = [];
  for (let k = 0; k < pos.count; k++) points.push(new THREE.Vector3().fromBufferAttribute(pos, k));
  return { geometry, points, size: new THREE.Vector2(curve.getLength(), 2 * Math.PI * 0.6) };
}

/** Flips the winding if needed so computed normals point away from the face. */
function orientOutward(geometry) {
  geometry.computeVertexNormals();
  const pos = geometry.attributes.position;
  const nrm = geometry.attributes.normal;
  let score = 0;
  const p = new THREE.Vector3();
  const n = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    score += n.fromBufferAttribute(nrm, i).dot(outward(p.fromBufferAttribute(pos, i)));
  }
  if (score < 0) {
    const idx = geometry.index.array;
    for (let i = 0; i < idx.length; i += 3) [idx[i + 1], idx[i + 2]] = [idx[i + 2], idx[i + 1]];
    geometry.computeVertexNormals();
  }
}

class FurPiece {
  constructor(parent, { geometry, points, size }, { shells, density, ...material }) {
    this.base = geometry;
    this.rest = new Float32Array(geometry.attributes.position.array);
    this.binding = bindToFace(points, LOWER_FACE);
    this.material = createFurMaterial({
      ...material,
      uvScale: new THREE.Vector2(size.x * density, size.y * density)
    });
    this.mesh = new THREE.Mesh(createFurGeometry(geometry, shells), this.material);
    this.mesh.geometry.attributes.position.setUsage(THREE.DynamicDrawUsage);
    this.mesh.geometry.attributes.normal.setUsage(THREE.DynamicDrawUsage);
    // Drawn after the face occluder but before the head ellipsoid, which would
    // otherwise poke through the lower face and hide parts of the beard.
    this.mesh.renderOrder = -2;
    this.mesh.frustumCulled = false;
    parent.add(this.mesh);
  }

  update(displacement, gravityDir) {
    applyFaceSkin(this.rest, this.binding, displacement, this.base.attributes.position.array);
    this.base.computeVertexNormals();
    updateFurGeometry(this.mesh.geometry, this.base);
    this.material.uniforms.gravityDir.value.copy(gravityDir);
  }
}

export class Beard {
  constructor(head) {
    this.head = head;
    this.beard = new FurPiece(head, buildBeardRest(), {
      shells: 28,
      density: FUR_DENSITY,
      furLength: 1.6,
      droop: 1.0,
      curl: 1.5,
      edgeWidth: 0.08,
      color: 0xf3efe6
    });
    this.mustache = new FurPiece(head, buildMustacheRest(), {
      shells: 24,
      density: 7,
      furLength: 0.8,
      droop: 0.6,
      curl: 0.8,
      color: 0xf6f3ec
    });
    this.gravity = new THREE.Vector3();
  }

  get materials() {
    return [this.beard.material, this.mustache.material];
  }

  /** @param displacement FaceRig.displacement (live minus canonical, head space) */
  update(displacement) {
    this.head.updateWorldMatrix(true, false);
    this.head.matrixWorld.decompose(new THREE.Vector3(), _q, new THREE.Vector3());
    this.gravity.set(0, -1, 0).applyQuaternion(_q.invert());
    this.beard.update(displacement, this.gravity);
    this.mustache.update(displacement, this.gravity);
  }
}
