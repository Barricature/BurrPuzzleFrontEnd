import * as THREE from "https://esm.sh/three@0.181.1";
import { OrbitControls } from "https://esm.sh/three@0.181.1/examples/jsm/controls/OrbitControls.js";
import { STLLoader } from "https://esm.sh/three@0.181.1/examples/jsm/loaders/STLLoader.js";
import { Line2 } from "https://esm.sh/three@0.181.1/examples/jsm/lines/Line2.js";
import { LineMaterial } from "https://esm.sh/three@0.181.1/examples/jsm/lines/LineMaterial.js";
import { LineGeometry } from "https://esm.sh/three@0.181.1/examples/jsm/lines/LineGeometry.js";
import { MeshBVH } from "../../node_modules/three-mesh-bvh/src/core/MeshBVH.js";
import { SAMPLE_PUZZLE_MANIFEST } from "../../public/sample-puzzle-manifest.js";
import { extractMeshTopology } from "../features/puzzle-loader/adapters/puzzleAdapter.ts";
import { computeMatchTransform } from "../features/physics/path-finding/computeTransform.ts";
import { planCollisionFreeSe3Path } from "../features/physics/path-finding/collisionFreePath.browser.js";
import {
  clearAllSelections as clearAllSelectionsImpl,
  clearFaceSelection as clearFaceSelectionImpl,
  clearMatchDisambiguationSelections as clearMatchDisambiguationSelectionsImpl,
  clearObjectSelection as clearObjectSelectionImpl,
  isEdgeTargetSelected as isEdgeTargetSelectedImpl,
  isFaceTargetSelected as isFaceTargetSelectedImpl,
  isTargetMatch as isTargetMatchImpl,
  isVertexTargetSelected as isVertexTargetSelectedImpl,
  pushSelectedEdgeTarget as pushSelectedEdgeTargetImpl,
  pushSelectedFaceTarget as pushSelectedFaceTargetImpl,
  pushSelectedVertexTarget as pushSelectedVertexTargetImpl,
  setMatchStage as setMatchStageImpl,
  targetsAreEqual as targetsAreEqualImpl,
} from "../features/interaction/selection/selectionState.js";
import {
  handleSceneContextMenuInteraction,
  handleSceneLeftClickInteraction,
  handleScenePointerLeaveInteraction,
  handleScenePointerMoveInteraction,
} from "../features/interaction/selection/interactionHandlers.js";
import { createTargetResolver } from "../features/interaction/selection/targetResolver.js";
import {
  buildPiecesByNameMap as buildPiecesByNameMapImpl,
  logMatchComputationChain as logMatchComputationChainImpl,
  outputCurrentAndTargetWorldPose as outputCurrentAndTargetWorldPoseImpl,
  runMatchFlowCoordinator,
} from "../features/matching/matchFlow.js";
import { createCollisionSceneTools } from "../features/planning/sceneQuery.js";
import {
  animatePieceAlongPath as animatePieceAlongPathImpl,
  applyPlannerTransformToPiece as applyPlannerTransformToPieceImpl,
} from "../features/planning/animationPlayer.js";
import { createSceneBootstrap } from "../features/rendering/sceneBootstrap.js";
import { createKeyboardInputBindings } from "../features/interaction/transform/inputBindings.js";

