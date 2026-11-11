export interface Stats {
  maxHp: number;
  atk: number;
  speed: number;
  atkSpeed: number;
  range: number;
  crit: number;
  armor: number;
  lifesteal: number;
}

export const baseStats = (): Stats => ({
  maxHp: 100,
  atk: 20,
  speed: 6,
  atkSpeed: 1,
  range: 1,
  crit: 0.05,
  armor: 0,
  lifesteal: 0,
});

export interface ItemTarget {
  stats: Stats;
  heal(amount: number): void;
}

export interface ItemDef {
  id: string;
  icon: string;
  name: string;
  desc: string;
  color: number;
  /** true면 즉시 소모되고 보유 목록에 남지 않는다 */
  instant?: boolean;
  apply(t: ItemTarget): void;
}

export const ITEMS: ItemDef[] = [
  { id: 'sword', icon: '🗡️', name: '날카로운 검', desc: '공격력 +25%', color: 0xd0d8e8, apply: (t) => (t.stats.atk *= 1.25) },
  { id: 'boots', icon: '🥾', name: '바람의 장화', desc: '이동 속도 +10%', color: 0x8ad0ff, apply: (t) => (t.stats.speed *= 1.1) },
  {
    id: 'heart', icon: '❤️', name: '생명의 심장', desc: '최대 체력 +25', color: 0xff5a6a,
    apply: (t) => { t.stats.maxHp += 25; t.heal(25); },
  },
  { id: 'gloves', icon: '🧤', name: '신속의 장갑', desc: '공격 속도 +15%', color: 0xffc46b, apply: (t) => (t.stats.atkSpeed *= 1.15) },
  { id: 'ring', icon: '💍', name: '흡혈의 반지', desc: '처치 시 체력 +4', color: 0xc04ad0, apply: (t) => (t.stats.lifesteal += 4) },
  { id: 'blade', icon: '⚔️', name: '긴 칼날', desc: '공격 범위 +15%', color: 0xa0ffe0, apply: (t) => (t.stats.range *= 1.15) },
  {
    id: 'armor', icon: '🛡️', name: '강철 갑옷', desc: '받는 피해 -12%', color: 0x9aa4b8,
    apply: (t) => (t.stats.armor = 1 - (1 - t.stats.armor) * 0.88),
  },
  { id: 'charm', icon: '🍀', name: '치명의 부적', desc: '치명타 확률 +10%', color: 0x6adf6a, apply: (t) => (t.stats.crit += 0.1) },
];

export const POTION: ItemDef = {
  id: 'potion', icon: '🧪', name: '회복 물약', desc: '체력 35% 회복', color: 0x5aff8a, instant: true,
  apply: (t) => t.heal(t.stats.maxHp * 0.35),
};

export type EnemyKind = 'minion' | 'skeleton' | 'mage' | 'boss';

export interface EnemyDef {
  name: string;
  hp: number;
  speed: number;
  dmg: number;
  radius: number;
  /** 공격을 시작하는 거리 */
  range: number;
  /** 근접 공격 판정 반경(예고 원의 크기) */
  hitRadius: number;
  windup: number;
  recover: number;
  cooldown: number;
  ranged?: boolean;
}

export const ENEMIES: Record<EnemyKind, EnemyDef> = {
  minion: { name: '해골 졸병', hp: 30, speed: 2.6, dmg: 11, radius: 0.5, range: 1.3, hitRadius: 1.7, windup: 0.45, recover: 0.5, cooldown: 1.0 },
  skeleton: { name: '해골 병사', hp: 50, speed: 3.6, dmg: 15, radius: 0.45, range: 1.7, hitRadius: 2.1, windup: 0.5, recover: 0.6, cooldown: 1.2 },
  mage: { name: '해골 마법사', hp: 35, speed: 2.6, dmg: 13, radius: 0.45, range: 9, hitRadius: 0, windup: 0.7, recover: 0.4, cooldown: 2.2, ranged: true },
  boss: { name: '탑의 수호자', hp: 520, speed: 3, dmg: 22, radius: 1.5, range: 4, hitRadius: 4.4, windup: 0.9, recover: 0.8, cooldown: 1.4 },
};
