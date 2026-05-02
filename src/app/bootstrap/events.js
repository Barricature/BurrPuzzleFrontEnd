export function registerGlobalErrorHandlers({
  state,
  setStatusMessage,
  formatErrorMessage,
  logger = console,
}) {
  window.addEventListener("error", (event) => {
    logger.error("[GlobalError]", event.error ?? event.message);
    state.loadStatus = "Failed";
    setStatusMessage(`Runtime error: ${event.message}`);
  });

  window.addEventListener("unhandledrejection", (event) => {
    logger.error("[UnhandledPromiseRejection]", event.reason);
    state.loadStatus = "Failed";
    setStatusMessage(`Unhandled promise: ${formatErrorMessage(event.reason, "unknown rejection")}`);
  });
}

export function bindBootstrapEvents({
  elements,
  loadAndRenderPuzzle,
  runMatchFlow,
  clearAllSelections,
  render,
}) {
  const openControlsHelp = () => {
    elements.controlsHelpModal.classList.remove("hidden");
    elements.controlsInfoButton.setAttribute("aria-expanded", "true");
  };

  const closeControlsHelp = () => {
    elements.controlsHelpModal.classList.add("hidden");
    elements.controlsInfoButton.setAttribute("aria-expanded", "false");
  };

  elements.reloadButton.addEventListener("click", async () => {
    await loadAndRenderPuzzle();
  });
  elements.matchButton.addEventListener("click", runMatchFlow);
  elements.clearSelectionButton.addEventListener("click", () => {
    clearAllSelections("All selections cleared");
    render();
  });
  elements.controlsInfoButton.addEventListener("click", openControlsHelp);
  elements.controlsHelpClose.addEventListener("click", closeControlsHelp);
  elements.controlsHelpBackdrop.addEventListener("click", closeControlsHelp);
}
