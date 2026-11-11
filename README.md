# The Tower

중세 판타지 배경의 3D 3인칭 탑 등반 액션 게임 프로토타입. 방의 몬스터를 처치하고 아이템을 모으며 층을 올라간다.
three.js + TypeScript + Vite로 만들었고, Capacitor로 Android / iOS 앱으로 포장한다.

## 실행

```bash
npm install
npm run dev      # 같은 Wi-Fi의 휴대폰에서 표시되는 Network 주소로 접속하면 터치로 플레이 가능
npm run build    # 타입 검사 + dist/ 빌드
```

## 조작

| | 모바일 | PC |
|---|---|---|
| 이동 | 화면 왼쪽 드래그(가상 조이스틱) | WASD / 방향키 |
| 시점 회전(상하좌우) | 화면 오른쪽 드래그 | 마우스 드래그, Q / E(좌우) |
| 카메라 거리 | — | 마우스 휠 |
| 공격 | 공격 버튼(누르고 있으면 연속) | J / Space |
| 구르기(무적 회피) | 구르기 버튼 | K / Shift |

화면 오른쪽 위의 ⚙ 버튼을 누르면 두루마리 설정창이 내려온다(열려 있는 동안 게임은 멈춘다).
버튼 크기와 투명도, 오른손/왼손 배치를 바꿀 수 있고, "버튼 직접 배치"로 공격·구르기 버튼을 끌어 원하는 곳에 둘 수 있다.
설정은 기기에 저장된다.

## 게임 구조

- 한 층은 방 4개. 방을 정리하면 문이 열리고, 문 색과 글자로 다음 방 종류(전투 / 정예 / 보물)를 골라 들어간다.
- 층의 마지막 방은 정예 방이고, 3층마다 보스 방이다. 정리하면 다음 층으로 가는 문이 열린다.
- 전투 방을 정리하면 상자가 나온다(아이템 또는 물약, 정예·보스는 아이템 2개). 보물 방은 셋 중 하나를 고른다.
- 몬스터: 구울, 강철 병사, 암흑 사제(원거리), 보스 "탑의 수호자"(내려찍기 · 탄막 · 돌진). 붉은 바닥 표시가 공격 예고.
- 층이 오를수록 몬스터의 체력·공격력·수가 늘고, 3층마다 탑의 색조가 바뀐다.

## 코드

| 파일 | 내용 |
|---|---|
| `src/game.ts` | 게임 루프, 방 생성, 전투, 몬스터 AI, 아이템, HUD |
| `src/data.ts` | 플레이어 능력치, 아이템, 몬스터 수치 (밸런스 조정은 여기서) |
| `src/assets.ts` | glTF 모델 로딩, 캐릭터 복제와 애니메이션 재생(`Actor`) |
| `src/models.ts` | 방 구조물·이펙트용 기본 도형과 절차적 텍스처 |
| `src/settings.ts` | 두루마리 설정창, 버튼 크기·배치 설정과 저장 |
| `src/input.ts` | 터치 조이스틱·버튼, 키보드·마우스 입력 |
| `scripts/retarget.mjs` | 리깅된 모델에 공용 동작을 옮겨 담는 스크립트 |
| `scripts/blender/heavy_anims.py` | 주인공 전용 동작(달리기·내려베기)을 만드는 Blender 파이썬 스크립트 |
| `scripts/check-anim.mjs` | 주인공 동작 점검: 발 미끄러짐, 바닥 관통, 관절 각도, 급격한 튐, 검 끝 속도 + 뼈대 궤적 그림 |
| `scripts/rig-character.mjs` | 뼈대 없는 인간형 모델에 공용 뼈대를 자동으로 심는 스크립트 |
| `scripts/convert-weapon.mjs` | 세워진 무기 모델을 손에 쥘 수 있는 소품으로 변환하는 스크립트 |
| `scripts/build-assets.mjs` | 원본 모델에서 필요한 것만 골라 압축해 `public/models/`에 넣는 변환 스크립트 |

