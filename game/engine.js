/* ============================================================
 * 青崖守印 · 引擎 engine.js
 * 渲染 / 寻路 / 塔 / 士兵 / 英雄 / 敌人 / 波次 / 特效 / 合成音效
 * 依赖 levels.js 中的 TOWER_DEFS / ENEMY_DEFS / HERO_DEFS / LEVELS / SAVE_KEY
 * ============================================================ */
'use strict';

/* ---------- 工具 ---------- */
const $ = id => document.getElementById(id);
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const lerp = (a, b, t) => a + (b - a) * t;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const IS_TOUCH = navigator.maxTouchPoints > 1;
const DPR = Math.min(window.devicePixelRatio || 1, 2);

/* ---------- 存档 ---------- */
const Save = {
  data: { stars: {}, best: {} },
  load() {
    try { Object.assign(this.data, JSON.parse(localStorage.getItem(SAVE_KEY) || '{}')); }
    catch (e) { /* 损坏存档静默重置 */ }
  },
  write() { try { localStorage.setItem(SAVE_KEY, JSON.stringify(this.data)); } catch (e) {} },
  record(levelId, stars, livesLeft) {
    const prev = this.data.stars[levelId] || 0;
    this.data.stars[levelId] = Math.max(prev, stars);
    this.data.best[levelId] = Math.max(this.data.best[levelId] || 0, livesLeft);
    this.write();
  },
  totalStars() { return Object.values(this.data.stars).reduce((a, b) => a + b, 0); },
};

/* ---------- 合成音效（WebAudio，无外部素材） ---------- */
const Sfx = {
  ctx: null, muted: false,
  ensure() {
    if (!this.ctx) { try { this.ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) {} }
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
  },
  tone(freq, dur, type = 'sine', vol = 0.12, slide = 0) {
    if (this.muted || !this.ctx) return;
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator(), g = this.ctx.createGain();
    o.type = type; o.frequency.setValueAtTime(freq, t);
    if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(40, freq + slide), t + dur);
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g); g.connect(this.ctx.destination);
    o.start(t); o.stop(t + dur + 0.02);
  },
  noise(dur = 0.15, vol = 0.10, freq = 800) {
    if (this.muted || !this.ctx) return;
    const t = this.ctx.currentTime, n = this.ctx.sampleRate * dur;
    const buf = this.ctx.createBuffer(1, n, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / n);
    const s = this.ctx.createBufferSource(); s.buffer = buf;
    const f = this.ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = freq;
    const g = this.ctx.createGain(); g.gain.value = vol;
    s.connect(f); f.connect(g); g.connect(this.ctx.destination); s.start(t);
  },
  play(name) {
    this.ensure(); if (!this.ctx || this.muted) return;
    switch (name) {
      case 'build':   this.tone(520, .12, 'triangle', .12, 240); break;
      case 'sell':    this.tone(340, .12, 'triangle', .10, -120); break;
      case 'shoot':   this.tone(880 + Math.random() * 120, .05, 'square', .04); break;
      case 'magic':   this.tone(660, .16, 'sine', .07, 320); break;
      case 'boom':    this.noise(.22, .14, 500); this.tone(120, .2, 'sine', .10, -60); break;
      case 'slash':   this.noise(.08, .08, 2400); break;
      case 'leak':    this.tone(220, .3, 'sawtooth', .12, -120); break;
      case 'coin':    this.tone(990, .07, 'triangle', .06, 200); break;
      case 'wave':    this.tone(392, .18, 'triangle', .11, 196); break;
      case 'skill':   this.tone(180, .5, 'sawtooth', .12, 420); this.noise(.4, .10, 1200); break;
      case 'herodown':this.tone(160, .5, 'sine', .12, -80); break;
      case 'win':     [523, 659, 784, 1046].forEach((f, i) => setTimeout(() => this.tone(f, .22, 'triangle', .11), i * 110)); break;
      case 'lose':    [392, 330, 262, 196].forEach((f, i) => setTimeout(() => this.tone(f, .25, 'sine', .11), i * 140)); break;
      case 'click':   this.tone(700, .04, 'square', .05); break;
    }
  },
};

/* ---------- 游戏主体 ---------- */
class Game {
  constructor(canvas, level, ui) {
    this.cv = canvas; this.ctx = canvas.getContext('2d');
    this.level = level; this.ui = ui;
    this.W = 0; this.H = 0;
    this.staticLayer = null;
    this.assets = {}; this.assetsReady = false;
    this.pointer = { x: -1, y: -1, down: false };
    this.mapRect = { x: 0, y: 0, w: 1, h: 1, scale: 1 };   // contain 映射矩形
    this.reset();
  }

  /* ----- 状态 ----- */
  reset() {
    const L = this.level;
    this.gold = L.startGold; this.lives = L.startLives;
    this.waveIndex = 0; this.running = false; this.finished = false;
    this.enemies = []; this.towers = []; this.shots = [];
    this.particles = []; this.floats = []; this.soldiers = [];
    this.spawnQueue = []; this.spawnTimer = 0;
    this.selectedTowerType = 'crossbow';
    this.selectedTower = null;          // 已建塔被点选（弹面板）
    this.placingType = null;            // 正在放置的塔类型
    this.settingRally = null;           // 正在设置集结点的兵营
    this.movingHero = false;
    this.speed = 1;
    this.hero = L.hero ? this.makeHero() : null;
    this.slots = (this.slotsRaw || []).map(s => ({ ...s, tower: null }));
    this.earlyBonusGiven = false;
    if (this.ui) {
      this.ui.updateHud(this);
      this.ui.setStatus('准备防守', '选择底部防御塔，点击发光塔位建造。沈烬明已在核心旁待命——点击他，再点地面即可调度。');
      this.ui.hideTowerPanel();
      this.ui.updateStartBtn(this);
      this.ui.refreshTowerBar(this);
      this.ui.refreshHero();
    }
  }

  makeHero() {
    const p = this.level.heroSpawn;
    return {
      x: 0, y: 0, rx: p[0], ry: p[1],           // 相对锚点，resize 时还原
      tx: null, ty: null,                        // 移动目标
      hp: HERO_DEF.hp, maxHp: HERO_DEF.hp,
      level: 1, xp: 0, alive: true, respawnTimer: 0,
      cd: 0, skillCd: 0, hit: 0, facing: 1, swing: 0,
    };
  }

  /* ----- 素材 ----- */
  loadAssets(done) {
    const srcs = {
      map: this.level.map,
      crossbow: './game-assets/defense/sprites/tower-crossbow.webp',
      talisman: './game-assets/defense/sprites/tower-talisman.webp',
      barracks: './game-assets/defense/sprites/tower-barracks.webp',
      mortar:   './game-assets/defense/sprites/tower-mortar.webp',
      miasma:   './game-assets/defense/sprites/enemy-miasma.webp',
      windfox:  './game-assets/defense/sprites/enemy-windfox.webp',
      shanxiao: './game-assets/defense/sprites/enemy-shanxiao.webp',
      crane:    './game-assets/defense/sprites/soldier-crane.webp',
      hero:     './game-assets/defense/sprites/hero-shenjinming.webp',
      heroRun1: './game-assets/defense/sprites/hero-run-1.webp',
      heroRun2: './game-assets/defense/sprites/hero-run-2.webp',
      heroRun3: './game-assets/defense/sprites/hero-run-3.webp',
      heroSlash1: './game-assets/defense/sprites/hero-slash-1.webp',
      heroSlash2: './game-assets/defense/sprites/hero-slash-2.webp',
      heroSlash3: './game-assets/defense/sprites/hero-slash-3.webp',
      slabA:    './game-assets/defense/sprites/slot-slab-a.webp',
      slabB:    './game-assets/defense/sprites/slot-slab-b.webp',
    };
    Promise.all(Object.entries(srcs).map(([k, s]) => new Promise(res => {
      const img = new Image();
      img.onload = () => { this.assets[k] = img; res(); };
      img.onerror = () => { console.warn('素材缺失', s); res(); };
      img.src = s;
    }))).then(() => {
      this.assetsReady = true;
      this.buildStatic();
      done && done();
    });
  }

