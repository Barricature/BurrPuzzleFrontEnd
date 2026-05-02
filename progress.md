## Update [2026-05-01]: Replaced RRT Planner With Block Adhere Path

- Updated `planCollisionFreeSe3Path(...)` in `src/features/physics/path-finding/collisionFreePath.ts` to use the Block Adhere algorithm instead of bidirectional RRT.
- New planner behavior:
  - accepts `attachmentNormalWorld`
  - validates start and target poses with the existing collision query
  - computes a staging pose at `targetPosition + d_clear * attachmentNormalWorld`
  - chooses `d_clear` from collision-bound projections along the normal, with min/max clearance and padding
  - validates the motion from start to staging
  - validates the final approach from staging to target along `-attachmentNormalWorld`
  - returns a deterministic densified path `[start, staging, target]`
- Updated `computeMatchTransform(...)` to return `attachmentNormalWorld` from the fixed face normal.
- Updated `runMatchFlow()` in `src/mvp/app.js` to pass `attachmentNormalWorld` into the planner.
- Updated `docs/collision-strategy.md` to describe the block-adhere planner inputs, failure reasons, clearance calculation, staging pose, and normal-only approach.
- Verification:
  - IDE lints are clean for `collisionFreePath.ts`, `computeTransform.ts`, `app.js`, and `collision-strategy.md`
  - `npm test` exits successfully, though the repo still has 0 tests

## Update [2026-05-01]: Replaced Match Transform With Rigid Face/Edge/Vertex Alignment

- Updated `computeMatchTransform(...)` / `computeTargetPose(...)` in `src/features/physics/path-finding/computeTransform.ts`.
- Replaced the previous normal-align + edge-twist + anchor-translation calculation with the explicit rigid alignment algorithm:
  - compute world-space face normals from selected face geometry
  - compute selected edge directions for fixed face A and moving face B
  - build orthonormal frames `F_A = [x_A, y_A, z_A]` and `F_B = [x_B, y_B, z_B]`
  - solve rotation as `R = F_A * F_B^T`
  - solve translation as `t = a0 - R*b0 + lambda*e_A`
  - compute `lambda` from the selected vertex overlap constraint
  - reject the solve when the perpendicular feasibility residual is above epsilon
- The match flow now requires one selected edge and one selected vertex on each selected face before solving.
- The edge direction sign ambiguity is handled by trying both fixed-edge directions and choosing the feasible candidate with the smallest residual.
- The transform is solved in current world space and then composed onto the moving piece's existing world matrix, preserving existing scale in the decomposed target pose.
- Debug output now records rigid-alignment residuals, selected world endpoints/vertices, transformed moving vertex/edge, and chosen edge sign.
- Verification:
  - IDE lints are clean for `computeTransform.ts`
  - `npm test` exits successfully, though the repo still has 0 tests

## Update [2026-04-30 22:00:22 -04:00]: Added Clear Selection Button

- Added a new `Clear Selection` button in `index.html` under the Match action section.
- Wired the button in `src/mvp/app.js` via `elements.clearSelectionButton` and a click handler.
- Implemented `clearAllSelections(...)` to clear all selection-related state in one action:
  - object selection (`selectedPieceName`, `selectedTarget`)
  - face/edge/vertex selections (`selectedFaceTargets`, `selectedEdgeTargets`, `selectedVertexTargets`)
  - hover highlights (`hoveredTarget`, `hoveredPieceName`)
  - match stage reset to `"face"`.
- Updated status text to `"All selections cleared"` and triggered `render()` after button click.
- Added styles for `#clear-selection-button` in `src/mvp/styles.css` so it is visually distinct from `Match`.

## Update [2026-04-30 22:06:27 -04:00]: Made Edge/Vertex Stage Empty Clicks Non-Destructive

- Updated `handleSceneLeftClick(...)` in `src/mvp/app.js` for `matchStage === "edge"` and `matchStage === "vertex"`.
- Empty-area left clicks in edge/vertex stages now do nothing (no selection arrays are cleared).
- This keeps already selected faces intact while collecting edge/vertex constraints.
- Clearing selections is now explicitly delegated to the `Clear Selection` button (`clearAllSelections(...)`).

## Update [2026-04-30 22:12:09 -04:00]: Non-Congruent Faces Now Require Edge First, Then Vertex

