/*
 * DangerAnalyzer —— 移植自 generals-bot/DangerAnalyzer.py（668 行）。
 *
 * 这个文件只回答一个问题：敌人最快几回合能打到我方将军（或城市/指定目标格），打到那一刻他还剩多少兵。
 * 剩下的兵数就是 ThreatObj.threatValue = 我还得再补多少兵才守得住。防守决策全靠这个数，所以
 * 路径、回合数、兵值任何一个算错，bot 就会在应该补刀的时候去扩张。
 *
 * 为什么这里的顺序一步都不能换：
 *   - analyze() 第一件事是 scan()：playerTiles 是所有「跳过视野里没有兵的玩家」分支的唯一依据，
 *     先跑搜索后跑 scan，等于拿上一回合的视野做判断。
 *   - fastestPotentialThreat 把 fastestThreat 的整条路径塞进 negativeTiles（假设我把兵从那条路上
 *     调走以后敌人还能不能更早打穿），所以它必须排在 fastestThreat 之后。
 *   - getFastestThreat 在玩家循环里会把局部 depth 改成 path.length + 1，后面几个玩家因此搜得更深。
 *     这是原版刻意留下的行为（先找到的威胁决定了还有多少时间可浪费），不要「修」成固定 depth。
 *   - 同一对格子的 ArmyAnalyzer 走 _get_army_analysis 的缓存：换顺序不仅慢，还会让 aMap/chokeWidths
 *     在两处计算里取到不同的实例。
 *
 * 与原版的差异（都是等价改写，不改语义）：
 *   - logbook 日志、time.perf_counter 计时、ViewInfo 可视化不搬；__str__ 保留纯文本版。
 *   - ThreatType 原版是 Enum，这里用冻结对象；成员名和原版一致（Kill / Vision / Econ）。
 *   - 搜索与距离全部复用已经过 oracle 校对的 EK.search / EK.ArmyAnalyzer，不在这里重写。
 *   - armies 形参就是原生 Map<Tile, Army>，Army 只需要 .tile / .value / .player / .visible /
 *     .last_moved_turn / .last_seen_turn / .entangledArmies / .name / .expectedPaths / .include_path()。
 *     ArmyTracker 还没移植完，这里绝不反向依赖它。
 */
