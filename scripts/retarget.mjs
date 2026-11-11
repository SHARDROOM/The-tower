// 이미 리깅된 인간형 모델(Pelvis / L_Shoulder / L_Elbow … 식 뼈 이름, 기본 자세의 뼈 회전이 모두 0)에
// 게임의 공용 동작(public/models/mannequin.glb)을 옮겨 담아 public/models/<이름>.glb 로 저장한다.
//
//   node scripts/retarget.mjs <리깅된 모델.glb> <이름>
//
// 방식: 두 뼈대의 기본 자세가 다르므로(모델은 A자, 공용 뼈대는 T자) 뼈의 로컬 회전을 그대로 옮길 수 없다.
// 대신 프레임마다 원본 뼈가 "기본 자세에서 월드 공간으로 얼마나 돌았는지"를 구해,
// 모델의 같은 뼈를 T자로 편 상태에서 그만큼 돌린 뒤 부모 기준 로컬 회전으로 되돌린다.
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dedup, meshopt, prune, resample, simplify, textureCompress, weld } from '@gltf-transform/functions';
import { MeshoptDecoder, MeshoptEncoder, MeshoptSimplifier } from 'meshoptimizer';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import sharp from 'sharp';
import * as THREE from 'three';

const [input, name] = process.argv.slice(2);
if (!input || !name) throw new Error('usage: node scripts/retarget.mjs <rigged.glb> <name>');
const HEIGHT = 1.8;
const FPS = 30;

// 옮겨 담을 공용 동작 (게임에서 주인공이 쓰는 것)
const CLIPS = ['Sword_Idle', 'Idle_Loop', 'Jog_Fwd_Loop', 'Sword_Attack', 'Roll', 'Hit_Chest', 'Death01'];

// 모델 뼈 ← 공용 뼈대의 뼈. straight: 몸통처럼 두 뼈대 모두 곧게 선 뼈라 자세 보정이 필요 없다.
const MAP = [
  ['Pelvis', 'pelvis', true], ['Spine1', 'spine_01', true], ['Spine2', 'spine_02', true], ['Spine3', 'spine_03', true],
  ['Neck', 'neck_01', true], ['Head', 'Head', true],
];
for (const [t, s] of [['L', 'l'], ['R', 'r']]) {
  MAP.push(
    [`${t}_Collar`, `clavicle_${s}`], [`${t}_Shoulder`, `upperarm_${s}`], [`${t}_Elbow`, `lowerarm_${s}`], [`${t}_Wrist`, `hand_${s}`],
    [`${t}_Hip`, `thigh_${s}`], [`${t}_Knee`, `calf_${s}`], [`${t}_Ankle`, `foot_${s}`], [`${t}_Foot`, `ball_${s}`],
  );
  for (const f of ['Thumb', 'Index', 'Middle', 'Ring', 'Pinky']) for (const i of [1, 2, 3]) MAP.push([`${t}_${f}${i}`, `${f.toLowerCase()}_0${i}_${s}`]);
}

await Promise.all([MeshoptDecoder.ready, MeshoptEncoder.ready, MeshoptSimplifier.ready]);
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
  'meshopt.decoder': MeshoptDecoder, 'meshopt.encoder': MeshoptEncoder,
});
const doc = await io.read(input);
const root = doc.getRoot();

// ── 1. 메시 정리: 원래 든 동작과 쓰지 않는 PBR 텍스처를 빼고 폴리곤을 줄인다 ──
for (const a of root.listAnimations()) {
  for (const c of a.listChannels()) c.dispose();
  for (const sm of a.listSamplers()) sm.dispose();
  a.dispose();
}
for (const m of root.listMaterials()) {
  m.setNormalTexture(null).setOcclusionTexture(null).setMetallicRoughnessTexture(null).setEmissiveTexture(null);
  m.setMetallicFactor(0).setRoughnessFactor(1);
}
await doc.transform(weld(), simplify({ simplifier: MeshoptSimplifier, ratio: 0.3, error: 0.004 }), prune());