const targetResolver = createTargetResolver({
  THREE,
  sceneRuntime,
  state,
  edgeBaseLineWidthPx: EDGE_BASE_LINE_WIDTH_PX,
  edgePickRadiusMultiplier: EDGE_PICK_RADIUS_MULTIPLIER,
  vertexBasePickRadiusPx: VERTEX_BASE_PICK_RADIUS_PX,
  vertexPickRadiusMultiplier: VERTEX_PICK_RADIUS_MULTIPLIER,
});
const collisionSceneTools = createCollisionSceneTools({
  THREE,
  state,
  sceneRuntime,
  gridWidth: GRID_WIDTH,
  gridHeight: GRID_HEIGHT,
  defaultCollisionEpsilon: DEFAULT_COLLISION_EPSILON,
  formatErrorMessage,
});
const sceneBootstrap = createSceneBootstrap({
  THREE,
  OrbitControls,
  elements,
  sceneRuntime,
  onPointerMove: handleScenePointerMove,
  onPointerLeave: handleScenePointerLeave,
  onLeftClick: handleSceneLeftClick,
  onContextMenu: handleSceneContextMenu,
});
import {
  DEFAULT_COLLISION_EPSILON,
  EDGE_BASE_LINE_WIDTH_PX,
  EDGE_HOVER_WIDTH_MULTIPLIER,
  EDGE_PICK_RADIUS_MULTIPLIER,
  EDGE_SELECTED_WIDTH_MULTIPLIER,
  GRID_HEIGHT,
  GRID_WIDTH,
  VERTEX_BASE_PICK_RADIUS_PX,
  VERTEX_PICK_RADIUS_MULTIPLIER,
} from "../app/core/constants.js";
import { elements, sceneRuntime, state } from "../app/core/runtime.js";
import {
  formatErrorMessage as formatErrorMessageFromUi,
  renderInspector as renderInspectorFromUi,
  renderStatus as renderStatusFromUi,
} from "../app/ui/status.js";
import {
  bindBootstrapEvents,
  registerGlobalErrorHandlers as registerGlobalErrorHandlersImpl,
} from "../app/bootstrap/events.js";

function setStatusMessage(message) {
  state.statusMessage = message;
  renderStatus();
}

function formatErrorMessage(error, fallback = "Unknown error") {
  return formatErrorMessageFromUi(error, fallback);
}

function renderStatus() {
  renderStatusFromUi(state, elements);
}

function renderPieceList() {
  elements.pieceList.innerHTML = "";

  state.pieces.forEach((piece) => {
    const item = document.createElement("button");
    item.type = "button";
    item.className = `piece-item ${piece.name === state.selectedPieceName ? "is-selected" : ""}`.trim();
    item.textContent = piece.name;
    item.addEventListener("click", () => {
      state.selectedPieceName = piece.name;
      state.selectedTarget = {
        pieceName: piece.name,
        componentType: "piece",
        componentId: piece.name,
      };
      state.hoveredTarget = null;
      state.hoveredPieceName = null;
      setStatusMessage("Piece selected");
      renderInspector();
      renderPieceList();
      syncPieceObjects();
      sceneBootstrap.renderThreeScene();
    });
    elements.pieceList.appendChild(item);
  });
}

function renderInspector() {
  renderInspectorFromUi(state, elements);
}

function getMeshCenter(piece) {
  return {
    x: piece.position.x - GRID_WIDTH / 2,
    y: piece.position.z,
    z: piece.position.y - GRID_HEIGHT / 2,
  };
}

