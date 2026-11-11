// 뼈대가 없는 인간형 정지 메시(A자/T자 자세, +Z 를 바라봄)에 뼈대를 심어 public/models/<이름>.glb 로 저장한다.
//
//   node scripts/rig-character.mjs <입력.glb> <이름>
//       게임의 공용 뼈대(mannequin.glb)에 묶는다. 공용 애니메이션을 그대로 쓸 수 있다.
//   node scripts/rig-character.mjs <입력.glb> <이름> --mixamo <폴더>
//       Mixamo 뼈대에 묶고, 폴더 안의 FBX 동작(아래 MIXAMO_CLIPS)을 같은 파일에 함께 담는다.
//       폴더에는 뼈대 기준이 되는 "X Bot.fbx" 와 동작 FBX 들이 있어야 한다.
//
// 방식: 메시의 손끝·발목 위치를 찾아 뼈대의 팔다리를 그 자세로 돌리고 길이를 맞춘 뒤,
// 각 정점을 가까운 뼈(뼈 굵기로 정규화한 거리)에 묶는다. 판금 갑옷처럼 단단한 외형에 적합하다.
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dedup, meshopt, prune, resample, simplify, textureCompress, weld } from '@gltf-transform/functions';
import { MeshoptDecoder, MeshoptEncoder, MeshoptSimplifier } from 'meshoptimizer';
import sharp from 'sharp';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';

const [input, name, flag, mixamoDir] = process.argv.slice(2);
if (!input || !name || (flag && (flag !== '--mixamo' || !mixamoDir))) {
  throw new Error('usage: node scripts/rig-character.mjs <input.glb> <name> [--mixamo <dir>]');
}
const HEIGHT = 1.8; // 두 뼈대 모두 키가 약 1.8m

// 게임에서 쓰는 이름 ← Mixamo 동작 파일. inPlace: 앞으로 나아가는 이동분을 빼고 제자리 동작으로 만든다.
// lift: 위아래 움직임 배율.
const MIXAMO_CLIPS = [
  ['Idle', 'sword and shield idle.fbx'],
  ['Run', 'sword and shield run.fbx', { inPlace: true }],
  ['Attack1', 'sword and shield slash.fbx'],
  ['Attack2', 'sword and shield slash (3).fbx'],
  ['Attack3', 'sword and shield attack (4).fbx'],
  ['Dodge', 'sword and shield jump.fbx', { inPlace: true, lift: 0.25 }], // 높이 뛰는 대신 낮게 몸을 날린다
  ['Hit', 'sword and shield impact (3).fbx'],
  ['Death', 'sword and shield death.fbx'],
  ['Block', 'sword and shield block idle.fbx'],
];

// 뼈 이름표: 공용 뼈대와 Mixamo 뼈대
const side = (l, r) => (s) => (s === 'l' ? l : r);
const NAMES = mixamoDir
  ? {
      spine: ['mixamorigHips', 'mixamorigSpine', 'mixamorigSpine1', 'mixamorigSpine2', 'mixamorigNeck', 'mixamorigHead'],
      clavicle: side('mixamorigLeftShoulder', 'mixamorigRightShoulder'), upperarm: side('mixamorigLeftArm', 'mixamorigRightArm'),
      lowerarm: side('mixamorigLeftForeArm', 'mixamorigRightForeArm'), hand: side('mixamorigLeftHand', 'mixamorigRightHand'),
      tip: side('mixamorigLeftHandMiddle4', 'mixamorigRightHandMiddle4'),
      thigh: side('mixamorigLeftUpLeg', 'mixamorigRightUpLeg'), calf: side('mixamorigLeftLeg', 'mixamorigRightLeg'),
      foot: side('mixamorigLeftFoot', 'mixamorigRightFoot'), ball: side('mixamorigLeftToeBase', 'mixamorigRightToeBase'),
      toe: side('mixamorigLeftToe_End', 'mixamorigRightToe_End'),
    }
  : {
      spine: ['pelvis', 'spine_01', 'spine_02', 'spine_03', 'neck_01', 'Head'],
      clavicle: (s) => `clavicle_${s}`, upperarm: (s) => `upperarm_${s}`, lowerarm: (s) => `lowerarm_${s}`,
      hand: (s) => `hand_${s}`, tip: (s) => `middle_04_leaf_${s}`,
      thigh: (s) => `thigh_${s}`, calf: (s) => `calf_${s}`, foot: (s) => `foot_${s}`, ball: (s) => `ball_${s}`,
      toe: (s) => `ball_leaf_${s}`,
    };

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