// ── 2. 모델 뼈대: 키를 1.8m 로, 발을 바닥에 (뼈대 전체를 Armature 노드의 배율로 감싼다) ──
const skin = root.listSkins()[0];
const jointNodes = new Map(skin.listJoints().map((j) => [j.getName(), j]));
let minY = Infinity, maxY = -Infinity;
const v = [0, 0, 0];
for (const p of root.listMeshes().flatMap((m) => m.listPrimitives())) {
  const P = p.getAttribute('POSITION');
  for (let i = 0; i < P.getCount(); i++) { P.getElement(i, v); minY = Math.min(minY, v[1]); maxY = Math.max(maxY, v[1]); }
}
const k = HEIGHT / (maxY - minY);
const scene = root.listScenes()[0];
const pelvisNode = jointNodes.get('Pelvis');
const meshNode = root.listNodes().find((n) => n.getMesh());
const armature = doc.createNode('Armature').setScale([k, k, k]).setTranslation([0, -minY * k, 0]);
pelvisNode.getParentNode()?.removeChild(pelvisNode);
for (const c of scene.listChildren()) scene.removeChild(c);
armature.addChild(pelvisNode).addChild(meshNode);
scene.addChild(armature);
for (const n of root.listNodes()) if (n !== armature && !n.getParentNode() && n.listParents().length <= 1) n.dispose();

// three 객체로 옮겨 월드 위치를 계산한다 (모델 뼈의 기본 회전은 모두 0 이라고 가정)
const tgt = new Map();
const tgtTop = new THREE.Object3D();
const mirror = (node, parent) => {
  if (node.getRotation().some((x, i) => Math.abs(x - (i === 3 ? 1 : 0)) > 1e-4)) throw new Error(`${node.getName()}: 기본 자세에 회전이 있는 뼈대는 지원하지 않습니다`);
  const o = new THREE.Object3D();
  o.name = node.getName();
  o.position.fromArray(node.getTranslation());
  parent.add(o);
  tgt.set(o.name, o);
  for (const c of node.listChildren()) if (jointNodes.has(c.getName())) mirror(c, o);
};
mirror(pelvisNode, tgtTop);
tgtTop.updateMatrixWorld(true);

// ── 3. 공용 뼈대와 동작을 three 객체로 옮긴다 ──
const man = await io.read('public/models/mannequin.glb');
const bot = new THREE.Object3D();
const srcBones = new Map();
const copy = (node, parent) => {
  if (node.getMesh()) return;
  const o = new THREE.Object3D();
  o.name = node.getName();
  o.position.fromArray(node.getTranslation());
  o.quaternion.fromArray(node.getRotation());
  parent.add(o);
  srcBones.set(o.name, o);
  for (const c of node.listChildren()) copy(c, o);
};
copy(man.getRoot().listNodes().find((n) => n.getName() === 'Armature'), bot);
bot.updateMatrixWorld(true);
const restPose = new Map([...srcBones].map(([n, o]) => [n, { p: o.position.clone(), q: o.quaternion.clone() }]));
const src = (n) => srcBones.get(n);
const wpos = (o) => o.getWorldPosition(new THREE.Vector3());
const wquat = (o) => o.getWorldQuaternion(new THREE.Quaternion());
const sourceClips = new Map(man.getRoot().listAnimations().map((a) => [a.getName(), new THREE.AnimationClip(
  a.getName(), -1,
  a.listChannels().filter((c) => c.getTargetPath() !== 'scale' && srcBones.has(c.getTargetNode().getName())).map((c) => {
    const sm = c.getSampler();
    const Track = c.getTargetPath() === 'rotation' ? THREE.QuaternionKeyframeTrack : THREE.VectorKeyframeTrack;
    const prop = c.getTargetPath() === 'rotation' ? 'quaternion' : 'position';
    return new Track(`${c.getTargetNode().getName()}.${prop}`, Array.from(sm.getInput().getArray()), Array.from(sm.getOutput().getArray()));
  }),
)]));

/** 뼈가 뻗은 방향: 첫 자식 쪽. 끝 뼈는 부모에서 자기 쪽 방향을 쓴다. */
const boneDir = (o, isBone) => {
  const child = o.children.find((c) => isBone(c) && c.name !== o.name);
  return (child ? wpos(child).sub(wpos(o)) : wpos(o).sub(wpos(o.parent))).normalize();
};
/**
 * 손의 방향 틀: 손가락이 뻗은 방향, 손바닥 방향, 엄지 쪽 방향을 축으로 하는 회전 행렬.
 * 엄지 뼈는 뼈대마다 붙은 자리가 달라 기준으로 삼기 어렵다. 검지·새끼 손가락 뿌리를 잇는 선(손바닥을 가로지르는 선)을 쓴다.
 */
