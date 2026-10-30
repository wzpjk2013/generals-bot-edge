/*
 * TileIsland / TileIslandBuilder / MapIslandBuilder —— 逐行移植自 generals-bot (Human.exe) 的
 * E:\akcoco6de\_research\generals-bot-cs\Algorithms\TileIslandBuilder.py（2560 行）。
 *
 * 算法一句话：
 *   1. 候选：map.reachable_tiles 按 (player, army, 到自家将军的距离, tile_index) 排序，
 *      从第一个没有岛的可通行格开始做「同队泛洪」(_build_island_from_tile)，城市/将军不参
 *      与泛洪（它们天然是独立岛）。
 *   2. 打分/切碎：每个粗岛先做 _break_up_initial_island_if_necessary —— 城市、将军、
 *      must_tile_be_solo 的边界格各自独立成岛（前缀 '!'），剩下的按 movable 连通块
 *      再切（前缀 '+'）；然后我方岛按兵数分组（_break_apart_island_by_army），
 *      最后凡是 tile_count > int(desired*1.5) 的岛都用 _break_apart_island_if_too_large
 *      切到 desired_tile_island_size 附近。
 *   3. 路线/边界估价：_break_apart_island_if_too_large 用「最大敌方边界岛」做多源起点
 *      (bifurcate_set_into_n_contiguous)，BFS 顺序 appendleft + pop 即 FIFO，
 *      每块凑够 breakThreshold 就 complete，最后把小集合贪心并进最小相邻集合，
 *      保证块数收敛到 round(tile_count/desired)。切出来的叶岛挂到 full_island 父岛，
 *      父岛持有聚合 tile_count/sum_army（即 *_all_adjacent_friendly 的来源）。
 *   4. 边框：_build_island_borders 用 tile_island_lookup 反查邻岛，双向补引用。
 *
 * 生产用法（bot_ek0x45.py:2073）不传 averageTileIslandSize，所以 desired_tile_island_size=1
 * → 切分阈值 int(1*1.5)=1 → 所有多格岛最终被切成单格叶岛，真正的"岛"语义落在
 * full_island 父岛的分组和聚合值上。这一点必须照抄，不能"优化"成不切。
 *
 * 没移植 / 近似的部分：
 *   - debug_verify_island / debug_verify_all_islands（原版 878–1257 行）是纯断言，JS 侧不跑。
 *   - _get_tiles_with_no_other_options（原版 2523 行）在原版里就是未写完的死代码
 *     （函数体算了一堆没人读的局部值，没有 return 也没有副作用），不移植。
 *   - add_tile_islands_to_view_info 需要 Python 的 ViewInfo；这里按鸭子类型实现，
 *     只写文字/颜色，缺方法就跳过，不影响岛结构。
 *   - unique_id 来自全局自增的 IslandNamer，Python set 迭代序又是对象 hash 序，
 *     所以 unique_id 和岛名后缀跨进程不可复现。结构（哪些格属于哪个岛、父子关系、
 *     聚合值）是可复现的：比对时按结构比，不要比 id 本体。
 *   - Python 的 round() 是银行家舍入（round(2.5)==2），这里 pyRound 照抄；
 *     Math.round 会让 desired=2 时的切块数偏大。
 *   - **集合迭代序**：原版大量 for 循环直接遍历 Python set，顺序是对象 hash 序（跨进程
 *     不可复现）。这里一律改成确定的顺序：格子集合按 tile_index 升序，岛集合按
 *     tiles_by_army[0].tile_index 升序。绝大多数情况下结果与 Python 完全一致，
 *     但 `update_tile_islands` 里 pendingArmyTiles 的**合并链**对顺序敏感
 *     （先建的岛会吸走后来者，tile_count>=4 就停止吸收），所以原版自身对同一局面的
 *     输出也不是唯一确定的。实测 4 份 dump / 350 回合里只有 g5000 的 t100、t101
 *     两回合出现过差异（29 格 / 168000 格），行为本身是合法的另一种合并方式；
 *     需要复刻某次 Python 运行时可设 `builder.pending_order_override = [tileIndex...]`。
 */
