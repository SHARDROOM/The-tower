// 뼈대가 없는 인간형 정지 메시(A자/T자 자세, +Z 를 바라봄)에 게임의 공용 뼈대를 심어
// public/models/<이름>.glb 로 저장한다. 공용 애니메이션(mannequin.glb)을 그대로 쓸 수 있게 된다.
//
//   node scripts/rig-character.mjs <입력.glb> <이름>
//
// 방식: 메시의 손끝·발목 위치를 찾아 뼈대의 팔다리를 그 자세로 돌리고 길이를 맞춘 뒤,
// 각 정점을 가까운 뼈(뼈 굵기로 정규화한 거리)에 묶는다. 판금 갑옷처럼 단단한 외형에 적합하다.
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dedup, meshopt, prune, simplify, textureCompress, weld } from '@gltf-transform/functions';
import { MeshoptDecoder, MeshoptEncoder, MeshoptSimplifier } from 'meshoptimizer';
import sharp from 'sharp';
import * as THREE from 'three';

const [input, name] = process.argv.slice(2);
if (!input || !name) throw new Error('usage: node scripts/rig-character.mjs <input.glb> <name>');
const HEIGHT = 1.8; // 공용 뼈대의 키

await Promise.all([MeshoptDecoder.ready, MeshoptEncoder.ready, MeshoptSimplifier.ready]);
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
  'meshopt.decoder': MeshoptDecoder, 'meshopt.encoder': MeshoptEncoder,
});

// ── 1. 메시 정리: 폴리곤 감소, 키를 맞추고 발을 바닥에 ──
const doc = await io.read(input);
const root = doc.getRoot();
for (const m of root.listMaterials()) {
  m.setNormalTexture(null).setOcclusionTexture(null).setMetallicRoughnessTexture(null).setEmissiveTexture(null);
  m.setMetallicFactor(0).setRoughnessFactor(1);
}
await doc.transform(weld(), simplify({ simplifier: MeshoptSimplifier, ratio: 0.3, error: 0.004 }), prune());
const prims = root.listMeshes().flatMap((m) => m.listPrimitives());
if (prims.length !== 1) throw new Error(`메시 조각이 ${prims.length}개입니다. 하나로 합쳐진 모델만 지원합니다.`);
const prim = prims[0];
const P = prim.getAttribute('POSITION');
const count = P.getCount();
const v = [0, 0, 0];
let minY = Infinity, maxY = -Infinity, sumX = 0, sumZ = 0;
for (let i = 0; i < count; i++) { P.getElement(i, v); minY = Math.min(minY, v[1]); maxY = Math.max(maxY, v[1]); sumX += v[0]; sumZ += v[2]; }
const k = HEIGHT / (maxY - minY);
const cx = sumX / count, cz = sumZ / count;
const pts = [];
for (let i = 0; i < count; i++) {
  P.getElement(i, v);
  const p = new THREE.Vector3((v[0] - cx) * k, (v[1] - minY) * k, (v[2] - cz) * k - 0.03);
  pts.push(p);
  P.setElement(i, p.toArray());
}

// ── 2. 공용 뼈대 읽기 ──
const man = await io.read('public/models/mannequin.glb');
const skinSrc = man.getRoot().listSkins()[0];
const bones = new Map();
const top = new THREE.Object3D();
const build = (n, parent) => {
  const o = new THREE.Object3D();
  o.name = n.getName();
  o.position.fromArray(n.getTranslation());
  o.quaternion.fromArray(n.getRotation());
  parent.add(o);
  bones.set(o.name, o);
  for (const c of n.listChildren()) if (!c.getMesh()) build(c, o);
};
const armature = man.getRoot().listNodes().find((n) => n.getName() === 'Armature');
build(armature, top);
top.updateMatrixWorld(true);
const wp = (b) => bones.get(b).getWorldPosition(new THREE.Vector3());

