# API Format Drafts

## Mesh To Topology Adapter (STL First, Extensible Interface)

Goal: when a piece mesh is loaded, persist a derived topology copy:

- `vertices`: unique points in model space
- `edges`: unique undirected connections between vertex pairs
- `faces`: triangle faces with vertex + edge references

### Public Adapter Interface

- Function: `extractMeshTopology(geometry, meshFormat = "stl", options = {})`
- Current format support: `stl`
- Extension seam: internal `topologyExtractors` map keyed by mesh format (`stl`, later `obj/gltf/ply/...`)

Return shape:

- `vertices[]`: `{ id, x, y, z }`
- `edges[]`: `{ id, vertexIndices: [a,b], faceIndices: [...], isBoundary }`
- `faces[]`: `{ id, vertexIndices: [a,b,c,...], edgeIndices: [e0,e1,e2,...], triangleVertexIndices, normal, area }`

### STL Conversion Algorithm

1. Read `position` buffer from `BufferGeometry`.
2. Quantize each raw vertex (`epsilon`, default `1e-5`) and dedupe into canonical vertices.
3. Walk triangles in groups of three indices from the position buffer.
4. Skip degenerate triangles (any repeated vertex index).
5. Convert valid triangles into an internal triangle graph:
   - each triangle stores canonical vertex indices, geometric normal, area, and plane reference
   - each undirected triangle edge stores the triangle indices that use it
6. Merge triangles into polygon faces:
   - two triangles are merge candidates only when they share an edge
   - candidate normals must be parallel within tolerance (`abs(dot(nA,nB)) ~= 1`)
   - candidate planes must be coincident within epsilon, preventing separate but parallel faces from merging
   - connected components of mergeable triangles become one polygon candidate
7. For each merged component:
   - remove internal shared edges
   - keep boundary edges used by exactly one triangle in the component
   - order the boundary into one closed vertex loop
   - emit one polygon face when the boundary is a simple loop
   - fall back to original triangle faces if the component has a non-simple boundary, branching boundary, or hole shape that cannot fit the current single-loop face contract
8. Normalize face orientation to outward-facing normals:
   - compute a mesh centroid from deduplicated vertices
   - compute each face centroid from its boundary loop
   - if `dot(face.normal, faceCentroid - meshCentroid) < 0`, flip face winding
   - flipping updates `vertexIndices`, `triangleVertexIndices`, and `normal`
9. Rebuild the final edge array from emitted polygon faces and mark boundary edges (`faceIndices.length === 1`).

### Polygon Face Rules

- `faces[].vertexIndices` may contain 3 or more vertices.
- `faces[].edgeIndices.length` always matches `faces[].vertexIndices.length`.
- Face vertices are ordered around the polygon boundary.
- `faces[].triangleVertexIndices` preserves the source STL triangles for exact rendering/picking, including concave polygon faces.
- `normal` and `area` are recomputed from the final polygon boundary, not copied from one source triangle.
- `normal` is normalized to outward-facing orientation relative to mesh centroid (for closed solids).
- Merging is local to connected triangle components; parallel disconnected surfaces remain separate faces.
- The current face contract intentionally represents one outer loop only. If a merged component would require holes or multiple loops, it is emitted as triangles until the schema grows a richer polygon representation.

### Why This Structure

- Stable IDs and index references make downstream matching/debugging deterministic.
- Quantization avoids duplicate vertices caused by STL floating-point noise.
- Face-edge adjacency supports future operations:
  - face selection
  - silhouette/feature extraction
  - manifold/boundary diagnostics

### Immediate Follow-Ups

- Add non-manifold edge flag (`faceIndices.length > 2`).
- Add optional vertex normals accumulation.
- Add format adapters behind same interface (`obj`, `ply`, `gltf`).

## Runtime Loading Mechanism (Component Groups)

The loader now converts mesh geometry into topology first, then builds grouped runtime components for interaction.

### Load Pipeline

1. Load raw STL geometry (`STLLoader`).
2. Normalize geometry to centered model space.
3. Run `extractMeshTopology(geometry, "stl")` to produce:
   - `vertices`
   - `edges`
   - `faces`
4. Build topology group payloads and attach to loaded piece:
   - `topologyGroups.vertexGroups`
   - `topologyGroups.edgeGroups`
   - `topologyGroups.faceGroups`
5. Build a pickable interaction subtree and attach it under the piece mesh:
   - face meshes
   - edge line segments
   - vertex markers
6. Add piece root object to scene as one unit so transform (position/orientation/scale) is shared by all topology components.

### Group Contracts

- `vertexGroups[]`:
  - `{ id, vertexId, vertexIndex, vertex }`
- `edgeGroups[]`:
  - `{ id, edgeId, edgeIndex, edge, vertices }`
  - `vertices` includes the two endpoint vertex records
- `faceGroups[]`:
  - `{ id, faceId, faceIndex, face, vertices, edges }`
  - includes all boundary vertices and surrounding edges for the face

### Selection/Picking Metadata

All runtime pickable components carry metadata in `userData`:

- `pieceName`
- `componentType` (`"face" | "edge" | "vertex"` for topology components; base piece mesh defaults to `"piece"`)
- `componentId`
- edge components additionally carry:
  - `localStart`: local-space edge endpoint
  - `localEnd`: local-space edge endpoint

This enables selection target resolution for piece, face, edge, and vertex interactions.

## Match Output + Debug Chain Contract

Function: `computeMatchTransform(...)`

Primary output statuses:

- `success`
- `need-edge`
- `need-vertex`
- `failure`

All statuses include a `debugChain` payload for full computation trace.

### Success Shape (runtime)

- `status: "success"`
- `movingPieceName`
- `fixedPieceName`
- `currentPoseWorld`: `{ position, rotation, scale }`
- `targetPoseWorld`: `{ position, rotation, scale }`
- `deltaTransformWorld`: `{ position, rotation, scale }` (`X_B* * inverse(X_B_current)`)
- `candidate`
- `debugChain`

### `debugChain` Structure

- `epsilons`: tolerance constants used in matching
- `selected`: normalized selected face/edge/vertex targets
- `decisions`: ordered list of branch decisions and outcomes
- `geometry`:
  - fixed/moving face ids
  - face areas and `areaDelta`
  - face vertex/edge index lists
  - candidate counts and candidate sets before/after filters
- `constraints`:
  - fixed/moving assignment for face/edge/vertex targets
  - resolved edge/vertex indices
  - on-face validity flags
- `poses` (on success):
  - `currentPoseWorld`
  - `targetPoseWorld`
  - `deltaTransformWorld`
  - pose computation internals:
    - anchored-edge checks (edge length equality, in-face checks)
    - fixed/moving local anchored feature frames (`G_A`, `G_B`)
    - fixed world pose matrix, moving current pose matrix, moving target pose matrix
    - delta transform matrix
    - residuals on selected vertex overlap and selected edge endpoint overlap

## Collision Classify Runtime Contract (MVP)

Scene-query `classifyObjectAtTransform(...)` statuses:

- `separated`
- `touching`
- `penetrating`

Current touching heuristic:

- broadphase uses epsilon-expanded world AABBs
- narrowphase uses BVH `intersectsGeometry(...)`
- when narrowphase intersects:
  - compute raw (non-expanded) world-AABB overlap depth on each axis
  - if minimum axis overlap <= `collisionEpsilon * 4`, classify as `touching`
  - otherwise classify as `penetrating`.