// 날이 위(+Y)를 향해 세워진 무기 모델을 손에 쥘 수 있는 소품으로 변환해 public/models/<이름>.glb 로 저장한다.
//
//   node scripts/convert-weapon.mjs <입력.glb> <이름> <전체 길이(m)> <손잡이 중심 위치(0=아래 끝, 1=위 끝)>
//
// 원점이 손잡이 중심에 오도록 옮기므로, 게임에서는 손 뼈에 그대로 붙이면 된다.
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dedup, meshopt, prune, simplify, textureCompress, weld } from '@gltf-transform/functions';
import { MeshoptEncoder, MeshoptSimplifier } from 'meshoptimizer';
import sharp from 'sharp';

const [input, name, length = '1', grip = '0.17'] = process.argv.slice(2);
if (!input || !name) throw new Error('usage: node scripts/convert-weapon.mjs <input.glb> <name> [length] [grip]');
await Promise.all([MeshoptEncoder.ready, MeshoptSimplifier.ready]);
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.encoder': MeshoptEncoder });
const doc = await io.read(input);
const root = doc.getRoot();
for (const m of root.listMaterials()) {
  m.setNormalTexture(null).setOcclusionTexture(null).setMetallicRoughnessTexture(null).setEmissiveTexture(null);
  m.setMetallicFactor(0).setRoughnessFactor(1);
}
await doc.transform(weld(), simplify({ simplifier: MeshoptSimplifier, ratio: 0.15, error: 0.002 }), prune());
const accessors = root.listMeshes().flatMap((m) => m.listPrimitives()).map((p) => p.getAttribute('POSITION'));
let minY = Infinity, maxY = -Infinity;
const v = [0, 0, 0];
for (const a of accessors) for (let i = 0; i < a.getCount(); i++) { a.getElement(i, v); minY = Math.min(minY, v[1]); maxY = Math.max(maxY, v[1]); }
const k = Number(length) / (maxY - minY);
const origin = minY + (maxY - minY) * Number(grip);
for (const a of accessors) for (let i = 0; i < a.getCount(); i++) {
  a.getElement(i, v);
  a.setElement(i, [v[0] * k, (v[1] - origin) * k, v[2] * k]);
}
await doc.transform(
  prune(), dedup(),
  textureCompress({ encoder: sharp, targetFormat: 'webp', resize: [512, 512], quality: 85 }),
  meshopt({ encoder: MeshoptEncoder, level: 'medium' }),
);
await io.write(`public/models/${name}.glb`, doc);
console.log(`public/models/${name}.glb 저장`);
