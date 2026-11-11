import * as THREE from 'three';
import { Input } from './input';
import { ENEMIES, ITEMS, POTION, baseStats, type EnemyDef, type EnemyKind, type ItemDef, type Stats } from './data';
import { Actor, prop, propSize } from './assets';
import { G, basic, blobShadow, brickTexture, labelSprite, lam, makeSlash, part, stoneTexture } from './models';

type RoomKind = 'combat' | 'elite' | 'treasure' | 'boss' | 'stairs';
type State = 'menu' | 'play' | 'transition' | 'dead';

const ROOMS_PER_FLOOR = 4;
const WALL_H = 6;
const ROOM_LABEL: Record<RoomKind, string> = {
  combat: '전투', elite: '정예', treasure: '보물', boss: '보스', stairs: '다음 층으로',
};
const ROOM_COLOR: Record<RoomKind, number> = {
  combat: 0xff8a4a, elite: 0xd04aff, treasure: 0xffd84a, boss: 0xff3030, stairs: 0x6ad0ff,
};
// 캐릭터 모델 배율(원본 키 약 2.3)
const MODEL_SCALE: Record<EnemyKind, number> = { minion: 0.72, skeleton: 0.85, mage: 0.85, boss: 2.0 };
// [클립, 타격 순간(초)] — 예고 시간이 끝나는 순간에 타격 동작이 맞도록 재생 속도를 정한다
const ATTACK_ANIM: Record<string, [string, number]> = {
  'minion.melee': ['Unarmed_Melee_Attack_Punch_A', 0.5],
  'skeleton.melee': ['1H_Melee_Attack_Chop', 0.45],
  'mage.shot': ['Spellcast_Shoot', 0.4],
  'boss.melee': ['1H_Melee_Attack_Jump_Chop', 0.75],
  'boss.burst': ['Spellcast_Summon', 1.6],
  'boss.charge': ['Taunt', 0.9],
};
// 3개 층마다 탑의 분위기(바닥·벽 색조)가 바뀐다.
const THEMES = [0xffffff, 0xb4d6a8, 0xe0a890, 0xa8bce8];

interface Enemy {
  kind: EnemyKind;
  def: EnemyDef;
  root: THREE.Group;
  actor: Actor;
  hp: number;
  maxHp: number;
  dmg: number;
  r: number;
  state: 'spawn' | 'chase' | 'windup' | 'recover' | 'charge';
  attack: 'melee' | 'shot' | 'burst' | 'charge';
  t: number;
  cd: number;
  kx: number;
  kz: number;
  flash: number;
  dx: number;
  dz: number;
  phase: number;
  scale: number;
  tele: THREE.Mesh;
  line: THREE.Mesh;
  bar: THREE.Sprite;
  barBg: THREE.Sprite;
  chargeHit: boolean;
}

interface Projectile { mesh: THREE.Mesh; vx: number; vz: number; life: number; dmg: number }
interface Corpse { root: THREE.Group; actor: Actor; t: number }
interface Pickup { type: 'chest' | 'heal' | 'item'; obj: THREE.Object3D; item?: ItemDef; t: number; r: number }
interface Door { kind: RoomKind; x: number; slab: THREE.Mesh; portal: THREE.Mesh; open: boolean }
interface Particle { mesh: THREE.Mesh; mat: THREE.MeshBasicMaterial; vx: number; vy: number; vz: number; life: number }

const rand = (a: number, b: number) => a + Math.random() * (b - a);
const pick = <T>(arr: T[]) => arr[Math.floor(Math.random() * arr.length)];
const $ = (id: string) => document.getElementById(id)!;

export class Game {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(55, 1, 0.1, 120);
  private timer = new THREE.Timer();
  private input: Input;
  private state: State = 'menu';

  private floorTex = stoneTexture();
  private wallTex = brickTexture();
  private floorMat = new THREE.MeshLambertMaterial({ map: this.floorTex });
  private wallMat = new THREE.MeshLambertMaterial({ map: this.wallTex });
  private torchA = new THREE.PointLight(0xffa860, 60, 22);
  private torchB = new THREE.PointLight(0xffa860, 60, 22);
  private barFg = new THREE.SpriteMaterial({ color: 0xe84a4a, depthTest: false });
  private barBg = new THREE.SpriteMaterial({ color: 0x000000, opacity: 0.6, transparent: true, depthTest: false });

  private room = new THREE.Group();
  private disposers: (() => void)[] = [];
  private hw = 9;
  private hd = 9;
  private obstacles: { x: number; z: number; r: number }[] = [];
  private enemies: Enemy[] = [];
  private projectiles: Projectile[] = [];
  private corpses: Corpse[] = [];
  private pickups: Pickup[] = [];
  private doors: Door[] = [];
  private particles: Particle[] = [];
  private kind: RoomKind = 'combat';
  private cleared = false;

  private heroRoot = new THREE.Group();
  private hero = new Actor('knight');
  private slash = makeSlash();
  private atkCount = 0;
  private stats: Stats = baseStats();
  private items: ItemDef[] = [];
  private hp = 100;
  private yaw = Math.PI;
  private targetYaw = Math.PI;
  private atkCd = 0;
  private atkT = 0;
  private atkDur = 0.3;
  private atkHit = false;
  private dodgeT = 0;
  private dodgeCd = 0;
  private dodgeX = 0;
  private dodgeZ = 0;
  private hurtT = 0;
  private walk = 0;

  private camYaw = 0;
  private camTarget = new THREE.Vector3();
  private shake = 0;
  private camDist = 10;

  floor = 1;
  roomIdx = 0;
  kills = 0;
  private toastTimer = 0;
  private tmp = new THREE.Vector3();

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.input = new Input(canvas);

