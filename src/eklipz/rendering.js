/*
 * BotRendering / ViewInfo 移植
 *   原版：E:\akcoco6de\_research\generals-bot-cs\BotModules\BotRendering.py（507 行）
 *         E:\akcoco6de\_research\generals-bot-cs\ViewInfo.py（335 行）
 *
 * 这里的代码**不参与决策**，但它有两个不能省的作用：
 *   1. 调用点保真。原版在决策路径上顺手往 viewInfo 里写调试信息（板分析分区、威胁、
 *      路径、每格小字），这些写操作夹在真正的状态更新之间。如果 JS 侧没有这些方法，
 *      调用点要么得逐处删掉（改动决策代码）、要么会抛异常。所以保留同名方法、参数、
 *      默认值，只是把"上屏"退化成"记在内存里"。
 *   2. dump。dump_turn_data_to_string 是原版的可复现性抓手（resume / 单测都靠它），
 *      保留它可以对比一整局的 bot 状态，而不只是逐格地图状态。
 *
 * 内存纪律（用户明确要求过）：
 *   ViewInfo 是每回合重建/清理的对象，但原版的 infoLines / arrows / targetedTiles /
 *   paths 只在 clear_for_next_turn 里清空；离线环境下如果没人调用清理、或者某个回合
 *   里疯狂 add_info_line，就会无界增长。这里所有"只给人看"的列表统一走环：
 *   超过 VIEW_INFO_LIST_CAP 条就丢最旧的。真正的数字字段（地图文本矩阵）是定长数组，
 *   不增长。ViewInfo 里不保存跨回合的静态缓存，避免把上一局的 map 拽住不放。
 *
 * 与 Python 的差异（都是收口，不改语义）：
 *   1. Python 用 MapMatrix 支撑每格文本矩阵（重载了 []），JS 的 MapMatrix 只有 .raw /
 *      set / get，所以内部统一走 _gridSet / _gridGet。
 *   2. `tile.player` 是属性 vs 方法：本文件里凡是要玩家号都走 _playerOf。
 *   3. BotSerialization 未移植，dump 里的集合/矩阵序列化在本地按原格式（'1'/'0' 串、
 *      ','.join(f'{v:.2f}') 等）重写；格式一致，函数名不同。
 *   4. BotRendering.render_flow_expand_in_view_info 依赖 ArmyFlowExpander（未移植）：
 *      保留签名，内部全部守卫，没数据就直接返回。
 */