(function (root) {
  'use strict';

  var EK = (root.__EK = root.__EK || {});

  /*
   * 原版 ThreatType(Enum)：Kill=1（能打死）、Vision=2（只抢视野）、Econ=3（抢经济）。
   * 这里用字符串值，因为只有判等和打印两种用途，用数字反而容易和 player / tile 值混起来。
   */
  var ThreatType = Object.freeze({
    Kill: 'Kill',
    Vision: 'Vision',
    Econ: 'Econ'
  });

  // Python 的 team_ids_by_player_index 末尾补了一个给 index = -1 用的槽位，JS 数组 [-1] 取不到，
  // 必须显式折回最后一个元素，否则中立的己方判定会整体反掉。
  function teamId(map, p) {
    var arr = map.team_ids_by_player_index;
    var idx = p === null || p === undefined ? -1 : p;
    if (idx < 0) return arr[arr.length - 1];
    return arr[idx];
  }

  function isPlayerOnTeamWith(map, p1, p2) {
    return teamId(map, p1) === teamId(map, p2);
  }

  // 原版 `x in dict` 对空 dict 永远 False；JS 的 Map 得先判存在，否则 undefined 会被当成「有」。
  function mapGet(m, key) {
    if (m === null || m === undefined) return undefined;
    if (typeof m.get === 'function') return m.has(key) ? m.get(key) : undefined;
    return m[key];
  }

  function isNullish(v) {
    return v === null || v === undefined;
  }

  /* ==================================================================
   * ThreatObj
   * ================================================================== */

  function ThreatObj(moveCount, threatValue, path, type, saveTile, armyAnalysis) {
    // 能用来防守的回合数：如果意思是「两回合后死」，这里就是 1
    this.turns = moveCount;
    this.threatValue = Math.ceil(threatValue);
    this.path = path;
    this.threatPlayer = path.start.tile.player();
    this.threatType = type;
    this.saveTile = isNullish(saveTile) ? null : saveTile;
    this.armyAnalysis = isNullish(armyAnalysis) ? null : armyAnalysis;
  }

  /*
   * 把「威胁路径」翻译成「我应该在哪几格攒兵、那几格分别需要提前几回合到位」。
   *
   * offset 默认 -1：路径第 i 格的距离是 i-1，即「现在就开始攒，哪一回合动手」。返回的 dict 里
   * 距离越小越优先集结。这里不能简单照抄路径距离：
   *   - 将军格单独处理，因为必须比平时早一回合站上去（到了将军格才算防住）；
   *   - 其它格子要加上 chokeWidth：路口越宽，我在这一格攒的兵能覆盖的方向越多，等价于能晚一回合；
   *     而 interceptChoke 表示敌人还有几条别的路能在同一回合切进来，所以要再提前。
   *   - stripBad 是「支配关系」剪枝：一条路径上如果后面的格子和前面的格子等价或更近，那前面
   *     那格永远不会被选中（攒到后面那格再去一样快），留着只会让后面选点的人多算一遍。
   */
  ThreatObj.prototype.convert_to_dist_dict = function (offset, allowNonChoke, stripBad) {
    if (offset === undefined || offset === null) offset = -1;
    if (allowNonChoke === undefined) allowNonChoke = false;
    if (stripBad === undefined) stripBad = true;

    var distDict = this.path.get_reversed().convert_to_dist_dict(offset);

    var tileList = this.path.tileList;
    for (var i = 0; i < tileList.length; i++) {
      var tile = tileList[i];
      // 原版是 pop：路径上的格子先摘出来，下面的分支不重新写回去就等于从结果里剔除了
      distDict.delete(tile);
      var dist = this.armyAnalysis.aMap.raw[tile.tile_index] + offset;
      var newDist = dist;

      // 攻击方已经在路径起点上，那格不需要「走过去」的时间，只留 offset 的提前量
      if (tile === this.path.start.tile) newDist -= 0 - offset;

      if (allowNonChoke) distDict.set(tile, newDist);

      if (tile.isGeneral) {
        // 将军必须早一回合到位，任何 choke 补偿都不能把它推后
        distDict.set(tile, newDist);
        continue;
      }

      var chokeWidth = this.armyAnalysis.chokeWidths.raw[tile.tile_index];
      var interceptChoke = this.armyAnalysis.interceptChokes.raw[tile.tile_index];
      // 路口多于 2 条时这个补偿就是错的（原版的注释也这么说），只有 <= 2 时才敢用
      if (allowNonChoke || (!isNullish(interceptChoke) && interceptChoke < 3)) {
        if (!isNullish(chokeWidth)) {
          newDist = dist + chokeWidth - 1;
          if (chokeWidth <= 2 && !isNullish(interceptChoke) && interceptChoke > 0) {
            newDist -= interceptChoke;
          }
          distDict.set(tile, newDist);
        }
      }
    }

    if (stripBad) {
      var lastVal = null;
      var lastTile = null;
      for (var k = 0; k < tileList.length; k++) {
        var t = tileList[k];
        var val = distDict.has(t) ? distDict.get(t) : null;
        if (!isNullish(val)) {
          if (!isNullish(lastVal)) {
            // 后面那格更早就能动手 → 前面那格没人会攒，删前面的
            if (val < lastVal - 1) distDict.delete(lastTile);
            // 后面那格更晚 → 后面那格没人会攒，删后面的
            if (val > lastVal) distDict.delete(t);
          }
        }
        lastVal = val;
        lastTile = t;
      }
    }

    return distDict;
  };

  ThreatObj.prototype.toString = function () {
    return (
      '[p' +
      this.threatPlayer +
      ' ' +
      this.threatValue +
      ' in ' +
      this.turns +
      ' @ ' +
      (this.path.tail ? this.path.tail.tile.toString() : 'null') +
      ': ' +
      String(this.path) +
      ']'
    );
  };

  /* ==================================================================
   * DangerAnalyzer
   * ================================================================== */

  // base/client/map.py 的 MODIFIER_DEFENSELESS 是 5（modifiers_by_id 是按下标填的裸数组）。
  // 不要用 map.has_defenseless：map.js 里那个别名取的是下标 12，和原版常量对不上。
  var MODIFIER_DEFENSELESS = 5;

  function DangerAnalyzer(map) {
    this.nonGeneralTargets = [];
    this.map = map;
    this.fastestVisionThreat = null;
    this.fastestThreat = null;
    this.fastestCityThreat = null;
    // 「如果我把将军上的兵调走，敌人能多快摸到将军」
    this.fastestPotentialThreat = null;
    this.fastestAllyThreat = null;
    this.highestThreat = null;
    this.playerTiles = null;

    this.alliedGenerals = [this.map.generals[this.map.player_index]];
    // 原版遍历 map.teammates（Python set）；小整数的 set 迭代是升序，这里排序以保持一致
    var mates = Array.from(this.map.teammates);
    mates.sort(function (a, b) {
      return a - b;
    });
    for (var mi = 0; mi < mates.length; mi++) {
      var teammate = mates[mi];
      if (!this.map.players[teammate].dead) this.alliedGenerals.push(this.map.generals[teammate]);
    }

    this.anyThreat = false;
    this.ignoreThreats = false;
    this.largeVisibleEnemyTiles = [];

    this.defenseless_modifier = this.map.modifiers_by_id[MODIFIER_DEFENSELESS];
    // key = "tileA,tileB,bypass,m axDist"，同一对格子会被 fastestThreat / highestThreat / vision
    // 反复问，不缓存的话每回合几百次全量 ArmyAnalyzer。
    this._army_analysis_cache = new Map();
  }

  DangerAnalyzer.prototype.__getstate__ = function () {
    var state = {};
    for (var k in this) {
      if (Object.prototype.hasOwnProperty.call(this, k) && k !== 'map') state[k] = this[k];
    }
    return state;
  };

  DangerAnalyzer.prototype.__setstate__ = function (state) {
    for (var k in state) {
      if (Object.prototype.hasOwnProperty.call(state, k)) this[k] = state[k];
    }
    this.map = null;
  };

  /*
   * 每回合的唯一入口。defenseTiles 是调用方给的「非将军目标格」（城市、前哨等），
   * depth 是搜索深度（原版 bot 传 6）。
   */
  DangerAnalyzer.prototype.analyze = function (defenseTiles, depth, armies) {
    this._army_analysis_cache.clear();
    var general = this.map.generals[this.map.player_index];
    this.scan(general);

    this.nonGeneralTargets = defenseTiles;
    this.fastestThreat = this.getFastestThreat(depth, armies, this.map.player_index);
    // 城市数太多时（中后期）不再把每座城都当目标，原版认为那时候城守不过来也不重要
    if (this.map.players[this.map.player_index].cityCount < 30) {
      this.fastestCityThreat = this.getFastestThreat(depth, armies, this.map.player_index, false, null, false, true);
    }

    var negTiles = new Set();
    if (this.fastestThreat !== null) {
      this.fastestThreat.path.tileSet.forEach(function (t) {
        negTiles.add(t);
      });
    }
    this.fastestPotentialThreat = this.getFastestThreat(depth + 2, armies, this.map.player_index, true, negTiles);

    if (this.map.is_2v2) {
      var mates = Array.from(this.map.teammates);
      mates.sort(function (a, b) {
        return a - b;
      });
      for (var mi = 0; mi < mates.length; mi++) {
        // 原版这里每轮覆盖同一个字段，最后一个队友说了算
        this.fastestAllyThreat = this.getFastestThreat(depth, armies, mates[mi]);
      }
    }

    this.highestThreat = this.getHighestThreat(general, depth, armies);
    this.fastestVisionThreat = this.getVisionThreat(9, armies);

    this.anyThreat =
      this.fastestThreat !== null ||
      this.fastestVisionThreat !== null ||
      this.fastestAllyThreat !== null ||
      this.highestThreat !== null;
  };

  /*
   * 「敌人什么时候能看到我将军旁边的格子」——不是致命威胁，但意味着我的调动开始被看见。
   * 只对「还有兵在视野里 + 地盘够大 + 不是队友」的玩家搜，因为小玩家看不到也不会真来。
   */
  DangerAnalyzer.prototype.getVisionThreat = function (depth, armies) {
    var curThreat = null;
    var threatenedGen = null;
    var map = this.map;

    for (var pi = 0; pi < map.players.length; pi++) {
      var player = map.players[pi];
      if (
        !player.dead &&
        player.index !== map.player_index &&
        this.playerTiles[player.index].length > 0 &&
        map.players[player.index].tileCount > 10 &&
        !map.teammates.has(player.index)
      ) {
        for (var gi = 0; gi < this.alliedGenerals.length; gi++) {
          var general = this.alliedGenerals[gi];
          // 对方已经知道我方国王位置的话，这一「视野威胁」早就兑现了，没有防守意义
          if (player.knowsKingLocation && general.player() === map.player_index) continue;
          if (player.knowsAllyKingLocation && map.teammates.has(general.player())) continue;

          var skip = false;
          for (var ai = 0; ai < general.adjacents.length; ai++) {
            var adj = general.adjacents[ai];
            if (adj.player() !== -1 && adj.player() !== general.player()) {
              // 将军旁边已经有别人的兵贴着，那早就被看见了
              skip = true;
              break;
            }
          }
          if (skip) continue;

          var path = EK.search.dest_breadth_first_target(map, general.adjacents, {
            targetArmy: 0.5,
            maxDepth: depth,
            negativeTiles: null,
            searchingPlayer: player.index,
            noNeutralCities: true,
            maxTime: Infinity
          });

          if (
            path !== null &&
            (curThreat === null ||
              path.length < curThreat.length ||
              (path.length === curThreat.length && path.value > curThreat.value))
          ) {
            curThreat = path;
            threatenedGen = general;
          }
        }
      }
    }

    var threatObj = null;
    if (curThreat !== null) {
      var army = curThreat.start.tile;
      var found = mapGet(armies, army);
      if (found !== undefined) army = found;
      var analysis = this._get_army_analysis(threatenedGen, army);
      threatObj = new ThreatObj(curThreat.length - 1, curThreat.value, curThreat, ThreatType.Vision, null, analysis);
    }
    return threatObj;
  };

  /*
   * 按「威胁从哪一格发起」分组。同一发起格可能有多个不同落点，去重 key 是 (发起格, 落点)。
   * includePotentialThreat / includeVisionThreat 决定要不要把 analyze() 算出来的那几个也塞进来。
   */
  DangerAnalyzer.prototype.get_threats_grouped_by_tile = function (
    armies,
    includePotentialThreat,
    includeVisionThreat,
    alwaysIncludeArmy,
    includeArmiesWithThreats,
    alwaysIncludeRecentlyMoved
  ) {
    if (includePotentialThreat === undefined) includePotentialThreat = true;
    if (includeVisionThreat === undefined) includeVisionThreat = true;
    if (alwaysIncludeArmy === undefined) alwaysIncludeArmy = null;
    if (includeArmiesWithThreats === undefined) includeArmiesWithThreats = false;
    if (alwaysIncludeRecentlyMoved === undefined) alwaysIncludeRecentlyMoved = false;

    var map = this.map;
    var threatLookup = new Map();
    var tailLookup = new Map();

    function addIfNotDuplicate(threat) {
      var tailKey = threat.path.tail.tile;
      var threatStart = threat.path.start.tile;
      var l = threatLookup.has(threatStart) ? threatLookup.get(threatStart) : [];
      if (l.length === 0) threatLookup.set(threatStart, l);

      var added = tailLookup.has(threatStart) ? tailLookup.get(threatStart) : new Set();
      if (added.size === 0) tailLookup.set(threatStart, added);

      if (!added.has(tailKey)) {
        l.push(threat);
        added.add(tailKey);
      }
    }

    if (this.fastestThreat !== null) addIfNotDuplicate(this.fastestThreat);
    if (this.highestThreat !== null) addIfNotDuplicate(this.highestThreat);
    // 已经有将军级威胁时，视野威胁只会是噪音（它总是更远、兵更少）
    if (threatLookup.size === 0 && includeVisionThreat && this.fastestVisionThreat !== null) {
      addIfNotDuplicate(this.fastestVisionThreat);
    }
    if (this.fastestCityThreat !== null) addIfNotDuplicate(this.fastestCityThreat);
    if (this.fastestAllyThreat !== null) addIfNotDuplicate(this.fastestAllyThreat);
    if (includePotentialThreat && this.fastestPotentialThreat !== null) addIfNotDuplicate(this.fastestPotentialThreat);

    var countCity = 0;
    var countGen = 0;
    var countExpansion = 0;
    var self = this;

    threatLookup.forEach(function (threatList, threatStart) {
      var army = mapGet(armies, threatStart);
      if (army === undefined || army === null) return;
      // 15 回合没再见到这个 ArmyTracker 影子，就别拿它当威胁了
      if (army.last_seen_turn < map.turn - 15) return;

      var added = tailLookup.get(threatStart);

      for (var ei = 0; ei < army.expectedPaths.length; ei++) {
        var path = army.expectedPaths[ei];
        if (path === null || path === undefined || path.length <= 0 || path.start === null) continue;
        path = path.get_positive_subsegment(army.player, map.team_ids_by_player_index);
        if (path === null || path === undefined || path.start === null) continue;
        var threatType = ThreatType.Econ;
        if (path.start.tile === threatStart) {
          if (!added.has(path.tail.tile)) {
            if (path.tail.tile.isGeneral) {
              threatType = ThreatType.Kill;
              countGen += 1;
              if (countGen > 2) continue;
            } else if (path.tail.tile.isCity) {
              threatType = ThreatType.Kill;
              countCity += 1;
              if (countCity > 2) continue;
            } else {
              countExpansion += 1;
              if (countExpansion > 3) continue;
            }
            added.add(path.tail.tile);
            threatList.push(new ThreatObj(path.length - 1, path.value, path, threatType, null));
          }
        }
      }
    });

    if (alwaysIncludeArmy || alwaysIncludeRecentlyMoved || includeArmiesWithThreats) {
      // 原版按 value 降序处理 Army，顺序会影响 2/3/4 这几个配额花在谁身上
      var armyList = Array.from(armies.values());
      armyList.sort(function (a, b) {
        return b.value - a.value;
      });

      for (var ai = 0; ai < armyList.length; ai++) {
        var army = armyList[ai];
        var threatStart = army.tile;
        if (map.is_player_friendly(army.player)) continue;
        if (threatLookup.has(threatStart)) continue; // already added
        if (army.last_seen_turn < map.turn - 15) continue;

        var include = false;
        if (alwaysIncludeArmy === army) {
          include = true;
        } else if (
          alwaysIncludeRecentlyMoved &&
          army.last_moved_turn > map.turn - 2 &&
          army.last_seen_turn > map.turn - 10
        ) {
          for (var rp = 0; rp < army.expectedPaths.length; rp++) include = true;
        } else if (includeArmiesWithThreats && army.last_seen_turn > map.turn - 10) {
          for (var tp = 0; tp < army.expectedPaths.length; tp++) {
            var apath = army.expectedPaths[tp];
            if (apath !== null && apath !== undefined) {
              var posPath = apath.get_positive_subsegment(army.player, map.team_ids_by_player_index);
              var friendlyCount = 0;
              for (var pl = 0; pl < posPath.tileList.length; pl++) {
                if (map.is_tile_friendly(posPath.tileList[pl])) friendlyCount++;
              }
              if (friendlyCount > 3) include = true;
            }
            break;
          }
        }

        if (!include) continue;

        var added = new Set();
        var threatList = [];
        threatLookup.set(threatStart, threatList);
        if (
          army.value > 4 &&
          !EK.search.any_where(army.expectedPaths, function (p) {
            return (
              p !== null &&
              p !== undefined &&
              !p.tail.tile.isCity &&
              !p.tail.tile.isGeneral
            );
          })
        ) {
          // 这条影子只预测了扩张、没预测打城/打国王，那它威胁等级不够，补一条「假设它来打我们」的路径。
          // 依赖 ArmyTracker.get_expected_enemy_expansion_path —— 那个模块还没移植，先跳过（见文件头注释）。
          if (typeof army.get_expected_enemy_expansion_path === 'function') {
            var p = army.get_expected_enemy_expansion_path(map, army.tile, map.generals[map.player_index]);
            if (p !== null && (p.tail.tile.isCity || p.tail.tile.isGeneral)) army.include_path(p);
          }
        }
        for (var ep = 0; ep < army.expectedPaths.length; ep++) {
          var path2 = army.expectedPaths[ep];
          if (path2 === null || path2 === undefined || path2.length <= 0) continue;
          if (path2.start.tile === threatStart) {
            if (!added.has(path2.tail.tile)) {
              if (path2.tail.tile.isGeneral) {
                countGen += 1;
                if (countGen > 3) continue;
              } else if (path2.tail.tile.isCity) {
                countCity += 1;
                if (countCity > 3) continue;
              } else {
                countExpansion += 1;
                if (countExpansion > 4) continue;
              }
              added.add(path2.tail.tile);
              threatList.push(new ThreatObj(path2.length - 1, path2.value, path2, ThreatType.Econ, null));
            }
          }
        }
      }
    }

    return threatLookup;
  };

  DangerAnalyzer.prototype.get_threats_by_tile = function (tile, armies, includePotentialThreat, includeVisionThreat) {
    var threatLookup = this.get_threats_grouped_by_tile(
      armies,
      includePotentialThreat,
      includeVisionThreat
    );

    var threatList = threatLookup.has(tile) ? threatLookup.get(tile) : [];
    if (threatList.length === 0) {
      var army = mapGet(armies, tile);
      if (army !== undefined && army !== null) {
        var added = new Set();
        for (var i = 0; i < army.expectedPaths.length; i++) {
          var path = army.expectedPaths[i];
          if (path.start.tile === tile) {
            if (!added.has(path.tail.tile)) {
              added.add(path.tail.tile);
              threatList.push(new ThreatObj(path.length - 1, path.value, path, ThreatType.Kill, null));
            }
          }
        }
      }
    }

    return threatList;
  };

  /*
   * 核心搜索：从目标格反向 BFS（dest_breadth_first_target 是「带着 targetArmy 兵打到 goal」的搜索），
   * 找出最快能打穿我的敌人。它不是正向找敌人，而是问「如果我是某个敌人，最快几步、剩多少兵能拿下目标」，
   * 这样不用知道敌人的兵具体在哪。
   *
   * 参数语义（都别改）：
   *   pretendTilesVacated —— 假设我把己方所有 >7 兵的格子都空出来（兵被调去防守别处），
   *                          searchArmyAmount 也相应减掉将军现有兵力，用来估「抽兵之后的漏洞」。
   *   negTiles             —— 视为不可走/没兵的格子（刚才那条威胁路径、敌方将军等）。
   *   generalOnly          —— 只把将军当目标，而不是 nonGeneralTargets 那串。
   *   requireMovement      —— 只考虑「最近真的动过的敌人」，用来过滤掉测绘出来的假影子。
   */
  DangerAnalyzer.prototype.getFastestThreat = function (
    depth,
    armies,
    againstPlayer,
    pretendTilesVacated,
    negTiles,
    generalOnly,
    requireMovement
  ) {
    if (pretendTilesVacated === undefined) pretendTilesVacated = false;
    if (negTiles === undefined) negTiles = null;
    if (generalOnly === undefined) generalOnly = true;
    if (requireMovement === undefined) requireMovement = false;

    var map = this.map;
    var curThreat = null;
    var saveTile = null;

    var isFfaMode = map.remainingPlayers > 2 && this.alliedGenerals.length === 1;
    var genPlayer = map.players[againstPlayer];
    if (genPlayer.dead) return null;

    var general = map.generals[againstPlayer];
    if (!general) return null;

    if (negTiles === null || negTiles === undefined) negTiles = new Set();

    var negativeTilesToUse = new Set(negTiles);

    if (pretendTilesVacated) {
      var myTiles = map.players[againstPlayer].tiles;
      for (var ti = 0; ti < myTiles.length; ti++) {
        var t = myTiles[ti];
        if (!t.isGeneral && t.army > 7) negativeTilesToUse.add(t);
      }
    }

    var targets = this.nonGeneralTargets;
    if (generalOnly) targets = [general];

    var searchArmyAmount = 1;
    if (pretendTilesVacated) searchArmyAmount -= general.army - 1;

    var defendableFromPlayers = new Set();
    var self = this;

    if (!requireMovement) {
      for (var pi = 0; pi < map.players.length; pi++) {
        var player = map.players[pi];
        if (player.dead) continue;
        if (map.teammates.has(player.index) || player.index === map.player_index) continue;
        if (this.playerTiles[player.index].length === 0 || player.tileCount <= 2) continue;
        if (isPlayerOnTeamWith(map, map.player_index, player.index)) continue;

        // FFA 里对「经济已经碾压我但兵力还差一点」的玩家不做防守判断，原版的取舍：
        // 这种对手要不了多久就会去打别人，先守会亏。
        var oppEcon = player.tileCount + player.cityCount * 25;
        var usEcon = genPlayer.tileCount + genPlayer.cityCount * 25;
        if (oppEcon > usEcon * 1.25 && player.score > genPlayer.score * 0.9 && isFfaMode) continue;
        if (player.score > genPlayer.score * 1.25 && oppEcon > usEcon * 1.0 && isFfaMode) continue;

        defendableFromPlayers.add(player.index);

        var curNegs = new Set(negativeTilesToUse);
        if (player.general !== null && player.general !== undefined) curNegs.add(player.general);

        if (this.defenseless_modifier) {
          for (var gi2 = 0; gi2 < targets.length; gi2++) {
            if (targets[gi2].isGeneral) curNegs.add(targets[gi2]);
          }
        }

        var path = EK.search.dest_breadth_first_target(map, targets, {
          targetArmy: searchArmyAmount,
          maxDepth: depth,
          negativeTiles: curNegs,
          searchingPlayer: player.index,
          noNeutralCities: true,
          maxTime: Infinity
        });

        if (path !== null && path !== undefined) {
          var skipped = this._skip_double_counted_armies(path, armies, curNegs);
          if (skipped) path = null;
        }

        if (
          path !== null &&
          path !== undefined &&
          (curThreat === null ||
            path.length < curThreat.length ||
            (path.length === curThreat.length && path.value > curThreat.value))
        ) {
          // 找一条「不走目标前一格」的备选路径：如果存在另一条不相交的路，我就可以晚一回合才在
          // saveTile 上攒兵（因为敌人不会一步到位）。
          var lastTile = path.tail.prev.tile;
          var altPath = EK.search.dest_breadth_first_target(map, [path.tail.tile], {
            targetArmy: searchArmyAmount,
            maxDepth: path.length + 5,
            negativeTiles: curNegs,
            searchingPlayer: player.index,
            noNeutralCities: true,
            skipTiles: [lastTile],
            maxTime: Infinity
          });

          if (altPath !== null && altPath !== undefined) {
            var skippedAlt = this._skip_double_counted_armies(altPath, armies, curNegs);
            if (skippedAlt) altPath = null;
          }

          if (altPath === null || altPath === undefined || altPath.length > path.length) {
            saveTile = lastTile;
          }

          curThreat = path;
          // 原版在这里改写了循环外的 depth，后面的玩家会搜得更深（因为已经知道要先撑几回合）
          depth = path.length + 1;
        }
      }
    } else {
      // requireMovement 只关心「最近动过」的敌人，所以这里不做经济/目标过滤
      for (var pj = 0; pj < map.players.length; pj++) {
        var p2 = map.players[pj];
        if (p2.dead) continue;
        if (map.teammates.has(p2.index) || p2.index === map.player_index) continue;
        if (isPlayerOnTeamWith(map, map.player_index, p2.index)) continue;
        defendableFromPlayers.add(p2.index);
      }
    }

    // 这一支处理「ArmyTracker 认为某格上有敌兵，但那格已经被我们占着/或者兵和格子归属对不上」的情况：
    // 靠 Army 自己的预测路径去找我方目标。
    var armyIter = armies instanceof Map ? Array.from(armies.entries()) : [];
    for (var e = 0; e < armyIter.length; e++) {
      var armyTile = armyIter[e][0];
      var army = armyIter[e][1];

      if (armyTile.visible && !requireMovement) continue;
      // 兵和格子归属一致 = 这格就是它自己的地盘，上面那个反向 BFS 已经覆盖了
      if (armyTile.player() === army.player && !requireMovement) continue;
      if (!defendableFromPlayers.has(army.player)) continue;
      if (map.is_tile_friendly(armyTile)) continue;
      if (map.teammates.has(armyTile.player())) continue;
      // 不可见又是 4 回合前动过的影子，多半是误报，不值得防守
      if (!army.visible && army.last_moved_turn < map.turn - 4) continue;
      if (army.visible && requireMovement && army.last_moved_turn < map.turn - 2) continue;

      var startTiles = new Map();
      startTiles.set(armyTile, [[0, 0, 0, 0, armyTile.x, armyTile.y, 0.5], 0]);
      var goalSet = new Set(targets);
      var goalFunc = function (tile, prio) {
        return goalSet.has(tile) && prio[3] >= 0;
      };
      var path2 = EK.search.breadth_first_dynamic(map, startTiles, goalFunc, {
        maxDepth: depth,
        // 兵多的影子走得动中立城，兵少的走不动（原版 noNeutralCities=army.value < 150）
        noNeutralCities: army.value < 150,
        searchingPlayer: army.player,
        incrementBackward: false,
        maxTime: Infinity
      });

      if (path2 !== null && path2 !== undefined) {
        var skip = false;
        var armiesAlreadyInPath = [];
        for (var pt = 0; pt < path2.tileList.length; pt++) {
          var armyInPath = mapGet(armies, path2.tileList[pt]);
          if (armyInPath !== undefined && armyInPath !== null && armyInPath.entangledArmies) {
            var armyKey = armyInPath.name + ',' + armyInPath.player;
            if (armiesAlreadyInPath.indexOf(armyKey) >= 0) skip = true;
            armiesAlreadyInPath.push(armyKey);
          }
        }
        if (!skip) {
          if (
            path2.value > 0 &&
            (curThreat === null ||
              path2.length < curThreat.length ||
              (path2.value > curThreat.value && path2.length === curThreat.length))
          ) {
            curThreat = path2;
          }
          if (typeof army.include_path === 'function') army.include_path(path2);
        }
      }
    }

    if (curThreat !== null) {
      var startTile = curThreat.start.tile;
      var armyOrTile = startTile;
      var foundArmy = mapGet(armies, startTile);
      if (foundArmy !== undefined && foundArmy !== null) armyOrTile = foundArmy;
      var analysis = this._get_army_analysis(curThreat.tail.tile, armyOrTile);
      return new ThreatObj(curThreat.length - 1, curThreat.value, curThreat, ThreatType.Kill, saveTile, analysis);
    }
    return null;
  };

  /*
   * 同一条路径上如果反复出现同一支纠缠部队（entangledArmies 同名同主），说明 ArmyTracker 把一个
   * 移动中的兵拆成了好几条影子，这条路是假的。原版的做法是把这些格子加进 negativeTiles 再重搜，
   * 这里只做判定，重搜留给调用方下一轮（等价：path = None）。
   */
  DangerAnalyzer.prototype._skip_double_counted_armies = function (path, armies, curNegs) {
    var armiesAlreadyInPath = [];
    var skipPath = false;
    for (var i = 0; i < path.tileList.length; i++) {
      var tile = path.tileList[i];
      var armyInPath = mapGet(armies, tile);
      if (armyInPath !== undefined && armyInPath !== null && armyInPath.entangledArmies && !curNegs.has(tile)) {
        var armyKey = armyInPath.name + ',' + armyInPath.player;
        if (armiesAlreadyInPath.indexOf(armyKey) >= 0) {
          curNegs.add(tile);
          skipPath = true;
        }
        armiesAlreadyInPath.push(armyKey);
      }
    }
    return skipPath;
  };

  // 原版目前就是「最高威胁 = 最快威胁」，留着这个函数是因为 bot 侧到处按名字调它
  DangerAnalyzer.prototype.getHighestThreat = function (general, depth, armies) {
    return this.fastestThreat;
  };

  DangerAnalyzer.prototype._get_army_analysis = function (
    armyA,
    armyB,
    bypassRetraverseThreshold,
    maxDist
  ) {
    if (bypassRetraverseThreshold === undefined) bypassRetraverseThreshold = -1;
    if (maxDist === undefined) maxDist = 100;

    var tileA = armyA && typeof armyA.tile === 'object' && armyA.tile !== null ? armyA.tile : armyA;
    var tileB = armyB && typeof armyB.tile === 'object' && armyB.tile !== null ? armyB.tile : armyB;
    var key = tileA.tile_index + ',' + tileB.tile_index + ',' + bypassRetraverseThreshold + ',' + maxDist;
    var analysis = this._army_analysis_cache.get(key);
    if (analysis === undefined) {
      analysis = new EK.ArmyAnalyzer(this.map, armyA, armyB, bypassRetraverseThreshold, null, maxDist);
      this._army_analysis_cache.set(key, analysis);
    }
    return analysis;
  };

  /*
   * 每回合先扫一遍全图：把每格按玩家分桶（后续所有「这个玩家还有没有兵在场上」的判断都用它），
   * 顺便记下「大到值得担心的可见敌兵」。
   */
  DangerAnalyzer.prototype.scan = function (general) {
    var map = this.map;
    this.largeVisibleEnemyTiles = [];
    this.playerTiles = [];
    for (var i = 0; i < map.players.length; i++) this.playerTiles.push([]);

    var allTiles = map.get_all_tiles();
    var threshold = Math.max(2, Math.floor(general.army / 4));
    for (var ti = 0; ti < allTiles.length; ti++) {
      var tile = allTiles[ti];
      if (tile.player() === -1) continue;

      this.playerTiles[tile.player()].push(tile);

      if (
        !map.teammates.has(tile.player()) &&
        tile.player() !== general.player() &&
        tile.army > threshold &&
        tile.visible &&
        !tile.isGeneral
      ) {
        this.largeVisibleEnemyTiles.push(tile);
      }
    }
  };

  /* ==================================================================
   * 导出
   * ================================================================== */

  EK.ThreatType = ThreatType;
  EK.ThreatObj = ThreatObj;
  EK.DangerAnalyzer = DangerAnalyzer;

  if (typeof module !== 'undefined' && module.exports) module.exports = EK;
})(typeof window !== 'undefined' ? window : global);
