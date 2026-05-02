export function createCollisionSceneTools({
  THREE,
  state,
  sceneRuntime,
  gridWidth,
  gridHeight,
  defaultCollisionEpsilon,
  formatErrorMessage,
}) {
  function toMatrixFromPlannerTransform(transform) {
    const scale = transform.scale ?? { x: 1, y: 1, z: 1 };
    return new THREE.Matrix4().compose(
      new THREE.Vector3(transform.position.x, transform.position.y, transform.position.z),
      new THREE.Quaternion(transform.rotation.x, transform.rotation.y, transform.rotation.z, transform.rotation.w).normalize(),
      new THREE.Vector3(scale.x, scale.y, scale.z),
    );
  }

  function withScaleFromReference(transform, referenceTransform) {
    return {
      ...transform,
      scale: transform.scale ?? referenceTransform.scale ?? { x: 1, y: 1, z: 1 },
    };
  }

  function isLikelyTouchingContact({
    movingCache,
    obstacleCache,
    movingMatrix,
    obstacleMatrix,
    collisionEpsilon,
  }) {
    const obstacleInverse = new THREE.Matrix4().copy(obstacleMatrix).invert();
    const nudgeDistance = Math.max(collisionEpsilon * 8, 1e-4);
    const nudgeDirections = [
      new THREE.Vector3(1, 0, 0),
      new THREE.Vector3(-1, 0, 0),
      new THREE.Vector3(0, 1, 0),
      new THREE.Vector3(0, -1, 0),
      new THREE.Vector3(0, 0, 1),
      new THREE.Vector3(0, 0, -1),
    ];

    for (const direction of nudgeDirections) {
      const shiftedMovingMatrix = new THREE.Matrix4()
        .makeTranslation(
          direction.x * nudgeDistance,
          direction.y * nudgeDistance,
          direction.z * nudgeDistance,
        )
        .multiply(movingMatrix);
      const shiftedMovingToObstacle = new THREE.Matrix4()
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

  function toPlannerTransformFromPiece(piece) {
    if (!piece) {
      return null;
    }
    const pieceScale = piece.rootObject?.scale ?? new THREE.Vector3(1, 1, 1);
    const rotation = piece.rotationQuaternion
      ? {
        x: piece.rotationQuaternion.x,
        y: piece.rotationQuaternion.y,
        z: piece.rotationQuaternion.z,
        w: piece.rotationQuaternion.w,
      }
      : new THREE.Quaternion().setFromEuler(
        new THREE.Euler(0, THREE.MathUtils.degToRad(piece.orientation ?? 0), 0, "YXZ"),
      );

    return {
      position: {
        x: piece.position.x - gridWidth / 2,
        y: piece.position.z,
        z: piece.position.y - gridHeight / 2,
      },
      rotation: {
        x: rotation.x,
        y: rotation.y,
        z: rotation.z,
        w: rotation.w,
      },
      scale: {
        x: pieceScale.x,
        y: pieceScale.y,
        z: pieceScale.z,
      },
    };
  }

  function getCollisionSceneQuery() {
    const snapshots = state.pieces.map((piece) => {
      const worldTransform = toPlannerTransformFromPiece(piece);
      if (!worldTransform) {
        throw new Error(`Missing world transform for piece: ${piece.name}`);
      }
      return {
        objectId: piece.name,
        worldTransform,
        collisionMeshId: piece.collisionMeshId,
      };
    });
    const objectById = new Map(snapshots.map((snapshot) => [snapshot.objectId, snapshot]));

    return {
      getMovingObjectSnapshot(objectId) {
        const object = objectById.get(objectId);
        if (!object) {
          throw new Error(`Collision object is unavailable: ${objectId}`);
        }
        return object;
      },
      getObstacleSnapshots(objectId) {
        return snapshots.filter((snapshot) => snapshot.objectId !== objectId);
      },
      getCollisionCache(collisionMeshId) {
        const cache = sceneRuntime.collisionCaches.get(collisionMeshId);
        if (!cache) {
          throw new Error(`Collision cache is unavailable: ${collisionMeshId}`);
        }
        return cache;
      },
      classifyObjectAtTransform(input) {
        const movingObject = this.getMovingObjectSnapshot(input.movingObjectId);
        const movingCache = this.getCollisionCache(movingObject.collisionMeshId);
        const movingTransform = withScaleFromReference(input.candidateTransform, movingObject.worldTransform);
        const movingMatrix = toMatrixFromPlannerTransform(movingTransform);
        const movingBoundsRaw = movingCache.localBounds
          .clone()
          .applyMatrix4(movingMatrix);
        const movingBounds = movingBoundsRaw
          .clone()
          .expandByScalar(input.collisionEpsilon);

        for (const obstacle of this.getObstacleSnapshots(input.movingObjectId)) {
          const obstacleCache = this.getCollisionCache(obstacle.collisionMeshId);
          const obstacleMatrix = toMatrixFromPlannerTransform(obstacle.worldTransform);
          const obstacleBoundsRaw = obstacleCache.localBounds
            .clone()
            .applyMatrix4(obstacleMatrix);
          const obstacleBounds = obstacleBoundsRaw
            .clone()
            .expandByScalar(input.collisionEpsilon);

          if (!movingBounds.intersectsBox(obstacleBounds)) {
            continue;
          }

          const movingToObstacle = new THREE.Matrix4().copy(obstacleMatrix).invert().multiply(movingMatrix);
          if (obstacleCache.bvh.intersectsGeometry(movingCache.geometry, movingToObstacle)) {
            if (isLikelyTouchingContact({
              movingCache,
              obstacleCache,
              movingMatrix,
              obstacleMatrix,
              collisionEpsilon: input.collisionEpsilon,
            })) {
              return {
                status: "touching",
                firstHit: {
                  movingObjectId: input.movingObjectId,
                  obstacleObjectId: obstacle.objectId,
                },
              };
            }
            return {
              status: "penetrating",
              firstHit: {
                movingObjectId: input.movingObjectId,
                obstacleObjectId: obstacle.objectId,
              },
            };
          }
        }
        return { status: "separated" };
      },
    };
  }

  function buildCollisionDebugTrace(sceneQuery, movingObjectId, candidateTransform, collisionEpsilon = defaultCollisionEpsilon) {
    try {
      const movingObject = sceneQuery.getMovingObjectSnapshot(movingObjectId);
      const movingCache = sceneQuery.getCollisionCache(movingObject.collisionMeshId);
      const movingTransform = withScaleFromReference(candidateTransform, movingObject.worldTransform);
      const movingMatrix = toMatrixFromPlannerTransform(movingTransform);
      const movingBoundsRaw = movingCache.localBounds.clone().applyMatrix4(movingMatrix);
      const movingBounds = movingBoundsRaw.clone().expandByScalar(collisionEpsilon);

      const obstacleTraces = [];
      for (const obstacle of sceneQuery.getObstacleSnapshots(movingObjectId)) {
        const obstacleCache = sceneQuery.getCollisionCache(obstacle.collisionMeshId);
        const obstacleMatrix = toMatrixFromPlannerTransform(obstacle.worldTransform);
        const obstacleBoundsRaw = obstacleCache.localBounds.clone().applyMatrix4(obstacleMatrix);
        const obstacleBounds = obstacleBoundsRaw.clone().expandByScalar(collisionEpsilon);
        const broadphaseIntersects = movingBounds.intersectsBox(obstacleBounds);
        let narrowphaseIntersects = false;
        let contactStatus = "separated";

        if (broadphaseIntersects) {
          const movingToObstacle = new THREE.Matrix4().copy(obstacleMatrix).invert().multiply(movingMatrix);
          narrowphaseIntersects = obstacleCache.bvh.intersectsGeometry(movingCache.geometry, movingToObstacle);
          if (narrowphaseIntersects) {
            contactStatus = isLikelyTouchingContact({
              movingCache,
              obstacleCache,
              movingMatrix,
              obstacleMatrix,
              collisionEpsilon,
            })
              ? "touching"
              : "penetrating";
          }
        }

        obstacleTraces.push({
          obstacleObjectId: obstacle.objectId,
          obstacleTransform: obstacle.worldTransform,
          broadphaseIntersects,
          narrowphaseIntersects,
          contactStatus,
          movingBounds: {
            min: { x: movingBoundsRaw.min.x, y: movingBoundsRaw.min.y, z: movingBoundsRaw.min.z },
            max: { x: movingBoundsRaw.max.x, y: movingBoundsRaw.max.y, z: movingBoundsRaw.max.z },
          },
          obstacleBounds: {
            min: { x: obstacleBoundsRaw.min.x, y: obstacleBoundsRaw.min.y, z: obstacleBoundsRaw.min.z },
            max: { x: obstacleBoundsRaw.max.x, y: obstacleBoundsRaw.max.y, z: obstacleBoundsRaw.max.z },
          },
        });
      }

      const firstPenetrating = obstacleTraces.find((item) => item.contactStatus === "penetrating");
      return {
        movingObjectId,
        candidateTransform: movingTransform,
        collisionEpsilon,
        firstPenetratingObstacleId: firstPenetrating?.obstacleObjectId ?? null,
        obstacleTraces,
      };
    } catch (error) {
      return {
        movingObjectId,
        candidateTransform,
        collisionEpsilon,
        firstPenetratingObstacleId: null,
        obstacleTraces: [],
        error: formatErrorMessage(error, "Failed to build collision debug trace"),
      };
    }
  }

  function diagnoseStartBlocked(sceneQuery, movingObjectId, startTransform) {
    const trace = buildCollisionDebugTrace(
      sceneQuery,
      movingObjectId,
      startTransform,
      defaultCollisionEpsilon,
    );
    console.log("[Collision Debug] start-blocked trace:", trace);
    return {
      obstacleObjectId: trace.firstPenetratingObstacleId ?? null,
      trace,
    };
  }

  return {
    toMatrixFromPlannerTransform,
    withScaleFromReference,
    isLikelyTouchingContact,
    toPlannerTransformFromPiece,
    getCollisionSceneQuery,
    buildCollisionDebugTrace,
    diagnoseStartBlocked,
  };
}
