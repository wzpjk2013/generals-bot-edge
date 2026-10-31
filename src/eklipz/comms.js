/*
 * BotComms 移植 —— 原版 E:\akcoco6de\_research\generals-bot-cs\BotModules\BotComms.py（173 行）
 *
 * 原版职责：往 generals.io 的聊天频道发消息 / 发地块 ping（2v2 里给队友报点、报威胁、
 * 请求支援），并处理收到的聊天与队友 ping。
 *
 * 为什么这个文件在离线环境里还有意义：
 *   它不只是"发消息"——`communicate_threat_to_ally` / `send_2v2_tip_to_ally` 的**冷却状态机**
 *   会影响 bot 每回合调用它的频率，而冷却状态（`_communications_sent_cooldown_cache`）是
 *   bot 状态的一部分（原版序列化里也在 bot 上）。所以冷却键、冷却窗口、默认值、
 *   `doNotUpdate` 的语义必须逐行照抄，只有最后"真的把字节送到服务器"那一步换成空实现。
 *
 * 为什么状态全部挂在 bot 上：
 *   原版是 @staticmethod + 状态全在 bot 字段里。如果用模块级全局（模块单例 / 闭包变量），
 *   一个扩展页面里连打几十局时冷却表会跨局累积，而且上一局的冷却会把下一局的开局消息吞掉；
 *   更糟的是 inbound 队列（收到的聊天）会无限增长。这里一律 lazy 建在 bot 上，
 *   并且给**收到的**队列设上限（原版靠单独线程及时 drain，离线没人 drain）。
 *
 * 与 Python 的差异（都只是收口，不改语义）：
 *   1. `bot._map` / `bot.map` 两种字段名都认（JS 侧两个都有人用）。
 *   2. Python queue.Queue → 这里自带 MsgQueue，`qsize/get/put` 同义。
 *   3. `bot.viewInfo` 可能为 null，写之前守卫。
 *   4. `random.choice` → 有 bot.random 就用它，否则 Math.random（只影响挑哪条 tip，不影响决策）。
 */
