// @ts-nocheck

/**
 * Constrained Bidirectional RRT (CBiRRT) for SE(3) rigid-body motion planning.
 *
 * Acts as a general-purpose fallback to the deterministic Block Adhere planner
 * in `collisionFreePath.ts`. Block Adhere is fast and structured but only
 * succeeds when the start->target motion fits its "stage along +n, approach
 * along -n" template. CBiRRT runs when Block Adhere reports `not-found` and
 * tries to find a path under the same collision query interface, optionally
 * snapping to an "approach-along-normal" manifold near the target so it can
 * solve face-flush insertions Block Adhere could not.
 *
 * Key properties:
 * - Uses the existing `CollisionSceneQuery.classifyObjectAtTransform(...)`
 *   contract from `collisionFreePath.ts` (BVH narrowphase + touching probe).
 *   No new collision dependencies; tangential contact is treated as
 *   path-valid because `classify(...)` returns `touching` (non-penetrating).
 * - Probabilistic completeness only. Failure modes are surfaced as
 *   `time-budget-exceeded`, `iteration-budget-exceeded`, `start-blocked`, or
 *   `target-blocked` so the caller can distinguish "ran out of search budget"
 *   from "configuration is genuinely infeasible at start/target".
 * - Deterministic w.r.t. `options.seed`: same seed + same scene yields the
 *   same path, which preserves the trace-based debugging workflow used in
 *   `progress.md`.
 *
 * Output shape mirrors `planCollisionFreeSe3Path` so the path consumer
 * (`animatePieceAlongPath`) can be reused unchanged.
 */

import { createMulberry32 } from "./prng.ts";
import {
  cloneTransform,
  createSe3Sampler,
  deriveSamplingBounds,
  interpolateTransform,
  transformDistance,
} from "./sampler.ts";
import {
  createApproachAlongNormalConstraint,
  createFreeConstraint,
  pickConstraint,
} from "./constraints.ts";

const DEFAULTS = {
  seed: 0xC0FFEE,
  maxIterations: 4000,
  maxPlanningTimeMs: 2500,
  goalSampleProbability: 0.15,
  translationStep: 0.4,
  rotationStepRadians: Math.PI / 6,
  rotationDistanceWeight: 1,
  collisionEpsilon: 1e-5,
  // null disables the approach-along-normal constraint entirely.
  // Set to a positive number (in world units) to project candidate
  // configurations onto the M1 line once they enter that radius.
  constraintActivationDistance: null,
  smoothingPasses: 50,
  // Distance below which two transforms are treated as "the same" when
  // declaring tree connection.
  connectionEpsilon: 1e-3,
  // Sampling bounds. If null, derived from start/target positions with padding.
  bounds: null,
  boundsPadding: 4,
};

function nowMs() {
  return typeof performance !== "undefined" && performance.now
    ? performance.now()
    : Date.now();
}

class Tree {
  constructor(rootTransforms) {
    this.nodes = [];
    this.parents = [];
    for (const rootTransform of rootTransforms) {
      this.nodes.push(cloneTransform(rootTransform));
      this.parents.push(-1);
    }
  }

  add(transform, parentIndex) {
    this.nodes.push(cloneTransform(transform));
    this.parents.push(parentIndex);
    return this.nodes.length - 1;
  }

  nearest(target, weight) {
    let bestIndex = -1;
    let bestDistance = Infinity;
    for (let i = 0; i < this.nodes.length; i += 1) {
      const distance = transformDistance(this.nodes[i], target, weight);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestIndex = i;
      }
    }
    return bestIndex;
  }

  pathFromRoot(index) {
    const path = [];
    let cursor = index;
    while (cursor >= 0) {
      path.push(this.nodes[cursor]);
      cursor = this.parents[cursor];
    }
    path.reverse();
    return path;
  }
}

function quaternionLengthSq(rotation) {
  return (
    rotation.x * rotation.x
    + rotation.y * rotation.y
    + rotation.z * rotation.z
    + rotation.w * rotation.w
  );
}

function normalizedRotation(rotation) {
  const lengthSq = quaternionLengthSq(rotation);
  if (lengthSq === 0) {
    return { x: 0, y: 0, z: 0, w: 1 };
  }
  const inverseLength = 1 / Math.sqrt(lengthSq);
  return {
    x: rotation.x * inverseLength,
    y: rotation.y * inverseLength,
    z: rotation.z * inverseLength,
    w: rotation.w * inverseLength,
  };
}