## 모델과 애니메이션

모두 CC0 라이선스라 상업적 이용을 포함해 자유롭게 쓸 수 있다.

- 캐릭터(7~8등신)와 애니메이션: [Quaternius](https://quaternius.com)의 Universal Animation Library,
  Modular Character Outfits – Fantasy, Universal Base Characters (무료 Standard 판).
  모든 캐릭터가 같은 뼈대를 쓰므로 애니메이션은 `mannequin.glb` 한 벌을 공유한다.
- 주인공(검은 갑옷 기사): 직접 제공한 리깅된 모델(손가락 포함 52개 뼈)에 공용 동작을 옮겨 담은 것.
  이 뼈대는 공용 뼈대와 뼈 이름도 기본 자세도 달라서(모델은 A자, 공용 뼈대는 T자),
  `scripts/retarget.mjs`가 프레임마다 월드 공간 회전을 옮긴다: `node scripts/retarget.mjs <리깅된 모델.glb> <이름>`.
  뼈대가 없는 모델이라면 `scripts/rig-character.mjs`로 공용 뼈대에 자동 리깅할 수 있다(품질은 더 낮다).
- 주인공 전용 동작(무게감 있는 달리기 `Heavy_Run`, 내려베기 `Heavy_Attack`)은 직접 만든 것이다.
  `scripts/blender/heavy_anims.py`를 Blender의 파이썬(`pip install bpy`)으로 실행하면 `scripts/anim/*.json`이 만들어지고,
  `scripts/retarget.mjs`가 이를 모델 파일에 함께 담는다. 발과 검 든 손은 2관절 IK로 정한 위치에 놓는다.
  동작을 고치려면 그 파이썬 파일의 수치(보폭, 자세 높이, 공격의 시각별 손 위치 등)를 바꾸면 된다.
  고친 뒤에는 `node scripts/check-anim.mjs Heavy_Run --speed 3.6 --svg run.svg` 처럼 점검한다
  (`--speed`는 게임 이동 속도. 달리기 주기와 디딤 비율은 이 속도에서 발이 미끄러지지 않도록 계산돼 있다).
- 주인공의 3단 베기 연속기(`Sword_-_slash_combo`)와 걷기·전력 질주 등 동작(`walk_*`, `sprint_*`)은 같은 뼈대로 만들어
  직접 제공한 파일에서 그대로 가져온 것이다: `node scripts/retarget.mjs <리깅된 모델.glb> knight <동작 파일.glb ...>`.
  반복 동작은 제자리 동작으로 바꾸고, 연속기는 앞으로 파고드는 이동(루트 모션)을 남겨 게임이 그만큼 캐릭터를 옮긴다.
- 주인공의 검: 직접 제공한 모델을 `scripts/convert-weapon.mjs`로 변환한 것.
- 소품과 무기: [KayKit](https://www.kaylousberg.com) (Kay Lousberg)의 Dungeon Remastered / Adventurers / Skeletons 팩.

변환된 파일(`public/models/*.glb`, 합계 약 2.5MB)이 저장소에 들어 있어 따로 받을 필요는 없다.
모델이나 애니메이션을 추가하려면 원본 팩을 받은 뒤 `scripts/build-assets.mjs`의 목록을 고치고
`node scripts/build-assets.mjs <KayKit 폴더> <Quaternius 폴더>`를 실행한다(폴더 구성은 스크립트 머리말 참고).

## Android / iOS 빌드 (Capacitor)

네이티브 프로젝트는 아직 생성하지 않았다. Android Studio(Android) 또는 macOS + Xcode(iOS)가 있는 PC에서:

```bash
npx cap add android     # 최초 1회
npx cap add ios         # 최초 1회, macOS 필요
npm run cap:android     # 빌드 → 동기화 → Android Studio 열기
npm run cap:ios         # 빌드 → 동기화 → Xcode 열기
```

앱 ID와 이름은 `capacitor.config.json`에서 바꾼다.
