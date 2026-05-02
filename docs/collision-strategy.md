# Collision Strategy

## 1) UI designer view (what users experience)

- During drag/rotate, pieces move smoothly until a blocked state is reached.
- If a move causes penetration, motion is rejected immediately and the piece returns to last valid pose.
- Valid face contact is allowed (touching without overlap), enabling intentional "fit" behavior.
- Collision feedback is instant and readable (status pill/message + optional highlight of conflicting pieces).

## 2) Engineer view (how it works)

- Precompute once per piece: collision mesh, local `Box3`, and BVH (`three-mesh-bvh`), then cache.
- On each proposed transform, update `matrixWorld` and compute world AABB for broadphase pair pruning.
- For AABB-overlapping pairs, run BVH narrowphase (`intersectsGeometry`/`shapecast`) with relative transforms.
- Classify result with epsilon: `separated`, `touching`, or `penetrating`; short-circuit on first penetration.
- Validation pipeline per input step: predict transform -> broadphase -> BVH confirm -> accept or reject + surface collision pair.

## 3) SE(3) Collision-Free Path Planning

Function name: `planCollisionFreeSe3Path(...)`

Purpose: given a moving object, its current SE(3) transform, and a target SE(3) transform, compute a sequence of intermediate SE(3) transforms that moves the object to the target without penetrating any other object.

This function does not solve face alignment. Face/edge/vertex selection should happen upstream and produce the final `targetTransform`.

### Geometry Representation

- Use collision mesh + BVH as the source of truth for occupied space.
- Store per object:
  - immutable local-space collision mesh
  - local-space `Box3`
  - BVH built over the collision mesh
- Do not use vertex/edge/face topology as the primary collision representation.
  - Topology is useful for selection, target derivation, labels, and debug overlays.
  - Mesh/BVH is required for robust collision checks because it preserves all triangles and supports narrowphase queries.

### Input

```ts
type Se3Transform = {
  position: { x: number; y: number; z: number };
  rotation: { x: number; y: number; z: number; w: number };
};

type CollisionObjectSnapshot = {
  objectId: string;
  worldTransform: Se3Transform;
  collisionMeshId: string;
};

type CollisionSceneQuery = {
  getMovingObjectSnapshot(objectId: string): CollisionObjectSnapshot;
  getObstacleSnapshots(movingObjectId: string): CollisionObjectSnapshot[];
  getCollisionCache(collisionMeshId: string): {
    localBounds: Box3;
    bvh: MeshBVH;
    geometry: BufferGeometry;
  };
};

type PlanCollisionFreeSe3PathInput = {
  movingObjectId: string;
  startTransform: Se3Transform;
  targetTransform: Se3Transform;
  attachmentNormalWorld: { x: number; y: number; z: number };
  sceneQuery: CollisionSceneQuery;
  options?: {
    maxClearance?: number;
    minClearance?: number;
    translationStep?: number;
    rotationStepRadians?: number;
    collisionEpsilon?: number;
    maxLocalSegmentChecks?: number;
    clearancePadding?: number;
    maxStagingAttempts?: number;
    stagingClearanceScaleStep?: number;
    maxStagingClearanceFactor?: number;
  };
};
```

### Output

```ts
type PlanCollisionFreeSe3PathOutput =
  | {
      status: "found";
      transforms: Se3Transform[];
      stats: {
        iterations: number;
        collisionChecks: number;
        pathLength: number;
      };
    }
  | {
      status: "not-found";
      reason: "target-blocked" | "start-blocked" | "invalid-normal" | "staging-blocked" | "approach-blocked";
      bestAttempt?: Se3Transform;
      stats: {
        collisionChecks: number;
      };
    };
```

### Collision Check API

Function name: `classifyObjectAtTransform(...)`

```ts
type ClassifyObjectAtTransformInput = {
  movingObjectId: string;
  candidateTransform: Se3Transform;
  sceneQuery: CollisionSceneQuery;
  collisionEpsilon: number;
};

type ClassifyObjectAtTransformOutput = {
  status: "separated" | "touching" | "penetrating";
  firstHit?: {
    movingObjectId: string;
    obstacleObjectId: string;
  };
};
```

Steps:

1. Load the moving object's collision cache with `sceneQuery.getCollisionCache(...)`.
2. Transform its local `Box3` by `candidateTransform` to get a world AABB.
3. Ask `sceneQuery.getObstacleSnapshots(movingObjectId)` for all other object transforms.
4. For each obstacle:
  - load its collision cache
  - transform its local `Box3` by its current world transform
  - skip it if world AABBs do not overlap
  - run BVH narrowphase against the moving mesh using the relative transform
