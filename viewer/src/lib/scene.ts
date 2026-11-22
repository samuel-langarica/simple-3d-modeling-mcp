/**
 * The three.js scene: model, edges, grid, axes, lights and orbit camera.
 * OpenSCAD is Z-up, so the scene is too.
 */

import {
  BufferAttribute,
  BufferGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DirectionalLight,
  DoubleSide,
  EdgesGeometry,
  GridHelper,
  Group,
  HemisphereLight,
  LineBasicMaterial,
  LineSegments,
  MathUtils,
  Mesh,
  MeshBasicMaterial,
  MeshPhongMaterial,
  MOUSE,
  Object3D,
  PerspectiveCamera,
  Scene,
  Vector3,
  WebGLRenderer,
} from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import type { ViewerMesh } from "./mesh.js";

Object3D.DEFAULT_UP.set(0, 0, 1); // OpenSCAD is Z-up

/**
 * Line colours per theme. The canvas is transparent and the page paints the
 * paper behind it, so these are matched to the tokens in app.css: ink on
 * paper (#f3efe6) for light, white on blueprint blue (#143560) for dark.
 */
const THEMES = {
  light: {
    ground: 0x909090,
    edges: { color: 0x161616, opacity: 0.6 },
    grid: { center: 0xa6a39d, lines: 0xd8d5cd },
    axes: [0xd63c26, 0x2e8b4f, 0x2456b0],
  },
  dark: {
    ground: 0x3a5478,
    edges: { color: 0xf0f5fc, opacity: 0.7 },
    grid: { center: 0x768caa, lines: 0x375377 },
    axes: [0xff5a45, 0x2fd27a, 0x5ba3ff],
  },
} as const;

/** Per axis: the solid arrow, and its "hidden line" twin that shows faintly through the model. */
interface AxisMaterials {
  solid: MeshBasicMaterial;
  hidden: MeshBasicMaterial;
}

/**
 * X, Y and Z arrows of unit length (scaled to each model): a shaft and a cone
 * tip each, flat-coloured like ink. Lines would be 1px wide on most GPUs.
 * Where the model is in front of an arrow, its hidden twin draws it faintly,
 * as a technical drawing shows hidden edges.
 */
function buildAxes(materials: AxisMaterials[]): Group {
  const shaft = new CylinderGeometry(0.009, 0.009, 0.86, 12).translate(0, 0.43, 0); // along +Y
  const tip = new ConeGeometry(0.035, 0.14, 20).translate(0, 0.93, 0);
  const group = new Group();
  // Turn +Y onto +X, +Y and +Z.
  [[0, 0, -Math.PI / 2], [0, 0, 0], [Math.PI / 2, 0, 0]].forEach(([x, y, z], i) => {
    for (const geometry of [shaft, tip]) {
      for (const material of [materials[i].solid, materials[i].hidden]) {
        const arrow = new Mesh(geometry, material);
        arrow.rotation.set(x, y, z);
        group.add(arrow);
      }
    }
  });
  group.visible = false;
  return group;
}

