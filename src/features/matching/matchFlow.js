export function buildPiecesByNameMap(pieces) {
  return Object.fromEntries(pieces.map((piece) => [piece.name, piece]));
}

/**
 * Rotate a 3D vector by a unit quaternion using the standard
 * `v' = v + 2 * cross(q.xyz, cross(q.xyz, v) + q.w * v)` formulation.
 * Inlined to avoid pulling THREE into this module.
 */
function rotateVecByQuat(v, q) {
  const c1x = q.y * v.z - q.z * v.y;
  const c1y = q.z * v.x - q.x * v.z;
  const c1z = q.x * v.y - q.y * v.x;
  const ix = c1x + q.w * v.x;
  const iy = c1y + q.w * v.y;
  const iz = c1z + q.w * v.z;
  return {
    x: v.x + 2 * (q.y * iz - q.z * iy),
    y: v.y + 2 * (q.z * ix - q.x * iz),
    z: v.z + 2 * (q.x * iy - q.y * ix),
  };
}

/**
 * Identify the moving piece's longest local axis from its world-space
 * bounding box at load time (`piece.size = { width, depth, height }` is the
 * world bbox in (X, Y, Z) at identity rotation, with mesh scale applied).
 * Returns the unit-length local axis vector and the world-space size along
 * it, or `null` if size data is unavailable.
 */
function getLocalLongAxisAndSize(piece) {
  if (!piece?.size) return null;
  const { width, depth, height } = piece.size;
  if (width >= depth && width >= height) {
    return { axis: { x: 1, y: 0, z: 0 }, worldSize: width };
  }
  if (depth >= height) {
    return { axis: { x: 0, y: 1, z: 0 }, worldSize: depth };
  }
  return { axis: { x: 0, y: 0, z: 1 }, worldSize: height };
}

/**
 * Build seed poses for the CBiRRT goal tree by translating the matched
 * target pose along the moving piece's long axis (as oriented at target) by
 * `+/- distance`. These poses sit in free space well outside the matched
 * fixed piece and act as natural "pre-assembly" entry points for the slide
 * into the assembled position.
 *
 * For interlocking (burr) puzzles the matched piece's only valid
 * disassembly direction is along its long axis at target; seeding CBiRRT
 * with a pose at each end of that axis lets the planner connect a
 * free-space approach to the slide-in path without having to re-discover
 * the slide direction by random sampling in 6-DOF.
 */
function computeDisassemblySeeds({ movingPiece, targetTransform, distanceMultiplier = 2 }) {
  const local = getLocalLongAxisAndSize(movingPiece);
  if (!local) return [];
  const worldAxis = rotateVecByQuat(local.axis, targetTransform.rotation);
  const len = Math.sqrt(
    worldAxis.x * worldAxis.x + worldAxis.y * worldAxis.y + worldAxis.z * worldAxis.z,
  );
  if (len < 1e-9) return [];
  worldAxis.x /= len;
  worldAxis.y /= len;
  worldAxis.z /= len;

  const distance = local.worldSize * distanceMultiplier;
  const seeds = [];
  for (const sign of [1, -1]) {
    seeds.push({
      position: {
        x: targetTransform.position.x + sign * distance * worldAxis.x,
        y: targetTransform.position.y + sign * distance * worldAxis.y,
        z: targetTransform.position.z + sign * distance * worldAxis.z,
      },
      rotation: { ...targetTransform.rotation },
      scale: targetTransform.scale,
    });
  }
  return seeds;
}

/**
 * Aggregate all per-Match-click debug data into a single object so console
 * output is one copy/paste-friendly entry per Match button click.
 *
 * The shape intentionally mirrors the natural decomposition of the flow:
 * - `summary`: one-line outcome + which planner produced the path
 * - `selections`: face/edge/vertex picks the user made (incl. selection order)
 * - `matchSolve`: result of `computeMatchTransform(...)` (poses + debugChain)
 * - `planner`: Block Adhere result, optional CBiRRT fallback result, and
 *   which planner ended up driving the animation
 * - `diagnostics`: per-obstacle collision trace when start-blocked or
 *   target-blocked was hit
 */