5. If BVH geometry intersects:
  - run micro-separation probes by nudging the moving transform in world `±X/±Y/±Z`
  - nudge distance: `max(collisionEpsilon * 8, 1e-4)`
  - if any probe resolves the intersection, return `touching`
  - if all probes still intersect, return `penetrating`
6. Return `separated` otherwise.

### Block Adhere Path Planner Steps

1. Validate start, target, and normal.
  - Normalize `attachmentNormalWorld` to get `n`.
  - If `n` has zero length, return `invalid-normal`.
  - Run `classifyObjectAtTransform(...)` for `startTransform`.
  - If penetrating, return `start-blocked`.
  - Run `classifyObjectAtTransform(...)` for `targetTransform`.
  - If penetrating, return `target-blocked`.
2. Compute final target pose.
  - The current MVP passes `targetTransform` as the absolute world pose `X_B*`.
  - If a future caller has a relative attachment transform `T`, compute `X_B* = X_A T` before calling the planner.
  - Extract `R*` and `p*` from `targetTransform`.
3. Compute staging clearance along the attachment normal.
  - Transform the moving block's local collision bounds by `targetTransform`.
  - Project that target box and all obstacle boxes onto `n`.
  - Pick `d_clear` so `minProjection(B* + d_clear n) > maxProjection(obstacles) + epsilon`.
  - Clamp/pad with `minClearance`, `maxClearance`, and `clearancePadding`.
4. Build the staging pose.
  - Use target orientation immediately: `R0 = R*`.
  - Place the moving block on the `+n` side: `p0 = p* + d_clear n`.
  - Staging pose is `(R*, p0)`.
5. Validate staging motion with adaptive retries.
  - Check the staging pose itself.
  - Sample the segment from `startTransform` to the staging pose.
  - If blocked, increase clearance distance along `+n` and retry staging.
  - Retry controls:
    - attempts bounded by `maxStagingAttempts`
    - per-attempt scaling by `stagingClearanceScaleStep`
    - absolute retry cap from `max(maxClearance, initialClearance) * maxStagingClearanceFactor`
  - If all retries fail, return `staging-blocked` with the last staging pose as `bestAttempt`.
6. Approach along the face normal only.
  - Sample the segment from staging pose to `targetTransform`.
  - This translation is along `-n`.
  - If any sample penetrates, return `approach-blocked` with the staging pose as `bestAttempt`.
7. Return the deterministic path.
  - Densify `[startTransform, stagingTransform, targetTransform]`.
  - Return those transforms for animation.

## 4) Face Match and Pose Derivation Strategy (Face -> Edge -> Vertex)

Goal: from user selections, derive a unique target SE(3) transform for the moving object so two faces can sit flush against each other without mirroring mistakes.

### Step 1: Face compatibility and candidate setup

Given selected `faceA` (fixed object) and `faceB` (moving object):

1. Build ordered boundary loops from face topology (`face.vertexIndices`) and fetch coordinates from `topology.vertices`.
   - topology normals are outward-normalized during STL->topology conversion (winding flips when needed).
2. Convert each face loop to a 2D local frame on its own plane.
3. Run orientation-sensitive polygon congruence:
  - same vertex count
  - same perimeter/area (within epsilon)
  - cyclic edge-length + signed-turn sequence match
4. No pre-opposite-normal gate is required at selection time:
  - selected faces may start with any normal directions
  - rotation solve later maps moving face normal to opposite fixed face normal.

### Step 2: Detect whether face-only alignment is unique (congruent branch)

Define an exact candidate correspondence search on cyclic face boundaries:

1. Let face boundary index sequences be:
  - `A = [a0, a1, ..., a(n-1)]`
  - `B = [b0, b1, ..., b(n-1)]`
2. Enumerate all cyclic shifts `k in [0, n-1]` on `B` (no reversal allowed).
3. For each shift `k`, test boundary invariants for all `i`:
  - `|lenA(i) - lenB((i+k) mod n)| <= epsLen`
  - `|turnA(i) - turnB((i+k) mod n)| <= epsAngle`
4. Keep every shift that passes all checks; call this set `K`.
5. Decision:
  - if `|K| == 0`: shapes are treated as non-congruent for correspondence solving
  - if `|K| == 1`: face-only alignment is unique
  - if `|K| > 1`: face-only alignment is ambiguous, require edge selection

