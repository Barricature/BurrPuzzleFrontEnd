export function applyPlannerTransformToPiece({
  pieceName,
  transform,
  findPieceByName,
  gridWidth,
  gridHeight,
  THREE,
}) {
  const piece = findPieceByName(pieceName);
  if (!piece) {
    return false;
  }
  piece.position = {
    x: transform.position.x + gridWidth / 2,
    y: transform.position.z + gridHeight / 2,
    z: transform.position.y,
  };
  piece.rotationQuaternion = {
    x: transform.rotation.x,
    y: transform.rotation.y,
    z: transform.rotation.z,
    w: transform.rotation.w,
  };
  const yaw = new THREE.Euler().setFromQuaternion(
    new THREE.Quaternion(
      transform.rotation.x,
      transform.rotation.y,
      transform.rotation.z,
      transform.rotation.w,
    ),
    "YXZ",
  ).y;
  piece.orientation = THREE.MathUtils.radToDeg(yaw);
  return true;
}

export function animatePieceAlongPath({
  movingPieceName,
  transforms,
  THREE,
  state,
  sceneRuntime,
  applyPlannerTransformToPieceFn,
  syncPieceObjects,
  renderThreeScene,
  renderInspector,
  render,
  setStatusMessage,
}) {
  if (!transforms?.length) {
    return;
  }
  if (sceneRuntime.activeAnimationFrame !== null) {
    cancelAnimationFrame(sceneRuntime.activeAnimationFrame);
    sceneRuntime.activeAnimationFrame = null;
  }

  state.isAnimating = true;
  const waypoints = transforms;
  const segmentDurationMs = 80;
  let segmentIndex = 0;
  let segmentStart = performance.now();

  const tick = (now) => {
    if (segmentIndex >= waypoints.length - 1) {
      applyPlannerTransformToPieceFn(movingPieceName, waypoints[waypoints.length - 1]);
      state.isAnimating = false;
      sceneRuntime.activeAnimationFrame = null;
      render();
      setStatusMessage("Path animation complete");
      return;
    }

    const from = waypoints[segmentIndex];
    const to = waypoints[segmentIndex + 1];
    const t = THREE.MathUtils.clamp((now - segmentStart) / segmentDurationMs, 0, 1);

    const interpPosition = new THREE.Vector3(from.position.x, from.position.y, from.position.z).lerp(
      new THREE.Vector3(to.position.x, to.position.y, to.position.z),
      t,
    );
    const interpRotation = new THREE.Quaternion(from.rotation.x, from.rotation.y, from.rotation.z, from.rotation.w)
      .normalize()
      .slerp(new THREE.Quaternion(to.rotation.x, to.rotation.y, to.rotation.z, to.rotation.w).normalize(), t);

    applyPlannerTransformToPieceFn(movingPieceName, {
      position: { x: interpPosition.x, y: interpPosition.y, z: interpPosition.z },
      rotation: { x: interpRotation.x, y: interpRotation.y, z: interpRotation.z, w: interpRotation.w },
    });
    syncPieceObjects();
    renderThreeScene();
    renderInspector();

    if (t >= 1) {
      segmentIndex += 1;
      segmentStart = now;
    }
    sceneRuntime.activeAnimationFrame = requestAnimationFrame(tick);
  };

  sceneRuntime.activeAnimationFrame = requestAnimationFrame(tick);
}
