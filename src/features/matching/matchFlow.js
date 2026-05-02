export function buildPiecesByNameMap(pieces) {
  return Object.fromEntries(pieces.map((piece) => [piece.name, piece]));
}

export function outputCurrentAndTargetWorldPose(matchResult, setStatusMessage, logger = console) {
  const payload = {
    movingPiece: matchResult.movingPieceName,
    fixedPiece: matchResult.fixedPieceName,
    currentPoseWorld: matchResult.currentPoseWorld,
    targetPoseWorld: matchResult.targetPoseWorld,
    deltaTransformWorld: matchResult.deltaTransformWorld ?? null,
  };
  logger.log("Match pose output", payload);
  setStatusMessage(`Match solved for ${matchResult.movingPieceName}. See console for world poses.`);
}

export function logMatchComputationChain(matchResult, state, logger = console) {
  logger.groupCollapsed(`[Match] status=${matchResult.status}`);
  logger.log("Match result output:", matchResult);
  logger.log("Selected faces:", state.selectedFaceTargets);
  logger.log("Selected edges:", state.selectedEdgeTargets);
  logger.log("Selected vertices:", state.selectedVertexTargets);
  if (matchResult.currentPoseWorld || matchResult.targetPoseWorld) {
    logger.log("Current pose world:", matchResult.currentPoseWorld ?? null);
    logger.log("Target pose world:", matchResult.targetPoseWorld ?? null);
  }
  if (matchResult.debugChain) {
    logger.log("Debug chain:", matchResult.debugChain);
  }
  logger.groupEnd();
}

export function runMatchFlowCoordinator({
  state,
  sceneRuntime,
  computeMatchTransform,
  buildPiecesByNameMapFn,
  logMatchComputationChainFn,
  clearMatchDisambiguationSelections,
  setMatchStage,
  outputCurrentAndTargetWorldPoseFn,
  syncPieceObjects,
  getCollisionSceneQuery,
  planCollisionFreeSe3Path,
  animatePieceAlongPath,
  shakeMatchButton,
  diagnoseStartBlocked,
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
  const result = computeMatchTransform({
    selectedFaces: state.selectedFaceTargets,
    selectedEdges: state.selectedEdgeTargets,
    selectedVertices: state.selectedVertexTargets,
    piecesByName: buildPiecesByNameMapFn(state.pieces),
  });
  logMatchComputationChainFn(result);

  if (result.status === "success") {
    clearMatchDisambiguationSelections();
    setMatchStage("face");
    outputCurrentAndTargetWorldPoseFn(result);
    try {
      const sceneQuery = getCollisionSceneQuery();
      const plannerResult = planCollisionFreeSe3Path({
        movingObjectId: result.movingPieceName,
        startTransform: result.currentPoseWorld,
        targetTransform: result.targetPoseWorld,
        attachmentNormalWorld: result.attachmentNormalWorld,
        sceneQuery,
      });
      console.log("[Match Planner] planCollisionFreeSe3Path output:", plannerResult);

      if (plannerResult.status === "found") {
        setStatusMessage(`Animating path (${plannerResult.transforms.length} steps)`);
        animatePieceAlongPath(result.movingPieceName, plannerResult.transforms);
      } else {
        shakeMatchButton();
        if (plannerResult.reason === "start-blocked") {
          const startBlockedDiagnosis = diagnoseStartBlocked(
            sceneQuery,
            result.movingPieceName,
            result.currentPoseWorld,
          );
          const obstacleObjectId = startBlockedDiagnosis.obstacleObjectId;
          setStatusMessage(
            obstacleObjectId
              ? `Path planning failed: start-blocked by ${obstacleObjectId}`
              : "Path planning failed: start-blocked",
          );
        } else {
          setStatusMessage(`Path planning failed: ${plannerResult.reason}`);
        }
      }
    } catch (error) {
      shakeMatchButton();
      setStatusMessage(formatErrorMessage(error, "Path planning failed"));
    }
    return;
  }

  if (result.status === "need-edge") {
    setMatchStage("edge");
    shakeMatchButton();
    setStatusMessage(result.reason);
    return;
  }

  if (result.status === "need-vertex") {
    setMatchStage("vertex");
    shakeMatchButton();
    setStatusMessage(result.reason);
    return;
  }

  clearMatchDisambiguationSelections();
  setMatchStage("face");
  shakeMatchButton();
  setStatusMessage(result.reason ?? "Match failed");
}
