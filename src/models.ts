import * as THREE from 'three';
import type { EnemyKind } from './data';

// 모든 모델은 기본 도형으로 조립한다(외부 에셋 없음). 지오메트리는 전부 공유.
export const G = {
  box: new THREE.BoxGeometry(1, 1, 1),
  sphere: new THREE.SphereGeometry(0.5, 14, 10),
  cyl: new THREE.CylinderGeometry(0.5, 0.5, 1, 12),
  cone: new THREE.ConeGeometry(0.5, 1, 10),
  plane: new THREE.PlaneGeometry(1, 1),
  circle: new THREE.CircleGeometry(0.5, 28),
  // 캐릭터 앞(+Z)을 중심으로 한 130도 부채꼴. 눕히면 검기 이펙트가 된다.
  slash: new THREE.RingGeometry(0.45, 1, 20, 1, -Math.PI / 2 - 1.13, 2.26),
};

const cache = new Map<string, THREE.Material>();
export function lam(color: number, emissive = 0): THREE.MeshLambertMaterial {
  const key = `l${color}_${emissive}`;
  let m = cache.get(key) as THREE.MeshLambertMaterial | undefined;
  if (!m) cache.set(key, (m = new THREE.MeshLambertMaterial({ color, emissive })));
  return m;
}
export function basic(color: number, opacity = 1): THREE.MeshBasicMaterial {
  const key = `b${color}_${opacity}`;
  let m = cache.get(key) as THREE.MeshBasicMaterial | undefined;
  if (!m) {
    m = new THREE.MeshBasicMaterial({ color, transparent: opacity < 1, opacity, depthWrite: opacity >= 1 });
    cache.set(key, m);
  }
  return m;
}

type V3 = [number, number, number];
export function part(geo: THREE.BufferGeometry, mat: THREE.Material, s: V3, p: V3, parent?: THREE.Object3D) {
  const m = new THREE.Mesh(geo, mat);
  m.scale.set(...s);
  m.position.set(...p);
  parent?.add(m);
  return m;
}

export function blobShadow(radius: number, parent: THREE.Object3D) {
  const m = part(G.circle, basic(0x000000, 0.35), [radius * 2, radius * 2, 1], [0, 0.03, 0], parent);
  m.rotation.x = -Math.PI / 2;
  return m;
}

export interface KnightRig {
  root: THREE.Group;
  torso: THREE.Group;
  armR: THREE.Group;
  legL: THREE.Group;
  legR: THREE.Group;
  slash: THREE.Mesh;
  slashMat: THREE.MeshBasicMaterial;
}

export function makeKnight(): KnightRig {
  const root = new THREE.Group();
  blobShadow(0.6, root);
  const steel = lam(0xb9c2d0);
  const tunic = lam(0x2f5fb3);
  const skin = lam(0xe2b48c);
  const dark = lam(0x3a2f2a);

  const legL = new THREE.Group();
  const legR = new THREE.Group();
  legL.position.set(-0.17, 0.7, 0);
  legR.position.set(0.17, 0.7, 0);
  part(G.box, dark, [0.22, 0.7, 0.24], [0, -0.35, 0], legL);
  part(G.box, dark, [0.22, 0.7, 0.24], [0, -0.35, 0], legR);
  root.add(legL, legR);

  const torso = new THREE.Group();
  torso.position.y = 0.7;
  root.add(torso);
  part(G.box, tunic, [0.66, 0.72, 0.38], [0, 0.4, 0], torso);
  part(G.box, steel, [0.72, 0.3, 0.44], [0, 0.66, 0], torso); // 어깨 갑옷
  part(G.sphere, skin, [0.42, 0.42, 0.42], [0, 1.02, 0], torso);
  part(G.cyl, steel, [0.48, 0.22, 0.48], [0, 1.17, 0], torso); // 투구
  part(G.cone, lam(0xc43c3c), [0.14, 0.34, 0.14], [0, 1.42, 0], torso); // 깃털 장식
  part(G.box, lam(0x8f1f2a), [0.6, 0.85, 0.05], [0, 0.3, -0.24], torso); // 망토

  const armL = new THREE.Group();
  armL.position.set(-0.45, 0.68, 0);
  part(G.box, tunic, [0.18, 0.55, 0.2], [0, -0.25, 0], armL);
  part(G.cyl, lam(0x7a5a2a), [0.6, 0.07, 0.6], [-0.1, -0.3, 0.12], armL).rotation.z = Math.PI / 2; // 방패
  torso.add(armL);

  const armR = new THREE.Group();
  armR.position.set(0.45, 0.68, 0);
  part(G.box, tunic, [0.18, 0.55, 0.2], [0, -0.25, 0], armR);
  part(G.box, lam(0x6a4a20), [0.3, 0.06, 0.1], [0, -0.58, 0], armR); // 가드
  part(G.box, lam(0xe6edf5, 0x222831), [0.09, 1.15, 0.04], [0, -1.18, 0], armR); // 칼날
  torso.add(armR);

  const slashMat = new THREE.MeshBasicMaterial({
    color: 0xcfe8ff, transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false,
  });
  const slash = new THREE.Mesh(G.slash, slashMat);
  slash.rotation.x = -Math.PI / 2;
  slash.position.y = 1.0;
  slash.visible = false;
  root.add(slash);

  return { root, torso, armR, legL, legR, slash, slashMat };
}

