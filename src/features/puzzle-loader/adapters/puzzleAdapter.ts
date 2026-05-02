/**
 * Mesh topology extraction for loader adapters.
 *
 * Extension surface:
 * - Add new extractor functions to `topologyExtractors` keyed by mesh format.
 * - Keep return shape stable: { vertices, edges, faces }.
 */

const DEFAULT_EPSILON = 1e-5;
const DEFAULT_NORMAL_TOLERANCE = 1e-4;

function buildVertexKey(x, y, z, epsilon) {
  const qx = Math.round(x / epsilon);
  const qy = Math.round(y / epsilon);
  const qz = Math.round(z / epsilon);
  return `${qx}|${qy}|${qz}`;
}

function createEdgeKey(a, b) {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

function dotNormals(a, b) {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function computeFaceNormalAndArea(a, b, c) {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const abz = b.z - a.z;
  const acx = c.x - a.x;
  const acy = c.y - a.y;
  const acz = c.z - a.z;

  const nx = aby * acz - abz * acy;
  const ny = abz * acx - abx * acz;
  const nz = abx * acy - aby * acx;
  const crossLength = Math.sqrt(nx * nx + ny * ny + nz * nz);
  const area = 0.5 * crossLength;

  if (crossLength === 0) {
    return {
      normal: { x: 0, y: 0, z: 0 },
      area: 0,
    };
  }

  return {
    normal: {
      x: nx / crossLength,
      y: ny / crossLength,
      z: nz / crossLength,
    },
    area,
  };
}

function computePolygonNormalAndArea(vertices, vertexIndices) {
  let nx = 0;
  let ny = 0;
  let nz = 0;

  for (let i = 0; i < vertexIndices.length; i += 1) {
    const current = vertices[vertexIndices[i]];
    const next = vertices[vertexIndices[(i + 1) % vertexIndices.length]];
    nx += (current.y - next.y) * (current.z + next.z);
    ny += (current.z - next.z) * (current.x + next.x);
    nz += (current.x - next.x) * (current.y + next.y);
  }

  const normalLength = Math.sqrt(nx * nx + ny * ny + nz * nz);
  if (normalLength === 0) {
    return {
      normal: { x: 0, y: 0, z: 0 },
      area: 0,
    };
  }

  return {
    normal: {
      x: nx / normalLength,
      y: ny / normalLength,
      z: nz / normalLength,
    },
    area: 0.5 * normalLength,
  };
}

function computeMeshCentroid(vertices) {
  if (!vertices.length) {
    return null;
  }

  let sumX = 0;
  let sumY = 0;
  let sumZ = 0;
  for (const vertex of vertices) {
    sumX += vertex.x;
    sumY += vertex.y;
    sumZ += vertex.z;
  }

  return {
    x: sumX / vertices.length,
    y: sumY / vertices.length,
    z: sumZ / vertices.length,
  };
}

function computeFaceCentroid(vertices, vertexIndices) {
  if (!vertexIndices.length) {
    return null;
  }

  let sumX = 0;
  let sumY = 0;
  let sumZ = 0;
  for (const vertexIndex of vertexIndices) {
    const vertex = vertices[vertexIndex];
    if (!vertex) {
      return null;
    }
    sumX += vertex.x;
    sumY += vertex.y;
    sumZ += vertex.z;
  }

  return {
    x: sumX / vertexIndices.length,
    y: sumY / vertexIndices.length,
    z: sumZ / vertexIndices.length,
  };
}

function enforceOutwardFaceNormals(faces, vertices, epsilon) {
  const meshCentroid = computeMeshCentroid(vertices);
  if (!meshCentroid) {
    return faces;
  }

  const minDirectionLengthSq = epsilon * epsilon;
  for (const face of faces) {
    if (!face?.vertexIndices?.length) {
      continue;
    }

    const faceCentroid = computeFaceCentroid(vertices, face.vertexIndices);
    if (!faceCentroid) {
      continue;
    }

    const outwardX = faceCentroid.x - meshCentroid.x;
    const outwardY = faceCentroid.y - meshCentroid.y;
    const outwardZ = faceCentroid.z - meshCentroid.z;
    const outwardLengthSq = outwardX * outwardX + outwardY * outwardY + outwardZ * outwardZ;
    if (outwardLengthSq <= minDirectionLengthSq) {
      continue;
    }

    const alignment =
      (face.normal.x * outwardX) +
      (face.normal.y * outwardY) +
      (face.normal.z * outwardZ);
    if (alignment >= 0) {
      continue;
    }

    face.vertexIndices = [...face.vertexIndices].reverse();
    face.triangleVertexIndices = face.triangleVertexIndices.map(
      (triangle) => [triangle[0], triangle[2], triangle[1]],
    );
    face.normal = {
      x: -face.normal.x,
      y: -face.normal.y,
      z: -face.normal.z,
    };
  }

  return faces;
}

function createTriangleEdges(vertexIndices) {
  return [
    [vertexIndices[0], vertexIndices[1]],
    [vertexIndices[1], vertexIndices[2]],
    [vertexIndices[2], vertexIndices[0]],
  ];
}

function areTrianglesCoplanarAndParallel(first, second, vertices, epsilon, normalTolerance) {
  if (Math.abs(dotNormals(first.normal, second.normal)) < 1 - normalTolerance) {
    return false;
  }

  const firstPlanePoint = vertices[first.vertexIndices[0]];
  const secondPlanePoint = vertices[second.vertexIndices[0]];
  const firstPlaneOffset = dotNormals(first.normal, firstPlanePoint);
  const secondPointOffset = dotNormals(first.normal, secondPlanePoint);
  return Math.abs(firstPlaneOffset - secondPointOffset) <= epsilon;
}

function getMergeableTriangleNeighbors(triangle, triangles, triangleEdgeKeyToTriangleIndices, vertices, epsilon, normalTolerance) {
  const neighbors = new Set();

  for (const [vA, vB] of createTriangleEdges(triangle.vertexIndices)) {
    const edgeTriangles = triangleEdgeKeyToTriangleIndices.get(createEdgeKey(vA, vB)) ?? [];
    for (const triangleIndex of edgeTriangles) {
      if (triangleIndex === triangle.index) {
        continue;
      }

      const candidate = triangles[triangleIndex];
      if (areTrianglesCoplanarAndParallel(triangle, candidate, vertices, epsilon, normalTolerance)) {
        neighbors.add(triangleIndex);
      }
    }
  }

  return neighbors;
}

function findMergeableTriangleComponents(triangles, triangleEdgeKeyToTriangleIndices, vertices, epsilon, normalTolerance) {
  const visited = new Set();
  const components = new Array();

  for (const triangle of triangles) {
    if (visited.has(triangle.index)) {
      continue;
    }

    const component = new Array();
    const queue = [triangle.index];
    visited.add(triangle.index);

    while (queue.length > 0) {
      const currentIndex = queue.shift();
      const currentTriangle = triangles[currentIndex];
      component.push(currentIndex);

      const neighbors = getMergeableTriangleNeighbors(
        currentTriangle,
        triangles,
        triangleEdgeKeyToTriangleIndices,
        vertices,
        epsilon,
        normalTolerance,
      );

      for (const neighborIndex of neighbors) {
        if (!visited.has(neighborIndex)) {
          visited.add(neighborIndex);
          queue.push(neighborIndex);
        }
      }
    }

    components.push(component);
  }

  return components;
}

function orderBoundaryLoop(boundaryEdges) {
  if (boundaryEdges.length < 3) {
    return null;
  }

  const vertexToNeighbors = new Map();
  function addNeighbor(vertexIndex, neighborIndex) {
    const neighbors = vertexToNeighbors.get(vertexIndex) ?? new Array();
    neighbors.push(neighborIndex);
    vertexToNeighbors.set(vertexIndex, neighbors);
  }

  for (const [vA, vB] of boundaryEdges) {
    addNeighbor(vA, vB);
    addNeighbor(vB, vA);
  }

  for (const neighbors of vertexToNeighbors.values()) {
    if (neighbors.length !== 2) {
      return null;
    }
  }

  const start = Math.min(...vertexToNeighbors.keys());
  const startNeighbors = [...vertexToNeighbors.get(start)].sort((a, b) => a - b);
  const loop = [start];
  let previous = start;
  let current = startNeighbors[0];

  while (current !== start) {
    if (loop.includes(current)) {
      return null;
    }

    loop.push(current);
    const neighbors = vertexToNeighbors.get(current);
    const next = neighbors[0] === previous ? neighbors[1] : neighbors[0];
    previous = current;
    current = next;
  }

  return loop.length === vertexToNeighbors.size ? loop : null;
}

function getBoundaryLoopForComponent(component, triangles, triangleEdgeKeyToTriangleIndices) {
  const componentSet = new Set(component);
  const boundaryEdges = new Array();

  for (const triangleIndex of component) {
    const triangle = triangles[triangleIndex];
    for (const [vA, vB] of createTriangleEdges(triangle.vertexIndices)) {
      const edgeKey = createEdgeKey(vA, vB);
      const sameComponentUsers = triangleEdgeKeyToTriangleIndices
        .get(edgeKey)
        .filter((candidateIndex) => componentSet.has(candidateIndex));
      if (sameComponentUsers.length === 1) {
        boundaryEdges.push([vA, vB]);
      }
    }
  }

  return orderBoundaryLoop(boundaryEdges);
}

function createTriangleFace(triangle, vertices, faceIndex) {
  const normalAndArea = computePolygonNormalAndArea(vertices, triangle.vertexIndices);
  return {
    id: `f${faceIndex}`,
    vertexIndices: triangle.vertexIndices,
    edgeIndices: new Array(),
    triangleVertexIndices: [triangle.vertexIndices],
    normal: normalAndArea.normal,
    area: normalAndArea.area,
  };
}

function buildMergedFaces(triangles, triangleEdgeKeyToTriangleIndices, vertices, epsilon, normalTolerance) {
  const components = findMergeableTriangleComponents(
    triangles,
    triangleEdgeKeyToTriangleIndices,
    vertices,
    epsilon,
    normalTolerance,
  );
  const faces = new Array();

  for (const component of components) {
    const boundaryLoop = getBoundaryLoopForComponent(component, triangles, triangleEdgeKeyToTriangleIndices);
    if (!boundaryLoop) {
      for (const triangleIndex of component) {
        faces.push(createTriangleFace(triangles[triangleIndex], vertices, faces.length));
      }
      continue;
    }

    const normalAndArea = computePolygonNormalAndArea(vertices, boundaryLoop);
    faces.push({
      id: `f${faces.length}`,
      vertexIndices: boundaryLoop,
      edgeIndices: new Array(),
      triangleVertexIndices: component.map((triangleIndex) => triangles[triangleIndex].vertexIndices),
      normal: normalAndArea.normal,
      area: normalAndArea.area,
    });
  }

  return faces;
}

function buildEdgesFromFaces(faces) {
  const edgeKeyToEdge = new Map();

  faces.forEach((face, faceIndex) => {
    face.edgeIndices = [];

    for (let i = 0; i < face.vertexIndices.length; i += 1) {
      const vA = face.vertexIndices[i];
      const vB = face.vertexIndices[(i + 1) % face.vertexIndices.length];
      const key = createEdgeKey(vA, vB);
      let edge = edgeKeyToEdge.get(key);

      if (!edge) {
        edge = {
          index: edgeKeyToEdge.size,
          key,
          vA: Math.min(vA, vB),
          vB: Math.max(vA, vB),
          faceIndices: [],
        };
        edgeKeyToEdge.set(key, edge);
      }

      edge.faceIndices.push(faceIndex);
      face.edgeIndices.push(edge.index);
    }
  });

  return Array.from(edgeKeyToEdge.values())
    .sort((a, b) => a.index - b.index)
    .map((edge) => ({
      id: `e${edge.index}`,
      vertexIndices: [edge.vA, edge.vB],
      faceIndices: edge.faceIndices,
      isBoundary: edge.faceIndices.length === 1,
    }));
}

function extractTopologyFromStlGeometry(
  geometry,
  options = { epsilon: DEFAULT_EPSILON, normalTolerance: DEFAULT_NORMAL_TOLERANCE },
) {
  const epsilon = options.epsilon ?? DEFAULT_EPSILON;
  const normalTolerance = options.normalTolerance ?? DEFAULT_NORMAL_TOLERANCE;
  const position = geometry.getAttribute("position");
  if (!position) {
    throw new Error("Topology extraction failed: mesh has no position attribute");
  }

  const vertices = new Array();
  const vertexKeyToIndex = new Map();
  const triangles = new Array();
  const triangleEdgeKeyToTriangleIndices = new Map();

  function getOrCreateVertexIndex(x, y, z) {
    const key = buildVertexKey(x, y, z, epsilon);
    const existing = vertexKeyToIndex.get(key);
    if (existing !== undefined) {
      return existing;
    }

    const newIndex = vertices.length;
    vertices.push({
      id: `v${newIndex}`,
      x,
      y,
      z,
    });
    vertexKeyToIndex.set(key, newIndex);
    return newIndex;
  }

  for (let i = 0; i < position.count; i += 3) {
    const v0 = getOrCreateVertexIndex(position.getX(i), position.getY(i), position.getZ(i));
    const v1 = getOrCreateVertexIndex(position.getX(i + 1), position.getY(i + 1), position.getZ(i + 1));
    const v2 = getOrCreateVertexIndex(position.getX(i + 2), position.getY(i + 2), position.getZ(i + 2));

    if (v0 === v1 || v1 === v2 || v0 === v2) {
      continue;
    }

    const normalAndArea = computeFaceNormalAndArea(vertices[v0], vertices[v1], vertices[v2]);
    if (normalAndArea.area === 0) {
      continue;
    }

    const triangleIndex = triangles.length;
    const edgeKeys = createTriangleEdges([v0, v1, v2]).map(([vA, vB]) => createEdgeKey(vA, vB));
    const triangle = {
      index: triangleIndex,
      vertexIndices: [v0, v1, v2],
      edgeKeys,
      normal: normalAndArea.normal,
      area: normalAndArea.area,
    };
    triangles.push(triangle);

    for (const edgeKey of edgeKeys) {
      const users = triangleEdgeKeyToTriangleIndices.get(edgeKey) ?? [];
      users.push(triangleIndex);
      triangleEdgeKeyToTriangleIndices.set(edgeKey, users);
    }
  }

  const faces = buildMergedFaces(
    triangles,
    triangleEdgeKeyToTriangleIndices,
    vertices,
    epsilon,
    normalTolerance,
  );
  enforceOutwardFaceNormals(faces, vertices, epsilon);
  const edges = buildEdgesFromFaces(faces);

  return {
    vertices,
    edges,
    faces,
  };
}

const topologyExtractors = {
  stl: extractTopologyFromStlGeometry,
};

/**
 * Convert a loaded mesh geometry into a topology snapshot.
 *
 * Supported formats:
 * - `stl` (current)
 *
 * The returned object is format-agnostic and always includes:
 * - `vertices`: unique vertex list `{ id, x, y, z }`
 * - `edges`: undirected edge list `{ id, vertexIndices, faceIndices, isBoundary }`
 * - `faces`: polygon list `{ id, vertexIndices, edgeIndices, triangleVertexIndices, normal, area }`
 *
 * @param geometry Three.js `BufferGeometry` for the loaded piece.
 * @param meshFormat Source mesh format key (used to select extractor).
 * @param options Extractor options (STL uses `epsilon` vertex quantization).
 * @returns Topology payload with explicit adjacency:
 * - `vertices: Array<{ id, x, y, z }>`
 *   - One entry per deduplicated vertex in model space.
 *   - `id` is stable within this extraction (`v0`, `v1`, ...).
 *   - `x/y/z` are model-space coordinates from the loaded geometry.
 * - `edges: Array<{ id, vertexIndices, faceIndices, isBoundary }>`
 *   - Undirected unique edge list built from canonical vertex index pairs.
 *   - `vertexIndices` is `[a, b]` where `a < b`, both indexing into `vertices`.
 *   - `faceIndices` lists all faces that use this edge (indices into `faces`).
 *   - `isBoundary` is `true` when edge is used by exactly one face.
 * - `faces: Array<{ id, vertexIndices, edgeIndices, triangleVertexIndices, normal, area }>`
 *   - Polygon entries merged from adjacent coplanar STL triangles when possible.
 *   - `vertexIndices` is `[a, b, c, ...]` indexing into `vertices`.
 *   - `edgeIndices` is `[e0, e1, e2, ...]` indexing into `edges`.
 *   - `triangleVertexIndices` preserves the source triangle tessellation for rendering/picking.
 *   - `normal` is a unit vector (`{ x, y, z }`) computed from the polygon boundary.
 *   - `area` is polygon area in squared model units.
 * @throws {Error} If no extractor exists for `meshFormat`.
 */
export function extractMeshTopology(geometry, meshFormat = "stl", options = {}) {
  const extractor = topologyExtractors[meshFormat.toLowerCase()];
  if (!extractor) {
    throw new Error(`Topology extractor is not available for format: ${meshFormat}`);
  }
  return extractor(geometry, options);
}
