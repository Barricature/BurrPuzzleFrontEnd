/**
 * SE(3) collision-free path planning.
 *
 * The planner assumes the target transform is already known. Its job is to
 * find intermediate rigid transforms that avoid penetration, using a scene
 * query API for collision checks and object occupancy data.
 */

import { Box3, BufferGeometry, Matrix4, Quaternion, Vector3 } from "three";
import { MeshBVH } from "three-mesh-bvh";

export type Vector3Like = {
  x: number;
  y: number;
  z: number;
};

export type QuaternionLike = {
  x: number;
  y: number;
  z: number;
  w: number;
};

export type Se3Transform = {
  position: Vector3Like;
  rotation: QuaternionLike;
  scale?: Vector3Like;
};

export type Bounds3Like = {
  min: Vector3Like;
  max: Vector3Like;
};

export type CollisionObjectSnapshot = {
  objectId: string;
  worldTransform: Se3Transform;
  collisionMeshId: string;
};

export type CollisionStatus = "separated" | "touching" | "penetrating";

export type ClassifyObjectAtTransformInput = {
  movingObjectId: string;
  candidateTransform: Se3Transform;
  sceneQuery: CollisionSceneQuery;
  collisionEpsilon: number;
};

export type ClassifyObjectAtTransformOutput = {
  status: CollisionStatus;
  firstHit?: {
    movingObjectId: string;
    obstacleObjectId: string;
  };
};

export type CollisionSceneQuery = {
  getMovingObjectSnapshot(objectId: string): CollisionObjectSnapshot;
  getObstacleSnapshots(movingObjectId: string): CollisionObjectSnapshot[];
  getCollisionCache(collisionMeshId: string): CollisionMeshCache;
  classifyObjectAtTransform(input: ClassifyObjectAtTransformInput): ClassifyObjectAtTransformOutput;
};

export type CollisionMeshCache = {
  localBounds: Box3;
  bvh: MeshBVH;
  geometry: BufferGeometry;
};

type CreateBvhCollisionSceneQueryInput = {
  movingObjectId: string;
  objects: CollisionObjectSnapshot[];
  collisionCaches: Map<string, CollisionMeshCache>;
};

export type PlanCollisionFreeSe3PathInput = {
  movingObjectId: string;
  startTransform: Se3Transform;
  targetTransform: Se3Transform;
  attachmentNormalWorld: Vector3Like;
  sceneQuery: CollisionSceneQuery;
  options?: {
    bounds?: Bounds3Like;
    maxClearance?: number;
    minClearance?: number;
    translationStep?: number;
    rotationStepRadians?: number;
    collisionEpsilon?: number;
    maxLocalSegmentChecks?: number;
    rotationDistanceWeight?: number;
    clearancePadding?: number;
    maxStagingAttempts?: number;
    stagingClearanceScaleStep?: number;
    maxStagingClearanceFactor?: number;
  };
};

export type PlanCollisionFreeSe3PathOutput =
  | {
      status: "found";
      transforms: Se3Transform[];
      stats: {
        iterations: number;
        collisionChecks: number;
        pathLength: number;
      };
    }
  | {
      status: "not-found";
      reason: "target-blocked" | "start-blocked" | "invalid-normal" | "staging-blocked" | "approach-blocked";
      bestAttempt?: Se3Transform;
      stats: {
        collisionChecks: number;
      };
    };

type PlannerOptions = Required<NonNullable<PlanCollisionFreeSe3PathInput["options"]>>;

type CollisionStats = {
  collisionChecks: number;
};

const DEFAULT_OPTIONS: PlannerOptions = {
  bounds: {
    min: { x: -10, y: -10, z: -10 },
    max: { x: 10, y: 10, z: 10 },
  },
  maxClearance: 20,
  minClearance: 0.5,
  translationStep: 0.25,
  rotationStepRadians: Math.PI / 18,
  collisionEpsilon: 1e-5,
  maxLocalSegmentChecks: 80,
  rotationDistanceWeight: 1,
  clearancePadding: 0.25,
  maxStagingAttempts: 6,
  stagingClearanceScaleStep: 1.5,
  maxStagingClearanceFactor: 4,
};

