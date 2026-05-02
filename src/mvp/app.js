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

const GRID_WIDTH = 12;
const GRID_HEIGHT = 8;
const DEFAULT_COLLISION_EPSILON = 1e-5;
const EDGE_BASE_LINE_WIDTH_PX = 1.5;
const EDGE_SELECTED_WIDTH_MULTIPLIER = 3;
const EDGE_HOVER_WIDTH_MULTIPLIER = 1.6;
const EDGE_PICK_RADIUS_MULTIPLIER = 5;
const VERTEX_PICK_RADIUS_MULTIPLIER = 5;
const VERTEX_BASE_PICK_RADIUS_PX = 7;

const sceneRuntime = {
  scene: null,
  camera: null,
  renderer: null,
  controls: null,
  raycaster: new THREE.Raycaster(),
  pointer: new THREE.Vector2(),
  pieceObjects: new Map(),
  collisionCaches: new Map(),
  activeAnimationFrame: null,
};

const state = {
  puzzle: null,
  pieces: [],
  selectedPieceName: null,
  selectedFaceTargets: [],
  selectedEdgeTargets: [],
  selectedVertexTargets: [],
  matchStage: "face",
  selectionOrderCounter: 0,
  hoveredPieceName: null,
  selectedTarget: null,
  hoveredTarget: null,
  statusMessage: "Ready",
  loadStatus: "Pending",
  collisionStatus: "Clear",
  successStatus: "Incomplete",
  isAnimating: false,
};

const elements = {
  puzzleTitle: document.getElementById("puzzle-title"),
  reloadButton: document.getElementById("reload-button"),
  pieceCount: document.getElementById("piece-count"),
  selectedPieceName: document.getElementById("selected-piece-name"),
  pieceList: document.getElementById("piece-list"),
  scene: document.getElementById("scene"),
  selectionEmpty: document.getElementById("selection-empty"),
  selectionDetails: document.getElementById("selection-details"),
  inspectorName: document.getElementById("inspector-name"),
  coordOrientation: document.getElementById("coord-orientation"),
  matchButton: document.getElementById("match-button"),
  clearSelectionButton: document.getElementById("clear-selection-button"),
  controlsInfoButton: document.getElementById("controls-info-button"),
  controlsHelpModal: document.getElementById("controls-help-modal"),
  controlsHelpBackdrop: document.getElementById("controls-help-backdrop"),
  controlsHelpClose: document.getElementById("controls-help-close"),
  statusMessage: document.getElementById("status-message"),
  loadStatus: document.getElementById("load-status"),
  collisionStatus: document.getElementById("collision-status"),
  successStatus: document.getElementById("success-status"),
};

function getSelectedPiece() {
  return state.pieces.find((piece) => piece.name === state.selectedPieceName) ?? null;
}

function setStatusMessage(message) {
  state.statusMessage = message;
  renderStatus();
}

function formatErrorMessage(error, fallback = "Unknown error") {
  return error instanceof Error ? error.message : fallback;
}

function renderStatus() {
  elements.statusMessage.textContent = state.statusMessage;
  elements.loadStatus.textContent = `Load: ${state.loadStatus}`;
  elements.collisionStatus.textContent = `Collision: ${state.collisionStatus}`;
  elements.successStatus.textContent = `Success: ${state.successStatus}`;

  elements.loadStatus.className = `status-pill ${state.loadStatus === "Loaded" ? "is-success" : ""}`.trim();
  elements.collisionStatus.className = "status-pill is-success";
  elements.successStatus.className = "status-pill";
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
      renderThreeScene();
    });
    elements.pieceList.appendChild(item);
  });
}

