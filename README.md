# Burr Puzzle Frontend

A browser app for trying 3D burr-puzzle assembly and disassembly moves.

## Quick Start

1. Install Node.js 18+.
2. Install dependencies:

```bash
npm install
```

3. Start the app:

```bash
npm run dev
```

4. Open the URL shown in terminal (usually `http://localhost:5173`).

## How To Use

### Select a piece

- Click a piece in the left panel.

### Move / rotate the selected piece

- `W/A/S/D`: move in screen-parallel directions
- `Q/E`: rotate around screen-parallel axis
- `Left/Right`: rotate around ground-parallel axis
- `R/F`: rotate around axis orthogonal to ground and screen

If a move would cause penetration, it is blocked and rolled back.

### Face Match workflow

1. Left-click one face on the fixed piece.
2. Left-click one face on the moving piece.
3. (Optional) add edge/vertex constraints for disambiguation.
4. Click `Match` to compute and play the path.
5. Use `Clear Selection` to restart picks.

## Status Bar

- `Load`: asset loading status
- `Collision`: `Clear` or `Blocked`
- `Success`: current match outcome

## Troubleshooting

- **App does not open:** make sure `npm run dev` is running and use its printed URL.
- **Match fails:** clear selections and pick faces again in fixed-then-moving order.
- **Piece cannot move:** collision guard is preventing penetration; try another direction.

## For Maintainers

- Build production bundle: `npm run build`
- Preview production build: `npm run preview`
- GitHub Pages auto-deploy workflow: `.github/workflows/deploy-pages.yml`
