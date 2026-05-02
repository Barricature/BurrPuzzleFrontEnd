// @ts-nocheck
import * as THREE from "https://esm.sh/three@0.181.1";

const EPSILON_LENGTH = 1e-3;
const EPSILON_AREA = 1e-3;
const EPSILON_ANGLE = 1e-3;
const EPSILON_POSE = 1e-6;

function toPlainVector3(value) {
  return value ? { x: value.x, y: value.y, z: value.z } : null;
}

function toPlainQuaternion(value) {
  return value ? { x: value.x, y: value.y, z: value.z, w: value.w } : null;
}

function summarizeTarget(target) {
  if (!target) {
    return null;
  }
  return {
    pieceName: target.pieceName,
    componentType: target.componentType,
    componentId: target.componentId,
    selectedAt: target.selectedAt ?? null,
  };
}

function createDebugChain({ selectedFaces, selectedEdges, selectedVertices }) {
  return {
    epsilons: {
      length: EPSILON_LENGTH,
      area: EPSILON_AREA,
      angle: EPSILON_ANGLE,
    },
    selected: {
      faces: selectedFaces.map(summarizeTarget),
      edges: selectedEdges.map(summarizeTarget),
      vertices: selectedVertices.map(summarizeTarget),
    },
    decisions: [],
    geometry: {},
    constraints: {},
    poses: {},
  };
}

function finalizeMatchResult(result, debugChain) {
  return {
    ...result,
    debugChain,
  };
}

function getFaceById(piece, faceId) {
  return piece?.topology?.faces?.find((face) => face.id === faceId) ?? null;
}

function getEdgeById(piece, edgeId) {
  return piece?.topology?.edges?.find((edge) => edge.id === edgeId) ?? null;
}

function getVertexById(piece, vertexId) {
  return piece?.topology?.vertices?.find((vertex) => vertex.id === vertexId) ?? null;
}

function getVertexByIndex(piece, vertexIndex) {
  return piece?.topology?.vertices?.[vertexIndex] ?? null;
}

function getEdgeIndexById(piece, edgeId) {
  return piece?.topology?.edges?.findIndex((edge) => edge.id === edgeId) ?? -1;
}

function getVertexIndexById(piece, vertexId) {
  return piece?.topology?.vertices?.findIndex((vertex) => vertex.id === vertexId) ?? -1;
}

function getEdgeByIdOrNull(piece, edgeId) {
  return edgeId ? getEdgeById(piece, edgeId) : null;
}

function getVertexByIdOrNull(piece, vertexId) {
  return vertexId ? getVertexById(piece, vertexId) : null;
}

function getFaceBoundaryLengths(face, topology) {
  const vertices = face.vertexIndices.map((index) => topology.vertices[index]);
  const lengths = [];
  for (let i = 0; i < vertices.length; i += 1) {
    const current = vertices[i];
    const next = vertices[(i + 1) % vertices.length];
    const dx = next.x - current.x;
    const dy = next.y - current.y;
    const dz = next.z - current.z;
    lengths.push(Math.hypot(dx, dy, dz));
  }
  return lengths;
}

function getFaceSignedTurns(face, topology) {
  const vertices = face.vertexIndices.map((index) => topology.vertices[index]);
  const normal = new THREE.Vector3(face.normal.x, face.normal.y, face.normal.z).normalize();
  const turns = [];

  for (let i = 0; i < vertices.length; i += 1) {
    const prev = vertices[(i - 1 + vertices.length) % vertices.length];
    const current = vertices[i];
    const next = vertices[(i + 1) % vertices.length];

    const incoming = new THREE.Vector3(current.x - prev.x, current.y - prev.y, current.z - prev.z).normalize();
    const outgoing = new THREE.Vector3(next.x - current.x, next.y - current.y, next.z - current.z).normalize();

    const cross = new THREE.Vector3().crossVectors(incoming, outgoing);
    const sin = cross.dot(normal);
    const cos = THREE.MathUtils.clamp(incoming.dot(outgoing), -1, 1);
    turns.push(Math.atan2(sin, cos));
  }

  return turns;
}

