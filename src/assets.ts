import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';

// 캐릭터·애니메이션은 Quaternius, 소품·무기는 KayKit 팩(모두 CC0)에서 가져와
// scripts/build-assets.mjs 로 변환한 것이다.
const NAMES = [
  'mannequin', 'knight', 'cultist', 'brute', 'sword', 'blade', 'axe', 'staff',
  'chest', 'pillar', 'column', 'torch', 'barrel', 'crates',
] as const;
export type AssetName = (typeof NAMES)[number];

const store = new Map<AssetName, { scene: THREE.Group; clips?: THREE.AnimationClip[] }>();
/** 공용 뼈대를 쓰는 캐릭터들이 함께 쓰는 클립. 자기 파일에 동작이 든 캐릭터(주인공)는 그것을 쓴다. */
let clips: THREE.AnimationClip[] = [];

/**
 * 체형이 다른 캐릭터에 같은 클립을 쓰려면 뼈의 회전만 가져와야 한다.
 * 위치는 골반(전신의 상하 움직임)만 남기고, 나머지 위치·크기 트랙은 버린다.
 */
function retargetable(clip: THREE.AnimationClip) {
  clip.tracks = clip.tracks.filter((t) => t.name.endsWith('.quaternion') || t.name === 'pelvis.position');
  return clip;
}

/** 무기를 쥐는 손 뼈(공용 뼈대의 hand_r) 기준 자세. 쥔 주먹 위로 칼날이 서도록 맞춘 값이다. */
const GRIP: Partial<Record<AssetName, { p: [number, number, number]; r: [number, number, number]; s: number }>> = {
  sword: { p: [0, 0.1, 0.03], r: [0, 0, -Math.PI / 2], s: 1 },
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

/**
 * 주인공 뼈대(R_Wrist 아래에 손가락 뼈가 있는 규격)의 오른손에 무기를 쥐여 준다.
 * 이 뼈대는 기본 자세의 뼈 회전이 0 이라, 손가락 뼈 위치로 손의 방향을 직접 구한다:
 * 손가락이 뻗은 방향과 검지→새끼 손가락 뿌리를 잇는 선에서 손바닥 방향과 칼날이 설 방향(엄지 쪽)을 얻는다.
 */
function gripInHand(hand: THREE.Object3D, weapon: THREE.Object3D) {
  const middle = hand.getObjectByName('R_Middle1');
  const index = hand.getObjectByName('R_Index1');
  const pinky = hand.getObjectByName('R_Pinky1');
  if (!middle || !index || !pinky) return;
  const fingers = middle.position.clone().normalize();
  const across = pinky.position.clone().sub(index.position);
  across.addScaledVector(fingers, -across.dot(fingers)).normalize();
  const palm = new THREE.Vector3().crossVectors(fingers, across); // 오른손 기준 손바닥 방향
  const blade = across.clone().negate(); // 엄지 쪽
  // 무기의 날 방향(+Y)을 blade 로 세운다. 검의 폭(X, 양쪽 날을 잇는 방향)은 손가락이 뻗은 쪽에 맞춘다:
  // 손바닥은 손잡이의 납작한 면에 닿고, 날은 주먹이 나가는 쪽을 향한다.
  weapon.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(fingers, blade, new THREE.Vector3().crossVectors(fingers, blade)));
  weapon.position.copy(middle.position).multiplyScalar(0.75).addScaledVector(palm, middle.position.length() * 0.35);
  // 뼈대 전체가 배율로 감싸여 있으므로 무기 크기를 되돌린다
  weapon.scale.divide(hand.getWorldScale(new THREE.Vector3()));
}

export async function loadAssets(onProgress: (ratio: number) => void) {
  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);
  let done = 0;
  await Promise.all(
    NAMES.map(async (name) => {
      const gltf = await loader.loadAsync(`${import.meta.env.BASE_URL}models/${name}.glb`);
      simplify(gltf.scene);
      if (name === 'mannequin') {
        clips = gltf.animations.map(retargetable);
        store.set(name, { scene: gltf.scene });
      } else {
        store.set(name, { scene: gltf.scene, clips: gltf.animations.length ? gltf.animations : undefined });
      }
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
      const weapon = prop(opts.right, GRIP[opts.right]!.s);
      weapon.name = 'weapon';
      const wrist = this.root.getObjectByName('R_Wrist');
      if (wrist) {
        wrist.add(weapon);
        this.root.updateMatrixWorld(true);
        gripInHand(wrist, weapon);
      } else {
        const g = GRIP[opts.right]!;
        weapon.position.set(...g.p);
        weapon.rotation.set(...g.r);
        this.root.getObjectByName('hand_r')?.add(weapon);
      }
    }

    this.mixer = new THREE.AnimationMixer(this.root);
    for (const clip of src.clips ?? clips) this.actions.set(clip.name, this.mixer.clipAction(clip));
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
