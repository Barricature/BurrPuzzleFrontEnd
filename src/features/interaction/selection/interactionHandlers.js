export function handleScenePointerMoveInteraction({
  event,
  state,
  getTargetsFromMouseEvent,
  targetsAreEqual,
  syncPieceObjects,
  renderThreeScene,
}) {
  const {
    pieceTarget,
    faceTargetOnSelectedPiece,
    edgeTargetOnSelectedPiece,
    vertexTargetOnSelectedPiece,
    edgeTargetAny,
    vertexTargetAny,
  } = getTargetsFromMouseEvent(event);

  let hoveredTarget = null;
  if (state.selectedPieceName) {
    if (state.matchStage === "edge") {
      hoveredTarget = edgeTargetOnSelectedPiece;
    } else if (state.matchStage === "vertex") {
      hoveredTarget = vertexTargetOnSelectedPiece;
    } else {
      hoveredTarget = faceTargetOnSelectedPiece;
    }
  } else if (state.matchStage === "edge") {
    hoveredTarget = edgeTargetAny;
  } else if (state.matchStage === "vertex") {
    hoveredTarget = vertexTargetAny;
  } else {
    hoveredTarget = pieceTarget;
  }
  if (targetsAreEqual(hoveredTarget, state.hoveredTarget)) {
    return;
  }

  state.hoveredTarget = hoveredTarget;
  state.hoveredPieceName = hoveredTarget?.pieceName ?? null;
  syncPieceObjects();
  renderThreeScene();
}

export function handleScenePointerLeaveInteraction({
  state,
  syncPieceObjects,
  renderThreeScene,
}) {
  if (!state.hoveredPieceName && !state.hoveredTarget) {
    return;
  }
  state.hoveredTarget = null;
  state.hoveredPieceName = null;
  syncPieceObjects();
  renderThreeScene();
}

export function handleSceneContextMenuInteraction({
  event,
  state,
  getTargetsFromMouseEvent,
  clearObjectSelection,
  setMatchStage,
  setStatusMessage,
  render,
}) {
  event.preventDefault();
  const { pieceTarget } = getTargetsFromMouseEvent(event);
  if (!pieceTarget) {
    clearObjectSelection("Object selection cleared");
    render();
    return;
  }

  setMatchStage("face");
  state.selectedTarget = pieceTarget;
  state.selectedPieceName = pieceTarget.pieceName;
  setStatusMessage("Object selected");
  render();
}

export function handleSceneLeftClickInteraction({
  event,
  state,
  getTargetsFromMouseEvent,
  pushSelectedEdgeTarget,
  pushSelectedVertexTarget,
  clearFaceSelection,
  pushSelectedFaceTarget,
  setStatusMessage,
  render,
}) {
  if (event.button !== 0) {
    return;
  }
  const {
    faceTargetOnSelectedPiece,
    edgeTargetAny,
    vertexTargetAny,
  } = getTargetsFromMouseEvent(event);

  if (state.matchStage === "edge") {
    if (!edgeTargetAny) {
      return;
    }
    pushSelectedEdgeTarget(edgeTargetAny);
    state.hoveredTarget = edgeTargetAny;
    state.hoveredPieceName = edgeTargetAny.pieceName;
    setStatusMessage("Edge selected");
    render();
    return;
  }

  if (state.matchStage === "vertex") {
    if (!vertexTargetAny) {
      return;
    }
    pushSelectedVertexTarget(vertexTargetAny);
    state.hoveredTarget = vertexTargetAny;
    state.hoveredPieceName = vertexTargetAny.pieceName;
    setStatusMessage("Vertex selected");
    render();
    return;
  }

  if (!state.selectedPieceName) {
    if (state.selectedFaceTargets.length > 0) {
      clearFaceSelection("Face selection cleared");
      render();
    }
    return;
  }

  if (!faceTargetOnSelectedPiece) {
    if (state.selectedFaceTargets.length > 0) {
      clearFaceSelection("Face selection cleared");
      render();
    }
    return;
  }

  state.selectedTarget = null;
  state.selectedPieceName = null;
  pushSelectedFaceTarget(faceTargetOnSelectedPiece);
  state.hoveredTarget = faceTargetOnSelectedPiece;
  state.hoveredPieceName = faceTargetOnSelectedPiece.pieceName;
  setStatusMessage("Face selected");
  render();
}