function renderInspector() {
  const selectedPiece = getSelectedPiece();
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
        const isSelectedFace = isFaceTargetSelected(piece.name, componentId);
        const isHoveredFace = isTargetMatch(state.hoveredTarget, piece.name, "face", componentId);
        child.material.opacity = isSelectedFace ? 0.55 : isHoveredFace ? 0.28 : 0.08;
        child.material.color.set(isSelectedFace ? "#f08a5d" : isHoveredFace ? "#f2b28f" : "#5f81a8");
        return;
      }

      if (componentType === "edge" && child.material) {
        const isSelectedEdge = isEdgeTargetSelected(piece.name, componentId);
        const isHoveredEdge = isTargetMatch(state.hoveredTarget, piece.name, "edge", componentId);
        child.material.opacity = isSelectedEdge ? 1 : isHoveredEdge ? 0.85 : 0.35;
        child.material.color.set(isSelectedEdge ? "#f08a5d" : isHoveredEdge ? "#f2b28f" : "#2f241d");
        if (typeof child.material.linewidth === "number") {
          const widthMultiplier = isSelectedEdge ? EDGE_SELECTED_WIDTH_MULTIPLIER : isHoveredEdge ? EDGE_HOVER_WIDTH_MULTIPLIER : 1;
          child.material.linewidth = EDGE_BASE_LINE_WIDTH_PX * widthMultiplier;
        }
        return;
      }

      if (componentType === "vertex" && child.isMesh) {
        const isSelectedVertex = isVertexTargetSelected(piece.name, componentId);
        const isHoveredVertex = isTargetMatch(state.hoveredTarget, piece.name, "vertex", componentId);
        child.material.color.set(isSelectedVertex ? "#f08a5d" : isHoveredVertex ? "#f2b28f" : "#2f241d");
        child.material.emissive.set(isSelectedVertex ? "#7f2f12" : isHoveredVertex ? "#6d3d22" : "#000000");
        child.material.emissiveIntensity = isSelectedVertex || isHoveredVertex ? 0.45 : 0;
        return;
      }

      if (!child.isMesh) {
        return;
      }
      const isSelectedPiece = isTargetMatch(state.selectedTarget, piece.name, "piece", piece.name);
      const isHoveredPiece = isTargetMatch(state.hoveredTarget, piece.name, "piece", piece.name);
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

function resizeRenderer() {
  if (!sceneRuntime.renderer) {
    return;
  }

  const width = Math.max(elements.scene.clientWidth, 1);
  const height = Math.max(elements.scene.clientHeight, 1);
  sceneRuntime.camera.aspect = width / height;
  sceneRuntime.camera.updateProjectionMatrix();
  sceneRuntime.renderer.setSize(width, height, false);
  updateEdgeLineResolutions(width, height);
}

function updateEdgeLineResolutions(width, height) {
  for (const object of sceneRuntime.pieceObjects.values()) {
    object.traverse((child) => {
      if (child.userData?.componentType !== "edge") {
        return;
      }
      if (!child.material?.isLineMaterial) {
        return;
      }
      child.material.resolution.set(width, height);
    });
  }
}

function renderThreeScene() {
  if (!sceneRuntime.renderer) {
    return;
  }
  sceneRuntime.controls.update();
  sceneRuntime.renderer.render(sceneRuntime.scene, sceneRuntime.camera);
}

function renderLoop() {
  renderThreeScene();
  window.requestAnimationFrame(renderLoop);
}

