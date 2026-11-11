// KayKit(CC0) 원본 팩에서 게임에 쓰는 모델만 골라 모바일용으로 줄여 public/models 에 넣는다.
//
//   node scripts/build-assets.mjs <KayKit 저장소 3개를 clone 해 둔 폴더>
//
// 필요한 저장소 (github.com/KayKit-Game-Assets):
//   KayKit-Character-Pack-Adventures-1.0, KayKit-Character-Pack-Skeletons-1.0, KayKit-Dungeon-Remastered-1.0
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dedup, meshopt, prune, resample } from '@gltf-transform/functions';
import { MeshoptEncoder } from 'meshoptimizer';
import { mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const src = process.argv[2];
if (!src) throw new Error('usage: node scripts/build-assets.mjs <kaykit-dir>');
const out = 'public/models';
mkdirSync(out, { recursive: true });

const ADV = join(src, 'KayKit-Character-Pack-Adventures-1.0/addons/kaykit_character_pack_adventures');
const SKE = join(src, 'KayKit-Character-Pack-Skeletons-1.0/addons/kaykit_character_pack_skeletons');
const DUN = join(src, 'KayKit-Dungeon-Remastered-1.0/addons/kaykit_dungeon_remastered/Assets/gltf');

const SKELETON_ANIMS = ['Idle_Combat', 'Running_A', 'Hit_A', 'Death_C_Skeletons', 'Spawn_Ground_Skeletons'];

/** [출력 이름, 원본 경로, 남길 애니메이션(없으면 전부 제거), 지울 노드] */
const jobs = [
  ['knight', join(ADV, 'Characters/gltf/Knight.glb'),
    ['Idle', 'Running_A', '1H_Melee_Attack_Slice_Diagonal', '1H_Melee_Attack_Slice_Horizontal', 'Dodge_Forward', 'Hit_A', 'Death_A'],
    ['1H_Sword_Offhand', '2H_Sword', 'Badge_Shield', 'Rectangle_Shield', 'Spike_Shield']],
  ['minion', join(SKE, 'Characters/gltf/Skeleton_Minion.glb'), [...SKELETON_ANIMS, 'Unarmed_Melee_Attack_Punch_A'], []],
  ['warrior', join(SKE, 'Characters/gltf/Skeleton_Warrior.glb'),
    [...SKELETON_ANIMS, '1H_Melee_Attack_Chop', '1H_Melee_Attack_Jump_Chop', 'Spellcast_Summon', 'Taunt'], []],
  ['mage', join(SKE, 'Characters/gltf/Skeleton_Mage.glb'), [...SKELETON_ANIMS, 'Walking_A', 'Spellcast_Shoot'], []],
  ['blade', join(SKE, 'Assets/gltf/Skeleton_Blade.gltf')],
  ['axe', join(SKE, 'Assets/gltf/Skeleton_Axe.gltf')],
  ['staff', join(SKE, 'Assets/gltf/Skeleton_Staff.gltf')],
  ['shield', join(SKE, 'Assets/gltf/Skeleton_Shield_Large_A.gltf')],
  ['chest', join(DUN, 'chest_gold.glb')],
  ['pillar', join(DUN, 'pillar.gltf.glb')],
  ['column', join(DUN, 'column.gltf.glb')],
  ['torch', join(DUN, 'torch_mounted.gltf.glb')],
  ['barrel', join(DUN, 'barrel_large.gltf.glb')],
  ['crates', join(DUN, 'crates_stacked.gltf.glb')],
];

await MeshoptEncoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.encoder': MeshoptEncoder });

for (const [name, path, keep = [], drop = []] of jobs) {
  const doc = await io.read(path);
  const root = doc.getRoot();
  const have = root.listAnimations().map((a) => a.getName());
  for (const k of keep) if (!have.includes(k)) throw new Error(`${name}: animation ${k} not found`);
  for (const a of root.listAnimations()) {
    if (keep.includes(a.getName())) continue;
    // 채널·샘플러를 직접 지워야 키프레임 데이터까지 빠진다
    for (const c of a.listChannels()) c.dispose();
    for (const sm of a.listSamplers()) sm.dispose();
    a.dispose();
  }
  for (const n of root.listNodes()) if (drop.includes(n.getName())) n.dispose();
  await doc.transform(resample(), prune(), dedup(), meshopt({ encoder: MeshoptEncoder, level: 'medium' }));
  const file = join(out, `${name}.glb`);
  await io.write(file, doc);
  const clips = root.listAnimations().map((a) => {
    const d = Math.max(...a.listSamplers().map((s) => s.getInput().getMax([])[0]));
    return `${a.getName()}=${d.toFixed(2)}s`;
  });
  console.log(`${name}.glb ${(statSync(file).size / 1024).toFixed(0)}KB ${clips.join(' ')}`);
}
