// The 3D view: one mesh (plus its CAD edges) per part, orbit controls, picking parts with a click,
// a "cut in half" section view, showing only the selected part, and showing what one detail does
// (plastic it takes away in red, plastic it adds in green). The rocket's axis is Z.

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import type { PartMesh } from "./session.ts";

interface Shown {
  group: THREE.Group;
  /** The outside, and the inside drawn darker so walls stand out in the cut view. */
  surface: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>;
  inside: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>;
  edges: THREE.LineSegments<THREE.BufferGeometry, THREE.LineBasicMaterial>;
  visible: boolean;
}

const SELECTED = new THREE.Color("#2f6fde");
const REMOVED = new THREE.Color("#e5484d");
const ADDED = new THREE.Color("#2fa36b");
const EDGE = new THREE.Color("#1d2330");

export class Viewer {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(35, 1, 1, 20000);
  private controls: OrbitControls;
  private parts = new Map<string, Shown>();
  private selected: string | null = null;
  private onlySelected = false;
  /** Hides the half of the rocket with Y < 0, the side the default view looks from, to show the cut. */
  private cutPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  private cut = false;
  private container: HTMLElement;
  /** What a detail does, drawn over the parts (see showDetail). */
  private highlight = new THREE.Group();
  onPick: (key: string | null) => void = () => {};