export interface EnemyModel {
  root: THREE.Group;
  /** 피격 시 번쩍이도록 개체마다 따로 만든 재질 */
  mats: THREE.MeshLambertMaterial[];
  height: number;
}

export function makeEnemy(kind: EnemyKind): EnemyModel {
  const root = new THREE.Group();
  const mats: THREE.MeshLambertMaterial[] = [];
  const own = (color: number) => {
    const m = new THREE.MeshLambertMaterial({ color });
    mats.push(m);
    return m;
  };
  const eye = basic(0xffe14a);
  let height = 1.6;

  if (kind === 'slime') {
    blobShadow(0.7, root);
    const body = own(0x58c96a);
    part(G.sphere, body, [1.3, 0.95, 1.3], [0, 0.45, 0], root);
    part(G.sphere, basic(0xffffff), [0.2, 0.2, 0.2], [-0.22, 0.6, 0.5], root);
    part(G.sphere, basic(0xffffff), [0.2, 0.2, 0.2], [0.22, 0.6, 0.5], root);
    part(G.sphere, basic(0x111111), [0.1, 0.1, 0.1], [-0.22, 0.6, 0.59], root);
    part(G.sphere, basic(0x111111), [0.1, 0.1, 0.1], [0.22, 0.6, 0.59], root);
    height = 1.1;
  } else if (kind === 'skeleton') {
    blobShadow(0.5, root);
    const bone = own(0xe8e4d4);
    part(G.box, bone, [0.14, 0.75, 0.14], [-0.15, 0.38, 0], root);
    part(G.box, bone, [0.14, 0.75, 0.14], [0.15, 0.38, 0], root);
    part(G.box, bone, [0.5, 0.6, 0.26], [0, 1.05, 0], root);
    part(G.sphere, bone, [0.42, 0.44, 0.42], [0, 1.6, 0], root);
    part(G.box, basic(0x111111), [0.1, 0.1, 0.05], [-0.1, 1.63, 0.2], root);
    part(G.box, basic(0x111111), [0.1, 0.1, 0.05], [0.1, 1.63, 0.2], root);
    part(G.box, bone, [0.12, 0.6, 0.12], [-0.36, 1.0, 0], root);
    part(G.box, bone, [0.12, 0.12, 0.6], [0.36, 1.2, 0.25], root);
    part(G.box, own(0x8a8f99), [0.08, 0.08, 1.0], [0.36, 1.2, 0.95], root); // 녹슨 검
    height = 1.95;
  } else if (kind === 'mage') {
    blobShadow(0.5, root);
    part(G.cone, own(0x6a3fa8), [0.95, 1.4, 0.95], [0, 0.7, 0], root);
    part(G.sphere, own(0xd9c2a0), [0.36, 0.36, 0.36], [0, 1.5, 0], root);
    part(G.cone, own(0x3f2470), [0.6, 0.7, 0.6], [0, 1.95, 0], root);
    part(G.sphere, eye, [0.07, 0.07, 0.07], [-0.08, 1.52, 0.17], root);
    part(G.sphere, eye, [0.07, 0.07, 0.07], [0.08, 1.52, 0.17], root);
    part(G.cyl, own(0x5a3a1a), [0.07, 1.9, 0.07], [0.5, 0.95, 0.15], root);
    part(G.sphere, basic(0x9fe8ff), [0.24, 0.24, 0.24], [0.5, 1.98, 0.15], root);
    height = 2.4;
  } else {
    blobShadow(1.7, root);
    const rock = own(0x7a2a2a);
    const dark = own(0x4a1a1c);
    part(G.box, dark, [0.7, 1.2, 0.7], [-0.55, 0.6, 0], root);
    part(G.box, dark, [0.7, 1.2, 0.7], [0.55, 0.6, 0], root);
    part(G.box, rock, [1.9, 1.6, 1.2], [0, 2.0, 0], root);
    part(G.box, dark, [0.6, 1.9, 0.6], [-1.3, 1.8, 0], root);
    part(G.box, dark, [0.6, 1.9, 0.6], [1.3, 1.8, 0], root);
    part(G.box, rock, [0.85, 0.8, 0.8], [0, 3.2, 0.1], root);
    part(G.box, eye, [0.16, 0.1, 0.05], [-0.2, 3.28, 0.51], root);
    part(G.box, eye, [0.16, 0.1, 0.05], [0.2, 3.28, 0.51], root);
    part(G.cone, own(0xd8cfc0), [0.25, 0.7, 0.25], [-0.4, 3.85, 0.1], root).rotation.z = 0.4;
    part(G.cone, own(0xd8cfc0), [0.25, 0.7, 0.25], [0.4, 3.85, 0.1], root).rotation.z = -0.4;
    height = 4.5;
  }
  return { root, mats, height };
}