- Updated `computeMatchTransform(...)` in `src/features/physics/path-finding/computeTransform.ts`:
  - non-congruent face cases (`area mismatch` or `no face candidates`) now return `need-edge` first
  - after edges are set, it returns `need-vertex` to finalize correspondence.
- Added validation that selected edge/vertex constraints are provided one per selected piece and lie on the selected faces.
- Updated downstream pose computation (`computeTargetPose(...)`) so edge selection influences transform:
  - aligns face normals first
  - applies an additional twist around face normal to align selected edge directions (parallel/touching dimension)
  - uses edge midpoint anchoring for translation when vertex anchors are not yet applied.
- Preserved vertex overlap as the final precise anchor when vertices are selected.
- Fixed centroid world-point extraction to use vertex indices correctly for face-anchor calculations.

## Update [2026-04-30 22:47:38 -04:00]: Removed Opposite-Normal Precondition In Match

- Updated `computeMatchTransform(...)` in `src/features/physics/path-finding/computeTransform.ts` to remove the early failure:
  - `"Selected face normals are not opposite."`
- Rationale: face normals do not need to be pre-opposite at selection time; rotation solve can align them during pose derivation.
- Effect: Match now proceeds with candidate/constraint logic for any selected face normal directions.

## Update [2026-04-30 23:08:38 -04:00]: Improved Edge/Vertex Selection Usability

- Updated `src/mvp/app.js` to use stage-specific screen-space picking for thin components:
  - `findScreenSpaceEdgeTarget(...)`
  - `findScreenSpaceVertexTarget(...)`
  - both use projected cursor distance with enlarged thresholds.
- Implemented `5x` interaction area during edge/vertex selection stages:
  - edge threshold based on base edge thickness
  - vertex threshold based on base vertex pick radius.
- Upgraded edge rendering to `Line2`/`LineMaterial`/`LineGeometry` so width is controllable in pixels.
- Applied selected-edge visual emphasis:
  - selected edge width = `3x` base thickness
  - hover edge width uses an intermediate multiplier.
- Added line-material resolution synchronization on resize so edge thickness stays correct.
- Documented behavior in `docs/controls-spec.md` under Match and 2D-to-3D selection strategy.

## Update [2026-04-30 23:58:55 -04:00]: Clear Edge/Vertex Selections When Match Finishes

- Updated `runMatchFlow()` in `src/mvp/app.js` so edge/vertex disambiguation selections are cleared on terminal outcomes:
  - `success`
  - `failure`
- Added helper `clearMatchDisambiguationSelections()` to clear:
  - `selectedEdgeTargets`
  - `selectedVertexTargets`
  - edge/vertex hover highlight if currently active
- Match stage is reset to `"face"` on terminal failure as well, keeping stage lifecycle consistent after completion.

## Update [2026-05-01 00:04:21 -04:00]: Fixed Scale-Related Planner False Positive (`start-blocked`)

- Updated collision transform handling in `src/mvp/app.js` to preserve object world scale during planner collision classification.
- `getPieceWorldTransform(...)` now includes `scale` in the transform snapshot.
- `toPlannerTransformFromPiece(...)` now passes through position + rotation + scale.
- `toMatrixFromPlannerTransform(...)` now composes matrices with `transform.scale` (fallback `1,1,1`) instead of always forcing unit scale.
- Added `withScaleFromReference(...)` and applied it in `classifyObjectAtTransform(...)` so candidate transforms from planner keep the moving object's real scale.
- Expected effect: removes false-positive `Path planning failed: start-blocked` caused by collision checks using unit-scale transforms against scaled meshes.

## Update [2026-05-01 00:15:20 -04:00]: Added `start-blocked` Obstacle Diagnostics

- Updated `runMatchFlow()` in `src/mvp/app.js` to surface which obstacle triggers `start-blocked`.
- Added `diagnoseStartBlocked(...)` helper that re-runs classification at `currentPoseWorld` and reads `firstHit.obstacleObjectId`.
- Status message now reports:
  - `Path planning failed: start-blocked by <piece>`
  - instead of only the generic `start-blocked`.
- This enables direct verification whether the block is true overlap with a specific piece or a precision/contact false positive.

## Update [2026-05-01 22:10:18 -04:00]: Added Full Match Computation Chain Debug Output