function handFrame(pos, wrist, middle, index, pinky, left) {
  const fingers = pos(middle).sub(pos(wrist)).normalize();
  const across = pos(pinky).sub(pos(index));
  across.addScaledVector(fingers, -across.dot(fingers)).normalize();
  const palm = new THREE.Vector3().crossVectors(fingers, across).multiplyScalar(left ? -1 : 1);
  return new THREE.Matrix4().makeBasis(fingers, palm, new THREE.Vector3().crossVectors(fingers, palm));
}
const pairs = [];
for (const [tName, sName, straight] of MAP) {
  const t = tgt.get(tName), s = src(sName);
  if (!t || !s) throw new Error(`뼈를 찾을 수 없습니다: ${tName} ↔ ${sName}`);
  // fix: 모델의 이 뼈를 원본 뼈대의 기본 자세(T자) 방향으로 펴는 월드 회전
  let fix = new THREE.Quaternion();
  if (/_Wrist$/.test(tName)) {
    // 손은 뻗은 방향만 맞추면 손목이 비틀린 채 남아 쥔 무기가 엉뚱한 곳을 향한다.
    // 손가락 방향과 손바닥 방향을 함께 맞춘다.
    const left = tName.startsWith('L');
    const sd = sName.slice(-1);
    const T = tName[0];
    fix.setFromRotationMatrix(
      handFrame(wpos, s, src(`middle_01_${sd}`), src(`index_01_${sd}`), src(`pinky_01_${sd}`), left).multiply(
        handFrame(wpos, t, tgt.get(`${T}_Middle1`), tgt.get(`${T}_Index1`), tgt.get(`${T}_Pinky1`), left).invert(),
      ),
    );
  } else if (!straight) {
    fix.setFromUnitVectors(boneDir(t, (c) => tgt.has(c.name)), boneDir(s, () => true));
  }
  pairs.push({ t, s, fix, restInv: wquat(s).invert(), node: jointNodes.get(tName), values: [], world: new THREE.Quaternion() });
}
const byTarget = new Map(pairs.map((p) => [p.t, p]));
/** 대응 뼈가 있는 가장 가까운 조상의 현재 월드 회전 (대응 없는 뼈는 회전 0 이라 그대로 통과) */
const parentWorld = (o) => {
  for (let p = o.parent; p; p = p.parent) if (byTarget.has(p)) return byTarget.get(p).world;
  return new THREE.Quaternion();
};