function syncPieceObjects() {
  const activePieceNames = new Set(state.pieces.map((piece) => piece.name));
  for (const [pieceName, object] of sceneRuntime.pieceObjects.entries()) {
    if (!activePieceNames.has(pieceName)) {
      sceneRuntime.scene.remove(object);
      sceneRuntime.pieceObjects.delete(pieceName);
    }
  }

  state.pieces.forEach((piece) => {
    let object = sceneRuntime.pieceObjects.get(piece.name);
    if (!object) {
      object = piece.rootObject;
      sceneRuntime.scene.add(object);
      sceneRuntime.pieceObjects.set(piece.name, object);
    }

    const center = getMeshCenter(piece);
    object.position.set(center.x, center.y, center.z);
    if (piece.rotationQuaternion) {
      object.quaternion.set(
        piece.rotationQuaternion.x,
        piece.rotationQuaternion.y,
        piece.rotationQuaternion.z,
        piece.rotationQuaternion.w,
      );
    } else {
      object.rotation.set(0, THREE.MathUtils.degToRad(piece.orientation), 0);
    }

    object.traverse((child) => {
      const componentType = child.userData?.componentType;
      const componentId = child.userData?.componentId;

      if (componentType === "face" && child.isMesh) {
        const isSelectedFace = isFaceTargetSelectedImpl(state, piece.name, componentId);
        const isHoveredFace = isTargetMatchImpl(state.hoveredTarget, piece.name, "face", componentId);
        child.material.opacity = isSelectedFace ? 0.55 : isHoveredFace ? 0.28 : 0.08;
        child.material.color.set(isSelectedFace ? "#f08a5d" : isHoveredFace ? "#f2b28f" : "#5f81a8");
        return;
      }

      if (componentType === "edge" && child.material) {
        const isSelectedEdge = isEdgeTargetSelectedImpl(state, piece.name, componentId);
        const isHoveredEdge = isTargetMatchImpl(state.hoveredTarget, piece.name, "edge", componentId);
        child.material.opacity = isSelectedEdge ? 1 : isHoveredEdge ? 0.85 : 0.35;
        child.material.color.set(isSelectedEdge ? "#f08a5d" : isHoveredEdge ? "#f2b28f" : "#2f241d");
        if (typeof child.material.linewidth === "number") {
          const widthMultiplier = isSelectedEdge ? EDGE_SELECTED_WIDTH_MULTIPLIER : isHoveredEdge ? EDGE_HOVER_WIDTH_MULTIPLIER : 1;
          child.material.linewidth = EDGE_BASE_LINE_WIDTH_PX * widthMultiplier;
        }
        return;
      }

      if (componentType === "vertex" && child.isMesh) {
        const isSelectedVertex = isVertexTargetSelectedImpl(state, piece.name, componentId);
        const isHoveredVertex = isTargetMatchImpl(state.hoveredTarget, piece.name, "vertex", componentId);
        child.material.color.set(isSelectedVertex ? "#f08a5d" : isHoveredVertex ? "#f2b28f" : "#2f241d");
        child.material.emissive.set(isSelectedVertex ? "#7f2f12" : isHoveredVertex ? "#6d3d22" : "#000000");
        child.material.emissiveIntensity = isSelectedVertex || isHoveredVertex ? 0.45 : 0;
        return;
      }

      if (!child.isMesh) {
        return;
      }
      const isSelectedPiece = isTargetMatchImpl(state.selectedTarget, piece.name, "piece", piece.name);
      const isHoveredPiece = isTargetMatchImpl(state.hoveredTarget, piece.name, "piece", piece.name);
      if (child.material.emissive) {
        if (isSelectedPiece) {
          child.material.emissive.set("#f5e6d8");
        } else if (isHoveredPiece) {
          child.material.emissive.set("#dcc6b2");
        } else {
          child.material.emissive.set("#000000");
        }
      }
      child.material.emissiveIntensity = isSelectedPiece ? 0.35 : isHoveredPiece ? 0.24 : 0;
    });
  });
}

function normalizeGeometry(geometry) {
  geometry.computeBoundingBox();
  const bounds = geometry.boundingBox;
  if (!bounds) {
    return geometry;
  }
  const center = new THREE.Vector3();
  bounds.getCenter(center);
  geometry.translate(-center.x, -center.y, -center.z);
  geometry.computeVertexNormals();
  return geometry;
}

function measureMeshSize(mesh) {
  const bounds = new THREE.Box3().setFromObject(mesh);
  const size = new THREE.Vector3();
  bounds.getSize(size);
  return {
    width: Math.max(size.x, 1),
    height: Math.max(size.z, 1),
    depth: Math.max(size.y, 1),
  };
}

function getPieceMaxDimension(piece) {
  return Math.max(piece.size.width, piece.size.height, piece.size.depth);
}