  /* ----- 尺寸 / 地图 ----- */
  resize() {
    const r = this.cv.parentElement.getBoundingClientRect();
    const w = Math.max(320, Math.floor(r.width)), h = Math.max(260, Math.floor(r.height));
    if (Math.abs(w - this.W) < 4 && Math.abs(h - this.H) < 4) return;   // 防抖：URL 栏收起不重建
    this.W = w; this.H = h;
    this.cv.width = w * DPR; this.cv.height = h * DPR;
    this.ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    this.buildMap(); this.buildStatic();
  }

  /* ----- 地图坐标系（contain 映射：所有游戏坐标钉死地图，与画布尺寸解耦） ----- */
  computeMapRect() {
    const img = this.assets.map;
    const ir = img ? img.width / img.height : 1920 / 1020;
    const cr = this.W / this.H;
    let w, h;
    if (cr > ir) { h = this.H; w = h * ir; } else { w = this.W; h = w / ir; }
    this.mapRect = { x: (this.W - w) / 2, y: (this.H - h) / 2, w, h, scale: w / 1920 };
  }
  /** 地图相对坐标 (0~1) → 画布像素 */
  mp(rx, ry) {
    const r = this.mapRect;
    return { x: r.x + rx * r.w, y: r.y + ry * r.h };
  }
  /** 地图像素长度 → 画布像素长度 */
  ms(len) { return len * this.mapRect.scale; }

  buildMap() {
    this.computeMapRect();
    const L = this.level;
    this.path = L.path.map(p => this.mp(p[0], p[1]));
    this.pathLen = 0;
    this.segs = [];
    for (let i = 0; i < this.path.length - 1; i++) {
      const len = dist(this.path[i], this.path[i + 1]);
      this.segs.push({ a: this.path[i], b: this.path[i + 1], len, start: this.pathLen });
      this.pathLen += len;
    }
    this.slotsRaw = L.slots;
    this.slots = L.slots.map((p, i) => {
      const q = this.mp(p[0], p[1]);
      const old = this.towers.find(t => t.slotIndex === i);
      const s = { x: q.x, y: q.y, r: this.ms(58), tower: old || null };
      if (old) { old.x = s.x; old.y = s.y; }
      return s;
    });
    if (this.hero) {
      const q = this.mp(this.hero.rx, this.hero.ry);
      this.hero.x = q.x; this.hero.y = q.y;
    }
  }

  pointOnPath(d) {
    d = clamp(d, 0, this.pathLen);
    for (const s of this.segs) {
      if (d <= s.start + s.len) {
        const t = (d - s.start) / s.len;
        return { x: lerp(s.a.x, s.b.x, t), y: lerp(s.a.y, s.b.y, t), angle: Math.atan2(s.b.y - s.a.y, s.b.x - s.a.x) };
      }
    }
    const e = this.path[this.path.length - 1];
    return { x: e.x, y: e.y, angle: 0 };
  }

  buildStatic() {
    const c = document.createElement('canvas');
    c.width = this.W * DPR; c.height = this.H * DPR;
    const g = c.getContext('2d');
    g.setTransform(DPR, 0, 0, DPR, 0, 0);
    if (this.assets.map) {
      // contain 完整填充，地图外区域铺深色底
      g.fillStyle = '#05070f'; g.fillRect(0, 0, this.W, this.H);
      const r = this.mapRect;
      g.drawImage(this.assets.map, r.x, r.y, r.w, r.h);
      g.fillStyle = 'rgba(4,7,16,.08)'; g.fillRect(r.x, r.y, r.w, r.h);
    } else {
      const gr = g.createLinearGradient(0, 0, 0, this.H);
      gr.addColorStop(0, '#0b1020'); gr.addColorStop(1, '#070914');
      g.fillStyle = gr; g.fillRect(0, 0, this.W, this.H);
      this.drawPathOn(g);
    }
    // 石板贴片：按 slotSkin 把石板素材烧进静态层（坐标即事实源）
    if (this.level.slotSkin && this.slots.length) {
      this.level.slotSkin.forEach((skin, i) => {
        if (skin < 0) return;                       // -1 = 地图自带石板
        const img = skin === 0 ? this.assets.slabA : this.assets.slabB;
        if (!img) return;
        const s = this.slots[i];
        const w = this.ms(190);
        const h = w * (img.height / img.width);
        g.drawImage(img, s.x - w / 2, s.y - h * .5, w, h);
      });
    }
    this.staticLayer = c;
  }

