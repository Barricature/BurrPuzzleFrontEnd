function pushBoundedUniqueTarget(state, listKey, target) {
  const withOrder = {
    ...target,
    selectedAt: ++state.selectionOrderCounter,
  };
  const filtered = state[listKey].filter(
    (entry) => !(entry.pieceName === target.pieceName && entry.componentId === target.componentId),
  );
  state[listKey] = [...filtered, withOrder].slice(-2);
}

export function targetsAreEqual(first, second) {
  if (!first && !second) {
    return true;
  }
  if (!first || !second) {
    return false;
  }
  return (
    first.pieceName === second.pieceName &&
    first.componentType === second.componentType &&
    first.componentId === second.componentId
  );
}

export function isTargetMatch(target, pieceName, componentType, componentId) {
  return (
    target?.pieceName === pieceName &&
    target?.componentType === componentType &&
    target?.componentId === componentId
  );
}

export function isFaceTargetSelected(state, pieceName, componentId) {
  return state.selectedFaceTargets.some(
    (target) => target.pieceName === pieceName && target.componentType === "face" && target.componentId === componentId,
  );
}

export function pushSelectedFaceTarget(state, target) {
  pushBoundedUniqueTarget(state, "selectedFaceTargets", target);
}

export function isEdgeTargetSelected(state, pieceName, componentId) {
  return state.selectedEdgeTargets.some(
    (target) => target.pieceName === pieceName && target.componentType === "edge" && target.componentId === componentId,
  );
}

export function pushSelectedEdgeTarget(state, target) {
  pushBoundedUniqueTarget(state, "selectedEdgeTargets", target);
}

export function isVertexTargetSelected(state, pieceName, componentId) {
  return state.selectedVertexTargets.some(
    (target) => target.pieceName === pieceName && target.componentType === "vertex" && target.componentId === componentId,
  );
}

export function pushSelectedVertexTarget(state, target) {
  pushBoundedUniqueTarget(state, "selectedVertexTargets", target);
}

export function clearHoverHighlight(state) {
  state.hoveredTarget = null;
  state.hoveredPieceName = null;
}

export function clearObjectSelection(state, setStatusMessage, statusMessage = null) {
  state.selectedPieceName = null;
  state.selectedTarget = null;
  clearHoverHighlight(state);
  if (statusMessage) {
    setStatusMessage(statusMessage);
  }
}

export function clearFaceSelection(state, setStatusMessage, statusMessage = null) {
  state.selectedFaceTargets = [];
  clearHoverHighlight(state);
  if (statusMessage) {
    setStatusMessage(statusMessage);
  }
}

export function clearEdgeSelection(state, setStatusMessage, statusMessage = null) {
  state.selectedEdgeTargets = [];
  clearHoverHighlight(state);
  if (statusMessage) {
    setStatusMessage(statusMessage);
  }
}

export function clearVertexSelection(state, setStatusMessage, statusMessage = null) {
  state.selectedVertexTargets = [];
  clearHoverHighlight(state);
  if (statusMessage) {
    setStatusMessage(statusMessage);
  }
}

export function clearAllSelections(state, setStatusMessage, statusMessage = null) {
  state.selectedPieceName = null;
  state.selectedTarget = null;
  state.selectedFaceTargets = [];
  state.selectedEdgeTargets = [];
  state.selectedVertexTargets = [];
  state.matchStage = "face";
  clearHoverHighlight(state);
  if (statusMessage) {
    setStatusMessage(statusMessage);
  }
}

export function clearMatchDisambiguationSelections(state) {
  state.selectedEdgeTargets = [];
  state.selectedVertexTargets = [];
  if (state.hoveredTarget?.componentType === "edge" || state.hoveredTarget?.componentType === "vertex") {
    clearHoverHighlight(state);
  }
}

export function setMatchStage(state, stage) {
  state.matchStage = stage;
}