function mergeOptions(options: PlanCollisionFreeSe3PathInput["options"]): PlannerOptions {
  return {
    ...DEFAULT_OPTIONS,
    ...options,
    bounds: options?.bounds ?? DEFAULT_OPTIONS.bounds,
  };
}

function toVector3(value: Vector3Like): Vector3 {
  return value instanceof Vector3 ? (value as Vector3).clone() : new Vector3(value.x, value.y, value.z);
}

function toQuaternion(value: QuaternionLike): Quaternion {
  const quaternion = value instanceof Quaternion
    ? (value as Quaternion).clone()
    : new Quaternion(value.x, value.y, value.z, value.w);

  if (quaternion.lengthSq() === 0) {
    return new Quaternion();
  }
  return quaternion.normalize();
}

function cloneTransform(value: Se3Transform): Se3Transform {
  return {
    position: toVector3(value.position),
    rotation: toQuaternion(value.rotation),
    scale: value.scale ? toVector3(value.scale) : undefined,
  };
}

function vectorDistance(a: Vector3Like, b: Vector3Like): number {
  return toVector3(a).distanceTo(toVector3(b));
}

function lerpVector(a: Vector3Like, b: Vector3Like, t: number): Vector3Like {
  return toVector3(a).lerp(toVector3(b), t);
}

function quaternionAngularDistance(a: QuaternionLike, b: QuaternionLike): number {
  return toQuaternion(a).angleTo(toQuaternion(b));
}

function slerpQuaternion(a: QuaternionLike, b: QuaternionLike, t: number): QuaternionLike {
  return toQuaternion(a).slerp(toQuaternion(b), t);
}

function interpolateTransform(a: Se3Transform, b: Se3Transform, t: number): Se3Transform {
  return {
    position: lerpVector(a.position, b.position, t),
    rotation: slerpQuaternion(a.rotation, b.rotation, t),
  };
}

function transformDistance(a: Se3Transform, b: Se3Transform, rotationDistanceWeight: number): number {
  return (
    vectorDistance(a.position, b.position) +
    quaternionAngularDistance(a.rotation, b.rotation) * rotationDistanceWeight
  );
}

function getLocalSegmentSampleCount(a: Se3Transform, b: Se3Transform, options: PlannerOptions): number {
  const translationSamples = Math.ceil(vectorDistance(a.position, b.position) / options.translationStep);
  const rotationSamples = Math.ceil(quaternionAngularDistance(a.rotation, b.rotation) / options.rotationStepRadians);
  return Math.max(1, Math.min(options.maxLocalSegmentChecks, Math.max(translationSamples, rotationSamples)));
}

function transformToMatrix(transform: Se3Transform): Matrix4 {
  return new Matrix4().compose(
    toVector3(transform.position),
    toQuaternion(transform.rotation),
    transform.scale ? toVector3(transform.scale) : new Vector3(1, 1, 1),
  );
}

function transformBounds(bounds: Box3, transform: Se3Transform): Box3 {
  return bounds.clone().applyMatrix4(transformToMatrix(transform));
}

function isLikelyTouchingContact(
  movingCache: CollisionMeshCache,
  obstacleCache: CollisionMeshCache,
  movingMatrix: Matrix4,
  obstacleMatrix: Matrix4,
  collisionEpsilon: number,
): boolean {
  const obstacleInverse = new Matrix4().copy(obstacleMatrix).invert();
  const nudgeDistance = Math.max(collisionEpsilon * 8, 1e-4);
  const nudgeDirections = [
    new Vector3(1, 0, 0),
    new Vector3(-1, 0, 0),
    new Vector3(0, 1, 0),
    new Vector3(0, -1, 0),
    new Vector3(0, 0, 1),
    new Vector3(0, 0, -1),
  ];

  for (const direction of nudgeDirections) {
    const shiftedMovingMatrix = new Matrix4()
      .makeTranslation(
        direction.x * nudgeDistance,
        direction.y * nudgeDistance,
        direction.z * nudgeDistance,
      )
      .multiply(movingMatrix);
    const shiftedMovingToObstacle = new Matrix4()
      .copy(obstacleInverse)
      .multiply(shiftedMovingMatrix);
    const stillIntersecting = obstacleCache.bvh.intersectsGeometry(
      movingCache.geometry,
      shiftedMovingToObstacle,
    );
    if (!stillIntersecting) {
      return true;
    }
  }

  return false;
}

