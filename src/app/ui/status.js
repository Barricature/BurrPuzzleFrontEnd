export function formatErrorMessage(error, fallback = "Unknown error") {
  return error instanceof Error ? error.message : fallback;
}

export function getSelectedPiece(state) {
  return state.pieces.find((piece) => piece.name === state.selectedPieceName) ?? null;
}

export function renderStatus(state, elements) {
  elements.statusMessage.textContent = state.statusMessage;
  elements.loadStatus.textContent = `Load: ${state.loadStatus}`;
  elements.collisionStatus.textContent = `Collision: ${state.collisionStatus}`;
  elements.successStatus.textContent = `Success: ${state.successStatus}`;

  elements.loadStatus.className = `status-pill ${state.loadStatus === "Loaded" ? "is-success" : ""}`.trim();
  elements.collisionStatus.className = "status-pill is-success";
  elements.successStatus.className = "status-pill";
}

export function renderInspector(state, elements) {
  const selectedPiece = getSelectedPiece(state);
  elements.pieceCount.textContent = String(state.pieces.length);
  elements.selectedPieceName.textContent = selectedPiece ? selectedPiece.name : "None";

  if (!selectedPiece) {
    elements.selectionEmpty.classList.remove("hidden");
    elements.selectionDetails.classList.add("hidden");
    return;
  }

  elements.selectionEmpty.classList.add("hidden");
  elements.selectionDetails.classList.remove("hidden");
  elements.inspectorName.textContent = selectedPiece.name;
  elements.coordOrientation.textContent = `${selectedPiece.orientation.toFixed(1)}deg`;
}