function applyLoadSpacing(pieces) {
  if (pieces.length === 0) {
    return;
  }

  let cursorX = pieces[0].initialPosition.x;
  pieces[0].position = {
    x: cursorX,
    y: pieces[0].initialPosition.y,
    z: pieces[0].initialPosition.z,
  };

  for (let i = 1; i < pieces.length; i += 1) {
    const previous = pieces[i - 1];
    const current = pieces[i];
    const minSeparation = 2 * Math.max(getPieceMaxDimension(previous), getPieceMaxDimension(current));
    cursorX += minSeparation;
    current.position = {
      x: cursorX,
      y: current.initialPosition.y,
      z: current.initialPosition.z,
    };
  }
}

function buildTopologyGroups(topology) {
  const vertexGroups = topology.vertices.map((vertex, vertexIndex) => ({
    id: `vg-${vertex.id}`,
    vertexId: vertex.id,
    vertexIndex,
    vertex,
  }));

  const edgeGroups = topology.edges.map((edge, edgeIndex) => ({
    id: `eg-${edge.id}`,
    edgeId: edge.id,
    edgeIndex,
    edge,
    vertices: edge.vertexIndices.map((vertexIndex) => topology.vertices[vertexIndex]),
  }));

  const faceGroups = topology.faces.map((face, faceIndex) => ({
    id: `fg-${face.id}`,
    faceId: face.id,
    faceIndex,
    face,
    vertices: face.vertexIndices.map((vertexIndex) => topology.vertices[vertexIndex]),
    edges: face.edgeIndices.map((edgeIndex) => topology.edges[edgeIndex]),
  }));

  return {
    vertexGroups,
    edgeGroups,
    faceGroups,
  };
}