function createBvhCollisionSceneQuery(
  input: CreateBvhCollisionSceneQueryInput,
): CollisionSceneQuery {
  const objectById = new Map(input.objects.map((object) => [object.objectId, object]));

  const query: CollisionSceneQuery = {
    getMovingObjectSnapshot(objectId) {
      const object = objectById.get(objectId);
      if (!object) {
        throw new Error(`Collision object is not available: ${objectId}`);
      }
      return object;
    },
    getObstacleSnapshots(movingObjectId) {
      return input.objects.filter((object) => object.objectId !== movingObjectId);
    },
    getCollisionCache(collisionMeshId) {
      const cache = input.collisionCaches.get(collisionMeshId);
      if (!cache) {
        throw new Error(`Collision mesh cache is not available: ${collisionMeshId}`);
      }
      return cache;
    },
    classifyObjectAtTransform(classifyInput) {
      const movingObject = query.getMovingObjectSnapshot(classifyInput.movingObjectId);
      const movingCache = query.getCollisionCache(movingObject.collisionMeshId);
      const movingMatrix = transformToMatrix(classifyInput.candidateTransform);
      const movingBoundsRaw = transformBounds(movingCache.localBounds, classifyInput.candidateTransform);
      const movingBounds = movingBoundsRaw
        .clone()
        .expandByScalar(classifyInput.collisionEpsilon);

      for (const obstacle of query.getObstacleSnapshots(classifyInput.movingObjectId)) {
        const obstacleCache = query.getCollisionCache(obstacle.collisionMeshId);
        const obstacleBoundsRaw = transformBounds(obstacleCache.localBounds, obstacle.worldTransform);
        const obstacleBounds = obstacleBoundsRaw
          .clone()
          .expandByScalar(classifyInput.collisionEpsilon);

        if (!movingBounds.intersectsBox(obstacleBounds)) {
          continue;
        }

        const obstacleMatrix = transformToMatrix(obstacle.worldTransform);
        const movingToObstacleMatrix = new Matrix4()
          .copy(obstacleMatrix)
          .invert()
          .multiply(movingMatrix);

        if (obstacleCache.bvh.intersectsGeometry(movingCache.geometry, movingToObstacleMatrix)) {
          if (isLikelyTouchingContact(
            movingCache,
            obstacleCache,
            movingMatrix,
            obstacleMatrix,
            classifyInput.collisionEpsilon,
          )) {
            return {
              status: "touching",
              firstHit: {
                movingObjectId: classifyInput.movingObjectId,
                obstacleObjectId: obstacle.objectId,
              },
            };
          }
          return {
            status: "penetrating",
            firstHit: {
              movingObjectId: classifyInput.movingObjectId,
              obstacleObjectId: obstacle.objectId,
            },
          };
        }
      }

      return { status: "separated" };
    },
  };

  return query;
}

function classifyObjectAtTransform(
  input: ClassifyObjectAtTransformInput,
  stats?: CollisionStats,
): ClassifyObjectAtTransformOutput {
  if (stats) {
    stats.collisionChecks += 1;
  }
  return input.sceneQuery.classifyObjectAtTransform(input);
}