// ── 3. 메시에서 손·발 위치를 찾아 뼈대를 그 자세로 맞춘다 ──
const mean = (list) => list.reduce((a, p) => a.add(p), new THREE.Vector3()).divideScalar(list.length || 1);
/** bone 에서 end 까지의 방향이 target 을 향하도록 bone 을 돌리고, 그 아래 뼈 길이를 scale 배 한다. */
function aim(bone, end, target, scale) {
  const b = bones.get(bone);
  b.traverse((o) => { if (o !== b) o.position.multiplyScalar(scale); });
  top.updateMatrixWorld(true);
  const from = wp(bone);
  const delta = new THREE.Quaternion().setFromUnitVectors(wp(end).sub(from).normalize(), target.clone().sub(from).normalize());
  const world = delta.multiply(b.getWorldQuaternion(new THREE.Quaternion()));
  b.quaternion.copy(b.parent.getWorldQuaternion(new THREE.Quaternion()).invert().multiply(world));
  top.updateMatrixWorld(true);
}
for (const [side, sx] of [['l', 1], ['r', -1]]) {
  const mine = pts.filter((p) => p.x * sx > 0);
  // 손끝: 몸에서 가장 먼 쪽 3% 정점의 중심
  const reach = Math.max(...mine.map((p) => p.x * sx));
  const tip = mean(mine.filter((p) => p.x * sx > reach - 0.03).map((p) => p.clone()));
  const shoulder = wp(`upperarm_${side}`);
  const armLen = wp(`middle_04_leaf_${side}`).distanceTo(shoulder);
  aim(`upperarm_${side}`, `middle_04_leaf_${side}`, tip, tip.distanceTo(shoulder) / armLen);
  // 발목: 발등 높이의 정점 중심
  const ankle = mean(mine.filter((p) => p.y > 0.08 && p.y < 0.14).map((p) => p.clone()));
  ankle.y = wp(`foot_${side}`).y;
  const hip = wp(`thigh_${side}`);
  aim(`thigh_${side}`, `foot_${side}`, ankle, ankle.distanceTo(hip) / wp(`foot_${side}`).distanceTo(hip));
  console.log(`${side}: 손끝 ${tip.toArray().map((n) => n.toFixed(2))} 발목 ${ankle.toArray().map((n) => n.toFixed(2))}`);
}

// ── 4. 스키닝: 정점마다 가까운 뼈 4개까지 ──
// [뼈, 끝점이 되는 뼈(없으면 위/앞으로 짧게), 굵기, 좌우(+1 왼쪽, -1 오른쪽, 0 중앙)]
const SEG = [
  ['pelvis', 'spine_01', 0.17, 0], ['spine_01', 'spine_02', 0.17, 0], ['spine_02', 'spine_03', 0.17, 0],
  ['spine_03', 'neck_01', 0.18, 0], ['neck_01', 'Head', 0.075, 0], ['Head', null, 0.13, 0],
];
for (const [s, sx] of [['l', 1], ['r', -1]]) {
  SEG.push(
    [`clavicle_${s}`, `upperarm_${s}`, 0.09, sx], [`upperarm_${s}`, `lowerarm_${s}`, 0.09, sx],
    [`lowerarm_${s}`, `hand_${s}`, 0.07, sx], [`hand_${s}`, `middle_04_leaf_${s}`, 0.06, sx],
    [`thigh_${s}`, `calf_${s}`, 0.105, sx], [`calf_${s}`, `foot_${s}`, 0.085, sx],
    [`foot_${s}`, `ball_${s}`, 0.07, sx], [`ball_${s}`, `ball_leaf_${s}`, 0.06, sx],
  );
}
const jointNames = skinSrc.listJoints().map((j) => j.getName());
const segs = SEG.map(([bone, end, r, sx]) => {
  const a = wp(bone);
  const b = end ? wp(end) : a.clone().add(new THREE.Vector3(0, 0.22, 0));
  return { bone, end, joint: jointNames.indexOf(bone), a, ab: b.clone().sub(a), r, sx };
});
// 섞어도 되는 뼈는 가장 가까운 뼈와 관절로 이어진 이웃뿐이다.
// (팔이 몸통 옆에 붙어 있는 자세에서 팔 정점이 몸통 뼈에 끌려가 늘어나는 것을 막는다)
const linked = (x, y) => x === y || x.end === y.bone || y.end === x.bone
  || (bones.get(x.bone).parent === bones.get(y.bone).parent && x.sx === 0 && y.sx === 0)
  || bones.get(x.bone).parent?.name === y.bone || bones.get(y.bone).parent?.name === x.bone;
