# Burr Puzzle Frontend

Browser-based MVP for interacting with a simple 3D burr puzzle layout.  
The current runnable slice loads sample model assets with Three.js loaders, renders pieces in a Three.js scene, supports selection and transform controls, and shows basic collision/success status.

## Current State

- A working MVP exists in `index.html` + `src/mvp/app.js` + `src/mvp/styles.css`.
- Sample piece metadata is loaded from `public/sample-puzzle-manifest.js`.
- A lightweight Node static server in `server.js` powers local development.
- The broader TypeScript architecture under `src/app`, `src/domain`, `src/features`, `src/shared`, and `src/ui` is still mostly placeholder scaffolding.
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
- `src/mvp/styles.css` - MVP styling
- `public/sample-puzzle-manifest.js` - sample piece sources and initial positions
- `server.js` - local static file server
- `progress.md` - current implementation progress tracker