(function (root) {
  'use strict';

  var EK = (root.__EK = root.__EK || {});

  // 只影响"给人看"的列表；决策不读这些，丢最旧不会改变任何选择。
  var VIEW_INFO_LIST_CAP = 200;

  var PLAYER_CHARS = 'ABCDEFGHIJKLMNOP';

  // ---- 小工具 ------------------------------------------------------------

  function _pushRing(list, item, cap) {
    list.push(item);
    if (list.length > cap) {
      // 一次删一批，避免每条都 shift（大数组 shift 是 O(n)）。
      list.splice(0, list.length - cap);
    }
  }

  function _playerOf(tile) {
    if (tile === null || tile === undefined) return -1;
    if (typeof tile.player === 'function') return tile.player();
    return tile.player === undefined ? -1 : tile.player;
  }

  function _isSetLike(m) {
    return !!(m && typeof m.has === 'function');
  }

  function _contains(container, tile) {
    if (!container) return false;
    if (Array.isArray(container)) return container.indexOf(tile) >= 0;
    if (typeof container.has === 'function') return container.has(tile);
    if (typeof container.indexOf === 'function') return container.indexOf(tile) >= 0;
    if (container.raw && Array.isArray(container.raw)) return !!container.raw[tile.tile_index];
    return false;
  }

  function _getMat(map, init) {
    if (EK.MapMatrix) return new EK.MapMatrix(map, init);
    // 退化实现：只保证 .raw / get / set，够 ViewInfo 自己用。
    var cols = map ? map.cols : 0;
    var rows = map ? map.rows : 0;
    var raw = new Array(cols * rows);
    for (var i = 0; i < raw.length; i++) raw[i] = init;
    return {
      raw: raw,
      get: function (t) { return raw[t.tile_index]; },
      set: function (t, v) { raw[t.tile_index] = v; },
      has: function (t) { return raw[t.tile_index] !== undefined && raw[t.tile_index] !== init; }
    };
  }

  function _gridGet(grid, tile) {
    if (!grid) return null;
    if (typeof grid.get === 'function') return grid.get(tile);
    return grid.raw ? grid.raw[tile.tile_index] : null;
  }

  function _gridSet(grid, tile, value) {
    if (!grid) return;
    if (typeof grid.set === 'function') {
      grid.set(tile, value);
      return;
    }
    if (grid.raw) grid.raw[tile.tile_index] = value;
  }

  // 原版这里常写成 matrix[tile]，MapMatrix 也支持下标；JS 侧按 tile_index 直写 raw。
  function _gridSetRaw(grid, tileIndex, value) {
    if (!grid || !grid.raw) return;
    grid.raw[tileIndex] = value;
  }

  function _mapOf(bot) {
    return (bot && (bot._map || bot.map)) || null;
  }

  function _get(obj, name, dflt) {
    if (!obj) return dflt;
    var v = obj[name];
    return v === undefined ? dflt : v;
  }

  function _tilesInOrder(map) {
    if (!map) return [];
    if (map.tiles_by_index) return map.tiles_by_index;
    return map.get_all_tiles ? map.get_all_tiles() : [];
  }

  // ---- TargetStyle / PathColorer ----------------------------------------
  // 原版这两个在 ViewInfo.py 里。botmain.js 有一份私有副本，但没有导出到 EK，
  // 所以这里定义并导出；已被别人定义就不覆盖（谁先加载谁说话，成员值一样）。

  if (!EK.TargetStyle) {
    EK.TargetStyle = {
      BLUE: 1, GREEN: 2, RED: 3, WHITE: 4, TEAL: 5,
      PURPLE: 6, ORANGE: 7, YELLOW: 8, BLACK: 9, GOLD: 10, GRAY: 11
    };
  }

  if (!EK.PathColorer) {
    function PathColorer(path, r, g, b, alpha, alphaDecreaseRate, alphaMinimum) {
      this.path = path;
      this.color = [r === undefined ? 0 : r, g === undefined ? 0 : g, b === undefined ? 0 : b];
      this.alpha = alpha === undefined ? 255 : alpha;
      this.alphaDecreaseRate = alphaDecreaseRate === undefined ? 10 : alphaDecreaseRate;
      this.alphaMinimum = alphaMinimum === undefined ? 100 : alphaMinimum;
    }
    EK.PathColorer = PathColorer;
  }

  var TargetStyle = EK.TargetStyle;
  var PathColorer = EK.PathColorer;

  // ---- ViewInfo ---------------------------------------------------------

  function ViewInfo(countHist, map) {
    this.renderStep = countHist;
    this.map = map;
    this.cols = map ? map.cols : 0;
    this.rows = map ? map.rows : 0;

    this.infoText = '(replace with whatever text here)';
    this.infoLines = [];
    this.statsLines = [];
    this.addlTimingsLineText = '';
    this.perfEvents = [];

    this._divisions = [];
    this._zones = [];
    this.paths = [];
    this.arrows = [];
    this.targetedTiles = [];

    this.board_analysis = null;
    this.targetingArmy = null;
    this.armyTracker = null;
    this.dangerAnalyzer = null;
    this.currentPath = null;
    this.gatherNodes = null;
    this.redGatherNodes = null;
    this.territories = null;
    this.timings = null;
    this.allIn = false;
    this.allInCounter = 0;
    this.givingUpCounter = 0;
    this.targetPlayer = -1;
    this.generalApproximations = [];
    this.playerTargetScores = [];
    this.team_cycle_stats = [];
    this.team_last_cycle_stats = [];
    this.player_fog_tile_counts = {};
    this.player_fog_risks = [];

    this.evaluatedGrid = [];
    for (var x = 0; x < this.cols; x++) {
      var col = new Array(this.rows);
      for (var y = 0; y < this.rows; y++) col[y] = 0;
      this.evaluatedGrid.push(col);
    }

    this.topRightGridText = _getMat(map, null);
    this.midRightGridText = _getMat(map, null);
    this.bottomMidRightGridText = _getMat(map, null);
    this.bottomRightGridText = _getMat(map, null);
    this.bottomLeftGridText = _getMat(map, null);
    this.bottomMidLeftGridText = _getMat(map, null);
    this.midLeftGridText = _getMat(map, null);
  }

  ViewInfo.get_color_from_target_style = function (targetStyle) {
    switch (targetStyle) {
      case TargetStyle.RED: return [255, 0, 0];
      case TargetStyle.BLUE: return [50, 50, 255];
      case TargetStyle.GOLD: return [185, 145, 0];
      case TargetStyle.GREEN: return [0, 200, 0];
      case TargetStyle.PURPLE: return [160, 0, 200];
      case TargetStyle.TEAL: return [0, 160, 160];
      case TargetStyle.YELLOW: return [230, 230, 0];
      case TargetStyle.GRAY: return [128, 128, 128];
      case TargetStyle.WHITE: return [200, 200, 200];
      case TargetStyle.ORANGE: return [255, 140, 0];
      default: return [128, 128, 128];
    }
  };

  ViewInfo.prototype.clear_for_next_turn = function () {
    this.addlTimingsLineText = '';
    this.infoLines = [];
    this.statsLines = [];
    this._divisions = [];
    this._zones = [];
    this.board_analysis = null;
    this.targetingArmy = null;
    this.armyTracker = null;
    this.dangerAnalyzer = null;
    this.currentPath = null;
    this.gatherNodes = null;
    this.redGatherNodes = null;
    this.territories = null;
    this.allIn = false;
    this.timings = null;
    this.allInCounter = 0;
    this.givingUpCounter = 0;
    this.targetPlayer = -1;
    this.perfEvents = [];
    this.paths = [];
    this.arrows = [];
    this.targetedTiles = [];
    // 每格文本必须整块重建：上一回合的残余小字会和这一回合的叠在一起，
    // 看着像"这一回合又多出一格"，排查时会误导。
    this.topRightGridText = _getMat(this.map, null);
    this.midRightGridText = _getMat(this.map, null);
    this.bottomMidRightGridText = _getMat(this.map, null);
    this.bottomRightGridText = _getMat(this.map, null);
    this.bottomLeftGridText = _getMat(this.map, null);
    this.bottomMidLeftGridText = _getMat(this.map, null);
    this.midLeftGridText = _getMat(this.map, null);
    for (var x = 0; x < this.cols; x++) {
      for (var y = 0; y < this.rows; y++) this.evaluatedGrid[x][y] = 0;
    }
  };

  ViewInfo.prototype.add_targeted_tile = function (tile, targetStyle, radiusReduction) {
    if (!tile) return;
    _pushRing(this.targetedTiles,
      [tile, targetStyle === undefined ? TargetStyle.RED : targetStyle,
        radiusReduction === undefined ? 6 : radiusReduction],
      VIEW_INFO_LIST_CAP);
  };

  ViewInfo.prototype.add_targeted_tiles = function (tiles, targetStyle, radiusReduction) {
    if (!tiles) return;
    var arr = typeof tiles.forEach === 'function' && !Array.isArray(tiles) ? Array.from(tiles) : tiles;
    for (var i = 0; i < (arr ? arr.length : 0); i++) {
      this.add_targeted_tile(arr[i], targetStyle, radiusReduction);
    }
  };

  ViewInfo.prototype.add_targeted_tiles_with_legend = function (tiles, legend, targetStyle, radiusReduction) {
    this.add_targeted_tiles(tiles, targetStyle, radiusReduction);
    if (legend) this.add_info_line(String(legend));
  };

  ViewInfo.prototype.add_info_line = function (additionalInfo) {
    this.infoText = String(additionalInfo);
    _pushRing(this.infoLines, String(additionalInfo), VIEW_INFO_LIST_CAP);
  };

  ViewInfo.prototype.add_info_multiline = function (additionalInfo) {
    this.add_info_multi_line(additionalInfo);
  };

  ViewInfo.prototype.add_info_line_no_log = function (additionalInfo) {
    _pushRing(this.infoLines, String(additionalInfo), VIEW_INFO_LIST_CAP);
  };

  ViewInfo.prototype.add_info_multiline_no_log = function (additionalInfo) {
    this.add_info_multi_line(additionalInfo);
  };

  ViewInfo.prototype.add_info_line_opt_log = function (additionalInfo, noLog) {
    if (noLog) this.add_info_line_no_log(additionalInfo);
    else this.add_info_line(additionalInfo);
  };

  ViewInfo.prototype.add_info_multiline_opt_log = function (additionalInfo, noLog) {
    this.add_info_multi_line(additionalInfo);
  };

  ViewInfo.prototype.add_info_multi_line = function (inputStr, lineLenChars, childLineIndent) {
    var lines = String(inputStr).split('\n');
    for (var i = 0; i < lines.length; i++) {
      _pushRing(this.infoLines, lines[i], VIEW_INFO_LIST_CAP);
    }
  };

  ViewInfo.prototype.add_stats_line = function (statsLine) {
    _pushRing(this.statsLines, String(statsLine), VIEW_INFO_LIST_CAP);
  };

  ViewInfo.prototype.add_stats_multiline = function (statsLines) {
    var lines = String(statsLines).split('\n');
    for (var i = 0; i < lines.length; i++) {
      _pushRing(this.statsLines, lines[i], VIEW_INFO_LIST_CAP);
    }
  };

  ViewInfo.prototype.add_map_division = function (divisionMatrix, color, alpha, thickness) {
    _pushRing(this._divisions,
      [divisionMatrix, color, alpha === undefined ? 128 : alpha, thickness === undefined ? 2 : thickness],
      VIEW_INFO_LIST_CAP);
  };

  ViewInfo.prototype.add_map_zone = function (zoneMatrix, color, alpha) {
    _pushRing(this._zones, [zoneMatrix, color, alpha === undefined ? 15 : alpha], VIEW_INFO_LIST_CAP);
  };

  ViewInfo.prototype.color_path = function (pathColorer, renderOnBottom) {
    if (!pathColorer) return;
    _pushRing(this.paths, pathColorer, VIEW_INFO_LIST_CAP);
  };

  ViewInfo.prototype.color_tile = function (tile, color, alpha) {
    // 原版会往 tileColors 里塞；离线只记录，保证调用点不炸。
    this.add_targeted_tile(tile, TargetStyle.WHITE, 0);
  };

  ViewInfo.prototype.mark_tile = function (tile, alpha) {
    if (!tile) return;
    if (this.evaluatedGrid[tile.x]) this.evaluatedGrid[tile.x][tile.y] = alpha === undefined ? 100 : alpha;
  };

  ViewInfo.prototype.draw_diagonal_arrow_between = function (fromTile, toTile, label, color, alpha, isBidirectional, labelAlpha) {
    if (!fromTile || !toTile) return;
    _pushRing(this.arrows, [fromTile, toTile, label, color, alpha, isBidirectional, labelAlpha],
      VIEW_INFO_LIST_CAP);
  };

  ViewInfo.prototype.draw_diagonal_arrow_between_xy = function (x1, y1, x2, y2, label, color, alpha) {
    _pushRing(this.arrows, [[x1, y1], [x2, y2], label, color, alpha], VIEW_INFO_LIST_CAP);
  };

  EK.ViewInfo = ViewInfo;

  // ---- BotSerialization 等价物（仅 dump 用） -----------------------------

  function _tileSetStr(map, tiles) {
    var all = _tilesInOrder(map);
    var out = '';
    for (var i = 0; i < all.length; i++) {
      out += _contains(tiles, all[i]) ? '1' : '0';
    }
    return out;
  }

  function _boolMatrixStr(map, matrix) {
    var all = _tilesInOrder(map);
    var out = '';
    for (var i = 0; i < all.length; i++) {
      out += (matrix && _gridGet(matrix, all[i])) ? '1' : '0';
    }
    return out;
  }

  function _floatMatrixStr(map, matrix) {
    var all = _tilesInOrder(map);
    var parts = [];
    for (var i = 0; i < all.length; i++) {
      var v = matrix ? _gridGet(matrix, all[i]) : 0;
      parts.push((v === null || v === undefined ? 0 : v).toFixed(2));
    }
    return parts.join(',');
  }

  function _tileIntDictStr(map, dict) {
    var all = _tilesInOrder(map);
    var parts = [];
    for (var i = 0; i < all.length; i++) {
      var v = null;
      if (dict) {
        if (typeof dict.get === 'function') v = dict.get(all[i]);
        else v = dict[all[i].tile_index];
      }
      parts.push(v === null || v === undefined ? '' : String(v));
    }
    return parts.join(',');
  }

  function _moveStr(move) {
    if (!move) return 'None';
    return move.source.x + ',' + move.source.y + '>' + move.dest.x + ',' + move.dest.y + '>' + (move.move_half ? 'True' : 'False');
  }

  function _playerChar(index) {
    return index >= 0 && index < PLAYER_CHARS.length ? PLAYER_CHARS.charAt(index) : '?';
  }

  // ---- BotRendering -----------------------------------------------------

  function BotRendering() { }

  BotRendering.mark_tile = function (bot, tile, alpha) {
    if (alpha === undefined) alpha = 100;
    if (!bot || !bot.viewInfo || !tile) return;
    if (bot.viewInfo.evaluatedGrid[tile.x]) bot.viewInfo.evaluatedGrid[tile.x][tile.y] = alpha;
  };

  BotRendering.render_tile_deltas_in_view_info = function (viewInfo, map) {
    if (!viewInfo || !map) return;
    var tiles = _tilesInOrder(map);
    for (var i = 0; i < tiles.length; i++) {
      var tile = tiles[i];
      var d = tile.delta;
      if (!d) continue;
      var renderMore = !!(d.armyMovedHere || d.lostSight || d.gainedSight || d.discovered
        || d.armyDelta !== 0 || d.unexplainedDelta !== 0
        || (d.fromTile !== null && d.fromTile !== undefined)
        || (d.toTile !== null && d.toTile !== undefined));

      var s = '';
      if (d.armyMovedHere) s += 'M';
      if (d.imperfectArmyDelta) s += 'I';
      if (d.lostSight) s += 'L';
      if (d.gainedSight) s += 'G';
      if (d.discovered) s += 'D';
      s += ' ';
      _gridSetRaw(viewInfo.bottomRightGridText, tile.tile_index, s);

      // 原版 f'{v:+d}' 会带正号；JS 要手写，否则 "-3 / 3" 看起来分不出增减。
      if (d.armyDelta !== 0) {
        _gridSetRaw(viewInfo.bottomLeftGridText, tile.tile_index,
          'd' + (d.armyDelta > 0 ? '+' : '') + d.armyDelta);
      }
      if (d.unexplainedDelta !== 0) {
        _gridSetRaw(viewInfo.bottomMidLeftGridText, tile.tile_index,
          'u' + (d.unexplainedDelta > 0 ? '+' : '') + d.unexplainedDelta);
      }
      if (renderMore) {
        var moves = '';
        if (d.toTile && d.fromTile) moves = d.fromTile.toString() + '-' + d.toTile.toString();
        else if (d.fromTile) moves = '<-' + d.fromTile.toString();
        else if (d.toTile) moves = '->' + d.toTile.toString();
        _gridSetRaw(viewInfo.topRightGridText, tile.tile_index, moves);
        _gridSetRaw(viewInfo.midRightGridText, tile.tile_index, String(d.oldArmy));
        if (d.oldOwner !== d.newOwner) {
          _gridSetRaw(viewInfo.bottomMidRightGridText, tile.tile_index, d.oldOwner + '-' + d.newOwner);
        }
      }
    }
  };

  BotRendering.render_tile_state_in_view_info = function (viewInfo, map) {
    if (!viewInfo || !map) return;
    var tiles = _tilesInOrder(map);
    for (var i = 0; i < tiles.length; i++) {
      var tile = tiles[i];
      var s = '';
      if (!tile.isPathable) s += '-';
      if (!map.pathable_tiles || !map.pathable_tiles.has(tile)) s += '-';
      if (tile.isCostlyNeutralCity) s += 'C';
      if (!map.reachable_tiles || !map.reachable_tiles.has(tile)) s += 'X';
      if (tile.isObstacle) s += 'O';
      if (tile.isMountain) s += 'M';
      if (tile.overridePathable !== null && tile.overridePathable !== undefined) {
        s += tile.overridePathable ? 'p' : 'z';
      }
      s += ' ';
      _gridSetRaw(viewInfo.bottomMidRightGridText, tile.tile_index, s);
    }
  };

  BotRendering.add_city_score_to_view_info = function (score, viewInfo) {
    if (!score || !viewInfo || !score.tile) return;
    var tile = score.tile;
    // 原版 `f'{v:.2f}'.strip('0')` 会把 "0.50" 里的尾零也剪掉 → 这里照做。
    function _fmt(v, prefix) {
      var s = (v === null || v === undefined ? 0 : v).toFixed(2);
      s = s.replace(/0+$/, '');
      return prefix + s;
    }
    _gridSet(viewInfo.topRightGridText, tile, _fmt(score.city_relevance_score, 'r'));
    _gridSet(viewInfo.midRightGridText, tile, _fmt(score.city_expandability_score, 'e'));
    _gridSet(viewInfo.bottomMidRightGridText, tile, _fmt(score.city_defensability_score, 'd'));
    _gridSet(viewInfo.bottomRightGridText, tile, _fmt(score.city_general_defense_score, 'g'));

    if (_playerOf(tile) >= 0) {
      _gridSet(viewInfo.bottomLeftGridText, tile,
        _fmt(score.get_weighted_enemy_capture_value(), 'e'));
    } else {
      _gridSet(viewInfo.bottomLeftGridText, tile,
        _fmt(score.get_weighted_neutral_value(), 'n'));
    }
  };

  BotRendering.render_intercept_plan = function (bot, plan, colorIndex) {
    if (colorIndex === undefined) colorIndex = 0;
    if (!bot || !plan) return;
    var vi = bot.viewInfo || null;
    var targetStyle = ((colorIndex + 1) % 9) + 1;
    var chokes = plan.common_intercept_chokes;
    if (chokes && vi) {
      var keys = chokes instanceof Map ? Array.from(chokes.keys())
        : (Array.isArray(chokes) ? chokes : []);
      for (var i = 0; i < keys.length; i++) {
        var tile = keys[i];
        var info = chokes instanceof Map ? chokes.get(tile) : null;
        if (!info) continue;
        vi.add_targeted_tile(tile, targetStyle, 11 - colorIndex);
        _gridSet(vi.bottomMidRightGridText, tile, 'cw' + info.max_choke_width);
        _gridSet(vi.bottomMidLeftGridText, tile, 'ic' + info.max_intercept_turn_offset);
        _gridSet(vi.bottomLeftGridText, tile, 'it' + info.max_delay_turns);
        _gridSet(vi.midRightGridText, tile, 'im' + info.max_extra_moves_to_capture);
      }
    }
    if (vi) {
      vi.add_info_line_no_log('  intChokes @' + (plan.target_tile ? String(plan.target_tile) : 'null')
        + ' = ' + targetStyle);
    }
  };

  BotRendering.prep_view_info_for_render = function (bot, move) {
    if (!bot) return;
    var vi = bot.viewInfo;
    if (!vi) return;      // 没有渲染层就别干活，原版这里假定 viewInfo 一直在
    var map = _mapOf(bot);
    if (!map) return;

    vi.board_analysis = _get(bot, 'board_analysis', null);
    vi.targetingArmy = _get(bot, 'targetingArmy', null);
    vi.armyTracker = _get(bot, 'armyTracker', null);
    vi.dangerAnalyzer = _get(bot, 'dangerAnalyzer', null);
    vi.currentPath = _get(bot, 'curPath', null);
    vi.gatherNodes = _get(bot, 'gatherNodes', null);
    vi.redGatherNodes = _get(bot, 'redGatherTreeNodes', null);
    vi.territories = _get(bot, 'territories', null);
    vi.allIn = !!_get(bot, 'is_all_in_losing', false);
    vi.timings = _get(bot, 'timings', null);
    vi.allInCounter = _get(bot, 'all_in_losing_counter', 0);
    vi.givingUpCounter = _get(bot, 'giving_up_counter', 0);
    vi.targetPlayer = _get(bot, 'targetPlayer', -1);
    vi.generalApproximations = _get(bot, 'generalApproximations', []);
    vi.playerTargetScores = _get(bot, 'playerTargetScores', []);

    var movePath = null;
    if (move && EK.Path) {
      movePath = new EK.Path(move.source.army - 1);
      movePath.add_next(move.source);
      movePath.add_next(move.dest);
      vi.color_path(new PathColorer(movePath, 254, 254, 254, 255, 0), true);
    }

    var armyTracker = vi.armyTracker;
    if (armyTracker) {
      if (_get(bot, 'info_render_army_emergence_values', false)) {
        var emergence = armyTracker.emergenceLocationMap;
        var targetPlayer = vi.targetPlayer;
        if (emergence && emergence[targetPlayer]) {
          var reachable = map.reachable_tiles ? Array.from(map.reachable_tiles) : [];
          for (var i = 0; i < reachable.length; i++) {
            var t = reachable[i];
            var val = _gridGet(emergence[targetPlayer], t);
            if (val !== 0 && val !== null && val !== undefined) {
              _gridSet(vi.bottomMidRightGridText, t, 'e' + Number(val).toFixed(1));
            }
          }
        }
      }

      var dropped = armyTracker.dropped_fog_tiles_this_turn || [];
      for (var di = 0; di < dropped.length; di++) vi.add_targeted_tile(dropped[di], TargetStyle.RED);
      var decr = armyTracker.decremented_fog_tiles_this_turn || [];
      for (var ci = 0; ci < decr.length; ci++) vi.add_targeted_tile(decr[ci], TargetStyle.GREEN);
    }

    if (_get(bot, 'info_render_gather_locality_values', false)) {
      var gatherAnalyzer = _get(bot, 'gatherAnalyzer', null);
      if (gatherAnalyzer && gatherAnalyzer.gather_locality_map) {
        var genPlayer = _playerOf(_get(bot, 'general', null));
        var pathable = map.pathable_tiles ? Array.from(map.pathable_tiles) : [];
        for (var pi = 0; pi < pathable.length; pi++) {
          if (_playerOf(pathable[pi]) === genPlayer) {
            _gridSet(vi.bottomMidRightGridText, pathable[pi],
              'l' + _gridGet(gatherAnalyzer.gather_locality_map, pathable[pi]));
          }
        }
      }
    }

    if (_get(bot, 'info_render_tile_deltas', false)) {
      BotRendering.render_tile_deltas_in_view_info(vi, map);
    }
    if (_get(bot, 'info_render_tile_states', false)) {
      BotRendering.render_tile_state_in_view_info(vi, map);
    }

    var gatherPath = _get(bot, 'target_player_gather_path', null);
    if (gatherPath) {
      vi.color_path(new PathColorer(gatherPath, 60, 50, 0, 140, 5, 100));
    }

    var boardAnalysis = vi.board_analysis;
    if (boardAnalysis && boardAnalysis.intergeneral_analysis) {
      if (boardAnalysis.core_play_area_matrix) {
        var nonZone = EK.MapMatrixSet ? new EK.MapMatrixSet(map) : null;
        var allTiles = _tilesInOrder(map);
        for (var ti = 0; ti < allTiles.length; ti++) {
          if (!_contains(boardAnalysis.core_play_area_matrix, allTiles[ti])) {
            if (nonZone) nonZone.add(allTiles[ti]);
          }
        }
        if (nonZone) vi.add_map_zone(nonZone, [100, 100, 50], 35);
      }

      if (_get(bot, 'info_render_board_analysis_zones', false)) {
        if (boardAnalysis.core_play_area_matrix) {
          vi.add_map_division(boardAnalysis.core_play_area_matrix, [10, 230, 0], 150);
        }
        if (boardAnalysis.extended_play_area_matrix) {
          vi.add_map_division(boardAnalysis.extended_play_area_matrix, [255, 230, 0], 150);
        }
        if (boardAnalysis.flank_danger_play_area_matrix) {
          vi.add_map_division(boardAnalysis.flank_danger_play_area_matrix, [205, 80, 40], 255);
        }
        if (boardAnalysis.flankable_fog_area_matrix) {
          vi.add_map_division(boardAnalysis.flankable_fog_area_matrix, [0, 0, 0], 255);
          vi.add_map_zone(boardAnalysis.flankable_fog_area_matrix, [255, 255, 255], 40);
        }
        if (boardAnalysis.backwards_tiles) {
          vi.add_map_zone(boardAnalysis.backwards_tiles, [50, 100, 50], 75);
        }
      }
    }

    var oppTracker = _get(bot, 'opponent_tracker', _get(bot, 'opponentTracker', null));
    if (oppTracker) {
      vi.team_cycle_stats = _get(oppTracker, 'current_team_cycle_stats', []);
      if (typeof oppTracker.get_last_cycle_stats_per_team === 'function') {
        vi.team_last_cycle_stats = oppTracker.get_last_cycle_stats_per_team();
      }
      if (typeof oppTracker.get_all_player_fog_tile_count_dict === 'function') {
        vi.player_fog_tile_counts = oppTracker.get_all_player_fog_tile_count_dict();
      }
      if (typeof oppTracker.get_approximate_fog_army_risk === 'function') {
        var risks = [];
        var players = map.players || [];
        for (var rp = 0; rp < players.length; rp++) {
          risks.push(oppTracker.get_approximate_fog_army_risk(rp));
        }
        vi.player_fog_risks = risks;
      }
    }

    if (_get(bot, 'info_render_centrality_distances', false) && boardAnalysis && boardAnalysis.defense_centrality_sums) {
      var allTilesC = _tilesInOrder(map);
      for (var ct = 0; ct < allTilesC.length; ct++) {
        _gridSet(vi.bottomLeftGridText, allTilesC[ct],
          'cen' + _gridGet(boardAnalysis.defense_centrality_sums, allTilesC[ct]));
      }
    }

    if (_get(bot, 'info_render_pathway_distances', false) && boardAnalysis
      && boardAnalysis.intergeneral_analysis && boardAnalysis.intergeneral_analysis.pathWayLookupMatrix) {
      var pwMatrix = boardAnalysis.intergeneral_analysis.pathWayLookupMatrix;
      var allTilesP = _tilesInOrder(map);
      for (var pt = 0; pt < allTilesP.length; pt++) {
        var tileP = allTilesP[pt];
        var pw = pwMatrix.raw ? pwMatrix.raw[tileP.tile_index] : null;
        _gridSet(vi.bottomLeftGridText, tileP,
          (pw === null || pw === undefined) ? 'pwN' : ('pw' + pw.distance));
      }
    }

    var enemyAttackPath = _get(bot, 'enemy_attack_path', null);
    if (enemyAttackPath) {
      vi.color_path(new PathColorer(enemyAttackPath, 255, 185, 75, 255, 5));
    }

    var targetPlayer = vi.targetPlayer;
    var expectedGenLoc = _get(bot, 'targetPlayerExpectedGeneralLocation', null);
    if (targetPlayer >= 0 && expectedGenLoc && !expectedGenLoc.isGeneral) {
      var altPositions = _get(bot, 'alt_en_gen_positions', null);
      // botmain 里 alt_en_gen_positions 是按玩家号索引的数组；这里必须显式分流，
      // 写成 `a[i] || a.get ? a.get(i) : null` 会因运算符优先级把数组当 Map 用。
      var positions = null;
      if (altPositions) {
        positions = typeof altPositions.get === 'function'
          ? altPositions.get(targetPlayer)
          : altPositions[targetPlayer];
      }
      if (positions) {
        for (var ai = 0; ai < positions.length; ai++) {
          vi.add_targeted_tile(positions[ai], TargetStyle.YELLOW, 3);
        }
      }
    }

    if (_get(bot, 'info_render_board_analysis_choke_widths', false) && boardAnalysis
      && boardAnalysis.intergeneral_analysis) {
      var chokeWidths = boardAnalysis.intergeneral_analysis.chokeWidths;
      var allTilesW = _tilesInOrder(map);
      for (var wt = 0; wt < allTilesW.length; wt++) {
        var w = '';
        if (chokeWidths && _contains(chokeWidths, allTilesW[wt])) {
          w = String(_gridGet(chokeWidths, allTilesW[wt]));
        }
        _gridSet(vi.topRightGridText, allTilesW[wt], 'cw' + w);
      }
    }

    if (armyTracker) {
      var unconnectable = armyTracker.unconnectable_tiles || [];
      for (var ui = 0; ui < unconnectable.length; ui++) {
        var group = unconnectable[ui];
        for (var gi = 0; gi < group.length; gi++) {
          vi.add_targeted_tile(group[gi], TargetStyle.RED, -5);
        }
      }

      var connected = armyTracker.player_connected_tiles || [];
      var botPlayer = _get(bot, 'player', null);
      var playerIndex = botPlayer && botPlayer.index !== undefined ? botPlayer.index
        : _get(map, 'player_index', -1);
      for (var cp = 0; cp < connected.length; cp++) {
        // 只画"不是自己队、且还活着"的玩家的连通块（活着才有未来威胁）。
        if (_teamCheck(map, playerIndex, cp)) continue;
        if (map.players && map.players[cp] && map.players[cp].dead) continue;
        vi.add_map_division(connected[cp], [128, 128, 128], 150);
        vi.add_map_zone(connected[cp], [128, 128, 128], 65);
      }
    }

    if (move && movePath) {
      vi.color_path(new PathColorer(movePath, 254, 254, 254, 135, 0));
    }

    var defenseTree = _get(bot, 'defensive_spanning_tree', null);
    if (_get(bot, 'info_render_defense_spanning_tree', false) && defenseTree) {
      vi.add_map_division(defenseTree, [255, 255, 255], 200, 4);
      vi.add_map_zone(defenseTree, [128, 0, 0], 100);
    }

    var winCondition = _get(bot, 'win_condition_analyzer', _get(bot, 'winConditionAnalyzer', null));
    if (winCondition && winCondition.defend_cities) {
      vi.add_targeted_tiles_with_legend(winCondition.defend_cities, 'DEFEND CITIES', TargetStyle.PURPLE, 3);
    }

    var friendlyCityTree = _get(bot, 'friendly_city_spanning_tree', null);
    if (_get(bot, 'info_render_friendly_city_spanning_tree', false) && friendlyCityTree) {
      vi.add_map_zone(friendlyCityTree, [185, 145, 0], 50);
    }

    var islandBuilder = _get(bot, 'tileIslandBuilder', _get(bot, 'tile_island_builder', null));
    if (_get(bot, 'info_render_tile_islands', false) && islandBuilder) {
      var islands = islandBuilder.all_tile_islands || [];
      var sorted = islands.slice().sort(function (a, b) {
        if (a.team !== b.team) return a.team < b.team ? -1 : 1;
        var an = String(a.name === null || a.name === undefined ? '' : a.name);
        var bn = String(b.name === null || b.name === undefined ? '' : b.name);
        return an < bn ? -1 : (an > bn ? 1 : 0);
      });
      for (var ii = 0; ii < sorted.length; ii++) {
        var island = sorted[ii];
        if (!island.name) continue;
        var islandTiles = island.tile_set ? Array.from(island.tile_set) : [];
        for (var it = 0; it < islandTiles.length; it++) {
          if (_gridGet(vi.topRightGridText, islandTiles[it])) {
            _gridSet(vi.midRightGridText, islandTiles[it], island.name);
          } else {
            _gridSet(vi.topRightGridText, islandTiles[it], island.name);
          }
        }
      }
    }

    if (_get(bot, 'last_flow_expander', null) !== null && _get(bot, 'last_flow_opt_collection', null) !== null) {
      if (_get(bot, 'info_render_flow_expand', false)) {
        BotRendering.render_flow_expand_in_view_info(bot, true);
      }
    }

    if (_get(bot, 'info_render_enemy_vision_data', false) && targetPlayer !== -1 && armyTracker) {
      var visByPlayer = armyTracker.visible_tiles_by_player;
      var seenByPlayer = armyTracker.seen_tiles_by_player;
      if (visByPlayer && visByPlayer[targetPlayer]) {
        var visRaw = visByPlayer[targetPlayer].raw;
        var allTilesV = _tilesInOrder(map);
        for (var vt = 0; vt < allTilesV.length; vt++) {
          _gridSetRaw(vi.midLeftGridText, allTilesV[vt].tile_index, visRaw[allTilesV[vt].tile_index] ? '+' : '-');
        }
      }
      if (seenByPlayer && seenByPlayer[targetPlayer]) {
        var seenRaw = seenByPlayer[targetPlayer].raw;
        var allTilesS = _tilesInOrder(map);
        for (var sti = 0; sti < allTilesS.length; sti++) {
          _gridSetRaw(vi.midRightGridText, allTilesS[sti].tile_index, seenRaw[allTilesS[sti].tile_index] ? '+' : '-');
        }
      }
    }
  };

  // map.is_player_on_team_with 在 map.js 里没有（原版有），本文件内兜一个。
  function _teamCheck(map, p1, p2) {
    if (p1 === p2) return true;
    if (typeof map.is_player_on_team_with === 'function') return map.is_player_on_team_with(p1, p2);
    if (typeof map.is_tile_on_team_with === 'function') return false;
    var ids = map.team_ids_by_player_index;
    if (!ids) return p1 === p2;
    var t1 = p1 >= 0 && p1 < ids.length ? ids[p1] : -1;
    var t2 = p2 >= 0 && p2 < ids.length ? ids[p2] : -1;
    if (t1 === -1 || t2 === -1) return p1 === p2;
    return t1 === t2;
  }

  BotRendering.render_flow_expand_in_view_info = function (bot, dontLogOpts) {
    // ArmyFlowExpander / FlowGraph 在 JS 侧没有对应实现（属于未移植的 BehaviorAlgorithms）。
    // 这里保留函数是为了让调用点不改，有数据就按原版顺序输出"最优扩张选项"到 info 行。
    if (!bot || !bot.viewInfo) return;
    var expander = _get(bot, 'last_flow_expander', null);
    var optCollection = _get(bot, 'last_flow_opt_collection', null);
    if (!expander || !optCollection) return;
    var vi = bot.viewInfo;
    var opts = optCollection.expansion_options || [];
    if (!opts.length) return;

    var optsSorted = opts.slice().sort(function (a, b) {
      if (b.length !== a.length) return b.length - a.length;
      return b.econValue - a.econValue;
    });

    var seen = new Set();
    var dupes = 0;
    for (var i = 0; i < optsSorted.length; i++) {
      var tileList = optsSorted[i].tileList || [];
      for (var t = 0; t < tileList.length; t++) {
        var tile = tileList[t];
        if (seen.has(tile)) {
          dupes++;
        } else {
          seen.add(tile);
        }
      }
    }
    if (dupes > 0) {
      vi.add_info_line('FE DUPE count=' + dupes);
    }

    var bestOpt = null;
    for (var bi = 0; bi < optsSorted.length; bi++) {
      if (optsSorted[bi].length > 3) {
        bestOpt = optsSorted[bi];
        break;
      }
    }
    if (!bestOpt) bestOpt = optsSorted[0];
    var bestTiles = bestOpt.tileList || [];
    var labels = [];
    for (var bt = 0; bt < bestTiles.length; bt++) labels.push(bestTiles[bt].x + ',' + bestTiles[bt].y);
    vi.add_info_line_no_log(String(bestOpt) + '   ' + labels.join('|'));
  };

  BotRendering.dump_turn_data_to_string = function (bot) {
    if (!bot) return '';
    var map = _mapOf(bot);
    var data = [];
    var armyTracker = _get(bot, 'armyTracker', null);
    var oppTracker = _get(bot, 'opponent_tracker', _get(bot, 'opponentTracker', null));
    var winCondition = _get(bot, 'win_condition_analyzer', _get(bot, 'winConditionAnalyzer', null));
    var targetPlayer = _get(bot, 'targetPlayer', -1);

    data.push('bot_target_player=' + targetPlayer);
    var expectedGenLoc = _get(bot, 'targetPlayerExpectedGeneralLocation', null);
    if (expectedGenLoc && targetPlayer !== -1) {
      data.push('targetPlayerExpectedGeneralLocation=' + expectedGenLoc.x + ',' + expectedGenLoc.y);
    }
    var lockedLaunch = _get(bot, 'locked_launch_point', null);
    if (lockedLaunch) {
      data.push('bot_locked_launch_point=' + lockedLaunch.x + ',' + lockedLaunch.y);
    }
    data.push('bot_is_all_in_losing=' + _get(bot, 'is_all_in_losing', false));
    data.push('bot_all_in_losing_counter=' + _get(bot, 'all_in_losing_counter', 0));
    data.push('bot_is_winning_gather_cyclic=' + _get(bot, 'is_winning_gather_cyclic', false));
    data.push('bot_is_all_in_army_advantage=' + _get(bot, 'is_all_in_army_advantage', false));
    data.push('bot_all_in_army_advantage_counter=' + _get(bot, 'all_in_army_advantage_counter', 0));
    data.push('bot_all_in_army_advantage_cycle=' + _get(bot, 'all_in_army_advantage_cycle', 0));
    data.push('bot_all_in_city_behind=' + _get(bot, 'all_in_city_behind', false));
    data.push('bot_defend_economy=' + _get(bot, 'defend_economy', false));
    data.push('bot_attack_failed_turn=' + _get(bot, 'attackFailedTurn', -1));
    data.push('bot_count_failed_quick_attacks=' + _get(bot, 'countFailedQuickAttacks', 0));
    data.push('bot_count_failed_high_depth_attacks=' + _get(bot, 'countFailedHighDepthAttacks', 0));
    data.push('bot_last_target_attack_turn=' + _get(bot, 'lastTargetAttackTurn', -1));
    data.push('bot_force_far_gathers=' + _get(bot, 'force_far_gathers', false));
    data.push('bot_force_far_gathers_turns=' + _get(bot, 'force_far_gathers_turns', 0));
    data.push('bot_force_far_gathers_sleep_turns=' + _get(bot, 'force_far_gathers_sleep_turns', 0));

    var timings = _get(bot, 'timings', null);
    if (timings) {
      data.push('bot_timings_launch_timing=' + _get(timings, 'launchTiming', 0));
      data.push('bot_timings_split_turns=' + _get(timings, 'splitTurns', 0));
      data.push('bot_timings_quick_expand_turns=' + _get(timings, 'quickExpandTurns', 0));
      data.push('bot_timings_cycle_turns=' + _get(timings, 'cycleTurns', 0));
      data.push('bot_timings_disallow_enemy_gather=' + _get(timings, 'disallowEnemyGather', false));
    }

    data.push('bot_is_rapid_capturing_neut_cities=' + _get(bot, 'is_rapid_capturing_neut_cities', false));
    data.push('bot_is_blocking_neutral_city_captures=' + _get(bot, 'is_blocking_neutral_city_captures', false));
    data.push('bot_was_allowing_neutral_cities_last_turn=' + _get(bot, 'was_allowing_neutral_cities_last_turn', false));
    data.push('bot_city_capture_plan_tiles='
      + _tileSetStr(map, _get(bot, 'city_capture_plan_tiles', null)));
    data.push('bot_city_capture_plan_last_updated=' + _get(bot, 'city_capture_plan_last_updated', -1));
    data.push('bot_finishing_exploration=' + _get(bot, 'finishing_exploration', false));
    var targetingArmy = _get(bot, 'targetingArmy', null);
    if (targetingArmy && targetingArmy.tile) {
      data.push('bot_targeting_army=' + targetingArmy.tile.x + ',' + targetingArmy.tile.y);
    }
    data.push('bot_cur_path=' + String(_get(bot, 'curPath', null)));
    var lastMove = _get(bot, 'last_move', null);
    if (lastMove) {
      data.push('bot_last_move=' + _moveStr(lastMove));
    }

    var players = (map && map.players) || [];
    var usernames = (map && map.usernames) || [];
    for (var i = 0; i < players.length; i++) {
      var player = players[i];
      var ch = _playerChar(player.index);
      var unsafeUserName = String(usernames[player.index] === undefined ? '' : usernames[player.index]).replace(/=/g, '__');
      // 非 ASCII 一律换成空格：这行是给"按 = 分字段"的解析器读的。
      var safeUserName = unsafeUserName.replace(/[^\x00-\x7F]/g, ' ');
      data.push(ch + 'Username=' + safeUserName);
      data.push(ch + 'Tiles=' + _get(player, 'tileCount', 0));
      data.push(ch + 'Score=' + _get(player, 'score', 0));
      data.push(ch + 'StandingArmy=' + _get(player, 'standingArmy', 0));
      data.push(ch + 'Stars=' + _get(player, 'stars', 0));
      data.push(ch + 'CityCount=' + _get(player, 'cityCount', 0));
      if (player.general) data.push(ch + 'General=' + player.general.x + ',' + player.general.y);
      data.push(ch + 'KnowsKingLocation=' + _get(player, 'knowsKingLocation', false));
      if (map && map.is_2v2) data.push(ch + 'KnowsAllyKingLocation=' + _get(player, 'knowsAllyKingLocation', false));
      data.push(ch + 'Dead=' + _get(player, 'dead', false));
      data.push(ch + 'LeftGame=' + _get(player, 'leftGame', false));
      data.push(ch + 'LeftGameTurn=' + _get(player, 'leftGameTurn', -1));
      data.push(ch + 'AggressionFactor=' + _get(player, 'aggression_factor', 0));
      data.push(ch + 'Delta25Tiles=' + _get(player, 'delta25tiles', 0));
      data.push(ch + 'Delta25Score=' + _get(player, 'delta25score', 0));
      data.push(ch + 'CityGainedTurn=' + _get(player, 'cityGainedTurn', -1));
      data.push(ch + 'CityLostTurn=' + _get(player, 'cityLostTurn', -1));
      data.push(ch + 'LastSeenMoveTurn=' + _get(player, 'last_seen_move_turn', -1));

      if (armyTracker) {
        var emergenceMap = armyTracker.emergenceLocationMap;
        if (emergenceMap && emergenceMap[player.index]) {
          data.push(ch + 'Emergences=' + _floatMatrixStr(map, emergenceMap[player.index]));
        }
        var validGen = armyTracker.valid_general_positions_by_player;
        if (validGen && validGen[player.index]) {
          data.push(ch + 'ValidGeneralPos=' + _boolMatrixStr(map, validGen[player.index]));
        }
        var everOwned = armyTracker.tiles_ever_owned_by_player;
        if (everOwned && everOwned[player.index]) {
          data.push(ch + 'TilesEverOwned=' + _tileSetStr(map, everOwned[player.index]));
        }
        var unelim = armyTracker.uneliminated_emergence_events;
        if (unelim && unelim[player.index]) {
          data.push(ch + 'UneliminatedEmergences=' + _tileIntDictStr(map, unelim[player.index]));
        }
        var unelimCity = armyTracker.uneliminated_emergence_event_city_perfect_info;
        if (unelimCity && unelimCity[player.index]) {
          data.push(ch + 'UneliminatedEmergenceCityPerfectInfo=' + _tileSetStr(map, unelimCity[player.index]));
        }
        var unrecap = armyTracker.unrecaptured_emergence_events;
        if (unrecap && unrecap[player.index]) {
          data.push(ch + 'UnrecapturedEmergences=' + _tileSetStr(map, unrecap[player.index]));
        }
      }

      var generalApproximations = _get(bot, 'generalApproximations', []);
      if (generalApproximations.length > player.index && generalApproximations[player.index]
        && generalApproximations[player.index][3]) {
        data.push(ch + '_bot_general_approx=' + String(generalApproximations[player.index][3]));
      }
    }

    var allTiles = _tilesInOrder(map);
    var tempSet = new Set();
    var neutDiscSet = new Set();
    var lastMovedParts = [];
    var turn = map ? map.turn : 0;
    for (var at = 0; at < allTiles.length; at++) {
      var tl = allTiles[at];
      if (tl.isTempFogPrediction) tempSet.add(tl);
      if (tl.discoveredAsNeutral) neutDiscSet.add(tl);
      if (tl.lastMovedTurn >= turn - 5 && tl.lastMovedTurn >= 0) {
        lastMovedParts.push(tl.tile_index + ':' + tl.lastMovedTurn);
      }
    }
    data.push('TempFogTiles=' + _tileSetStr(map, tempSet));
    data.push('DiscoveredNeutral=' + _tileSetStr(map, neutDiscSet));
    data.push('DefensiveSpanningTree=' + _tileSetStr(map, _get(bot, 'defensive_spanning_tree', null)));
    data.push('FriendlyCitySpanningTree=' + _tileSetStr(map, _get(bot, 'friendly_city_spanning_tree', null)));
    if (winCondition && typeof winCondition.dump_city_contestation_history === 'function') {
      var hist = winCondition.dump_city_contestation_history();
      if (hist) for (var hi = 0; hi < hist.length; hi++) data.push(hist[hi]);
    }
    if (lastMovedParts.length) data.push('LastMovedTiles=' + lastMovedParts.join(','));

    // TextMapLoader.dump_armies 未移植：这里只输出兵力总数与条目数，够定位"这一回合有几个军团"。
    var armies = armyTracker ? armyTracker.armies : null;
    var armyCount = 0;
    var armyTotal = 0;
    if (armies) {
      if (typeof armies.forEach === 'function' && typeof armies.size === 'number') {
        armies.forEach(function (a) {
          armyCount++;
          armyTotal += _get(a, 'value', 0);
        });
      } else {
        var armyKeys = Object.keys(armies);
        armyCount = armyKeys.length;
        for (var ak = 0; ak < armyKeys.length; ak++) armyTotal += _get(armies[armyKeys[ak]], 'value', 0);
      }
    }
    data.push('Armies=count:' + armyCount + ',total:' + armyTotal);

    if (oppTracker && typeof oppTracker.dump_to_string_data === 'function') {
      data.push(String(oppTracker.dump_to_string_data()));
    }
    if (armyTracker && armyTracker.seen_tiles_by_player) {
      for (var sp = 0; sp < players.length; sp++) {
        var seenMatrix = armyTracker.seen_tiles_by_player[players[sp].index];
        if (seenMatrix) {
          data.push('seen_tiles_' + _playerChar(players[sp].index) + '=' + _boolMatrixStr(map, seenMatrix));
        }
      }
    }

    var islandBuilder = _get(bot, 'tileIslandBuilder', _get(bot, 'tile_island_builder', null));
    if (islandBuilder) {
      data.push('island_builder_tiles=' + (_get(islandBuilder, 'all_tile_islands', []) || []).length);
    }

    return data.join('\n');
  };

  EK.BotRendering = BotRendering;

  if (typeof module !== 'undefined' && module.exports) module.exports = EK;
})(typeof window !== 'undefined' ? window : global);