function ensureScene() {
  if (sceneRuntime.renderer) {
    return;
  }

  const scene = new THREE.Scene();
  scene.background = new THREE.Color("#fbf5ec");

  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
  camera.position.set(8, 12, 12);

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  elements.scene.appendChild(renderer.domElement);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.target.set(0, 1.5, 0);
  sceneRuntime.raycaster.params.Line.threshold = 0.08;

  scene.add(new THREE.AmbientLight("#fff6eb", 1.3));
  const keyLight = new THREE.DirectionalLight("#ffffff", 1.1);
  keyLight.position.set(6, 12, 8);
  keyLight.castShadow = true;
  scene.add(keyLight);

  const fillLight = new THREE.DirectionalLight("#ffd8b8", 0.7);
  fillLight.position.set(-8, 6, -6);
  scene.add(fillLight);

  scene.add(new THREE.AxesHelper(4.5));

  sceneRuntime.scene = scene;
  sceneRuntime.camera = camera;
  sceneRuntime.renderer = renderer;
  sceneRuntime.controls = controls;

  renderer.domElement.addEventListener("pointermove", handleScenePointerMove);
  renderer.domElement.addEventListener("pointerleave", handleScenePointerLeave);
  renderer.domElement.addEventListener("click", handleSceneLeftClick);
  renderer.domElement.addEventListener("contextmenu", handleSceneContextMenu);

  window.addEventListener("resize", () => {
    resizeRenderer();
    renderThreeScene();
  });

  resizeRenderer();
  renderLoop();
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

function targetsAreEqual(first, second) {
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

function isTargetMatch(target, pieceName, componentType, componentId) {
  return (
    target?.pieceName === pieceName &&
    target?.componentType === componentType &&
    target?.componentId === componentId
  );
}

function isFaceTargetSelected(pieceName, componentId) {
  return state.selectedFaceTargets.some(
    (target) => target.pieceName === pieceName && target.componentType === "face" && target.componentId === componentId,
  );
}

function pushSelectedFaceTarget(target) {
  const withOrder = {
    ...target,
    selectedAt: ++state.selectionOrderCounter,
  };
  const filtered = state.selectedFaceTargets.filter(
    (entry) => !(entry.pieceName === target.pieceName && entry.componentId === target.componentId),
  );
  state.selectedFaceTargets = [...filtered, withOrder].slice(-2);
}

function isEdgeTargetSelected(pieceName, componentId) {
  return state.selectedEdgeTargets.some(
    (target) => target.pieceName === pieceName && target.componentType === "edge" && target.componentId === componentId,
  );
}

function pushSelectedEdgeTarget(target) {
  const withOrder = {
    ...target,
    selectedAt: ++state.selectionOrderCounter,
  };
  const filtered = state.selectedEdgeTargets.filter(
    (entry) => !(entry.pieceName === target.pieceName && entry.componentId === target.componentId),
  );
  state.selectedEdgeTargets = [...filtered, withOrder].slice(-2);
}

function isVertexTargetSelected(pieceName, componentId) {
  return state.selectedVertexTargets.some(
    (target) => target.pieceName === pieceName && target.componentType === "vertex" && target.componentId === componentId,
  );
}

function pushSelectedVertexTarget(target) {
  const withOrder = {
    ...target,
    selectedAt: ++state.selectionOrderCounter,
  };
  const filtered = state.selectedVertexTargets.filter(
    (entry) => !(entry.pieceName === target.pieceName && entry.componentId === target.componentId),
  );
  state.selectedVertexTargets = [...filtered, withOrder].slice(-2);
}

function clearHoverHighlight() {
  state.hoveredTarget = null;
  state.hoveredPieceName = null;
}

function clearObjectSelection(statusMessage = null) {
  state.selectedPieceName = null;
  state.selectedTarget = null;
  clearHoverHighlight();
  if (statusMessage) {
    setStatusMessage(statusMessage);
  }
}

function clearFaceSelection(statusMessage = null) {
  state.selectedFaceTargets = [];
  clearHoverHighlight();
  if (statusMessage) {
    setStatusMessage(statusMessage);
  }
}

function clearEdgeSelection(statusMessage = null) {
  state.selectedEdgeTargets = [];
  clearHoverHighlight();
  if (statusMessage) {
    setStatusMessage(statusMessage);
  }
}

function clearVertexSelection(statusMessage = null) {
  state.selectedVertexTargets = [];
  clearHoverHighlight();
  if (statusMessage) {
    setStatusMessage(statusMessage);
  }
}

function clearAllSelections(statusMessage = null) {
  state.selectedPieceName = null;
  state.selectedTarget = null;
  state.selectedFaceTargets = [];
  state.selectedEdgeTargets = [];
  state.selectedVertexTargets = [];
  state.matchStage = "face";
  clearHoverHighlight();
  if (statusMessage) {
    setStatusMessage(statusMessage);
  }
}

function clearMatchDisambiguationSelections() {
  state.selectedEdgeTargets = [];
  state.selectedVertexTargets = [];
  if (state.hoveredTarget?.componentType === "edge" || state.hoveredTarget?.componentType === "vertex") {
    clearHoverHighlight();
  }
}

function setMatchStage(stage) {
  state.matchStage = stage;
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

function buildPiecesByNameMap() {
  return Object.fromEntries(state.pieces.map((piece) => [piece.name, piece]));
}

function outputCurrentAndTargetWorldPose(matchResult) {
  const payload = {
    movingPiece: matchResult.movingPieceName,
    fixedPiece: matchResult.fixedPieceName,
    currentPoseWorld: matchResult.currentPoseWorld,
    targetPoseWorld: matchResult.targetPoseWorld,
    deltaTransformWorld: matchResult.deltaTransformWorld ?? null,
  };
  console.log("Match pose output", payload);
  setStatusMessage(`Match solved for ${matchResult.movingPieceName}. See console for world poses.`);
}

function logMatchComputationChain(matchResult) {
  console.groupCollapsed(`[Match] status=${matchResult.status}`);
  console.log("Match result output:", matchResult);
  console.log("Selected faces:", state.selectedFaceTargets);
  console.log("Selected edges:", state.selectedEdgeTargets);
  console.log("Selected vertices:", state.selectedVertexTargets);
  if (matchResult.currentPoseWorld || matchResult.targetPoseWorld) {
    console.log("Current pose world:", matchResult.currentPoseWorld ?? null);
    console.log("Target pose world:", matchResult.targetPoseWorld ?? null);
  }
  if (matchResult.debugChain) {
    console.log("Debug chain:", matchResult.debugChain);
  }
  console.groupEnd();
}

function getPieceByName(pieceName) {
  return state.pieces.find((piece) => piece.name === pieceName) ?? null;
}

function getPieceWorldTransform(piece) {
  if (!piece?.rootObject) {
    return null;
  }
  piece.rootObject.updateMatrixWorld(true);
  const position = new THREE.Vector3();
  const rotation = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  piece.rootObject.matrixWorld.decompose(position, rotation, scale);
  return {
    position: { x: position.x, y: position.y, z: position.z },
    rotation: { x: rotation.x, y: rotation.y, z: rotation.z, w: rotation.w },
    scale: { x: scale.x, y: scale.y, z: scale.z },
  };
}

function toMatrixFromPlannerTransform(transform) {
  const scale = transform.scale ?? { x: 1, y: 1, z: 1 };
  return new THREE.Matrix4().compose(
    new THREE.Vector3(transform.position.x, transform.position.y, transform.position.z),
    new THREE.Quaternion(transform.rotation.x, transform.rotation.y, transform.rotation.z, transform.rotation.w).normalize(),
    new THREE.Vector3(scale.x, scale.y, scale.z),
  );
}

function withScaleFromReference(transform, referenceTransform) {
  return {
    ...transform,
    scale: transform.scale ?? referenceTransform.scale ?? { x: 1, y: 1, z: 1 },
  };
}

function isLikelyTouchingContact({
  movingCache,
  obstacleCache,
  movingMatrix,
  obstacleMatrix,
  collisionEpsilon,
}) {
  const obstacleInverse = new THREE.Matrix4().copy(obstacleMatrix).invert();
  const nudgeDistance = Math.max(collisionEpsilon * 8, 1e-4);
  const nudgeDirections = [
    new THREE.Vector3(1, 0, 0),
    new THREE.Vector3(-1, 0, 0),
    new THREE.Vector3(0, 1, 0),
    new THREE.Vector3(0, -1, 0),
    new THREE.Vector3(0, 0, 1),
    new THREE.Vector3(0, 0, -1),
  ];

  for (const direction of nudgeDirections) {
    const shiftedMovingMatrix = new THREE.Matrix4()
      .makeTranslation(
        direction.x * nudgeDistance,
        direction.y * nudgeDistance,
        direction.z * nudgeDistance,
      )
      .multiply(movingMatrix);
    const shiftedMovingToObstacle = new THREE.Matrix4()
      .copy(obstacleInverse)
      .multiply(shiftedMovingMatrix);
    const stillIntersecting = obstacleCache.bvh.intersectsGeometry(
      movingCache.geometry,
      shiftedMovingToObstacle,
    );
    if (!stillIntersecting) {
      return true;
    }
  }

  return false;
}

function toPlannerTransformFromPiece(piece) {
  if (!piece) {
    return null;
  }
  const pieceScale = piece.rootObject?.scale ?? new THREE.Vector3(1, 1, 1);
  const rotation = piece.rotationQuaternion
    ? {
      x: piece.rotationQuaternion.x,
      y: piece.rotationQuaternion.y,
      z: piece.rotationQuaternion.z,
      w: piece.rotationQuaternion.w,
    }
    : new THREE.Quaternion().setFromEuler(
      new THREE.Euler(0, THREE.MathUtils.degToRad(piece.orientation ?? 0), 0, "YXZ"),
    );

  return {
    position: {
      x: piece.position.x - GRID_WIDTH / 2,
      y: piece.position.z,
      z: piece.position.y - GRID_HEIGHT / 2,
    },
    rotation: {
      x: rotation.x,
      y: rotation.y,
      z: rotation.z,
      w: rotation.w,
    },
    scale: {
      x: pieceScale.x,
      y: pieceScale.y,
      z: pieceScale.z,
    },
  };
}

function applyPlannerTransformToPiece(pieceName, transform) {
  const piece = getPieceByName(pieceName);
  if (!piece) {
    return;
  }
  piece.position = {
    x: transform.position.x + GRID_WIDTH / 2,
    y: transform.position.z + GRID_HEIGHT / 2,
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
}

function getCollisionSceneQuery() {
  const snapshots = state.pieces.map((piece) => {
    const worldTransform = toPlannerTransformFromPiece(piece);
    if (!worldTransform) {
      throw new Error(`Missing world transform for piece: ${piece.name}`);
    }
    return {
      objectId: piece.name,
      worldTransform,
      collisionMeshId: piece.collisionMeshId,
    };
  });
  const objectById = new Map(snapshots.map((snapshot) => [snapshot.objectId, snapshot]));

  return {
    getMovingObjectSnapshot(objectId) {
      const object = objectById.get(objectId);
      if (!object) {
        throw new Error(`Collision object is unavailable: ${objectId}`);
      }
      return object;
    },
    getObstacleSnapshots(objectId) {
      return snapshots.filter((snapshot) => snapshot.objectId !== objectId);
    },
    getCollisionCache(collisionMeshId) {
      const cache = sceneRuntime.collisionCaches.get(collisionMeshId);
      if (!cache) {
        throw new Error(`Collision cache is unavailable: ${collisionMeshId}`);
      }
      return cache;
    },
    classifyObjectAtTransform(input) {
      const movingObject = this.getMovingObjectSnapshot(input.movingObjectId);
      const movingCache = this.getCollisionCache(movingObject.collisionMeshId);
      const movingTransform = withScaleFromReference(input.candidateTransform, movingObject.worldTransform);
      const movingMatrix = toMatrixFromPlannerTransform(movingTransform);
      const movingBoundsRaw = movingCache.localBounds
        .clone()
        .applyMatrix4(movingMatrix);
      const movingBounds = movingBoundsRaw
        .clone()
        .expandByScalar(input.collisionEpsilon);

      for (const obstacle of this.getObstacleSnapshots(input.movingObjectId)) {
        const obstacleCache = this.getCollisionCache(obstacle.collisionMeshId);
        const obstacleMatrix = toMatrixFromPlannerTransform(obstacle.worldTransform);
        const obstacleBoundsRaw = obstacleCache.localBounds
          .clone()
          .applyMatrix4(obstacleMatrix);
        const obstacleBounds = obstacleBoundsRaw
          .clone()
          .expandByScalar(input.collisionEpsilon);

        if (!movingBounds.intersectsBox(obstacleBounds)) {
          continue;
        }

        const movingToObstacle = new THREE.Matrix4().copy(obstacleMatrix).invert().multiply(movingMatrix);
        if (obstacleCache.bvh.intersectsGeometry(movingCache.geometry, movingToObstacle)) {
          if (isLikelyTouchingContact({
            movingCache,
            obstacleCache,
            movingMatrix,
            obstacleMatrix,
            collisionEpsilon: input.collisionEpsilon,
          })) {
            return {
              status: "touching",
              firstHit: {
                movingObjectId: input.movingObjectId,
                obstacleObjectId: obstacle.objectId,
              },
            };
          }
          return {
            status: "penetrating",
            firstHit: {
              movingObjectId: input.movingObjectId,
              obstacleObjectId: obstacle.objectId,
            },
          };
        }
      }
      return { status: "separated" };
    },
  };
}

function buildCollisionDebugTrace(sceneQuery, movingObjectId, candidateTransform, collisionEpsilon = DEFAULT_COLLISION_EPSILON) {
  try {
    const movingObject = sceneQuery.getMovingObjectSnapshot(movingObjectId);
    const movingCache = sceneQuery.getCollisionCache(movingObject.collisionMeshId);
    const movingTransform = withScaleFromReference(candidateTransform, movingObject.worldTransform);
    const movingMatrix = toMatrixFromPlannerTransform(movingTransform);
    const movingBoundsRaw = movingCache.localBounds.clone().applyMatrix4(movingMatrix);
    const movingBounds = movingBoundsRaw.clone().expandByScalar(collisionEpsilon);

    const obstacleTraces = [];
    for (const obstacle of sceneQuery.getObstacleSnapshots(movingObjectId)) {
      const obstacleCache = sceneQuery.getCollisionCache(obstacle.collisionMeshId);
      const obstacleMatrix = toMatrixFromPlannerTransform(obstacle.worldTransform);
      const obstacleBoundsRaw = obstacleCache.localBounds.clone().applyMatrix4(obstacleMatrix);
      const obstacleBounds = obstacleBoundsRaw.clone().expandByScalar(collisionEpsilon);
      const broadphaseIntersects = movingBounds.intersectsBox(obstacleBounds);
      let narrowphaseIntersects = false;
      let contactStatus = "separated";

      if (broadphaseIntersects) {
        const movingToObstacle = new THREE.Matrix4().copy(obstacleMatrix).invert().multiply(movingMatrix);
        narrowphaseIntersects = obstacleCache.bvh.intersectsGeometry(movingCache.geometry, movingToObstacle);
        if (narrowphaseIntersects) {
          contactStatus = isLikelyTouchingContact({
            movingCache,
            obstacleCache,
            movingMatrix,
            obstacleMatrix,
            collisionEpsilon,
          })
            ? "touching"
            : "penetrating";
        }
      }

      obstacleTraces.push({
        obstacleObjectId: obstacle.objectId,
        obstacleTransform: obstacle.worldTransform,
        broadphaseIntersects,
        narrowphaseIntersects,
        contactStatus,
        movingBounds: {
          min: { x: movingBoundsRaw.min.x, y: movingBoundsRaw.min.y, z: movingBoundsRaw.min.z },
          max: { x: movingBoundsRaw.max.x, y: movingBoundsRaw.max.y, z: movingBoundsRaw.max.z },
        },
        obstacleBounds: {
          min: { x: obstacleBoundsRaw.min.x, y: obstacleBoundsRaw.min.y, z: obstacleBoundsRaw.min.z },
          max: { x: obstacleBoundsRaw.max.x, y: obstacleBoundsRaw.max.y, z: obstacleBoundsRaw.max.z },
        },
      });
    }

    const firstPenetrating = obstacleTraces.find((item) => item.contactStatus === "penetrating");
    return {
      movingObjectId,
      candidateTransform: movingTransform,
      collisionEpsilon,
      firstPenetratingObstacleId: firstPenetrating?.obstacleObjectId ?? null,
      obstacleTraces,
    };
  } catch (error) {
    return {
      movingObjectId,
      candidateTransform,
      collisionEpsilon,
      firstPenetratingObstacleId: null,
      obstacleTraces: [],
      error: formatErrorMessage(error, "Failed to build collision debug trace"),
    };
  }
}

function diagnoseStartBlocked(sceneQuery, movingObjectId, startTransform) {
  const trace = buildCollisionDebugTrace(
    sceneQuery,
    movingObjectId,
    startTransform,
    DEFAULT_COLLISION_EPSILON,
  );
  console.log("[Collision Debug] start-blocked trace:", trace);
  return {
    obstacleObjectId: trace.firstPenetratingObstacleId ?? null,
    trace,
  };
}

function animatePieceAlongPath(movingPieceName, transforms) {
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
      applyPlannerTransformToPiece(movingPieceName, waypoints[waypoints.length - 1]);
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

    applyPlannerTransformToPiece(movingPieceName, {
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

function runMatchFlow() {
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
    piecesByName: buildPiecesByNameMap(),
  });
  logMatchComputationChain(result);

  if (result.status === "success") {
    clearMatchDisambiguationSelections();
    setMatchStage("face");
    outputCurrentAndTargetWorldPose(result);
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
      setStatusMessage(error instanceof Error ? error.message : "Path planning failed");
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

function getTargetFromIntersection(intersection) {
  const pieceName = intersection?.object?.userData?.pieceName;
  if (!pieceName) {
    return null;
  }
  return {
    pieceName,
    componentType: intersection.object.userData.componentType ?? "piece",
    componentId: intersection.object.userData.componentId ?? pieceName,
  };
}

function findFirstPieceHit(hits) {
  for (const hit of hits) {
    const pieceName = hit?.object?.userData?.pieceName;
    if (!pieceName) {
      continue;
    }
    return {
      pieceName,
      componentType: "piece",
      componentId: pieceName,
    };
  }
  return null;
}

function findFirstFaceHitOnPiece(hits, pieceName) {
  for (const hit of hits) {
    if (hit?.object?.userData?.pieceName !== pieceName) {
      continue;
    }
    if (hit?.object?.userData?.componentType !== "face") {
      continue;
    }
    return {
      pieceName,
      componentType: "face",
      componentId: hit.object.userData.componentId,
    };
  }
  return null;
}

function findFirstEdgeHit(hits, pieceName = null) {
  for (const hit of hits) {
    if (pieceName && hit?.object?.userData?.pieceName !== pieceName) {
      continue;
    }
    if (hit?.object?.userData?.componentType !== "edge") {
      continue;
    }
    return {
      pieceName: hit.object.userData.pieceName,
      componentType: "edge",
      componentId: hit.object.userData.componentId,
    };
  }
  return null;
}

function findFirstVertexHit(hits, pieceName = null) {
  for (const hit of hits) {
    if (pieceName && hit?.object?.userData?.pieceName !== pieceName) {
      continue;
    }
    if (hit?.object?.userData?.componentType !== "vertex") {
      continue;
    }
    return {
      pieceName: hit.object.userData.pieceName,
      componentType: "vertex",
      componentId: hit.object.userData.componentId,
    };
  }
  return null;
}

function projectWorldPointToScreen(point, rect) {
  const projected = point.clone().project(sceneRuntime.camera);
  if (projected.z < -1 || projected.z > 1) {
    return null;
  }
  return {
    x: ((projected.x + 1) * 0.5) * rect.width + rect.left,
    y: ((1 - projected.y) * 0.5) * rect.height + rect.top,
    depth: projected.z,
  };
}

function distancePointToSegmentSquared(point, segmentStart, segmentEnd) {
  const sx = segmentEnd.x - segmentStart.x;
  const sy = segmentEnd.y - segmentStart.y;
  const segmentLengthSquared = sx * sx + sy * sy;
  if (segmentLengthSquared <= Number.EPSILON) {
    const dx = point.x - segmentStart.x;
    const dy = point.y - segmentStart.y;
    return dx * dx + dy * dy;
  }
  const t = THREE.MathUtils.clamp(
    ((point.x - segmentStart.x) * sx + (point.y - segmentStart.y) * sy) / segmentLengthSquared,
    0,
    1,
  );
  const closestX = segmentStart.x + t * sx;
  const closestY = segmentStart.y + t * sy;
  const dx = point.x - closestX;
  const dy = point.y - closestY;
  return dx * dx + dy * dy;
}

function findScreenSpaceEdgeTarget(event, pieceName = null) {
  if (!sceneRuntime.renderer || !sceneRuntime.camera) {
    return null;
  }
  const rect = sceneRuntime.renderer.domElement.getBoundingClientRect();
  const pointer = { x: event.clientX, y: event.clientY };
  const thresholdPx = EDGE_BASE_LINE_WIDTH_PX * EDGE_PICK_RADIUS_MULTIPLIER;
  const thresholdSquared = thresholdPx * thresholdPx;

  let best = null;
  for (const pieceObject of sceneRuntime.pieceObjects.values()) {
    pieceObject.traverse((child) => {
      if (child.userData?.componentType !== "edge") {
        return;
      }
      if (pieceName && child.userData.pieceName !== pieceName) {
        return;
      }

      const localStart = child.userData.localStart;
      const localEnd = child.userData.localEnd;
      if (!localStart || !localEnd) {
        return;
      }
      const worldStart = child.localToWorld(new THREE.Vector3(localStart.x, localStart.y, localStart.z));
      const worldEnd = child.localToWorld(new THREE.Vector3(localEnd.x, localEnd.y, localEnd.z));
      const screenStart = projectWorldPointToScreen(worldStart, rect);
      const screenEnd = projectWorldPointToScreen(worldEnd, rect);
      if (!screenStart || !screenEnd) {
        return;
      }
      const distanceSquared = distancePointToSegmentSquared(pointer, screenStart, screenEnd);
      if (distanceSquared > thresholdSquared) {
        return;
      }
      const depth = Math.min(screenStart.depth, screenEnd.depth);
      if (
        !best
        || distanceSquared < best.distanceSquared
        || (Math.abs(distanceSquared - best.distanceSquared) < 1e-4 && depth < best.depth)
      ) {
        best = {
          distanceSquared,
          depth,
          target: {
            pieceName: child.userData.pieceName,
            componentType: "edge",
            componentId: child.userData.componentId,
          },
        };
      }
    });
  }

  return best?.target ?? null;
}

function findScreenSpaceVertexTarget(event, pieceName = null) {
  if (!sceneRuntime.renderer || !sceneRuntime.camera) {
    return null;
  }
  const rect = sceneRuntime.renderer.domElement.getBoundingClientRect();
  const pointer = { x: event.clientX, y: event.clientY };
  const thresholdPx = VERTEX_BASE_PICK_RADIUS_PX * VERTEX_PICK_RADIUS_MULTIPLIER;
  const thresholdSquared = thresholdPx * thresholdPx;

  let best = null;
  for (const pieceObject of sceneRuntime.pieceObjects.values()) {
    pieceObject.traverse((child) => {
      if (child.userData?.componentType !== "vertex") {
        return;
      }
      if (pieceName && child.userData.pieceName !== pieceName) {
        return;
      }

      const worldPoint = child.getWorldPosition(new THREE.Vector3());
      const screenPoint = projectWorldPointToScreen(worldPoint, rect);
      if (!screenPoint) {
        return;
      }
      const dx = pointer.x - screenPoint.x;
      const dy = pointer.y - screenPoint.y;
      const distanceSquared = dx * dx + dy * dy;
      if (distanceSquared > thresholdSquared) {
        return;
      }
      if (
        !best
        || distanceSquared < best.distanceSquared
        || (Math.abs(distanceSquared - best.distanceSquared) < 1e-4 && screenPoint.depth < best.depth)
      ) {
        best = {
          distanceSquared,
          depth: screenPoint.depth,
          target: {
            pieceName: child.userData.pieceName,
            componentType: "vertex",
            componentId: child.userData.componentId,
          },
        };
      }
    });
  }

  return best?.target ?? null;
}

function createRandomPieceColor() {
  const hue = Math.random();
  const saturation = 0.45 + Math.random() * 0.3;
  const lightness = 0.45 + Math.random() * 0.2;
  return new THREE.Color().setHSL(hue, saturation, lightness);
}

function getTargetsFromMouseEvent(event) {
  if (!sceneRuntime.renderer || !sceneRuntime.camera) {
    return {
      pieceTarget: null,
      faceTargetOnSelectedPiece: null,
      edgeTargetOnSelectedPiece: null,
      vertexTargetOnSelectedPiece: null,
      edgeTargetAny: null,
      vertexTargetAny: null,
    };
  }

  const rect = sceneRuntime.renderer.domElement.getBoundingClientRect();
  sceneRuntime.pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  sceneRuntime.pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
  sceneRuntime.raycaster.setFromCamera(sceneRuntime.pointer, sceneRuntime.camera);

  const hits = sceneRuntime.raycaster.intersectObjects([...sceneRuntime.pieceObjects.values()], true);
  const edgeTargetAny = findScreenSpaceEdgeTarget(event);
  const vertexTargetAny = findScreenSpaceVertexTarget(event);
  return {
    pieceTarget: findFirstPieceHit(hits),
    faceTargetOnSelectedPiece: state.selectedPieceName ? findFirstFaceHitOnPiece(hits, state.selectedPieceName) : null,
    edgeTargetOnSelectedPiece: state.selectedPieceName ? findScreenSpaceEdgeTarget(event, state.selectedPieceName) : null,
    vertexTargetOnSelectedPiece: state.selectedPieceName ? findScreenSpaceVertexTarget(event, state.selectedPieceName) : null,
    edgeTargetAny,
    vertexTargetAny,
  };
}

function handleScenePointerMove(event) {
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

function handleScenePointerLeave() {
  if (!state.hoveredPieceName && !state.hoveredTarget) {
    return;
  }
  state.hoveredTarget = null;
  state.hoveredPieceName = null;
  syncPieceObjects();
  renderThreeScene();
}

function handleSceneContextMenu(event) {
  event.preventDefault();
  const { pieceTarget } = getTargetsFromMouseEvent(event);
  if (!pieceTarget) {
    clearObjectSelection("Object selection cleared");
    render();
    return;
  }

  state.matchStage = "face";
  state.selectedTarget = pieceTarget;
  state.selectedPieceName = pieceTarget.pieceName;
  setStatusMessage("Object selected");
  render();
}

function handleSceneLeftClick(event) {
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

function registerGlobalErrorHandlers() {
  window.addEventListener("error", (event) => {
    console.error("[GlobalError]", event.error ?? event.message);
    state.loadStatus = "Failed";
    setStatusMessage(`Runtime error: ${event.message}`);
  });
  window.addEventListener("unhandledrejection", (event) => {
    console.error("[UnhandledPromiseRejection]", event.reason);
    state.loadStatus = "Failed";
    setStatusMessage(`Unhandled promise: ${formatErrorMessage(event.reason, "unknown rejection")}`);
  });
}

function openControlsHelp() {
  elements.controlsHelpModal.classList.remove("hidden");
  elements.controlsInfoButton.setAttribute("aria-expanded", "true");
}

function closeControlsHelp() {
  elements.controlsHelpModal.classList.add("hidden");
  elements.controlsInfoButton.setAttribute("aria-expanded", "false");
}

function bindEvents() {
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

function render() {
  elements.puzzleTitle.textContent = state.puzzle?.title ?? "Loading sample assets...";
  ensureScene();
  syncPieceObjects();
  resizeRenderer();
  renderThreeScene();
  renderPieceList();
  renderInspector();
  renderStatus();
}

registerGlobalErrorHandlers();
bindEvents();
renderStatus();
loadAndRenderPuzzle().catch((error) => {
  state.loadStatus = "Failed";
  setStatusMessage(formatErrorMessage(error, "Initial load failed"));
  console.error("[InitialLoadFailed]", error);
});