This removes the placeholder and gives a deterministic ambiguity test.

### Step 3: If faces are not same shape, require edge first, then vertex

When faces are non-congruent (`area mismatch` or no valid cyclic candidate), the solver switches to constraint anchoring mode:

1. Request one edge on each selected face first.
2. Validate both selected edges lie on their corresponding selected faces.
3. Use face-normal alignment plus edge-direction alignment to fix orientation.
4. Then request one vertex on each selected face.
5. Validate both selected vertices lie on their corresponding selected faces.
6. Use the vertex pair as the final positional anchor.

Output of Step 3 is a deterministic orientation (from face+edge) plus exact position anchor (from vertex).

### Step 4: Ambiguity escalation chain

Constraint sequence (implemented):

1. face only
2. face + edge
3. face + edge + vertex

Exact escalation logic:

1. Build face candidates (Step 2) and compute `candidateCount`.
2. If faces are non-congruent (`candidateCount == 0` or area mismatch):
  - request edge pair first (`need-edge`)
  - after edges are provided, request vertex pair (`need-vertex`)
  - use a constrained fallback candidate for pose derivation (not cyclic candidate matching)
3. If faces are congruent and `candidateCount > 1`:
  - request edge pair (`need-edge`)
  - apply edge filter to reduce candidates
  - if still ambiguous, request vertex pair (`need-vertex`)
  - apply vertex filter and require exactly one remaining candidate
4. If faces are congruent and `candidateCount == 1`:
  - face-only solve is allowed.

### Step 5: Uniqueness rule

Use this uniqueness/validity contract:

- Congruent branch:
  - face only: valid only if candidate count is exactly `1`
  - face+edge: valid only if filtered candidate count is exactly `1`
  - face+edge+vertex: final disambiguation tier when needed
- Non-congruent branch:
  - edge pair is required before vertex pair
  - vertex pair is required before SE(3) emit
  - solver may emit pose without a cyclic face candidate, but only after valid edge+vertex constraints.

### Step 6: Compute SE(3) from selected constraints

Given either:
- a single surviving congruent candidate, or
- the non-congruent edge+vertex constrained fallback,
compute target pose as follows:

1. Convert `(face, edge, vertex)` to anchored oriented edge on each block:
  - selected vertex must be one endpoint of selected edge
  - define `p` as selected endpoint, `q` as the other endpoint, `d = q - p`
  - require:
    - `||d|| > eps`
    - `d · n_face ~= 0` (edge lies in face plane)
    - edge lengths match between fixed and moving selections.
2. Build local feature frames:
  - fixed frame `G_A = [u_A, y_A, z_A, p_A]` with
    - `u_A = normalize(q_A - p_A)`
    - `z_A = -n_A`
    - `y_A = normalize(z_A × u_A)`
  - moving frame `G_B = [u_B, y_B, z_B, p_B]` with
    - `u_B = normalize(q_B - p_B)`
    - `z_B = n_B`
    - `y_B = normalize(z_B × u_B)`.
3. Compute target world pose directly:
  - `X_B* = X_A * G_A * inverse(G_B)`.
4. If motion transform from current pose is needed:
  - `ΔX = X_B* * inverse(X_B_current)`.
5. Guarantees (when checks pass):
  - selected vertices overlap
  - selected edge segments overlap from the selected vertex
  - selected face normals become opposite.

Output: unique target `SE(3)` for `planCollisionFreeSe3Path(...)`.

### Debug Output Contract (Implemented)

`computeMatchTransform(...)` now returns a structured `debugChain` on all outcomes (`success`, `need-edge`, `need-vertex`, `failure`), including:

- selected face/edge/vertex inputs
- ordered decision trace through branch points
- face geometry and candidate counts before/after filters
- edge/vertex constraint mapping and on-face validation flags
- pose diagnostics (world normals, centroids, edge midpoints, anchor points, quaternions, final translation).

### Runtime Collision Notes (Current MVP)

- Scene-query collision classification is scale-aware:
  - world transform snapshots include `position`, `rotation`, and `scale`
  - candidate planner transforms inherit moving-object scale when omitted in intermediate planner nodes
- This prevents false-positive `start-blocked` caused by unit-scale collision transforms against scaled meshes.
- Contact classification includes a touching-vs-penetrating heuristic:
  - geometry intersection + resolvable micro-separation is treated as `touching` (allowed)
  - persistent intersection across probe directions remains `penetrating` (blocked).