// ── 4. 동작마다 프레임을 뽑아 옮긴다 ──
const buffer = root.listBuffers()[0];
const hips = src('pelvis');
const hipsRest = wpos(hips);
const pelvisRest = pelvisNode.getTranslation();
// 골반 높이 비율: 다리 길이가 달라도 발이 바닥에 닿게 한다
const ratio = (pelvisRest[1] - minY) / hipsRest.y;
for (const clipName of CLIPS) {
  const clip = sourceClips.get(clipName);
  if (!clip) throw new Error(`mannequin.glb 에 ${clipName} 동작이 없습니다`);
  const mixer = new THREE.AnimationMixer(bot);
  mixer.clipAction(clip).play();
  const frames = Math.max(2, Math.round(clip.duration * FPS) + 1);
  const times = new Float32Array(frames);
  const hipPos = [];
  for (const p of pairs) p.values = new Float32Array(frames * 4);
  for (let f = 0; f < frames; f++) {
    times[f] = (f / (frames - 1)) * clip.duration;
    mixer.setTime(Math.min(times[f], clip.duration - 1e-4));
    bot.updateMatrixWorld(true);
    hipPos.push(wpos(hips));
    for (const p of pairs) {
      // 부모가 먼저 오도록 MAP 을 짰으므로 p.world 는 순서대로 채워진다
      p.world.copy(wquat(p.s)).multiply(p.restInv).multiply(p.fix);
      const local = parentWorld(p.t).clone().invert().multiply(p.world);
      // 프레임 사이 보간이 먼 길로 돌지 않게 부호를 맞춘다
      if (f > 0) {
        const o = (f - 1) * 4, q = p.values;
        if (q[o] * local.x + q[o + 1] * local.y + q[o + 2] * local.z + q[o + 3] * local.w < 0) local.set(-local.x, -local.y, -local.z, -local.w);
      }
      local.toArray(p.values, f * 4);
    }
  }
  mixer.stopAllAction();
  mixer.uncacheRoot(bot);
  // 뼈대를 기본 자세로 되돌려 다음 동작이 앞 동작의 자세를 물려받지 않게 한다
  for (const [n, o] of srcBones) { const r = restPose.get(n); o.position.copy(r.p); o.quaternion.copy(r.q); }
  const anim = doc.createAnimation(clipName);
  const add = (node, path, type, array) => {
    const sampler = doc.createAnimationSampler()
      .setInput(doc.createAccessor().setType('SCALAR').setArray(times).setBuffer(buffer))
      .setOutput(doc.createAccessor().setType(type).setArray(array).setBuffer(buffer))
      .setInterpolation('LINEAR');
    anim.addSampler(sampler).addChannel(doc.createAnimationChannel().setTargetNode(node).setTargetPath(path).setSampler(sampler));
  };
  for (const p of pairs) add(p.node, 'rotation', 'VEC4', p.values);
  const pos = new Float32Array(frames * 3);
  for (let f = 0; f < frames; f++) {
    const d = hipPos[f].sub(hipsRest).multiplyScalar(ratio);
    pos[f * 3] = pelvisRest[0] + d.x;
    pos[f * 3 + 1] = pelvisRest[1] + d.y;
    pos[f * 3 + 2] = pelvisRest[2] + d.z;
  }
  add(pelvisNode, 'translation', 'VEC3', pos);
  console.log(`동작 ${clipName.padEnd(8)} ${clip.duration.toFixed(2)}초, ${frames}프레임`);
}

// ── 5. 이 모델 전용으로 직접 만든 동작 (scripts/blender/heavy_anims.py 가 만든 scripts/anim/*.json) ──
const ANIM_DIR = 'scripts/anim';
for (const file of existsSync(ANIM_DIR) ? readdirSync(ANIM_DIR).filter((f) => f.endsWith('.json')).sort() : []) {
  const a = JSON.parse(readFileSync(`${ANIM_DIR}/${file}`, 'utf8'));
  const times = Float32Array.from({ length: a.frames }, (_, f) => (f / (a.frames - 1)) * a.duration);
  const anim = doc.createAnimation(a.name);
  const add = (node, path, type, array) => {
    const sampler = doc.createAnimationSampler()
      .setInput(doc.createAccessor().setType('SCALAR').setArray(times).setBuffer(buffer))
      .setOutput(doc.createAccessor().setType(type).setArray(Float32Array.from(array)).setBuffer(buffer))
      .setInterpolation('LINEAR');
    anim.addSampler(sampler).addChannel(doc.createAnimationChannel().setTargetNode(node).setTargetPath(path).setSampler(sampler));
  };
  for (const [bone, values] of Object.entries(a.rotations)) {
    if (!jointNodes.has(bone)) throw new Error(`${file}: 모델에 없는 뼈 ${bone}`);
    add(jointNodes.get(bone), 'rotation', 'VEC4', values);
  }
  add(pelvisNode, 'translation', 'VEC3', a.pelvis);
  console.log(`동작 ${a.name.padEnd(8)} ${a.duration.toFixed(2)}초 (직접 제작)`);
}

await doc.transform(
  resample(), prune(), dedup(),
  textureCompress({ encoder: sharp, targetFormat: 'webp', resize: [1024, 1024], quality: 85 }),
  meshopt({ encoder: MeshoptEncoder, level: 'medium' }),
);
const out = `public/models/${name}.glb`;
await io.write(out, doc);
const prim = root.listMeshes()[0].listPrimitives()[0];
console.log(`${out}: 정점 ${prim.getAttribute('POSITION').getCount()}, 삼각형 ${prim.getIndices().getCount() / 3}`);
