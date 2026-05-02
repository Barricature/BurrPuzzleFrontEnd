# Burr Puzzle Frontend

Browser-based MVP for interacting with a simple 3D burr puzzle layout.  
The current runnable slice loads sample model assets with Three.js loaders, renders pieces in a Three.js scene, supports selection and transform controls, and shows basic collision/success status.

## Current State

- A working MVP exists in `index.html` + `src/mvp/app.js` + `src/mvp/styles.css`.
- Sample piece metadata is loaded from `public/sample-puzzle-manifest.js`.
- A lightweight Node static server in `server.js` powers local development.
- Refactor in progress: foundational modules now exist under `src/app/core` and `src/app/ui`, while orchestration still lives in `src/mvp/app.js`.
- Detailed snapshot: see `progress.md`.

## Install

### Requirements

- Node.js 18+ (or current LTS)
- npm (bundled with Node)

### Dependencies

Install project dependencies:

```bash
npm install
```

## Run The App

Start the local server:

```bash
npm run dev
```

Then open:

- `http://localhost:4173`

## Other Scripts

- `npm run build` - currently placeholder (`scripts/noop-build.js`)
- `npm test` - runs Node test runner (no tests implemented yet)

## Project Layout (Relevant Today)

- `index.html` - app shell and UI structure
- `src/mvp/app.js` - MVP logic, state, Three.js runtime, movement/collision logic
- `src/app/core/constants.js` - shared runtime constants extracted from MVP entrypoint
- `src/app/core/runtime.js` - centralized app runtime/state/elements containers
- `src/app/bootstrap/events.js` - extracted startup event wiring (global error hooks + UI control events)
- `src/app/ui/status.js` - shared status/inspector rendering helpers
- `src/features/interaction/selection/selectionState.js` - selection state operations extracted from MVP orchestration
- `src/features/interaction/selection/interactionHandlers.js` - extracted pointer/click interaction handlers
- `src/features/interaction/selection/targetResolver.js` - extracted raycast and screen-space target resolution
- `src/features/interaction/transform/inputBindings.js` - continuous keyboard movement/rotation bindings for selected pieces
- `src/features/matching/matchFlow.js` - extracted match action orchestration and debug output helpers
- `src/features/planning/sceneQuery.js` - extracted collision scene query + start-block debug diagnostics
- `src/features/planning/animationPlayer.js` - extracted planner transform application + animation playback
- `src/features/rendering/sceneBootstrap.js` - extracted scene setup, resize sync, canvas event wiring, and render-loop bootstrap
- `src/mvp/styles.css` - MVP styling
- `public/sample-puzzle-manifest.js` - sample piece sources and initial positions
- `server.js` - local static file server
- `progress.md` - current implementation progress tracker
