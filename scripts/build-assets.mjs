// CC0 원본 팩에서 게임에 쓰는 모델만 골라 모바일용으로 줄여 public/models 에 넣는다.
//
//   node scripts/build-assets.mjs <KayKit 폴더> <Quaternius 폴더>
//
// KayKit 폴더: github.com/KayKit-Game-Assets 의 아래 저장소를 clone 해 둔 곳 (소품·무기)
//   KayKit-Character-Pack-Adventures-1.0, KayKit-Character-Pack-Skeletons-1.0, KayKit-Dungeon-Remastered-1.0
// Quaternius 폴더: quaternius.com 의 무료(Standard) 팩을 아래 이름으로 풀어 둔 곳 (캐릭터·애니메이션)
//   universal_animation_library/UAL1.glb
//   modular_character_outfits/Outfits/*.gltf
//   universal_base_characters/Base Characters/*.gltf
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dedup, meshopt, prune, resample, simplify, textureCompress, weld } from '@gltf-transform/functions';
import { MeshoptEncoder, MeshoptSimplifier } from 'meshoptimizer';
import { mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';

const [kaykit, quaternius] = process.argv.slice(2);
if (!kaykit || !quaternius) throw new Error('usage: node scripts/build-assets.mjs <kaykit-dir> <quaternius-dir>');
const out = 'public/models';
mkdirSync(out, { recursive: true });

const ADV = join(kaykit, 'KayKit-Character-Pack-Adventures-1.0/addons/kaykit_character_pack_adventures');
const SKE = join(kaykit, 'KayKit-Character-Pack-Skeletons-1.0/addons/kaykit_character_pack_skeletons');
const DUN = join(kaykit, 'KayKit-Dungeon-Remastered-1.0/addons/kaykit_dungeon_remastered/Assets/gltf');
const OUTFIT = join(quaternius, 'modular_character_outfits/Outfits');

// 모든 캐릭터가 같은 뼈대를 쓰므로 애니메이션은 mannequin.glb 한 곳에만 둔다.
const ANIMS = [
  'Idle_Loop', 'Sword_Idle', 'Jog_Fwd_Loop', 'Sprint_Loop', 'Walk_Loop', 'Sword_Attack', 'Punch_Jab', 'Punch_Cross',
  'Roll', 'Hit_Chest', 'Death01', 'Spell_Simple_Shoot', 'Spell_Simple_Enter', 'Jump_Land', 'Crouch_Idle_Loop',
];

/** [출력 이름, 원본 경로, 옵션] — char: 리깅된 캐릭터(텍스처 축소·폴리곤 감소), anims: 남길 애니메이션 */
const jobs = [
  ['mannequin', join(quaternius, 'universal_animation_library/UAL1.glb'), { char: true, anims: ANIMS }],
  ['cultist', join(OUTFIT, 'Female_Ranger.gltf'), { char: true }],
  ['brute', join(quaternius, 'universal_base_characters/Base Characters/Superhero_Male_FullBody.gltf'), { char: true }],
  ['sword', join(ADV, 'Assets/gltf/sword_1handed.gltf')],
  ['blade', join(SKE, 'Assets/gltf/Skeleton_Blade.gltf')],
  ['axe', join(SKE, 'Assets/gltf/Skeleton_Axe.gltf')],
  ['staff', join(SKE, 'Assets/gltf/Skeleton_Staff.gltf')],
  ['chest', join(DUN, 'chest_gold.glb')],
  ['pillar', join(DUN, 'pillar.gltf.glb')],
  ['column', join(DUN, 'column.gltf.glb')],
  ['torch', join(DUN, 'torch_mounted.gltf.glb')],
  ['barrel', join(DUN, 'barrel_large.gltf.glb')],
  ['crates', join(DUN, 'crates_stacked.gltf.glb')],
];

await MeshoptEncoder.ready;
await MeshoptSimplifier.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.encoder': MeshoptEncoder });

for (const [name, path, opts = {}] of jobs) {
  const keep = opts.anims ?? [];
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
  const steps = [resample(), prune(), dedup()];
  if (opts.char) {
    // 게임에서는 Lambert 재질만 쓰므로 색상 텍스처만 남긴다
    for (const m of root.listMaterials()) {
      m.setNormalTexture(null);
      m.setOcclusionTexture(null);
      m.setMetallicRoughnessTexture(null);
      m.setEmissiveTexture(null);
    }
    steps.push(
      weld(),
      simplify({ simplifier: MeshoptSimplifier, ratio: 0.5, error: 0.001 }),
      prune(),
      textureCompress({ encoder: sharp, targetFormat: 'webp', resize: [1024, 1024], quality: 85 }),
    );
  }
  steps.push(meshopt({ encoder: MeshoptEncoder, level: 'medium' }));
  await doc.transform(...steps);
  const file = join(out, `${name}.glb`);
  await io.write(file, doc);
  const clips = root.listAnimations().map((a) => {
    const d = Math.max(...a.listSamplers().map((s) => s.getInput().getMax([])[0]));
    return `${a.getName()}=${d.toFixed(2)}s`;
  });
  console.log(`${name}.glb ${(statSync(file).size / 1024).toFixed(0)}KB ${clips.join(' ')}`);
}