- Extended `computeMatchTransform(...)` in `src/features/physics/path-finding/computeTransform.ts` to return a structured `debugChain` on all outcomes (`success`, `need-edge`, `need-vertex`, `failure`).
- `debugChain` now includes:
  - selected face/edge/vertex inputs
  - fixed vs moving assignment and per-piece target resolution
  - face geometry metadata (areas, indices, candidate counts)
  - decision trace through each stage
  - edge/vertex constraint validation results
  - computed pose diagnostics (face normals, centroids, edge midpoints, anchor points, quaternions, final translation)
- Added `logMatchComputationChain(...)` in `src/mvp/app.js` and call in `runMatchFlow()`:
  - logs full match output
  - logs selected targets
  - logs current/target world pose when available
  - logs `debugChain`.
- Added planner output logging:
  - `planCollisionFreeSe3Path(...)` result is now printed as `[Match Planner] ...` for end-to-end debugging.

## Update [2026-05-01 23:11:17 -04:00]: Synced Docs With Latest Runtime Behavior

- Updated `docs/collision-strategy.md`:
  - removed outdated pre-opposite-normal selection requirement
  - updated collision classify contract to current runtime statuses (`separated | penetrating`)
  - added implemented `debugChain` contract summary
  - documented scale-aware collision transform behavior used to avoid false `start-blocked`.
- Updated `docs/api-format-drafts.md`:
  - documented additional edge metadata (`localStart`, `localEnd`)
  - added `computeMatchTransform(...)` output contract with `debugChain` structure.
- Updated `docs/controls-spec.md`:
  - documented `Clear Selection` button behavior
  - documented terminal match cleanup for edge/vertex selections
  - documented non-destructive empty clicks during edge/vertex stages.

## Investigation [2026-05-01 23:34:32 -04:00]: `target-blocked` Despite Visually Clear Target

- Trace observation:
  - planner output is `{ status: "not-found", reason: "target-blocked", stats: { collisionChecks: 2, iterations: 0 } }`
  - this means start check passed, then target transform was immediately classified as penetrating before search begins.
- Code-level cause likely identified:
  - collision classifier currently has only two outcomes in practice: `penetrating` or `separated`
  - it uses `bvh.intersectsGeometry(...)` and treats any geometric intersection result as penetration
  - there is no implemented contact/touching branch even though earlier type docs mention it.
- Why this can look like a false positive:
  - matched faces are often intended to be flush (coplanar contact)
  - coplanar triangle contact/overlap can be reported as `intersectsGeometry === true`
  - classifier therefore labels face-touching targets as `penetrating`, producing `target-blocked`.
- Additional sensitivity factors:
  - broadphase boxes are expanded by `collisionEpsilon`, increasing candidate overlap checks
  - numeric noise around exact contact can tip a borderline touch into intersection.

Current conclusion: the `target-blocked` in this trace is consistent with missing separation between "touching allowed" and "penetrating disallowed" in narrowphase classification.

## Update [2026-05-01 23:36:52 -04:00]: Added Touching-vs-Penetrating Classification

- Implemented touching classification in runtime scene query (`src/mvp/app.js`):
  - classifier now computes raw (non-expanded) moving/obstacle world AABBs in addition to epsilon-expanded broadphase AABBs
  - on BVH intersection, it computes axis overlap depths (`x/y/z`)
  - if minimum axis overlap <= `collisionEpsilon * 4`, result is `touching`
  - otherwise result is `penetrating`.
- Implemented same classification logic in planner-side scene query helper in `src/features/physics/path-finding/collisionFreePath.ts` for consistency.
- Effect:
  - flush/near-contact face matches are treated as `touching` and remain path-valid
  - deeper overlaps remain blocked as `penetrating`.
- Documentation updated:
  - `docs/collision-strategy.md` collision classify API and steps now include touching heuristic
  - `docs/api-format-drafts.md` now includes collision classify runtime contract with touching logic.

## Update [2026-05-01 23:35:42 -04:00]: Switched To Anchored-Edge Target Pose Solve

- Updated `computeTargetPose(...)` in `src/features/physics/path-finding/computeTransform.ts` to use the anchored feature-frame formulation:
  - builds anchored oriented edge `(p -> q)` per block from selected edge + selected vertex
  - enforces exact-solution checks (`edge non-degenerate`, `edge-in-face`, `equal edge lengths`)
  - constructs local feature frames `G_A` and `G_B`
  - computes target pose via `X_B* = X_A * G_A * inverse(G_B)`.
