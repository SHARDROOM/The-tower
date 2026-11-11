// 주인공 모델(public/models/knight.glb)에 든 동작을 프레임 단위로 점검한다.
//
//   node scripts/check-anim.mjs <동작 이름> [--speed <게임 이동 속도>] [--svg <출력.svg>]
//
// 검사: 발 미끄러짐(--speed 를 준 이동 동작), 바닥 관통·뜸, 무릎·팔꿈치 각도, 프레임 사이 급격한 튐,
//       반복 동작의 이음매, 검 끝 속도(타격 시점). --svg 는 옆에서 본 뼈대를 프레임마다 겹쳐 그린다.
// 길이는 게임 월드 단위(캐릭터 키 약 1.89), 각도는 도.
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';
import { writeFileSync } from 'node:fs';
import * as THREE from 'three';

const args = process.argv.slice(2);
const clipName = args[0];
const opt = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const gameSpeed = Number(opt('--speed', 0));
const svgPath = opt('--svg', '');
const HERO_SCALE = 1.05; // src/game.ts 와 같은 값
const FPS = 60;

await MeshoptDecoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
const doc = await io.read('public/models/knight.glb');
const root = doc.getRoot();
const top = new THREE.Object3D();
top.scale.setScalar(HERO_SCALE);
const bones = new Map();
const build = (node, parent) => {
  if (node.getMesh()) return;
  const o = new THREE.Object3D();
  o.name = node.getName();
  o.position.fromArray(node.getTranslation());
  o.quaternion.fromArray(node.getRotation());
  o.scale.fromArray(node.getScale());
  parent.add(o);
  bones.set(o.name, o);
  for (const c of node.listChildren()) build(c, o);
};
for (const n of root.listScenes()[0].listChildren()) build(n, top);
top.updateMatrixWorld(true);
const pos = (n) => bones.get(n).getWorldPosition(new THREE.Vector3());
const rest = Object.fromEntries([...bones.keys()].map((n) => [n, pos(n)]));

const src = root.listAnimations().find((a) => a.getName() === clipName);
if (!src) throw new Error(`동작 없음: ${clipName}. 있는 동작: ${root.listAnimations().map((a) => a.getName()).join(', ')}`);
const clip = new THREE.AnimationClip(clipName, -1, src.listChannels().map((c) => {
  const sm = c.getSampler();
  const rot = c.getTargetPath() === 'rotation';
  const Track = rot ? THREE.QuaternionKeyframeTrack : THREE.VectorKeyframeTrack;
  return new Track(`${c.getTargetNode().getName()}.${rot ? 'quaternion' : 'position'}`, Array.from(sm.getInput().getArray()), Array.from(sm.getOutput().getArray()));
}));
const mixer = new THREE.AnimationMixer(top);
mixer.clipAction(clip).play();

// 검 끝: 손목에서 엄지 쪽(칼날 방향)으로 손잡이 위 0.83 지점 — src/assets.ts 의 gripInHand 와 같은 기준
const wrist = bones.get('R_Wrist');
const fingers = bones.get('R_Middle1').position.clone().normalize();
const across = bones.get('R_Pinky1').position.clone().sub(bones.get('R_Index1').position);
across.addScaledVector(fingers, -across.dot(fingers)).normalize();
const bladeLocal = across.clone().negate();
const armScale = bones.get('Armature').scale.x;
const tipLocal = bones.get('R_Middle1').position.clone().multiplyScalar(0.75).addScaledVector(bladeLocal, 0.83 / armScale);

const JOINTS = ['Pelvis', 'Spine3', 'Head', 'L_Shoulder', 'L_Elbow', 'L_Wrist', 'R_Shoulder', 'R_Elbow', 'R_Wrist',
  'L_Hip', 'L_Knee', 'L_Ankle', 'L_Foot', 'R_Hip', 'R_Knee', 'R_Ankle', 'R_Foot'];
const n = Math.round(clip.duration * FPS) + 1;
const frames = [];
for (let f = 0; f < n; f++) {
  const t = Math.min((f / (n - 1)) * clip.duration, clip.duration - 1e-5);
  mixer.setTime(t);
  top.updateMatrixWorld(true);
  const fr = { t, p: {}, q: {} };
  for (const j of JOINTS) fr.p[j] = pos(j);
  for (const [name, o] of bones) fr.q[name] = o.quaternion.clone();
  fr.tip = wrist.localToWorld(tipLocal.clone());
  frames.push(fr);
}
const dt = clip.duration / (n - 1);
const deg = THREE.MathUtils.radToDeg;
const fmt = (x, d = 3) => x.toFixed(d);
const problems = [];
const report = (ok, label, detail) => { console.log(`${ok ? '  ok ' : '  !! '} ${label}: ${detail}`); if (!ok) problems.push(label); };
console.log(`\n${clipName}: ${clip.duration.toFixed(2)}초, ${n}프레임(초당 ${FPS})`);

