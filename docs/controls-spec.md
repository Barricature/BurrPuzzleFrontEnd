# Controls Spec

## Keyboard

- <kbd>W</kbd> / <kbd>A</kbd> / <kbd>S</kbd> / <kbd>D</kbd>: translate selected piece in screen-parallel directions.
- <kbd>↑</kbd> / <kbd>↓</kbd>: move farther/nearer along screen depth.
- <kbd>Q</kbd> / <kbd>E</kbd>: rotate selected piece around an axis parallel to the screen.
- <kbd>←</kbd> / <kbd>→</kbd>: rotate selected piece around an axis parallel to the ground.
- <kbd>R</kbd> / <kbd>F</kbd>: rotate selected piece around an axis orthogonal to both ground and screen.

Everything is applied to the current selected object

## Mouse

- <kbd>Right Click</kbd>: select an object (selecting another object replaces the current one).
- <kbd>Left Click</kbd>: select a face on the currently selected object.
- <kbd>Ctrl</kbd> + <kbd>Left Click</kbd> + drag: orbit/drag the full scene view.
- `Clear Selection` button: clears object + face + edge + vertex selections and resets match stage to face.
- Empty-space click behavior:
  - <kbd>Left Click</kbd> on empty area clears selected faces.
  - <kbd>Right Click</kbd> on empty area clears selected object.

## Match Action

- `Match` button: align two selected surfaces.
- If multiple valid alignments exist, prompt for edge selection.
- If still ambiguous, prompt for vertex selection.
- In edge/vertex stages, selection sensitivity is increased for usability:
  - hover/select hit area for edges is `5x` base edge thickness
  - hover/select hit area for vertices is `5x` base vertex pick radius
  - selected edges render at `3x` thickness.
- Stage lifecycle:
  - when Match reaches terminal `success` or `failure`, edge/vertex selections are cleared automatically
  - when Match requests more constraints (`need-edge`, `need-vertex`), prior face selections remain.

## 2D Screen to 3D Object Selection Strategy

- Use a raycast from camera through the current mouse position to determine which 3D object is under the cursor.
- Convert mouse coordinates from viewport pixels to normalized device coordinates:
  - `x_ndc = ((x - rect.left) / rect.width) * 2 - 1`
  - `y_ndc = -((y - rect.top) / rect.height) * 2 + 1`
- Build ray with `raycaster.setFromCamera(pointerNdc, camera)` and intersect against puzzle piece objects.
- Interaction state model:
  - `selectedObject`: max one at a time.
  - `selectedFaces`: max two at a time (queue behavior).
- Hover behavior:
  - If no object is selected:
    - Hover highlights only the full piece/object.
    - No per-face/per-edge/per-vertex hover highlight.
  - If an object is selected:
    - Hover over the selected object resolves face targets only.
    - Hover highlight is face-only (no edge or vertex highlight).
- Right click behavior (`contextmenu`):
  - Right click on a piece selects that object.
  - If another object was already selected, it is deselected and replaced by the new one.
  - Right click on empty area clears object selection.
  - Selecting an object does not clear already selected face highlights.
- Left click behavior:
  - Only active when an object is selected.
  - Left click on a face of the selected object selects that face.
  - Left click on empty area clears selected face queue.
  - On face selection, object selection is cleared first, then face highlight is applied.
- Edge/vertex picking algorithm (stage-specific):
  - In `edge` or `vertex` stage, use screen-space proximity tests instead of thin-geometry ray hits:
    - project candidate endpoints/points to screen
    - compute 2D cursor distance to edge segment / vertex point
    - accept if within stage threshold (`5x` base)
    - resolve ties by nearest distance, then by depth
  - This improves reliability for thin components while preserving normal raycast behavior for object/face selection.
  - Empty-space left clicks in edge/vertex stages are non-destructive (do not clear existing face/edge/vertex selections).
- Selection limits:
  - Max one selected object at a time.
  - Max two selected faces at a time; selecting a third face removes the oldest selected face.
