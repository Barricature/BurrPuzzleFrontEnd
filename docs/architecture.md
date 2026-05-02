# Architecture Refactor Plan (Post-MVP)

This document tracks the migration from a single-file MVP implementation to a modular application architecture.

## Goals

- Reduce coupling inside `src/mvp/app.js`.
- Move domain and runtime contracts into stable modules.
- Keep behavior unchanged during migration.
- Make later testing and feature extension easier.

## Target Module Layout

- `src/app/core/`
  - `constants.js`: shared runtime constants.
  - `runtime.js`: `sceneRuntime`, app `state`, and DOM `elements`.
- `src/app/ui/`
  - `status.js`: status + inspector render helpers.
- `src/features/`
  - matching, planning, and loading logic (existing TypeScript feature modules).
- `src/mvp/`
  - thin orchestration layer while migration is ongoing.

## Migration Phases

1. **Phase 1 (Done): Core extraction**
   - Move constants/runtime containers and status helpers into dedicated modules.
   - Keep `src/mvp/app.js` as orchestrator.
2. **Phase 2 (Done): Interaction extraction**
   - Move selection target resolution + hover/click handlers into feature modules.
3. **Phase 3 (Done): Match/planner orchestration split**
   - Separate match flow coordinator from scene synchronization/animation code.
4. **Phase 4 (Done): Final cleanup**
   - Remove obsolete placeholder files/folders and reduce `src/mvp/app.js` to boot wiring.

## Current Status

- Core runtime constants/state/UI status logic has been extracted.
- `src/mvp/app.js` now imports from `src/app/core/*` and `src/app/ui/*`.
- Selection state operations are now extracted to `src/features/interaction/selection/selectionState.js`
  and consumed from `src/mvp/app.js` wrappers.
- Scene interaction handlers are now extracted to
  `src/features/interaction/selection/interactionHandlers.js`
  and consumed from `src/mvp/app.js` wrappers.
- Pointer target resolution and screen-space picking helpers are now extracted to
  `src/features/interaction/selection/targetResolver.js`
  and consumed from `src/mvp/app.js` wrappers.
- Match orchestration helpers are now extracted to
  `src/features/matching/matchFlow.js`
  and consumed from `src/mvp/app.js` wrappers.
- Collision scene-query construction and start-block diagnostics are now extracted to
  `src/features/planning/sceneQuery.js`
  and consumed from `src/mvp/app.js` wrappers.
- Planner transform application and animation playback are now extracted to
  `src/features/planning/animationPlayer.js`
  and consumed from `src/mvp/app.js` wrappers.
- Dead passthrough wrappers that were no longer referenced were removed from `src/mvp/app.js`
  to keep the orchestrator lean without behavior changes.
- Additional single-use wrapper functions were inlined into `runMatchFlow()` dependency
  injection, further reducing orchestration boilerplate.
- Bootstrap event wiring (global error hooks and UI button/modal event registration) is now
  extracted to `src/app/bootstrap/events.js`.
- Scene creation/render bootstrap and canvas event registration are now extracted to
  `src/features/rendering/sceneBootstrap.js`.
- Selection/match interaction dependencies now mostly use direct injected lambdas instead of
  local pass-through wrappers in `src/mvp/app.js`.
- Continuous keyboard transform bindings are now modularized in
  `src/features/interaction/transform/inputBindings.js` and advanced via frame callbacks.
- Behavior parity is preserved (no intentional interaction changes).