export class ViewerScene {
  readonly #scene = new Scene();
  readonly #camera = new PerspectiveCamera(40, 1, 0.1, 10000);
  readonly #renderer = new WebGLRenderer({ antialias: true, alpha: true });
  readonly #controls: OrbitControls;
  readonly #hemi = new HemisphereLight(0xffffff, 0x404060, 1.2);
  readonly #key = new DirectionalLight(0xffffff, 1.6);
  readonly #fill = new DirectionalLight(0x8899ff, 0.5);
  readonly #material = new MeshPhongMaterial({
    vertexColors: true, flatShading: true, shininess: 40, specular: 0x222222, side: DoubleSide,
    polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1, // keep edge lines on top
  });
  readonly #edgeMaterial = new LineBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.45 });
  /** X-ray: everything outside the focus colours, drawn as a faint ghost that never hides what is behind it. */
  readonly #ghostMaterial = new MeshPhongMaterial({
    vertexColors: true, flatShading: true, side: DoubleSide, transparent: true, opacity: 0.1, depthWrite: false,
  });
  readonly #ghostEdgeMaterial = new LineBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.18, depthWrite: false });
  readonly #axisMaterials: AxisMaterials[] = [0, 1, 2].map(() => ({
    solid: new MeshBasicMaterial(),
    // Transparent, so it draws after the model; without a depth test, it shows through it.
    hidden: new MeshBasicMaterial({ transparent: true, opacity: 0.3, depthTest: false, depthWrite: false }),
  }));
  readonly #axes = buildAxes(this.#axisMaterials);

  #dark = true;
  #showEdges = true;
  #showGrid = true;
  #modelColor = new Color("#ff8c00");
  #grid: GridHelper | null = null;
  #gridSize = 200;
  #mesh: Mesh | null = null;
  #edges: LineSegments | null = null;
  #ghost: Mesh | null = null;
  #ghostEdges: LineSegments | null = null;
  #data: ViewerMesh | null = null;
  #offset = new Vector3();
  #xray = false;
  /** Packed sRGB colours (0xRRGGBB) kept solid in X-ray mode; empty = ghost everything. */
  #focus: number[] = [];
  /** Per triangle: 1 = painted with the model colour. */
  #defaultMask: Uint8Array | null = null;
  #home: { position: Vector3; target: Vector3 } | null = null;
  #lastRadius = 0;

  /** `onAutoRotateStop` runs when a drag, touch or scroll turns auto-rotate off. */
  constructor({ onAutoRotateStop }: { onAutoRotateStop?: () => void } = {}) {
    this.#renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.#renderer.setClearColor(0x000000, 0); // the page's paper shows through
    this.#controls = new OrbitControls(this.#camera, this.#renderer.domElement);
    this.#controls.enableDamping = true;
    this.#controls.autoRotateSpeed = 1.5;
    // Middle-drag pans, like right-drag (the scroll wheel already zooms), as in most CAD tools.
    this.#controls.mouseButtons = { LEFT: MOUSE.ROTATE, MIDDLE: MOUSE.PAN, RIGHT: MOUSE.PAN };
    // Keep the browser's middle-click autoscroll from starting as well.
    this.#renderer.domElement.addEventListener("mousedown", (e) => {
      if (e.button === 1) e.preventDefault();
    });
    // Taking hold of the model hands the camera back to the user.
    this.#controls.addEventListener("start", () => {
      if (!this.#controls.autoRotate) return;
      this.#controls.autoRotate = false;
      onAutoRotateStop?.();
    });
    this.#hemi.position.set(0, 0, 1);
    this.#scene.add(this.#hemi, this.#key, this.#fill, this.#axes);
    this.#applyTheme();
  }

  /** Puts the canvas into `container`, sizes it to fit and starts rendering. Returns the undo. */
  mount(container: HTMLElement): () => void {
    container.appendChild(this.#renderer.domElement);
    const resize = () => {
      const w = container.clientWidth, h = container.clientHeight;
      if (!w || !h) return;
      this.#camera.aspect = w / h;
      // Lens shift: the picture moves up to centre the model in the space above the
      // toolbar, while the camera still orbits the model's centre.
      this.#camera.setViewOffset(w, h, 0, Math.round(Math.min(36, h * 0.05)), w, h);
      this.#renderer.setSize(w, h);
    };
    const observer = new ResizeObserver(resize);
    observer.observe(container);
    resize();
    this.#renderer.setAnimationLoop(() => {
      this.#controls.update();
      this.#renderer.render(this.#scene, this.#camera);
    });
    return () => {
      this.#renderer.setAnimationLoop(null);
      observer.disconnect();
      this.#renderer.domElement.remove();
    };
  }

  setTheme(dark: boolean): void {
    if (dark === this.#dark) return;
    this.#dark = dark;
    this.#applyTheme();
  }

  setEdges(visible: boolean): void {
    this.#showEdges = visible;
    if (this.#edges) this.#edges.visible = visible;
    if (this.#ghostEdges) this.#ghostEdges.visible = visible;
  }

  /** X-ray mode: only triangles in the focus colours stay solid; the rest becomes a faint ghost. */
  setXray(on: boolean): void {
    if (on === this.#xray) return;
    this.#xray = on;
    this.#buildModel();
  }

  /** Focus colours for X-ray mode, packed 0xRRGGBB. */
  setXrayFocus(colors: number[]): void {
    const same = colors.length === this.#focus.length && colors.every((c, i) => c === this.#focus[i]);
    if (same) return;
    this.#focus = colors;
    if (this.#xray) this.#buildModel();
  }

  setWireframe(on: boolean): void {
    this.#material.wireframe = on;
    this.#ghostMaterial.wireframe = on;
  }

  setAutoRotate(on: boolean): void {
    this.#controls.autoRotate = on;
  }

  /** Shows or hides the grid and the axes. */
  setGrid(visible: boolean): void {
    this.#showGrid = visible;
    if (this.#grid) this.#grid.visible = visible;
    this.#axes.visible = visible && this.#data !== null;
  }

  /** Colour for parts without color(). */
  setModelColor(hex: string): void {
    this.#modelColor = new Color(hex);
    this.#paintColors();
  }

  resetView(): void {
    if (!this.#home) return;
    this.#camera.position.copy(this.#home.position);
    this.#controls.target.copy(this.#home.target);
  }

  /** Replaces the model. Keeps the camera unless the model's size changed a lot. */
  load(data: ViewerMesh): void {
    const geo = new BufferGeometry();
    geo.setAttribute("position", new BufferAttribute(data.positions, 3));
    geo.computeBoundingBox();
    const box = geo.boundingBox!;
    geo.dispose();

    const hadModel = this.#mesh !== null || this.#ghost !== null;
    this.#data = data;
    this.#defaultMask = data.defaultMask;
    const c = box.getCenter(new Vector3());
    // Sit the model on the grid, centred in X/Y.
    const offset = new Vector3(-c.x, -c.y, -box.min.z);
    this.#offset = offset;
    this.#buildModel();

    const size = box.getSize(new Vector3());
    const radius = Math.max(size.length() / 2, 0.5);
    this.#rebuildGrid(Math.max(50, Math.ceil((Math.max(size.x, size.y) * 2) / 50) * 50));
    // From just outside the model's -X/-Y corner, so the arrows don't hide along its bottom edges.
    const axisLength = Math.max(size.x, size.y, size.z) * 0.6;
    const margin = Math.max(size.x, size.y) * 0.08;
    this.#axes.scale.setScalar(axisLength);
    this.#axes.position.set(offset.x + box.min.x - margin, offset.y + box.min.y - margin, 0.009 * axisLength);
    this.#axes.visible = this.#showGrid;

    const target = new Vector3(0, 0, size.z / 2);
    const d = (radius / Math.sin(MathUtils.degToRad(this.#camera.fov / 2))) * 1.3;
    const dir = new Vector3(0.62, -0.95, 0.65).normalize();
    this.#home = { position: target.clone().addScaledVector(dir, d), target };
    this.#camera.near = radius / 100;
    this.#camera.far = radius * 100;
    this.#camera.updateProjectionMatrix();
    // Keep the user's camera while iterating on similar-sized models; re-frame on big size changes.
    const ratio = this.#lastRadius ? radius / this.#lastRadius : 0;
    if (!hadModel || ratio > 1.6 || ratio < 0.6) this.resetView();
    this.#lastRadius = radius;
    this.#key.position.set(radius * 2, -radius * 3, radius * 4);
    this.#fill.position.set(-radius * 3, radius * 2, -radius);
  }

  /** (Re)creates the meshes from #data: one solid mesh, or in X-ray mode a solid focus mesh plus a ghost mesh. */
  #buildModel(): void {
    const data = this.#data;
    this.#removeModel();
    if (!data) return;
    const n = data.triangles;
    let solidSel: Uint8Array | null = null; // null = every triangle solid
    if (this.#xray) {
      solidSel = new Uint8Array(n);
      const focus = this.#focus;
      if (focus.length) {
        for (let t = 0; t < n; t++) {
          const c = data.srgb[t];
          if (c < 0) continue;
          for (const f of focus) {
            // Small tolerance: colours go through OpenSCAD and back as bytes.
            if (Math.abs(((c >> 16) & 255) - ((f >> 16) & 255)) <= 2 && Math.abs(((c >> 8) & 255) - ((f >> 8) & 255)) <= 2 && Math.abs((c & 255) - (f & 255)) <= 2) {
              solidSel[t] = 1;
              break;
            }
          }
        }
      }
    }
    const solid = this.#subset(data, solidSel, 1);
    if (solid) {
      this.#mesh = new Mesh(solid.geo, this.#material);
      this.#mesh.userData.mask = solid.mask;
      this.#edges = new LineSegments(new EdgesGeometry(solid.geo, 35), this.#edgeMaterial);
      this.#edges.visible = this.#showEdges;
    }
    if (solidSel) {
      const ghost = this.#subset(data, solidSel, 0);
      if (ghost) {
        this.#ghost = new Mesh(ghost.geo, this.#ghostMaterial);
        this.#ghost.userData.mask = ghost.mask;
        this.#ghost.renderOrder = 1; // after the solid parts
        this.#ghostEdges = new LineSegments(new EdgesGeometry(ghost.geo, 35), this.#ghostEdgeMaterial);
        this.#ghostEdges.visible = this.#showEdges;
        this.#ghostEdges.renderOrder = 1;
      }
    }
    for (const obj of [this.#mesh, this.#edges, this.#ghost, this.#ghostEdges]) {
      if (!obj) continue;
      obj.position.copy(this.#offset);
      this.#scene.add(obj);
    }
    this.#paintColors();
  }

  /** Geometry of the triangles whose `sel` byte equals `want` (all of them when `sel` is null). */
  #subset(data: ViewerMesh, sel: Uint8Array | null, want: number): { geo: BufferGeometry; mask: Uint8Array } | null {
    let count = data.triangles;
    if (sel) {
      count = 0;
      for (let t = 0; t < data.triangles; t++) if (sel[t] === want) count++;
    }
    if (!count) return null;
    let positions = data.positions, colors = data.colors, mask = data.defaultMask;
    if (sel) {
      positions = new Float32Array(count * 9);
      colors = new Float32Array(count * 9);
      mask = new Uint8Array(count);
      let j = 0;
      for (let t = 0; t < data.triangles; t++) {
        if (sel[t] !== want) continue;
        positions.set(data.positions.subarray(t * 9, t * 9 + 9), j * 9);
        colors.set(data.colors.subarray(t * 9, t * 9 + 9), j * 9);
        mask[j++] = data.defaultMask[t];
      }
    } else {
      colors = new Float32Array(data.colors); // painted in place by #paintColors
    }
    const geo = new BufferGeometry();
    geo.setAttribute("position", new BufferAttribute(positions, 3));
    geo.setAttribute("color", new BufferAttribute(colors, 3));
    geo.computeVertexNormals();
    return { geo, mask };
  }

  dispose(): void {
    this.#renderer.setAnimationLoop(null);
    this.#removeModel();
    this.#grid?.dispose();
    this.#controls.dispose();
    this.#material.dispose();
    this.#edgeMaterial.dispose();
    this.#ghostMaterial.dispose();
    this.#ghostEdgeMaterial.dispose();
    const axisGeometries = new Set(this.#axes.children.map((c) => (c as Mesh).geometry));
    for (const geometry of axisGeometries) geometry.dispose();
    for (const { solid, hidden } of this.#axisMaterials) {
      solid.dispose();
      hidden.dispose();
    }
    this.#renderer.dispose();
    // dispose() keeps the WebGL context; release it so hot reloads don't pile them up.
    this.#renderer.forceContextLoss();
  }

  get #theme() {
    return this.#dark ? THEMES.dark : THEMES.light;
  }

  #applyTheme(): void {
    const theme = this.#theme;
    this.#hemi.groundColor.set(theme.ground);
    this.#edgeMaterial.color.set(theme.edges.color);
    this.#edgeMaterial.opacity = theme.edges.opacity;
    theme.axes.forEach((color, i) => {
      this.#axisMaterials[i].solid.color.set(color);
      this.#axisMaterials[i].hidden.color.set(color);
    });
    this.#rebuildGrid(this.#gridSize);
  }

  #rebuildGrid(size: number): void {
    if (this.#grid) {
      this.#scene.remove(this.#grid);
      this.#grid.dispose();
    }
    const { center, lines } = this.#theme.grid;
    const grid = new GridHelper(size, Math.min(100, Math.round(size / 10)), center, lines);
    grid.rotation.x = Math.PI / 2; // XY plane
    grid.visible = this.#showGrid;
    this.#grid = grid;
    this.#gridSize = size;
    this.#scene.add(grid);
  }

  #removeModel(): void {
    for (const obj of [this.#mesh, this.#edges, this.#ghost, this.#ghostEdges]) {
      if (!obj) continue;
      this.#scene.remove(obj);
      obj.geometry.dispose();
    }
    this.#mesh = this.#edges = this.#ghost = this.#ghostEdges = null;
  }

  #paintColors(): void {
    const { r, g, b } = this.#modelColor;
    for (const mesh of [this.#mesh, this.#ghost]) {
      const mask = mesh?.userData.mask as Uint8Array | undefined;
      if (!mesh || !mask) continue;
      const col = mesh.geometry.getAttribute("color") as BufferAttribute;
      for (let t = 0; t < mask.length; t++) {
        if (!mask[t]) continue;
        for (let k = 0; k < 3; k++) col.setXYZ(t * 3 + k, r, g, b);
      }
      col.needsUpdate = true;
    }
  }
}