  constructor(container: HTMLElement) {
    this.container = container;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.localClippingEnabled = true;
    container.appendChild(this.renderer.domElement);

    this.camera.up.set(0, 0, 1);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.addEventListener("change", () => this.render());

    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x8a8f99, 2.2));
    const sun = new THREE.DirectionalLight(0xffffff, 1.6);
    sun.position.set(-400, -900, 1200);
    this.camera.add(sun); // light follows the camera so every side is readable
    this.scene.add(this.camera);
    this.scene.add(this.highlight);

    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
    this.pickOnClick();
  }

  setPart(key: string, mesh: PartMesh, color: string): void {
    this.remove(key);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(mesh.vertices, 3));
    geometry.setAttribute("normal", new THREE.BufferAttribute(mesh.normals, 3));
    geometry.setIndex(new THREE.BufferAttribute(mesh.triangles, 1));
    const c = new THREE.Color(color);
    const material = (side: THREE.Side, shade: THREE.Color) =>
      new THREE.MeshStandardMaterial({
        color: shade,
        roughness: 0.65,
        metalness: 0,
        side,
        polygonOffset: true,
        polygonOffsetFactor: 1,
        polygonOffsetUnits: 1,
      });
    const surface = new THREE.Mesh(geometry, material(THREE.FrontSide, c));
    const inside = new THREE.Mesh(geometry, material(THREE.BackSide, c.clone().multiplyScalar(0.45)));
    const edgeGeometry = new THREE.BufferGeometry();
    edgeGeometry.setAttribute("position", new THREE.BufferAttribute(mesh.edges, 3));
    const edges = new THREE.LineSegments(edgeGeometry, new THREE.LineBasicMaterial({ color: EDGE, transparent: true, opacity: 0.55 }));
    const group = new THREE.Group();
    group.add(surface, inside, edges);
    surface.userData.key = inside.userData.key = key;
    const old = this.parts.get(key);
    this.parts.set(key, { group, surface, inside, edges, visible: old?.visible ?? true });
    this.scene.add(group);
    this.refresh();
  }

  remove(key: string): void {
    const p = this.parts.get(key);
    if (!p) return;
    this.scene.remove(p.group);
    p.surface.geometry.dispose();
    p.surface.material.dispose();
    p.inside.material.dispose();
    p.edges.geometry.dispose();
    p.edges.material.dispose();
    this.parts.delete(key);
  }

  clear(): void {
    for (const key of [...this.parts.keys()]) this.remove(key);
    this.selected = null;
    this.showDetail(null);
  }

  /**
   * Shows what one detail does: the plastic it takes away (red) and adds (green), drawn through
   * the part so a pocket inside it shows too, while the rest of the part fades. null clears it.
   */
  showDetail(shape: { removed?: PartMesh; added?: PartMesh } | null): void {
    for (const child of [...this.highlight.children]) {
      this.highlight.remove(child);
      const m = child as THREE.Mesh<THREE.BufferGeometry, THREE.Material>;
      m.geometry.dispose();
      m.material.dispose();
    }
    for (const [mesh, color] of [
      [shape?.removed, REMOVED],
      [shape?.added, ADDED],
    ] as const) {
      if (!mesh) continue;
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.BufferAttribute(mesh.vertices, 3));
      geometry.setAttribute("normal", new THREE.BufferAttribute(mesh.normals, 3));
      geometry.setIndex(new THREE.BufferAttribute(mesh.triangles, 1));
      const solid = new THREE.Mesh(
        geometry,
        new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.35, depthTest: false, transparent: true, opacity: 0.9 }),
      );
      solid.renderOrder = 10;
      this.highlight.add(solid);
    }
    this.refresh();
  }

  setVisible(key: string, visible: boolean): void {
    const p = this.parts.get(key);
    if (p) p.visible = visible;
    this.refresh();
  }

  select(key: string | null): void {
    this.selected = key;
    this.refresh();
  }

  setCut(on: boolean): void {
    this.cut = on;
    this.refresh();
  }

  setOnlySelected(on: boolean): void {
    this.onlySelected = on;
    this.refresh();
    this.fit();
  }

  /** Frames everything that is showing, looking at the rocket from the side. */
  fit(): void {
    const box = new THREE.Box3();
    for (const p of this.parts.values()) if (p.group.visible) box.expandByObject(p.group);
    if (box.isEmpty()) return;
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    const distance = (sphere.radius / Math.sin(THREE.MathUtils.degToRad(this.camera.fov / 2))) * 1.05;
    const direction = new THREE.Vector3(0.35, -1, 0.25).normalize();
    this.camera.position.copy(sphere.center).addScaledVector(direction, distance);
    this.camera.near = distance / 100;
    this.camera.far = distance * 100;
    this.camera.updateProjectionMatrix();
    this.controls.target.copy(sphere.center);
    this.controls.update();
    this.render();
  }

  private refresh(): void {
    for (const [key, p] of this.parts) {
      p.group.visible = p.visible && (!this.onlySelected || this.selected === null || key === this.selected);
      const planes = this.cut ? [this.cutPlane] : [];
      const chosen = key === this.selected;
      // Showing a detail: the parts fade so it stands out.
      const faded = this.highlight.children.length > 0;
      for (const m of [p.surface.material, p.inside.material]) {
        m.clippingPlanes = planes;
        m.transparent = faded;
        m.opacity = faded ? 0.35 : 1;
        m.depthWrite = !faded;
        m.emissive.copy(chosen ? SELECTED : new THREE.Color(0));
        m.emissiveIntensity = chosen ? 0.35 : 0;
      }
      p.edges.material.clippingPlanes = planes;
      p.edges.material.color.copy(chosen ? SELECTED : EDGE);
      p.edges.material.opacity = chosen ? 1 : 0.55;
    }
    for (const child of this.highlight.children) {
      ((child as THREE.Mesh).material as THREE.Material).clippingPlanes = this.cut ? [this.cutPlane] : [];
    }
    this.render();
  }

  private pickOnClick(): void {
    const canvas = this.renderer.domElement;
    let down: { x: number; y: number } | null = null;
    canvas.addEventListener("pointerdown", (e) => (down = { x: e.clientX, y: e.clientY }));
    canvas.addEventListener("pointerup", (e) => {
      if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4) return; // a drag, not a click
      const rect = canvas.getBoundingClientRect();
      const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
      const ray = new THREE.Raycaster();
      ray.setFromCamera(ndc, this.camera);
      const surfaces = [...this.parts.values()].filter((p) => p.group.visible).flatMap((p) => [p.surface, p.inside]);
      const hit = ray.intersectObjects(surfaces, false).find((h) => !this.cut || this.cutPlane.distanceToPoint(h.point) >= 0);
      this.onPick(hit ? (hit.object.userData.key as string) : null);
    });
  }

  private resize(): void {
    const { clientWidth: w, clientHeight: h } = this.container;
    if (!w || !h) return;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.render();
  }

  private render(): void {
    this.renderer.render(this.scene, this.camera);
  }
}