function buildFaceCandidates(faceA, pieceA, faceB, pieceB) {
  const n = faceA.vertexIndices.length;
  if (n !== faceB.vertexIndices.length) {
    return [];
  }

  const lengthsA = getFaceBoundaryLengths(faceA, pieceA.topology);
  const lengthsB = getFaceBoundaryLengths(faceB, pieceB.topology);
  const turnsA = getFaceSignedTurns(faceA, pieceA.topology);
  const turnsB = getFaceSignedTurns(faceB, pieceB.topology);

  const candidates = [];
  for (let shift = 0; shift < n; shift += 1) {
    let ok = true;
    for (let i = 0; i < n; i += 1) {
      const j = (i + shift) % n;
      if (Math.abs(lengthsA[i] - lengthsB[j]) > EPSILON_LENGTH) {
        ok = false;
        break;
      }
      if (Math.abs(turnsA[i] - turnsB[j]) > EPSILON_ANGLE) {
        ok = false;
        break;
      }
    }
    if (ok) {
      candidates.push({ shift });
    }
  }

  return candidates;
}

function filterCandidatesByEdges(candidates, faceA, faceB, edgeAIndex, edgeBIndex) {
  if (edgeAIndex < 0 || edgeBIndex < 0) {
    return candidates;
  }
  const n = faceA.edgeIndices.length;
  return candidates.filter(({ shift }) => {
    for (let i = 0; i < n; i += 1) {
      const j = (i + shift) % n;
      const edgeA = faceA.edgeIndices[i];
      const edgeB = faceB.edgeIndices[j];
      if (edgeA === edgeAIndex && edgeB === edgeBIndex) {
        return true;
      }
    }
    return false;
  });
}

function filterCandidatesByVertices(candidates, faceA, faceB, vertexAIndex, vertexBIndex) {
  if (vertexAIndex < 0 || vertexBIndex < 0) {
    return candidates;
  }
  const n = faceA.vertexIndices.length;
  return candidates.filter(({ shift }) => {
    for (let i = 0; i < n; i += 1) {
      const j = (i + shift) % n;
      const vA = faceA.vertexIndices[i];
      const vB = faceB.vertexIndices[j];
      if (vA === vertexAIndex && vB === vertexBIndex) {
        return true;
      }
    }
    return false;
  });
}

function resolveSelectionByPiece(targets, firstPieceName, secondPieceName) {
  const first = targets.find((target) => target.pieceName === firstPieceName) ?? null;
  const second = targets.find((target) => target.pieceName === secondPieceName) ?? null;
  return [first, second];
}

function getWorldPointFromVertex(piece, vertexId) {
  const vertex = getVertexById(piece, vertexId);
  if (!vertex) {
    return null;
  }
  return new THREE.Vector3(vertex.x, vertex.y, vertex.z).applyMatrix4(piece.rootObject.matrixWorld);
}

function getWorldPointFromVertexIndex(piece, vertexIndex) {
  const vertex = getVertexByIndex(piece, vertexIndex);
  if (!vertex) {
    return null;
  }
  return new THREE.Vector3(vertex.x, vertex.y, vertex.z).applyMatrix4(piece.rootObject.matrixWorld);
}

function getWorldFaceNormalFromGeometry(piece, face) {
  const points = face.vertexIndices
    .map((vertexIndex) => getWorldPointFromVertexIndex(piece, vertexIndex))
    .filter(Boolean);
  if (points.length < 3) {
    return null;
  }

  const origin = points[0];
  for (let i = 1; i < points.length - 1; i += 1) {
    const first = points[i].clone().sub(origin);
    const second = points[i + 1].clone().sub(origin);
    const normal = new THREE.Vector3().crossVectors(first, second);
    if (normal.lengthSq() > EPSILON_AREA * EPSILON_AREA) {
      return normal.normalize();
    }
  }

  return null;
}

function getWorldFaceNormal(piece, face) {
  const geometricNormal = getWorldFaceNormalFromGeometry(piece, face);
  if (geometricNormal) {
    return geometricNormal;
  }

  const localNormal = new THREE.Vector3(face.normal.x, face.normal.y, face.normal.z).normalize();
  const normalMatrix = new THREE.Matrix3().getNormalMatrix(piece.rootObject.matrixWorld);
  return localNormal.applyMatrix3(normalMatrix).normalize();
}

function getWorldFaceCentroid(piece, face) {
  const points = face.vertexIndices
    .map((vertexIndex) => getWorldPointFromVertexIndex(piece, vertexIndex))
    .filter(Boolean);
  const centroid = new THREE.Vector3(0, 0, 0);
  points.forEach((point) => centroid.add(point));
  return points.length ? centroid.multiplyScalar(1 / points.length) : centroid;
}

