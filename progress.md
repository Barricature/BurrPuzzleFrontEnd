## Update [2026-05-07]: Start-Tree Rotation Alignment Seed + Seed Diagnostics

- Symptom (from a `[Match Report]` after the previous strict-no-penetration
  change): CBiRRT exhausted its 2000 iteration budget with 6078 tree nodes
  and `bestAttempt.position = (15.69, 0.19, -4.73)` (very close to the
  matched target position `16.518, 0, -4`) but the bestAttempt rotation
  was `~47 degrees` away from the target rotation. The start tree had
  reached the target *position* neighbourhood but was wandering in
  rotation space and could not match the target orientation needed to
  connect with the goal tree.
- Root cause: with the disassembly seeds added on the goal tree only, the
  goal tree had several nodes at target rotation in free space but the
  start tree was rooted at identity rotation. Each `constrainedExtend`
  step interpolates translation+rotation jointly, so the start tree
  rotated incrementally toward random samples while it translated --
  intermediate poses had a partially-rotated bbox that frequently
  collided with neighbouring pieces. Effective search dimensionality was
  the full 6-DOF.
- Fix: added a dual seed on the start side in
  `src/features/physics/path-finding/cbirrt/planCBiRRT.ts`:
  - Build a "rotation alignment" pose at `(start.position, target.rotation)`.
  - Validate the rotate-in-place segment from `start` to that pose using
    `isSegmentCollisionFree(...)` -- the start position is typically far
    from any obstacle, so the rotation is almost always free.
  - When the segment is clear, attach the new pose as a direct child of
    the start root in `treeA`.
  - Skip the seed when start is already at target rotation
    (`transformDistance` below `connectionEpsilon`).
- Effect: extensions originating from the rotation-alignment node maintain
  the target rotation by construction (slerp between target rotation and a
  goal-tree node at target rotation stays at target rotation). The 6-DOF
  search collapses to a 3-DOF translation search through obstacle-free
  space, which RRT solves much faster.
- Added a `seedAcceptance` block to the planner stats for visibility:
  - `goalCandidates`, `goalAccepted`, `goalRejectedPenetrating`,
    `goalRejectedSegmentBlocked` for the disassembly seeds
  - `startRotationAlignmentAttempted`, `startRotationAlignmentAccepted`,
    `startRotationAlignmentReason` for the new alignment seed
  - These show up automatically in the consolidated `[Match Report]` under
    `planner.cbirrtFallback.stats.seedAcceptance` so failures (e.g. a seed
    that was rejected because the segment to/from it is blocked) are
    immediately visible without re-running.
- Bumped CBiRRT defaults to give the seeded planner room to finish:
  - `maxIterations`: `2000 -> 4000`
  - `maxPlanningTimeMs`: `1000 -> 2500`
  - `goalSampleProbability`: `0.10 -> 0.15` (slightly higher bias toward
    sampling existing goal-tree nodes, which are now mostly
    target-rotation poses thanks to the disassembly seeds)
- Combined with the previous "strict no-penetration + disassembly seeds"
  change, CBiRRT now has both: (a) target-rotation entry points in free
  space (goal tree) and (b) a target-rotation departure point at the
  start position (start tree). The remaining work for RRT is a 3-DOF
  translation search to bridge them, which is the natural shape of burr
  disassembly motion.

## Update [2026-05-07]: Strict No-Penetration + Disassembly-Axis Hints For CBiRRT

- Goal: never let any piece visually penetrate any other piece during a
  Match animation, including the matched fixed piece. Previously the match
  flow filtered the matched fixed piece out of the obstacle list because
  the old nudge-probe heuristic mis-classified face-flush contact as
  `penetrating`; the side effect was that any straight-line approach the
  planner picked would phase straight through the fixed piece during
  animation.
- Now that `classifyTriangleContact(...)` correctly classifies face-flush,
  edge-on-face, and vertex contacts as `touching`, the filter is no longer
  necessary and has been removed:
  - `runMatchFlowCoordinator` in `src/features/matching/matchFlow.js` now
    leaves `expectedContactObjectIds = []` always; both planners and the
    per-tick animation guard receive the unfiltered scene query.
  - The matched target pose still passes the planner's `target` collision
    check because the new classifier sees the matched-face triangle pairs
    as `touching`, not `penetrating`.
  - Any candidate path that would actually phase-through the fixed piece
    is now rejected, so the animation never lands on a penetrating frame.