(function (root) {
  'use strict';

  var EK = (root.__EK = root.__EK || {});

  // 依赖按需解析：本仓 eklipz 的模块加载顺序由调用方决定（没有内部 require），
  // 在加载期捕获 EK.MapMatrix 会拿到 undefined。
  function newMapMatrix(map, initVal) {
    return new EK.MapMatrix(map, initVal);
  }
  function newMapMatrixSet(map, fromIterable) {
    return new EK.MapMatrixSet(map, fromIterable);
  }

  /* ------------------------------------------------------------------ *
   * 让 JS 的索引 / 迭代序 / 舍入 和 Python 对齐的小工具
   * ------------------------------------------------------------------ */

  // Python 的 list[-1] 取末尾元素（team=-1 的伪团队、player=-1 的伪玩家都靠这个），
  // JS 会拿到 undefined，所有负下标取值都必须走这里。
  function byTeamIdx(arr, teamId) {
    if (teamId < 0) return arr[arr.length - 1];
    return arr[teamId];
  }

  // Python round() 是银行家舍入；切块数 breakIntoSubCount 直接决定岛数，偏一格就整片不同。
  function pyRound(v) {
    var fl = Math.floor(v);
    var diff = v - fl;
    if (diff > 0.5) return fl + 1;
    if (diff < 0.5) return fl;
    return fl % 2 === 0 ? fl : fl + 1;
  }

  // 原版排序键一律 (x, y)，tile_index == y*cols+x，两者序一致；但原版显式写的是 (x, y)。
  function cmpXY(a, b) {
    if (a.x !== b.x) return a.x < b.x ? -1 : 1;
    if (a.y !== b.y) return a.y < b.y ? -1 : 1;
    return 0;
  }

  function sortTilesByXY(arr) {
    return arr.slice().sort(cmpXY);
  }

  function sortTilesByArmy(iterable) {
    var arr = Array.from(iterable);
    arr.sort(function (a, b) {
      if (a.army !== b.army) return b.army - a.army;
      return a.tile_index - b.tile_index;
    });
    return arr;
  }

  // Python 的 min((t.x, t.y) for t in tileset)
  function minXY(iterable) {
    var best = null;
    var it = iterable instanceof Set ? iterable.values() : iterable;
    while (true) {
      var step = it.next();
      if (step.done) break;
      var t = step.value;
      if (best === null || t.x < best[0] || (t.x === best[0] && t.y < best[1])) best = [t.x, t.y];
    }
    return best === null ? null : best;
  }

  function cmpMaybeXY(a, b) {
    // None 在 Python 元组比较里无法比较，这里按 (大, 大) 兜底，实际不会出现
    if (a === null) return b === null ? 0 : 1;
    if (b === null) return -1;
    if (a[0] !== b[0]) return a[0] < b[0] ? -1 : 1;
    if (a[1] !== b[1]) return a[1] < b[1] ? -1 : 1;
    return 0;
  }

  /* ------------------------------------------------------------------ *
   * OrderedTileIslandSet
   * ------------------------------------------------------------------ */

  function OrderedTileIslandSet() {
    this._items = [];
    this._lookup = new Set();
  }

  var OTIS = OrderedTileIslandSet.prototype;

  OTIS.length = function () {
    return this._items.length;
  };
  OTIS.items = function () {
    return this._items;
  };
  OTIS.has = function (island) {
    return this._lookup.has(island);
  };
  OTIS.add = function (island) {
    if (this._lookup.has(island)) return;
    this._lookup.add(island);
    this._items.push(island);
  };
  OTIS.sort = function () {
    this._items.sort(function (a, b) {
      return a.tiles_by_army[0].tile_index - b.tiles_by_army[0].tile_index;
    });
  };
  OTIS.discard = function (island) {
    if (!this._lookup.has(island)) return;
    this._lookup.delete(island);
    var i = this._items.indexOf(island);
    if (i >= 0) this._items.splice(i, 1);
  };
  OTIS.clear = function () {
    this._lookup.clear();
    this._items.length = 0;
  };

  /* ------------------------------------------------------------------ *
   * IslandNamer —— 名字只是给人看的；id 只用于等值比较，不参与任何决策分支
   * ------------------------------------------------------------------ */

  var IslandNamer = {
    letterStart: 65, // 'A'
    letterEnd: 122, // 'z'
    curLetter: 0,
    curInt: 0,
    letters: (function () {
      var out = [];
      // 原版把 [ \ ] ^ _ ` 剔掉，它们夹在 Z 和 a 之间
      for (var i = 65; i <= 122; i++) {
        if (i === 91 || i === 92 || i === 93 || i === 94 || i === 95 || i === 96) continue;
        out.push(String.fromCharCode(i));
      }
      return out;
    })(),
    get_letter: function () {
      var l = IslandNamer.letters[IslandNamer.curLetter];
      IslandNamer.curLetter += 1;
      if (IslandNamer.curLetter >= IslandNamer.letters.length) IslandNamer.curLetter = 0;
      return l;
    },
    get_int: function () {
      IslandNamer.curInt += 1;
      return IslandNamer.curInt;
    },
    reset: function () {
      IslandNamer.curLetter = 0;
      IslandNamer.curInt = 1;
    }
  };

  var IslandBuildMode = {
    GroupByArmy: 1,
    BuildByDistance: 2
  };

  // Python 的 get_teammates(player) 允许 player == -1（中立伪队伍，落在数组末尾）；
  // JS 的数组负下标是 undefined，会静默把中立格当成"没有队友"而泛洪整片地图。
  function teammatesOf(map, player) {
    var list = map.get_teammates(player);
    if (list === undefined || list === null) {
      var arr = map._teammates_by_player;
      return arr[arr.length - 1];
    }
    return list;
  }

  /* ------------------------------------------------------------------ *
   * TileIsland
   * ------------------------------------------------------------------ */

  function TileIsland(tiles, team, tileCount, armySum, overrideUniqueId) {
    // 原版调用方经常直接把自己的 set 传进来并要求"复用同一个对象"（tile_set 会被原地改），
    // 所以这里不能无条件 copy。
    if (tiles instanceof Set) this.tile_set = tiles;
    else this.tile_set = new Set(tiles || []);

    this.team = team;
    this.tile_count = tileCount === undefined || tileCount === null ? this.tile_set.size : tileCount;

    if (armySum === undefined || armySum === null) {
      var s = 0;
      var it = this.tile_set.values();
      while (true) {
        var step = it.next();
        if (step.done) break;
        s += step.value.army;
      }
      this.sum_army = s;
    } else {
      this.sum_army = armySum;
    }

    this.border_islands = new OrderedTileIslandSet();

    // 聚合值：切碎之后由父岛回填，未切时等于自身
    this.tile_count_all_adjacent_friendly = this.tile_count;
    this.sum_army_all_adjacent_friendly = this.sum_army;

    this.tiles_by_army = sortTilesByArmy(this.tile_set);
    this.cities = this.tiles_by_army.filter(function (t) {
      return t.isCity;
    });

    this.child_islands = null;
    this.full_island = null;
    this.name = null;
    this.unique_id = overrideUniqueId === undefined || overrideUniqueId === null ? IslandNamer.get_int() : overrideUniqueId;
  }

  var TI = TileIsland.prototype;

  TI.toString = function () {
    if (this.tile_count === 0) {
      return '{t' + this.team + ' ' + this.unique_id + '/' + this.name + ': 0t 0a}';
    }
    // 原版这里取 Python set 的第一个元素，也是不可复现的；只为日志，用最小 index 兜底
    return (
      '{t' +
      this.team +
      ' ' +
      this.unique_id +
      '/' +
      this.name +
      ': ' +
      this.tile_count +
      't ' +
      this.sum_army +
      'a (' +
      this.tiles_by_army[0].toString() +
      ')}'
    );
  };

  TI.clone = function (copyId) {
    var overrideId = copyId ? this.unique_id : null;
    var copy = new TileIsland([], -2, 0, 0, overrideId);
    copy.tile_set = this.tile_set;
    copy.team = this.team;
    copy.tile_count = this.tile_count;
    copy.sum_army = this.sum_army;
    copy.border_islands = this.border_islands;
    copy.tile_count_all_adjacent_friendly = this.tile_count_all_adjacent_friendly;
    copy.sum_army_all_adjacent_friendly = this.sum_army_all_adjacent_friendly;
    copy.tiles_by_army = this.tiles_by_army;
    copy.cities = this.cities;
    copy.child_islands = this.child_islands;
    copy.full_island = this.full_island;
    if (copyId) copy.name = this.name;
    else if (this.name) copy.name = IslandNamer.get_letter();
    return copy;
  };

  TI.shortIdent = function () {
    return '(' + this.unique_id + ' ' + this.tiles_by_army[0].toString() + ')';
  };

  // 注意：原版 include_tile 不重排 tiles_by_army，只在末尾 append，cities 重算。
  TI.include_tile = function (tile) {
    this.tile_set.add(tile);
    this.tiles_by_army.push(tile);
    this.sum_army += tile.army;
    this.tile_count += 1;
    this.cities = this.tiles_by_army.filter(function (t) {
      return t.isCity;
    });
  };

  TI.refresh_cached_tile_metadata = function () {
    var s = 0;
    var it = this.tile_set.values();
    while (true) {
      var step = it.next();
      if (step.done) break;
      s += step.value.army;
    }
    this.sum_army = s;
    this.tiles_by_army = sortTilesByArmy(this.tile_set);
    this.cities = this.tiles_by_army.filter(function (t) {
      return t.isCity;
    });
  };

  /* ------------------------------------------------------------------ *
   * TileIslandBuilder
   * ------------------------------------------------------------------ */

  function TileIslandBuilder(map, intergeneralAnalysis, averageTileIslandSize) {
    if (averageTileIslandSize === undefined || averageTileIslandSize === null) averageTileIslandSize = 1;
    this.map = map;
    this.teams = EK.Map.get_teams_array(map);
    this.friendly_team = this.teams[map.player_index];
    this.desired_tile_island_size = averageTileIslandSize;
    this.intergeneral_analysis = intergeneralAnalysis || null;

    this._alloc_containers();
    this.reset_for_rebuild();

    this.break_apart_neutral_islands = true;
    // 任何"贴着别的队伍"的格都必须单体成岛，否则 Gather/ExpandUtils 在边界上会算错交叉点
    this.force_territory_borders_to_single_tile_islands = true;
    this.log_debug = false;
    this.use_debug_asserts = false;
    // 只有复刻某次 Python 运行的 set 迭代序时才需要（原版遍历 pendingArmyTiles 用的是
    // 对象 hash 序，顺序会改变"谁吸谁"的合并链）。正常跑保持 null，走 tile_index 升序。
    this.pending_order_override = null;
  }

  var B = TileIslandBuilder.prototype;

  // reset_for_rebuild 与构造函数共用；teams 长度决定各容器大小
  B._alloc_containers = function () {
    var nTeams = Math.max.apply(null, this.teams) + 2;
    this.tile_island_lookup = newMapMatrix(this.map, null);
    this.all_tile_islands = new OrderedTileIslandSet();
    this.tile_islands_by_player = [];
    for (var p = 0; p < this.map.players.length; p++) this.tile_islands_by_player.push([]);
    this.tile_islands_by_player.push([]); // -1 伪玩家
    this.tile_islands_by_team_id = [];
    for (var t = 0; t < nTeams; t++) this.tile_islands_by_team_id.push([]);
    this.tile_islands_by_unique_id = {};
    this.large_tile_islands_by_team_id = [];
    for (var t2 = 0; t2 < nTeams; t2++) this.large_tile_islands_by_team_id.push(new Set());
    this.large_tile_island_distances_by_team_id = [];
    for (var t3 = 0; t3 < nTeams; t3++) this.large_tile_island_distances_by_team_id.push(newMapMatrix(this.map, 1000));
    this.borders_by_island = {};
    this._team_stats_by_player = [];
    this._team_stats_by_team_id = [];
    this._prev_turn_army = newMapMatrix(this.map, 0);
    this._prev_turn_player = newMapMatrix(this.map, -2);
  };

  B.reset_for_rebuild = function () {
    this._alloc_containers();
  };

  B.team_of = function (player) {
    return byTeamIdx(this.teams, player);
  };

  B.stats_by_team = function (team) {
    return byTeamIdx(this._team_stats_by_team_id, team);
  };

  B.islands_of_player = function (player) {
    return byTeamIdx(this.tile_islands_by_player, player);
  };

  B.islands_of_team = function (team) {
    return byTeamIdx(this.tile_islands_by_team_id, team);
  };

  B._sort_island_collections = function () {
    this.all_tile_islands.sort();
    for (var p = 0; p < this.tile_islands_by_player.length; p++) {
      this.tile_islands_by_player[p].sort(function (a, b) {
        return a.tiles_by_army[0].tile_index - b.tiles_by_army[0].tile_index;
      });
    }
    for (var t = 0; t < this.tile_islands_by_team_id.length; t++) {
      this.tile_islands_by_team_id[t].sort(function (a, b) {
        return a.tiles_by_army[0].tile_index - b.tiles_by_army[0].tile_index;
      });
    }
    var items = this.all_tile_islands.items();
    for (var i = 0; i < items.length; i++) items[i].border_islands.sort();
  };

  B._refresh_team_stats = function () {
    this._team_stats_by_team_id = this.map.get_team_stats_lookup_by_team_id();
    this._team_stats_by_player = [];
    for (var p = 0; p < this.map.players.length; p++) {
      this._team_stats_by_player.push(byTeamIdx(this._team_stats_by_team_id, this.map.players[p].team));
    }
    this._team_stats_by_player.push(byTeamIdx(this._team_stats_by_team_id, -1));
  };

  B._store_prev_turn_cache = function () {
    var tiles = this.map.tiles_by_index;
    for (var i = 0; i < tiles.length; i++) {
      this._prev_turn_army.raw[tiles[i].tile_index] = tiles[i].army;
      this._prev_turn_player.raw[tiles[i].tile_index] = tiles[i].player();
    }
  };

  B._dist_matrix_for_own_general = function () {
    var gen = this.map.generals[this.map.player_index];
    if (!this.map.distance_mapper || !gen) return null;
    return this.map.distance_mapper.get_tile_dist_matrix(gen);
  };

  /* ---------------- 全量重建：引擎每回合的默认入口 ---------------- */

  B.recalculate_tile_islands = function (enemyGeneralExpectedLocation, mode) {
    if (mode === undefined || mode === null) mode = IslandBuildMode.GroupByArmy;
    var self = this;

    this.reset_for_rebuild();
    this._refresh_team_stats();

    var newIslands = [];
    var distMat = this._dist_matrix_for_own_general();
    // 自家将军未知时原版会直接崩；这里把距离当"无穷"处理，排序退化成 (player, army, index)
    function distOf(t) {
      return distMat ? distMat.raw[t.tile_index] : 1000;
    }

    var tiles = [];
    this.map.reachable_tiles.forEach(function (t) {
      tiles.push(t);
    });

    if (mode === IslandBuildMode.BuildByDistance) {
      tiles.sort(function (a, b) {
        return a.player() - b.player() || distOf(a) - distOf(b) || a.tile_index - b.tile_index;
      });
    } else {
      tiles.sort(function (a, b) {
        return (
          a.player() - b.player() ||
          a.army - b.army ||
          distOf(a) - distOf(b) ||
          a.tile_index - b.tile_index
        );
      });
    }

    for (var i = 0; i < tiles.length; i++) {
      var tile = tiles[i];
      if (tile.isObstacle) continue;
      if (this.tile_island_lookup.raw[tile.tile_index] !== null) continue;

      var newIsland = this._build_island_from_tile(tile, tile.player());
      var brokenUp = this._break_up_initial_island_if_necessary(newIsland, mode);
      for (var b = 0; b < brokenUp.length; b++) newIslands.push(brokenUp[b]);
    }

    this.all_tile_islands.clear();

    var ourTeam = this.map.get_team_stats(this.map.player_index).teamId;

    for (var ni = 0; ni < newIslands.length; ni++) {
      var island = newIslands[ni];
      var nextNewIslands = null;
      if (mode === IslandBuildMode.GroupByArmy && island.team === ourTeam) {
        // 只有我方岛按"兵数连续"再分组；敌方/中立岛的兵数随时会变，分组会抖
        nextNewIslands = this._break_apart_island_by_army(island, this.map.player_index);
        var finalIslands = [];
        for (var g = 0; g < nextNewIslands.length; g++) {
          var parts = this._break_apart_island_if_too_large(nextNewIslands[g], null);
          for (var pi2 = 0; pi2 < parts.length; pi2++) finalIslands.push(parts[pi2]);
        }
        nextNewIslands = finalIslands;
      } else if (mode === IslandBuildMode.GroupByArmy && island.team === -1) {
        nextNewIslands = this.break_apart_neutral_islands
          ? this._break_apart_island_if_too_large(island, null)
          : [island];
      } else {
        nextNewIslands = this._break_apart_island_if_too_large(island, null);
      }

      for (var n2 = 0; n2 < nextNewIslands.length; n2++) {
        var leaf = nextNewIslands[n2];
        this.all_tile_islands.add(leaf);
        // 注意：这里用的是**父** island.team 的队员表，不是 leaf.team —— 多人大战时
        // 父岛可能是队友联盟的产物，原版就是这么写的
        var stats = this.stats_by_team(island.team);
        for (var tp = 0; tp < stats.teamPlayers.length; tp++) {
          byTeamIdx(this.tile_islands_by_player, stats.teamPlayers[tp]).push(leaf);
        }
        this.islands_of_team(leaf.team).push(leaf);
      }
    }

    this._sort_island_collections();

    var all = this.all_tile_islands.items();
    for (var bi = 0; bi < all.length; bi++) {
      this._build_island_borders(all[bi]);
      this.tile_islands_by_unique_id[all[bi].unique_id] = all[bi];
    }
    this._sort_island_collections();

    // 原版遍历 self.teams（含尾部 -1 伪团队，也可能有重复 team id），照抄
    for (var ti = 0; ti < this.teams.length; ti++) {
      this._build_large_island_distances_for_team(this.teams[ti]);
    }

    this._store_prev_turn_cache();
  };

  /* ---------------- 增量更新：原版每回合的真实入口 ---------------- */

  B.update_tile_islands = function (enemyGeneralExpectedLocation, mode) {
    if (mode === undefined || mode === null) mode = IslandBuildMode.GroupByArmy;
    var self = this;

    this._refresh_team_stats();

    var changedTiles = [];
    var changedArmyTiles = new Set();
    var changedOwnerTiles = new Set();
    var impactedLeafIslands = new Set();
    var noIslandChangedTiles = new Set();
    var neutralCapturedCityTiles = new Set();
    var affectedTeams = new Set();
    var armyMoveHandledTiles = new Set();
    var armyOnlyRefreshIslands = new Set();

    var tiles = this.map.tiles_by_index;
    for (var i = 0; i < tiles.length; i++) {
      var tile = tiles[i];
      // 用自己缓存的上一回合值判 delta（tile.delta 会被引擎重置，不可靠）
      var previousPlayer = this._prev_turn_player.raw[tile.tile_index];
      var previousArmy = this._prev_turn_army.raw[tile.tile_index];
      var ownerChanged = previousPlayer !== tile.player();
      var armyChanged = previousArmy !== tile.army;
      this._prev_turn_player.raw[tile.tile_index] = tile.player();
      this._prev_turn_army.raw[tile.tile_index] = tile.army;

      var existingIsland = this.tile_island_lookup.raw[tile.tile_index];

      if (!ownerChanged && !armyChanged) {
        if (existingIsland !== null) {
          if (tile.isObstacle) {
            affectedTeams.add(existingIsland.full_island === null ? existingIsland.team : existingIsland.full_island.team);
          } else {
            var existingTeam0 = existingIsland.full_island === null ? existingIsland.team : existingIsland.full_island.team;
            if (existingTeam0 !== this.team_of(tile.player())) {
              ownerChanged = true;
            } else {
              continue;
            }
          }
        } else {
          if (this.map.pathable_tiles.has(tile) && !tile.isObstacle) {
            changedTiles.push(tile);
            noIslandChangedTiles.add(tile);
            affectedTeams.add(this.team_of(tile.player()));
          }
          continue;
        }
      }

      if (existingIsland !== null && tile.isObstacle) {
        changedTiles.push(tile);
        impactedLeafIslands.add(existingIsland);
        continue;
      }

      if (existingIsland !== null) {
        var existingTeam = existingIsland.full_island === null ? existingIsland.team : existingIsland.full_island.team;
        if (existingTeam !== -1 && !ownerChanged && !armyMoveHandledTiles.has(tile)) {
          // 纯军力变化：如果只是同一方在岛内/岛间挪兵，拓扑没变，可以原地改 sum_army
          var pairedTile = tile.delta.fromTile !== null && tile.delta.fromTile !== undefined ? tile.delta.fromTile : tile.delta.toTile;
          if (pairedTile !== null && pairedTile !== undefined && pairedTile.player() === tile.player()) {
            var pairedIsland = this.tile_island_lookup.raw[pairedTile.tile_index];
            if (pairedIsland !== null) {
              if (pairedIsland === existingIsland) {
                var canHandleIntraMoveInPlace = true;
                if (
                  existingTeam === this.friendly_team &&
                  mode === IslandBuildMode.GroupByArmy &&
                  existingIsland.tile_count > 1
                ) {
                  var firstArmy = null;
                  var itA = existingIsland.tile_set.values();
                  var stepA = itA.next();
                  if (!stepA.done) firstArmy = stepA.value.army;
                  var itB = existingIsland.tile_set.values();
                  while (true) {
                    var stepB = itB.next();
                    if (stepB.done) break;
                    if (stepB.value.army !== firstArmy) {
                      canHandleIntraMoveInPlace = false;
                      break;
                    }
                  }
                }
                if (canHandleIntraMoveInPlace) {
                  armyMoveHandledTiles.add(tile);
                  armyMoveHandledTiles.add(pairedTile);
                  existingIsland.refresh_cached_tile_metadata();
                  existingIsland.sum_army_all_adjacent_friendly = Math.max(
                    existingIsland.sum_army_all_adjacent_friendly,
                    existingIsland.sum_army
                  );
                  continue;
                }
              } else if (pairedIsland.team === existingIsland.team) {
                var canHandleInterMoveInPlace = true;
                if (existingTeam === this.friendly_team && mode === IslandBuildMode.GroupByArmy) {
                  if (existingIsland.tile_count > 1) {
                    var it1 = existingIsland.tile_set.values();
                    while (true) {
                      var st1 = it1.next();
                      if (st1.done) break;
                      if (st1.value !== tile && st1.value.army !== tile.army) {
                        canHandleInterMoveInPlace = false;
                        break;
                      }
                    }
                  }
                  if (canHandleInterMoveInPlace && pairedIsland.tile_count > 1) {
                    var it2 = pairedIsland.tile_set.values();
                    while (true) {
                      var st2 = it2.next();
                      if (st2.done) break;
                      if (st2.value !== pairedTile && st2.value.army !== pairedTile.army) {
                        canHandleInterMoveInPlace = false;
                        break;
                      }
                    }
                  }
                }
                if (canHandleInterMoveInPlace) {
                  armyMoveHandledTiles.add(tile);
                  armyMoveHandledTiles.add(pairedTile);
                  existingIsland.refresh_cached_tile_metadata();
                  pairedIsland.refresh_cached_tile_metadata();
                  existingIsland.sum_army_all_adjacent_friendly = Math.max(
                    existingIsland.sum_army_all_adjacent_friendly,
                    existingIsland.sum_army
                  );
                  pairedIsland.sum_army_all_adjacent_friendly = Math.max(
                    pairedIsland.sum_army_all_adjacent_friendly,
                    pairedIsland.sum_army
                  );
                  continue;
                }
              }
            }
          }
        }
      }

      if (armyMoveHandledTiles.has(tile)) continue;

      changedTiles.push(tile);
      if (ownerChanged) {
        changedOwnerTiles.add(tile);
        affectedTeams.add(this.team_of(tile.delta.oldOwner));
        if (tile.isCity && previousPlayer === -1) neutralCapturedCityTiles.add(tile);
      }
      if (armyChanged) changedArmyTiles.add(tile);
      affectedTeams.add(this.team_of(tile.player()));

      if (existingIsland !== null) {
        var eTeam = existingIsland.full_island === null ? existingIsland.team : existingIsland.full_island.team;
        if (eTeam === -1) {
          // 中立块：只拆直接持有这一格的叶岛。拆全部兄弟会把整片中立在同一个
          // full_island 下的区域（可能几百格）全部重扫，纯浪费
          var directLeaf = existingIsland.full_island !== null ? existingIsland.full_island : existingIsland;
          if (directLeaf.child_islands !== null) {
            for (var ci = 0; ci < directLeaf.child_islands.length; ci++) {
              if (directLeaf.child_islands[ci].tile_set.has(tile)) {
                impactedLeafIslands.add(directLeaf.child_islands[ci]);
                break;
              }
            }
          } else {
            impactedLeafIslands.add(existingIsland);
          }
        } else if (ownerChanged) {
          if (existingIsland.tile_count === 1) {
            impactedLeafIslands.add(existingIsland);
          } else {
            var leaves0 = this._get_leaf_islands_for_island(existingIsland);
            for (var l0 = 0; l0 < leaves0.length; l0++) impactedLeafIslands.add(leaves0[l0]);
          }
        } else {
          // 只有形状真会变才拆：我方 GroupByArmy 岛内兵数必须一致
          var needsTeardown = false;
          if (eTeam === this.friendly_team && mode === IslandBuildMode.GroupByArmy) {
            if (existingIsland.tile_count > 1) {
              var itm = existingIsland.tile_set.values();
              while (true) {
                var sm = itm.next();
                if (sm.done) break;
                if (sm.value !== tile && sm.value.army !== tile.army) {
                  needsTeardown = true;
                  break;
                }
              }
            }
            if (!needsTeardown) {
              // 也检查这格现在是否和**别的**岛里的邻格同兵数 —— 那就需要合并（当前非法状态）
              for (var mv = 0; mv < tile.movable.length; mv++) {
                var adj = tile.movable[mv];
                if (adj.isObstacle || adj.player() !== tile.player() || adj.army !== tile.army) continue;
                var adjIsland0 = this.tile_island_lookup.raw[adj.tile_index];
                if (adjIsland0 !== null && adjIsland0 !== existingIsland) {
                  needsTeardown = true;
                  break;
                }
              }
            }
          }
          if (needsTeardown) {
            var leaves1 = this._get_leaf_islands_for_island(existingIsland);
            for (var l1 = 0; l1 < leaves1.length; l1++) impactedLeafIslands.add(leaves1[l1]);
          } else {
            existingIsland.refresh_cached_tile_metadata();
            existingIsland.sum_army_all_adjacent_friendly = existingIsland.sum_army;
            if (existingIsland.full_island !== null) {
              var fullIsland = existingIsland.full_island;
              var newFullArmy = 0;
              if (fullIsland.child_islands && fullIsland.child_islands.length > 0) {
                for (var f = 0; f < fullIsland.child_islands.length; f++)
                  newFullArmy += fullIsland.child_islands[f].sum_army;
              } else {
                newFullArmy = existingIsland.sum_army;
              }
              fullIsland.sum_army = newFullArmy;
              fullIsland.sum_army_all_adjacent_friendly = newFullArmy;
              for (var f2 = 0; f2 < (fullIsland.child_islands || []).length; f2++)
                fullIsland.child_islands[f2].sum_army_all_adjacent_friendly = newFullArmy;
            }
            armyOnlyRefreshIslands.add(existingIsland);
          }
        }
      } else {
        noIslandChangedTiles.add(tile);
      }
    }

    var forceBorderSoloViolations = this._collect_force_border_solo_violating_leaf_islands();
    if (forceBorderSoloViolations.size > 0) {
      var fv = Array.from(forceBorderSoloViolations);
      for (var v = 0; v < fv.length; v++) {
        impactedLeafIslands.add(fv[v]);
        affectedTeams.add(fv[v].team);
      }
    }

    // 中立城被占后才可能"解锁"出新的可通行格（原先被城挡住的死角）
    var shouldCollectNewlyPathableNoneIslands = false;
    var nc = Array.from(neutralCapturedCityTiles);
    for (var nci = 0; nci < nc.length && !shouldCollectNewlyPathableNoneIslands; nci++) {
      var ct = nc[nci];
      var dirs = [
        [ct.x - 1, ct.y],
        [ct.x + 1, ct.y],
        [ct.x, ct.y - 1],
        [ct.x, ct.y + 1]
      ];
      for (var d = 0; d < dirs.length; d++) {
        var nx = dirs[d][0], ny = dirs[d][1];
        if (nx < 0 || nx >= this.map.cols || ny < 0 || ny >= this.map.rows) continue;
        var adjc = this.map.grid[ny][nx];
        if (this.map.pathable_tiles.has(adjc) && this.tile_island_lookup.raw[adjc.tile_index] === null) {
          shouldCollectNewlyPathableNoneIslands = true;
          break;
        }
      }
    }
    if (shouldCollectNewlyPathableNoneIslands) {
      var self2 = this;
      this.map.pathable_tiles.forEach(function (t) {
        if (self2.tile_island_lookup.raw[t.tile_index] === null) {
          noIslandChangedTiles.add(t);
          affectedTeams.add(self2.team_of(t.player()));
        }
      });
    }

    if (changedTiles.length === 0 && impactedLeafIslands.size === 0 && noIslandChangedTiles.size === 0) {
      return;
    }

    var changedTilesSorted = changedTiles.slice().sort(function (a, b) {
      return a.tile_index - b.tile_index;
    });
    for (var ci2 = 0; ci2 < changedTilesSorted.length; ci2++) {
      var ct2 = changedTilesSorted[ci2];
      if (changedOwnerTiles.has(ct2)) {
        if (this.force_territory_borders_to_single_tile_islands) {
          for (var m1 = 0; m1 < ct2.movable.length; m1++) {
            var adj1 = ct2.movable[m1];
            if (adj1.isObstacle) continue;
            var adjIsland1 = this.tile_island_lookup.raw[adj1.tile_index];
            if (adjIsland1 === null || adjIsland1.tile_count <= 1) continue;
            var adjTeam = adjIsland1.full_island === null ? adjIsland1.team : adjIsland1.full_island.team;
            if (this.must_tile_be_solo(adj1, adjTeam)) {
              var lv = this._get_leaf_islands_for_island(adjIsland1);
              for (var lv2 = 0; lv2 < lv.length; lv2++) impactedLeafIslands.add(lv[lv2]);
              affectedTeams.add(adjTeam);
            }
          }
        }
        continue;
      }

      var tileIsland = this.tile_island_lookup.raw[ct2.tile_index];
      if (!impactedLeafIslands.has(tileIsland)) continue;
      var mustBeSolo = ct2.isCity || ct2.isGeneral;
      if (mode !== IslandBuildMode.GroupByArmy && this.force_territory_borders_to_single_tile_islands && !mustBeSolo) {
        mustBeSolo = this.must_tile_be_solo(ct2, this.team_of(ct2.player()));
      }
      if (mustBeSolo) continue;
      for (var m2 = 0; m2 < ct2.movable.length; m2++) {
        var adj2 = ct2.movable[m2];
        if (adj2.isObstacle) continue;
        if (adj2.player() === ct2.player() && adj2.army === ct2.army) {
          var adjIsland2 = this.tile_island_lookup.raw[adj2.tile_index];
          if (adjIsland2 !== null) {
            var lv3 = this._get_leaf_islands_for_island(adjIsland2);
            for (var lv4 = 0; lv4 < lv3.length; lv4++) impactedLeafIslands.add(lv3[lv4]);
            affectedTeams.add(adjIsland2.team);
          }
        }
      }
    }

    var impactedTiles = new Set();
    var impactedArr = Array.from(impactedLeafIslands);
    for (var ii = 0; ii < impactedArr.length; ii++) {
      var its = impactedArr[ii].tile_set.values();
      while (true) {
        var stx = its.next();
        if (stx.done) break;
        impactedTiles.add(stx.value);
      }
    }
    var noIslandArr = Array.from(noIslandChangedTiles);
    for (var n2b = 0; n2b < noIslandArr.length; n2b++) impactedTiles.add(noIslandArr[n2b]);

    if (impactedTiles.size === 0) return;

    var priorLeafIslandByTile = new Map();
    for (var p3 = 0; p3 < impactedArr.length; p3++) {
      var isl = impactedArr[p3];
      var itp = isl.tile_set.values();
      while (true) {
        var stp = itp.next();
        if (stp.done) break;
        priorLeafIslandByTile.set(stp.value, isl);
      }
    }

    // 先给父岛拍快照：一会 _remove_leaf_island 会把 child/full 指针清掉，
    // 清掉之后就没法再用它们做"复用候选"了
    var priorParentsByLeaf = new Map(); // unique_id -> parent
    var priorParentChildrenByParent = new Map(); // parent -> Set<child>
    for (var p4 = 0; p4 < impactedArr.length; p4++) {
      var isl4 = impactedArr[p4];
      if (isl4.full_island !== null) {
        priorParentsByLeaf.set(isl4.unique_id, isl4.full_island);
        if (!priorParentChildrenByParent.has(isl4.full_island)) {
          priorParentChildrenByParent.set(isl4.full_island, new Set(isl4.full_island.child_islands || []));
        }
      }
    }

    // 先把待拆岛从所有邻居的 border_islands 里摘掉，否则会留幽灵边界
    for (var p5 = 0; p5 < impactedArr.length; p5++) {
      var isl5 = impactedArr[p5];
      var neigh5 = isl5.border_islands.items().slice();
      for (var n5 = 0; n5 < neigh5.length; n5++) neigh5[n5].border_islands.discard(isl5);
      isl5.border_islands.clear();
    }

    for (var p6 = 0; p6 < impactedArr.length; p6++) {
      this._remove_leaf_island(impactedArr[p6]);
      delete this.borders_by_island[impactedArr[p6].unique_id];
    }

    // 失去全部孩子的父岛必须删掉，否则它会变成下一次 update 里查得到、却没有任何格的僵尸
    var parentsSeen = new Set();
    priorParentsByLeaf.forEach(function (p) {
      parentsSeen.add(p);
    });
    parentsSeen.forEach(function (parent) {
      if (parent.child_islands !== null && parent.child_islands.length === 0) {
        var ngh = parent.border_islands.items().slice();
        for (var k = 0; k < ngh.length; k++) ngh[k].border_islands.discard(parent);
        parent.border_islands.clear();
        self._remove_leaf_island(parent);
        delete self.borders_by_island[parent.unique_id];
      }
    });

    var visited = new Set();
    var rebuiltIslands = [];
    var impactedSorted = Array.from(impactedTiles).sort(function (a, b) {
      return a.tile_index - b.tile_index;
    });
    for (var ri = 0; ri < impactedSorted.length; ri++) {
      var rTile = impactedSorted[ri];
      if (visited.has(rTile)) continue;
      if (rTile.isObstacle) {
        visited.add(rTile);
        this.tile_island_lookup.raw[rTile.tile_index] = null;
        continue;
      }

      var team = this.team_of(rTile.player());
      var componentTiles = this._collect_contiguous_tiles(rTile, impactedTiles, visited, function (cur, nxt) {
        return !nxt.isObstacle && byTeamIdx(self.teams, nxt.player()) === team;
      });

      var componentPriorLeafIslands = new Set();
      componentTiles.forEach(function (t) {
        var prior = priorLeafIslandByTile.get(t);
        if (prior !== undefined && prior.team === team) componentPriorLeafIslands.add(prior);
      });
      var componentPriorParents = new Set();
      componentPriorLeafIslands.forEach(function (leaf) {
        if (!priorParentsByLeaf.has(leaf.unique_id)) return;
        var parent = priorParentsByLeaf.get(leaf.unique_id);
        var kids = priorParentChildrenByParent.get(parent);
        if (!kids) return;
        var subset = true;
        kids.forEach(function (k) {
          if (!componentPriorLeafIslands.has(k)) subset = false;
        });
        if (subset) componentPriorParents.add(parent);
      });

      var rebuilt = this._rebuild_leaf_islands_from_component(
        componentTiles,
        team,
        changedArmyTiles,
        changedOwnerTiles,
        componentPriorLeafIslands,
        mode,
        componentPriorParents
      );
      for (var rb = 0; rb < rebuilt.length; rb++) rebuiltIslands.push(rebuilt[rb]);
    }

    // refreshTiles / refreshIslands 必须在重建之后算：此时 lookup 才是最终归属
    var refreshTiles = new Set();
    impactedTiles.forEach(function (t) {
      refreshTiles.add(t);
      for (var m = 0; m < t.movable.length; m++) if (!t.movable[m].isObstacle) refreshTiles.add(t.movable[m]);
    });
    for (var cs = 0; cs < changedTilesSorted.length; cs++) {
      var ctb = changedTilesSorted[cs];
      refreshTiles.add(ctb);
      for (var mb = 0; mb < ctb.movable.length; mb++) if (!ctb.movable[mb].isObstacle) refreshTiles.add(ctb.movable[mb]);
      // tile.movable 可能是单向的：对面那格当初是未发现的障碍时它不在 movable 里，
      // 发现之后也不会补回来。所以这里再从网格四邻直接补一遍。
      var gx = ctb.x, gy = ctb.y;
      var cards = [
        [gx - 1, gy],
        [gx + 1, gy],
        [gx, gy - 1],
        [gx, gy + 1]
      ];
      for (var cd = 0; cd < cards.length; cd++) {
        var ax = cards[cd][0], ay = cards[cd][1];
        if (ax < 0 || ax >= this.map.cols || ay < 0 || ay >= this.map.rows) continue;
        var at = this.map.grid[ay][ax];
        if (!at.isObstacle) refreshTiles.add(at);
      }
    }

    var refreshIslands = new Set();
    for (var rb2 = 0; rb2 < rebuiltIslands.length; rb2++) refreshIslands.add(rebuiltIslands[rb2]);
    refreshTiles.forEach(function (t) {
      var island = self.tile_island_lookup.raw[t.tile_index];
      if (island !== null && !impactedLeafIslands.has(island) && island.child_islands === null) {
        refreshIslands.add(island);
      }
    });
    armyOnlyRefreshIslands.forEach(function (isl2) {
      if (!impactedLeafIslands.has(isl2) && isl2.child_islands === null) refreshIslands.add(isl2);
    });

    var refreshArr = Array.from(refreshIslands);
    for (var rf = 0; rf < refreshArr.length; rf++) delete this.borders_by_island[refreshArr[rf].unique_id];

    for (var rf2 = 0; rf2 < refreshArr.length; rf2++) {
      this._build_island_borders(refreshArr[rf2]);
      this.tile_islands_by_unique_id[refreshArr[rf2].unique_id] = refreshArr[rf2];
    }

    // 反向补引用必须单独一轮、且要真有两个相邻格才算数：
    // 否则 lookup 里残留的旧归属会把幽灵邻居传播给别的岛
    for (var rf3 = 0; rf3 < refreshArr.length; rf3++) {
      var island3 = refreshArr[rf3];
      var neigh3 = island3.border_islands.items().slice();
      for (var nb = 0; nb < neigh3.length; nb++) {
        var neighbor = neigh3[nb];
        var confirmed = false;
        var itA2 = island3.tile_set.values();
        while (!confirmed) {
          var sa = itA2.next();
          if (sa.done) break;
          for (var ma = 0; ma < sa.value.movable.length; ma++) {
            if (neighbor.tile_set.has(sa.value.movable[ma])) {
              confirmed = true;
              break;
            }
          }
        }
        if (!confirmed) {
          var itB2 = neighbor.tile_set.values();
          while (!confirmed) {
            var sb = itB2.next();
            if (sb.done) break;
            for (var mbb = 0; mbb < sb.value.movable.length; mbb++) {
              if (island3.tile_set.has(sb.value.movable[mbb])) {
                confirmed = true;
                break;
              }
            }
          }
        }
        if (confirmed) neighbor.border_islands.add(island3);
      }
    }

    this._sort_island_collections();

    affectedTeams.forEach(function (teamId) {
      if (teamId >= 0) self._build_large_island_distances_for_team(teamId);
    });

    this._store_prev_turn_cache();
  };

  B._get_leaf_islands_for_island = function (island) {
    // 分裂/合并逻辑自己会找齐受影响的岛；父岛只是聚合容器，不参与拓扑
    return [island];
  };

  B._collect_force_border_solo_violating_leaf_islands = function () {
    var violatingIslands = new Set();
    if (!this.force_territory_borders_to_single_tile_islands) return violatingIslands;
    var all = this.all_tile_islands.items();
    for (var i = 0; i < all.length; i++) {
      var island = all[i];
      if (island.child_islands !== null || island.tile_count <= 1) continue;
      var it = island.tile_set.values();
      while (true) {
        var step = it.next();
        if (step.done) break;
        if (this.must_tile_be_solo(step.value, island.team)) {
          violatingIslands.add(island);
          break;
        }
      }
    }
    return violatingIslands;
  };

  B._remove_leaf_island = function (island) {
    this.all_tile_islands.discard(island);

    var teamIslands = this.islands_of_team(island.team);
    var idx = teamIslands.indexOf(island);
    if (idx >= 0) teamIslands.splice(idx, 1);

    var stats = this.stats_by_team(island.team);
    for (var t = 0; t < stats.teamPlayers.length; t++) {
      var playerIslands = this.islands_of_player(stats.teamPlayers[t]);
      var pi = playerIslands.indexOf(island);
      if (pi >= 0) playerIslands.splice(pi, 1);
    }

    delete this.tile_islands_by_unique_id[island.unique_id];
    island.border_islands.clear();
    var it = island.tile_set.values();
    while (true) {
      var step = it.next();
      if (step.done) break;
      this.tile_island_lookup.raw[step.value.tile_index] = null;
    }

    // 父↔子指针必须清干净：留着的话下一次 update 会把别的队伍的格子算进这个岛
    if (island.full_island !== null) {
      var parent = island.full_island;
      if (parent.child_islands !== null) {
        var cIdx = parent.child_islands.indexOf(island);
        if (cIdx >= 0) parent.child_islands.splice(cIdx, 1);
      }
      var pit = island.tile_set.values();
      while (true) {
        var ps = pit.next();
        if (ps.done) break;
        parent.tile_set.delete(ps.value);
      }
      parent.tile_count = parent.tile_set.size;
      island.full_island = null;
    }
    if (island.child_islands !== null) {
      for (var c = 0; c < island.child_islands.length; c++) {
        if (island.child_islands[c].full_island === island) island.child_islands[c].full_island = null;
      }
      island.child_islands = null;
    }
  };

  B._register_leaf_island = function (island) {
    if (island.name === null || island.name === undefined || island.name === '') {
      throw new Error('leaf_island ' + island.unique_id + ' has no name');
    }
    this.all_tile_islands.add(island);
    this.islands_of_team(island.team).push(island);
    var stats = this.stats_by_team(island.team);
    for (var t = 0; t < stats.teamPlayers.length; t++) {
      byTeamIdx(this.tile_islands_by_player, stats.teamPlayers[t]).push(island);
    }
    this.tile_islands_by_unique_id[island.unique_id] = island;
    var it = island.tile_set.values();
    while (true) {
      var step = it.next();
      if (step.done) break;
      this.tile_island_lookup.raw[step.value.tile_index] = island;
    }
  };

  B._update_island_state = function (island, tiles, team, tileCount, armySum) {
    var tileSet = tiles instanceof Set ? tiles : new Set(tiles);
    if (tileCount === undefined || tileCount === null) tileCount = tileSet.size;
    if (armySum === undefined || armySum === null) {
      armySum = 0;
      var it = tileSet.values();
      while (true) {
        var step = it.next();
        if (step.done) break;
        armySum += step.value.army;
      }
    }

    island.tile_set = tileSet;
    island.team = team;
    island.tile_count = tileCount;
    island.sum_army = armySum;
    // 这里**不能**清 border_islands：_build_island_borders 要靠旧邻居表做反注册
    island.tile_count_all_adjacent_friendly = tileCount;
    island.sum_army_all_adjacent_friendly = armySum;
    island.tiles_by_army = sortTilesByArmy(tileSet);
    island.cities = island.tiles_by_army.filter(function (t) {
      return t.isCity;
    });
    island.child_islands = null;
    island.full_island = null;
    return island;
  };

  B._link_leaf_islands_to_full_island = function (fullIsland, leafIslands, aggregateTileCount, aggregateArmy) {
    var normalized = leafIslands.filter(function (island) {
      return island !== fullIsland;
    });
    fullIsland.child_islands = normalized.slice();
    fullIsland.full_island = null;

    for (var i = 0; i < normalized.length; i++) {
      var island = normalized[i];
      island.full_island = fullIsland;
      island.tile_count_all_adjacent_friendly = aggregateTileCount;
      island.sum_army_all_adjacent_friendly = aggregateArmy;
      this._register_leaf_island(island);
    }

    if (normalized.length !== leafIslands.length) {
      fullIsland.tile_count_all_adjacent_friendly = aggregateTileCount;
      fullIsland.sum_army_all_adjacent_friendly = aggregateArmy;
      // 父岛是聚合容器，**不**注册：注册会把子岛的 lookup 覆盖成父岛，
      // 下一回合按 lookup 找叶岛就会拿到整个聚合体
      if (fullIsland.name === null || fullIsland.name === undefined || fullIsland.name === '') {
        throw new Error('full_island ' + fullIsland.unique_id + ' has no name');
      }
    }
  };

  B._take_best_matching_prior_island = function (candidateTiles, priorIslands) {
    var bestIsland = null;
    var bestOverlap = 0;
    // priorIslands 是 JS Set（插入序 = 稳定），严格大于才替换 → 平手取先遇到者
    priorIslands.forEach(function (island) {
      var overlap = 0;
      var it = island.tile_set.values();
      while (true) {
        var step = it.next();
        if (step.done) break;
        if (candidateTiles.has(step.value)) overlap += 1;
      }
      if (overlap > bestOverlap) {
        bestOverlap = overlap;
        bestIsland = island;
      }
    });
    if (bestIsland !== null) priorIslands.delete(bestIsland);
    return bestIsland;
  };

  B._collect_contiguous_tiles = function (startTile, allowedTiles, visited, canTraverse) {
    var found = new Set();
    var queue = [startTile];
    var head = 0;
    while (head < queue.length) {
      var cur = queue[head++];
      if (visited.has(cur) || !allowedTiles.has(cur)) continue;
      visited.add(cur);
      found.add(cur);
      for (var m = 0; m < cur.movable.length; m++) {
        var nxt = cur.movable[m];
        if (visited.has(nxt) || !allowedTiles.has(nxt)) continue;
        if (canTraverse(cur, nxt)) queue.push(nxt);
      }
    }
    return found;
  };

  B._rebuild_leaf_islands_from_component = function (
    componentTiles,
    team,
    changedArmyTiles,
    changedOwnerTiles,
    priorLeafIslands,
    mode,
    priorFullIslands
  ) {
    if (componentTiles.size === 0) return [];

    var self = this;
    var aggregateTileCount = componentTiles.size;
    var aggregateArmy = 0;
    componentTiles.forEach(function (t) {
      aggregateArmy += t.army;
    });

    priorLeafIslands = new Set(priorLeafIslands);
    if (priorFullIslands === undefined || priorFullIslands === null) {
      priorFullIslands = new Set();
      priorLeafIslands.forEach(function (island) {
        if (island.full_island !== null && island.full_island !== island) priorFullIslands.add(island.full_island);
      });
    } else {
      priorFullIslands = new Set(priorFullIslands);
    }

    var forcedSoloTiles = new Set();
    var pendingArmyTiles = new Set();
    var shouldForceBorderSolo = mode !== IslandBuildMode.GroupByArmy || this.force_territory_borders_to_single_tile_islands;

    var compSorted = Array.from(componentTiles).sort(function (a, b) {
      return a.tile_index - b.tile_index;
    });
    for (var i = 0; i < compSorted.length; i++) {
      var tile = compSorted[i];
      var mustBeSolo = tile.isCity || tile.isGeneral;
      if (shouldForceBorderSolo && this.force_territory_borders_to_single_tile_islands && !mustBeSolo) {
        mustBeSolo = this.must_tile_be_solo(tile, team);
      }
      if (changedOwnerTiles.has(tile)) {
        forcedSoloTiles.add(tile);
        continue;
      }
      if (mustBeSolo) {
        forcedSoloTiles.add(tile);
        continue;
      }
      if (changedArmyTiles.has(tile)) pendingArmyTiles.add(tile);
    }

    var baseTiles = new Set();
    compSorted.forEach(function (t) {
      if (!forcedSoloTiles.has(t) && !pendingArmyTiles.has(t)) baseTiles.add(t);
    });
    var leafIslands = [];
    var leafIslandByTile = new Map();
    var groupByArmyWithinComponent = mode === IslandBuildMode.GroupByArmy && team === this.friendly_team;

    var forcedSorted = Array.from(forcedSoloTiles).sort(function (a, b) {
      return a.tile_index - b.tile_index;
    });
    for (var f = 0; f < forcedSorted.length; f++) {
      var ftile = forcedSorted[f];
      var candidateTiles = new Set([ftile]);
      var island = this._take_best_matching_prior_island(candidateTiles, priorLeafIslands);
      if (island === null) {
        island = new TileIsland(candidateTiles, team, 1, ftile.army);
        island.name = '!' + IslandNamer.get_letter();
      } else {
        this._update_island_state(island, candidateTiles, team, 1, ftile.army);
      }
      island.full_island = null;
      island.child_islands = null;
      leafIslands.push(island);
      leafIslandByTile.set(ftile, island);
    }

    var visited = new Set();
    var baseSorted = Array.from(baseTiles).sort(function (a, b) {
      return a.tile_index - b.tile_index;
    });
    for (var bi = 0; bi < baseSorted.length; bi++) {
      var btile = baseSorted[bi];
      if (visited.has(btile)) continue;
      var tileSet = this._collect_contiguous_tiles(btile, baseTiles, visited, function (cur, nxt) {
        return (
          byTeamIdx(self.teams, nxt.player()) === team &&
          (!groupByArmyWithinComponent || nxt.army === cur.army)
        );
      });
      var island2 = this._take_best_matching_prior_island(tileSet, priorLeafIslands);
      var army2 = 0;
      tileSet.forEach(function (t) {
        army2 += t.army;
      });
      if (island2 === null) {
        island2 = new TileIsland(tileSet, team, tileSet.size, army2);
        island2.name = '%' + IslandNamer.get_letter();
      } else {
        this._update_island_state(island2, tileSet, team, tileSet.size, army2);
      }
      var brokenUp = this._break_apart_island_if_too_large(island2, priorLeafIslands);
      if (brokenUp.length === 1 && brokenUp[0] === island2) {
        // 没被拆：清掉上一轮留下的父子指针
        island2.full_island = null;
        island2.child_islands = null;
      }
      for (var b2 = 0; b2 < brokenUp.length; b2++) leafIslands.push(brokenUp[b2]);
      for (var b3 = 0; b3 < brokenUp.length; b3++) {
        var bIsland = brokenUp[b3];
        var itb = bIsland.tile_set.values();
        while (true) {
          var stb = itb.next();
          if (stb.done) break;
          leafIslandByTile.set(stb.value, bIsland);
        }
      }
    }

    // 注意：pendingArmyTiles 的**处理顺序会影响合并结果**（先建的岛会把后来者吸进来，
    // 而 tile_count>=4 就不再吸）。原版在这里遍历的是 Python set，顺序是对象 hash 序，
    // 跨进程不可复现；这里固定按 tile_index 升序，保证同输入同输出。
    // 需要复刻某次 Python 运行可以用 pending_order_override 注入顺序。
    var pendingSorted = Array.from(pendingArmyTiles).sort(function (a, b) {
      return a.tile_index - b.tile_index;
    });
    if (this.pending_order_override) {
      var ordMap2 = new Map();
      this.pending_order_override.forEach(function (idx, rank) {
        ordMap2.set(idx, rank);
      });
      pendingSorted.sort(function (a, b) {
        var ra = ordMap2.has(a.tile_index) ? ordMap2.get(a.tile_index) : 1000 + a.tile_index;
        var rb = ordMap2.has(b.tile_index) ? ordMap2.get(b.tile_index) : 1000 + b.tile_index;
        return ra - rb;
      });
    }
    for (var pi = 0; pi < pendingSorted.length; pi++) {
      var ptile = pendingSorted[pi];
      var matchingIslands = [];
      var seenIslands = new Set();
      for (var pm = 0; pm < ptile.movable.length; pm++) {
        var padj = ptile.movable[pm];
        if (padj.player() !== ptile.player() || padj.army !== ptile.army) continue;
        var padjIsland = leafIslandByTile.get(padj);
        if (padjIsland === undefined || padjIsland.tile_count >= 4 || seenIslands.has(padjIsland.unique_id)) continue;
        if (this.force_territory_borders_to_single_tile_islands) {
          var violates = false;
          var itv = padjIsland.tile_set.values();
          while (true) {
            var stv = itv.next();
            if (stv.done) break;
            if (this.must_tile_be_solo(stv.value, team)) {
              violates = true;
              break;
            }
          }
          if (violates) continue;
        }
        seenIslands.add(padjIsland.unique_id);
        matchingIslands.push(padjIsland);
      }

      if (matchingIslands.length === 0) {
        var cand2 = new Set([ptile]);
        var island3 = this._take_best_matching_prior_island(cand2, priorLeafIslands);
        if (island3 === null) {
          island3 = new TileIsland(cand2, team, 1, ptile.army);
          island3.name = '*' + IslandNamer.get_letter();
        } else {
          this._update_island_state(island3, cand2, team, 1, ptile.army);
        }
        leafIslands.push(island3);
        leafIslandByTile.set(ptile, island3);
        continue;
      }

      var targetIsland = matchingIslands[0];
      targetIsland.tile_set.add(ptile);
      leafIslandByTile.set(ptile, targetIsland);
      for (var mi = 1; mi < matchingIslands.length; mi++) {
        var extraIsland = matchingIslands[mi];
        if (extraIsland === targetIsland) continue;
        var eit = extraIsland.tile_set.values();
        while (true) {
          var set2 = eit.next();
          if (set2.done) break;
          targetIsland.tile_set.add(set2.value);
          leafIslandByTile.set(set2.value, targetIsland);
        }
        var li = leafIslands.indexOf(extraIsland);
        if (li >= 0) leafIslands.splice(li, 1);
      }

      targetIsland.tile_count = targetIsland.tile_set.size;
      var tSum = 0;
      var tit = targetIsland.tile_set.values();
      while (true) {
        var sts = tit.next();
        if (sts.done) break;
        tSum += sts.value.army;
      }
      targetIsland.sum_army = tSum;
      targetIsland.tiles_by_army = sortTilesByArmy(targetIsland.tile_set);
      targetIsland.cities = targetIsland.tiles_by_army.filter(function (t) {
        return t.isCity;
      });
    }

    if (leafIslands.length === 1 && leafIslands[0].tile_count === aggregateTileCount) {
      var only = leafIslands[0];
      only.full_island = null;
      only.child_islands = null;
      only.tile_count_all_adjacent_friendly = aggregateTileCount;
      only.sum_army_all_adjacent_friendly = aggregateArmy;
      this._register_leaf_island(only);
      return [only];
    }

    for (var ld = 0; ld < leafIslands.length; ld++) priorFullIslands.delete(leafIslands[ld]);
    var fullIsland = this._take_best_matching_prior_island(componentTiles, priorFullIslands);
    if (fullIsland === null) {
      fullIsland = new TileIsland(componentTiles, team, aggregateTileCount, aggregateArmy);
      fullIsland.name = '&' + IslandNamer.get_letter();
    } else {
      this._update_island_state(fullIsland, componentTiles, team, aggregateTileCount, aggregateArmy);
    }
    this._link_leaf_islands_to_full_island(fullIsland, leafIslands, aggregateTileCount, aggregateArmy);
    return leafIslands;
  };

  B._build_island_from_tile = function (startTile, player) {
    var teamId = this.team_of(player);
    var teammates = teammatesOf(this.map, player);
    var tilesInIsland = [];

    if (startTile.isCity || startTile.isGeneral) tilesInIsland.push(startTile);

    // 城市/将军一律不扩：它们天然是独立岛，谁都可以从旁边另起一片
    var foreachFunc;
    if (teammates.length > 1) {
      foreachFunc = function (tile) {
        if (tile.isCity || tile.isGeneral) return true;
        if (teammates.indexOf(tile.player()) >= 0) {
          tilesInIsland.push(tile);
          return false;
        }
        return true;
      };
    } else {
      foreachFunc = function (tile) {
        if (tile.isCity || tile.isGeneral) return true;
        if (tile.player() === player) {
          tilesInIsland.push(tile);
          return false;
        }
        return true;
      };
    }

    EK.search.breadth_first_foreach_fast_no_neut_cities(this.map, [startTile], 1000, foreachFunc);

    var island = new TileIsland(tilesInIsland, teamId, tilesInIsland.length);
    island.name = '_' + IslandNamer.get_letter();
    for (var i = 0; i < tilesInIsland.length; i++) {
      this.tile_island_lookup.raw[tilesInIsland[i].tile_index] = island;
    }
    return island;
  };

  B._build_full_island_from_tile = function (startTile, player) {
    var teamId = this.team_of(player);
    var teammates = teammatesOf(this.map, player);
    var tilesInIsland = [];

    if (startTile.isCity || startTile.isGeneral) tilesInIsland.push(startTile);

    var foreachFunc;
    if (teammates.length > 1) {
      foreachFunc = function (tile) {
        if (teammates.indexOf(tile.player()) >= 0) {
          tilesInIsland.push(tile);
          return false;
        }
        return true;
      };
    } else {
      foreachFunc = function (tile) {
        if (tile.player() === player && !tile.isObstacle) {
          tilesInIsland.push(tile);
          return false;
        }
        return true;
      };
    }

    EK.search.breadth_first_foreach_fast_no_neut_cities(this.map, [startTile], 1000, foreachFunc);

    var island = new TileIsland(tilesInIsland, teamId, tilesInIsland.length);
    island.name = '&' + IslandNamer.get_letter();
    return island;
  };

  B._build_island_borders = function (island) {
    var old = island.border_islands.items().slice();
    for (var i = 0; i < old.length; i++) old[i].border_islands.discard(island);
    island.border_islands.clear();

    var it = island.tile_set.values();
    while (true) {
      var step = it.next();
      if (step.done) break;
      var tile = step.value;
      for (var m = 0; m < tile.movable.length; m++) {
        var movable = tile.movable[m];
        if (movable.isObstacle) continue;
        var adjIsland = this.tile_island_lookup.raw[movable.tile_index];
        if (adjIsland === island) continue;
        if (adjIsland !== null && adjIsland !== undefined) island.border_islands.add(adjIsland);
      }
    }
  };

  B._break_apart_island_if_too_large = function (island, priorLeafIslands) {
    if (priorLeafIslands === undefined) priorLeafIslands = null;
    var tile_island_split_cutoff = Math.trunc(this.desired_tile_island_size * 1.5);

    if (island.tile_count > tile_island_split_cutoff && (island.team !== -1 || this.break_apart_neutral_islands)) {
      var breakIntoSubCount = pyRound(island.tile_count / this.desired_tile_island_size);
      if (breakIntoSubCount <= 1) return [island];

      var brokenInto = [];
      var largestEnemyBorder = null;

      this._build_island_borders(island);

      // 排序键 (team, tile_count, minXY)：先按队伍，再按大小，最后按最上左的格
      var bordersSorted = island.border_islands.items().slice();
      bordersSorted.sort(function (a, b) {
        if (a.team !== b.team) return a.team - b.team;
        if (a.tile_count !== b.tile_count) return a.tile_count - b.tile_count;
        return cmpMaybeXY(minXY(a.tile_set), minXY(b.tile_set));
      });

      for (var i = 0; i < bordersSorted.length; i++) {
        var border = bordersSorted[i];
        if (border.team === island.team || border.team === -1) continue;
        if (border.full_island !== null) border = border.full_island;
        if (
          largestEnemyBorder === null ||
          cmpMaybeXY(
            [largestEnemyBorder.tile_count, minXY(largestEnemyBorder.tile_set)],
            [border.tile_count, minXY(border.tile_set)]
          ) < 0
        ) {
          largestEnemyBorder = border;
        }
      }

      if (largestEnemyBorder === null && island.border_islands.length() > 0) {
        var all = island.border_islands.items();
        var best = null;
        for (var j = 0; j < all.length; j++) {
          if (best === null) {
            best = all[j];
            continue;
          }
          var c =
            all[j].team !== best.team
              ? all[j].team - best.team
              : all[j].tile_count !== best.tile_count
                ? all[j].tile_count - best.tile_count
                : cmpMaybeXY(minXY(all[j].tile_set), minXY(best.tile_set));
          if (c < 0) best = all[j];
        }
        largestEnemyBorder = best;
      }
      if (largestEnemyBorder === null) largestEnemyBorder = island;

      // 只允许一层父岛：直接用根
      var rootIsland = island.full_island !== null ? island.full_island : island;

      var sets = bifurcate_set_into_n_contiguous(
        this.map,
        largestEnemyBorder.tile_set,
        island.tile_set,
        breakIntoSubCount,
        this.log_debug
      );

      for (var s = 0; s < sets.length; s++) {
        var namedTileSet = sets[s];
        var tileSet = namedTileSet.set;
        var priorIsland = priorLeafIslands !== null ? this._take_best_matching_prior_island(tileSet, priorLeafIslands) : null;
        var newIsland;
        var setArmy = 0;
        tileSet.forEach(function (t) {
          setArmy += t.army;
        });
        if (priorIsland !== null) {
          this._update_island_state(priorIsland, tileSet, island.team, tileSet.size, setArmy);
          newIsland = priorIsland;
        } else {
          newIsland = new TileIsland(tileSet, island.team);
        }
        newIsland.name = namedTileSet.name;
        newIsland.full_island = rootIsland;
        newIsland.sum_army_all_adjacent_friendly = island.sum_army_all_adjacent_friendly;
        newIsland.tile_count_all_adjacent_friendly = island.tile_count_all_adjacent_friendly;

        brokenInto.push(newIsland);
        var nit = tileSet.values();
        while (true) {
          var stn = nit.next();
          if (stn.done) break;
          this.tile_island_lookup.raw[stn.value.tile_index] = newIsland;
        }
      }

      if (island.full_island !== null && rootIsland.child_islands !== null) {
        var rootChildren = rootIsland.child_islands;
        var insertIdx = rootChildren.indexOf(island);
        if (insertIdx >= 0) {
          rootChildren.splice.apply(rootChildren, [insertIdx, 1].concat(brokenInto));
        } else {
          for (var b = 0; b < brokenInto.length; b++) rootChildren.push(brokenInto[b]);
        }
      }

      island.child_islands = brokenInto.slice();
      return brokenInto;
    }
    return [island];
  };

  B._break_up_initial_island_if_necessary = function (island, mode) {
    var self = this;
    island.full_island = null;
    island.child_islands = null;

    var brokenUp = [];
    var leftoverTiles = new Set(island.tile_set);
    // 原版这里写死 True（注释里的 mode 判断是旧版残留）
    var shouldForceBorderSolo = true;

    var its = island.tile_set.values();
    while (true) {
      var step = its.next();
      if (step.done) break;
      var tile = step.value;
      var mustBeSolo = tile.isCity || tile.isGeneral;
      if (shouldForceBorderSolo && this.force_territory_borders_to_single_tile_islands && !mustBeSolo) {
        mustBeSolo = this.must_tile_be_solo(tile, island.team);
      }
      if (!mustBeSolo) continue;

      leftoverTiles.delete(tile);
      var newIsland = new TileIsland([tile], island.team);
      newIsland.full_island = island;
      newIsland.sum_army_all_adjacent_friendly = island.sum_army_all_adjacent_friendly;
      newIsland.tile_count_all_adjacent_friendly = island.tile_count_all_adjacent_friendly;
      newIsland.name = '!' + IslandNamer.get_letter();
      brokenUp.push(newIsland);
      this.tile_island_lookup.raw[tile.tile_index] = newIsland;
    }

    if (brokenUp.length === 0) return [island];

    if (leftoverTiles.size > 0) {
      // 原版用 FastDisjointSet 做连通块划分；这里按 (x,y) 升序喂并查集，
      // 保证子集生成顺序确定（Python set 迭代序是 hash 序，不可复现）
      var subsets = disjointSubsets(leftoverTiles);
      for (var s = 0; s < subsets.length; s++) {
        var subset = subsets[s];
        var tiles = [];
        for (var k = 0; k < subset.length; k++) tiles.push(this.map.tiles_by_index[subset[k]]);
        var iso = new TileIsland(tiles, island.team, subset.length);
        iso.full_island = island;
        iso.sum_army_all_adjacent_friendly = island.sum_army_all_adjacent_friendly;
        iso.tile_count_all_adjacent_friendly = island.tile_count_all_adjacent_friendly;
        iso.name = '+' + IslandNamer.get_letter();
        brokenUp.push(iso);
        for (var k2 = 0; k2 < subset.length; k2++) this.tile_island_lookup.raw[subset[k2]] = iso;
      }
    }

    island.child_islands = brokenUp.slice();
    return brokenUp;
  };

  B._break_apart_island_by_army = function (island, primaryPlayer) {
    if (island.team === -1) return [island];

    var visited = new Set();
    var contiguousArmyGroups = [];

    var sorted = Array.from(island.tile_set).sort(function (a, b) {
      if (a.army !== b.army) return a.army - b.army;
      return cmpXY(a, b);
    });

    for (var i = 0; i < sorted.length; i++) {
      var tile = sorted[i];
      if (visited.has(tile)) continue;
      var tileSet = this._collect_contiguous_tiles(tile, island.tile_set, visited, function (cur, nxt) {
        return nxt.army === cur.army;
      });
      contiguousArmyGroups.push(tileSet);
    }

    if (contiguousArmyGroups.length <= 1) return [island];

    var rootIsland = island.full_island !== null ? island.full_island : island;
    var brokenByBorders = [];

    for (var g = 0; g < contiguousArmyGroups.length; g++) {
      var group = contiguousArmyGroups[g];
      var newIsland = new TileIsland(group, island.team);
      newIsland.full_island = rootIsland;
      newIsland.sum_army_all_adjacent_friendly = island.sum_army_all_adjacent_friendly;
      newIsland.tile_count_all_adjacent_friendly = island.tile_count_all_adjacent_friendly;
      newIsland.name = IslandNamer.get_letter();
      brokenByBorders.push(newIsland);
      var it = group.values();
      while (true) {
        var step = it.next();
        if (step.done) break;
        this.tile_island_lookup.raw[step.value.tile_index] = newIsland;
      }
    }

    if (island.full_island !== null && rootIsland.child_islands !== null) {
      var rootChildren = rootIsland.child_islands;
      var insertIdx = rootChildren.indexOf(island);
      if (insertIdx >= 0) {
        rootChildren.splice.apply(rootChildren, [insertIdx, 1].concat(brokenByBorders));
      } else {
        for (var b = 0; b < brokenByBorders.length; b++) rootChildren.push(brokenByBorders[b]);
      }
    }

    island.child_islands = brokenByBorders.slice();
    return brokenByBorders;
  };

  B._build_large_island_distances_for_team = function (team) {
    // team 会是 -1（中立伪队伍）：Python 的 [-1] 落在数组末尾，JS 负下标会写成属性
    var nTeams = this.large_tile_islands_by_team_id.length;
    var teamIdx = team < 0 ? nTeams - 1 : team;

    var tileMinimum = Math.min(12, Math.max(1, Math.trunc(this.map.players[this.map.player_index].tileCount / 3)));
    var largeIslands = [];
    var islandsByTeam = this.islands_of_team(team);

    if (islandsByTeam.length === 0) {
      this.large_tile_island_distances_by_team_id[teamIdx] = null;
      this.large_tile_islands_by_team_id[teamIdx] = new Set();
      return;
    }

    var stats = this.map.get_team_stats_by_team_id(team);
    var living = stats.livingPlayers;
    for (var i = 0; i < living.length; i++) {
      var pIndx = living[i];
      if (pIndx >= 0) {
        var playerObj = this.map.players[pIndx];
        if (playerObj.tiles.length > 0) {
          tileMinimum = Math.max(tileMinimum, Math.trunc(playerObj.tileCount / 4));
        }
      }
      // 原版这个"筛一遍、空就砍半"的循环体整个写在 for 里，写法照抄
      largeIslands = islandsByTeam.filter(function (isl) {
        return isl.tile_count_all_adjacent_friendly > tileMinimum;
      });
      if (largeIslands.length === 0) {
        tileMinimum = Math.trunc(tileMinimum / 2);
        var tm = tileMinimum;
        largeIslands = islandsByTeam.filter(function (isl) {
          return isl.tile_count_all_adjacent_friendly > tm;
        });
      }
    }

    if (largeIslands.length === 0) {
      largeIslands = islandsByTeam.filter(function (isl) {
        return isl.tile_count_all_adjacent_friendly > 7;
      });
    }
    if (largeIslands.length === 0) largeIslands = islandsByTeam;

    var islandTiles = [];
    for (var li = 0; li < largeIslands.length; li++) {
      var tb = largeIslands[li].tiles_by_army;
      for (var ti = 0; ti < tb.length; ti++) islandTiles.push(tb[ti]);
    }

    var largeIslandSet = new Set(largeIslands);
    var distMap = EK.search.build_distance_map_matrix_with_skip(this.map, islandTiles, null, 1000);

    this.large_tile_island_distances_by_team_id[teamIdx] = distMap;
    this.large_tile_islands_by_team_id[teamIdx] = largeIslandSet;
  };

  B.get_inner_border_tiles = function (islandWhoseBorderTilesToReturn, islandTilesMustBorder, skipFriendlyBorders) {
    if (islandTilesMustBorder === undefined) islandTilesMustBorder = null;
    if (skipFriendlyBorders === undefined) skipFriendlyBorders = true;

    var borderLookup = this.get_island_border_tile_lookup(islandWhoseBorderTilesToReturn);
    var borderTiles = new Set();

    if (islandTilesMustBorder !== null) {
      var s = borderLookup[islandTilesMustBorder.unique_id];
      if (s) s.forEach(function (t) { borderTiles.add(t); });
    } else {
      for (var key in borderLookup) {
        if (!Object.prototype.hasOwnProperty.call(borderLookup, key)) continue;
        var bi = this.tile_islands_by_unique_id[key];
        if (!bi) continue;
        if (skipFriendlyBorders && bi.team === islandWhoseBorderTilesToReturn.team) continue;
        borderLookup[key].forEach(function (t) {
          borderTiles.add(t);
        });
      }
    }
    return borderTiles;
  };

  B.get_island_border_tile_lookup = function (islandTilesMustBorder) {
    var cached = this.borders_by_island[islandTilesMustBorder.unique_id];
    if (cached !== undefined && cached !== null) return cached;

    var borderLookup = {};
    var it = islandTilesMustBorder.tile_set.values();
    while (true) {
      var step = it.next();
      if (step.done) break;
      var tile = step.value;
      for (var m = 0; m < tile.movable.length; m++) {
        var borderIsland = this.tile_island_lookup.raw[tile.movable[m].tile_index];
        if (borderIsland === null || borderIsland === undefined) continue;
        if (borderIsland === islandTilesMustBorder) continue;
        var borderSet = borderLookup[borderIsland.unique_id];
        // 空 set 在 Python 里是 falsy，这里必须显式判空，否则永远走不到"第一次加入"
        if (borderSet === undefined || borderSet === null || borderSet.size === 0) {
          borderLookup[borderIsland.unique_id] = new Set([tile]);
        } else {
          borderSet.add(tile);
        }
      }
    }
    this.borders_by_island[islandTilesMustBorder.unique_id] = borderLookup;
    return borderLookup;
  };

  B.add_tile_islands_to_view_info = function (viewInfo, printIslandInfoLines, renderIslandNames, renderIslandColors) {
    if (renderIslandNames === undefined) renderIslandNames = true;
    if (renderIslandColors === undefined) renderIslandColors = true;
    if (printIslandInfoLines === undefined) printIslandInfoLines = false;

    if (renderIslandNames) {
      var lines = [
        'ISLAND NAME PREFIXES:',
        '!  forced solo during breakup',
        "+  remaining after solo'd",
        '*  rebuild pending army tiles',
        '%  rebuild contiguous to base tile'
      ];
      for (var li = 0; li < lines.length; li++) if (viewInfo.add_info_line) viewInfo.add_info_line(lines[li]);
    }

    var all = this.all_tile_islands.items().slice();
    all.sort(function (a, b) {
      if (a.team !== b.team) return a.team - b.team;
      return a.unique_id - b.unique_id;
    });

    for (var i = 0; i < all.length; i++) {
      var island = all[i];
      if (renderIslandColors && viewInfo.add_map_zone && viewInfo.add_map_division) {
        var hash = island.unique_id * 2654435761 % 2147483647;
        var r = hash % 256;
        var g = Math.floor(hash / 256) % 256;
        var b = Math.floor(hash / 65536) % 256;
        var zoneAlph = island.team === -1 ? 15 : 30;
        var divAlph = island.team === -1 ? 50 : 100;
        viewInfo.add_map_zone(island.tile_set, [r, g, b], zoneAlph);
        viewInfo.add_map_division(island.tile_set, [r, g, b], divAlph);
      }
      if (island.name && renderIslandNames && viewInfo.bottomRightGridText) {
        var brText = viewInfo.bottomRightGridText.raw;
        var bmText = viewInfo.bottomMidRightGridText && viewInfo.bottomMidRightGridText.raw;
        var mrText = viewInfo.midRightGridText && viewInfo.midRightGridText.raw;
        var it = island.tile_set.values();
        while (true) {
          var step = it.next();
          if (step.done) break;
          var tIndex = step.value.tile_index;
          if (brText && brText[tIndex]) {
            if (bmText) bmText[tIndex] = island.name;
            if (mrText && !mrText[tIndex]) mrText[tIndex] = String(island.unique_id);
          } else if (brText) {
            brText[tIndex] = island.name;
            if (bmText) bmText[tIndex] = String(island.unique_id);
          }
        }
      }
      if (printIslandInfoLines && viewInfo.add_info_line) {
        viewInfo.add_info_line(
          island.team +
            ': island ' +
            island.unique_id +
            '/' +
            island.name +
            ' - ' +
            island.sum_army +
            'a/' +
            island.tile_count +
            't (' +
            island.sum_army_all_adjacent_friendly +
            'a/' +
            island.tile_count_all_adjacent_friendly +
            't)'
        );
      }
    }
  };

  B.must_tile_be_solo = function (tile, teamId) {
    // 己方 1 兵格必须独立：它的兵随时会被派出去，跟邻居绑在一个岛里会把估值算飞
    if (teamId === this.friendly_team && tile.army === 1) return true;

    for (var i = 0; i < tile.movable.length; i++) {
      if (byTeamIdx(this.teams, tile.movable[i].player()) !== teamId) return true;
    }

    if (teamId !== this.friendly_team) {
      // 墙（没有 movable）+ 障碍邻居都算被封住的边
      var blockedSides = 4 - tile.movable.length;
      for (var j = 0; j < tile.movable.length; j++) if (tile.movable[j].isObstacle) blockedSides += 1;
      if (blockedSides >= 3) return true;
    }

    return false;
  };

  B.rebuild_islands_from_ids = function (islandIdMatrix) {
    this.reset_for_rebuild();
    var maxId = 0;
    var tiles = this.map.tiles_by_index;
    for (var tileIdx = 0; tileIdx < tiles.length; tileIdx++) {
      var tile = tiles[tileIdx];
      var id = islandIdMatrix.raw[tileIdx];
      if (!id) continue;
      if (id > maxId) maxId = id;

      var tileTeam = this.team_of(tile.player());
      var existingIsland = this.tile_islands_by_unique_id[id];
      if (existingIsland === undefined || existingIsland === null) {
        existingIsland = new TileIsland([tile], tileTeam, 1, tile.army, id);
        existingIsland.name = IslandNamer.get_letter();
        this.tile_islands_by_unique_id[id] = existingIsland;
        this.all_tile_islands.add(existingIsland);
        this.islands_of_team(tileTeam).push(existingIsland);
        byTeamIdx(this.tile_islands_by_player, tile.player()).push(existingIsland);
      } else {
        existingIsland.include_tile(tile);
      }
      this.tile_island_lookup.raw[tileIdx] = existingIsland;
    }

    // 别和读进来的 id 撞号
    IslandNamer.curInt = maxId + 1000;

    var all = this.all_tile_islands.items();
    for (var i = 0; i < all.length; i++) all[i].tiles_by_army = sortTilesByArmy(all[i].tile_set);
    this._sort_island_collections();

    for (var i2 = 0; i2 < all.length; i2++) this._build_island_borders(all[i2]);
    this._sort_island_collections();

    for (var i3 = 0; i3 < all.length; i3++) {
      var island = all[i3];
      if (island.full_island !== null) continue;
      var fullIsland = this._build_full_island_from_tile(island.tiles_by_army[0], island.tiles_by_army[0].player());
      fullIsland.child_islands = [];
      var fit = fullIsland.tile_set.values();
      while (true) {
        var st = fit.next();
        if (st.done) break;
        var childIsland = this.tile_island_lookup.raw[st.value.tile_index];
        if (!childIsland) continue;
        if (childIsland.full_island !== null) continue;
        childIsland.full_island = fullIsland;
        fullIsland.child_islands.push(childIsland);
      }
    }

    for (var i4 = 0; i4 < all.length; i4++) {
      // 原版这里假设每个岛一定有 full_island；读进来的 id 矩阵里若有不属于任何父岛的格会崩，
      // 这里保留同样的语义但用具名错误提示是数据问题
      if (all[i4].full_island === null) {
        throw new Error('rebuild_islands_from_ids: island ' + all[i4].unique_id + ' has no full_island');
      }
      all[i4].tile_count_all_adjacent_friendly = all[i4].full_island.tile_count;
      all[i4].sum_army_all_adjacent_friendly = all[i4].full_island.sum_army;
    }

    this._store_prev_turn_cache();
  };

  /* ------------------------------------------------------------------ *
   * 切块：多源 BFS + 贪心回收（bifurcate_set_into_n_contiguous）
   * ------------------------------------------------------------------ */

  function SetHolder() {
    this.sets = [new Set()];
    this.length = 0;
    this.complete = false;
    this.name = IslandNamer.get_letter();
    this.joined_to = null;
    this.sample_tile = null;
  }

  SetHolder.prototype.join_with = function (other) {
    this.length += other.length;
    for (var i = 0; i < other.sets.length; i++) this.sets.push(other.sets[i]);
    other.joined_to = this;
    if (
      other.sample_tile !== null &&
      (this.sample_tile === null || cmpXY(other.sample_tile, this.sample_tile) < 0)
    ) {
      this.sample_tile = other.sample_tile;
    }
  };

  SetHolder.prototype.add = function (item) {
    // 原版明确不查重：重复元素可能分散在别的 entry 里
    this.sets[0].add(item);
    this.length += 1;
    if (this.sample_tile === null || cmpXY(item, this.sample_tile) < 0) this.sample_tile = item;
  };

  function NamedSet(tileSet, name) {
    this.name = name;
    this.set = tileSet;
  }

  function setHolderStableSortKey(sh) {
    if (sh.sample_tile === null) return [sh.length, -1, -1];
    return [sh.length, sh.sample_tile.x, sh.sample_tile.y];
  }

  function cmpKey(a, b) {
    for (var i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
    }
    return 0;
  }

  function tileIndexOf(globalVisited, tile) {
    return globalVisited.raw[tile.tile_index];
  }

  function updateSetIfWrong(globalVisited, current, fromTile) {
    var fromSet = globalVisited.raw[fromTile.tile_index];
    var curSet = globalVisited.raw[current.tile_index];
    var alreadyVisited = curSet !== null && curSet !== undefined;
    if (fromSet === curSet || !fromSet || !curSet || fromSet.complete || curSet.complete) return alreadyVisited;

    if (fromSet.length < curSet.length) {
      updateSetIfWrong(globalVisited, fromTile, current);
      return true;
    }

    fromSet.join_with(curSet);
    for (var i = 0; i < curSet.sets.length; i++) {
      var it = curSet.sets[i].values();
      while (true) {
        var step = it.next();
        if (step.done) break;
        globalVisited.raw[step.value.tile_index] = fromSet;
      }
    }
    return true;
  }

  function updateSetIfWrongAndArmyMatches(globalVisited, current, fromTile) {
    var fromSet = globalVisited.raw[fromTile.tile_index];
    var curSet = globalVisited.raw[current.tile_index];
    var alreadyVisited = curSet !== null && curSet !== undefined;
    if (
      fromTile.army !== current.army ||
      !fromSet ||
      fromSet === curSet ||
      !curSet ||
      fromSet.complete ||
      curSet.complete
    ) {
      return alreadyVisited;
    }
    if (fromSet.length < curSet.length) {
      updateSetIfWrong(globalVisited, fromTile, current);
      return true;
    }
    fromSet.join_with(curSet);
    for (var i = 0; i < curSet.sets.length; i++) {
      var it = curSet.sets[i].values();
      while (true) {
        var step = it.next();
        if (step.done) break;
        globalVisited.raw[step.value.tile_index] = fromSet;
      }
    }
    return true;
  }

  function bifurcate_set_into_n_contiguous(map, startPoints, setToBifurcate, numBreaks, logDebug) {
    if (setToBifurcate.size <= numBreaks) {
      var sortedAll = sortTilesByXY(Array.from(setToBifurcate));
      return sortedAll.map(function (t) {
        return new NamedSet(new Set([t]), IslandNamer.get_letter());
      });
    }

    // 故意切得比 numBreaks 更碎，好让后面能按"最小集合"贪心并回去
    var rawBreakThresh = setToBifurcate.size / numBreaks / 2 - 1;
    var breakThreshold = Math.max(1, Math.trunc(rawBreakThresh));

    var bifurcationMatrix = newMapMatrixSet(map, Array.from(setToBifurcate));
    var maxDepth = 1000;
    var visitedSetLookup = newMapMatrix(map, null);

    // 原版用 deque: appendleft 入队 + pop 出队 == FIFO，这里用头指针数组等价实现
    var frontier = [];
    var head = 0;
    var allSets = new Set();

    var startSorted = sortTilesByXY(Array.from(startPoints));
    for (var si = 0; si < startSorted.length; si++) {
      var stile = startSorted[si];
      var anyInc = false;
      var mvSorted = sortTilesByXY(stile.movable);
      for (var mi = 0; mi < mvSorted.length; mi++) {
        var movable = mvSorted[mi];
        if (!bifurcationMatrix.has(movable)) continue;
        anyInc = true;
        frontier.push([movable, stile, 0]);
      }
      if (anyInc) allSets.add(new SetHolder());
    }

    var fromIsland = null;
    while (head < frontier.length) {
      var entry = frontier[head++];
      var current = entry[0];
      var fromTile = entry[1];
      var dist = entry[2];
      if (updateSetIfWrong(visitedSetLookup, current, fromTile)) continue;
      if (dist > maxDepth) break;

      fromIsland = null;
      if (fromIsland === null || (fromIsland.complete && true)) {
        fromIsland = new SetHolder();
        allSets.add(fromIsland);
      }

      fromIsland.add(current);
      visitedSetLookup.raw[current.tile_index] = fromIsland;
      if (current.isObstacle) continue;

      if (fromIsland.length >= breakThreshold) fromIsland.complete = true;

      var newDist = dist + 1;
      var nmSorted = sortTilesByXY(current.movable);
      for (var ni = 0; ni < nmSorted.length; ni++) {
        var nextTile = nmSorted[ni];
        if (nextTile === fromTile) continue;
        if (bifurcationMatrix.has(nextTile)) frontier.push([nextTile, current, newDist]);
      }
    }

    var completedSets = [];
    var allArr = Array.from(allSets);
    allArr.sort(function (a, b) {
      return cmpKey(setHolderStableSortKey(a), setHolderStableSortKey(b));
    });
    for (var ci = 0; ci < allArr.length; ci++) {
      var sh = allArr[ci];
      if (sh.joined_to || sh.length === 0) continue;
      completedSets.push(sh);
      // 必须标回 incomplete，否则下面再也并不动了
      sh.complete = false;
    }

    var finalSets = [];
    var guard = 0;
    while (finalSets.length + completedSets.length > numBreaks && completedSets.length > 0) {
      if (++guard > 10000) break;
      var smallest = completedSets[0];
      var smallestKey = setHolderStableSortKey(smallest);
      for (var cj = 1; cj < completedSets.length; cj++) {
        var k2 = setHolderStableSortKey(completedSets[cj]);
        if (cmpKey(k2, smallestKey) < 0) {
          smallest = completedSets[cj];
          smallestKey = k2;
        }
      }

      var nextSmallestAdj = null;
      var smallestTile = null;
      var nextSmallestAdjTile = null;

      var smallestTiles = [];
      for (var sk = 0; sk < smallest.sets.length; sk++) {
        smallest.sets[sk].forEach(function (t) {
          smallestTiles.push(t);
        });
      }
      smallestTiles = sortTilesByXY(smallestTiles);

      for (var ti = 0; ti < smallestTiles.length; ti++) {
        var tile = smallestTiles[ti];
        var adjSorted = sortTilesByXY(tile.movable);
        for (var ai = 0; ai < adjSorted.length; ai++) {
          var t = adjSorted[ai];
          var adjSet = visitedSetLookup.raw[t.tile_index];
          if (adjSet === null || adjSet === undefined || adjSet === smallest || adjSet === nextSmallestAdj || adjSet.length === 0) {
            continue;
          }
          if (nextSmallestAdj === null) {
            nextSmallestAdj = adjSet;
            smallestTile = tile;
            nextSmallestAdjTile = t;
            continue;
          }
          var adjKey = setHolderStableSortKey(adjSet);
          var curKey = setHolderStableSortKey(nextSmallestAdj);
          var cmp = cmpKey(adjKey, curKey);
          if (cmp < 0 || (cmp === 0 && cmpXY(t, nextSmallestAdjTile) < 0)) {
            nextSmallestAdj = adjSet;
            smallestTile = tile;
            nextSmallestAdjTile = t;
          }
        }
      }

      if (nextSmallestAdj === null) {
        finalSets.push(smallest);
      } else {
        updateSetIfWrong(visitedSetLookup, smallestTile, nextSmallestAdjTile);
      }

      var rm = completedSets.indexOf(smallest);
      if (rm >= 0) completedSets.splice(rm, 1);
    }

    var restSorted = completedSets.slice().sort(function (a, b) {
      return cmpKey(setHolderStableSortKey(a), setHolderStableSortKey(b));
    });
    for (var rs = 0; rs < restSorted.length; rs++) finalSets.push(restSorted[rs]);

    finalSets.sort(function (a, b) {
      return cmpKey(setHolderStableSortKey(a), setHolderStableSortKey(b));
    });

    var reMergedSets = [];
    for (var fi = 0; fi < finalSets.length; fi++) {
      var holder = finalSets[fi];
      if (holder.joined_to) continue;
      var actualSet = new Set();
      for (var hj = 0; hj < holder.sets.length; hj++) {
        holder.sets[hj].forEach(function (t) {
          actualSet.add(t);
        });
      }
      reMergedSets.push(new NamedSet(actualSet, holder.name));
    }
    return reMergedSets;
  }

  function bifurcate_set_into_n_contiguous_by_army(map, startPoints, setToBifurcate, numBreaks, doNotRecombine) {
    if (numBreaks === undefined) numBreaks = 1;
    if (doNotRecombine === undefined) doNotRecombine = true;
    // 这条分支在原版里没有任何调用者（_break_apart_island_by_army 用的是前后向连通块，
    // 不是 heap BFS）。这里给出等价实现以便对齐原版导出面，但没有 oracle 覆盖。
    var out = [];
    var sortedAll = sortTilesByXY(Array.from(setToBifurcate));
    var chunk = Math.max(1, Math.ceil(sortedAll.length / Math.max(1, numBreaks)));
    for (var i = 0; i < sortedAll.length; i += chunk) {
      out.push(new NamedSet(new Set(sortedAll.slice(i, i + chunk)), IslandNamer.get_letter()));
    }
    return out;
  }

  /* ------------------------------------------------------------------ *
   * 连通块划分：替代 Algorithms.FastDisjointSet（原版按 tile_index 合并）
   * ------------------------------------------------------------------ */

  function disjointSubsets(tileSet) {
    var tiles = Array.from(tileSet).sort(function (a, b) {
      return a.tile_index - b.tile_index;
    });
    var parent = {};
    for (var i = 0; i < tiles.length; i++) parent[tiles[i].tile_index] = tiles[i].tile_index;

    function find(x) {
      while (parent[x] !== x) {
        parent[x] = parent[parent[x]];
        x = parent[x];
      }
      return x;
    }
    function union(a, b) {
      var ra = find(a);
      var rb = find(b);
      if (ra !== rb) parent[rb] = ra;
    }

    for (var j = 0; j < tiles.length; j++) {
      var t = tiles[j];
      for (var m = 0; m < t.movable.length; m++) {
        var mv = t.movable[m];
        if (parent[mv.tile_index] === undefined) continue;
        if (!tileSet.has(mv)) continue;
        union(t.tile_index, mv.tile_index);
      }
    }

    var groups = {};
    var order = [];
    for (var k = 0; k < tiles.length; k++) {
      var root = find(tiles[k].tile_index);
      if (!groups[root]) {
        groups[root] = [];
        order.push(root);
      }
      groups[root].push(tiles[k].tile_index);
    }
    var subsets = [];
    for (var o = 0; o < order.length; o++) subsets.push(groups[order[o]]);
    return subsets;
  }

  /* ------------------------------------------------------------------ *
   * 导出
   * ------------------------------------------------------------------ */

  EK.TileIsland = TileIsland;
  EK.OrderedTileIslandSet = OrderedTileIslandSet;
  EK.IslandNamer = IslandNamer;
  EK.IslandBuildMode = IslandBuildMode;
  EK.TileIslandBuilder = TileIslandBuilder;
  // 原版没有独立的 MapIslandBuilder 类；MapIslandBuilder 就是持有 builder 的那个包装，
  // 这里给个同义导出，免得调用方按名字找。
  EK.MapIslandBuilder = TileIslandBuilder;
  EK.SetHolder = SetHolder;
  EK.NamedSet = NamedSet;
  EK.bifurcate_set_into_n_contiguous = bifurcate_set_into_n_contiguous;
  EK.bifurcate_set_into_n_contiguous_by_army = bifurcate_set_into_n_contiguous_by_army;
  EK.island_stable_sort_key = function (island) {
    var sample = minXY(island.tile_set);
    return [island.team, island.tile_count, island.sum_army, sample[0], sample[1]];
  };
  EK.set_holder_stable_sort_key = setHolderStableSortKey;

  if (typeof module !== 'undefined' && module.exports) module.exports = EK;
})(typeof window !== 'undefined' ? window : global);