function quaternionFromNormals(movingNormal, fixedNormal) {
  const targetNormal = fixedNormal.clone().negate();
  return new THREE.Quaternion().setFromUnitVectors(movingNormal, targetNormal);
}

function getLocalEdgeDirection(piece, edgeId) {
  const edge = getEdgeById(piece, edgeId);
  if (!edge) {
    return null;
  }
  const [aIndex, bIndex] = edge.vertexIndices;
  const a = getVertexByIndex(piece, aIndex);
  const b = getVertexByIndex(piece, bIndex);
  if (!a || !b) {
    return null;
  }
  const direction = new THREE.Vector3(b.x - a.x, b.y - a.y, b.z - a.z);
  return direction.lengthSq() > 0 ? direction.normalize() : null;
}

function getLocalEdgeMidpoint(piece, edgeId) {
  const edge = getEdgeById(piece, edgeId);
  if (!edge) {
    return null;
  }
  const [aIndex, bIndex] = edge.vertexIndices;
  const a = getVertexByIndex(piece, aIndex);
  const b = getVertexByIndex(piece, bIndex);
  if (!a || !b) {
    return null;
  }
  return new THREE.Vector3(
    (a.x + b.x) * 0.5,
    (a.y + b.y) * 0.5,
    (a.z + b.z) * 0.5,
  );
}

function getWorldEdgeMidpoint(piece, edgeId) {
  const localMidpoint = getLocalEdgeMidpoint(piece, edgeId);
  if (!localMidpoint) {
    return null;
  }
  return localMidpoint.applyMatrix4(piece.rootObject.matrixWorld);
}

function getWorldEdgeEndpoints(piece, edgeId) {
  const edge = getEdgeById(piece, edgeId);
  if (!edge) {
    return null;
  }

  const [aIndex, bIndex] = edge.vertexIndices;
  const a = getWorldPointFromVertexIndex(piece, aIndex);
  const b = getWorldPointFromVertexIndex(piece, bIndex);
  if (!a || !b) {
    return null;
  }

  return { a, b };
}

function makeUnitDirection(from, to) {
  const direction = to.clone().sub(from);
  return direction.lengthSq() > EPSILON_LENGTH * EPSILON_LENGTH ? direction.normalize() : null;
}

function projectUnitDirectionOntoPlane(direction, normal) {
  const projected = direction.clone().projectOnPlane(normal);
  return projected.lengthSq() > EPSILON_LENGTH * EPSILON_LENGTH ? projected.normalize() : null;
}

function buildFrameMatrix({ x, z }) {
  const zAxis = z.clone().normalize();
  const xAxis = projectUnitDirectionOntoPlane(x, zAxis);
  if (!xAxis) {
    return null;
  }

  const yAxis = new THREE.Vector3().crossVectors(zAxis, xAxis);
  if (yAxis.lengthSq() <= EPSILON_LENGTH * EPSILON_LENGTH) {
    return null;
  }
  yAxis.normalize();

  // Recompute x after y/z to remove small drift from non-perfect CAD data.
  xAxis.copy(new THREE.Vector3().crossVectors(yAxis, zAxis).normalize());
  return new THREE.Matrix4().makeBasis(xAxis, yAxis, zAxis);
}

function rotateVector(rotationMatrix, vector) {
  return vector.clone().applyMatrix4(rotationMatrix);
}

function alignMovingEdgeToFixedEdge({
  fixedPiece,
  movingPiece,
  fixedEdgeId,
  movingEdgeId,
  fixedNormal,
  tentativeQuat,
}) {
  if (!fixedEdgeId || !movingEdgeId) {
    return tentativeQuat.clone();
  }

  const fixedDirectionLocal = getLocalEdgeDirection(fixedPiece, fixedEdgeId);
  const movingDirectionLocal = getLocalEdgeDirection(movingPiece, movingEdgeId);
  if (!fixedDirectionLocal || !movingDirectionLocal) {
    return tentativeQuat.clone();
  }

  const fixedQuat = new THREE.Quaternion();
  const fixedPos = new THREE.Vector3();
  const fixedScale = new THREE.Vector3();
  fixedPiece.rootObject.matrixWorld.decompose(fixedPos, fixedQuat, fixedScale);
  const fixedDirectionWorld = fixedDirectionLocal.clone().applyQuaternion(fixedQuat).normalize();
  const movingDirectionWorld = movingDirectionLocal.clone().applyQuaternion(tentativeQuat).normalize();

  const axis = fixedNormal.clone().normalize();
  const movingPlanar = movingDirectionWorld.clone().projectOnPlane(axis).normalize();
  const fixedPlanar = fixedDirectionWorld.clone().projectOnPlane(axis).normalize();
  if (movingPlanar.lengthSq() === 0 || fixedPlanar.lengthSq() === 0) {
    return tentativeQuat.clone();
  }

  const angleTo = (target) => {
    const sin = axis.dot(new THREE.Vector3().crossVectors(movingPlanar, target));
    const cos = THREE.MathUtils.clamp(movingPlanar.dot(target), -1, 1);
    return Math.atan2(sin, cos);
  };

  const angleSame = angleTo(fixedPlanar);
  const angleOpposite = angleTo(fixedPlanar.clone().negate());
  const bestAngle = Math.abs(angleOpposite) < Math.abs(angleSame) ? angleOpposite : angleSame;
  const twist = new THREE.Quaternion().setFromAxisAngle(axis, bestAngle);
  return twist.multiply(tentativeQuat.clone()).normalize();
}