function asPlannerTransform(transform) {
  return {
    position: {
      x: transform.position.x,
      y: transform.position.y,
      z: transform.position.z,
    },
    rotation: normalizedRotation(transform.rotation),
    scale: transform.scale,
  };
}

/**
 * Take a single bounded step from `from` toward `to` in SE(3) using the
 * configured translation/rotation step caps, then project the result onto the
 * supplied constraint manifold.
 */
function stepAndProject({
  from,
  to,
  options,
  constraint,
}) {
  const positionDistance = Math.sqrt(
    (from.position.x - to.position.x) ** 2
    + (from.position.y - to.position.y) ** 2
    + (from.position.z - to.position.z) ** 2,
  );
  const fromRotationNorm = normalizedRotation(from.rotation);
  const toRotationNorm = normalizedRotation(to.rotation);
  const dot = Math.min(
    1,
    Math.max(
      -1,
      fromRotationNorm.x * toRotationNorm.x
      + fromRotationNorm.y * toRotationNorm.y
      + fromRotationNorm.z * toRotationNorm.z
      + fromRotationNorm.w * toRotationNorm.w,
    ),
  );
  const rotationDistance = 2 * Math.acos(Math.abs(dot));

  let translationT = positionDistance > 0
    ? Math.min(1, options.translationStep / positionDistance)
    : 1;
  let rotationT = rotationDistance > 0
    ? Math.min(1, options.rotationStepRadians / rotationDistance)
    : 1;
  const t = Math.min(translationT, rotationT, 1);
  if (!Number.isFinite(t) || t <= 0) {
    return null;
  }

  const stepped = interpolateTransform(from, to, t);
  return constraint.project(stepped);
}

function isSegmentCollisionFree({
  from,
  to,
  options,
  classify,
}) {
  const positionDistance = Math.sqrt(
    (from.position.x - to.position.x) ** 2
    + (from.position.y - to.position.y) ** 2
    + (from.position.z - to.position.z) ** 2,
  );
  const fromRotationNorm = normalizedRotation(from.rotation);
  const toRotationNorm = normalizedRotation(to.rotation);
  const dot = Math.min(
    1,
    Math.max(
      -1,
      fromRotationNorm.x * toRotationNorm.x
      + fromRotationNorm.y * toRotationNorm.y
      + fromRotationNorm.z * toRotationNorm.z
      + fromRotationNorm.w * toRotationNorm.w,
    ),
  );
  const rotationDistance = 2 * Math.acos(Math.abs(dot));
  const translationSamples = Math.ceil(positionDistance / Math.max(options.translationStep, 1e-6));
  const rotationSamples = Math.ceil(rotationDistance / Math.max(options.rotationStepRadians, 1e-6));
  const samples = Math.max(1, translationSamples, rotationSamples);

  for (let i = 1; i <= samples; i += 1) {
    const intermediate = interpolateTransform(from, to, i / samples);
    if (classify(intermediate).status === "penetrating") {
      return false;
    }
  }
  return true;
}

function densifyPath(path, options) {
  if (path.length <= 1) {
    return path.map(cloneTransform);
  }
  const out = [cloneTransform(path[0])];
  for (let i = 1; i < path.length; i += 1) {
    const previous = path[i - 1];
    const current = path[i];
    const positionDistance = Math.sqrt(
      (previous.position.x - current.position.x) ** 2
      + (previous.position.y - current.position.y) ** 2
      + (previous.position.z - current.position.z) ** 2,
    );
    const fromNorm = normalizedRotation(previous.rotation);
    const toNorm = normalizedRotation(current.rotation);
    const dot = Math.min(
      1,
      Math.max(
        -1,
        fromNorm.x * toNorm.x + fromNorm.y * toNorm.y + fromNorm.z * toNorm.z + fromNorm.w * toNorm.w,
      ),
    );
    const rotationDistance = 2 * Math.acos(Math.abs(dot));
    const translationSamples = Math.ceil(positionDistance / Math.max(options.translationStep, 1e-6));
    const rotationSamples = Math.ceil(rotationDistance / Math.max(options.rotationStepRadians, 1e-6));
    const samples = Math.max(1, translationSamples, rotationSamples);
    for (let k = 1; k <= samples; k += 1) {
      out.push(interpolateTransform(previous, current, k / samples));
    }
  }
  return out;
}