const joints = new Uint16Array(count * 4);
const weights = new Float32Array(count * 4);
const tmp = new THREE.Vector3();
for (let i = 0; i < count; i++) {
  const p = pts[i];
  const cand = [];
  for (const s of segs) {
    if (s.sx !== 0 && p.x * s.sx < -0.01) continue; // 반대쪽 팔다리에는 묶지 않는다
    const t = THREE.MathUtils.clamp(tmp.copy(p).sub(s.a).dot(s.ab) / s.ab.lengthSq(), 0, 1);
    cand.push({ seg: s, joint: s.joint, d: tmp.copy(s.a).addScaledVector(s.ab, t).distanceTo(p) / s.r });
  }
  cand.sort((x, y) => x.d - y.d);
  const best = cand.filter((c) => linked(cand[0].seg, c.seg)).slice(0, 4);
  let sum = 0;
  for (const c of best) { c.w = Math.exp(-(((c.d - best[0].d) / 0.3) ** 2)); if (c.w < 0.02) c.w = 0; sum += c.w; }
  best.forEach((c, n) => { joints[i * 4 + n] = c.w ? c.joint : 0; weights[i * 4 + n] = c.w / sum; });
}

if (process.env.RIG_DEBUG) {
  const nm = (j) => jointNames[j];
  const tally = new Map();
  for (let i = 0; i < count; i++) {
    const js = [0, 1, 2, 3].filter((n) => weights[i * 4 + n] > 0.05).map((n) => nm(joints[i * 4 + n]));
    const arm = js.some((j) => /lowerarm|hand/.test(j));
    const other = js.filter((j) => !/arm|hand|clavicle/.test(j));
    if (arm && other.length) { const key = js.join('+'); const t = tally.get(key) || { n: 0, p: pts[i] }; t.n++; tally.set(key, t); }
  }
  for (const [k2, t] of tally) console.log('MIX', k2, t.n, t.p.toArray().map((n) => n.toFixed(2)).join(','));
  for (const sgm of segs) console.log('SEG', nm(sgm.joint), sgm.a.toArray().map((n) => n.toFixed(2)).join(','), '→', sgm.a.clone().add(sgm.ab).toArray().map((n) => n.toFixed(2)).join(','));
}

// ── 5. 뼈대 노드와 스킨을 문서에 넣는다 ──
const buffer = root.listBuffers()[0];
const nodeOf = new Map();
const emit = (o) => {
  const n = doc.createNode(o.name).setTranslation(o.position.toArray()).setRotation(o.quaternion.toArray());
  nodeOf.set(o.name, n);
  for (const c of o.children) n.addChild(emit(c));
  return n;
};
const scene = root.listScenes()[0];
for (const c of scene.listChildren()) scene.removeChild(c);
for (const n of root.listNodes()) if (!nodeOf.has(n.getName())) n.dispose();
const armNode = emit(bones.get('Armature'));
const ibm = new Float32Array(jointNames.length * 16);
jointNames.forEach((j, i) => bones.get(j).matrixWorld.clone().invert().toArray(ibm, i * 16));
const skin = doc.createSkin(name).setInverseBindMatrices(doc.createAccessor().setType('MAT4').setArray(ibm).setBuffer(buffer));
for (const j of jointNames) skin.addJoint(nodeOf.get(j));
skin.setSkeleton(nodeOf.get('root'));
prim.setAttribute('JOINTS_0', doc.createAccessor().setType('VEC4').setArray(joints).setBuffer(buffer));
prim.setAttribute('WEIGHTS_0', doc.createAccessor().setType('VEC4').setArray(weights).setBuffer(buffer));
const mesh = root.listMeshes()[0];
armNode.addChild(doc.createNode(name).setMesh(mesh).setSkin(skin));
scene.addChild(armNode);

await doc.transform(
  prune(), dedup(),
  textureCompress({ encoder: sharp, targetFormat: 'webp', resize: [1024, 1024], quality: 85 }),
  meshopt({ encoder: MeshoptEncoder, level: 'medium' }),
);
const out = `public/models/${name}.glb`;
await io.write(out, doc);
console.log(`${out}: 정점 ${count}, 삼각형 ${prim.getIndices().getCount() / 3}`);