function canvasTexture(size: number, draw: (c: CanvasRenderingContext2D, s: number) => void) {
  const cv = document.createElement('canvas');
  cv.width = cv.height = size;
  draw(cv.getContext('2d')!, size);
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

export function stoneTexture() {
  return canvasTexture(256, (c, s) => {
    c.fillStyle = '#2a2730';
    c.fillRect(0, 0, s, s);
    const n = 4;
    const t = s / n;
    for (let y = 0; y < n; y++)
      for (let x = 0; x < n; x++) {
        const v = 92 + Math.floor(Math.random() * 34);
        c.fillStyle = `rgb(${v},${v - 4},${v + 4})`;
        c.fillRect(x * t + 2, y * t + 2, t - 4, t - 4);
        c.fillStyle = 'rgba(0,0,0,0.12)';
        for (let i = 0; i < 6; i++) c.fillRect(x * t + Math.random() * t, y * t + Math.random() * t, 5, 2);
      }
  });
}

export function brickTexture() {
  return canvasTexture(256, (c, s) => {
    c.fillStyle = '#1e1b22';
    c.fillRect(0, 0, s, s);
    const rows = 8;
    const h = s / rows;
    const w = s / 4;
    for (let y = 0; y < rows; y++)
      for (let x = -1; x < 4; x++) {
        const v = 78 + Math.floor(Math.random() * 30);
        c.fillStyle = `rgb(${v + 6},${v},${v - 4})`;
        c.fillRect(x * w + (y % 2 ? w / 2 : 0) + 2, y * h + 2, w - 4, h - 4);
      }
  });
}

/** 문/아이템 위에 띄우는 글자 스프라이트. 반환된 텍스처와 재질은 방을 치울 때 dispose 한다. */
export function labelSprite(lines: string[], color = '#f2d38a') {
  const cv = document.createElement('canvas');
  cv.width = 512;
  cv.height = 192;
  const c = cv.getContext('2d')!;
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  c.lineJoin = 'round';
  lines.forEach((line, i) => {
    const big = i === 0;
    c.font = `800 ${big ? 60 : 38}px "Apple SD Gothic Neo","Noto Sans KR","Malgun Gothic",sans-serif`;
    const y = lines.length === 1 ? 96 : big ? 62 : 138;
    c.lineWidth = 10;
    c.strokeStyle = 'rgba(0,0,0,0.85)';
    c.strokeText(line, 256, y);
    c.fillStyle = big ? color : '#ffffff';
    c.fillText(line, 256, y);
  });
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(3.6, 1.35, 1);
  return { sprite, dispose: () => (tex.dispose(), mat.dispose()) };
}