// ── 바닥: 기본 자세의 발목·발끝 높이를 기준으로 얼마나 파고들거나 뜨는가 ──
for (const s of 'LR') {
  let low = Infinity, high = -Infinity;
  for (const fr of frames) {
    const d = Math.min(fr.p[`${s}_Ankle`].y - rest[`${s}_Ankle`].y, fr.p[`${s}_Foot`].y - rest[`${s}_Foot`].y);
    low = Math.min(low, d); high = Math.max(high, d);
  }
  report(low > -0.03, `${s} 발 바닥 관통`, `가장 낮을 때 ${fmt(low)} (0 = 바닥, 음수 = 파고듦), 가장 높을 때 ${fmt(high)}`);
}

// ── 관절 각도: 0 = 완전히 폄 ──
const bend = (fr, a, b, c) => deg(fr.p[b].clone().sub(fr.p[a]).angleTo(fr.p[c].clone().sub(fr.p[b])));
for (const [label, a, b, c, max] of [['L 무릎', 'L_Hip', 'L_Knee', 'L_Ankle', 140], ['R 무릎', 'R_Hip', 'R_Knee', 'R_Ankle', 140],
  ['L 팔꿈치', 'L_Shoulder', 'L_Elbow', 'L_Wrist', 150], ['R 팔꿈치', 'R_Shoulder', 'R_Elbow', 'R_Wrist', 150]]) {
  const v = frames.map((fr) => bend(fr, a, b, c));
  const lo = Math.min(...v), hi = Math.max(...v);
  report(hi <= max && (label.includes('무릎') ? lo >= 4 : true), `${label} 굽힘`, `${fmt(lo, 0)}° ~ ${fmt(hi, 0)}°${lo < 4 && label.includes('무릎') ? ' (완전히 펴져 다리가 뻣뻣하게 잠김)' : ''}`);
}
// 무릎이 뒤로 꺾이지 않는가: 무릎은 골반-발목을 잇는 선보다 몸의 정면 쪽에 있어야 한다
for (const s of 'LR') {
  let worst = Infinity;
  for (const fr of frames) {
    const fwd = fr.p.L_Hip.clone().sub(fr.p.R_Hip).cross(new THREE.Vector3(0, 1, 0)).normalize(); // 왼쪽(+X) × 위(+Y) = 정면(+Z)
    const mid = fr.p[`${s}_Hip`].clone().lerp(fr.p[`${s}_Ankle`], 0.5);
    worst = Math.min(worst, fr.p[`${s}_Knee`].clone().sub(mid).dot(fwd));
  }
  report(worst > -0.01, `${s} 무릎 방향`, `정면 쪽으로 최소 ${fmt(worst)} (음수 = 뒤로 꺾임)`);
}

// ── 급격한 튐: 뼈 회전 속도가 프레임 사이에 갑자기 바뀌는 곳 ──
let worstJerk = { v: 0 };
let worstSpeed = { v: 0 };
for (const name of bones.keys()) {
  let prev = null;
  for (let f = 1; f < n; f++) {
    const w = deg(frames[f - 1].q[name].angleTo(frames[f].q[name])) / dt;
    if (w > worstSpeed.v) worstSpeed = { v: w, name, t: frames[f].t };
    if (prev !== null && Math.abs(w - prev) > worstJerk.v) worstJerk = { v: Math.abs(w - prev), name, t: frames[f].t };
    prev = w;
  }
}
report(worstSpeed.v < 2200, '가장 빠른 회전', `${worstSpeed.name} ${fmt(worstSpeed.v, 0)}°/초 (${fmt(worstSpeed.t, 2)}초)`);
report(worstJerk.v < 600, '회전 속도 급변', `${worstJerk.name} 한 프레임 사이 ${fmt(worstJerk.v, 0)}°/초 변화 (${fmt(worstJerk.t, 2)}초)`);

// ── 골반의 위아래 움직임 ──
const py = frames.map((fr) => fr.p.Pelvis.y);
console.log(`       골반 높이: ${fmt(Math.min(...py))} ~ ${fmt(Math.max(...py))} (출렁임 ${fmt(Math.max(...py) - Math.min(...py))}, 기본 자세 ${fmt(rest.Pelvis.y)})`);