    this.scene.background = new THREE.Color(0x0d0b12);
    this.scene.fog = new THREE.Fog(0x0d0b12, 18, 46);
    this.scene.add(new THREE.HemisphereLight(0xaab4d8, 0x2a2018, 1.5));
    const sun = new THREE.DirectionalLight(0xfff0d8, 1.3);
    sun.position.set(4, 10, 6);
    blobShadow(0.6, this.heroRoot);
    this.hero.root.scale.setScalar(0.85);
    this.heroRoot.add(this.hero.root, this.slash.mesh);
    this.hero.play('Idle');
    this.scene.add(sun, this.torchA, this.torchB, this.room, this.heroRoot);

    for (let i = 0; i < 48; i++) {
      const mat = new THREE.MeshBasicMaterial({ color: 0xffffff });
      const mesh = new THREE.Mesh(G.box, mat);
      mesh.visible = false;
      this.scene.add(mesh);
      this.particles.push({ mesh, mat, vx: 0, vy: 0, vz: 0, life: 0 });
    }

    this.timer.connect(document);
    window.addEventListener('resize', () => this.resize());
    this.resize();

    $('start').addEventListener('click', () => this.start());
    $('retry').addEventListener('click', () => this.start());
    const best = Number(localStorage.getItem('tower.best') || 0);
    if (best > 0) $('best').textContent = `최고 기록: ${best}층`;

