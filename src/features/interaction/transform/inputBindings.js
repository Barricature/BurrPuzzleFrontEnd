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
  translationSpeed = DEFAULT_TRANSLATION_SPEED,
  rotationSpeedRad = DEFAULT_ROTATION_SPEED_RAD,
}) {
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

    let changed = false;
    if (moveVector.lengthSq() > 1e-12) {
      moveVector.normalize().multiplyScalar(translationSpeed * deltaSeconds);
      piece.position.x += moveVector.x;
      piece.position.y += moveVector.z;
      piece.position.z += moveVector.y;
      changed = true;
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

    if (rotationInput.length > 0) {
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
      changed = true;
    }

    return changed;
  }

  return {
    bind,
    unbind,
    update,
  };
}