function toPoseFromWorldMatrix(matrix) {
  const position = new THREE.Vector3();
  const rotation = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  matrix.decompose(position, rotation, scale);
  return {
    position: { x: position.x, y: position.y, z: position.z },
    rotation: { x: rotation.x, y: rotation.y, z: rotation.z, w: rotation.w },
    scale: { x: scale.x, y: scale.y, z: scale.z },
  };
}

function toPlainMatrix4(matrix) {
  return Array.from(matrix.elements);
}

function buildAnchoredFeatureFrame({ anchor, otherEndpoint, zAxis }) {
  const d = otherEndpoint.clone().sub(anchor);
  const length = d.length();
  if (length <= EPSILON_LENGTH) {
    return { ok: false, reason: "Selected edge is degenerate." };
  }
  const u = d.clone().multiplyScalar(1 / length);
  const z = zAxis.clone().normalize();
  if (z.lengthSq() <= EPSILON_LENGTH * EPSILON_LENGTH) {
    return { ok: false, reason: "Selected face normal is degenerate." };
  }
  const y = new THREE.Vector3().crossVectors(z, u);
  if (y.lengthSq() <= EPSILON_LENGTH * EPSILON_LENGTH) {
    return { ok: false, reason: "Selected edge direction is parallel to selected face normal." };
  }
  y.normalize();
  const frame = new THREE.Matrix4().makeBasis(u, y, z);
  frame.setPosition(anchor);
  return { ok: true, frame, u, y, z, length, d };
}