  drawPathOn(g) {
    g.lineCap = 'round'; g.lineJoin = 'round';
    const pts = this.path;
    const stroke = (style, w, dash) => {
      g.strokeStyle = style; g.lineWidth = w;
      if (dash) g.setLineDash(dash);
      g.beginPath(); g.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) g.lineTo(pts[i].x, pts[i].y);
      g.stroke(); g.setLineDash([]);
    };
    stroke('rgba(255,255,255,.07)', 44);
    stroke('rgba(216,180,254,.20)', 30);
    stroke('rgba(6,182,212,.15)', 4, [12, 16]);
  }

  /* ----- 波次 ----- */
  startWave() {
    if (!this.assetsReady || this.finished) return;
    if (this.running || this.waveIndex >= this.level.waves.length) return;
    // 提前开波奖励：距上一波结束越久奖励越高，封顶 25
    if (this.waveIndex > 0 && !this.earlyBonusGiven) {
      const bonus = 15;
      this.gold += bonus;
      this.addFloat(this.W * .5, this.H * .3, `提前开波 +${bonus}`, '#facc15', 16);
      Sfx.play('coin');
    }
    const w = this.level.waves[this.waveIndex];
    this.spawnQueue = [];
    w.groups.forEach(gr => {
      const base = gr.delay || 0;
      // 双数小怪前后微错开，避免完全重叠（仍成对读感）
      for (let i = 0; i < gr.count; i++)
        this.spawnQueue.push({ type: gr.type, delay: base + i * gr.gap + (i % 2 ? gr.gap * .35 : 0) });
    });
    this.spawnQueue.sort((a, b) => a.delay - b.delay);
    this.spawnTimer = 0; this.running = true; this.earlyBonusGiven = false;
    Sfx.play('wave');
    this.ui.setStatus(`第 ${this.waveIndex + 1} 波来袭`, w.tip);
    this.ui.updateHud(this); this.ui.updateStartBtn(this);
  }

  spawnEnemy(type) {
    const def = ENEMY_DEFS[type], p = this.pointOnPath(0);
    const hpScale = 1 + this.waveIndex * 0.08;    // 随波次微增
    this.enemies.push({
      type, x: p.x, y: p.y, dist: 0, angle: 0,
      hp: Math.round(def.hp * hpScale), maxHp: Math.round(def.hp * hpScale),
      speed: def.speed, block: 0, slow: 0, hit: 0, alive: true, fadeIn: .4,
      stride: Math.random() * Math.PI * 2,   // 步幅相位
      dying: 0,                               // 死亡倒地进度 0~1
    });
  }

  updateSpawns(dt) {
    if (!this.running) return;
    this.spawnTimer += dt;
    while (this.spawnQueue.length && this.spawnQueue[0].delay <= this.spawnTimer)
      this.spawnEnemy(this.spawnQueue.shift().type);
    if (!this.spawnQueue.length && !this.enemies.length) {
      this.running = false; this.waveIndex++;
      if (this.waveIndex >= this.level.waves.length) this.finish(true);
      else {
        this.earlyBonusGiven = false;
        this.ui.setStatus(`第 ${this.waveIndex} 波守住了`,
          `核心余 ${this.lives} 点。补塔或升级后，点击开始下一波（提前开波有奖）。`);
        this.addBurst(this.W * .5, this.H * .2, '#86efac', 12, .6);
      }
      this.ui.updateHud(this); this.ui.updateStartBtn(this);
    }
  }

  /* ----- 塔 ----- */
  towerCfg(t) { return TOWER_DEFS[t.type].levels[t.level - 1]; }

  canAfford(type) { return this.gold >= TOWER_DEFS[type].levels[0].cost; }

  placeTower(x, y) {
    const idx = this.slots.findIndex(s => !s.tower && Math.hypot(x - s.x, y - s.y) < s.r + 12);
    if (idx < 0) { this.ui.toast('请点击发光的塔位建造'); return false; }
    const cfg = TOWER_DEFS[this.placingType].levels[0];
    if (this.gold < cfg.cost) { this.ui.toast(`灵石不足，${TOWER_DEFS[this.placingType].name}需 ${cfg.cost}`); return false; }
    this.gold -= cfg.cost;
    const s = this.slots[idx];
    const t = {
      type: this.placingType, level: 1, slotIndex: idx, x: s.x, y: s.y,
      cd: Math.random() * .2, fire: 0, born: .3, pulse: 0,
      rally: this.placingType === 'barracks' ? { x: s.x, y: s.y + 46 } : null,
      respawnTimers: [], invested: cfg.cost,
    };
    s.tower = t; this.towers.push(t);
    if (t.type === 'barracks') this.spawnSoldiers(t);
    this.addSummon(s.x, s.y, TOWER_DEFS[t.type].color);
    this.addFloat(s.x, s.y - 36, `-${cfg.cost}`, '#facc15');
    Sfx.play('build');
    this.ui.setStatus(`${TOWER_DEFS[t.type].name} 已建造`, TOWER_DEFS[t.type].role + '。点击塔可升级或出售。');
    this.ui.updateHud(this); this.ui.refreshTowerBar(this);
    return true;
  }

  upgradeTower(t) {
    const def = TOWER_DEFS[t.type];
    if (t.level >= this.level.maxTowerLevel || t.level >= def.levels.length) return;
    const cost = def.levels[t.level].cost;
    if (this.gold < cost) { this.ui.toast(`灵石不足，升级需 ${cost}`); return; }
    this.gold -= cost; t.level++; t.invested += cost;
    if (t.type === 'barracks') { this.soldiers = this.soldiers.filter(s => s.camp !== t); this.spawnSoldiers(t); }
    this.addSummon(t.x, t.y, def.color);
    this.addFloat(t.x, t.y - 40, `Lv.${t.level}`, '#86efac', 17);
    Sfx.play('build');
    this.ui.updateHud(this); this.ui.refreshTowerBar(this); this.ui.showTowerPanel(this, t);
  }

  sellTower(t) {
    const refund = Math.round(t.invested * 0.7);
    this.gold += refund;
    this.soldiers = this.soldiers.filter(s => s.camp !== t);
    this.slots[t.slotIndex].tower = null;
    this.towers = this.towers.filter(x => x !== t);
    this.selectedTower = null;
    this.addFloat(t.x, t.y - 30, `+${refund}`, '#facc15', 16);
    this.addBurst(t.x, t.y, '#aab1c4', 8, .4);
    Sfx.play('sell');
    this.ui.updateHud(this); this.ui.refreshTowerBar(this); this.ui.hideTowerPanel();
  }

  findTarget(x, y, range) {
    let best = null, bd = -1;
    for (const e of this.enemies) {
      if (!e.alive || e.dying > 0) continue;
      if (Math.hypot(e.x - x, e.y - y) <= range && e.dist > bd) { best = e; bd = e.dist; }
    }
    return best;
  }

  updateTowers(dt) {
    for (const t of this.towers) {
      const cfg = this.towerCfg(t), def = TOWER_DEFS[t.type];
      t.cd -= dt; t.pulse += dt; t.born = Math.max(0, t.born - dt); t.fire = Math.max(0, t.fire - dt);
      if (t.type === 'barracks') { this.updateBarracks(t, cfg, dt); continue; }
      if (t.cd > 0) continue;
      const target = this.findTarget(t.x, t.y, cfg.range);
      if (!target) continue;
      t.cd = cfg.cooldown; t.fire = .2;
      this.shots.push({
        kind: t.type, sx: t.x, sy: t.y - 14, x: t.x, y: t.y - 14,
        tx: target.x, ty: target.y, target, life: 0,
        dur: t.type === 'talisman' ? .34 : t.type === 'mortar' ? .5 : .18,
        color: def.color, damage: cfg.damage,
        damageType: def.damageType, splash: cfg.splash || 0,
      });
      Sfx.play(t.type === 'talisman' ? 'magic' : t.type === 'mortar' ? 'boom' : 'shoot');
    }
  }

  /* ----- 云翼营士兵（KR4 机制：扇形散开站位 / 1v1 锁定 / 脱战归位 / 跑步补员） ----- */
  /** 第 idx 个兵的站位偏移：围绕集结点 120° 扇形散开 */
  soldierPost(camp, idx) {
    const angles = [Math.PI / 2, Math.PI / 2 + 2.1, Math.PI / 2 - 2.1];   // 下 / 左后 / 右后
    const a = angles[idx % angles.length];
    const r = idx === 0 ? 0 : 26;
    return { x: camp.rally.x + Math.cos(a) * r, y: camp.rally.y + Math.sin(a) * r * .6 };
  }

  makeSoldier(camp, idx) {
    const cfg = this.towerCfg(camp);
    return {
      camp, idx, x: camp.x, y: camp.y + 20,          // 出生在兵营门口，跑向站位
      hp: cfg.soldierHp, maxHp: cfg.soldierHp,
      cd: 0, alive: true, target: null, bob: Math.random() * 6,
      stride: 0, lunge: 0, moving: true,
    };
  }

  spawnSoldiers(camp) {
    const cfg = this.towerCfg(camp);
    for (let i = 0; i < cfg.soldiers; i++) {
      const s = this.makeSoldier(camp, i);
      this.soldiers.push(s);
      this.addSummon(camp.x, camp.y + 20, '#f0f9ff');
    }
  }

  updateBarracks(camp, cfg, dt) {
    const mine = this.soldiers.filter(s => s.camp === camp);
    const alive = mine.filter(s => s.alive);
    // 阵亡补员：从兵营门口跑出
    if (alive.length < cfg.soldiers) {
      camp._respawn = (camp._respawn || 0) + dt;
      if (camp._respawn >= cfg.respawn) {
        camp._respawn = 0;
        const usedIdx = alive.map(s => s.idx);
        const idx = [0, 1, 2].find(i => !usedIdx.includes(i)) ?? 0;
        const s = this.makeSoldier(camp, idx);
        this.soldiers.push(s);
        this.addSummon(camp.x, camp.y + 20, '#f0f9ff');
      }
    } else camp._respawn = 0;

    for (const s of alive) {
      s.cd -= dt; s.bob += dt * 6;
      const post = this.soldierPost(camp, s.idx);
      const aggroR = cfg.range;                          // KR4：追击不超过集结点 1×射程

      // 目标有效性：活着 + 未超出仇恨范围
      let tgt = s.target && s.target.alive && s.target.dying === 0
        && Math.hypot(s.target.x - camp.rally.x, s.target.y - camp.rally.y) <= aggroR ? s.target : null;

      if (!tgt) {
        // 索敌：集结点范围内、未被其他兵锁定的敌人（1v1 兵线）
        const claimed = new Set(alive.filter(o => o !== s && o.target && o.target.alive).map(o => o.target));
        let best = null, bd = 1e9;
        for (const e of this.enemies) {
          if (!e.alive || e.dying > 0 || claimed.has(e)) continue;
          const d = Math.hypot(e.x - camp.rally.x, e.y - camp.rally.y);
          if (d < aggroR && d < bd) { best = e; bd = d; }
        }
        tgt = best;
        s.target = tgt;
      }

      if (tgt) {
        const d = Math.hypot(tgt.x - s.x, tgt.y - s.y);
        s.facing = tgt.x > s.x ? 1 : -1;
        if (d > 26) {
          // 追击时也受仇恨范围约束：追出圈就放弃回位
          if (Math.hypot(tgt.x - camp.rally.x, tgt.y - camp.rally.y) > aggroR) {
            s.target = null;
          } else {
            s.x += (tgt.x - s.x) / d * 62 * dt; s.y += (tgt.y - s.y) / d * 62 * dt;
            s.stride += dt * 9; s.moving = true;
          }
        } else {
          s.moving = false;
          tgt.block = Math.max(tgt.block, .3);            // 拦截：怪停下
          if (s.cd <= 0) {
            s.cd = cfg.soldierCd;
            s.lunge = .2;
            this.damageEnemy(tgt, cfg.soldierDmg, 'physical', '#f0f9ff');
            this.shots.push({ kind: 'slash', x: s.x - 8, y: s.y - 6, tx: tgt.x + 6, ty: tgt.y + 4, life: .18, max: .18, color: '#e8f4ff' });
            Sfx.play('slash');
            s.hp -= 2;                                     // 拦截反噬
            if (s.hp <= 0) {
              s.alive = false; s.target = null;
              this.addBurst(s.x, s.y, '#f0f9ff', 6, .4);
            }
          }
        }
      } else {
        // 无目标：走向自己的站位（散开）
        const d = Math.hypot(post.x - s.x, post.y - s.y);
        if (d > 6) {
          s.x += (post.x - s.x) / d * 58 * dt; s.y += (post.y - s.y) / d * 58 * dt;
          s.stride += dt * 8; s.moving = true;
          s.facing = post.x > s.x ? 1 : -1;
        } else s.moving = false;
      }
      s.lunge = Math.max(0, s.lunge - dt);
    }
  }

  /* ----- 英雄 · 沈烬明 ----- */
  updateHero(dt) {
    const h = this.hero; if (!h) return;
    if (!h.alive) {
      h.respawnTimer -= dt;
      if (h.respawnTimer <= 0) {
        h.alive = true; h.hp = h.maxHp;
        const q = this.mp(h.rx, h.ry);
        h.x = q.x; h.y = q.y; h.tx = null;
        this.addSummon(h.x, h.y, '#c4b5fd');
        this.ui.toast('沈烬明重返战场');
      }
      return;
    }
    h.cd -= dt; h.hit = Math.max(0, h.hit - dt); h.swing = Math.max(0, h.swing - dt);
    h.skillCd = Math.max(0, h.skillCd - dt);
    // 移动
    h.moving = false;
    if (h.tx != null) {
      const d = Math.hypot(h.tx - h.x, h.ty - h.y);
      if (d < 6) { h.tx = null; }
      else {
        h.facing = h.tx > h.x ? 1 : -1;
        h.x += (h.tx - h.x) / d * HERO_DEF.moveSpeed * dt;
        h.y += (h.ty - h.y) / d * HERO_DEF.moveSpeed * dt;
        h.rx = (h.x - this.mapRect.x) / this.mapRect.w;
        h.ry = (h.y - this.mapRect.y) / this.mapRect.h;
        h.stride = (h.stride || 0) + dt * 10;
        h.moving = true;
      }
    }
    // 索敌攻击
    const tgt = this.findTarget(h.x, h.y, HERO_DEF.aggroRange);
    if (tgt && h.cd <= 0) {
      const d = Math.hypot(tgt.x - h.x, tgt.y - h.y);
      if (d <= HERO_DEF.range + 14) {
        h.cd = HERO_DEF.cooldown; h.swing = .3;
        h.facing = tgt.x > h.x ? 1 : -1;
        const dmg = HERO_DEF.damage + (h.level - 1) * HERO_DEF.dmgPerLevel;
        this.damageEnemy(tgt, dmg, 'physical', '#c4b5fd', false, h);
        this.shots.push({ kind: 'slash', x: h.x - 14, y: h.y - 10, tx: tgt.x + 10, ty: tgt.y + 6, life: .2, max: .2, color: '#d8b4fe' });
        Sfx.play('slash');
      } else if (h.tx == null) {
        // 追击
        h.tx = tgt.x; h.ty = tgt.y;
      }
    }
  }

  heroSkill() {
    const h = this.hero;
    if (!h || !h.alive || h.level < HERO_DEF.skill.unlockLevel || h.skillCd > 0) return false;
    const sk = HERO_DEF.skill;
    h.skillCd = sk.cooldown;
    let hits = 0;
    for (const e of this.enemies) {
      if (e.alive && Math.hypot(e.x - h.x, e.y - h.y) <= sk.radius) {
        this.damageEnemy(e, sk.damage, 'physical', sk.color, true, h); hits++;
      }
    }
    this.particles.push({ x: h.x, y: h.y, r: sk.radius, vx: 0, vy: 0, life: .5, max: .5, g: 0, color: sk.color, ring: true });
    this.addBurst(h.x, h.y, sk.color, 16, .9);
    this.addFloat(h.x, h.y - 44, `破围斩 ×${hits}`, sk.color, 18);
    Sfx.play('skill');
    return true;
  }

  heroGainXp(amount) {
    const h = this.hero; if (!h || h.level >= 5) return;
    h.xp += amount;
    const need = HERO_DEF.xpPerLevel[h.level];  // 下一级门槛
    if (h.xp >= need) {
      h.level++;
      h.maxHp += HERO_DEF.hpPerLevel; h.hp = h.maxHp;
      this.addFloat(h.x, h.y - 40, `Lv.${h.level}`, '#86efac', 17);
      this.addSummon(h.x, h.y, '#86efac');
      if (h.level === HERO_DEF.skill.unlockLevel)
        this.ui.toast(`沈烬明领悟绝技「${HERO_DEF.skill.name}」——点击绝技按钮释放`);
      this.ui.refreshHero(this);
    }
  }

  /* ----- 敌人 ----- */
  damageEnemy(e, dmg, type, color, splash = false, source = null) {
    if (!e || !e.alive) return;
    const def = ENEMY_DEFS[e.type];
    const resist = type === 'magic' ? def.magicResist : def.physResist;
    const real = Math.max(1, Math.round(dmg * (1 - resist)));
    e.hp -= real; e.hit = .14;
    this.addFloat(e.x, e.y - 26, real, color, splash ? 19 : 15);
    if (splash) { this.addBurst(e.x, e.y, color, 8, .5); this.addImpact(e.x, e.y, color, true); }
    if (e.hp <= 0) {
      e.alive = false;                         // 立即退出索敌/拦截逻辑
      e.dying = 0.0001;                        // 尸体只走渲染层退场动画
      this.gold += def.reward;
      this.addFloat(e.x, e.y - 12, `+${def.reward}`, '#facc15', 14);
      this.addDeath(e);
      if (source === this.hero) this.heroGainXp(10);
      else this.hero && this.heroGainXp(2);   // 塔击杀英雄蹭少量经验
      Sfx.play('coin');
      this.ui.updateHud(this);
    }
  }

  updateEnemies(dt) {
    for (const e of this.enemies) {
      // 倒地动画播放完毕后移除
      if (e.dying > 0) {
        e.dying += dt * 2.2;
        continue;
      }
      if (!e.alive) continue;
      e.fadeIn = Math.max(0, (e.fadeIn || 0) - dt);
      const slowFactor = e.block > 0 ? .05 : 1;
      e.block = Math.max(0, e.block - dt); e.hit = Math.max(0, e.hit - dt);
      e.dist += e.speed * slowFactor * dt;
      e.stride += dt * (e.block > 0 ? 2 : e.speed * .14);   // 步幅节奏与速度挂钩
      if (e.dist >= this.pathLen) {
        e.alive = false;
        this.lives -= ENEMY_DEFS[e.type].leak;
        const end = this.path[this.path.length - 1];
        this.addBurst(end.x, end.y, '#fb7185', 10, .6);
        this.addFloat(end.x, end.y - 40, `-${ENEMY_DEFS[e.type].leak} 核心`, '#fb7185', 16);
        Sfx.play('leak');
        this.ui.updateHud(this);
        this.ui.flashLives();
        if (this.lives <= 0) { this.lives = 0; this.finish(false); return; }
      } else {
        const p = this.pointOnPath(e.dist);
        e.x = p.x; e.y = p.y; e.angle = p.angle;
      }
    }
    this.enemies = this.enemies.filter(e => e.alive || (e.dying > 0 && e.dying < 1));
  }

  /* ----- 投射物 ----- */
  updateShots(dt) {
    for (const s of this.shots) {
      if (s.kind === 'slash') { s.life -= dt; continue; }
      s.life += dt;
      const p = Math.min(1, s.life / s.dur);
      s.x = lerp(s.sx, s.tx, p); s.y = lerp(s.sy, s.ty, p) - Math.sin(p * Math.PI) * 14;
      if (p >= 1 && !s.done) {
        s.done = true;
        if (s.splash) {
          for (const e of this.enemies)
            if (e.alive && Math.hypot(e.x - s.tx, e.y - s.ty) < s.splash)
              this.damageEnemy(e, s.damage, s.damageType, s.color, true);
          this.particles.push({ x: s.tx, y: s.ty, r: s.splash, vx: 0, vy: 0, life: .3, max: .3, g: 0, color: s.color, ring: true });
        } else if (s.target && s.target.alive) {
          this.damageEnemy(s.target, s.damage, s.damageType, s.color);
        }
      }
    }
    this.shots = this.shots.filter(s => s.kind === 'slash' ? s.life > 0 : !(s.done && s.life > s.dur + .05));
  }

  /* ----- 特效 ----- */
  addFloat(x, y, text, color, size = 15) { this.floats.push({ x, y, text, color, size, life: .85, max: .85 }); }
  addImpact(x, y, color, big = false) {
    this.particles.push({ x, y, r: big ? 40 : 20, vx: 0, vy: 0, life: big ? .3 : .2, max: big ? .3 : .2, g: 0, color, ring: true });
  }
  addBurst(x, y, color, n = 10, power = .6) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, sp = (30 + Math.random() * 90) * power;
      this.particles.push({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, r: 2 + Math.random() * 3, life: .4 + Math.random() * .4, max: .8, g: 8, color });
    }
  }
  addSummon(x, y, color) {
    this.addBurst(x, y, color, 10, .5);
    this.particles.push({ x, y, r: 36, vx: 0, vy: 0, life: .4, max: .4, g: 0, color, ring: true });
  }
  addDeath(e) {
    const def = ENEMY_DEFS[e.type];
    this.addBurst(e.x, e.y, def.color, e.type === 'shanxiao' ? 12 : 7, .55);
  }
  updateEffects(dt) {
    for (const p of this.particles) { p.life -= dt; p.x += (p.vx || 0) * dt; p.y += (p.vy || 0) * dt; if (p.g) p.vy += p.g * dt; }
    for (const f of this.floats) { f.life -= dt; f.y -= 22 * dt; }
    this.particles = this.particles.filter(p => p.life > 0).slice(-90);
    this.floats = this.floats.filter(f => f.life > 0).slice(-20);
  }

  /* ----- 结算 ----- */
  finish(win) {
    if (this.finished) return;
    this.finished = true; this.running = false; this.spawnQueue = [];
    let stars = 0;
    if (win) {
      const th = this.level.starThresholds;
      stars = this.lives >= th[0] ? 3 : this.lives >= th[1] ? 2 : 1;
      Save.record(this.level.id, stars, this.lives);
      this.addBurst(this.W * .5, this.H * .5, '#facc15', 20, 1);
    }
    Sfx.play(win ? 'win' : 'lose');
    setTimeout(() => this.ui.showResult(this, win, stars), 500);
    this.ui.updateStartBtn(this);
  }

  /* ----- 渲染 ----- */
  draw() {
    const ctx = this.ctx, W = this.W, H = this.H;
    if (this.staticLayer) ctx.drawImage(this.staticLayer, 0, 0, W, H);
    else { ctx.fillStyle = '#070914'; ctx.fillRect(0, 0, W, H); }
    if (!this.assets.map) this.drawPathOn(ctx);

    this.drawSlots(ctx);
    for (const t of this.towers) this.drawTower(ctx, t);
    this.drawSoldiers(ctx);
    this.drawShots(ctx);
    this.drawEnemies(ctx);
    if (this.hero) this.drawHero(ctx);
    this.drawEffects(ctx);
    this.drawPlacementPreview(ctx);
  }

  drawSlots(ctx) {
    const now = performance.now();
    this.slots.forEach((s, i) => {
      const pulse = .4 + Math.sin(now / 520 + i * 1.7) * .15;
      const rr = this.ms(56);                       // 与石板内圈直径(≈110px)对应
      ctx.save(); ctx.translate(s.x, s.y);
      if (!s.tower) {
        ctx.strokeStyle = `rgba(216,180,254,${pulse})`; ctx.lineWidth = 2.5;
        ctx.beginPath(); ctx.ellipse(0, 0, rr, rr * .52, 0, 0, Math.PI * 2); ctx.stroke();
        ctx.fillStyle = 'rgba(255,255,255,.05)';
        ctx.beginPath(); ctx.ellipse(0, 0, rr, rr * .52, 0, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = 'rgba(255,255,255,.75)'; ctx.font = '800 16px sans-serif';
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('+', 0, -1);
      }
      ctx.restore();
    });
    ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
  }

  drawTower(ctx, t) {
    const def = TOWER_DEFS[t.type], cfg = this.towerCfg(t);
    const img = this.assets[t.type];
    const bob = Math.sin(performance.now() / 680 + t.slotIndex * 2) * 1.2;
    const bornScale = t.born > 0 ? 1 - (t.born / .3) * .25 : 1;
    const fireScale = 1 + t.fire * .08;
    // 塔宽 = 石板主体直径(200px) × 0.78，随等级放大 8%
    const base = this.ms(156) * (1 + (t.level - 1) * .08);
    const w = base * bornScale * fireScale;
    ctx.save(); ctx.translate(t.x, t.y);
    if (this.selectedTower === t) {
      ctx.strokeStyle = def.color + '88'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(0, 0, cfg.range, 0, Math.PI * 2); ctx.stroke();
    }
    if (img) {
      const h = w * (img.height / img.width);
      // 落座阴影锚定石板中心
      ctx.fillStyle = 'rgba(0,0,0,.35)';
      ctx.beginPath(); ctx.ellipse(0, 2, w * .34, w * .12, 0, 0, Math.PI * 2); ctx.fill();
      ctx.drawImage(img, -w / 2, -h * .82 + bob, w, h);
    } else {
      ctx.fillStyle = def.color;
      ctx.beginPath(); ctx.roundRect(-w * .24, -w * .45, w * .48, w * .7, 10); ctx.fill();
    }
    // 等级标识
    if (t.level > 1) {
      ctx.fillStyle = '#86efac'; ctx.font = '900 11px sans-serif'; ctx.textAlign = 'center';
      ctx.fillText('Lv.' + t.level, 0, -w * .72 - 6);
    }
    // 兵营集结点旗
    if (t.type === 'barracks' && t.rally) {
      ctx.strokeStyle = 'rgba(240,249,255,.5)'; ctx.lineWidth = 1.5; ctx.setLineDash([4, 5]);
      ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(t.rally.x - t.x, t.rally.y - t.y); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = '#f0f9ff';
      ctx.beginPath(); ctx.arc(t.rally.x - t.x, t.rally.y - t.y, 5, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = '#7c6ef7'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(t.rally.x - t.x, t.rally.y - t.y, 8, 0, Math.PI * 2); ctx.stroke();
    }
    ctx.restore(); ctx.textAlign = 'left';
  }

  drawSoldiers(ctx) {
    const img = this.assets.crane;
    for (const s of this.soldiers) {
      if (!s.alive) continue;
      const w = this.ms(76);
      // 步幅颠簸（移动时）/ 待机呼吸
      const bob = s.moving ? Math.abs(Math.sin(s.stride || 0)) * 3 : Math.sin(s.bob * .3) * 1;
      // 前扑挥砍：向朝向突进 + 前倾
      const lungeK = (s.lunge || 0) / .2;
      const lungeX = (s.facing || 1) * lungeK * 8;
      ctx.save(); ctx.translate(s.x + lungeX, s.y);
      ctx.fillStyle = 'rgba(0,0,0,.3)';
      ctx.beginPath(); ctx.ellipse(0, 1, w * .3, w * .1, 0, 0, Math.PI * 2); ctx.fill();
      ctx.scale(s.facing || 1, 1);
      ctx.rotate(lungeK * .18 * 1);                          // 挥砍前倾
      if (img) {
        ctx.drawImage(img, -w / 2, -w * .8 - bob, w, w * (img.height / img.width));
      } else {
        ctx.fillStyle = '#eef6ff'; ctx.beginPath(); ctx.arc(0, -bob, 7, 0, Math.PI * 2); ctx.fill();
      }
      ctx.restore();
      // 血条
      if (s.hp < s.maxHp) {
        ctx.save(); ctx.translate(s.x, s.y);
        ctx.fillStyle = 'rgba(0,0,0,.45)'; ctx.fillRect(-12, -w * .8 - 6, 24, 3.5);
        ctx.fillStyle = '#86efac'; ctx.fillRect(-12, -w * .8 - 6, 24 * s.hp / s.maxHp, 3.5);
        ctx.restore();
      }
    }
  }

  drawEnemies(ctx) {
    for (const e of this.enemies) {
      const def = ENEMY_DEFS[e.type];
      const img = this.assets[e.type];
      const size = this.ms(def.size * 1.05);
      // ---- 程序化动作：步幅颠簸 / 行进前倾 / 受击后仰 / 倒地消散 ----
      const strideBob = Math.abs(Math.sin(e.stride)) * (e.type === 'shanxiao' ? 2.5 : 5.5);
      const lean = clamp(Math.sin(e.angle) * .08 + (e.block > 0 ? 0 : .09), -.14, .18);   // 前进方向前倾
      const hitKick = e.hit > 0 ? -(e.hit / .14) * 7 : 0;                                // 受击向后顿一下
      ctx.save(); ctx.translate(e.x, e.y);
      if (e.fadeIn > 0) ctx.globalAlpha = 1 - e.fadeIn / .4;
      if (e.dying > 0) {
        // 倒地：压缩 + 旋转倾倒 + 淡出
        const d = Math.min(1, e.dying);
        ctx.globalAlpha = 1 - d * d;
        ctx.scale(1 + d * .2, 1 - d * .5);
        ctx.rotate(d * .5);
      } else {
        ctx.rotate(lean);
        ctx.translate(hitKick, 0);
      }
      // 触地阴影（不随颠簸）
      if (!e.dying) {
        ctx.fillStyle = 'rgba(0,0,0,.3)';
        ctx.beginPath(); ctx.ellipse(0, 1, size * .3, size * .1, 0, 0, Math.PI * 2); ctx.fill();
      }
      if (img) {
        const flip = e.angle > Math.PI / 2 || e.angle < -Math.PI / 2;
        if (flip) ctx.scale(-1, 1);
        const wobble = e.dying ? 0 : Math.sin(e.stride) * (e.type === 'shanxiao' ? .035 : .09);  // 左右微摆
        ctx.rotate(wobble);
        ctx.drawImage(img, -size / 2, -size * .62 - strideBob, size, size * (img.height / img.width));
      } else {
        ctx.fillStyle = def.color;
        ctx.beginPath(); ctx.arc(0, -strideBob, size * .3, 0, Math.PI * 2); ctx.fill();
      }
      ctx.restore();
      // 受击反馈：冲击环 + 整体提亮（不碰像素合成，避免软边素材出现白块）
      if (e.hit > 0 && !e.dying) {
        ctx.save(); ctx.translate(e.x, e.y);
        const k = e.hit / .14;
        ctx.strokeStyle = `rgba(255,255,255,${.55 * k})`;
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(0, -size * .3, size * (.3 + (1 - k) * .25), 0, Math.PI * 2); ctx.stroke();
        ctx.restore();
      }
      // 血条（不随动作）
      if (!e.dying && e.hp < e.maxHp) {
        ctx.save(); ctx.translate(e.x, e.y);
        const w = 34, r = Math.max(0, e.hp / e.maxHp);
        ctx.fillStyle = 'rgba(0,0,0,.45)'; ctx.fillRect(-w / 2, -size * .62 - 8, w, 4.5);
        ctx.fillStyle = def.physResist > 0 ? '#c4b5fd' : '#86efac';
        ctx.fillRect(-w / 2, -size * .62 - 8, w * r, 4.5);
        ctx.restore();
      }
    }
  }

  drawHero(ctx) {
    const h = this.hero;
    if (!h.alive) {
      // 复活倒计时
      const q = this.mp(h.rx, h.ry);
      ctx.save(); ctx.translate(q.x, q.y);
      ctx.fillStyle = 'rgba(196,181,253,.85)'; ctx.font = '700 13px sans-serif'; ctx.textAlign = 'center';
      ctx.fillText(`重整旗鼓 ${Math.ceil(h.respawnTimer)}s`, 0, -20);
      ctx.restore(); ctx.textAlign = 'left';
      return;
    }
    ctx.save(); ctx.translate(h.x, h.y);
    if (this.movingHero) {
      ctx.strokeStyle = 'rgba(196,181,253,.6)'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(0, 0, HERO_DEF.aggroRange, 0, Math.PI * 2); ctx.stroke();
    }
    // ---- 帧动画选择：挥刀三连 > 奔跑四拍循环 > 待机立绘 ----
    let img = this.assets.hero;
    if (h.swing > 0) {
      const t = 1 - h.swing / .3;                       // 0→1
      img = t < .33 ? this.assets.heroSlash1 : t < .72 ? this.assets.heroSlash2 : this.assets.heroSlash3;
      img = img || this.assets.hero;
    } else if (h.moving) {
      const phase = Math.floor((h.stride || 0) * 1.6) % 4;   // 1-2-3-2 四拍
      img = [this.assets.heroRun1, this.assets.heroRun2, this.assets.heroRun3, this.assets.heroRun2][phase] || this.assets.hero;
    }
    const bob = (h.moving || h.swing > 0) ? 0 : Math.sin(performance.now() / 600) * 1.2;
    const w = this.ms(128) * (1 + (h.swing > 0 ? .1 : 0));
    const swingK = h.swing > 0 ? h.swing / .3 : 0;
    ctx.fillStyle = 'rgba(0,0,0,.32)';
    ctx.beginPath(); ctx.ellipse(0, 2, w * .28, w * .09, 0, 0, Math.PI * 2); ctx.fill();
    ctx.scale(h.facing, 1);
    ctx.translate(swingK * 6, 0);
    if (h.hit > 0) ctx.globalAlpha = .8;
    if (img) {
      ctx.drawImage(img, -w / 2, -w * .82 + bob, w, w * (img.height / img.width));
    } else {
      ctx.fillStyle = '#7c6ef7'; ctx.beginPath(); ctx.arc(0, bob - 8, 12, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
    // 移动目标标记
    if (h.tx != null) {
      ctx.save();
      ctx.strokeStyle = 'rgba(196,181,253,.55)'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(h.tx, h.ty, 8 + Math.sin(performance.now() / 200) * 2, 0, Math.PI * 2); ctx.stroke();
      ctx.restore();
    }
    // 血条+等级
    ctx.save(); ctx.translate(h.x, h.y);
    const w2 = 40;
    ctx.fillStyle = 'rgba(0,0,0,.5)'; ctx.fillRect(-w2 / 2, -58, w2, 5);
    ctx.fillStyle = '#c4b5fd'; ctx.fillRect(-w2 / 2, -58, w2 * h.hp / h.maxHp, 5);
    ctx.fillStyle = '#e9d5ff'; ctx.font = '800 11px sans-serif'; ctx.textAlign = 'center';
    ctx.fillText(`沈烬明 Lv.${h.level}`, 0, -63);
    ctx.restore(); ctx.textAlign = 'left';
  }

  drawShots(ctx) {
    for (const s of this.shots) {
      ctx.save(); ctx.strokeStyle = s.color; ctx.fillStyle = s.color;
      if (s.kind === 'slash') {
        ctx.globalAlpha = Math.max(0, s.life / s.max); ctx.lineWidth = 4;
        ctx.beginPath(); ctx.moveTo(s.x, s.y);
        ctx.quadraticCurveTo((s.x + s.tx) / 2, s.y - 24, s.tx, s.ty); ctx.stroke();
      } else {
        ctx.globalAlpha = .3; ctx.lineWidth = s.splash ? 4 : 2;
        ctx.beginPath(); ctx.moveTo(s.sx, s.sy); ctx.lineTo(s.x, s.y); ctx.stroke();
        ctx.globalAlpha = 1;
        ctx.beginPath(); ctx.arc(s.x, s.y, s.splash ? 7 : 4.5, 0, Math.PI * 2); ctx.fill();
      }
      ctx.restore();
    }
  }

  drawEffects(ctx) {
    for (const p of this.particles) {
      ctx.save(); ctx.globalAlpha = clamp(p.life / (p.max || .8), 0, 1);
      if (p.ring) {
        const prog = 1 - p.life / p.max;
        ctx.strokeStyle = p.color; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(p.x, p.y, p.r * (.2 + prog * .9), 0, Math.PI * 2); ctx.stroke();
      } else {
        ctx.fillStyle = p.color;
        ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2); ctx.fill();
      }
      ctx.restore();
    }
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (const f of this.floats) {
      ctx.globalAlpha = clamp(f.life / f.max, 0, 1);
      ctx.font = `900 ${f.size || 15}px Inter, sans-serif`;
      ctx.fillStyle = 'rgba(0,0,0,.4)'; ctx.fillText(f.text, f.x + 1, f.y + 1);
      ctx.fillStyle = f.color; ctx.fillText(f.text, f.x, f.y);
    }
    ctx.globalAlpha = 1; ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
  }

  drawPlacementPreview(ctx) {
    if (!this.placingType || IS_TOUCH) return;
    const { x, y } = this.pointer;
    if (x < 0) return;
    const cfg = TOWER_DEFS[this.placingType].levels[0];
    const ok = this.slots.some(s => !s.tower && Math.hypot(x - s.x, y - s.y) < s.r + 12);
    ctx.save();
    ctx.strokeStyle = ok ? 'rgba(134,239,172,.55)' : 'rgba(251,113,133,.4)';
    ctx.fillStyle = ok ? 'rgba(134,239,172,.08)' : 'rgba(251,113,133,.06)';
    ctx.beginPath(); ctx.arc(x, y, cfg.range, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.restore();
  }

  /* ----- 主循环 ----- */
  step(dt) {
    const sdt = dt * this.speed;
    if (!this.finished) {
      this.updateSpawns(sdt);
      this.updateTowers(sdt);
      this.updateShots(sdt);
      this.updateEnemies(sdt);
      this.updateHero(sdt);
    }
    this.updateEffects(sdt);
    this.draw();
  }
}

/* ============================================================
 * UI 控制器：HUD / 塔栏 / 面板 / 结算 / 输入
 * ============================================================ */
class UI {
  constructor(game) {
    this.g = game;
    this.el = {
      gold: $('gold'), lives: $('lives'), wave: $('wave'),
      startBtn: $('startWave'), statusTitle: $('statusTitle'), statusText: $('statusText'),
      toast: $('toast'), hint: $('hint'), modal: $('modal'), modalTitle: $('modalTitle'),
      modalText: $('modalText'), modalStars: $('modalStars'),
      towerPanel: $('towerPanel'), panelName: $('panelName'), panelInfo: $('panelInfo'),
      upgradeBtn: $('upgradeBtn'), sellBtn: $('sellBtn'),
      heroCard: $('heroCard'), heroHp: $('heroHp'), heroLv: $('heroLv'),
      skillBtn: $('skillBtn'), skillCd: $('skillCd'),
      preview: $('wavePreview'), speedBtn: $('speedBtn'), muteBtn: $('muteBtn'),
    };
    this.toastTimer = null;
    this.bind();
  }

  bind() {
    const g = this.g, cv = g.cv;
    // 塔按钮
    document.querySelectorAll('.tower-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        Sfx.play('click');
        g.placingType = btn.dataset.tower;
        g.selectedTower = null; this.hideTowerPanel(); g.movingHero = false; g.settingRally = null;
        document.querySelectorAll('.tower-btn').forEach(b => b.classList.toggle('active', b === btn));
        const def = TOWER_DEFS[g.placingType];
        this.setStatus(def.name, def.role + `（${def.levels[0].cost} 灵石）——点击发光塔位建造`);
      });
    });
    // 画布指针
    const pos = ev => {
      const r = cv.getBoundingClientRect();
      const p = ev.touches ? ev.touches[0] : ev;
      return { x: p.clientX - r.left, y: p.clientY - r.top };
    };
    cv.addEventListener('pointermove', ev => { const p = pos(ev); g.pointer.x = p.x; g.pointer.y = p.y; });
    cv.addEventListener('pointerdown', ev => {
      Sfx.ensure();
      const p = pos(ev);
      this.handleTap(p.x, p.y);
    });
    // 开波
    this.el.startBtn.addEventListener('click', () => g.startWave());
    // 速度 / 静音
    this.el.speedBtn.addEventListener('click', () => {
      g.speed = g.speed === 1 ? 2 : 1;
      this.el.speedBtn.textContent = g.speed === 1 ? '▶ 1×' : '▶▶ 2×';
      Sfx.play('click');
    });
    this.el.muteBtn.addEventListener('click', () => {
      Sfx.muted = !Sfx.muted;
      this.el.muteBtn.textContent = Sfx.muted ? '🔇' : '🔊';
    });
    // 塔面板
    this.el.upgradeBtn.addEventListener('click', () => g.selectedTower && g.upgradeTower(g.selectedTower));
    this.el.sellBtn.addEventListener('click', () => g.selectedTower && g.sellTower(g.selectedTower));
    $('panelClose').addEventListener('click', () => { g.selectedTower = null; this.hideTowerPanel(); });
    $('rallyBtn').addEventListener('click', () => {
      if (g.selectedTower && g.selectedTower.type === 'barracks') {
        g.settingRally = g.selectedTower;
        this.toast('点击地图设置云翼卫集结点');
        this.hideTowerPanel(); g.selectedTower = null;
      }
    });
    // 英雄卡 & 绝技
    this.el.heroCard.addEventListener('click', () => {
      if (!g.hero || !g.hero.alive) return;
      g.movingHero = !g.movingHero; g.placingType = null; g.settingRally = null;
      document.querySelectorAll('.tower-btn').forEach(b => b.classList.remove('active'));
      this.el.heroCard.classList.toggle('active', g.movingHero);
      if (g.movingHero) this.setStatus('调度沈烬明', '点击地图任意位置，沈烬明会前往驻守。他会自动攻击靠近的妖物。');
    });
    this.el.skillBtn.addEventListener('click', () => {
      if (!g.heroSkill()) {
        const h = g.hero;
        if (h && h.level < HERO_DEF.skill.unlockLevel) this.toast(`Lv.${HERO_DEF.skill.unlockLevel} 解锁绝技`);
        else if (h && h.skillCd > 0) this.toast(`绝技冷却中 ${Math.ceil(h.skillCd)}s`);
      }
    });
    // 结算
    $('again').addEventListener('click', () => { this.el.modal.classList.remove('show'); g.reset(); });
    // 重开
    $('restartTop').addEventListener('click', () => g.reset());
    // resize
    let rT;
    window.addEventListener('resize', () => { clearTimeout(rT); rT = setTimeout(() => g.resize(), 120); });
  }

  handleTap(x, y) {
    const g = this.g;
    if (g.finished) return;
    // 1. 集结点设置
    if (g.settingRally) {
      const camp = g.settingRally;
      camp.rally = { x, y };
      g.settingRally = null;
      // 士兵走向新集结点
      Sfx.play('click');
      g.addFloat(x, y - 20, '集结点已调整', '#f0f9ff', 14);
      return;
    }
    // 2. 英雄调度
    if (g.movingHero) {
      g.hero.tx = x; g.hero.ty = y;
      g.movingHero = false;
      this.el.heroCard.classList.remove('active');
      g.addFloat(x, y - 14, '遵命', '#c4b5fd', 14);
      Sfx.play('click');
      return;
    }
    // 3. 点英雄本人 → 进入调度
    if (g.hero && g.hero.alive && Math.hypot(x - g.hero.x, y - g.hero.y) < 34) {
      g.movingHero = true; g.placingType = null;
      document.querySelectorAll('.tower-btn').forEach(b => b.classList.remove('active'));
      this.el.heroCard.classList.add('active');
      this.setStatus('调度沈烬明', '点击目标位置。他会自动迎击靠近的妖物，绝技可手动释放。');
      return;
    }
    // 4. 点已建塔 → 面板
    const t = g.towers.find(t => Math.hypot(x - t.x, y - t.y) < 36);
    if (t) { g.selectedTower = t; g.placingType = null; this.showTowerPanel(g, t); return; }
    // 5. 放塔
    if (g.placingType) { g.placeTower(x, y); return; }
    // 6. 点空 → 收面板
    g.selectedTower = null; this.hideTowerPanel();
  }

  /* ----- HUD ----- */
  updateHud(g) {
    this.el.gold.textContent = g.gold;
    this.el.lives.textContent = Math.max(0, g.lives);
    this.el.wave.textContent = `${Math.min(g.waveIndex, g.level.waves.length)}/${g.level.waves.length}`;
  }
  flashLives() {
    this.el.lives.parentElement.classList.add('flash');
    setTimeout(() => this.el.lives.parentElement.classList.remove('flash'), 350);
  }
  setStatus(t, s) { this.el.statusTitle.textContent = t; this.el.statusText.textContent = s; }
  toast(text) {
    const el = this.el.toast;
    el.textContent = text; el.classList.add('show');
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => el.classList.remove('show'), 1900);
  }
  updateStartBtn(g) {
    const b = this.el.startBtn;
    const active = g.running || g.spawnQueue.length || g.enemies.length;
    b.disabled = !g.assetsReady || g.finished || active || g.waveIndex >= g.level.waves.length;
    b.textContent = !g.assetsReady ? '素材加载中'
      : g.waveIndex >= g.level.waves.length ? '防守完成'
      : `开始第 ${g.waveIndex + 1} 波`;
    this.updatePreview();
  }
  updatePreview() {
    const g = this.g, el = this.el.preview;
    const next = g.level.waves[g.waveIndex];
    if (!next || g.finished) { el.innerHTML = ''; return; }
    const icons = { miasma: '🟢', windfox: '🦊', shanxiao: '🗿' };
    const parts = next.groups.map(gr => `${icons[gr.type] || '👾'}×${gr.count}`);
    el.innerHTML = `下一波：${parts.join(' + ')}`;
  }
  refreshTowerBar(g) {
    document.querySelectorAll('.tower-btn').forEach(btn => {
      const def = TOWER_DEFS[btn.dataset.tower];
      btn.classList.toggle('poor', g.gold < def.levels[0].cost);
    });
  }

  /* ----- 塔面板 ----- */
  showTowerPanel(g, t) {
    const def = TOWER_DEFS[t.type], cfg = g.towerCfg(t);
    this.el.panelName.textContent = `${def.name} Lv.${t.level}`;
    let info = def.role;
    if (t.type === 'barracks') info = `云翼卫 ×${cfg.soldiers} · 单体 ${cfg.soldierDmg} · ${def.role}`;
    else info = `伤害 ${cfg.damage} · 射程 ${cfg.range} · ${def.damageType === 'magic' ? '法术' : '物理'}`;
    this.el.panelInfo.textContent = info;
    const next = def.levels[t.level];
    const canUp = next && t.level < g.level.maxTowerLevel;
    this.el.upgradeBtn.style.display = canUp ? '' : 'none';
    if (canUp) this.el.upgradeBtn.textContent = `升级 Lv.${t.level + 1}（${next.cost}）`;
    $('rallyBtn').style.display = t.type === 'barracks' ? '' : 'none';
    this.el.sellBtn.textContent = `出售（+${Math.round(t.invested * .7)}）`;
    this.el.towerPanel.classList.add('show');
  }
  hideTowerPanel() { this.el.towerPanel.classList.remove('show'); }

  /* ----- 英雄卡 ----- */
  refreshHero() {
    const g = this.g, h = g.hero;
    if (!h) { this.el.heroCard.style.display = 'none'; this.el.skillBtn.style.display = 'none'; return; }
    this.el.heroHp.style.width = `${(h.alive ? h.hp / h.maxHp : 0) * 100}%`;
    this.el.heroLv.textContent = h.alive ? `Lv.${h.level}` : `${Math.ceil(h.respawnTimer)}s`;
    const sk = HERO_DEF.skill;
    const ready = h.alive && h.level >= sk.unlockLevel && h.skillCd <= 0;
    this.el.skillBtn.disabled = !ready;
    this.el.skillCd.textContent = h.level < sk.unlockLevel ? `Lv.${sk.unlockLevel}解锁`
      : h.skillCd > 0 ? `${Math.ceil(h.skillCd)}s` : '就绪';
  }

  /* ----- 结算 ----- */
  showResult(g, win, stars) {
    this.el.modalTitle.textContent = win ? '防守成功' : '核心失守';
    this.el.modalText.textContent = win
      ? `青崖入口守住了，灵晶重燃。剩余核心 ${g.lives}/${g.level.startLives}。第十三站的封印，又守住了一道。`
      : '混沌突破了入口。调整塔位与英雄站位，再试一次。';
    this.el.modalStars.innerHTML = win
      ? [1, 2, 3].map(i => `<span class="star ${i <= stars ? 'on' : ''}">★</span>`).join('') : '';
    this.el.modal.classList.add('show');
  }
}