function isTransformCollisionFree(
  movingObjectId: string,
  transform: Se3Transform,
  sceneQuery: CollisionSceneQuery,
  options: PlannerOptions,
  stats: CollisionStats,
): boolean {
  return classifyObjectAtTransform(
    {
      movingObjectId,
      candidateTransform: transform,
      sceneQuery,
      collisionEpsilon: options.collisionEpsilon,
    },
    stats,
  ).status !== "penetrating";
}

function buildLocalSegment(
  from: Se3Transform,
  to: Se3Transform,
  options: PlannerOptions,
): Se3Transform[] {
  const sampleCount = getLocalSegmentSampleCount(from, to, options);
  const segment = new Array<Se3Transform>();

  for (let i = 1; i <= sampleCount; i += 1) {
    segment.push(interpolateTransform(from, to, i / sampleCount));
  }

  return segment;
}

function isLocalSegmentCollisionFree(
  movingObjectId: string,
  from: Se3Transform,
  to: Se3Transform,
  sceneQuery: CollisionSceneQuery,
  options: PlannerOptions,
  stats: CollisionStats,
): boolean {
  const segment = buildLocalSegment(from, to, options);
  return segment.every((transform) => isTransformCollisionFree(movingObjectId, transform, sceneQuery, options, stats));
}

function computePathLength(path: Se3Transform[], options: PlannerOptions): number {
  let length = 0;
  for (let i = 1; i < path.length; i += 1) {
    length += transformDistance(path[i - 1], path[i], options.rotationDistanceWeight);
  }
  return length;
}

function densifyPath(path: Se3Transform[], options: PlannerOptions): Se3Transform[] {
  if (path.length <= 1) {
    return path;
  }

  const densified = [cloneTransform(path[0])];
  for (let i = 1; i < path.length; i += 1) {
    densified.push(...buildLocalSegment(path[i - 1], path[i], options));
  }
  return densified;
}

function getBoxProjectionRange(bounds: Box3, normal: Vector3): { min: number; max: number } {
  const points = [
    new Vector3(bounds.min.x, bounds.min.y, bounds.min.z),
    new Vector3(bounds.min.x, bounds.min.y, bounds.max.z),
    new Vector3(bounds.min.x, bounds.max.y, bounds.min.z),
    new Vector3(bounds.min.x, bounds.max.y, bounds.max.z),
    new Vector3(bounds.max.x, bounds.min.y, bounds.min.z),
    new Vector3(bounds.max.x, bounds.min.y, bounds.max.z),
    new Vector3(bounds.max.x, bounds.max.y, bounds.min.z),
    new Vector3(bounds.max.x, bounds.max.y, bounds.max.z),
  ];
  const projections = points.map((point) => normal.dot(point));
  return {
    min: Math.min(...projections),
    max: Math.max(...projections),
  };
}

function getTransformWithPosition(transform: Se3Transform, position: Vector3Like): Se3Transform {
  return {
    ...cloneTransform(transform),
    position: toVector3(position),
  };
}

function computeClearanceDistance(
  movingObjectId: string,
  targetTransform: Se3Transform,
  normal: Vector3,
  sceneQuery: CollisionSceneQuery,
  options: PlannerOptions,
): number {
  const movingObject = sceneQuery.getMovingObjectSnapshot(movingObjectId);
  const movingCache = sceneQuery.getCollisionCache(movingObject.collisionMeshId);
  const targetBounds = transformBounds(movingCache.localBounds, targetTransform);
  const targetProjection = getBoxProjectionRange(targetBounds, normal);
  const maxObstacleProjection = sceneQuery.getObstacleSnapshots(movingObjectId)
    .map((obstacle) => {
      const obstacleCache = sceneQuery.getCollisionCache(obstacle.collisionMeshId);
      const obstacleBounds = transformBounds(obstacleCache.localBounds, obstacle.worldTransform);
      return getBoxProjectionRange(obstacleBounds, normal).max;
    })
    .reduce((max, projection) => Math.max(max, projection), Number.NEGATIVE_INFINITY);

  if (!Number.isFinite(maxObstacleProjection)) {
    return options.minClearance;
  }

  return Math.min(
    options.maxClearance,
    Math.max(
      options.minClearance,
      maxObstacleProjection - targetProjection.min + options.collisionEpsilon + options.clearancePadding,
    ),
  );
}