function buildMatchReport({
  state,
  matchResult,
  expectedContactObjectIds,
  blockAdherePlannerResult,
  cbirrtPlannerResult,
  finalPlannerResult,
  startBlockedDiagnosis,
  targetBlockedDiagnosis,
  errorMessage,
}) {
  const finalOutcome = (() => {
    if (errorMessage) return "exception";
    if (matchResult.status === "success") {
      if (finalPlannerResult?.status === "found") return "animated";
      return "planner-failed";
    }
    return matchResult.status;
  })();

  const chosenPlanner = (() => {
    if (finalPlannerResult?.status !== "found") return null;
    return finalPlannerResult.stats?.plannerKind === "cbirrt" ? "cbirrt" : "block-adhere";
  })();

  const report = {
    timestamp: new Date().toISOString(),
    summary: {
      matchStatus: matchResult.status,
      finalOutcome,
      fixedPieceName: matchResult.fixedPieceName ?? null,
      movingPieceName: matchResult.movingPieceName ?? null,
      chosenPlanner,
      pathSteps: finalPlannerResult?.status === "found"
        ? finalPlannerResult.transforms.length
        : 0,
    },
    selections: {
      matchStage: state.matchStage,
      faces: state.selectedFaceTargets,
      edges: state.selectedEdgeTargets,
      vertices: state.selectedVertexTargets,
    },
    matchSolve: {
      status: matchResult.status,
      reason: matchResult.reason ?? null,
      candidate: matchResult.candidate ?? null,
      currentPoseWorld: matchResult.currentPoseWorld ?? null,
      targetPoseWorld: matchResult.targetPoseWorld ?? null,
      deltaTransformWorld: matchResult.deltaTransformWorld ?? null,
      attachmentNormalWorld: matchResult.attachmentNormalWorld ?? null,
      debugChain: matchResult.debugChain ?? null,
    },
    planner: blockAdherePlannerResult
      ? {
        // Pieces filtered out of the obstacle list for this match. Tangential
        // contact with these is treated as path-valid so face-flush burr
        // interlocks do not trip target-blocked.
        expectedContactObjectIds: expectedContactObjectIds ?? [],
        blockAdhere: blockAdherePlannerResult,
        cbirrtFallback: cbirrtPlannerResult ?? null,
      }
      : null,
    diagnostics: (startBlockedDiagnosis || targetBlockedDiagnosis)
      ? {
        startBlocked: startBlockedDiagnosis ?? null,
        targetBlocked: targetBlockedDiagnosis ?? null,
      }
      : null,
    error: errorMessage ?? null,
  };

  return report;
}

