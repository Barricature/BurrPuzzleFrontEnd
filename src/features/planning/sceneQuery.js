/**
 * Wrap a `CollisionSceneQuery` so the listed obstacle ids are removed from
 * `getObstacleSnapshots(...)`. Tangential contact with those obstacles is
 * then treated as path-valid by the planner because they no longer appear
 * in the iteration. Used by:
 *   - the match flow, where the matched fixed piece is in face-contact at
 *     target by construction
 *   - the per-frame collision guard during animation, for the same reason
 *
 * `classifyObjectAtTransform` is delegated through `this` so the underlying
 * implementation (which iterates `this.getObstacleSnapshots(...)`) sees the
 * filtered list automatically.
 */
export function createSceneQueryWithExpectedContacts(baseQuery, expectedContactObjectIds) {
  if (!expectedContactObjectIds || expectedContactObjectIds.length === 0) {
    return baseQuery;
  }
  const allowedSet = new Set(expectedContactObjectIds);
  return {
    getMovingObjectSnapshot(objectId) {
      return baseQuery.getMovingObjectSnapshot(objectId);
    },
    getCollisionCache(collisionMeshId) {
      return baseQuery.getCollisionCache(collisionMeshId);
    },
    getObstacleSnapshots(movingObjectId) {
      return baseQuery
        .getObstacleSnapshots(movingObjectId)
        .filter((snapshot) => !allowedSet.has(snapshot.objectId));
    },
    classifyObjectAtTransform(input) {
      return baseQuery.classifyObjectAtTransform.call(this, input);
    },
  };
}

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

  /**
   * Classify a contact between two BVH-equipped meshes by walking every pair
   * of triangles that BVH-overlaps and asking, for each intersecting pair,
   * whether the contact is purely tangential or a real 3D penetration.
   *
   *   separated   = no triangle pairs intersect
   *   touching    = every intersecting pair is tangential, where tangential
   *                 means either:
   *                   (a) the two triangles are coplanar (face-flush) — the
   *                       intersection is a 2D region inside the shared
   *                       plane and neither triangle pokes through the
   *                       other, or
   *                   (b) the intersection segment lies entirely on the
   *                       boundary (one of the three edges) of one of the
   *                       triangles — i.e. edge-on-edge, edge-on-face, or
   *                       vertex-on-anything contact
   *   penetrating = at least one intersecting pair is non-coplanar AND the
   *                 intersection segment cuts through the interior of both
   *                 triangles — i.e. one face actually pokes into the other
   *
   * This is strictly more accurate than the axis-aligned nudge probe for
   * burr-style interlocked geometry: interlocked pieces cannot be separated
   * by a small axis-aligned nudge so the probe always falsely classifies
   * face-flush contact as `penetrating`. Coplanarity + boundary tangency are
   * purely local geometric properties and give the right answer regardless
   * of the surrounding interlock.
   *
   * Implementation notes:
   * - Uses `MeshBVH.bvhcast(otherBvh, matrixToLocal, { intersectsTriangles })`
   *   from `three-mesh-bvh`. The library transforms the moving triangles
   *   into the obstacle local frame internally, so both `triObstacle` and
   *   `triMoving` arrive in the obstacle frame and planes/segments can be
   *   compared directly.
   * - `ExtendedTriangle.intersectsTriangle(other, target)` populates the
   *   `Line3` target with the intersection segment, which the boundary
   *   tangency check uses.
   * - The callback returns `true` to early-exit the bvhcast as soon as a
   *   genuine non-coplanar interior penetration is detected.
   */
  function classifyTriangleContact({
    movingCache,
    obstacleCache,
    movingMatrix,
    obstacleMatrix,
    planarityEpsilon = 1e-3,
    normalDotEpsilon = 1e-3,
  }) {
    const movingToObstacle = new THREE.Matrix4()
      .copy(obstacleMatrix)
      .invert()
      .multiply(movingMatrix);

    const intersectionLine = new THREE.Line3();
    const segmentVecAB = new THREE.Vector3();
    const segmentVecAP = new THREE.Vector3();
    const segmentProj = new THREE.Vector3();

    function distanceToSegment(point, a, b) {
      segmentVecAB.subVectors(b, a);
      segmentVecAP.subVectors(point, a);
      const lengthSq = segmentVecAB.lengthSq();
      if (lengthSq < 1e-30) {
        return segmentVecAP.length();
      }
      let t = segmentVecAP.dot(segmentVecAB) / lengthSq;
      if (t < 0) t = 0;
      else if (t > 1) t = 1;
      segmentProj.copy(segmentVecAB).multiplyScalar(t).add(a);
      return point.distanceTo(segmentProj);
    }

    function isPointNearTriangleBoundary(point, triangle, epsilon) {
      return distanceToSegment(point, triangle.a, triangle.b) <= epsilon
        || distanceToSegment(point, triangle.b, triangle.c) <= epsilon
        || distanceToSegment(point, triangle.c, triangle.a) <= epsilon;
    }

    function isLineFullyOnTriangleBoundary(line, triangle, epsilon) {
      return isPointNearTriangleBoundary(line.start, triangle, epsilon)
        && isPointNearTriangleBoundary(line.end, triangle, epsilon);
    }

    let hasContact = false;
    let hasInteriorPenetration = false;

    obstacleCache.bvh.bvhcast(movingCache.bvh, movingToObstacle, {
      intersectsTriangles(triObstacle, triMoving) {
        if (!triObstacle.intersectsTriangle(triMoving, intersectionLine)) {
          return false;
        }
        hasContact = true;

        const normalAlignment = Math.abs(
          triObstacle.plane.normal.dot(triMoving.plane.normal),
        );
        if (normalAlignment > 1 - normalDotEpsilon) {
          const planeOffset = Math.abs(triMoving.plane.distanceToPoint(triObstacle.a));
          if (planeOffset < planarityEpsilon) {
            // (a) coplanar tangential contact
            return false;
          }
        }

        if (
          isLineFullyOnTriangleBoundary(intersectionLine, triObstacle, planarityEpsilon)
          || isLineFullyOnTriangleBoundary(intersectionLine, triMoving, planarityEpsilon)
        ) {
          // (b) edge-on-edge / edge-on-face / vertex contact
          return false;
        }

        hasInteriorPenetration = true;
        return true;
      },
    });

    if (hasInteriorPenetration) return "penetrating";
    if (hasContact) return "touching";
    return "separated";
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

          // Coplanar tangent-face detection: every intersecting triangle pair
          // must share a plane to be classified as `touching`. Any
          // non-coplanar pair => true 3D penetration.
          const planarityEpsilon = Math.max(input.collisionEpsilon * 100, 1e-4);
          const status = classifyTriangleContact({
            movingCache,
            obstacleCache,
            movingMatrix,
            obstacleMatrix,
            planarityEpsilon,
          });
          if (status === "separated") {
            continue;
          }
          return {
            status,
            firstHit: {
              movingObjectId: input.movingObjectId,
              obstacleObjectId: obstacle.objectId,
            },
          };
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
      const planarityEpsilon = Math.max(collisionEpsilon * 100, 1e-4);
      for (const obstacle of sceneQuery.getObstacleSnapshots(movingObjectId)) {
        const obstacleCache = sceneQuery.getCollisionCache(obstacle.collisionMeshId);
        const obstacleMatrix = toMatrixFromPlannerTransform(obstacle.worldTransform);
        const obstacleBoundsRaw = obstacleCache.localBounds.clone().applyMatrix4(obstacleMatrix);
        const obstacleBounds = obstacleBoundsRaw.clone().expandByScalar(collisionEpsilon);
        const broadphaseIntersects = movingBounds.intersectsBox(obstacleBounds);
        let contactStatus = "separated";

        if (broadphaseIntersects) {
          contactStatus = classifyTriangleContact({
            movingCache,
            obstacleCache,
            movingMatrix,
            obstacleMatrix,
            planarityEpsilon,
          });
        }

        obstacleTraces.push({
          obstacleObjectId: obstacle.objectId,
          obstacleTransform: obstacle.worldTransform,
          broadphaseIntersects,
          // `narrowphaseIntersects` is now equivalent to "any triangle pair
          // overlapped during the coplanar walk" (touching OR penetrating).
          narrowphaseIntersects: contactStatus !== "separated",
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

  // diagnose* return data only; the match flow consolidates them into a
  // single `[Match Report]` console dump so callers do not double-log here.
  function diagnoseStartBlocked(sceneQuery, movingObjectId, startTransform) {
    const trace = buildCollisionDebugTrace(
      sceneQuery,
      movingObjectId,
      startTransform,
      defaultCollisionEpsilon,
    );
    return {
      obstacleObjectId: trace.firstPenetratingObstacleId ?? null,
      trace,
    };
  }

  function diagnoseTargetBlocked(sceneQuery, movingObjectId, targetTransform) {
    const trace = buildCollisionDebugTrace(
      sceneQuery,
      movingObjectId,
      targetTransform,
      defaultCollisionEpsilon,
    );
    return {
      obstacleObjectId: trace.firstPenetratingObstacleId ?? null,
      trace,
    };
  }

  return {
    toMatrixFromPlannerTransform,
    withScaleFromReference,
    isLikelyTouchingContact,
    classifyTriangleContact,
    toPlannerTransformFromPiece,
    getCollisionSceneQuery,
    buildCollisionDebugTrace,
    diagnoseStartBlocked,
    diagnoseTargetBlocked,
  };
}