/**
 * Plans a block-adhere path between two SE(3) transforms.
 *
 * The caller is responsible for computing the target transform. For example,
 * face/edge/vertex matching should happen before this function is called. This
 * function only answers: "given this target pose and attachment face normal,
 * can the moving object stage outside the fixed block and then approach along
 * the negative normal without penetrating scene geometry?"
 *
 * Input:
 * - `movingObjectId`: id of the object being planned. The scene query uses this
 *   id to fetch the moving object's collision mesh and to exclude it from the
 *   obstacle list.
 * - `startTransform`: initial SE(3) pose of the moving object. `position` is a
 *   world-space translation and `rotation` is a quaternion. The quaternion is
 *   normalized internally, so callers may pass any non-zero equivalent value.
 * - `targetTransform`: desired final SE(3) pose in the same world coordinate
 *   frame as `startTransform`.
 * - `attachmentNormalWorld`: outward normal of the attachment face on the fixed
 *   object, in world coordinates. The staging pose is placed on the `+n` side of
 *   the target and the final approach moves along `-n`.
 * - `sceneQuery`: dependency-injected scene/collision API. It must be able to:
 *   - return the moving object snapshot
 *   - return all obstacle snapshots for the moving object
 *   - return collision caches containing local bounds, `MeshBVH`, and
 *     `BufferGeometry`
 *   - classify a candidate moving-object transform as `separated`, `touching`,
 *     or `penetrating`
 * - `options.maxClearance`: upper bound for computed staging distance along
 *   `+attachmentNormalWorld`.
 * - `options.minClearance`: minimum staging distance even when projections are
 *   already separated.
 * - `options.translationStep`: maximum translation distance between returned
 *   sampled transforms.
 * - `options.rotationStepRadians`: maximum quaternion angular distance between
 *   returned sampled transforms.
 * - `options.collisionEpsilon`: tolerance forwarded to collision classification.
 * - `options.maxLocalSegmentChecks`: cap on sampled collision checks for one
 *   local segment.
 * - `options.rotationDistanceWeight`: converts rotational distance into the
 *   same cost scale as translation for path-length scoring.
 * - `options.clearancePadding`: extra distance added after projection-based
 *   clearance calculation.
 * - `options.maxStagingAttempts`: retry count for staging when the initial
 *   clearance estimate still produces a blocked staging move.
 * - `options.stagingClearanceScaleStep`: multiplicative growth factor applied
 *   to staging clearance on each retry attempt.
 * - `options.maxStagingClearanceFactor`: upper bound factor relative to
 *   `max(options.maxClearance, initialClearance)` for adaptive retries.
 *
 * Output:
 * - On success, returns `{ status: "found", transforms, stats }`.
 *   - `transforms` is ordered from start to target and is densified so adjacent
 *     transforms respect the configured translation/rotation step limits.
 *   - `stats.iterations` is always `0` for this deterministic planner.
 *   - `stats.collisionChecks` counts candidate-transform collision queries.
 *   - `stats.pathLength` is the weighted translation + rotation length of the
 *     returned path.
 * - On failure, returns `{ status: "not-found", reason, bestAttempt?, stats }`.
 *   - `reason: "start-blocked"` means the start transform is penetrating.
 *   - `reason: "target-blocked"` means the target transform is penetrating.
 *   - `reason: "invalid-normal"` means `attachmentNormalWorld` is zero length.
 *   - `reason: "staging-blocked"` means the rotation/staging motion cannot be
 *     sampled without penetration.
 *   - `reason: "approach-blocked"` means the final translation along `-n`
 *     penetrates an obstacle.
 *   - `bestAttempt` is the staging pose when staging succeeds but approach fails.
 *
 * Algorithm:
 * 1. Normalize input transforms and the attachment normal.
 * 2. Validate the start and target poses.
 * 3. Compute a staging pose at `p* + d_clear * n`, using projected world bounds
 *    to choose `d_clear` so the moving block is beyond all obstacle projections
 *    along `n`.
 * 4. Move from start to the staging pose with target orientation.
 * 5. Translate from staging to target along `-n`; no random search is performed.
 */
