// @ts-nocheck
import * as THREE from "three";

/**
 * SE(3) sampler producing pose tuples `{ position, rotation }` where
 * - `position` is uniformly sampled in the supplied axis-aligned `bounds`
 * - `rotation` is a unit quaternion uniformly sampled on S^3 using the
 *   Marsaglia 4D method.
 *
 * The sampler reads its randomness from the supplied RNG callable so callers
 * can keep planning reproducible by seeding the PRNG.
 */
export function createSe3Sampler({ rng, bounds }) {
  function sampleQuaternion() {
    const u1 = rng();
    const u2 = rng();
    const u3 = rng();
    const sqrtComplement = Math.sqrt(1 - u1);
    const sqrtU1 = Math.sqrt(u1);
    const twoPi = 2 * Math.PI;
    return {
      x: sqrtComplement * Math.sin(twoPi * u2),
      y: sqrtComplement * Math.cos(twoPi * u2),
      z: sqrtU1 * Math.sin(twoPi * u3),
      w: sqrtU1 * Math.cos(twoPi * u3),
    };
  }

  function samplePosition() {
    return {
      x: bounds.min.x + rng() * (bounds.max.x - bounds.min.x),
      y: bounds.min.y + rng() * (bounds.max.y - bounds.min.y),
      z: bounds.min.z + rng() * (bounds.max.z - bounds.min.z),
    };
  }

  function sample() {
    return {
      position: samplePosition(),
      rotation: sampleQuaternion(),
    };
  }

  return { sample, samplePosition, sampleQuaternion };
}

/**
 * Derive a sampling AABB from a start/target pose pair plus any optional
 * extra anchor transforms (e.g. seed poses). The AABB is the tight box over
 * all supplied positions, then padded so the planner has room to maneuver
 * around obstacles.
 */
export function deriveSamplingBounds(startTransform, targetTransform, padding, extraTransforms = []) {
  const all = [startTransform, targetTransform, ...extraTransforms];
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (const transform of all) {
    if (!transform?.position) continue;
    const { x, y, z } = transform.position;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }
  const pad = Math.max(padding, 1e-3);
  return {
    min: { x: minX - pad, y: minY - pad, z: minZ - pad },
    max: { x: maxX + pad, y: maxY + pad, z: maxZ + pad },
  };
}

const tmpVecA = new THREE.Vector3();
const tmpVecB = new THREE.Vector3();
const tmpQuatA = new THREE.Quaternion();
const tmpQuatB = new THREE.Quaternion();

/**
 * SE(3) distance: Euclidean translation distance plus quaternion angular
 * distance scaled by `rotationDistanceWeight`. Matches the metric used by
 * `collisionFreePath.ts` so behavior is consistent across planners.
 */
export function transformDistance(a, b, rotationDistanceWeight) {
  tmpVecA.set(a.position.x, a.position.y, a.position.z);
  tmpVecB.set(b.position.x, b.position.y, b.position.z);
  tmpQuatA.set(a.rotation.x, a.rotation.y, a.rotation.z, a.rotation.w);
  tmpQuatB.set(b.rotation.x, b.rotation.y, b.rotation.z, b.rotation.w);
  if (tmpQuatA.lengthSq() === 0) tmpQuatA.identity();
  else tmpQuatA.normalize();
  if (tmpQuatB.lengthSq() === 0) tmpQuatB.identity();
  else tmpQuatB.normalize();
  return tmpVecA.distanceTo(tmpVecB) + rotationDistanceWeight * tmpQuatA.angleTo(tmpQuatB);
}

/**
 * Linear interpolation of a SE(3) pose: lerp on translation, slerp on rotation.
 * Returns a fresh plain-object pose suitable for downstream collision queries.
 */
export function interpolateTransform(a, b, t) {
  const pa = new THREE.Vector3(a.position.x, a.position.y, a.position.z);
  const pb = new THREE.Vector3(b.position.x, b.position.y, b.position.z);
  const qa = new THREE.Quaternion(a.rotation.x, a.rotation.y, a.rotation.z, a.rotation.w);
  const qb = new THREE.Quaternion(b.rotation.x, b.rotation.y, b.rotation.z, b.rotation.w);
  if (qa.lengthSq() === 0) qa.identity();
  else qa.normalize();
  if (qb.lengthSq() === 0) qb.identity();
  else qb.normalize();
  pa.lerp(pb, t);
  qa.slerp(qb, t);
  return {
    position: { x: pa.x, y: pa.y, z: pa.z },
    rotation: { x: qa.x, y: qa.y, z: qa.z, w: qa.w },
    scale: a.scale ?? b.scale,
  };
}

export function cloneTransform(transform) {
  return {
    position: {
      x: transform.position.x,
      y: transform.position.y,
      z: transform.position.z,
    },
    rotation: {
      x: transform.rotation.x,
      y: transform.rotation.y,
      z: transform.rotation.z,
      w: transform.rotation.w,
    },
    scale: transform.scale
      ? { x: transform.scale.x, y: transform.scale.y, z: transform.scale.z }
      : undefined,
  };
}