// ── 이동 동작: 발 미끄러짐 ──
if (gameSpeed) {
  // 이음매
  let seam = 0, seamBone = '';
  for (const name of bones.keys()) { const a = deg(frames[0].q[name].angleTo(frames[n - 1].q[name])); if (a > seam) { seam = a; seamBone = name; } }
  report(seam < 1, '반복 이음매', `처음과 끝 자세 차이 최대 ${fmt(seam, 2)}° (${seamBone})`);
  for (const s of 'LR') {
    // 발이 땅에 닿은 프레임: 발목이 기본 높이에서 1.5cm 이내이고 발이 뒤로 가는 중
    let slide = 0, time = 0, travel = 0, need = 0;
    for (let f = 1; f < n; f++) {
      const a = frames[f - 1].p[`${s}_Ankle`], b = frames[f].p[`${s}_Ankle`];
      const grounded = Math.min(a.y, b.y) - rest[`${s}_Ankle`].y < 0.015 && b.z < a.z;
      if (!grounded) continue;
      // 땅은 캐릭터 기준으로 초당 gameSpeed 만큼 뒤(-Z)로 흐른다. 발도 같은 속도로 뒤로 가야 미끄러지지 않는다.
      slide += Math.abs((b.z - a.z) + gameSpeed * dt) + Math.abs(b.x - a.x);
      travel += a.z - b.z; need += gameSpeed * dt; time += dt;
    }
    const ratio = slide / Math.max(need, 1e-6);
    report(ratio < 0.2, `${s} 발 미끄러짐`, `디딘 시간 ${fmt(time, 2)}초 동안 발이 뒤로 ${fmt(travel, 2)} 이동, 땅은 ${fmt(need, 2)} 흐름 → 어긋남 ${fmt(slide, 2)} (${fmt(ratio * 100, 0)}%)`);
  }
  const step = clip.duration / 2;
  console.log(`       한 걸음 ${fmt(step, 2)}초, 걸음당 이동 ${fmt(gameSpeed * step, 2)} (다리 길이 ${fmt(rest.L_Hip.y - rest.L_Ankle.y, 2)})`);
}

// ── 검 끝 속도 ──
let peak = { v: 0, t: 0 };
for (let f = 1; f < n; f++) { const v = frames[f].tip.distanceTo(frames[f - 1].tip) / dt; if (v > peak.v) peak = { v, t: frames[f].t }; }
console.log(`       검 끝 최고 속도 ${fmt(peak.v, 1)}/초, 시각 ${fmt(peak.t, 2)}초`);
// 휘두름이 여러 번인 동작: 검 끝 속도가 크게 솟는 순간들(최고치의 35% 이상, 0.15초 이상 떨어진 봉우리)
{
  const sp = frames.map((fr, f) => (f ? fr.tip.distanceTo(frames[f - 1].tip) / dt : 0));
  const sm = sp.map((_, f) => { let a = 0, c = 0; for (let k = f - 2; k <= f + 2; k++) if (sp[k] !== undefined) { a += sp[k]; c++; } return a / c; });
  const peaks = [];
  for (let f = 1; f < n - 1; f++) {
    if (sm[f] < peak.v * 0.35 || sm[f] < sm[f - 1] || sm[f] < sm[f + 1]) continue;
    const last = peaks[peaks.length - 1];
    if (last && frames[f].t - last.t < 0.15) { if (sm[f] > last.v) peaks[peaks.length - 1] = { t: frames[f].t, v: sm[f] }; continue; }
    peaks.push({ t: frames[f].t, v: sm[f] });
  }
  console.log(`       휘두름 봉우리: ${peaks.map((p) => `${fmt(p.t, 2)}초(${fmt(p.v, 0)})`).join(', ')}`);
  // 골반이 앞으로 나간 거리(루트 모션)
  const pz = frames.map((fr) => fr.p.Pelvis.z);
  console.log(`       골반 앞뒤 위치: 처음 ${fmt(pz[0])}, 끝 ${fmt(pz[n - 1])}, 최대 ${fmt(Math.max(...pz))}`);
}

console.log(problems.length ? `  → 문제 ${problems.length}건: ${problems.join(', ')}` : '  → 문제 없음');