// ── 2. 뼈대 읽기 ──
const bones = new Map();
const top = new THREE.Object3D();
let jointNames;
const loadFbx = (file) => {
  const b = readFileSync(`${mixamoDir}/${file}`);
  return new FBXLoader().parse(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength), '');
};
let mixamoBot = null;
if (mixamoDir) {
  // Mixamo 는 cm 단위라 뼈 위치를 m 로 바꾼다
  mixamoBot = loadFbx('X Bot.fbx');
  const armature = new THREE.Object3D();
  armature.name = 'Armature';
  top.add(armature);
  bones.set('Armature', armature);
  const copy = (src, parent) => {
    const o = new THREE.Object3D();
    o.name = src.name;
    o.position.copy(src.position).multiplyScalar(0.01);
    o.quaternion.copy(src.quaternion);
    parent.add(o);
    bones.set(o.name, o);
    // FBXLoader 는 뼈마다 같은 이름의 빈 복제 뼈를 자식으로 달아 두므로 건너뛴다
    for (const c of src.children) if (c.isBone && c.name !== src.name) copy(c, o);
  };
  copy(mixamoBot.children.find((c) => c.isBone), armature);
  jointNames = [...bones.keys()].filter((n) => n !== 'Armature');
} else {
  const man = await io.read('public/models/mannequin.glb');
  const build = (n, parent) => {
    const o = new THREE.Object3D();
    o.name = n.getName();
    o.position.fromArray(n.getTranslation());
    o.quaternion.fromArray(n.getRotation());
    parent.add(o);
    bones.set(o.name, o);
    for (const c of n.listChildren()) if (!c.getMesh()) build(c, o);
  };
  build(man.getRoot().listNodes().find((n) => n.getName() === 'Armature'), top);
  jointNames = man.getRoot().listSkins()[0].listJoints().map((j) => j.getName());
}
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
  const shoulder = wp(NAMES.upperarm(side));
  const armLen = wp(NAMES.tip(side)).distanceTo(shoulder);
  aim(NAMES.upperarm(side), NAMES.tip(side), tip, tip.distanceTo(shoulder) / armLen);
  // 발목: 발등 높이의 정점 중심
  const ankle = mean(mine.filter((p) => p.y > 0.08 && p.y < 0.14).map((p) => p.clone()));
  ankle.y = wp(NAMES.foot(side)).y;
  const hip = wp(NAMES.thigh(side));
  aim(NAMES.thigh(side), NAMES.foot(side), ankle, ankle.distanceTo(hip) / wp(NAMES.foot(side)).distanceTo(hip));
  console.log(`${side}: 손끝 ${tip.toArray().map((n) => n.toFixed(2))} 발목 ${ankle.toArray().map((n) => n.toFixed(2))}`);
}

// ── 4. 스키닝: 정점마다 가까운 뼈 4개까지 ──
// [뼈, 끝점이 되는 뼈(없으면 위/앞으로 짧게), 굵기, 좌우(+1 왼쪽, -1 오른쪽, 0 중앙)]
const sp = NAMES.spine;
const SEG = [
  [sp[0], sp[1], 0.17, 0], [sp[1], sp[2], 0.17, 0], [sp[2], sp[3], 0.17, 0],
  [sp[3], sp[4], 0.18, 0], [sp[4], sp[5], 0.075, 0], [sp[5], null, 0.13, 0],
];
for (const [s, sx] of [['l', 1], ['r', -1]]) {
  SEG.push(
    [NAMES.clavicle(s), NAMES.upperarm(s), 0.09, sx], [NAMES.upperarm(s), NAMES.lowerarm(s), 0.09, sx],
    [NAMES.lowerarm(s), NAMES.hand(s), 0.07, sx], [NAMES.hand(s), NAMES.tip(s), 0.06, sx],
    [NAMES.thigh(s), NAMES.calf(s), 0.105, sx], [NAMES.calf(s), NAMES.foot(s), 0.085, sx],
    [NAMES.foot(s), NAMES.ball(s), 0.07, sx], [NAMES.ball(s), NAMES.toe(s), 0.06, sx],
  );
}
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
    const arm = js.some((j) => /lowerarm|hand|ForeArm|Hand/.test(j));
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
skin.setSkeleton(nodeOf.get(mixamoDir ? sp[0] : 'root'));
prim.setAttribute('JOINTS_0', doc.createAccessor().setType('VEC4').setArray(joints).setBuffer(buffer));
prim.setAttribute('WEIGHTS_0', doc.createAccessor().setType('VEC4').setArray(weights).setBuffer(buffer));
const mesh = root.listMeshes()[0];
armNode.addChild(doc.createNode(name).setMesh(mesh).setSkin(skin));
scene.addChild(armNode);

