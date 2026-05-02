export function createTargetResolver({
  THREE,
  sceneRuntime,
  state,
  edgeBaseLineWidthPx,
  edgePickRadiusMultiplier,
  vertexBasePickRadiusPx,
  vertexPickRadiusMultiplier,
}) {
  function getTargetFromIntersection(intersection) {
    const pieceName = intersection?.object?.userData?.pieceName;
    if (!pieceName) {
      return null;
    }
    const componentType = intersection?.object?.userData?.componentType ?? "piece";
    const componentId = intersection?.object?.userData?.componentId ?? pieceName;
    return {
      pieceName,
      componentType,
      componentId,
    };
  }

  function findFirstPieceHit(hits) {
    for (const hit of hits) {
      const pieceName = hit?.object?.userData?.pieceName;
      if (!pieceName) {
        continue;
      }
      return {
        pieceName,
        componentType: "piece",
        componentId: pieceName,
      };
    }
    return null;
  }

  function findFirstFaceHitOnPiece(hits, pieceName) {
    for (const hit of hits) {
      if (hit?.object?.userData?.pieceName !== pieceName) {
        continue;
      }
      if (hit?.object?.userData?.componentType !== "face") {
        continue;
      }
      return getTargetFromIntersection(hit);
    }
    return null;
  }

  function findFirstEdgeHit(hits, pieceName = null) {
    for (const hit of hits) {
      if (pieceName && hit?.object?.userData?.pieceName !== pieceName) {
        continue;
      }
      if (hit?.object?.userData?.componentType !== "edge") {
        continue;
      }
      return getTargetFromIntersection(hit);
    }
    return null;
  }

  function findFirstVertexHit(hits, pieceName = null) {
    for (const hit of hits) {
      if (pieceName && hit?.object?.userData?.pieceName !== pieceName) {
        continue;
      }
      if (hit?.object?.userData?.componentType !== "vertex") {
        continue;
      }
      return getTargetFromIntersection(hit);
    }
    return null;
  }

  function projectWorldPointToScreen(point, rect) {
    const projected = point.clone().project(sceneRuntime.camera);
    if (projected.z < -1 || projected.z > 1) {
      return null;
    }
    return {
      x: ((projected.x + 1) * 0.5) * rect.width + rect.left,
      y: ((1 - projected.y) * 0.5) * rect.height + rect.top,
      depth: projected.z,
    };
  }

  function distancePointToSegmentSquared(point, segmentStart, segmentEnd) {
    const sx = segmentEnd.x - segmentStart.x;
    const sy = segmentEnd.y - segmentStart.y;
    const segmentLengthSquared = sx * sx + sy * sy;
    if (segmentLengthSquared <= Number.EPSILON) {
      const dx = point.x - segmentStart.x;
      const dy = point.y - segmentStart.y;
      return dx * dx + dy * dy;
    }
    const t = THREE.MathUtils.clamp(
      ((point.x - segmentStart.x) * sx + (point.y - segmentStart.y) * sy) / segmentLengthSquared,
      0,
      1,
    );
    const closestX = segmentStart.x + t * sx;
    const closestY = segmentStart.y + t * sy;
    const dx = point.x - closestX;
    const dy = point.y - closestY;
    return dx * dx + dy * dy;
  }

  function findScreenSpaceEdgeTarget(event, pieceName = null) {
    if (!sceneRuntime.renderer || !sceneRuntime.camera) {
      return null;
    }
    const rect = sceneRuntime.renderer.domElement.getBoundingClientRect();
    const pointer = { x: event.clientX, y: event.clientY };
    const thresholdPx = edgeBaseLineWidthPx * edgePickRadiusMultiplier;
    const thresholdSquared = thresholdPx * thresholdPx;

    let best = null;
    for (const pieceObject of sceneRuntime.pieceObjects.values()) {
      pieceObject.traverse((child) => {
        if (child.userData?.componentType !== "edge") {
          return;
        }
        if (pieceName && child.userData.pieceName !== pieceName) {
          return;
        }

        const localStart = child.userData.localStart;
        const localEnd = child.userData.localEnd;
        if (!localStart || !localEnd) {
          return;
        }
        const worldStart = child.localToWorld(new THREE.Vector3(localStart.x, localStart.y, localStart.z));
        const worldEnd = child.localToWorld(new THREE.Vector3(localEnd.x, localEnd.y, localEnd.z));
        const screenStart = projectWorldPointToScreen(worldStart, rect);
        const screenEnd = projectWorldPointToScreen(worldEnd, rect);
        if (!screenStart || !screenEnd) {
          return;
        }
        const distanceSquared = distancePointToSegmentSquared(pointer, screenStart, screenEnd);
        if (distanceSquared > thresholdSquared) {
          return;
        }
        const depth = Math.min(screenStart.depth, screenEnd.depth);
        if (
          !best
          || distanceSquared < best.distanceSquared
          || (Math.abs(distanceSquared - best.distanceSquared) < 1e-4 && depth < best.depth)
        ) {
          best = {
            distanceSquared,
            depth,
            target: {
              pieceName: child.userData.pieceName,
              componentType: "edge",
              componentId: child.userData.componentId,
            },
          };
        }
      });
    }

    return best?.target ?? null;
  }

  function findScreenSpaceVertexTarget(event, pieceName = null) {
    if (!sceneRuntime.renderer || !sceneRuntime.camera) {
      return null;
    }
    const rect = sceneRuntime.renderer.domElement.getBoundingClientRect();
    const pointer = { x: event.clientX, y: event.clientY };
    const thresholdPx = vertexBasePickRadiusPx * vertexPickRadiusMultiplier;
    const thresholdSquared = thresholdPx * thresholdPx;

    let best = null;
    for (const pieceObject of sceneRuntime.pieceObjects.values()) {
      pieceObject.traverse((child) => {
        if (child.userData?.componentType !== "vertex") {
          return;
        }
        if (pieceName && child.userData.pieceName !== pieceName) {
          return;
        }

        const worldPoint = child.getWorldPosition(new THREE.Vector3());
        const screenPoint = projectWorldPointToScreen(worldPoint, rect);
        if (!screenPoint) {
          return;
        }
        const dx = pointer.x - screenPoint.x;
        const dy = pointer.y - screenPoint.y;
        const distanceSquared = dx * dx + dy * dy;
        if (distanceSquared > thresholdSquared) {
          return;
        }
        if (
          !best
          || distanceSquared < best.distanceSquared
          || (Math.abs(distanceSquared - best.distanceSquared) < 1e-4 && screenPoint.depth < best.depth)
        ) {
          best = {
            distanceSquared,
            depth: screenPoint.depth,
            target: {
              pieceName: child.userData.pieceName,
              componentType: "vertex",
              componentId: child.userData.componentId,
            },
          };
        }
      });
    }

    return best?.target ?? null;
  }

  function getTargetsFromMouseEvent(event) {
    if (!sceneRuntime.renderer || !sceneRuntime.camera) {
      return {
        pieceTarget: null,
        faceTargetOnSelectedPiece: null,
        edgeTargetOnSelectedPiece: null,
        vertexTargetOnSelectedPiece: null,
        edgeTargetAny: null,
        vertexTargetAny: null,
      };
    }

    const rect = sceneRuntime.renderer.domElement.getBoundingClientRect();
    sceneRuntime.pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    sceneRuntime.pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    sceneRuntime.raycaster.setFromCamera(sceneRuntime.pointer, sceneRuntime.camera);

    const hits = sceneRuntime.raycaster.intersectObjects([...sceneRuntime.pieceObjects.values()], true);
    const edgeTargetAny = findScreenSpaceEdgeTarget(event);
    const vertexTargetAny = findScreenSpaceVertexTarget(event);
    return {
      pieceTarget: findFirstPieceHit(hits),
      faceTargetOnSelectedPiece: state.selectedPieceName ? findFirstFaceHitOnPiece(hits, state.selectedPieceName) : null,
      edgeTargetOnSelectedPiece: state.selectedPieceName ? findScreenSpaceEdgeTarget(event, state.selectedPieceName) : null,
      vertexTargetOnSelectedPiece: state.selectedPieceName ? findScreenSpaceVertexTarget(event, state.selectedPieceName) : null,
      edgeTargetAny,
      vertexTargetAny,
    };
  }

  return {
    getTargetFromIntersection,
    findFirstPieceHit,
    findFirstFaceHitOnPiece,
    findFirstEdgeHit,
    findFirstVertexHit,
    projectWorldPointToScreen,
    distancePointToSegmentSquared,
    findScreenSpaceEdgeTarget,
    findScreenSpaceVertexTarget,
    getTargetsFromMouseEvent,
  };
}
