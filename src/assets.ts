import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';

// 캐릭터·애니메이션은 Quaternius, 소품·무기는 KayKit 팩(모두 CC0)에서 가져와
// scripts/build-assets.mjs 로 변환한 것이다.
const NAMES = [
  'mannequin', 'ranger', 'cultist', 'brute', 'sword', 'blade', 'axe', 'staff',
  'chest', 'pillar', 'column', 'torch', 'barrel', 'crates',
] as const;
export type AssetName = (typeof NAMES)[number];

const store = new Map<AssetName, { scene: THREE.Group }>();
/** 모든 캐릭터가 같은 뼈대를 쓰므로 애니메이션 클립은 한 벌을 공유한다. */
let clips: THREE.AnimationClip[] = [];

/**
 * 체형이 다른 캐릭터에 같은 클립을 쓰려면 뼈의 회전만 가져와야 한다.
 * 위치는 골반(전신의 상하 움직임)만 남기고, 나머지 위치·크기 트랙은 버린다.
 */
function retargetable(clip: THREE.AnimationClip) {
  clip.tracks = clip.tracks.filter((t) => t.name.endsWith('.quaternion') || t.name === 'pelvis.position');
  return clip;
}

/** 무기를 쥐는 손 뼈(hand_r) 기준 자세. 쥔 주먹 위로 칼날이 서도록 맞춘 값이다. */
const GRIP: Partial<Record<AssetName, { p: [number, number, number]; r: [number, number, number]; s: number }>> = {
  sword: { p: [0, 0.1, 0.03], r: [0, 0, -Math.PI / 2], s: 0.62 },
  blade: { p: [0, 0.1, 0.03], r: [0, 0, -Math.PI / 2], s: 0.7 },
  axe: { p: [0, 0.1, 0.03], r: [0, 0, -Math.PI / 2], s: 0.8 },
  staff: { p: [0, 0.1, 0.03], r: [0, 0, -Math.PI / 2], s: 0.8 },
};

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
      store.set(name, { scene: gltf.scene });
      if (name === 'mannequin') clips = gltf.animations.map(retargetable);
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

  constructor(name: AssetName, opts: { right?: AssetName; tint?: number } = {}) {
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
    if (opts.right) {
      const g = GRIP[opts.right]!;
      const weapon = prop(opts.right, g.s);
      weapon.name = 'weapon';
      weapon.position.set(...g.p);
      weapon.rotation.set(...g.r);
      this.root.getObjectByName('hand_r')?.add(weapon);
    }

    this.mixer = new THREE.AnimationMixer(this.root);
    for (const clip of clips) this.actions.set(clip.name, this.mixer.clipAction(clip));
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