// ── 6. Mixamo 동작을 같은 파일에 담는다 ──
if (mixamoDir) {
  for (const [clipName, file, opts = {}] of MIXAMO_CLIPS) {
    const clip = loadFbx(file).animations[0];
    const anim = doc.createAnimation(clipName);
    for (const track of clip.tracks) {
      const [bone, prop] = track.name.split('.');
      const node = nodeOf.get(bone);
      if (!node || (prop !== 'quaternion' && prop !== 'position')) continue;
      // 위치는 골반만 쓴다(나머지 뼈 길이는 메시에 맞춘 값을 유지)
      if (prop === 'position' && bone !== sp[0]) continue;
      const values = Float32Array.from(track.values);
      if (prop === 'position') {
        const n = values.length / 3;
        for (let i = 0; i < n; i++) {
          const t = n > 1 ? i / (n - 1) : 0;
          for (const ax of [0, 2]) {
            // 제자리 동작: 처음~끝 사이의 직선 이동분을 뺀다
            const drift = opts.inPlace ? (track.values[(n - 1) * 3 + ax] - track.values[ax]) * t : 0;
            // 동작마다 시작 위치가 달라 발밑 기준점에서 벗어나므로, 첫 프레임을 원점으로 맞춘다
            values[i * 3 + ax] = (track.values[i * 3 + ax] - track.values[ax] - drift) * 0.01;
          }
          // lift: 첫 프레임 높이를 기준으로 위아래 움직임을 줄인다
          values[i * 3 + 1] = (track.values[1] + (track.values[i * 3 + 1] - track.values[1]) * (opts.lift ?? 1)) * 0.01;
        }
      }
      const sampler = doc.createAnimationSampler()
        .setInput(doc.createAccessor().setType('SCALAR').setArray(Float32Array.from(track.times)).setBuffer(buffer))
        .setOutput(doc.createAccessor().setType(prop === 'position' ? 'VEC3' : 'VEC4').setArray(values).setBuffer(buffer))
        .setInterpolation('LINEAR');
      anim.addSampler(sampler).addChannel(
        doc.createAnimationChannel().setTargetNode(node).setTargetPath(prop === 'position' ? 'translation' : 'rotation').setSampler(sampler),
      );
    }
    // 무기 손이 가장 빠르게 움직이는 순간(타격 시점 참고용)
    const mixer = new THREE.AnimationMixer(mixamoBot);
    mixer.clipAction(clip).play();
    const hand = mixamoBot.getObjectByName(NAMES.hand('r'));
    let prev = null, peak = 0, peakT = 0;
    for (let t = 0; t <= clip.duration; t += 1 / 60) {
      mixer.setTime(t);
      mixamoBot.updateMatrixWorld(true);
      const p = hand.getWorldPosition(new THREE.Vector3());
      if (prev && p.distanceTo(prev) > peak) { peak = p.distanceTo(prev); peakT = t; }
      prev = p;
    }
    mixer.stopAllAction();
    console.log(`동작 ${clipName.padEnd(8)} ${clip.duration.toFixed(2)}초, 오른손 최고 속도 ${peakT.toFixed(2)}초`);
  }
}

await doc.transform(
  resample(), prune(), dedup(),
  textureCompress({ encoder: sharp, targetFormat: 'webp', resize: [1024, 1024], quality: 85 }),
  meshopt({ encoder: MeshoptEncoder, level: 'medium' }),
);
const out = `public/models/${name}.glb`;
await io.write(out, doc);
console.log(`${out}: 정점 ${count}, 삼각형 ${prim.getIndices().getCount() / 3}`);