export function planCollisionFreeSe3Path(
  input: PlanCollisionFreeSe3PathInput,
): PlanCollisionFreeSe3PathOutput {
  const options = mergeOptions(input.options);
  const stats: CollisionStats = { collisionChecks: 0 };
  const startTransform = cloneTransform(input.startTransform);
  const targetTransform = cloneTransform(input.targetTransform);
  const approachNormal = toVector3(input.attachmentNormalWorld);

  if (approachNormal.lengthSq() === 0) {
    return {
      status: "not-found",
      reason: "invalid-normal",
      stats: { collisionChecks: stats.collisionChecks },
    };
  }
  approachNormal.normalize();

  if (!isTransformCollisionFree(input.movingObjectId, startTransform, input.sceneQuery, options, stats)) {
    return {
      status: "not-found",
      reason: "start-blocked",
      stats: { collisionChecks: stats.collisionChecks },
    };
  }

  if (!isTransformCollisionFree(input.movingObjectId, targetTransform, input.sceneQuery, options, stats)) {
    return {
      status: "not-found",
      reason: "target-blocked",
      stats: { collisionChecks: stats.collisionChecks },
    };
  }

  const targetPosition = toVector3(targetTransform.position);
  const clearanceDistance = computeClearanceDistance(
    input.movingObjectId,
    targetTransform,
    approachNormal,
    input.sceneQuery,
    options,
  );
  let stagingTransform = getTransformWithPosition(
    targetTransform,
    targetPosition.clone().addScaledVector(approachNormal, clearanceDistance),
  );
  let stagingFound = false;
  const maxStagingClearance = Math.max(options.maxClearance, clearanceDistance) * options.maxStagingClearanceFactor;

  for (let attempt = 0; attempt < options.maxStagingAttempts; attempt += 1) {
    const retryClearance = attempt === 0
      ? clearanceDistance
      : Math.min(
        maxStagingClearance,
        Math.max(
          clearanceDistance + (options.minClearance * attempt),
          clearanceDistance * (options.stagingClearanceScaleStep ** attempt),
        ),
      );
    const retryPosition = targetPosition.clone().addScaledVector(approachNormal, retryClearance);
    stagingTransform = getTransformWithPosition(targetTransform, retryPosition);
    const stagingPoseFree = isTransformCollisionFree(
      input.movingObjectId,
      stagingTransform,
      input.sceneQuery,
      options,
      stats,
    );
    const stagingSegmentFree = stagingPoseFree
      ? isLocalSegmentCollisionFree(
        input.movingObjectId,
        startTransform,
        stagingTransform,
        input.sceneQuery,
        options,
        stats,
      )
      : false;
    if (stagingPoseFree && stagingSegmentFree) {
      stagingFound = true;
      break;
    }
  }

  if (!stagingFound) {
    return {
      status: "not-found",
      reason: "staging-blocked",
      bestAttempt: stagingTransform,
      stats: { collisionChecks: stats.collisionChecks },
    };
  }

  if (!isLocalSegmentCollisionFree(input.movingObjectId, stagingTransform, targetTransform, input.sceneQuery, options, stats)) {
    return {
      status: "not-found",
      reason: "approach-blocked",
      bestAttempt: stagingTransform,
      stats: { collisionChecks: stats.collisionChecks },
    };
  }

  const transforms = densifyPath([startTransform, stagingTransform, targetTransform], options);
  return {
    status: "found",
    transforms,
    stats: {
      iterations: 0,
      collisionChecks: stats.collisionChecks,
      pathLength: computePathLength(transforms, options),
    },
  };
}
