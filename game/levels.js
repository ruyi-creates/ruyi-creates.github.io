/* ============================================================
 * 青崖守印 · 关卡配置（配置驱动，加新关=加一份配置+一张地图）
 * ============================================================ */

const TOWER_DEFS = {
  crossbow: {
    name: '灵弩台', kind: 'single', damageType: 'physical', color: '#a78bfa',
    role: '极快单体，清扫小妖与补刀',
    levels: [
      { cost: 60,  range: 135, cooldown: 0.50, damage: 8  },
      { cost: 90,  range: 148, cooldown: 0.40, damage: 14 },
    ],
  },
  talisman: {
    name: '符咒楼', kind: 'single', damageType: 'magic', color: '#22d3ee',
    role: '慢速高伤法术，克制石甲硬怪',
    levels: [
      { cost: 90,  range: 150, cooldown: 1.40, damage: 30 },
      { cost: 130, range: 162, cooldown: 1.20, damage: 52 },
    ],
  },
  barracks: {
    name: '云翼营', kind: 'block', damageType: 'physical', color: '#f0f9ff',
    role: '遣云翼卫下场拦截，可调集结点',
    rallyRange: 130,
    levels: [
      { cost: 80,  range: 130, soldiers: 2, soldierHp: 40, soldierDmg: 5, soldierCd: 0.8, respawn: 6 },
      { cost: 110, range: 140, soldiers: 3, soldierHp: 70, soldierDmg: 9, soldierCd: 0.7, respawn: 5 },
    ],
  },
  mortar: {
    name: '雷火瓮', kind: 'splash', damageType: 'physical', color: '#fb923c',
    role: '慢速范围爆炸，克制成群敌人',
    levels: [
      { cost: 110, range: 130, cooldown: 2.20, damage: 22, splash: 55 },
      { cost: 150, range: 140, cooldown: 2.00, damage: 38, splash: 66 },
    ],
  },
};

const ENEMY_DEFS = {
  // KR4 比例尺：英雄 128 为基准，小怪 0.6、精英 0.85、小兵 0.6
  miasma:  { name: '瘴气灵', hp: 35,  speed: 50, reward: 8,  leak: 1, color: '#34d399', physResist: 0,    magicResist: 0,    size: 78 },
  windfox: { name: '风行妖', hp: 26,  speed: 85, reward: 10, leak: 1, color: '#fb923c', physResist: 0,    magicResist: 0,    size: 84 },
  shanxiao:{ name: '山魈',   hp: 160, speed: 32, reward: 20, leak: 2, color: '#9ca3af', physResist: 0.30, magicResist: -0.15, size: 110 },
};

const HERO_DEF = {
  name: '沈烬明', title: '破军镇印刀',
  hp: 220, damage: 18, cooldown: 0.7, range: 46, aggroRange: 110,
  moveSpeed: 95, respawn: 15,
  xpPerLevel: [0, 30, 70, 130, 210],   // Lv1~Lv5 累计经验
  hpPerLevel: 40, dmgPerLevel: 6,
  skill: { name: '破围斩', unlockLevel: 3, cooldown: 45, radius: 135, damage: 120, color: '#c4b5fd' },
};

const LEVELS = [
  {
    id: 1,
    name: '青崖入口',
    subtitle: '第十三站支线 · 六塔位 · 可升至 Lv.2',
    map: './game-assets/defense/maps/map-level-1-a.webp',
    startGold: 220, startLives: 20,
    maxTowerLevel: 2,
    hero: true,
    // A 稿路径点（按地图发光灵路中心线标定，相对坐标）
    path: [
      [0.099, 0.453], [0.117, 0.472], [0.141, 0.523], [0.167, 0.573],
      [0.197, 0.613], [0.233, 0.635], [0.266, 0.622], [0.296, 0.588],
      [0.320, 0.534], [0.341, 0.464], [0.371, 0.416], [0.407, 0.392],
      [0.440, 0.401], [0.469, 0.444], [0.493, 0.517], [0.511, 0.596],
      [0.532, 0.675], [0.562, 0.731], [0.598, 0.759], [0.637, 0.766],
      [0.676, 0.748], [0.712, 0.708], [0.745, 0.658], [0.772, 0.596],
      [0.795, 0.545], [0.822, 0.506],
    ],
    // 塔位（6 个）：只保留能够有效覆盖路径的底图石台
    slots: [
      [0.328, 0.304],   // ① 第一弯上侧
      [0.256, 0.457],   // ② 第一弯内侧
      [0.444, 0.516],   // ③ 中央折返点
      [0.292, 0.765],   // ④ 第一弯下侧
      [0.648, 0.599],   // ⑤ 第二弯内侧
      [0.737, 0.841],   // ⑥ 核心前下侧
    ],
    // 全部使用 A 稿底图自带石台，避免额外贴片造成真假塔位和坐标漂移
    slotSkin: [-1, -1, -1, -1, -1, -1],
    heroSpawn: [0.790, 0.590],
    waves: [
      { groups: [{ type: 'miasma', count: 6, gap: 0.85 }],
        tip: '瘴气灵成群而来，灵弩台速射最稳。' },
      { groups: [{ type: 'miasma', count: 5, gap: 0.75 }, { type: 'windfox', count: 3, gap: 0.55, delay: 3.2 }],
        tip: '风行妖速度极快，用云翼卫拦住它们。' },
      { groups: [{ type: 'miasma', count: 11, gap: 0.72 }, { type: 'windfox', count: 5, gap: 0.55, delay: 4.5 }],
        tip: '妖群变密了，雷火瓮的范围爆炸正合用。' },
      { groups: [{ type: 'shanxiao', count: 3, gap: 4.0 }, { type: 'miasma', count: 8, gap: 0.68, delay: 2.0 }],
        tip: '山魈物理皮糙，符咒楼的法术能穿透。' },
      { groups: [{ type: 'shanxiao', count: 4, gap: 3.5 }, { type: 'windfox', count: 8, gap: 0.55, delay: 2.5 }, { type: 'miasma', count: 6, gap: 0.65, delay: 6.0 }],
        tip: '最后一波总攻——沈烬明的破围斩留到现在。' },
    ],
    starThresholds: [18, 10, 1],   // ≥18心=3星 ≥10心=2星 ≥1心=1星
  },
];

const SAVE_KEY = 'ruyi-td-v1';