function createFaceMesh(topology, face, pieceName) {
  const faceTriangles = face.triangleVertexIndices ?? face.vertexIndices
    .slice(1, -1)
    .map((vertexIndex, index) => [face.vertexIndices[0], vertexIndex, face.vertexIndices[index + 2]]);
  const geometry = new THREE.BufferGeometry();
  const positions = new Float32Array(faceTriangles.length * 9);

  faceTriangles.forEach((triangle, triangleIndex) => {
    const triangleOffset = triangleIndex * 9;
    const triangleVertices = triangle.map((vertexIndex) => topology.vertices[vertexIndex]);
    triangleVertices.forEach((vertex, vertexOffset) => {
      const positionOffset = triangleOffset + vertexOffset * 3;
      positions[positionOffset] = vertex.x;
      positions[positionOffset + 1] = vertex.y;
      positions[positionOffset + 2] = vertex.z;
    });
  });

  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.computeVertexNormals();

  const material = new THREE.MeshBasicMaterial({
    color: "#5f81a8",
    transparent: true,
    opacity: 0.08,
    depthWrite: false,
    side: THREE.DoubleSide,
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.userData = {
    pieceName,
    componentType: "face",
    componentId: face.id,
  };
  return mesh;
}

function createEdgeLine(topology, edge, pieceName) {
  const [a, b] = edge.vertexIndices.map((vertexIndex) => topology.vertices[vertexIndex]);
  const geometry = new LineGeometry();
  geometry.setPositions([
    a.x, a.y, a.z,
    b.x, b.y, b.z,
  ]);
  const material = new LineMaterial({
    color: "#2f241d",
    transparent: true,
    opacity: 0.35,
    linewidth: EDGE_BASE_LINE_WIDTH_PX,
    worldUnits: false,
  });
  const line = new Line2(geometry, material);
  line.computeLineDistances();
  line.userData = {
    pieceName,
    componentType: "edge",
    componentId: edge.id,
    localStart: { x: a.x, y: a.y, z: a.z },
    localEnd: { x: b.x, y: b.y, z: b.z },
  };
  return line;
}

function createVertexMarker(vertex, pieceName) {
  const geometry = new THREE.SphereGeometry(0.03, 10, 10);
  const material = new THREE.MeshStandardMaterial({
    color: "#2f241d",
    roughness: 0.45,
    metalness: 0.1,
    transparent: true,
    opacity: 0.85,
  });
  const marker = new THREE.Mesh(geometry, material);
  marker.position.set(vertex.x, vertex.y, vertex.z);
  marker.userData = {
    pieceName,
    componentType: "vertex",
    componentId: vertex.id,
  };
  return marker;
}

function createTopologyInteractionRoot(pieceName, topology) {
  const root = new THREE.Group();
  root.name = `${pieceName}-topology`;

  const facesGroup = new THREE.Group();
  facesGroup.name = "faces";
  topology.faces.forEach((face) => {
    facesGroup.add(createFaceMesh(topology, face, pieceName));
  });

  const edgesGroup = new THREE.Group();
  edgesGroup.name = "edges";
  topology.edges.forEach((edge) => {
    edgesGroup.add(createEdgeLine(topology, edge, pieceName));
  });

  const verticesGroup = new THREE.Group();
  verticesGroup.name = "vertices";
  topology.vertices.forEach((vertex) => {
    verticesGroup.add(createVertexMarker(vertex, pieceName));
  });

  root.add(facesGroup);
  root.add(edgesGroup);
  root.add(verticesGroup);
  return root;
}

function shakeMatchButton() {
  elements.matchButton.animate(
    [
      { transform: "translateX(0)" },
      { transform: "translateX(-6px)" },
      { transform: "translateX(6px)" },
      { transform: "translateX(-4px)" },
      { transform: "translateX(4px)" },
      { transform: "translateX(0)" },
    ],
    { duration: 300, easing: "ease-out" },
  );
}

function runMatchFlow() {
  runMatchFlowCoordinator({
    state,
    sceneRuntime,
    computeMatchTransform,
    buildPiecesByNameMapFn: () => buildPiecesByNameMapImpl(state.pieces),
    logMatchComputationChainFn: (matchResult) => logMatchComputationChainImpl(matchResult, state, console),
    clearMatchDisambiguationSelections: () => clearMatchDisambiguationSelectionsImpl(state),
    setMatchStage: (stage) => setMatchStageImpl(state, stage),
    outputCurrentAndTargetWorldPoseFn: (matchResult) =>
      outputCurrentAndTargetWorldPoseImpl(matchResult, setStatusMessage, console),
    syncPieceObjects,
    getCollisionSceneQuery: () => collisionSceneTools.getCollisionSceneQuery(),
    planCollisionFreeSe3Path,
    animatePieceAlongPath: (movingPieceName, transforms) =>
      animatePieceAlongPathImpl({
        movingPieceName,
        transforms,
        THREE,
        state,
        sceneRuntime,
        applyPlannerTransformToPieceFn: (pieceName, transform) =>
          applyPlannerTransformToPieceImpl({
            pieceName,
            transform,
            findPieceByName: (targetName) =>
              state.pieces.find((piece) => piece.name === targetName) ?? null,
            gridWidth: GRID_WIDTH,
            gridHeight: GRID_HEIGHT,
            THREE,
          }),
        syncPieceObjects,
        renderThreeScene: () => sceneBootstrap.renderThreeScene(),
        renderInspector,
        render,
        setStatusMessage,
      }),
    shakeMatchButton,
    diagnoseStartBlocked: (sceneQuery, movingObjectId, startTransform) =>
      collisionSceneTools.diagnoseStartBlocked(sceneQuery, movingObjectId, startTransform),
    setStatusMessage,
    formatErrorMessage,
  });
}

function createRandomPieceColor() {
  const hue = Math.random();
  const saturation = 0.45 + Math.random() * 0.3;
  const lightness = 0.45 + Math.random() * 0.2;
  return new THREE.Color().setHSL(hue, saturation, lightness);
}

function getTargetsFromMouseEvent(event) {
  return targetResolver.getTargetsFromMouseEvent(event);
}

function handleScenePointerMove(event) {
  handleScenePointerMoveInteraction({
    event,
    state,
    getTargetsFromMouseEvent,
    targetsAreEqual: (first, second) => targetsAreEqualImpl(first, second),
    syncPieceObjects,
    renderThreeScene: () => sceneBootstrap.renderThreeScene(),
  });
}

function handleScenePointerLeave() {
  handleScenePointerLeaveInteraction({
    state,
    syncPieceObjects,
    renderThreeScene: () => sceneBootstrap.renderThreeScene(),
  });
}

function handleSceneContextMenu(event) {
  handleSceneContextMenuInteraction({
    event,
    state,
    getTargetsFromMouseEvent,
    clearObjectSelection: (statusMessage = null) =>
      clearObjectSelectionImpl(state, setStatusMessage, statusMessage),
    setMatchStage: (stage) => setMatchStageImpl(state, stage),
    setStatusMessage,
    render,
  });
}

function handleSceneLeftClick(event) {
  handleSceneLeftClickInteraction({
    event,
    state,
    getTargetsFromMouseEvent,
    pushSelectedEdgeTarget: (target) => pushSelectedEdgeTargetImpl(state, target),
    pushSelectedVertexTarget: (target) => pushSelectedVertexTargetImpl(state, target),
    clearFaceSelection: (statusMessage = null) =>
      clearFaceSelectionImpl(state, setStatusMessage, statusMessage),
    pushSelectedFaceTarget: (target) => pushSelectedFaceTargetImpl(state, target),
    setStatusMessage,
    render,
  });
}

async function loadPiece(piece) {
  const pieceIndex = state.pieces.length;
  const pieceName = piece.name ?? `Piece ${pieceIndex + 1}`;
  const pieceColor = createRandomPieceColor();
  const loader = new STLLoader();
  const geometry = await loader.loadAsync(piece.file);
  const mesh = new THREE.Mesh(
    normalizeGeometry(geometry),
    new THREE.MeshStandardMaterial({ color: pieceColor, roughness: 0.5, metalness: 0.08 }),
  );
  const topology = extractMeshTopology(mesh.geometry, "stl");
  const collisionGeometry = mesh.geometry.clone();
  collisionGeometry.computeBoundingBox();
  const collisionBvh = new MeshBVH(collisionGeometry);
  const collisionMeshId = `collision-${pieceName}`;
  sceneRuntime.collisionCaches.set(collisionMeshId, {
    localBounds: collisionGeometry.boundingBox.clone(),
    bvh: collisionBvh,
    geometry: collisionGeometry,
  });
  const topologyGroups = buildTopologyGroups(topology);
  const topologyInteractionRoot = createTopologyInteractionRoot(pieceName, topology);
  mesh.add(topologyInteractionRoot);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.userData.pieceName = pieceName;
  if (piece.scale) {
    mesh.scale.setScalar(piece.scale);
  }

  return {
    name: pieceName,
    file: piece.file,
    geometry: mesh.geometry,
    topology,
    topologyGroups,
    collisionMeshId,
    initialPosition: {
      x: piece.initialPosition?.x ?? 0,
      y: piece.initialPosition?.y ?? 0,
      z: piece.initialPosition?.z ?? 0,
    },
    position: {
      x: piece.initialPosition?.x ?? 0,
      y: piece.initialPosition?.y ?? 0,
      z: piece.initialPosition?.z ?? 0,
    },
    color: `#${pieceColor.getHexString()}`,
    orientation: piece.orientation ?? 0,
    rotationQuaternion: {
      x: 0,
      y: 0,
      z: 0,
      w: 1,
    },
    size: measureMeshSize(mesh),
    rootObject: mesh,
  };
}

async function safeLoadPiece(piece, pieceIndex) {
  try {
    return await loadPiece(piece);
  } catch (error) {
    const pieceLabel = piece?.name ?? `Piece ${pieceIndex + 1}`;
    const reason = formatErrorMessage(error, "piece load failed");
    console.error(`[LoadPieceFailed] ${pieceLabel}`, error);
    setStatusMessage(`Skipped ${pieceLabel}: ${reason}`);
    return null;
  }
}

async function loadAndRenderPuzzle() {
  try {
    state.loadStatus = "Pending";
    state.selectedPieceName = null;
    state.selectedFaceTargets = [];
    state.selectedEdgeTargets = [];
    state.selectedVertexTargets = [];
    state.matchStage = "face";
    state.selectionOrderCounter = 0;
    state.hoveredPieceName = null;
    state.selectedTarget = null;
    state.hoveredTarget = null;
    state.isAnimating = false;
    if (sceneRuntime.activeAnimationFrame !== null) {
      cancelAnimationFrame(sceneRuntime.activeAnimationFrame);
      sceneRuntime.activeAnimationFrame = null;
    }
    setStatusMessage("Loading sample assets...");

    state.puzzle = SAMPLE_PUZZLE_MANIFEST;
    state.pieces = [];
    sceneRuntime.collisionCaches.clear();
    const loadErrors = [];
    for (let pieceIndex = 0; pieceIndex < state.puzzle.pieces.length; pieceIndex += 1) {
      const piece = state.puzzle.pieces[pieceIndex];
      const loadedPiece = await safeLoadPiece(piece, pieceIndex);
      if (!loadedPiece) {
        loadErrors.push(piece?.name ?? `Piece ${pieceIndex + 1}`);
        continue;
      }
      state.pieces.push(loadedPiece);
    }
    applyLoadSpacing(state.pieces);
    if (state.pieces.length === 0) {
      state.loadStatus = "Failed";
      setStatusMessage("All pieces failed to load. See console for details.");
      render();
      return;
    }
    if (loadErrors.length > 0) {
      state.loadStatus = "Loaded";
      setStatusMessage(`Loaded ${state.pieces.length}/${state.puzzle.pieces.length} pieces (some skipped)`);
      console.warn("[LoadPuzzlePartialFailure] Skipped pieces:", loadErrors);
      render();
      return;
    }
    state.loadStatus = "Loaded";
    setStatusMessage("Sample assets loaded");

    render();
  } catch (error) {
    state.loadStatus = "Failed";
    setStatusMessage(formatErrorMessage(error, "Load failed"));
    renderStatus();
  }
}

function render() {
  elements.puzzleTitle.textContent = state.puzzle?.title ?? "Loading sample assets...";
  sceneBootstrap.ensureScene();
  syncPieceObjects();
  sceneBootstrap.resizeRenderer();
  sceneBootstrap.renderThreeScene();
  renderPieceList();
  renderInspector();
  renderStatus();
}

const keyboardBindings = createKeyboardInputBindings({
  THREE,
  state,
  sceneRuntime,
  elements,
  findPieceByName: (pieceName) => state.pieces.find((piece) => piece.name === pieceName) ?? null,
});
sceneBootstrap.addFrameCallback((deltaSeconds) => {
  if (!keyboardBindings.update(deltaSeconds)) {
    return;
  }
  syncPieceObjects();
  renderInspector();
});

registerGlobalErrorHandlersImpl({
  state,
  setStatusMessage,
  formatErrorMessage,
  logger: console,
});
bindBootstrapEvents({
  elements,
  loadAndRenderPuzzle,
  runMatchFlow,
  clearAllSelections: (statusMessage = null) =>
    clearAllSelectionsImpl(state, setStatusMessage, statusMessage),
  render,
});
keyboardBindings.bind();
renderStatus();
loadAndRenderPuzzle().catch((error) => {
  state.loadStatus = "Failed";
  setStatusMessage(formatErrorMessage(error, "Initial load failed"));
  console.error("[InitialLoadFailed]", error);
});
