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
| 시점 회전 | 화면 오른쪽 드래그 | 마우스 드래그, Q / E |
| 공격 | 공격 버튼(누르고 있으면 연속) | J / Space |
| 구르기(무적 회피) | 구르기 버튼 | K / Shift |

## 게임 구조

- 한 층은 방 4개. 방을 정리하면 문이 열리고, 문 색과 글자로 다음 방 종류(전투 / 정예 / 보물)를 골라 들어간다.
- 층의 마지막 방은 정예 방이고, 3층마다 보스 방이다. 정리하면 다음 층으로 가는 문이 열린다.
- 전투 방을 정리하면 상자가 나온다(아이템 또는 물약, 정예·보스는 아이템 2개). 보물 방은 셋 중 하나를 고른다.
- 몬스터: 해골 졸병, 해골 병사, 해골 마법사(원거리), 보스 "탑의 수호자"(내려찍기 · 탄막 · 돌진). 붉은 바닥 표시가 공격 예고.
- 층이 오를수록 몬스터의 체력·공격력·수가 늘고, 3층마다 탑의 색조가 바뀐다.

## 코드

| 파일 | 내용 |
|---|---|
| `src/game.ts` | 게임 루프, 방 생성, 전투, 몬스터 AI, 아이템, HUD |
| `src/data.ts` | 플레이어 능력치, 아이템, 몬스터 수치 (밸런스 조정은 여기서) |
| `src/assets.ts` | glTF 모델 로딩, 캐릭터 복제와 애니메이션 재생(`Actor`) |
| `src/models.ts` | 방 구조물·이펙트용 기본 도형과 절차적 텍스처 |
| `src/input.ts` | 터치 조이스틱·버튼, 키보드·마우스 입력 |
| `scripts/build-assets.mjs` | 원본 모델에서 필요한 것만 골라 압축해 `public/models/`에 넣는 변환 스크립트 |

## 모델과 애니메이션

캐릭터(기사, 해골 졸병·병사·마법사, 보스)와 던전 소품은 [KayKit](https://www.kaylousberg.com) (Kay Lousberg)의
Adventurers / Skeletons / Dungeon Remastered 팩을 사용한다. 라이선스는 CC0로, 상업적 이용을 포함해 자유롭게 쓸 수 있다.

변환된 파일(`public/models/*.glb`, 합계 약 2MB)이 저장소에 들어 있어 따로 받을 필요는 없다.
모델이나 애니메이션을 추가하려면 `github.com/KayKit-Game-Assets`의 세 저장소를 한 폴더에 clone 한 뒤
`scripts/build-assets.mjs`의 목록을 고치고 `node scripts/build-assets.mjs <그 폴더>`를 실행한다.

## Android / iOS 빌드 (Capacitor)

네이티브 프로젝트는 아직 생성하지 않았다. Android Studio(Android) 또는 macOS + Xcode(iOS)가 있는 PC에서:

```bash
npx cap add android     # 최초 1회
npx cap add ios         # 최초 1회, macOS 필요
npm run cap:android     # 빌드 → 동기화 → Android Studio 열기
npm run cap:ios         # 빌드 → 동기화 → Xcode 열기
```

앱 ID와 이름은 `capacitor.config.json`에서 바꾼다.