export function runMatchFlowCoordinator({
  state,
  sceneRuntime,
  computeMatchTransform,
  buildPiecesByNameMapFn,
  clearMatchDisambiguationSelections,
  setMatchStage,
  syncPieceObjects,
  getCollisionSceneQuery,
  planCollisionFreeSe3Path,
  planCBiRRT,
  animatePieceAlongPath,
  shakeMatchButton,
  diagnoseStartBlocked,
  diagnoseTargetBlocked,
  setStatusMessage,
  formatErrorMessage,
}) {
  if (state.isAnimating) {
    setStatusMessage("Animation in progress");
    return;
  }

  // Ensure piece.rootObject.matrixWorld matches canonical piece state
  // before computeMatchTransform reads world-space face/edge/vertex geometry.
  syncPieceObjects();
  sceneRuntime.scene?.updateMatrixWorld(true);
  const matchResult = computeMatchTransform({
    selectedFaces: state.selectedFaceTargets,
    selectedEdges: state.selectedEdgeTargets,
    selectedVertices: state.selectedVertexTargets,
    piecesByName: buildPiecesByNameMapFn(state.pieces),
  });

  let blockAdhereResult = null;
  let cbirrtFallbackResult = null;
  let finalPlannerResult = null;
  let startBlockedDiagnosis = null;
  let targetBlockedDiagnosis = null;
  let errorMessage = null;

  let expectedContactObjectIds = [];

  function dumpReport() {
    const report = buildMatchReport({
      state,
      matchResult,
      expectedContactObjectIds,
      blockAdherePlannerResult: blockAdhereResult,
      cbirrtPlannerResult: cbirrtFallbackResult,
      finalPlannerResult,
      startBlockedDiagnosis,
      targetBlockedDiagnosis,
      errorMessage,
    });
    console.log("[Match Report]", report);
  }

  if (matchResult.status === "success") {
    clearMatchDisambiguationSelections();
    setMatchStage("face");
    try {
      // Strict no-penetration semantics: do not exclude the matched fixed
      // piece from the obstacle list. The triangle classifier in
      // `sceneQuery.js` correctly classifies face-flush, edge-on-face, and
      // vertex contacts as `touching` (path-valid) via coplanarity +
      // boundary tangency, so the matched pose itself passes collision and
      // any path that would phase-through the fixed piece is rejected.
      expectedContactObjectIds = [];
      const sceneQuery = getCollisionSceneQuery();
      blockAdhereResult = planCollisionFreeSe3Path({
        movingObjectId: matchResult.movingPieceName,
        startTransform: matchResult.currentPoseWorld,
        targetTransform: matchResult.targetPoseWorld,
        attachmentNormalWorld: matchResult.attachmentNormalWorld,
        sceneQuery,
      });
      finalPlannerResult = blockAdhereResult;

      // CBiRRT fallback: when Block Adhere reports a recoverable failure
      // (anything other than start-blocked / target-blocked / invalid-normal),
      // run the sampling-based planner. Seed it with:
      //   - Block Adhere's last staging attempt (lies on the M1 line by
      //     construction; useful when BA failed only at the staging segment)
      //   - two "pre-assembly" poses along the moving piece's long axis at
      //     target (free-space entry points for the natural disassembly
      //     direction; required for interlocked / burr-style assemblies
      //     where BA's stage-along-face-normal template does not match the
      //     valid disassembly motion).
      const blockAdhereTerminalReasons = new Set(["start-blocked", "target-blocked", "invalid-normal"]);
      if (
        blockAdhereResult.status !== "found"
        && typeof planCBiRRT === "function"
        && !blockAdhereTerminalReasons.has(blockAdhereResult.reason)
      ) {
        const piecesByName = buildPiecesByNameMapFn(state.pieces);
        const movingPiece = piecesByName[matchResult.movingPieceName];
        const disassemblySeeds = movingPiece
          ? computeDisassemblySeeds({
            movingPiece,
            targetTransform: matchResult.targetPoseWorld,
          })
          : [];
        const seedTransforms = [
          ...(blockAdhereResult.bestAttempt ? [blockAdhereResult.bestAttempt] : []),
          ...disassemblySeeds,
        ];
        cbirrtFallbackResult = planCBiRRT({
          movingObjectId: matchResult.movingPieceName,
          startTransform: matchResult.currentPoseWorld,
          targetTransform: matchResult.targetPoseWorld,
          attachmentNormalWorld: matchResult.attachmentNormalWorld,
          sceneQuery,
          seedTransforms,
        });
        if (cbirrtFallbackResult.status === "found") {
          finalPlannerResult = cbirrtFallbackResult;
        }
      }

      if (finalPlannerResult.status === "found") {
        const planner = finalPlannerResult.stats?.plannerKind === "cbirrt"
          ? "CBiRRT"
          : "Block Adhere";
        setStatusMessage(
          `Animating path (${finalPlannerResult.transforms.length} steps via ${planner})`,
        );
        animatePieceAlongPath(
          matchResult.movingPieceName,
          finalPlannerResult.transforms,
          { expectedContactObjectIds },
        );
      } else {
        shakeMatchButton();
        if (finalPlannerResult.reason === "start-blocked") {
          startBlockedDiagnosis = diagnoseStartBlocked(
            sceneQuery,
            matchResult.movingPieceName,
            matchResult.currentPoseWorld,
          );
          setStatusMessage(
            startBlockedDiagnosis.obstacleObjectId
              ? `Path planning failed: start-blocked by ${startBlockedDiagnosis.obstacleObjectId}`
              : "Path planning failed: start-blocked",
          );
        } else if (
          finalPlannerResult.reason === "target-blocked"
          && typeof diagnoseTargetBlocked === "function"
        ) {
          targetBlockedDiagnosis = diagnoseTargetBlocked(
            sceneQuery,
            matchResult.movingPieceName,
            matchResult.targetPoseWorld,
          );
          setStatusMessage(
            targetBlockedDiagnosis.obstacleObjectId
              ? `Path planning failed: target-blocked by ${targetBlockedDiagnosis.obstacleObjectId}`
              : "Path planning failed: target-blocked",
          );
        } else {
          setStatusMessage(`Path planning failed: ${finalPlannerResult.reason}`);
        }
      }
    } catch (error) {
      shakeMatchButton();
      errorMessage = formatErrorMessage(error, "Path planning failed");
      setStatusMessage(errorMessage);
    }
    dumpReport();
    return;
  }

  if (matchResult.status === "need-edge") {
    setMatchStage("edge");
    shakeMatchButton();
    setStatusMessage(matchResult.reason);
    dumpReport();
    return;
  }

  if (matchResult.status === "need-vertex") {
    setMatchStage("vertex");
    shakeMatchButton();
    setStatusMessage(matchResult.reason);
    dumpReport();
    return;
  }

  clearMatchDisambiguationSelections();
  setMatchStage("face");
  shakeMatchButton();
  setStatusMessage(matchResult.reason ?? "Match failed");
  dumpReport();
}