    // 메뉴 뒤 배경으로 보일 방
    this.buildRoom('treasure', true);
    this.renderer.setAnimationLoop(() => this.frame());
  }

  // ───────────────────────── 진행 ─────────────────────────

  start() {
    this.stats = baseStats();
    this.items = [];
    this.hp = this.stats.maxHp;
    this.floor = 1;
    this.roomIdx = 0;
    this.kills = 0;
    this.heroRoot.visible = true;
    this.hero.release();
    this.hero.root.visible = true;
    this.hero.play('Idle');
    $('menu').classList.add('hidden');
    $('dead').classList.add('hidden');
    this.input.reset();
    this.buildRoom('combat');
    this.state = 'play';
    this.toast(`${this.floor}층`);
  }

  private nextOptions(): RoomKind[] {
    const last = ROOMS_PER_FLOOR - 1;
    if (this.roomIdx === last) return ['stairs'];
    if (this.roomIdx + 1 === last) return [this.floor % 3 === 0 ? 'boss' : 'elite'];
    const other: RoomKind = Math.random() < 0.4 ? 'treasure' : 'elite';
    return Math.random() < 0.5 ? ['combat', other] : [other, 'combat'];
  }

  private enterDoor(door: Door) {
    this.state = 'transition';
    $('fade').classList.add('on');
    setTimeout(() => {
      if (door.kind === 'stairs') {
        this.floor++;
        this.roomIdx = 0;
        this.heal(this.stats.maxHp * 0.25);
        const best = Number(localStorage.getItem('tower.best') || 0);
        if (this.floor > best) localStorage.setItem('tower.best', String(this.floor));
        this.buildRoom('combat');
        this.toast(`${this.floor}층`);
      } else {
        this.roomIdx++;
        this.buildRoom(door.kind);
      }
      $('fade').classList.remove('on');
      this.state = 'play';
    }, 280);
  }

  private die() {
    this.state = 'dead';
    this.heroRoot.visible = true;
    this.slash.mesh.visible = false;
    this.hero.root.visible = true;
    this.hero.play('Death_A', { once: true });
    const best = Math.max(this.floor, Number(localStorage.getItem('tower.best') || 0));
    localStorage.setItem('tower.best', String(best));
    $('result').innerHTML = `도달: <b>${this.floor}층</b> · 처치: <b>${this.kills}</b><br/>최고 기록: ${best}층`;
    setTimeout(() => $('dead').classList.remove('hidden'), 900);
  }

  // ───────────────────────── 방 생성 ─────────────────────────

  private clearRoom() {
    this.room.clear();
    for (const d of this.disposers) d();
    this.disposers = [];
    for (const p of this.projectiles) this.scene.remove(p.mesh);
    this.enemies = [];
    this.corpses = [];
    this.projectiles = [];
    this.pickups = [];
    this.doors = [];
    this.obstacles = [];
    $('boss').style.display = 'none';
  }

  private buildRoom(kind: RoomKind, backdrop = false) {
    this.clearRoom();
    this.kind = kind;
    this.cleared = false;
    const W = kind === 'boss' ? 28 : kind === 'treasure' ? 16 : pick([20, 22, 24]);
    const D = kind === 'boss' ? 28 : kind === 'treasure' ? 16 : pick([20, 22, 24]);
    const hw = (this.hw = W / 2);
    const hd = (this.hd = D / 2);

    const tint = THEMES[Math.floor((this.floor - 1) / 3) % THEMES.length];
    this.floorMat.color.setHex(tint);
    this.wallMat.color.setHex(tint);
    this.floorTex.repeat.set(W / 4, D / 4);
    this.wallTex.repeat.set(Math.max(W, D) / 4, WALL_H / 4);

    part(G.plane, this.floorMat, [W, D, 1], [0, 0, 0], this.room).rotation.x = -Math.PI / 2;
    // 방 바깥 바닥: 카메라가 벽 너머를 볼 때 검은 허공 대신 어두운 돌바닥이 보이게 한다.
    part(G.plane, lam(0x17151d), [160, 160, 1], [0, -0.03, 0], this.room).rotation.x = -Math.PI / 2;
    // 벽은 안쪽 면만 그려지므로, 카메라가 방 밖으로 나가도 시야를 가리지 않는다.
    part(G.plane, this.wallMat, [W, WALL_H, 1], [0, WALL_H / 2, -hd], this.room);
    part(G.plane, this.wallMat, [W, WALL_H, 1], [0, WALL_H / 2, hd], this.room).rotation.y = Math.PI;
    part(G.plane, this.wallMat, [D, WALL_H, 1], [-hw, WALL_H / 2, 0], this.room).rotation.y = Math.PI / 2;
    part(G.plane, this.wallMat, [D, WALL_H, 1], [hw, WALL_H / 2, 0], this.room).rotation.y = -Math.PI / 2;

    if (kind !== 'treasure') {
      const px = kind === 'boss' ? hw * 0.62 : hw * 0.5;
      const pz = kind === 'boss' ? hd * 0.62 : hd * 0.45;
      for (const [sx, sz] of [[1, 1], [-1, 1], [1, -1], [-1, -1]]) {
        const x = sx * px;
        const z = sz * pz;
        const size = propSize('pillar');
        const k = WALL_H / size.y;
        const pillar = prop('pillar');
        pillar.scale.set(k * 0.65, k, k * 0.65); // 시야를 덜 가리도록 가늘게
        pillar.position.set(x, 0, z);
        this.room.add(pillar);
        this.obstacles.push({ x, z, r: size.x * k * 0.65 * 0.5 });
      }
      // 구석의 나무통과 상자
      for (const [name, x, z, r] of [
        ['crates', -hw + 1.4, hd - 1.5, 1.0], ['barrel', hw - 1.2, hd - 1.3, 0.75], ['barrel', hw - 1.2, hd - 3.0, 0.75],
        ['barrel', -hw + 1.2, -hd + 1.3, 0.75],
      ] as const) {
        const o = prop(name, 0.62);
        o.position.set(x, 0, z);
        o.rotation.y = rand(0, 6);
        this.room.add(o);
        this.obstacles.push({ x, z, r });
      }
    }
    // 횃불과 깃발
    for (const [i, sx] of [-1, 1].entries()) {
      const x = sx * hw * 0.6;
      const torch = prop('torch', 1.3);
      torch.position.set(x, 2.6, -hd);
      this.room.add(torch);
      part(G.sphere, basic(0xffb347), [0.3, 0.42, 0.3], [x, 3.55, -hd + 0.6], this.room);
      (i === 0 ? this.torchA : this.torchB).position.set(x, 3.4, -hd + 1.2);
      part(G.plane, lam(ROOM_COLOR[kind]), [1.1, 2.4, 1], [sx * hw * 0.82, 3.6, -hd + 0.05], this.room);
    }

    const options = backdrop ? [] : this.nextOptions();
    options.forEach((k, i) => this.addDoor(k, options.length === 1 ? 0 : i === 0 ? -4 : 4));

    this.heroRoot.position.set(0, 0, hd - 2.5);
    this.yaw = this.targetYaw = Math.PI;
    this.camYaw = 0;
    this.atkT = this.dodgeT = 0;
    this.camTarget.copy(this.heroRoot.position);

    if (backdrop) {
      this.heroRoot.visible = false;
    } else if (kind === 'treasure') {
      const choices = [...ITEMS].sort(() => Math.random() - 0.5).slice(0, 3);
      choices.forEach((item, i) => this.addPedestal(item, (i - 1) * 4, -1));
      this.onCleared(false);
    } else {
      this.spawnEnemies(kind);
    }
    this.updateHud();
  }

  private addDoor(kind: RoomKind, x: number) {
    const z = -this.hd + 0.25;
    const stone = lam(0x3c3844);
    part(G.box, stone, [0.5, 3.6, 0.6], [x - 1.2, 1.8, z], this.room);
    part(G.box, stone, [0.5, 3.6, 0.6], [x + 1.2, 1.8, z], this.room);
    part(G.box, stone, [2.9, 0.5, 0.6], [x, 3.85, z], this.room);
    const slab = part(G.box, lam(0x5a3d22), [1.9, 3.6, 0.2], [x, 1.8, z], this.room);
    const portal = part(G.plane, basic(ROOM_COLOR[kind], 0.75), [1.9, 3.6, 1], [x, 1.8, z + 0.05], this.room);
    portal.visible = false;
    const label = labelSprite([ROOM_LABEL[kind]], `#${ROOM_COLOR[kind].toString(16).padStart(6, '0')}`);
    label.sprite.position.set(x, 2.3, z + 0.5);
    this.room.add(label.sprite);
    this.disposers.push(label.dispose);
    this.doors.push({ kind, x, slab, portal, open: false });
  }

  private addPedestal(item: ItemDef, x: number, z: number) {
    const g = new THREE.Group();
    g.position.set(x, 0, z);
    g.add(prop('column', 0.8));
    const gem = part(G.box, lam(item.color, 0x333333), [0.5, 0.5, 0.5], [0, 1.5, 0], g);
    gem.rotation.set(0.6, 0, 0.6);
    gem.name = 'gem';
    const label = labelSprite([item.name, item.desc]);
    label.sprite.position.set(0, 2.7, 0);
    g.add(label.sprite);
    this.disposers.push(label.dispose);
    this.room.add(g);
    this.obstacles.push({ x, z, r: 0.6 });
    this.pickups.push({ type: 'item', obj: g, item, t: 0, r: 1.5 });
  }

  private addChest(x: number, z: number) {
    const g = new THREE.Group();
    g.position.set(x, 0, z);
    g.add(prop('chest', 0.75));
    this.room.add(g);
    this.pickups.push({ type: 'chest', obj: g, t: 0, r: 1.3 });
  }

  private spawnEnemies(kind: RoomKind) {
    const f = this.floor;
    if (kind === 'boss') {
      this.addEnemy('boss', 0, -this.hd * 0.4, 1);
      if (f >= 6) {
        this.addEnemy('skeleton', -5, -2, 1);
        this.addEnemy('skeleton', 5, -2, 1);
      }
      return;
    }
    const pool: EnemyKind[] =
      f === 1 ? ['minion', 'minion', 'minion', 'skeleton']
      : f < 4 ? ['minion', 'minion', 'skeleton', 'skeleton', 'mage']
      : ['minion', 'skeleton', 'skeleton', 'mage', 'mage'];
    const elite = kind === 'elite';
    const count = Math.min(10, 3 + Math.floor(f * 0.7) + (this.roomIdx > 0 ? 1 : 0) + (elite ? 1 : 0));
    for (let i = 0; i < count; i++) {
      let x = 0;
      let z = 0;
      for (let tries = 0; tries < 20; tries++) {
        x = rand(-this.hw + 2, this.hw - 2);
        z = rand(-this.hd + 3, this.hd * 0.3);
        if (!this.obstacles.some((o) => Math.hypot(o.x - x, o.z - z) < o.r + 1.2)) break;
      }
      this.addEnemy(pick(pool), x, z, elite && i < 2 ? 1.35 : 1);
    }
  }

  private addEnemy(kind: EnemyKind, x: number, z: number, scale: number) {
    const def = ENEMIES[kind];
    const boss = kind === 'boss';
    const actor =
      kind === 'minion' ? new Actor('minion')
      : kind === 'mage' ? new Actor('mage', { right: 'staff' })
      : boss ? new Actor('warrior', { right: 'axe', left: 'shield', tint: 0xff8f7a })
      : new Actor('warrior', { right: 'blade', left: 'shield' });
    const ms = MODEL_SCALE[kind];
    actor.root.scale.setScalar(ms);
    const root = new THREE.Group();
    blobShadow(def.radius * 1.1, root);
    root.add(actor.root);
    root.position.set(x, 0, z);
    root.scale.setScalar(scale);
    this.room.add(root);
    this.disposers.push(() => actor.dispose());
    const lvl = this.floor - 1;
    const hp = def.hp * (1 + lvl * (boss ? 0.2 : 0.22)) * (scale > 1 ? 1.8 : 1);
    // 땅에서 솟아오르는 등장 동작(원본 3.57초)을 빠르게 재생
    const spawnSpeed = rand(2.6, 3.4);
    actor.play('Spawn_Ground_Skeletons', { once: true, speed: spawnSpeed, fade: 0 });
    actor.update(0);

    const tele = part(G.circle, basic(0xff2a2a, 0.3), [1, 1, 1], [0, 0.05, 0], this.room);
    tele.rotation.x = -Math.PI / 2;
    tele.visible = false;
    const line = part(G.plane, basic(0xff2a2a, 0.3), [3, 14, 1], [0, 0.05, 0], this.room);
    line.rotation.x = -Math.PI / 2;
    line.rotation.order = 'YXZ';
    line.visible = false;

    const barW = boss ? 0 : 1.2;
    const barBg = new THREE.Sprite(this.barBg);
    const bar = new THREE.Sprite(this.barFg);
    barBg.scale.set(barW + 0.08, 0.2, 1);
    bar.scale.set(barW, 0.12, 1);
    barBg.position.y = bar.position.y = 2.45 * ms + 0.25;
    barBg.visible = bar.visible = false;
    barBg.renderOrder = 10;
    bar.renderOrder = 11;
    root.add(barBg, bar);

    this.enemies.push({
      kind, def, root, actor, hp, maxHp: hp,
      dmg: def.dmg * (1 + lvl * 0.14) * (scale > 1 ? 1.25 : 1),
      r: def.radius * scale, state: 'spawn', attack: 'melee', t: 3.4 / spawnSpeed, cd: rand(0.3, 1.2),
      kx: 0, kz: 0, flash: 0, dx: 0, dz: 1, phase: rand(0, 6), scale, tele, line, bar, barBg, chargeHit: false,
    });
    if (boss) {
      $('boss').style.display = 'block';
      $('bossname').textContent = `${def.name} · ${this.floor}층`;
      $('bossfill').style.width = '100%';
    }
  }

  private onCleared(reward = true) {
    this.cleared = true;
    for (const d of this.doors) {
      d.open = true;
      d.slab.visible = false;
      d.portal.visible = true;
    }
    if (reward) {
      this.addChest(0, 0);
      this.toast(this.kind === 'boss' ? '보스 처치! 상자를 열어보세요' : '방을 정리했습니다');
    }
  }

  // ───────────────────────── 프레임 ─────────────────────────

  private frame() {
    this.timer.update();
    const dt = Math.min(this.timer.getDelta(), 0.05);
    this.input.poll(dt);
    if (this.state === 'play') {
      this.updatePlayer(dt);
      this.updateEnemies(dt);
      this.updateProjectiles(dt);
      this.updatePickups(dt);
      this.updateDoors();
    } else if (this.state === 'menu') {
      this.camYaw += dt * 0.15;
    }
    this.hero.update(dt);
    for (const e of this.enemies) e.actor.update(dt);
    for (let i = this.corpses.length - 1; i >= 0; i--) {
      const c = this.corpses[i];
      c.actor.update(dt);
      c.t -= dt;
      if (c.t < 0.4) c.root.position.y -= dt * 2.5; // 바닥으로 가라앉으며 사라진다
      if (c.t <= 0) {
        this.room.remove(c.root);
        this.corpses.splice(i, 1);
      }
    }
    this.updateParticles(dt);
    this.updateCamera(dt);
    this.renderer.render(this.scene, this.camera);
  }

  private resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    const portrait = w < h;
    this.camera.fov = portrait ? 72 : 55;
    this.camDist = portrait ? 11.5 : 10;
    this.camera.updateProjectionMatrix();
  }

  private updateCamera(dt: number) {
    if (this.state === 'play') this.camYaw -= this.input.takeCamDX() * 0.006;
    const p = this.heroRoot.position;
    this.camTarget.lerp(this.tmp.set(p.x, 1.2, p.z), 1 - Math.exp(-10 * dt));
    const pitch = 0.74;
    const d = this.camDist;
    this.shake = Math.max(0, this.shake - dt * 2.5);
    const s = this.shake * 0.5;
    this.camera.position.set(
      this.camTarget.x + Math.sin(this.camYaw) * Math.cos(pitch) * d + rand(-s, s),
      this.camTarget.y + Math.sin(pitch) * d + rand(-s, s),
      this.camTarget.z + Math.cos(this.camYaw) * Math.cos(pitch) * d,
    );
    this.camera.lookAt(this.camTarget);
  }

  /** 원형 충돌체를 방 안쪽과 장애물 바깥으로 밀어낸다. */
  private collide(pos: THREE.Vector3, r: number) {
    pos.x = THREE.MathUtils.clamp(pos.x, -this.hw + r, this.hw - r);
    pos.z = THREE.MathUtils.clamp(pos.z, -this.hd + r, this.hd - r);
    for (const o of this.obstacles) {
      const dx = pos.x - o.x;
      const dz = pos.z - o.z;
      const d = Math.hypot(dx, dz);
      const min = o.r + r;
      if (d < min && d > 1e-4) {
        pos.x = o.x + (dx / d) * min;
        pos.z = o.z + (dz / d) * min;
      }
    }
  }

  // ───────────────────────── 플레이어 ─────────────────────────

  private updatePlayer(dt: number) {
    const inp = this.input;
    const s = this.stats;
    const pos = this.heroRoot.position;
    this.atkCd -= dt;
    this.dodgeCd -= dt;
    this.hurtT -= dt;

    let mx = inp.moveX;
    let my = inp.moveY;
    const len = Math.hypot(mx, my);
    if (len > 1) {
      mx /= len;
      my /= len;
    }
    // 카메라 기준 이동: 화면 위쪽이 카메라가 바라보는 방향
    const sy = Math.sin(this.camYaw);
    const cy = Math.cos(this.camYaw);
    const wx = cy * mx - sy * my;
    const wz = -sy * mx - cy * my;
    const moving = len > 0.15;

    if (inp.takeDodge() && this.dodgeCd <= 0) {
      const wl = Math.hypot(wx, wz);
      this.dodgeX = moving ? wx / wl : Math.sin(this.yaw);
      this.dodgeZ = moving ? wz / wl : Math.cos(this.yaw);
      this.targetYaw = Math.atan2(this.dodgeX, this.dodgeZ);
      this.dodgeT = 0.28;
      this.dodgeCd = 0.85;
      this.atkT = 0;
      this.hero.play('Dodge_Forward', { once: true, speed: 1.4, fade: 0.05 });
    }

    if (this.dodgeT > 0) {
      this.dodgeT -= dt;
      pos.x += this.dodgeX * 17 * dt;
      pos.z += this.dodgeZ * 17 * dt;
    } else {
      if (inp.attack && this.atkCd <= 0) this.startAttack();
      const speed = s.speed * (this.atkT > 0 ? 0.35 : 1);
      if (moving) {
        pos.x += wx * speed * dt;
        pos.z += wz * speed * dt;
        if (this.atkT <= 0) this.targetYaw = Math.atan2(wx, wz);
      }
    }

    if (this.atkT > 0) {
      this.atkT -= dt;
      if (!this.atkHit && this.atkDur - this.atkT >= this.atkDur * 0.5) this.strike();
    }
    this.collide(pos, 0.45);

    // 회전 보간(가까운 쪽으로)
    let dy = this.targetYaw - this.yaw;
    dy = Math.atan2(Math.sin(dy), Math.cos(dy));
    this.yaw += dy * Math.min(1, dt * 18);

    // 애니메이션
    this.heroRoot.rotation.y = this.yaw;
    if (this.dodgeT <= 0 && this.atkT <= 0) {
      this.hero.release();
      this.hero.play(moving ? 'Running_A' : 'Idle', { speed: moving ? s.speed / 6 * 1.25 : 1 });
    }
    if (this.atkT > 0) {
      const q = 1 - this.atkT / this.atkDur;
      this.slash.mesh.visible = q > 0.35;
      this.slash.mat.opacity = 0.75 * (1 - q);
      const r = 2.7 * s.range;
      this.slash.mesh.scale.set(r, r, 1);
    } else {
      this.slash.mesh.visible = false;
    }
    this.hero.root.visible = !(this.hurtT > 0 && Math.floor(this.hurtT * 20) % 2 === 0);
    $('btnDodge').classList.toggle('cd', this.dodgeCd > 0);
  }

  private startAttack() {
    const s = this.stats;
    this.atkDur = 0.3 / s.atkSpeed;
    this.atkT = this.atkDur;
    this.atkCd = 0.42 / s.atkSpeed;
    this.atkHit = false;
    const clip = this.atkCount++ % 2 ? '1H_Melee_Attack_Slice_Horizontal' : '1H_Melee_Attack_Slice_Diagonal';
    this.hero.play(clip, { once: true, speed: 2.4 * s.atkSpeed, fade: 0.06 });
    // 가까운 적 쪽으로 자동 조준(모바일에서 방향 맞추기 쉽게)
    const pos = this.heroRoot.position;
    let best: Enemy | null = null;
    let bestD = 5.5;
    for (const e of this.enemies) {
      if (e.state === 'spawn') continue;
      const d = Math.hypot(e.root.position.x - pos.x, e.root.position.z - pos.z) - e.r;
      if (d < bestD) {
        bestD = d;
        best = e;
      }
    }
    if (best) {
      this.targetYaw = Math.atan2(best.root.position.x - pos.x, best.root.position.z - pos.z);
      this.yaw = this.targetYaw;
    }
  }

  private strike() {
    this.atkHit = true;
    const s = this.stats;
    const pos = this.heroRoot.position;
    const fx = Math.sin(this.yaw);
    const fz = Math.cos(this.yaw);
    const range = 2.7 * s.range;
    let hitAny = false;
    for (const e of [...this.enemies]) {
      if (e.state === 'spawn') continue;
      const dx = e.root.position.x - pos.x;
      const dz = e.root.position.z - pos.z;
      const d = Math.hypot(dx, dz);
      if (d > range + e.r) continue;
      // 전방 약 130도 부채꼴. 몸이 겹칠 만큼 가까우면 각도와 무관하게 맞는다.
      if (d > e.r + 0.6 && (dx * fx + dz * fz) / d < 0.42) continue;
      const crit = Math.random() < s.crit;
      this.damageEnemy(e, s.atk * rand(0.9, 1.1) * (crit ? 2 : 1), crit, dx / (d || 1), dz / (d || 1));
      hitAny = true;
    }
    if (hitAny) this.shake = Math.max(this.shake, 0.25);
  }

  private damageEnemy(e: Enemy, dmg: number, crit: boolean, nx: number, nz: number) {
    e.hp -= dmg;
    e.flash = 0.12;
    if (e.kind !== 'boss') {
      e.kx = nx * 4.5;
      e.kz = nz * 4.5;
      if (e.state === 'chase') e.actor.play('Hit_A', { once: true, speed: 1.8, fade: 0.05 });
    }
    const p = e.root.position;
    this.floatText(this.tmp.set(p.x, 1.6 * e.scale, p.z), String(Math.round(dmg)), crit ? 'crit' : '');
    this.burst(p.x, 1, p.z, 0xffe9b0, 5);
    if (e.kind === 'boss') $('bossfill').style.width = `${Math.max(0, (e.hp / e.maxHp) * 100)}%`;
    if (e.hp <= 0) this.killEnemy(e);
  }

  private killEnemy(e: Enemy) {
    const p = e.root.position;
    this.room.remove(e.tele, e.line);
    e.root.remove(e.bar, e.barBg);
    for (const m of e.actor.mats) m.emissive.setRGB(0, 0, 0);
    e.actor.play('Death_C_Skeletons', { once: true, speed: 1.5, fade: 0.05 });
    this.corpses.push({ root: e.root, actor: e.actor, t: 2.2 });
    this.enemies.splice(this.enemies.indexOf(e), 1);
    this.kills++;
    this.burst(p.x, 0.8, p.z, 0xe8e4d4, e.kind === 'boss' ? 30 : 10);
    if (this.stats.lifesteal > 0) this.heal(this.stats.lifesteal);
    if (e.kind === 'boss') $('boss').style.display = 'none';
    if (Math.random() < 0.18 || e.kind === 'boss') {
      const orb = part(G.sphere, basic(0x5aff8a), [0.45, 0.45, 0.45], [p.x, 0.5, p.z], this.room);
      this.pickups.push({ type: 'heal', obj: orb, t: 0, r: 1.1 });
    }
    if (this.enemies.length === 0 && !this.cleared) this.onCleared();
  }

  private damagePlayer(dmg: number) {
    if (this.dodgeT > 0 || this.hurtT > 0 || this.state !== 'play') return;
    const d = Math.max(1, Math.round(dmg * (1 - this.stats.armor)));
    this.hp -= d;
    this.hurtT = 0.6;
    this.shake = 0.5;
    const p = this.heroRoot.position;
    this.floatText(this.tmp.set(p.x, 2.2, p.z), `-${d}`, 'hurt');
    const hurt = $('hurt');
    hurt.style.opacity = '1';
    setTimeout(() => (hurt.style.opacity = '0'), 150);
    this.updateHud();
    if (this.hp <= 0) this.die();
  }

  private heal(amount: number) {
    const before = this.hp;
    this.hp = Math.min(this.stats.maxHp, this.hp + amount);
    const got = Math.round(this.hp - before);
    if (got > 0 && this.state === 'play') {
      const p = this.heroRoot.position;
      this.floatText(this.tmp.set(p.x, 2.2, p.z), `+${got}`, 'heal');
    }
    this.updateHud();
  }

  private giveItem(item: ItemDef) {
    item.apply({ stats: this.stats, heal: (n) => this.heal(n) });
    if (!item.instant) this.items.push(item);
    this.toast(`${item.icon} ${item.name} — ${item.desc}`);
    this.updateHud();
  }

  // ───────────────────────── 몬스터 ─────────────────────────

  private updateEnemies(dt: number) {
    const pp = this.heroRoot.position;
    for (const e of [...this.enemies]) {
      const pos = e.root.position;
      e.phase += dt;
      if (e.flash > 0) {
        e.flash -= dt;
        const v = e.flash > 0 ? 0.8 : 0;
        for (const m of e.actor.mats) m.emissive.setRGB(v, v, v);
      }
      if (e.state === 'spawn') {
        e.t -= dt;
        if (e.t <= 0) {
          e.state = 'chase';
          e.actor.release();
        }
        continue;
      }
      const dx = pp.x - pos.x;
      const dz = pp.z - pos.z;
      const dist = Math.hypot(dx, dz) || 1e-4;
      const nx = dx / dist;
      const nz = dz / dist;
      const boss = e.kind === 'boss';
      const enraged = boss && e.hp < e.maxHp * 0.5;
      e.cd -= dt;

      if (e.state === 'chase') {
        e.root.rotation.y = Math.atan2(nx, nz);
        let mv = 1;
        if (e.def.ranged) mv = dist < 5 ? -0.8 : dist > 8 ? 1 : 0;
        else if (dist < e.r + 0.6) mv = 0;
        pos.x += nx * e.def.speed * mv * dt;
        pos.z += nz * e.def.speed * mv * dt;
        if (e.def.ranged && mv === 0) {
          // 사거리 안에서는 옆으로 돌며 거리를 유지
          pos.x += -nz * 1.2 * dt * Math.sign(Math.sin(e.phase * 0.5));
          pos.z += nx * 1.2 * dt * Math.sign(Math.sin(e.phase * 0.5));
        }
        if (e.cd <= 0 && (dist < e.def.range + e.r || (boss && dist < 16))) {
          e.state = 'windup';
          e.dx = nx;
          e.dz = nz;
          if (boss) e.attack = dist < e.def.range + e.r ? 'melee' : Math.random() < 0.5 ? 'burst' : 'charge';
          else e.attack = e.def.ranged ? 'shot' : 'melee';
          e.t = e.def.windup * (enraged ? 0.75 : 1);
          e.root.rotation.y = Math.atan2(nx, nz);
          const [clip, hitAt] = ATTACK_ANIM[`${e.kind}.${e.attack}`];
          e.actor.play(clip, { once: true, speed: hitAt / e.t, fade: 0.08 });
          if (e.attack === 'melee') {
            e.tele.visible = true;
            e.tele.position.set(pos.x, 0.05, pos.z);
          } else if (e.attack === 'charge') {
            e.line.visible = true;
            e.line.position.set(pos.x + nx * 7, 0.05, pos.z + nz * 7);
            e.line.rotation.y = Math.atan2(nx, nz);
          }
        }
        if (mv === 0) e.actor.play('Idle_Combat');
        else e.actor.play(e.def.ranged ? 'Walking_A' : 'Running_A', { speed: e.def.ranged ? 1.5 : e.def.speed / 3 });
      } else if (e.state === 'windup') {
        e.t -= dt;
        const total = e.def.windup * (enraged ? 0.75 : 1);
        const q = 1 - Math.max(0, e.t) / total;
        const hitR = e.def.hitRadius * e.scale;
        if (e.attack === 'melee') e.tele.scale.setScalar(hitR * 2 * (0.3 + 0.7 * q));
        if (e.t <= 0) {
          e.tele.visible = false;
          e.state = 'recover';
          e.t = e.def.recover;
          e.cd = e.def.cooldown * (enraged ? 0.7 : 1);
          if (e.attack === 'melee') {
            if (dist < hitR + 0.3) this.damagePlayer(e.dmg);
            this.burst(pos.x, 0.2, pos.z, 0xff6a4a, boss ? 16 : 6);
            if (boss) this.shake = Math.max(this.shake, 0.5);
          } else if (e.attack === 'shot') {
            this.shoot(pos.x, pos.z, nx, nz, 9, e.dmg);
          } else if (e.attack === 'burst') {
            const n = 10 + Math.min(8, this.floor) + (enraged ? 4 : 0);
            const off = Math.random() * Math.PI;
            for (let i = 0; i < n; i++) {
              const a = off + (i / n) * Math.PI * 2;
              this.shoot(pos.x, pos.z, Math.sin(a), Math.cos(a), 7, e.dmg * 0.7);
            }
          } else {
            e.state = 'charge';
            e.t = 0.75;
            e.chargeHit = false;
            e.line.visible = false;
            e.actor.release();
            e.actor.play('Running_A', { speed: 2.2 });
          }
        }
      } else if (e.state === 'charge') {
        e.t -= dt;
        pos.x += e.dx * 17 * dt;
        pos.z += e.dz * 17 * dt;
        if (!e.chargeHit && dist < e.r + 0.7) {
          e.chargeHit = true;
          this.damagePlayer(e.dmg * 1.2);
        }
        if (e.t <= 0) {
          e.state = 'recover';
          e.t = e.def.recover;
        }
      } else {
        e.t -= dt;
        if (e.t <= 0) {
          e.state = 'chase';
          e.actor.release();
        }
      }

      // 넉백과 서로 겹치지 않게 밀어내기
      pos.x += e.kx * dt;
      pos.z += e.kz * dt;
      e.kx *= Math.exp(-9 * dt);
      e.kz *= Math.exp(-9 * dt);
      for (const o of this.enemies) {
        if (o === e) continue;
        const ox = pos.x - o.root.position.x;
        const oz = pos.z - o.root.position.z;
        const od = Math.hypot(ox, oz);
        const min = e.r + o.r;
        if (od < min && od > 1e-4 && e.kind !== 'boss') {
          pos.x += (ox / od) * (min - od) * 0.5;
          pos.z += (oz / od) * (min - od) * 0.5;
        }
      }
      this.collide(pos, e.r);

      if (!boss) {
        const frac = Math.max(0, e.hp / e.maxHp);
        const show = frac < 1 && frac > 0;
        e.bar.visible = e.barBg.visible = show;
        if (show) {
          // 왼쪽 끝을 배경 막대에 맞춘 채 길이만 줄인다
          e.bar.scale.x = 1.2 * frac;
          e.bar.center.x = 0.5 / frac;
        }
      }
    }
  }

  private shoot(x: number, z: number, nx: number, nz: number, speed: number, dmg: number) {
    const mesh = part(G.sphere, basic(0xc070ff), [0.45, 0.45, 0.45], [x + nx, 1.1, z + nz], this.scene);
    this.projectiles.push({ mesh, vx: nx * speed, vz: nz * speed, life: 5, dmg });
  }

  private updateProjectiles(dt: number) {
    const pp = this.heroRoot.position;
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const p = this.projectiles[i];
      const m = p.mesh.position;
      m.x += p.vx * dt;
      m.z += p.vz * dt;
      p.life -= dt;
      let dead = p.life <= 0 || Math.abs(m.x) > this.hw - 0.2 || Math.abs(m.z) > this.hd - 0.2;
      if (!dead && this.obstacles.some((o) => Math.hypot(o.x - m.x, o.z - m.z) < o.r)) dead = true;
      if (!dead && this.dodgeT <= 0 && Math.hypot(pp.x - m.x, pp.z - m.z) < 0.7) {
        this.damagePlayer(p.dmg);
        dead = true;
      }
      if (dead) {
        this.burst(m.x, 1.1, m.z, 0xc070ff, 4);
        this.scene.remove(p.mesh);
        this.projectiles.splice(i, 1);
      }
    }
  }

  // ───────────────────────── 아이템 · 문 ─────────────────────────

  private updatePickups(dt: number) {
    const pp = this.heroRoot.position;
    for (const pk of [...this.pickups]) {
      pk.t += dt;
      const o = pk.obj;
      if (pk.type === 'heal') o.position.y = 0.5 + Math.sin(pk.t * 4) * 0.12;
      if (pk.type === 'item') {
        const gem = o.getObjectByName('gem')!;
        gem.rotation.y += dt * 2;
        gem.position.y = 1.5 + Math.sin(pk.t * 3) * 0.1;
      }
      if (pk.t < 0.4 || Math.hypot(pp.x - o.position.x, pp.z - o.position.z) > pk.r) continue;

      if (pk.type === 'heal') {
        if (this.hp >= this.stats.maxHp) continue;
        this.heal(this.stats.maxHp * 0.12);
      } else if (pk.type === 'chest') {
        this.burst(o.position.x, 0.8, o.position.z, 0xffd84a, 16);
        const count = this.kind === 'elite' || this.kind === 'boss' ? 2 : 1;
        // 일반 전투 상자는 절반 확률로 물약, 정예·보스 상자는 아이템 확정
        if (count === 1 && Math.random() < 0.5) this.giveItem(POTION);
        else for (let i = 0; i < count; i++) this.giveItem(pick(ITEMS));
        const lid = o.getObjectByName('chest_gold_lid');
        if (lid) lid.rotation.x = -1.1;
        this.pickups.splice(this.pickups.indexOf(pk), 1);
        continue;
      } else {
        this.giveItem(pk.item!);
        // 셋 중 하나만 고를 수 있다
        for (const other of this.pickups.filter((x) => x.type === 'item' && x !== pk)) {
          this.room.remove(other.obj);
          this.pickups.splice(this.pickups.indexOf(other), 1);
        }
        this.obstacles = this.obstacles.filter((ob) => ob.r !== 0.6);
      }
      this.room.remove(o);
      this.pickups.splice(this.pickups.indexOf(pk), 1);
    }
  }

  private updateDoors() {
    const pp = this.heroRoot.position;
    for (const d of this.doors) {
      if (d.open && Math.abs(pp.x - d.x) < 1.0 && pp.z < -this.hd + 1.3) {
        this.enterDoor(d);
        return;
      }
    }
  }

  // ───────────────────────── 이펙트 · HUD ─────────────────────────

  private burst(x: number, y: number, z: number, color: number, n: number) {
    for (const p of this.particles) {
      if (n <= 0) break;
      if (p.life > 0) continue;
      n--;
      p.life = rand(0.3, 0.6);
      p.mat.color.setHex(color);
      p.mesh.position.set(x, y, z);
      p.mesh.scale.setScalar(rand(0.08, 0.2));
      p.mesh.visible = true;
      const a = rand(0, Math.PI * 2);
      const sp = rand(2, 6);
      p.vx = Math.cos(a) * sp;
      p.vz = Math.sin(a) * sp;
      p.vy = rand(2, 6);
    }
  }

  private updateParticles(dt: number) {
    for (const p of this.particles) {
      if (p.life <= 0) continue;
      p.life -= dt;
      p.vy -= 16 * dt;
      p.mesh.position.x += p.vx * dt;
      p.mesh.position.y = Math.max(0.05, p.mesh.position.y + p.vy * dt);
      p.mesh.position.z += p.vz * dt;
      if (p.life <= 0) p.mesh.visible = false;
    }
  }

  private floatText(world: THREE.Vector3, text: string, cls: string) {
    const v = world.project(this.camera);
    if (v.z > 1) return;
    const el = document.createElement('span');
    el.textContent = text;
    el.className = cls;
    el.style.left = `${(v.x * 0.5 + 0.5) * window.innerWidth}px`;
    el.style.top = `${(-v.y * 0.5 + 0.5) * window.innerHeight}px`;
    $('dmg').appendChild(el);
    setTimeout(() => el.remove(), 700);
  }

  private toast(text: string) {
    const el = $('toast');
    el.textContent = text;
    el.classList.add('show');
    clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => el.classList.remove('show'), 2200);
  }

  private updateHud() {
    const hp = Math.max(0, Math.ceil(this.hp));
    $('hpfill').style.width = `${(hp / this.stats.maxHp) * 100}%`;
    $('hptext').textContent = `${hp} / ${Math.round(this.stats.maxHp)}`;
    $('floor').innerHTML = `${this.floor}층<small>방 ${this.roomIdx + 1} / ${ROOMS_PER_FLOOR} · ${ROOM_LABEL[this.kind]}</small>`;
    const counts = new Map<ItemDef, number>();
    for (const it of this.items) counts.set(it, (counts.get(it) || 0) + 1);
    $('items').innerHTML = [...counts].map(([it, n]) => `<span>${it.icon}${n > 1 ? `×${n}` : ''}</span>`).join('');
  }
}