function smoothPath({ path, options, classify, rng }) {
  if (path.length <= 2) {
    return path.map(cloneTransform);
  }
  let current = path.map(cloneTransform);
  for (let pass = 0; pass < options.smoothingPasses; pass += 1) {
    if (current.length <= 2) {
      break;
    }
    const i = Math.floor(rng() * (current.length - 1));
    const j = i + 1 + Math.floor(rng() * (current.length - i - 1));
    if (j - i <= 1) continue;
    if (isSegmentCollisionFree({ from: current[i], to: current[j], options, classify })) {
      current = [...current.slice(0, i + 1), ...current.slice(j)];
    }
  }
  return current;
}

function pathLength(path, weight) {
  let total = 0;
  for (let i = 1; i < path.length; i += 1) {
    total += transformDistance(path[i - 1], path[i], weight);
  }
  return total;
}

/**
 * Plan an SE(3) collision-free path between `startTransform` and
 * `targetTransform` using CBiRRT. See file docstring for behavior contract and
 * `DEFAULTS` for tuning knobs.
 *
 * Inputs:
 * - `movingObjectId`, `sceneQuery`: same as `planCollisionFreeSe3Path`.
 * - `startTransform`, `targetTransform`: SE(3) endpoints in world frame.
 * - `attachmentNormalWorld?`: optional outward normal of the attachment face.
 *   When supplied together with `options.constraintActivationDistance > 0`,
 *   the planner snaps configurations within that radius of the target onto
 *   the line `target.position + t * normal` with rotation locked to
 *   `target.rotation`.
 * - `seedTransforms?`: extra goal-tree seeds. Useful for forwarding the
 *   staging pose Block Adhere computed (it is on the M1 manifold by
 *   construction and dramatically reduces RRT search).
 * - `options?`: see `DEFAULTS`.
 *
 * Output:
 * - `{ status: "found", transforms, stats }` where `transforms` is densified
 *   per `translationStep` / `rotationStepRadians` for direct animation.
 * - `{ status: "not-found", reason, bestAttempt?, stats }` with reasons
 *   `start-blocked | target-blocked | time-budget-exceeded |
 *   iteration-budget-exceeded`. `bestAttempt` is the start-tree node closest
 *   to the target when planning fails by budget.
 */