- Side effect: Block Adhere's "stage along `+attachmentNormalWorld`,
  approach along `-n`" template does not match burr-style disassembly
  (where the only valid disassembly direction is the moving piece's long
  axis at target, perpendicular to the matched face normal). Block Adhere
  will now report `staging-blocked` / `approach-blocked` for these cases
  and fall through to the CBiRRT planner.
- Added disassembly-axis hints for CBiRRT in
  `src/features/matching/matchFlow.js`:
  - `getLocalLongAxisAndSize(piece)` reads `piece.size`
    (`{ width, depth, height }`, the world-space load-time bbox at
    identity rotation) to identify the moving piece's longest local axis.
  - `rotateVecByQuat(...)` (inlined to avoid pulling THREE into this
    module) rotates that local axis by the target rotation to get the
    disassembly axis in world space.
  - `computeDisassemblySeeds({ movingPiece, targetTransform })` builds two
    pre-assembly poses at `targetTransform.position +/- 2 * worldLongSize *
    disassemblyAxisWorld`, both at target rotation. They sit in free
    space well beyond the matched fixed piece in either direction along
    the slide axis.
  - These seeds are passed alongside Block Adhere's `bestAttempt` (when
    present) to `planCBiRRT(...)` as the `seedTransforms` argument.
- Updated CBiRRT seed handling in
  `src/features/physics/path-finding/cbirrt/planCBiRRT.ts`:
  - The goal tree is now initialized with target only as the root;
    user-supplied seeds are added as direct children of the target node,
    but only after their seed-to-target segment passes
    `isSegmentCollisionFree(...)`. This guarantees:
    - any returned path ends at the matched target pose (because tree-B
      path reconstruction traces parents back to the single target root),
      not at one of the seeds; and
    - the seed-to-target portion of the path is collision-free by
      construction, so the slide-in is animated with face-flush contact
      throughout (correctly classified as `touching`).
  - Penetrating seeds are silently dropped, as before.
- Updated `deriveSamplingBounds(...)` in
  `src/features/physics/path-finding/cbirrt/sampler.ts` to take an optional
  `extraTransforms` array. The CBiRRT bounds now include start, target,
  AND all candidate seed positions, so the sampling AABB extends to cover
  the disassembly seeds and CBiRRT can sample reachable random poses
  between start and the seeds.
- Net behavior:
  - Simple translation-only matches (e.g. peg-into-hole that aligns with
    the face normal): Block Adhere succeeds as before, animation strictly
    avoids all pieces.
  - Burr-style interlock matches: Block Adhere fails, CBiRRT picks up.
    The disassembly seeds give the planner a free-space "entry corridor"
    that connects via the validated slide-to-target segment, so the
    typical case finds a path that approaches the assembled position by
    sliding along the moving piece's long axis instead of phasing through
    the fixed piece.
- Match Report fields unchanged structurally; the `planner.expectedContactObjectIds`
  array will now always be empty, which acts as a self-documenting marker
  that the run used strict semantics.

## Update [2026-05-07]: Per-Axis Slide Decomposition For Keyboard Control