// ── 옆에서 본 뼈대 겹쳐 그리기 (정면이 오른쪽) ──
if (svgPath) {
  const W = 1500, H = 620, S = 250, cols = 4;
  const lines = [['Pelvis', 'Spine3'], ['Spine3', 'Head'], ['Spine3', 'R_Shoulder'], ['R_Shoulder', 'R_Elbow'], ['R_Elbow', 'R_Wrist'],
    ['Spine3', 'L_Shoulder'], ['L_Shoulder', 'L_Elbow'], ['L_Elbow', 'L_Wrist'],
    ['Pelvis', 'R_Hip'], ['R_Hip', 'R_Knee'], ['R_Knee', 'R_Ankle'], ['R_Ankle', 'R_Foot'],
    ['Pelvis', 'L_Hip'], ['L_Hip', 'L_Knee'], ['L_Knee', 'L_Ankle'], ['L_Ankle', 'L_Foot']];
  const shown = Array.from({ length: cols * 2 }, (_, i) => Math.round((i / (cols * 2 - 1)) * (n - 1)));
  let out = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H * 2 + 700}" font-family="sans-serif" font-size="15"><rect width="100%" height="100%" fill="#f4f1ea"/>`;
  shown.forEach((f, i) => {
    const ox = (i % cols) * (W / cols) + W / cols / 2, oy = Math.floor(i / cols) * H + H - 60;
    const P = (v) => `${(ox + v.z * S).toFixed(1)},${(oy - v.y * S).toFixed(1)}`;
    const fr = frames[f];
    out += `<line x1="${ox - 170}" y1="${oy - rest.L_Foot.y * S + 8}" x2="${ox + 170}" y2="${oy - rest.L_Foot.y * S + 8}" stroke="#998" stroke-width="2"/>`;
    for (const [a, b] of lines) {
      const col = a.startsWith('L_') || b.startsWith('L_') ? '#2f6fd0' : a.startsWith('R_') || b.startsWith('R_') ? '#c8442c' : '#333';
      out += `<polyline points="${P(fr.p[a])} ${P(fr.p[b])}" stroke="${col}" stroke-width="5" stroke-linecap="round" fill="none"/>`;
    }
    out += `<polyline points="${P(fr.p.R_Wrist)} ${P(fr.tip)}" stroke="#777" stroke-width="3"/>`;
    const head = fr.p.Head; out += `<circle cx="${ox + head.z * S}" cy="${oy - (head.y + 0.12) * S}" r="22" fill="none" stroke="#333" stroke-width="4"/>`;
    out += `<text x="${ox - 160}" y="${oy - H + 90}">${fr.t.toFixed(2)}초</text>`;
  });
  // 아래: 궤적 (검 끝, 오른손, 골반, 두 발목) — 제자리 기준
  const oy = H * 2 + 640, ox = 330;
  const path = (get, col, w = 2) => `<polyline points="${frames.map((fr) => { const v = get(fr); return `${(ox + v.z * S).toFixed(1)},${(oy - v.y * S).toFixed(1)}`; }).join(' ')}" stroke="${col}" stroke-width="${w}" fill="none"/>`;
  out += `<line x1="40" y1="${oy - rest.L_Foot.y * S + 8}" x2="${ox + 420}" y2="${oy - rest.L_Foot.y * S + 8}" stroke="#998" stroke-width="2"/>`;
  out += path((fr) => fr.tip, '#777', 3) + path((fr) => fr.p.R_Wrist, '#c8442c') + path((fr) => fr.p.Pelvis, '#333', 3) + path((fr) => fr.p.L_Ankle, '#2f6fd0') + path((fr) => fr.p.R_Ankle, '#c8442c');
  out += `<text x="40" y="${H * 2 + 40}">궤적(옆에서 봄, 정면이 오른쪽): 회색 = 검 끝, 빨강 = 오른손·오른발, 파랑 = 왼발, 검정 = 골반</text>`;
  // 오른쪽: 시간에 따른 검 끝 속도와 골반 높이
  const gx = 860, gw = 600, gy = H * 2 + 420, gh = 300;
  const speeds = frames.map((fr, f) => (f ? fr.tip.distanceTo(frames[f - 1].tip) / dt : 0));
  const maxV = Math.max(...speeds, 1e-6);
  const minP = Math.min(...py), maxP = Math.max(...py);
  out += `<rect x="${gx}" y="${gy - gh}" width="${gw}" height="${gh}" fill="none" stroke="#998"/>`;
  out += `<polyline points="${speeds.map((v, f) => `${(gx + (f / (n - 1)) * gw).toFixed(1)},${(gy - (v / maxV) * gh).toFixed(1)}`).join(' ')}" stroke="#777" stroke-width="3" fill="none"/>`;
  out += `<polyline points="${py.map((v, f) => `${(gx + (f / (n - 1)) * gw).toFixed(1)},${(gy - ((v - minP) / Math.max(maxP - minP, 1e-6)) * gh * 0.9 - 8).toFixed(1)}`).join(' ')}" stroke="#333" stroke-width="2" fill="none" stroke-dasharray="6 4"/>`;
  out += `<text x="${gx}" y="${gy - gh - 12}">시간 → : 실선 = 검 끝 속도(최고 ${maxV.toFixed(1)}), 점선 = 골반 높이(${minP.toFixed(2)}~${maxP.toFixed(2)})</text></svg>`;
  writeFileSync(svgPath, out);
}
