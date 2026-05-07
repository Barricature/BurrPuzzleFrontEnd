// @ts-nocheck
import * as THREE from "three";

/**
 * Constraint manifolds used by the CBiRRT planner.
 *
 * Each constraint exposes:
 * - `project(transform)`: returns the closest pose on the manifold
 * - `distanceTo(transform)`: signed scalar distance from `transform` to the
 *   manifold (used for diagnostics; the planner does not depend on it for
 *   correctness)
 * - `id`: short name used in debug output
 *
 * All constraints work directly on plain `Se3Transform` shapes
 * (`{ position, rotation, scale? }`).
 */

/**
 * M0: free space. Identity projection. Used by the planner when no narrow
 * passage / contact constraint applies in the current region of C-space.
 */
export function createFreeConstraint() {
  return {
    id: "free",
    project(transform) {
      return transform;
    },
    distanceTo() {
      return 0;
    },
  };
}

/**
 * M1: approach-along-normal.
 *
 * Defines a 1-DOF manifold containing exactly the poses that:
 * - share the target rotation
 * - have a position lying on the line through `targetTransform.position`
 *   along `attachmentNormalWorld`
 *
 * Geometrically this is the path Block Adhere already exploits: rotation is
 * locked, translation is restricted to the attachment normal axis. Adding M1
 * to CBiRRT lets the planner deterministically slide along that axis once it
 * is close enough to the target.
 */
export function createApproachAlongNormalConstraint({
  targetTransform,
  attachmentNormalWorld,
}) {
  const targetPosition = new THREE.Vector3(
    targetTransform.position.x,
    targetTransform.position.y,
    targetTransform.position.z,
  );
  const targetRotation = new THREE.Quaternion(
    targetTransform.rotation.x,
    targetTransform.rotation.y,
    targetTransform.rotation.z,
    targetTransform.rotation.w,
  );
  if (targetRotation.lengthSq() === 0) {
    targetRotation.identity();
  } else {
    targetRotation.normalize();
  }

  const normal = new THREE.Vector3(
    attachmentNormalWorld.x,
    attachmentNormalWorld.y,
    attachmentNormalWorld.z,
  );
  if (normal.lengthSq() === 0) {
    throw new Error("approach-along-normal constraint requires a non-zero attachment normal");
  }
  normal.normalize();

  function project(transform) {
    const point = new THREE.Vector3(
      transform.position.x,
      transform.position.y,
      transform.position.z,
    );
    const offset = point.clone().sub(targetPosition);
    const t = offset.dot(normal);
    const projected = targetPosition.clone().addScaledVector(normal, t);
    return {
      position: { x: projected.x, y: projected.y, z: projected.z },
      rotation: {
        x: targetRotation.x,
        y: targetRotation.y,
        z: targetRotation.z,
        w: targetRotation.w,
      },
      scale: transform.scale,
    };
  }

  function distanceTo(transform) {
    const point = new THREE.Vector3(
      transform.position.x,
      transform.position.y,
      transform.position.z,
    );
    const offset = point.clone().sub(targetPosition);
    const t = offset.dot(normal);
    const projection = targetPosition.clone().addScaledVector(normal, t);
    const positionError = point.distanceTo(projection);
    const candidateRotation = new THREE.Quaternion(
      transform.rotation.x,
      transform.rotation.y,
      transform.rotation.z,
      transform.rotation.w,
    );
    if (candidateRotation.lengthSq() === 0) {
      candidateRotation.identity();
    } else {
      candidateRotation.normalize();
    }
    return positionError + candidateRotation.angleTo(targetRotation);
  }

  return { id: "approach-along-normal", project, distanceTo };
}

/**
 * Choose which constraint applies at a given configuration.
 *
 * The selection rule: if an approach-along-normal constraint was supplied AND
 * the configuration is within `activationDistance` of the target position, use
 * the approach constraint. Otherwise, treat the region as free space.
 *
 * Pass `activationDistance = Infinity` to make the approach constraint apply
 * everywhere; pass `null`/`undefined` to disable it entirely.
 */
export function pickConstraint({
  transform,
  targetPosition,
  approachConstraint,
  freeConstraint,
  activationDistance,
}) {
  if (!approachConstraint || activationDistance == null || activationDistance <= 0) {
    return freeConstraint;
  }
  const dx = transform.position.x - targetPosition.x;
  const dy = transform.position.y - targetPosition.y;
  const dz = transform.position.z - targetPosition.z;
  const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
  return distance <= activationDistance ? approachConstraint : freeConstraint;
}