function computeTargetPose({
  fixedPiece,
  movingPiece,
  fixedFace,
  movingFace,
  fixedVertexId,
  movingVertexId,
  fixedEdgeId,
  movingEdgeId,
}) {
  movingPiece.rootObject.updateMatrixWorld(true);
  fixedPiece.rootObject.updateMatrixWorld(true);
  const currentMatrix = movingPiece.rootObject.matrixWorld.clone();
  const currentMovingPose = toPoseFromWorldMatrix(currentMatrix);

  const fixedEdge = getEdgeByIdOrNull(fixedPiece, fixedEdgeId);
  const movingEdge = getEdgeByIdOrNull(movingPiece, movingEdgeId);
  const fixedVertex = getVertexByIdOrNull(fixedPiece, fixedVertexId);
  const movingVertex = getVertexByIdOrNull(movingPiece, movingVertexId);
  if (!fixedEdge || !movingEdge || !fixedVertex || !movingVertex) {
    return {
      status: "failure",
      reason: "Anchored-edge pose requires one selected edge and one selected vertex on each face.",
      currentPose: currentMovingPose,
    };
  }

  const [a0Index, a1Index] = fixedEdge.vertexIndices;
  const [b0Index, b1Index] = movingEdge.vertexIndices;
  const fixedA0 = getVertexByIndex(fixedPiece, a0Index);
  const fixedA1 = getVertexByIndex(fixedPiece, a1Index);
  const movingB0 = getVertexByIndex(movingPiece, b0Index);
  const movingB1 = getVertexByIndex(movingPiece, b1Index);
  if (!fixedA0 || !fixedA1 || !movingB0 || !movingB1) {
    return {
      status: "failure",
      reason: "Selected edge endpoints are missing in topology.",
      currentPose: currentMovingPose,
    };
  }

  const fixedVertexIsA0 = fixedVertex.id === fixedA0.id;
  const fixedVertexIsA1 = fixedVertex.id === fixedA1.id;
  const movingVertexIsB0 = movingVertex.id === movingB0.id;
  const movingVertexIsB1 = movingVertex.id === movingB1.id;
  if ((!fixedVertexIsA0 && !fixedVertexIsA1) || (!movingVertexIsB0 && !movingVertexIsB1)) {
    return {
      status: "failure",
      reason: "Selected vertex must be an endpoint of the selected edge.",
      currentPose: currentMovingPose,
    };
  }

  const pALocal = fixedVertexIsA0 ? fixedA0 : fixedA1;
  const qALocal = fixedVertexIsA0 ? fixedA1 : fixedA0;
  const pBLocal = movingVertexIsB0 ? movingB0 : movingB1;
  const qBLocal = movingVertexIsB0 ? movingB1 : movingB0;

  const pA = new THREE.Vector3(pALocal.x, pALocal.y, pALocal.z);
  const qA = new THREE.Vector3(qALocal.x, qALocal.y, qALocal.z);
  const pB = new THREE.Vector3(pBLocal.x, pBLocal.y, pBLocal.z);
  const qB = new THREE.Vector3(qBLocal.x, qBLocal.y, qBLocal.z);
  const dA = qA.clone().sub(pA);
  const dB = qB.clone().sub(pB);
  const lA = dA.length();
  const lB = dB.length();
  if (lA <= EPSILON_LENGTH || lB <= EPSILON_LENGTH) {
    return {
      status: "failure",
      reason: "Selected edge is degenerate.",
      currentPose: currentMovingPose,
    };
  }
  if (Math.abs(lA - lB) > EPSILON_LENGTH) {
    return {
      status: "failure",
      reason: "Selected edge lengths are not equal; exact anchored overlap is impossible.",
      currentPose: currentMovingPose,
    };
  }

  const nA = new THREE.Vector3(fixedFace.normal.x, fixedFace.normal.y, fixedFace.normal.z).normalize();
  const nB = new THREE.Vector3(movingFace.normal.x, movingFace.normal.y, movingFace.normal.z).normalize();
  const dotA = Math.abs(dA.dot(nA));
  const dotB = Math.abs(dB.dot(nB));
  if (dotA > EPSILON_LENGTH || dotB > EPSILON_LENGTH) {
    return {
      status: "failure",
      reason: "Selected edge must lie in selected face plane.",
      currentPose: currentMovingPose,
    };
  }

  const frameAResult = buildAnchoredFeatureFrame({
    anchor: pA,
    otherEndpoint: qA,
    zAxis: nA.clone().negate(),
  });
  if (!frameAResult.ok) {
    return { status: "failure", reason: frameAResult.reason, currentPose: currentMovingPose };
  }
  const frameBResult = buildAnchoredFeatureFrame({
    anchor: pB,
    otherEndpoint: qB,
    zAxis: nB.clone(),
  });
  if (!frameBResult.ok) {
    return { status: "failure", reason: frameBResult.reason, currentPose: currentMovingPose };
  }

  const XA = fixedPiece.rootObject.matrixWorld.clone();
  const XBStarMatrix = XA
    .clone()
    .multiply(frameAResult.frame)
    .multiply(new THREE.Matrix4().copy(frameBResult.frame).invert());
  const targetPose = toPoseFromWorldMatrix(XBStarMatrix);
  const deltaMatrix = XBStarMatrix.clone().multiply(new THREE.Matrix4().copy(currentMatrix).invert());
  const deltaTransformWorld = toPoseFromWorldMatrix(deltaMatrix);

  const pAWorld = pA.clone().applyMatrix4(XA);
  const pBWorldAtTarget = pB.clone().applyMatrix4(XBStarMatrix);
  const qAWorld = qA.clone().applyMatrix4(XA);
  const qBWorldAtTarget = qB.clone().applyMatrix4(XBStarMatrix);

  return {
    status: "success",
    currentPose: currentMovingPose,
    targetPose,
    deltaTransformWorld,
    debug: {
      mode: "anchored-edge-pose",
      checks: {
        edgeLengthFixed: lA,
        edgeLengthMoving: lB,
        edgeLengthDelta: Math.abs(lA - lB),
        edgeDotNormalFixed: dA.dot(nA),
        edgeDotNormalMoving: dB.dot(nB),
      },
      local: {
        fixed: {
          faceNormal: toPlainVector3(nA),
          p: toPlainVector3(pA),
          q: toPlainVector3(qA),
          frame: toPlainMatrix4(frameAResult.frame),
        },
        moving: {
          faceNormal: toPlainVector3(nB),
          p: toPlainVector3(pB),
          q: toPlainVector3(qB),
          frame: toPlainMatrix4(frameBResult.frame),
        },
      },
      world: {
        fixedFaceNormal: toPlainVector3(
          new THREE.Vector3(fixedFace.normal.x, fixedFace.normal.y, fixedFace.normal.z)
            .normalize()
            .applyMatrix3(new THREE.Matrix3().getNormalMatrix(XA)),
        ),
        movingFaceNormal: toPlainVector3(
          new THREE.Vector3(movingFace.normal.x, movingFace.normal.y, movingFace.normal.z)
            .normalize()
            .applyMatrix3(new THREE.Matrix3().getNormalMatrix(currentMatrix)),
        ),
        fixedPose: toPlainMatrix4(XA),
        movingCurrentPose: toPlainMatrix4(currentMatrix),
        movingTargetPose: toPlainMatrix4(XBStarMatrix),
        deltaTransform: toPlainMatrix4(deltaMatrix),
        fixedVertexAtTarget: toPlainVector3(pAWorld),
        movingVertexAtTarget: toPlainVector3(pBWorldAtTarget),
        fixedEdgeOtherAtTarget: toPlainVector3(qAWorld),
        movingEdgeOtherAtTarget: toPlainVector3(qBWorldAtTarget),
        vertexResidual: pAWorld.distanceTo(pBWorldAtTarget),
        edgeEndpointResidual: qAWorld.distanceTo(qBWorldAtTarget),
      },
    },
  };
}