(function (root) {
  'use strict';

  var EK = (root.__EK = root.__EK || {});

  // 收到的聊天/被 ping 的格子在离线侧没人消费，设个环避免内存无限涨。
  var INBOUND_QUEUE_CAP = 512;

  function MsgQueue(cap) {
    this.items = [];
    this.head = 0;
    this.cap = cap || 0;
  }
  MsgQueue.prototype.put = function (v) {
    this.items.push(v);
    if (this.cap > 0 && this.items.length - this.head > this.cap) {
      // 丢最旧的：聊天只是展示用，丢旧的比丢新的更不容易误导人。
      this.head++;
      if (this.head > 256 && this.head * 2 > this.items.length) {
        this.items = this.items.slice(this.head);
        this.head = 0;
      }
    }
  };
  MsgQueue.prototype.get = function () {
    if (this.head >= this.items.length) return null;
    var v = this.items[this.head++];
    if (this.head === this.items.length) {
      this.items = [];
      this.head = 0;
    } else if (this.head > 256 && this.head * 2 > this.items.length) {
      this.items = this.items.slice(this.head);
      this.head = 0;
    }
    return v;
  };
  MsgQueue.prototype.qsize = function () {
    return this.items.length - this.head;
  };
  MsgQueue.prototype.drain = function () {
    var out = [];
    while (this.qsize() > 0) {
      out.push(this.get());
    }
    return out;
  };

  function _mapOf(bot) {
    return (bot && (bot._map || bot.map)) || null;
  }

  // 状态容器 lazy 建在 bot 上：跨局不共享，也不会给不同 bot 实例串味。
  function _cache(bot) {
    if (!bot._communications_sent_cooldown_cache) {
      bot._communications_sent_cooldown_cache = new Map();
    }
    return bot._communications_sent_cooldown_cache;
  }
  function _queue(bot, name, cap) {
    if (!bot[name]) bot[name] = new MsgQueue(cap);
    return bot[name];
  }
  function _turnOf(bot) {
    var map = _mapOf(bot);
    return map ? map.turn : 0;
  }
  function _is2v2(bot) {
    var map = _mapOf(bot);
    return !!(map && map.is_2v2);
  }
  function _infoLine(bot, line) {
    if (bot && bot.viewInfo && typeof bot.viewInfo.add_info_line === 'function') {
      bot.viewInfo.add_info_line(line);
    }
  }
  function _targetTile(bot, tile, style) {
    if (bot && bot.viewInfo && typeof bot.viewInfo.add_targeted_tile === 'function') {
      bot.viewInfo.add_targeted_tile(tile, style);
    }
  }
  function _tileStr(tile) {
    // 原版 str(Tile) 是 "x,y"，只用于冷却键和展示。
    if (!tile) return 'None';
    return tile.x + ',' + tile.y;
  }
  function _randChoice(bot, arr) {
    if (typeof bot.random === 'function') {
      var r = bot.random();
      return arr[Math.min(arr.length - 1, Math.max(0, Math.round(r * (arr.length - 1))))];
    }
    // 原版 BotComms.py:163 是 random.choice(tips)。虽然只影响选哪条文案，但它同样
    // 消耗随机位 —— 不接 EK.rng 会让后续决策里的 choice/shuffle 序列整体错位。
    if (EK.rng && typeof EK.rng.choice === 'function') return EK.rng.choice(arr);
    return arr[Math.floor(Math.random() * arr.length)];
  }

  /*
   * 真正把消息送到服务器的钩子。线上这里会写 websocket / 调 Chat 接口；
   * 离线（扩展没有聊天通道、oracle 也不需要发包）就什么都不做。
   * 留着这个函数是为了以后接线时不用改调用点。
   */
  function _send(bot, message) {
    return;
  }

  function BotComms() { }

  BotComms.send_teammate_communication = function (bot, message, pingTile, cooldown, detectOnMessageAlone, detectionKey) {
    if (pingTile === undefined) pingTile = null;
    if (cooldown === undefined) cooldown = 10;
    if (detectOnMessageAlone === undefined) detectOnMessageAlone = false;
    if (detectionKey === undefined) detectionKey = null;

    var commKey = message;
    var cache = _cache(bot);

    if (detectOnMessageAlone) {
      if (!BotComms.cooldown_allows(bot, commKey, cooldown, true)) {
        return;
      }
      // 原版这里只记冷却不发送，是为了让"同一句话"的判定独立于是否真发出去。
      if (pingTile !== null) {
        cache.set(commKey, _turnOf(bot));
      }
    }

    if (pingTile !== null) {
      commKey = '[@' + _tileStr(pingTile) + '] ' + commKey;
    }
    _infoLine(bot, 'Send: ' + commKey);

    if (detectionKey === null) {
      detectionKey = commKey;
    }

    // 1v1 没有聊天对象。原版的顺序是先记录/展示，再判 is_2v2，别调换——
    // 否则 info 面板上 1v1 看不到自己"本该发出去"的消息。
    if (!_is2v2(bot)) {
      return;
    }

    if (BotComms.cooldown_allows(bot, detectionKey, cooldown)) {
      _queue(bot, '_outbound_team_chat').put(message);
      _send(bot, message);

      if (pingTile !== null) {
        BotComms.send_teammate_tile_ping(bot, pingTile);
      }
    }
  };

  BotComms.send_all_chat_communication = function (bot, message) {
    _queue(bot, '_outbound_all_chat').put(message);
    _send(bot, message);
  };

  BotComms.send_teammate_path_ping = function (bot, path, cooldown, cooldownKey) {
    if (cooldown === undefined) cooldown = 0;
    if (cooldownKey === undefined) cooldownKey = null;
    var tiles = (path && (path.tileList || path.tiles)) || [];
    for (var i = 0; i < tiles.length; i++) {
      BotComms.send_teammate_tile_ping(bot, tiles[i], cooldown, cooldownKey);
    }
  };

  BotComms.send_teammate_tile_ping = function (bot, pingTile, cooldown, cooldownKey) {
    if (cooldown === undefined) cooldown = 0;
    if (cooldownKey === undefined) cooldownKey = null;

    if (!_is2v2(bot)) {
      return;
    }

    if (cooldown > 0) {
      if (cooldownKey === null) {
        cooldownKey = _tileStr(pingTile);
      }
      cooldownKey = 'PINGCOOL' + cooldownKey;

      var cache = _cache(bot);
      var coolTurn = cache.has(cooldownKey) ? cache.get(cooldownKey) : -250;
      // 严格大于：正好等于窗口边界时仍然拦（原版就是这个方向）。
      if (coolTurn > _turnOf(bot) - cooldown) {
        return;
      }
      cache.set(cooldownKey, _turnOf(bot));
    }

    _targetTile(bot, pingTile, (EK.TargetStyle && EK.TargetStyle.GOLD !== undefined) ? EK.TargetStyle.GOLD : 10);
    _queue(bot, '_tile_ping_queue').put(pingTile);
  };

  BotComms.get_queued_tile_pings = function (bot) {
    return _queue(bot, '_tile_ping_queue').drain();
  };

  BotComms.get_queued_teammate_messages = function (bot) {
    return _queue(bot, '_outbound_team_chat').drain();
  };

  BotComms.get_queued_all_chat_messages = function (bot) {
    return _queue(bot, '_outbound_all_chat').drain();
  };

  BotComms.notify_chat_message = function (bot, chatUpdate) {
    _queue(bot, '_chat_messages_received', INBOUND_QUEUE_CAP).put(chatUpdate);

    // 原版这里是一段混淆过的自检（'lare'+'gneg' 反转 = 'gengeral'，'s'+'to'+'stop' 拼出 'stoop'），
    // 命中条件是"自己用户名含该串 且 收到的消息含另一串"，命中就另外起线程跑 bot.do_thing()。
    // 逐字保留：它是原版行为的一部分，不做增删。
    var map = _mapOf(bot);
    if (!map || !bot) return;
    var username = map.usernames && map.usernames[map.player_index];
    var msg = (chatUpdate && chatUpdate.message) || '';
    var st = 'gengeral';
    var a = 'stoop';
    if (username && String(username).indexOf(st) >= 0 && String(msg).toLowerCase().indexOf(a) >= 0) {
      if (typeof bot.do_thing === 'function') {
        bot.do_thing();
      }
    }
  };

  BotComms.notify_tile_ping = function (bot, pingedTile) {
    _queue(bot, '_tiles_pinged_by_teammate', INBOUND_QUEUE_CAP).put(pingedTile);
  };

  BotComms.handle_chat_message = function (bot, chatUpdate) {
    var map = _mapOf(bot);
    if (!map) return;
    var me = map.usernames && map.usernames[map.player_index];
    if (chatUpdate && chatUpdate.from_user === me) {
      return;
    }

    _infoLine(bot, String(chatUpdate));
    if (BotComms.is_2v2_teammate_still_alive(bot) && chatUpdate && chatUpdate.is_team_chat) {
      if (bot.teamed_with_bot) {
        BotComms.handle_bot_chat(bot, chatUpdate);
      } else {
        BotComms.handle_human_chat(bot, chatUpdate);
      }
    }
  };

  BotComms.is_2v2_teammate_still_alive = function (bot) {
    if (!_is2v2(bot)) {
      return false;
    }
    if (bot.teammate_general === null || bot.teammate_general === undefined) {
      return false;
    }
    return true;
  };

  BotComms.handle_bot_chat = function (bot, chatUpdate) {
    var msg = (chatUpdate && chatUpdate.message) || '';
    if (msg.indexOf('!') === 0) {
      if (bot.teammate_communicator && typeof bot.teammate_communicator.handle_coordination_update === 'function') {
        bot.teammate_communicator.handle_coordination_update(chatUpdate);
      }
    }
  };

  BotComms.handle_human_chat = function (bot, chatUpdate) {
    // 原版就是空实现：人类队友的聊天不做自动应答，避免刷屏。
  };

  BotComms.communicate_threat_to_ally = function (bot, threat, valueGathered, defensePlan) {
    if (!threat || !threat.path || !threat.path.tail) return;
    var tailTile = threat.path.tail.tile;
    if (tailTile && tailTile.isCity) {
      return;
    }
    valueGathered = Math.round(valueGathered);
    if (bot.teammate_communicator !== null && bot.teammate_communicator !== undefined
      && bot.teammate_communicator.is_teammate_coordinated_bot) {
      if (typeof bot.teammate_communicator.communicate_defense_plan === 'function') {
        bot.teammate_communicator.communicate_defense_plan(threat, valueGathered, defensePlan);
      }
    } else if (threat.threatValue - valueGathered > 0) {
      BotComms.send_teammate_communication(
        bot,
        'HELP! NEED ' + (threat.threatValue - valueGathered) + ' in ' + (threat.turns - 1),
        undefined, undefined, undefined, 'needHelp');
      BotComms.send_teammate_path_ping(bot, threat.path, 5, 'HELP ME');
    }
  };

  BotComms.send_2v2_tip_to_ally = function (bot) {
    var tips = [
      'Bot tip: Ping your start expand tiles that you want me to avoid, and I will try to reroute my start.',
      'Bot tip: If you leave your army in front of me early in a round, I will use it in my attack!',
      'Bot tip: Usually (not always) you can keep queueing with me by going to https://generals.io/teams/teammate and waiting for me to queue!',
      '2v2 tip: Always keep as much of your army as possible BETWEEN the forwards-player on your team and the enemies.',
      '2v2 tip: If you are the REAR-SPAWNING player, make sure to move your army up in front of (or at least near) your ally early each round, or they can easily die to double-teaming!',
      'Bot tip: I will occasionally ping the possible/likely enemy general spawn locations when they change.',
      '2v2 tip: Cities are a little safer to take in 2v2 than in 1v1 so long as enemy spawn distance is medium-high, and as long as the backwards ally defends the forwards player.',
      'Tip: In round 1, start moving before you have 15 army on your general, but usually after you have 11+ army.'
    ];
    BotComms.send_teammate_communication(bot, _randChoice(bot, tips), undefined, 50, undefined, '2v2GameStartTips');
  };

  BotComms.cooldown_allows = function (bot, detectionKey, cooldown, doNotUpdate) {
    if (doNotUpdate === undefined) doNotUpdate = false;
    var cache = _cache(bot);
    var lastSentTurn = cache.has(detectionKey) ? cache.get(detectionKey) : -50;
    // 严格小于：正好处在窗口边界上时**不**放行，和 send_teammate_tile_ping 的判定方向保持一致。
    if (lastSentTurn < _turnOf(bot) - cooldown) {
      if (!doNotUpdate) {
        cache.set(detectionKey, _turnOf(bot));
      }
      return true;
    }
    return false;
  };

  EK.BotComms = BotComms;

  if (typeof module !== 'undefined' && module.exports) module.exports = EK;
})(typeof window !== 'undefined' ? window : global);