export function planCBiRRT(input) {
  const options = { ...DEFAULTS, ...(input.options ?? {}) };
  const stats = {
    iterations: 0,
    collisionChecks: 0,
    treeNodes: 0,
    pathLength: 0,
    plannerKind: "cbirrt",
    seedAcceptance: {
      // Goal-tree seeds (user-supplied via `input.seedTransforms`).
      goalCandidates: 0,
      goalAccepted: 0,
      goalRejectedPenetrating: 0,
      goalRejectedSegmentBlocked: 0,
      // Start-tree rotation-alignment seed (start position with target
      // rotation). Adding this lets the start tree explore at the target
      // rotation, which collapses the 6-DOF search around target back to a
      // 3-DOF translation when the disassembly direction is known.
      startRotationAlignmentAttempted: false,
      startRotationAlignmentAccepted: false,
      startRotationAlignmentReason: null,
    },
  };
  const startTime = nowMs();

  function classify(transform) {
    stats.collisionChecks += 1;
    return input.sceneQuery.classifyObjectAtTransform({
      movingObjectId: input.movingObjectId,
      candidateTransform: transform,
      sceneQuery: input.sceneQuery,
      collisionEpsilon: options.collisionEpsilon,
    });
  }

  const start = asPlannerTransform(input.startTransform);
  const target = asPlannerTransform(input.targetTransform);

  if (classify(start).status === "penetrating") {
    return {
      status: "not-found",
      reason: "start-blocked",
      stats,
    };
  }
  if (classify(target).status === "penetrating") {
    return {
      status: "not-found",
      reason: "target-blocked",
      stats,
    };
  }

  const freeConstraint = createFreeConstraint();
  let approachConstraint = null;
  if (
    input.attachmentNormalWorld
    && (input.attachmentNormalWorld.x !== 0
      || input.attachmentNormalWorld.y !== 0
      || input.attachmentNormalWorld.z !== 0)
  ) {
    try {
      approachConstraint = createApproachAlongNormalConstraint({
        targetTransform: target,
        attachmentNormalWorld: input.attachmentNormalWorld,
      });
    } catch {
      approachConstraint = null;
    }
  }

  function constraintAt(transform) {
    return pickConstraint({
      transform,
      targetPosition: target.position,
      approachConstraint,
      freeConstraint,
      activationDistance: options.constraintActivationDistance,
    });
  }

  const rng = createMulberry32(options.seed);

  // Pre-extract candidate seed transforms so the sampling bounds can grow to
  // cover them even before we know which ones survive collision validation.
  const candidateSeeds = Array.isArray(input.seedTransforms)
    ? input.seedTransforms.map(asPlannerTransform)
    : [];

  const bounds = options.bounds
    ?? deriveSamplingBounds(start, target, options.boundsPadding, candidateSeeds);
  const sampler = createSe3Sampler({ rng, bounds });

  let treeA = new Tree([start]);
  let treeB = new Tree([target]);
  let treeAIsStartTree = true;

  // Goal-tree seeds: insert as direct children of the target node, but only
  // when the seed-to-target segment is itself collision-free. This
  // guarantees any returned path ends at the actual target pose (tree-B
  // path reconstruction traces parents back to the target root) and the
  // seed-to-target slide is path-valid by construction.
  stats.seedAcceptance.goalCandidates = candidateSeeds.length;
  for (const candidate of candidateSeeds) {
    if (classify(candidate).status === "penetrating") {
      stats.seedAcceptance.goalRejectedPenetrating += 1;
      continue;
    }
    const segmentClear = isSegmentCollisionFree({
      from: target,
      to: candidate,
      options,
      classify,
    });
    if (!segmentClear) {
      stats.seedAcceptance.goalRejectedSegmentBlocked += 1;
      continue;
    }
    treeB.add(candidate, 0); // parent index 0 == target root
    stats.seedAcceptance.goalAccepted += 1;
  }

  // Start-tree rotation alignment: add a node at the start position with
  // the target rotation, validated by checking the rotate-in-place segment
  // from start. With this node, extensions from the start tree can pursue
  // goal-tree nodes (which all sit at target rotation) using pure
  // translation -- the 6-DOF search collapses to a 3-DOF translation
  // search through obstacle-free space, which RRT solves much faster than
  // hunting for a coupled translation+rotation alignment.
  const startAtTargetRotation = {
    position: { x: start.position.x, y: start.position.y, z: start.position.z },
    rotation: { ...target.rotation },
    scale: start.scale,
  };
  // Skip the alignment seed when start is already at target rotation
  // (within step tolerance) -- nothing to gain.
  const rotationAlreadyAligned = transformDistance(
    { position: start.position, rotation: start.rotation },
    { position: start.position, rotation: target.rotation },
    options.rotationDistanceWeight,
  ) <= options.connectionEpsilon;
  if (!rotationAlreadyAligned) {
    stats.seedAcceptance.startRotationAlignmentAttempted = true;
    if (classify(startAtTargetRotation).status === "penetrating") {
      stats.seedAcceptance.startRotationAlignmentReason = "endpoint-penetrating";
    } else if (
      !isSegmentCollisionFree({
        from: start,
        to: startAtTargetRotation,
        options,
        classify,
      })
    ) {
      stats.seedAcceptance.startRotationAlignmentReason = "rotate-in-place-segment-blocked";
    } else {
      treeA.add(startAtTargetRotation, 0); // parent = start root
      stats.seedAcceptance.startRotationAlignmentAccepted = true;
    }
  }

  /**
   * Repeatedly take constrained steps from the closest existing tree node
   * toward `targetPose`, adding each successful step. Returns the index of the
   * last node reached so the caller can do path reconstruction or connect the
   * other tree to it.
   */
  function constrainedExtend(tree, targetPose) {
    const nearestIndex = tree.nearest(targetPose, options.rotationDistanceWeight);
    if (nearestIndex < 0) {
      return { lastIndex: -1, reachedTarget: false };
    }
    let parentIndex = nearestIndex;
    let qNear = tree.nodes[nearestIndex];
    let lastReachedIndex = nearestIndex;

    const maxStepsPerExtend = options.maxLocalSegmentChecks ?? 80;
    for (let step = 0; step < maxStepsPerExtend; step += 1) {
      const remaining = transformDistance(qNear, targetPose, options.rotationDistanceWeight);
      if (remaining <= options.connectionEpsilon) {
        return { lastIndex: lastReachedIndex, reachedTarget: true };
      }

      const constraint = constraintAt(qNear);
      const qNew = stepAndProject({ from: qNear, to: targetPose, options, constraint });
      if (!qNew) {
        return { lastIndex: lastReachedIndex, reachedTarget: false };
      }

      // Reject step if the projection moved the candidate so far that the
      // resulting motion no longer respects step caps; this prevents
      // jittering across constraint manifolds.
      const stepDistance = transformDistance(qNear, qNew, options.rotationDistanceWeight);
      const stepBudget = options.translationStep
        + options.rotationStepRadians * options.rotationDistanceWeight;
      if (stepDistance > 4 * stepBudget || stepDistance <= 1e-9) {
        return { lastIndex: lastReachedIndex, reachedTarget: false };
      }

      // Validate the local segment from qNear to qNew (post-projection) so we
      // do not skip over thin obstacles between the tree node and the new
      // candidate.
      if (!isSegmentCollisionFree({ from: qNear, to: qNew, options, classify })) {
        return { lastIndex: lastReachedIndex, reachedTarget: false };
      }

      lastReachedIndex = tree.add(qNew, parentIndex);
      parentIndex = lastReachedIndex;
      qNear = qNew;

      if (transformDistance(qNear, targetPose, options.rotationDistanceWeight) <= options.connectionEpsilon) {
        return { lastIndex: lastReachedIndex, reachedTarget: true };
      }
    }
    return { lastIndex: lastReachedIndex, reachedTarget: false };
  }

  function goalSeedSample() {
    const seedSpace = treeAIsStartTree ? treeB : treeA;
    const index = Math.floor(rng() * seedSpace.nodes.length);
    return cloneTransform(seedSpace.nodes[Math.min(index, seedSpace.nodes.length - 1)]);
  }

  for (let iter = 0; iter < options.maxIterations; iter += 1) {
    if (nowMs() - startTime > options.maxPlanningTimeMs) {
      stats.iterations = iter;
      stats.treeNodes = treeA.nodes.length + treeB.nodes.length;
      const startTreeRef = treeAIsStartTree ? treeA : treeB;
      const closestIndex = startTreeRef.nearest(target, options.rotationDistanceWeight);
      return {
        status: "not-found",
        reason: "time-budget-exceeded",
        bestAttempt: closestIndex >= 0 ? cloneTransform(startTreeRef.nodes[closestIndex]) : undefined,
        stats,
      };
    }

    const qRand = rng() < options.goalSampleProbability
      ? goalSeedSample()
      : sampler.sample();

    const aResult = constrainedExtend(treeA, qRand);
    if (aResult.lastIndex < 0) {
      [treeA, treeB] = [treeB, treeA];
      treeAIsStartTree = !treeAIsStartTree;
      continue;
    }
    const qReached = treeA.nodes[aResult.lastIndex];

    const bResult = constrainedExtend(treeB, qReached);
    if (bResult.lastIndex >= 0) {
      const qConnected = treeB.nodes[bResult.lastIndex];
      const connectionDistance = transformDistance(
        qReached,
        qConnected,
        options.rotationDistanceWeight,
      );
      if (connectionDistance <= options.connectionEpsilon) {
        const pathA = treeA.pathFromRoot(aResult.lastIndex);
        const pathB = treeB.pathFromRoot(bResult.lastIndex);
        let startTreePath;
        let goalTreePath;
        if (treeAIsStartTree) {
          startTreePath = pathA;
          goalTreePath = pathB;
        } else {
          startTreePath = pathB;
          goalTreePath = pathA;
        }
        // goalTreePath ends at the meeting point; drop it (already in
        // startTreePath) and reverse so traversal goes meeting -> goal-root.
        const tail = goalTreePath.slice(0, -1).reverse();
        const combined = [...startTreePath, ...tail];

        const smoothed = smoothPath({ path: combined, options, classify, rng });
        const densified = densifyPath(smoothed, options);

        stats.iterations = iter + 1;
        stats.treeNodes = treeA.nodes.length + treeB.nodes.length;
        stats.pathLength = pathLength(densified, options.rotationDistanceWeight);
        return {
          status: "found",
          transforms: densified,
          stats,
        };
      }
    }

    [treeA, treeB] = [treeB, treeA];
    treeAIsStartTree = !treeAIsStartTree;
  }

  stats.iterations = options.maxIterations;
  stats.treeNodes = treeA.nodes.length + treeB.nodes.length;
  const startTreeRef = treeAIsStartTree ? treeA : treeB;
  const closestIndex = startTreeRef.nearest(target, options.rotationDistanceWeight);
  return {
    status: "not-found",
    reason: "iteration-budget-exceeded",
    bestAttempt: closestIndex >= 0 ? cloneTransform(startTreeRef.nodes[closestIndex]) : undefined,
    stats,
  };
}