- Symptom: after a successful Match, the moving piece is interlocked with
  the fixed piece (e.g. Piece 2 inside Piece 4's notch). Pulling it back out
  by keyboard input was reported as "blocked by Piece 4" in every direction
  the user pressed.
- Root cause: `inputBindings.update(...)` applied the full screen-aligned
  motion vector atomically, then ran one collision check. Burr interlocks
  have exactly one valid disassembly axis (the moving piece's long axis at
  the assembled pose); any motion with a non-zero perpendicular component
  trips the collision guard and gets the whole frame reverted. Combined
  with the screen-axis WASD/arrow mapping, almost every key produced a
  motion with a forbidden component, so all keys looked blocked even when
  the user's intent contained the valid axis.
- Fix: refactored the translation step in
  `src/features/interaction/transform/inputBindings.js` to apply each world
  axis component independently:
  - the screen-aligned `moveVector` is computed as before, but its
    `(x, y, z)` components are split into three separate single-axis
    deltas
  - each axis delta is applied to the piece, then the collision guard is
    consulted; if the resulting pose penetrates a non-allowed obstacle,
    that field is restored and the loop continues with the next axis
  - successful components stick, blocked components are silently dropped
  - this is the standard "slide along walls" behavior used in games:
    pressing W (which projects to e.g. world `+Y -Z` after camera
    transform) lets the `-Z` component slide the piece along its long
    axis even when the `+Y` component is interlock-blocked
- Rotation is still applied atomically (composed quaternions do not commute
  so per-axis decomposition is meaningless); on collision only the rotation
  is reverted, preserving any translation that succeeded earlier in the
  frame.
- `lastBlock` semantics updated: the collision pill now lights up red
  ("Blocked by ...") only when the user pressed at least one key but
  nothing was applied this frame. Partial slides (one axis succeeded,
  others got rejected) are reported as `Clear` so the UI does not falsely
  indicate "stuck" while the piece is actually moving.
- Cost: up to four `classifyObjectAtTransform` calls per frame (three
  translation axes plus one rotation) when every key is held. Each call is
  the new bvhcast-based classifier from earlier today, so this stays well
  under the 60 fps budget for the 6-piece puzzle.
- Outcome for the reported case: pressing any key whose screen-projected
  vector contains the world long-axis component (typically W/S or
  ArrowUp/ArrowDown depending on camera angle) will now slide the matched
  piece out of the interlock; perpendicular axis components remain blocked
  but no longer veto the whole motion.

## Update [2026-05-07]: Geometric Tangent-Face Detector (Replaces Nudge Probe)

- Goal: classify any tangent-face contact between two pieces as `touching`,
  not `penetrating`, regardless of whether the surrounding geometry is
  interlocked. The previous `isLikelyTouchingContact` heuristic fired six
  axis-aligned BVH probes at `1e-4` displacement; for burr-style interlocks
  no axis-aligned nudge can resolve the intersection, so face-flush contact
  was always misclassified as `penetrating`.
- Added `classifyTriangleContact(...)` in
  `src/features/planning/sceneQuery.js`. It iterates every pair of
  AABB-overlapping triangles between the two BVHs via
  `MeshBVH.bvhcast(...)`, confirms each pair with
  `ExtendedTriangle.intersectsTriangle(other, target)`, then classifies
  every confirmed intersection as either:
  - **coplanar tangential** (face-flush): `|n_obstacle · n_moving| > 1 - eps`
    AND distance from one triangle's vertex to the other's plane below
    `planarityEpsilon`
  - **boundary tangential** (edge-on-edge / edge-on-face / vertex contact):
    the intersection segment lies entirely within `planarityEpsilon` of one
    of the three edges of either triangle
  - **interior penetration**: anything else (the line of intersection cuts
    through the interior of both triangles)
- Aggregation:
  - any pair classified as interior penetration => the contact is
    `penetrating` (early exit from `bvhcast` to keep this case cheap)
  - else if any pair was tangential => `touching`
  - else => `separated`
- Wired the new classifier into both call sites in `sceneQuery.js`:
  - `classifyObjectAtTransform(...)`: replaces the old
    "intersectsGeometry + nudge probe" sequence with a single bvhcast walk.
    `planarityEpsilon` derives from `input.collisionEpsilon * 100` (or
    `1e-4` floor), giving roughly a 0.1mm tolerance at the project's
    typical scale, which comfortably absorbs `Matrix4.compose / decompose`
    drift while staying well below any plausible real-penetration depth.
  - `buildCollisionDebugTrace(...)`: same change; the trace now reports
    `narrowphaseIntersects = (status !== "separated")` and
    `contactStatus = status` straight from the new classifier.
- Exposed `classifyTriangleContact` from `createCollisionSceneTools(...)`
  so debugging code (e.g. future Match Reports or interactive probes) can
  call it directly.
- Effects of this change:
  - Keyboard: pieces can now slide against each other at face-flush, edges,
    and corners without the collision guard rejecting the move. Real 3D
    overlap (one piece poking into another's body interior) still bounces
    back and lights up the red collision pill.
  - Match animation: the per-tick collision guard is no longer fooled by
    burr interlock at the assembled position. Combined with the existing
    `expectedContactObjectIds` filter, both the planner and the animation
    accept face-flush + interlock contact as path-valid.
  - Block Adhere planner: the previous `target-blocked` failure on the
    Piece 2 -> Piece 4 match should now resolve to `separated` (the new
    coplanar test passes for the matched faces) and the planner can
    proceed.
- Cost notes:
  - `bvhcast` walks the same node hierarchy as `intersectsGeometry`. For
    the no-overlap case, BVH bbox pruning makes both equally cheap.
  - For the contact case, the new walk processes every overlapping
    triangle pair (vs. the bool short-circuit of `intersectsGeometry`),
    but it replaces the old 6-query nudge probe entirely, so net cost is
    similar or lower for typical contact scenarios.
- The old `isLikelyTouchingContact` is still exported (for backwards
  compatibility and as a debugging fallback) but is no longer on any hot
  path.

## Update [2026-05-07]: Constant Collision Guard For Keyboard And Animation

- Goal: strictly avoid penetration both during keyboard transform input and
  Match animation playback. If a candidate frame would penetrate any
  non-allowed obstacle, revert to the previous frame's pose.
- Promoted the previously-local `createMatchSceneQuery(...)` helper into
  `src/features/planning/sceneQuery.js` as `createSceneQueryWithExpectedContacts(...)`
  so both the match flow and the new collision guard can share one
  implementation. `matchFlow.js` now imports it instead of redefining it.
- Added a `collisionGuard` object in `src/mvp/app.js` exposing
  `isPiecePenetrating(piece, options)`. It rebuilds the scene query each call
  (so obstacle snapshots reflect the current piece state), optionally wraps
  it with `createSceneQueryWithExpectedContacts` when
  `options.expectedContactObjectIds` is non-empty, and returns
  `{ blocked, obstacleObjectId, status }` based on
  `classifyObjectAtTransform(...)`.
- Keyboard control (`src/features/interaction/transform/inputBindings.js`):
  - `createKeyboardInputBindings(...)` now accepts a `collisionGuard`.
  - At the start of each `update(deltaSeconds)`, the piece's pose is
    snapshotted (`position`, `rotationQuaternion`, `orientation`).
  - After translation + rotation are applied, the guard is consulted; if it
    reports `blocked`, the snapshot is restored atomically and the frame is
    treated as a no-op.
  - Exposes `getLastBlock()` so the caller can mirror the latest guard
    result into the UI without re-running the check.
- Animation (`src/features/planning/animationPlayer.js`):
  - `animatePieceAlongPath(...)` now accepts `collisionGuard`,
    `expectedContactObjectIds`, and `findPieceByName`.
  - Each tick snapshots the moving piece state, applies the interpolated
    transform, then runs the guard with the supplied
    `expectedContactObjectIds` (the matched fixed piece is included so
    burr-style face-flush contact at the assembled position remains
    path-valid).
  - On a blocked frame the animation is reverted to the snapshot, marked
    not-animating, the active rAF cancelled, and the status bar reports
    `Animation aborted: collision with <piece>` (or generic when the
    obstacle id is missing).
  - The final-pose check is also gated through the guard so the animation
    never lands on a frame that would otherwise be classified as
    penetrating.
- Match flow (`src/features/matching/matchFlow.js`) now passes
  `{ expectedContactObjectIds }` to the animation callback so the same
  filter the planner used carries over to the animation guard.
- Wired in `src/mvp/app.js`:
  - keyboard bindings receive `collisionGuard`
  - the per-frame callback also reads `keyboardBindings.getLastBlock()` and
    updates `state.collisionStatus` to `Clear` or
    `Blocked by <piece>` accordingly, calling `renderStatus()` only on
    transitions
  - the animation callback factory threads `collisionGuard`,
    `expectedContactObjectIds`, and `findPieceByName` to
    `animatePieceAlongPath`
- UI (`src/app/ui/status.js`): the collision pill now renders with the red
  `is-warning` class whenever `state.collisionStatus !== "Clear"`, and green
  `is-success` otherwise. No CSS changes needed (`.status-pill.is-warning`
  was already defined in `src/mvp/styles.css`).
- Performance notes:
  - One scene query rebuild + one `classifyObjectAtTransform` call per
    keyboard frame and per animation tick. For the 6-piece puzzle at
    `scale=0.05`, this is sub-millisecond on average.
  - The touching-vs-penetrating probe (six BVH nudge queries when
    narrowphase reports overlap) is the only meaningful cost spike; it only
    runs on actual overlap, so the common "moving in free space" case stays
    cheap.

## Update [2026-05-07]: Treat Matched Fixed Piece As Allowed Contact

- Symptom: Match flow reported `target-blocked by Piece 4` on a visually
  feasible face-flush match. The trace
  (`diagnostics.targetBlocked.obstacleTraces`) showed all other pieces as
  `separated`; only the matched fixed piece (`Piece 4`) classified as
  `penetrating`. Both pieces' world AABBs at the target had identical
  X-extent `[15.893, 17.143]` — i.e. they interlock through complementary
  notches at the matched faces.
- Root cause: `classifyObjectAtTransform(...)` uses BVH narrowphase plus a
  micro-separation probe (`isLikelyTouchingContact`) to distinguish touching
  vs penetrating. Burr-style interlock is by design unable to separate under
  small axis-aligned nudges, so the probe always fails and the matched fixed
  piece is reported as `penetrating`. The classifier had no notion of
  "expected contact": the matched fixed piece is, by construction, supposed
  to be in tangential contact with the moving piece at the target.
- Fix: added `createMatchSceneQuery(baseQuery, expectedContactObjectIds)` in
  `src/features/matching/matchFlow.js`. It wraps the scene query so the named
  obstacle ids are filtered out of `getObstacleSnapshots(...)`, and the
  inherited `classifyObjectAtTransform(...)` (which iterates
  `this.getObstacleSnapshots(...)`) automatically sees the filtered list.
- Wired `runMatchFlowCoordinator` to wrap the scene query with
  `[matchResult.fixedPieceName]` for both planners (Block Adhere and CBiRRT)
  and for the start/target-blocked diagnostics. Other obstacles are still
  checked normally, so a third piece truly in the way is still reported as
  the blocker.
- Added the active list to the consolidated debug report under
  `planner.expectedContactObjectIds` for visibility.
- Notes:
  - Side effect: a path that geometrically passes through the matched fixed
    piece during free-space approach (e.g. straight translation through
    Piece 4 to reach a staging pose on the far side) is now considered free
    and will animate as a phase-through. This is acceptable for the burr
    use case because the assembled-state interlock cannot be planned by
    Block Adhere otherwise; the user can iterate on face selection or move
    other pieces if the visualization is unsatisfactory.
  - This fix unblocks CBiRRT for burr matches: previously CBiRRT also
    aborted on `target-blocked` because it shares the same scene query.

## Update [2026-05-06]: Consolidated Match Console Output

- Replaced the scattered per-Match `console.log` calls (`Match result output`,
  `Match pose output`, `Selected faces`, `Selected edges`, `Selected vertices`,
  `Current pose world`, `Target pose world`, `Debug chain`,
  `[Match Planner] planCollisionFreeSe3Path output`,
  `[Match Planner] ... CBiRRT fallback output`,
  `[Collision Debug] start-blocked trace`,
  `[Collision Debug] target-blocked trace`) with one consolidated
  `[Match Report]` object dumped at the end of each `runMatchFlowCoordinator`
  invocation.
- Added `buildMatchReport(...)` helper in `src/features/matching/matchFlow.js`.
  Report shape:
  - `summary`: `matchStatus`, `finalOutcome`
    (`animated | planner-failed | need-edge | need-vertex | failure | exception`),
    `fixedPieceName`, `movingPieceName`, `chosenPlanner`, `pathSteps`
  - `selections`: `matchStage`, full `faces` / `edges` / `vertices` selection
    arrays (incl. `selectedAt` ordering)
  - `matchSolve`: `status`, `reason`, `candidate`, world poses, attachment
    normal, full `debugChain` (faces/edges/vertices used, frame matrices,
    decision trace, residuals)
  - `planner`: `blockAdhere` and `cbirrtFallback` raw planner outputs (when
    planner ran), so call-site has full transforms + stats + bestAttempt
  - `diagnostics`: `startBlocked` / `targetBlocked` per-obstacle trace
    (broadphase, narrowphase, contact classification, raw bounds), populated
    only when those failure reasons triggered
  - `error`: exception message when an exception was caught
- Removed dead exports `outputCurrentAndTargetWorldPose` and
  `logMatchComputationChain` from `matchFlow.js` (no callers left after the
  consolidation).
- Updated `src/mvp/app.js` to drop the corresponding imports and dependency
  injections (`logMatchComputationChainFn`, `outputCurrentAndTargetWorldPoseFn`).
- Stripped the inline `console.log("[Collision Debug] ... trace:", ...)`
  calls inside `diagnoseStartBlocked(...)` and `diagnoseTargetBlocked(...)` in
  `src/features/planning/sceneQuery.js`. They still return the same data; the
  match flow now owns the single dump.
- Net effect: each Match button click prints exactly one
  `[Match Report]` console line containing all per-click debug data, suitable
  for right-click -> "Copy object" -> paste into a chat for offline analysis.

## Update [2026-05-06]: Target-Blocked Diagnostics + Normal Magnitude Fix

- Added `diagnoseTargetBlocked(...)` helper in `src/features/planning/sceneQuery.js`,
  mirroring `diagnoseStartBlocked(...)`. It runs the same per-obstacle collision
  trace at the target pose and logs `[Collision Debug] target-blocked trace:`.
- Wired the helper into `runMatchFlowCoordinator` in
  `src/features/matching/matchFlow.js`:
  - on `target-blocked`, the status bar now reports
    `Path planning failed: target-blocked by <piece>` instead of the bare reason
  - the full obstacle trace (broadphase / narrowphase / contact classification)
    is dumped to console for offline inspection
- Injected the new helper from `src/mvp/app.js`.
- Fixed a magnitude bug in `computeTransform.ts` where
  `debug.world.fixedFaceNormal` / `movingFaceNormal` were emitted with
  magnitude `1/scale` (e.g. `20` for `scale=0.05` pieces) because of
  `Matrix3.getNormalMatrix` scaling rules. The pre-normalization happened
  before `applyMatrix3` instead of after; swapped the order so the emitted
  world normals are unit length.
  - Functional impact is nil for the existing planners (Block Adhere and
    CBiRRT both `.normalize()` the input internally), but the debug output is
    now numerically correct and safer for any future consumer that depends on
    the magnitude.
- Notes for future debugging:
  - `target-blocked` with no obvious overlap is most often face-flush
    numerical drift exceeding the `isLikelyTouchingContact` probe distance
    (`max(collisionEpsilon * 8, 1e-4)`). If the new
    `[Collision Debug] target-blocked trace` shows only the matched fixed
    piece as the obstacle, raising `collisionEpsilon` (and indirectly the
    probe distance) is the right knob.
  - When the trace shows a third piece as the obstacle, the failure is real
    geometry overlap and the puzzle truly needs another piece moved out of
    the way first.

## Update [2026-05-06]: Added CBiRRT Fallback Planner

- Added new sampling-based planner under `src/features/physics/path-finding/cbirrt/`:
  - `prng.ts` — deterministic mulberry32 PRNG so planning runs are reproducible per seed
  - `sampler.ts` — uniform SE(3) sampler (Marsaglia quaternion + AABB position) and
    shared SE(3) primitives (`transformDistance`, `interpolateTransform`,
    `cloneTransform`, `deriveSamplingBounds`)
  - `constraints.ts` — pluggable constraint manifolds:
    - `M0` free space (identity projection)
    - `M1` approach-along-normal (rotation locked to target, position locked to the
      line through `target.position` along `attachmentNormalWorld`)
  - `planCBiRRT.ts` — main CBiRRT-style bidirectional RRT with `ConstrainedExtend`,
    multi-seed support, shortcut smoothing, and densified output matching
    `planCollisionFreeSe3Path`'s shape
- Wired the fallback into `runMatchFlowCoordinator` in `src/features/matching/matchFlow.js`:
  - Block Adhere is still tried first as the fast path
  - if it returns `not-found` for any reason other than `start-blocked`,
    `target-blocked`, or `invalid-normal`, CBiRRT is invoked
  - CBiRRT is seeded with `bestAttempt` from Block Adhere when present so the goal
    tree starts from the closest staging pose Block Adhere reached
  - status text now reports which planner produced the path
    (`Animating path (N steps via CBiRRT)`)
- Injected `planCBiRRT` from `src/mvp/app.js` into the match flow coordinator.
- Documented the planner contract, algorithm sketch, tangential-contact handling,
  determinism, and known limitations in `docs/collision-strategy.md` (new Section 5).
- Notes:
  - No new external dependencies. Reuses the existing `CollisionSceneQuery`
    contract (`classifyObjectAtTransform` + BVH cache + touching probe), so
    sliding contact remains path-valid by virtue of the existing `touching`
    classification.
  - Probabilistic completeness only; failures surface as
    `time-budget-exceeded` / `iteration-budget-exceeded` rather than proofs
    of infeasibility.
  - M1 constraint is opt-in via `options.constraintActivationDistance`;
    default behavior is plain BiRRT to keep the first integration conservative.

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

### Update [2026-05-02 15:22:48 -04:00]

- Started post-MVP refactor pass with behavior-preserving module extraction:
  - Added `src/app/core/constants.js` for shared runtime constants.
  - Added `src/app/core/runtime.js` for central `sceneRuntime`, `state`, and `elements`.
  - Added `src/app/ui/status.js` for shared `formatErrorMessage`, `getSelectedPiece`, `renderStatus`, and `renderInspector`.
- Updated `src/mvp/app.js` to import from new modules and route existing wrapper functions through extracted helpers.
- Added `docs/architecture.md` to formalize migration plan and phase status.
- Updated `README.md` to reflect current hybrid architecture (`src/mvp` orchestration + `src/app/*` extracted modules).
- Removed obsolete placeholder file:
  - `src/features/interaction/selection/raycastSelection.ts`.

### Update [2026-05-02 15:22:48 -04:00] (Phase 2 Start)

- Continued refactor into interaction domain modules:
  - Added `src/features/interaction/selection/selectionState.js`.
  - Moved selection-state operations out of `src/mvp/app.js`:
    - target equality/match checks
    - selected face/edge/vertex membership checks
    - face/edge/vertex selection push logic (bounded queue behavior)
    - clear/reset helpers (object/face/edge/vertex/all/disambiguation)
    - match stage setter
- Updated `src/mvp/app.js` to delegate these behaviors through imported feature helpers while preserving existing public function names and runtime behavior.
- Updated `docs/architecture.md` status:
  - Phase 2 marked `In Progress`
  - documented extracted selection-state module and current integration state.

### Update [2026-05-02 15:47:53 -04:00] (Phase 2 Continue)

- Added `src/features/interaction/selection/interactionHandlers.js`.
- Moved scene interaction handler orchestration out of `src/mvp/app.js`:
  - pointer move hover target resolution
  - pointer leave hover clear behavior
  - context menu object selection flow
  - left click face/edge/vertex stage selection flow
- Updated `src/mvp/app.js` handler wrappers to delegate to extracted module via dependency injection while preserving behavior.
- Updated `docs/architecture.md` current status to include handler extraction.

### Update [2026-05-02 15:47:53 -04:00] (Phase 2 Continue: Target Resolver Extraction)

- Added `src/features/interaction/selection/targetResolver.js`.
- Moved pointer target-resolution helpers out of `src/mvp/app.js`:
  - raycast hit mapping (`getTargetFromIntersection`, `findFirst*Hit`)
  - screen-space projection and distance helpers
  - edge/vertex screen-space proximity pickers
  - `getTargetsFromMouseEvent(...)` aggregation
- Updated `src/mvp/app.js` wrappers to delegate to `targetResolver` while preserving existing function names and runtime behavior.
- Updated docs:
  - `docs/architecture.md` now includes extracted target resolver status
  - `README.md` layout section includes new interaction modules.

### Update [2026-05-02 15:58:14 -04:00] (Phase 2 Continue: Match Flow Extraction)

- Added `src/features/matching/matchFlow.js`.
- Moved match orchestration helpers out of `src/mvp/app.js`:
  - `buildPiecesByNameMap(...)`
  - `outputCurrentAndTargetWorldPose(...)`
  - `logMatchComputationChain(...)`
  - full `runMatchFlow` decision flow via `runMatchFlowCoordinator(...)`
- Updated `src/mvp/app.js` to delegate through wrapper functions/imported coordinator while preserving behavior and status messaging.
- Updated docs:
  - `docs/architecture.md` now includes extracted match flow status
  - `README.md` layout section now includes `src/features/matching/matchFlow.js`.

### Update [2026-05-02 16:03:46 -04:00] (Phase 2 Continue: Planning Scene Query Extraction)

- Added `src/features/planning/sceneQuery.js`.
- Moved planning/collision scene-query helpers out of `src/mvp/app.js`:
  - planner transform conversion helpers
  - touching-vs-penetrating probe helper
  - `getCollisionSceneQuery(...)`
  - `buildCollisionDebugTrace(...)`
  - `diagnoseStartBlocked(...)`
- Updated `src/mvp/app.js` to instantiate `collisionSceneTools` and delegate through wrappers, preserving existing call sites and behavior.
- Updated docs:
  - `docs/architecture.md` now includes extracted planning scene-query module status
  - `README.md` layout section now includes `src/features/planning/sceneQuery.js`.

### Update [2026-05-02 16:06:29 -04:00] (Phase 2 Continue: Animation Player Extraction)

- Added `src/features/planning/animationPlayer.js`.
- Moved planning animation helpers out of `src/mvp/app.js`:
  - planner transform application (`applyPlannerTransformToPiece`)
  - path playback interpolator (`animatePieceAlongPath`)
- Updated `src/mvp/app.js` wrappers to delegate through extracted module with dependency injection (`THREE`, `state`, `sceneRuntime`, render/status callbacks).
- Updated docs:
  - `docs/architecture.md` now includes extracted animation player module status
  - `README.md` layout section now includes `src/features/planning/animationPlayer.js`.

### Update [2026-05-02 16:08:32 -04:00] (Phase 2 Cleanup: Dead Wrapper Removal)

- Removed now-redundant dead wrappers from `src/mvp/app.js` after module extraction:
  - legacy target-resolver passthrough wrappers (`findFirst*`, `projectWorldPointToScreen`, etc.)
  - legacy scene-query passthrough wrappers no longer referenced
  - unused `getPieceWorldTransform(...)` helper.
- Kept only wrappers still required by dependency-injected orchestrators.
- Result: smaller MVP orchestrator surface with no behavior changes.

### Update [2026-05-02 17:23:03 -04:00] (Phase 4 Cleanup: Inline Single-Use Match Wrappers)

- Reduced `src/mvp/app.js` wrapper surface further by inlining single-use dependencies directly into `runMatchFlow()` coordinator injection:
  - pieces map builder, match debug logger, pose output
  - collision scene query and start-block diagnostics
  - animation orchestration callback + planner-transform apply callback
- Removed additional unused helper wrappers that no longer had call sites (`getSelectedPiece`, `clearHoverHighlight`).
- Preserved runtime behavior by keeping the same dependency values and execution order, only changing wiring shape.

### Update [2026-05-02 17:25:10 -04:00] (Phase 4 Cleanup: Bootstrap Event Extraction)

- Added `src/app/bootstrap/events.js` to hold app startup event wiring helpers:
  - `registerGlobalErrorHandlers(...)`
  - `bindBootstrapEvents(...)`
- Moved global error listeners and controls/reload/match/clear-selection event binding out of `src/mvp/app.js`.
- Updated `src/mvp/app.js` to call extracted bootstrap helpers while preserving startup order:
  - register handlers
  - bind events
  - render status
  - begin async load.

### Update [2026-05-02 17:29:18 -04:00] (Phase 4 Cleanup: Scene Bootstrap Extraction)

- Added `src/features/rendering/sceneBootstrap.js` with `createSceneBootstrap(...)` to encapsulate:
  - scene/camera/renderer/control creation
  - edge line resolution sync on resize
  - scene render call and render-loop startup
  - pointer/click/context menu event attachment on renderer canvas.
- Removed in-file scene boot/render helper functions from `src/mvp/app.js` (`ensureScene`, `resizeRenderer`, `updateEdgeLineResolutions`, `renderThreeScene`, `renderLoop`).
- Rewired `src/mvp/app.js` to use `sceneBootstrap.ensureScene()`, `sceneBootstrap.resizeRenderer()`, and `sceneBootstrap.renderThreeScene()` at existing call sites.
- Preserved behavior: same scene appearance, controls setup, event handlers, and render-loop semantics.

### Update [2026-05-02 17:32:19 -04:00] (Phase 4 Closeout: Selection Wrapper Prune)

- Removed another set of low-value selection/state passthrough wrappers from `src/mvp/app.js` by wiring state-aware lambdas directly into interaction and match coordinators.
- Updated selection highlight checks in `syncPieceObjects()` to call selection-state implementations directly (`isTargetMatchImpl`, `is*TargetSelectedImpl`) instead of local pass-throughs.
- Removed now-unused selection imports (`clearEdgeSelectionImpl`, `clearVertexSelectionImpl`) after wrapper pruning.
- Result: leaner orchestration layer with unchanged runtime behavior.

### Update [2026-05-02 17:51:52 -04:00] (Keyboard Controls Restore: Continuous Transform Input)

- Added `src/features/interaction/transform/inputBindings.js` and implemented a continuous keyboard controller:
  - tracks pressed keys (`W/A/S/D`, arrows, `Q/E`, `R/F`)
  - resolves selected piece from current selection state
  - applies frame-time-scaled translation + rotation updates
  - ignores input while animation is running or while controls modal is open.
- Extended `src/features/rendering/sceneBootstrap.js` with frame callback support (`addFrameCallback`) and frame delta timing in the render loop.
- Wired keyboard update into the per-frame loop from `src/mvp/app.js`:
  - bind key listeners during app boot
  - on keyboard-driven state changes, sync piece objects and refresh inspector.
- Goal of this pass: restore non-discrete, continuous keyboard controls from `docs/controls-spec.md` with minimal coupling impact.

