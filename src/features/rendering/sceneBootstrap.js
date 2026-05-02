export function createSceneBootstrap({
  THREE,
  OrbitControls,
  elements,
  sceneRuntime,
  onPointerMove,
  onPointerLeave,
  onLeftClick,
  onContextMenu,
}) {
  function updateEdgeLineResolutions(width, height) {
    for (const object of sceneRuntime.pieceObjects.values()) {
      object.traverse((child) => {
        if (child.userData?.componentType !== "edge") {
          return;
        }
        if (!child.material?.isLineMaterial) {
          return;
        }
        child.material.resolution.set(width, height);
      });
    }
  }

  function resizeRenderer() {
    if (!sceneRuntime.renderer) {
      return;
    }

    const width = Math.max(elements.scene.clientWidth, 1);
    const height = Math.max(elements.scene.clientHeight, 1);
    sceneRuntime.camera.aspect = width / height;
    sceneRuntime.camera.updateProjectionMatrix();
    sceneRuntime.renderer.setSize(width, height, false);
    updateEdgeLineResolutions(width, height);
  }

  function renderThreeScene() {
    if (!sceneRuntime.renderer) {
      return;
    }
    sceneRuntime.controls.update();
    sceneRuntime.renderer.render(sceneRuntime.scene, sceneRuntime.camera);
  }

  function renderLoop() {
    renderThreeScene();
    window.requestAnimationFrame(renderLoop);
  }

  function ensureScene() {
    if (sceneRuntime.renderer) {
      return;
    }

    const scene = new THREE.Scene();
    scene.background = new THREE.Color("#fbf5ec");

    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
    camera.position.set(8, 12, 12);

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    elements.scene.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.target.set(0, 1.5, 0);
    sceneRuntime.raycaster.params.Line.threshold = 0.08;

    scene.add(new THREE.AmbientLight("#fff6eb", 1.3));
    const keyLight = new THREE.DirectionalLight("#ffffff", 1.1);
    keyLight.position.set(6, 12, 8);
    keyLight.castShadow = true;
    scene.add(keyLight);

    const fillLight = new THREE.DirectionalLight("#ffd8b8", 0.7);
    fillLight.position.set(-8, 6, -6);
    scene.add(fillLight);

    scene.add(new THREE.AxesHelper(4.5));

    sceneRuntime.scene = scene;
    sceneRuntime.camera = camera;
    sceneRuntime.renderer = renderer;
    sceneRuntime.controls = controls;

    renderer.domElement.addEventListener("pointermove", onPointerMove);
    renderer.domElement.addEventListener("pointerleave", onPointerLeave);
    renderer.domElement.addEventListener("click", onLeftClick);
    renderer.domElement.addEventListener("contextmenu", onContextMenu);

    window.addEventListener("resize", () => {
      resizeRenderer();
      renderThreeScene();
    });

    resizeRenderer();
    renderLoop();
  }

  return {
    ensureScene,
    resizeRenderer,
    renderThreeScene,
  };
}