/* ============================================================
 * 启动
 * ============================================================ */
(function boot() {
  const params = new URLSearchParams(location.search);
  const levelId = clamp(parseInt(params.get('level') || '1', 10) || 1, 1, LEVELS.length);
  const level = LEVELS[levelId - 1];
  Save.load();
  const game = new Game($('game'), level, null);
  const ui = new UI(game);
  game.ui = ui;
  game.reset();   // ui 就位后刷新一次状态
  ui.refreshHero(); ui.refreshTowerBar(game); ui.updatePreview();
  document.title = `青崖守印 · ${level.name}`;
  $('levelTag').textContent = level.subtitle;

  game.resize();
  game.loadAssets(() => { ui.updateStartBtn(game); ui.setStatus('准备防守', '选择底部防御塔，点击发光塔位建造。点击沈烬明可调度站位。'); });
  ui.updateStartBtn(game);

  let last = performance.now();
  function loop(now) {
    const dt = Math.min(.05, (now - last) / 1000);
    last = now;
    game.step(dt);
    ui.refreshHero();
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(t => { last = t; requestAnimationFrame(loop); });

  // 调试钩子（?autoplay=1 用于自动化质检）
  if (params.get('autoplay')) {
    window.__game = game;
    setTimeout(() => {
      game.placingType = 'crossbow'; game.placeTower(game.slots[0].x, game.slots[0].y);
      game.placingType = 'talisman'; game.placeTower(game.slots[1].x, game.slots[1].y);
      game.placingType = 'barracks'; game.placeTower(game.slots[2].x, game.slots[2].y);
      game.placingType = 'mortar';   game.placeTower(game.slots[3].x, game.slots[3].y);
      game.startWave();
    }, 800);
  }
})();
