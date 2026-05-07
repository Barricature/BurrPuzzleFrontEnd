const DEFAULT_TRANSLATION_SPEED = 6;
const DEFAULT_ROTATION_SPEED_RAD = Math.PI * 0.85;

function isEditableTarget(target) {
  if (!target) {
    return false;
  }
  const tagName = target.tagName?.toLowerCase();
  if (target.isContentEditable) {
    return true;
  }
  return tagName === "input" || tagName === "textarea" || tagName === "select" || tagName === "button";
}

export function createKeyboardInputBindings({
  THREE,
  state,
  sceneRuntime,
  elements,
  findPieceByName,
  collisionGuard,
  translationSpeed = DEFAULT_TRANSLATION_SPEED,
  rotationSpeedRad = DEFAULT_ROTATION_SPEED_RAD,
}) {
  let lastBlock = null;
  const pressedKeys = new Set();
  const moveVector = new THREE.Vector3();
  const forward = new THREE.Vector3();
  const screenUp = new THREE.Vector3();
  const screenRight = new THREE.Vector3();
  const groundNormal = new THREE.Vector3(0, 1, 0);
  const tmpAxis = new THREE.Vector3();
  const tmpQuat = new THREE.Quaternion();
  const keyCodes = new Set([
    "KeyW",
    "KeyA",
    "KeyS",
    "KeyD",
    "KeyQ",
    "KeyE",
    "KeyR",
    "KeyF",
    "ArrowUp",
    "ArrowDown",
    "ArrowLeft",
    "ArrowRight",
  ]);

  function shouldIgnoreKeyboardEvent(event) {
    if (!event) {
      return true;
    }
    if (event.ctrlKey || event.metaKey || event.altKey) {
      return true;
    }
    return isEditableTarget(event.target);
  }

  function onKeyDown(event) {
    if (shouldIgnoreKeyboardEvent(event)) {
      return;
    }
    if (!keyCodes.has(event.code)) {
      return;
    }
    pressedKeys.add(event.code);
    event.preventDefault();
  }

  function onKeyUp(event) {
    pressedKeys.delete(event.code);
  }

  function bind() {
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", () => {
      pressedKeys.clear();
    });
  }

  function unbind() {
    window.removeEventListener("keydown", onKeyDown);
    window.removeEventListener("keyup", onKeyUp);
    pressedKeys.clear();
  }

  function resolveSelectedPiece() {
    const selectedPieceName = state.selectedTarget?.componentType === "piece"
      ? state.selectedTarget.pieceName
      : state.selectedPieceName;
    if (!selectedPieceName) {
      return null;
    }
    return findPieceByName(selectedPieceName);
  }

  function update(deltaSeconds) {
    if (pressedKeys.size === 0 || state.isAnimating) {
      return false;
    }
    if (!elements.controlsHelpModal?.classList.contains("hidden")) {
      return false;
    }
    const camera = sceneRuntime.camera;
    if (!camera) {
      return false;
    }

    const piece = resolveSelectedPiece();
    if (!piece) {
      return false;
    }

    camera.getWorldDirection(forward).normalize();
    screenUp.set(0, 1, 0).applyQuaternion(camera.quaternion).normalize();
    screenRight.crossVectors(forward, screenUp).normalize();

    moveVector.set(0, 0, 0);
    if (pressedKeys.has("KeyW")) {
      moveVector.add(screenUp);
    }
    if (pressedKeys.has("KeyS")) {
      moveVector.sub(screenUp);
    }
    if (pressedKeys.has("KeyD")) {
      moveVector.add(screenRight);
    }
    if (pressedKeys.has("KeyA")) {
      moveVector.sub(screenRight);
    }
    if (pressedKeys.has("ArrowUp")) {
      moveVector.add(forward);
    }
    if (pressedKeys.has("ArrowDown")) {
      moveVector.sub(forward);
    }

    // Translation: try each world axis component independently so the user
    // can "slide along walls" when the combined motion would penetrate.
    // Without this, a single blocked axis component would veto the whole
    // frame (e.g. after a Match the moving piece is interlocked along world
    // X but free along world Z; the long-axis disassembly slide fails as
    // soon as the screen-axis input has any X component).
    let translationApplied = false;
    let translationAttempted = false;
    let translationBlock = null;
    if (moveVector.lengthSq() > 1e-12) {
      translationAttempted = true;
      moveVector.normalize().multiplyScalar(translationSpeed * deltaSeconds);

      // Map world-axis deltas to the piece-state field they end up in.
      // `getMeshCenter(piece)` and `applyPlannerTransformToPiece(...)` both
      // use this convention: world X => piece.position.x,
      // world Y => piece.position.z, world Z => piece.position.y.
      const axisAttempts = [
        { delta: moveVector.x, field: "x" },
        { delta: moveVector.z, field: "y" },
        { delta: moveVector.y, field: "z" },
      ];
      for (const attempt of axisAttempts) {
        if (Math.abs(attempt.delta) <= 1e-12) continue;
        const before = piece.position[attempt.field];
        piece.position[attempt.field] = before + attempt.delta;
        if (collisionGuard) {
          const probe = collisionGuard.isPiecePenetrating(piece);
          if (probe?.blocked) {
            piece.position[attempt.field] = before;
            translationBlock = probe;
            continue;
          }
        }
        translationApplied = true;
      }
    }

    const rotationInput = [];
    if (pressedKeys.has("KeyQ")) {
      rotationInput.push({ axis: screenUp, sign: 1 });
    }
    if (pressedKeys.has("KeyE")) {
      rotationInput.push({ axis: screenUp, sign: -1 });
    }

    tmpAxis.copy(screenRight);
    tmpAxis.y = 0;
    if (tmpAxis.lengthSq() < 1e-10) {
      tmpAxis.set(1, 0, 0);
    } else {
      tmpAxis.normalize();
    }
    if (pressedKeys.has("ArrowLeft")) {
      rotationInput.push({ axis: tmpAxis, sign: 1 });
    }
    if (pressedKeys.has("ArrowRight")) {
      rotationInput.push({ axis: tmpAxis, sign: -1 });
    }

    const orthogonalAxis = new THREE.Vector3().crossVectors(groundNormal, forward);
    if (orthogonalAxis.lengthSq() < 1e-10) {
      orthogonalAxis.copy(screenRight);
    } else {
      orthogonalAxis.normalize();
    }
    if (pressedKeys.has("KeyR")) {
      rotationInput.push({ axis: orthogonalAxis, sign: 1 });
    }
    if (pressedKeys.has("KeyF")) {
      rotationInput.push({ axis: orthogonalAxis, sign: -1 });
    }

    let rotationApplied = false;
    let rotationAttempted = false;
    let rotationBlock = null;
    if (rotationInput.length > 0) {
      rotationAttempted = true;
      // Rotation is applied atomically (composed quaternions do not commute,
      // so per-axis decomposition is meaningless here); on collision we
      // revert just the rotation and keep any translation that succeeded.
      const rotationBefore = piece.rotationQuaternion
        ? {
          x: piece.rotationQuaternion.x,
          y: piece.rotationQuaternion.y,
          z: piece.rotationQuaternion.z,
          w: piece.rotationQuaternion.w,
        }
        : null;
      const orientationBefore = piece.orientation;

      const currentRotation = new THREE.Quaternion(
        piece.rotationQuaternion?.x ?? 0,
        piece.rotationQuaternion?.y ?? 0,
        piece.rotationQuaternion?.z ?? 0,
        piece.rotationQuaternion?.w ?? 1,
      );
      for (const item of rotationInput) {
        tmpQuat.setFromAxisAngle(item.axis, item.sign * rotationSpeedRad * deltaSeconds);
        currentRotation.premultiply(tmpQuat);
      }
      currentRotation.normalize();
      piece.rotationQuaternion = {
        x: currentRotation.x,
        y: currentRotation.y,
        z: currentRotation.z,
        w: currentRotation.w,
      };
      if (collisionGuard) {
        const probe = collisionGuard.isPiecePenetrating(piece);
        if (probe?.blocked) {
          if (rotationBefore) piece.rotationQuaternion = rotationBefore;
          if (typeof orientationBefore === "number") piece.orientation = orientationBefore;
          rotationBlock = probe;
        } else {
          rotationApplied = true;
        }
      } else {
        rotationApplied = true;
      }
    }

    const anyAttempted = translationAttempted || rotationAttempted;
    const anyApplied = translationApplied || rotationApplied;
    // Surface a "blocked" status only when the user pressed a key but
    // nothing was applied this frame; partial slides are not blocked.
    if (anyAttempted && !anyApplied) {
      lastBlock = translationBlock ?? rotationBlock ?? { blocked: true, obstacleObjectId: null };
      return false;
    }
    lastBlock = null;
    return anyApplied;
  }

  function getLastBlock() {
    return lastBlock;
  }

  return {
    bind,
    unbind,
    update,
    getLastBlock,
  };
}