- Added motion transform output:
  - `deltaTransformWorld = X_B* * inverse(X_B_current)`
  - included in success return and debug chain.
- Expanded pose debug payload:
  - local frame matrices
  - world pose matrices (fixed/current/target/delta)
  - endpoint overlap residuals for selected vertex and edge endpoint.
- Updated `src/mvp/app.js` match payload logging to include `deltaTransformWorld`.
- Updated docs to match implementation:
  - `docs/collision-strategy.md` Step 6 now documents anchored-frame equation and guarantees
  - `docs/api-format-drafts.md` success/debug contracts now include `deltaTransformWorld` and anchored-frame diagnostics.

## Investigation + Fix [2026-05-02 00:13:41 -04:00]: `start-blocked` False Positive On Visual Contact

- Investigated reported trace where planner returned:
  - `status: "not-found", reason: "start-blocked", collisionChecks: 1`
  - despite target/start looking visually non-penetrating.
- Root cause identified:
  - touching-vs-penetrating heuristic was based on raw AABB overlap depth
  - this is unreliable for rotated/contacting geometries because AABBs can overlap deeply even when mesh contact is only tangential.
- Implemented fix in both runtime and planner scene-query classifiers:
  - files:
    - `src/mvp/app.js`
    - `src/features/physics/path-finding/collisionFreePath.ts`
  - when BVH intersection is detected, classifier now performs a micro-separation probe:
    - nudge moving transform by a tiny distance in ±X/±Y/±Z (world)
    - if any nudge removes intersection, classify as `touching`
    - if all nudges still intersect, classify as `penetrating`
  - nudge magnitude: `max(collisionEpsilon * 8, 1e-4)`.
- Expected effect:
  - face-to-face/edge-to-edge contact states should no longer be misclassified as penetration as often
  - true embedded overlap remains blocked.

# Burr Puzzle Frontend - Done Work

## Current State

- Project has a runnable MVP vertical slice.
- App runs via local static server in `server.js` at `http://localhost:4173`.
- Primary runtime is `index.html` + `src/mvp/app.js` + `src/mvp/styles.css`.

## Completed Core MVP

- Implemented Three.js scene runtime in `src/mvp/app.js`:
  - `ensureScene()` initializes scene, camera, renderer, controls, and lighting.
  - `renderLoop()` + `renderThreeScene()` drive continuous viewport updates.
  - `syncPieceObjects()` applies current piece transforms and visual selection state.
- Implemented puzzle loading pipeline in MVP runtime:
  - puzzle/manifest load -> per-piece geometry load -> piece normalization -> state commit -> render.
  - runtime supports piece metadata + geometry + transform state as a single piece record.
- Implemented UI/state architecture:
  - centralized `state` object for puzzle, selection, and status values.
  - `elements` cache for DOM references to avoid repeated query lookups.
  - render split into list/inspector/status + scene sync for deterministic UI refresh.
- Implemented interaction loop:
  - viewport raycast selection and list selection are synchronized.
  - transform interactions (move/rotate) update state first, then rerender.
  - collision blocking and adjacency/success status are recalculated after transform attempts.

## Completed Topology + Loader Work

- Added `extractMeshTopology(...)` in `src/features/puzzle-loader/adapters/puzzleAdapter.ts`.
- Implemented STL topology extraction structure:
  - vertex deduplication via epsilon quantization.
  - canonical undirected edges with stable endpoint ordering.
  - face records with normal/area and edge adjacency references.
- Added polygon-face extraction stage:
  - connected coplanar triangle components are merged into polygon faces.
  - source triangle tessellation is preserved for rendering and picking fidelity.
  - non-simple boundaries fall back to triangle-face output.
- Updated emitted topology contracts:
  - final `edge.faceIndices` reference emitted final faces, not raw source triangles.
  - runtime-facing groups (`faceGroups`, `edgeGroups`, `vertexGroups`) are built from extracted topology.
- Added topology-driven runtime scene graph:
  - each piece now includes pickable face meshes, edge lines, and vertex markers under its piece root.

## Completed Interaction + Match Flow

- Implemented explicit multi-component selection model in `src/mvp/app.js`:
  - per-type selection targets for face/edge/vertex with deterministic ordering.
  - hover/selected highlight channels separated by component type.
