import * as THREE from 'three';

// 방 구조물·이펙트용 기본 도형. 지오메트리는 전부 공유한다. (캐릭터·소품 모델은 assets.ts)
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

/** 검을 휘두를 때 잠깐 보이는 검기 */
export function makeSlash() {
  const mat = new THREE.MeshBasicMaterial({
    color: 0xcfe8ff, transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false,
  });
  const mesh = new THREE.Mesh(G.slash, mat);
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.y = 1.0;
  mesh.visible = false;
  return { mesh, mat };
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