export function computeMatchTransform({
  selectedFaces = [],
  selectedEdges = [],
  selectedVertices = [],
  piecesByName = {},
}) {
  const debugChain = createDebugChain({ selectedFaces, selectedEdges, selectedVertices });

  if (selectedFaces.length < 2) {
    debugChain.decisions.push("failure: selectedFaces.length < 2");
    return finalizeMatchResult({ status: "failure", reason: "Select two faces first." }, debugChain);
  }

  const [firstFaceTarget, secondFaceTarget] = selectedFaces;
  const fixedFaceTarget = firstFaceTarget.selectedAt <= secondFaceTarget.selectedAt ? firstFaceTarget : secondFaceTarget;
  const movingFaceTarget = fixedFaceTarget === firstFaceTarget ? secondFaceTarget : firstFaceTarget;
  debugChain.constraints.faceSelectionOrder = {
    fixedFaceTarget: summarizeTarget(fixedFaceTarget),
    movingFaceTarget: summarizeTarget(movingFaceTarget),
  };

  const fixedPiece = piecesByName[fixedFaceTarget.pieceName];
  const movingPiece = piecesByName[movingFaceTarget.pieceName];
  if (!fixedPiece || !movingPiece) {
    debugChain.decisions.push("failure: selected face piece missing");
    return finalizeMatchResult({ status: "failure", reason: "Selected faces reference unknown pieces." }, debugChain);
  }

  const fixedFace = getFaceById(fixedPiece, fixedFaceTarget.componentId);
  const movingFace = getFaceById(movingPiece, movingFaceTarget.componentId);
  if (!fixedFace || !movingFace) {
    debugChain.decisions.push("failure: selected face topology missing");
    return finalizeMatchResult({ status: "failure", reason: "Selected face is missing in topology." }, debugChain);
  }

  let candidates = buildFaceCandidates(fixedFace, fixedPiece, movingFace, movingPiece);
  const areaDelta = Math.abs((fixedFace.area ?? 0) - (movingFace.area ?? 0));
  const nonCongruentFacePair = areaDelta > EPSILON_AREA || !candidates.length;
  debugChain.geometry.faces = {
    fixedPiece: fixedPiece.name,
    movingPiece: movingPiece.name,
    fixedFaceId: fixedFace.id,
    movingFaceId: movingFace.id,
    fixedFaceArea: fixedFace.area ?? null,
    movingFaceArea: movingFace.area ?? null,
    areaDelta,
    fixedFaceVertexIndices: [...fixedFace.vertexIndices],
    movingFaceVertexIndices: [...movingFace.vertexIndices],
    fixedFaceEdgeIndices: [...fixedFace.edgeIndices],
    movingFaceEdgeIndices: [...movingFace.edgeIndices],
    initialCandidateCount: candidates.length,
    initialCandidates: candidates.map((candidate) => ({ ...candidate })),
    nonCongruentFacePair,
  };

  if (!candidates.length) {
    debugChain.decisions.push("non-congruent branch: no cyclic face candidates");
    if (selectedEdges.length < 2) {
      debugChain.decisions.push("need-edge: non-congruent requires edge anchors first");
      return finalizeMatchResult({
        status: "need-edge",
        reason: "Faces are not congruent; select one edge on each face.",
      }, debugChain);
    }
    if (selectedVertices.length < 2) {
      debugChain.decisions.push("need-vertex: edges provided, vertex anchors required for position");
      return finalizeMatchResult({
        status: "need-vertex",
        reason: "Faces+edges set orientation; select one vertex on each face to fix position.",
      }, debugChain);
    }
    candidates = [{ shift: 0, unconstrained: true }];
    debugChain.decisions.push("non-congruent fallback candidate injected");
  }

  if (candidates.length > 1 && selectedEdges.length < 2) {
    debugChain.decisions.push("need-edge: congruent but ambiguous face candidates");
    return finalizeMatchResult({
      status: "need-edge",
      reason: "Face match is ambiguous; select one edge on each face.",
      ambiguityCount: candidates.length,
    }, debugChain);
  }

  const [fixedEdgeTarget, movingEdgeTarget] = resolveSelectionByPiece(
    selectedEdges,
    fixedPiece.name,
    movingPiece.name,
  );
  debugChain.constraints.edgeSelection = {
    fixedEdgeTarget: summarizeTarget(fixedEdgeTarget),
    movingEdgeTarget: summarizeTarget(movingEdgeTarget),
  };
  if (selectedEdges.length >= 2 && (!fixedEdgeTarget || !movingEdgeTarget)) {
    debugChain.decisions.push("need-edge: edge selection not one-per-piece");
    return finalizeMatchResult({
      status: "need-edge",
      reason: "Select one edge on each selected face.",
    }, debugChain);
  }
  const fixedEdgeIndex = fixedEdgeTarget ? getEdgeIndexById(fixedPiece, fixedEdgeTarget.componentId) : -1;
  const movingEdgeIndex = movingEdgeTarget ? getEdgeIndexById(movingPiece, movingEdgeTarget.componentId) : -1;
  debugChain.constraints.edgeSelection.fixedEdgeIndex = fixedEdgeIndex;
  debugChain.constraints.edgeSelection.movingEdgeIndex = movingEdgeIndex;
  if (fixedEdgeTarget && movingEdgeTarget) {
    const fixedEdgeOnFace = fixedFace.edgeIndices.includes(fixedEdgeIndex);
    const movingEdgeOnFace = movingFace.edgeIndices.includes(movingEdgeIndex);
    debugChain.constraints.edgeSelection.fixedEdgeOnFace = fixedEdgeOnFace;
    debugChain.constraints.edgeSelection.movingEdgeOnFace = movingEdgeOnFace;
    if (!fixedEdgeOnFace || !movingEdgeOnFace) {
      debugChain.decisions.push("failure: selected edge is not on selected face");
      return finalizeMatchResult({
        status: "failure",
        reason: "Selected edges must lie on the selected faces.",
      }, debugChain);
    }
  }
  if (!fixedEdgeTarget || !movingEdgeTarget) {
    debugChain.decisions.push("need-edge: rigid face alignment requires one edge per selected face");
    return finalizeMatchResult({
      status: "need-edge",
      reason: "Select one edge on each selected face to align the face frames.",
    }, debugChain);
  }
  if (!nonCongruentFacePair) {
    candidates = filterCandidatesByEdges(candidates, fixedFace, movingFace, fixedEdgeIndex, movingEdgeIndex);
    debugChain.geometry.afterEdgeFilterCandidateCount = candidates.length;
    debugChain.geometry.afterEdgeFilterCandidates = candidates.map((candidate) => ({ ...candidate }));
  }

  if (candidates.length > 1 && selectedVertices.length < 2) {
    debugChain.decisions.push("need-vertex: still ambiguous after edge constraints");
    return finalizeMatchResult({
      status: "need-vertex",
      reason: "Face+edge still ambiguous; select one vertex on each side.",
      ambiguityCount: candidates.length,
    }, debugChain);
  }

  const [fixedVertexTarget, movingVertexTarget] = resolveSelectionByPiece(
    selectedVertices,
    fixedPiece.name,
    movingPiece.name,
  );
  debugChain.constraints.vertexSelection = {
    fixedVertexTarget: summarizeTarget(fixedVertexTarget),
    movingVertexTarget: summarizeTarget(movingVertexTarget),
  };
  if (selectedVertices.length >= 2 && (!fixedVertexTarget || !movingVertexTarget)) {
    debugChain.decisions.push("need-vertex: vertex selection not one-per-piece");
    return finalizeMatchResult({
      status: "need-vertex",
      reason: "Select one vertex on each selected face.",
    }, debugChain);
  }
  const fixedVertexIndex = fixedVertexTarget ? getVertexIndexById(fixedPiece, fixedVertexTarget.componentId) : -1;
  const movingVertexIndex = movingVertexTarget ? getVertexIndexById(movingPiece, movingVertexTarget.componentId) : -1;
  debugChain.constraints.vertexSelection.fixedVertexIndex = fixedVertexIndex;
  debugChain.constraints.vertexSelection.movingVertexIndex = movingVertexIndex;
  if (fixedVertexTarget && movingVertexTarget) {
    const fixedVertexOnFace = fixedFace.vertexIndices.includes(fixedVertexIndex);
    const movingVertexOnFace = movingFace.vertexIndices.includes(movingVertexIndex);
    debugChain.constraints.vertexSelection.fixedVertexOnFace = fixedVertexOnFace;
    debugChain.constraints.vertexSelection.movingVertexOnFace = movingVertexOnFace;
    if (!fixedVertexOnFace || !movingVertexOnFace) {
      debugChain.decisions.push("failure: selected vertex is not on selected face");
      return finalizeMatchResult({
        status: "failure",
        reason: "Selected vertices must lie on the selected faces.",
      }, debugChain);
    }
  }
  if (!fixedVertexTarget || !movingVertexTarget) {
    debugChain.decisions.push("need-vertex: rigid face alignment requires one vertex per selected face");
    return finalizeMatchResult({
      status: "need-vertex",
      reason: "Select one vertex on each selected face to fix the final overlap point.",
    }, debugChain);
  }
  if (!nonCongruentFacePair) {
    candidates = filterCandidatesByVertices(
      candidates,
      fixedFace,
      movingFace,
      fixedVertexIndex,
      movingVertexIndex,
    );
    debugChain.geometry.afterVertexFilterCandidateCount = candidates.length;
    debugChain.geometry.afterVertexFilterCandidates = candidates.map((candidate) => ({ ...candidate }));
  }

  if (candidates.length !== 1) {
    debugChain.decisions.push(
      `rigid-frame solve continues despite cyclic candidate count ${candidates.length}`,
    );
  }

  const poseResult = computeTargetPose({
    fixedPiece,
    movingPiece,
    fixedFace,
    movingFace,
    fixedVertexId: fixedVertexTarget?.componentId,
    movingVertexId: movingVertexTarget?.componentId,
    fixedEdgeId: fixedEdgeTarget?.componentId,
    movingEdgeId: movingEdgeTarget?.componentId,
  });
  if (poseResult.status === "failure") {
    debugChain.decisions.push(`failure: rigid frame solve failed: ${poseResult.reason}`);
    debugChain.poses = {
      fixedPieceName: fixedPiece.name,
      movingPieceName: movingPiece.name,
      currentPoseWorld: poseResult.currentPose,
      poseComputation: poseResult.debug,
    };
    return finalizeMatchResult({
      status: "failure",
      reason: poseResult.reason,
    }, debugChain);
  }
  debugChain.decisions.push("success: unique candidate and target pose resolved");
  debugChain.poses = {
    fixedPieceName: fixedPiece.name,
    movingPieceName: movingPiece.name,
    currentPoseWorld: poseResult.currentPose,
    targetPoseWorld: poseResult.targetPose,
    deltaTransformWorld: poseResult.deltaTransformWorld ?? null,
    poseComputation: poseResult.debug,
  };

  return finalizeMatchResult({
    status: "success",
    movingPieceName: movingPiece.name,
    fixedPieceName: fixedPiece.name,
    currentPoseWorld: poseResult.currentPose,
    targetPoseWorld: poseResult.targetPose,
    deltaTransformWorld: poseResult.deltaTransformWorld ?? null,
    attachmentNormalWorld: poseResult.debug.world.fixedFaceNormal,
    candidate: candidates[0] ?? { rigidFrameSolve: true },
  }, debugChain);
}