- Implemented staged match workflow:
  - stage 1: face-based matching attempt.
  - stage 2: edge disambiguation when multiple face solutions remain.
  - stage 3: vertex disambiguation when edge constraints are still ambiguous.
- Implemented transform solving in `src/features/physics/path-finding/computeTransform.ts`:
  - cyclic face correspondence candidate generation.
  - constraint filtering by selected edge and vertex.
  - typed outputs (`success`, `need-edge`, `need-vertex`, `failure`).
- Added world-pose output contract:
  - emits moving object current pose and target pose in world frame for planner handoff.
- Synced selection-clearing UX:
  - clear actions now remove both state selection and corresponding highlight visuals.

## Completed Collision-Free Path Planning

- Added `planCollisionFreeSe3Path(...)` in `src/features/physics/path-finding/collisionFreePath.ts`.
- Implemented planner pipeline:
  - direct local path check using sampled translation interpolation + quaternion slerp.
  - bidirectional RRT fallback in SE(3) when direct path is blocked.
  - path reconstruction, shortcut smoothing, and waypoint densification for animation playback.
- Implemented typed planner I/O:
  - typed success/failure statuses with reason fields.
  - planner metrics (iterations/check counts) for debugging/tuning.
- Standardized math/runtime primitives:
  - migrated planner internals to `Vector3`, `Quaternion`, `Matrix4`, `Box3`.
  - introduced typed collision cache shape (`localBounds`, `bvh`, `geometry`).
- Added BVH-backed collision classification adapter (internal to planner module):
  - world AABB broadphase prune.
  - BVH narrowphase confirmation on candidate overlaps.

## Completed BVH Runtime Integration

- Added runtime deps:
  - `three`
  - `three-mesh-bvh`
- Implemented per-piece collision cache bootstrap in MVP runtime:
  - collision geometry clone for query use.
  - `MeshBVH` build and cache once per piece.
  - local `Box3` bounds cache for broadphase.
- Implemented runtime scene-query adapter compatible with planner API:
  - moving object snapshot generation from current state.
  - obstacle snapshot collection and cache lookup by collision mesh id.
  - transform classification path used by planner collision checks.
- Integrated match -> planning -> animation execution path:
  - match success triggers `planCollisionFreeSe3Path(...)`.
  - found path triggers transform-sequence animation and final state commit.
- Added quaternion-backed transform support in runtime state/rendering.
- Added animation lifecycle guards to prevent reentry and cancel active animation on reload.

## Completed Reliability + Startup Fixes

- Added error normalization for consistent status/error messaging.
- Added per-piece guarded loading (`safeLoadPiece(...)`) so one failed model no longer aborts full puzzle load.
- Added partial-failure handling: successfully loaded pieces continue rendering with skipped-count reporting.
- Added global runtime catchers (`window.error`, `window.unhandledrejection`) for visible failure reporting.
- Wrapped initial async load with explicit `.catch(...)` startup handling.
- Fixed BVH module loading path/specifier issues that blocked browser module resolution.

## Completed Docs/Spec Updates

- Updated `docs/controls-spec.md` with concise keyboard/mouse behavior and formatting.
- Updated `docs/collision-strategy.md` with UI-view + engineer-view collision pipeline.
- Updated `docs/api-format-drafts.md` with topology/polygon-face extraction contracts.
- Updated `README.md` with accurate install/run instructions for current MVP.

## Timestamped Updates

### Update [2026-04-30 21:37:52 -04:00]

- Added error normalization in `src/mvp/app.js` for consistent runtime status messages.
- Added `safeLoadPiece(...)` and per-piece guarded loading to prevent all-or-nothing load failure.
- Added partial-failure handling in `loadAndRenderPuzzle()` so successful pieces still render.
- Added global runtime catchers (`window.error`, `window.unhandledrejection`).
- Wrapped initial startup `loadAndRenderPuzzle()` with explicit `.catch(...)`.

### Update [2026-04-30 21:39:49 -04:00]

- Addressed runtime BVH CDN fetch failure by moving away from failing `esm.sh` path for `three-mesh-bvh`.

### Update [2026-04-30 21:49:53 -04:00]

- Resolved browser bare-specifier failure for `three-mesh-bvh` by switching to a relative source-module import path in `src/mvp/app.js`.

