import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';

// 모델은 KayKit(Kay Lousberg, CC0) 팩에서 가져와 scripts/build-assets.mjs 로 변환한 것이다.
const NAMES = [
  'knight', 'minion', 'warrior', 'mage', 'blade', 'axe', 'staff', 'shield',
  'chest', 'pillar', 'column', 'torch', 'barrel', 'crates',
] as const;
export type AssetName = (typeof NAMES)[number];

const store = new Map<AssetName, { scene: THREE.Group; clips: THREE.AnimationClip[] }>();

/** 모바일에서 가볍게 돌도록 PBR 재질을 Lambert 로 바꾼다. 발광 재질(해골 눈)은 unlit 으로. */
function simplify(scene: THREE.Object3D) {
  const converted = new Map<THREE.Material, THREE.Material>();
  scene.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const src = mesh.material as THREE.MeshStandardMaterial;
    let m = converted.get(src);
    if (!m) {
      const glow = src.emissive && src.emissive.getHex() !== 0;
      m = glow
        ? new THREE.MeshBasicMaterial({ color: src.emissive })
        : new THREE.MeshLambertMaterial({ map: src.map, color: src.color });
      m.name = src.name;
      converted.set(src, m);
      src.dispose();
    }
    mesh.material = m;
  });
}

export async function loadAssets(onProgress: (ratio: number) => void) {
  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);
  let done = 0;
  await Promise.all(
    NAMES.map(async (name) => {
      const gltf = await loader.loadAsync(`${import.meta.env.BASE_URL}models/${name}.glb`);
      simplify(gltf.scene);
      store.set(name, { scene: gltf.scene, clips: gltf.animations });
      onProgress(++done / NAMES.length);
    }),
  );
}

/** 소품 복제본. 지오메트리와 재질은 원본과 공유하므로 dispose 하지 않는다. */
export function prop(name: AssetName, scale = 1) {
  const o = store.get(name)!.scene.clone();
  o.scale.setScalar(scale);
  return o;
}

export function propSize(name: AssetName) {
  return new THREE.Box3().setFromObject(store.get(name)!.scene).getSize(new THREE.Vector3());
}

interface PlayOptions {
  /** 한 번만 재생하고 마지막 자세에서 멈춘다. 끝날 때까지 이동 애니메이션 요청을 무시한다. */
  once?: boolean;
  speed?: number;
  fade?: number;
}

/** 리깅된 캐릭터 한 개체: 복제된 스켈레톤 + 애니메이션 믹서 + 개체 전용 재질 */
export class Actor {
  readonly root: THREE.Object3D;
  /** 피격 시 번쩍이게 하려고 개체마다 복제한 재질 */
  readonly mats: THREE.MeshLambertMaterial[] = [];
  private mixer: THREE.AnimationMixer;
  private actions = new Map<string, THREE.AnimationAction>();
  private current: THREE.AnimationAction | null = null;
  private currentName = '';
  private busy = false;

  constructor(name: AssetName, opts: { right?: AssetName; left?: AssetName; tint?: number } = {}) {
    const src = store.get(name)!;
    this.root = SkeletonUtils.clone(src.scene);
    const cloned = new Map<THREE.Material, THREE.Material>();
    this.root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.frustumCulled = false; // 애니메이션으로 원래 경계 밖까지 움직인다
      const m = mesh.material as THREE.Material;
      if (!(m as THREE.MeshLambertMaterial).isMeshLambertMaterial) return;
      let c = cloned.get(m);
      if (!c) {
        c = m.clone();
        if (opts.tint !== undefined) (c as THREE.MeshLambertMaterial).color.setHex(opts.tint);
        cloned.set(m, c);
        this.mats.push(c as THREE.MeshLambertMaterial);
      }
      mesh.material = c;
    });
    // GLTFLoader 가 노드 이름의 '.' 을 지우므로 handslot.r → handslotr
    if (opts.right) this.root.getObjectByName('handslotr')?.add(prop(opts.right));
    if (opts.left) this.root.getObjectByName('handslotl')?.add(prop(opts.left));

    this.mixer = new THREE.AnimationMixer(this.root);
    for (const clip of src.clips) this.actions.set(clip.name, this.mixer.clipAction(clip));
    this.mixer.addEventListener('finished', () => (this.busy = false));
  }

  play(name: string, o: PlayOptions = {}) {
    if (!o.once && this.busy) return;
    const a = this.actions.get(name);
    if (!a) return;
    const speed = o.speed ?? 1;
    if (!o.once && this.currentName === name) {
      a.timeScale = speed;
      return;
    }
    const fade = o.fade ?? 0.12;
    a.reset();
    a.timeScale = speed;
    a.setLoop(o.once ? THREE.LoopOnce : THREE.LoopRepeat, Infinity);
    a.clampWhenFinished = true;
    if (this.current && this.current !== a) {
      this.current.fadeOut(fade);
      a.fadeIn(fade);
    }
    a.play();
    this.current = a;
    this.currentName = name;
    this.busy = !!o.once;
  }

  /** 진행 중인 1회성 동작을 끊고 이동 애니메이션을 받을 수 있게 한다. */
  release() {
    this.busy = false;
  }

  update(dt: number) {
    this.mixer.update(dt);
  }

  dispose() {
    this.mixer.stopAllAction();
    for (const m of this.mats) m.dispose();
  }
}