### Update [2026-04-30 21:52:01 -04:00]

- Refactored selection clearing into shared helpers:
  - `clearHoverHighlight()`
  - `clearObjectSelection(...)`
  - `clearFaceSelection(...)`
  - `clearEdgeSelection(...)`
  - `clearVertexSelection(...)`
- Synced `"... selection cleared"` status updates with corresponding highlight clearing behavior.

### Update [2026-05-02 00:30:29 -04:00]

- Implemented adaptive staging retry in `src/features/physics/path-finding/collisionFreePath.ts` to reduce false `staging-blocked` failures:
  - Added planner options:
    - `maxStagingAttempts` (default `6`)
    - `stagingClearanceScaleStep` (default `1.5`)
    - `maxStagingClearanceFactor` (default `4`)
  - Planner now retries staging with progressively larger clearance distance along `+attachmentNormalWorld`.
  - A retry succeeds only when both the staging pose and `start -> staging` segment are collision-free.
  - If all retries fail, planner still returns `not-found: staging-blocked` with the last staging attempt as `bestAttempt`.
- Rebuilt browser bundle:
  - `src/features/physics/path-finding/collisionFreePath.browser.js`.

### Update [2026-05-02 00:38:08 -04:00]

- Added detailed `start-blocked` diagnostics in `src/mvp/app.js`:
  - New helper `buildCollisionDebugTrace(...)` records per-obstacle collision pipeline data:
    - obstacle transform
    - broadphase AABB overlap result
    - BVH narrowphase intersection result
    - final contact classification (`separated` / `touching` / `penetrating`)
    - world-space moving/obstacle AABBs used for the test
  - `diagnoseStartBlocked(...)` now logs `[Collision Debug] start-blocked trace:` with the full trace object and returns the first penetrating obstacle id.
- Purpose: make `start-blocked by Piece X` verifiable with concrete runtime evidence when user-reported geometry should not collide.

### Update [2026-05-02 00:49:29 -04:00]

- Root-caused repeated `start-blocked` reports with trace evidence: all obstacle snapshots were showing the same world transform `(0,0,0)`, causing collision checks to run on artificially stacked pieces.
- Fixed planner snapshot transform source in `src/mvp/app.js`:
  - `toPlannerTransformFromPiece(...)` now derives planner transforms directly from the canonical piece state (`piece.position` + `piece.rotationQuaternion` + mesh scale), instead of reading `rootObject.matrixWorld`.
  - This removes dependence on render-time scene sync and prevents stale/zeroed object transforms from polluting collision queries.

### Update [2026-05-02 11:54:38 -04:00]

- Added outward-normal guarantee in STL topology conversion (`src/features/puzzle-loader/adapters/puzzleAdapter.ts`):
  - After merged faces are built, adapter now computes mesh centroid and each face centroid.
  - If a face normal points inward (`dot(face.normal, faceCentroid - meshCentroid) < 0`), it flips that face winding.
  - Winding flip updates:
    - `faces[].vertexIndices`
    - `faces[].triangleVertexIndices` (triangle winding reversed)
    - `faces[].normal` (sign flipped)
- This makes exported face normals consistent for downstream face-match orientation logic.
- Updated docs:
  - `docs/api-format-drafts.md` STL conversion steps + polygon rules now explicitly include outward-normal normalization.
  - `docs/collision-strategy.md` match setup notes now state that topology normals are outward-normalized during conversion.

### Update [2026-05-02 12:27:08 -04:00]

- Investigated target-translation offset in match outputs where posture was correct but world position appeared anchored near origin.
- Root cause:
  - `computeMatchTransform(...)` uses `piece.rootObject.matrixWorld` for world-space pose solve.
  - `runMatchFlow()` was calling match solve before forcing `rootObject` transforms to sync from canonical `piece.position` / `piece.rotationQuaternion`.
  - This allowed stale/identity `matrixWorld` values, so fixed/moving world poses were solved in the wrong frame origin.
- Fix in `src/mvp/app.js`:
  - Added `syncPieceObjects(); sceneRuntime.scene?.updateMatrixWorld(true);` immediately before `computeMatchTransform(...)` in `runMatchFlow()`.
  - This guarantees world-space face/edge/vertex data is read from up-to-date transforms during match target-pose computation.

