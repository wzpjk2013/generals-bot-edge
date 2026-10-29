/*
 * 页面主世界（MAIN world）的接线层：
 *   - 拦截 window.socket（generals.io 在 bundle 里执行 n.g.socket = at），
 *     拿到 socket.io 实例后订阅 game_start / game_update，并在每回合下发 attack。
 *   - attack 走的是官方前端自己用的同一个 emit，事件名会被官方包装层压成协议下标，
 *     所以不需要自己维护协议表。
 *   - 面板用 Shadow DOM，避免和站点样式打架。
 *
 * 面板右上角显示的是**扩展清单里的版本号**（由 bridge.js 从 chrome.runtime.getManifest()
 * 读出来传进来）。看不到版本号 = 隔离世界的 bridge 没跑起来；版本号是旧的 = 扩展没重载。
 * 这两个都是"改了代码却没生效"的典型现场，所以放到标题上，一眼能看到。
 */
(function () {
  'use strict';

  var GB = window.__GB;
  if (!GB) return;

  var state = new GB.GameState();
  GB.state = state;

  // 服务器每个半回合（内部 turn）只从每个玩家的 inputBuffer 里取一条攻击执行
  // （bundle 里 getPlayerMovesPriorityV2 取完一条就 break），屏幕上的一个回合
  // = 2 个半回合，所以真实上限是 2 条/回合。我们每个半回合都重新决策，只下发
  // 1 条：多发不会立刻生效，只会按回合排队，等于给未来回合灌过时命令。
  var settings = {
    enabled: true,
    maxMoves: 1
  };
  GB.settings = settings;

  // 面板上能看到的计数器。"不走子"的时候要靠它分清是哪一段坏了：
  //   ev 一直是 0        → 根本没收到对局事件（订阅/命名对不上）
  //   ev 在涨、dec 是 0  → 事件到了但引擎没给出动作
  //   dec 在涨、snd 是 0 → 有动作但 emit 失败
  var stats = {
    moves: 0,
    last: '-',
    blocked: '',
    error: '',
    ev: 0,        // 收到多少个对局事件
    lastEv: '-',  // 最近一个事件名
    dec: 0,       // 引擎给出决策的次数
    snd: 0,       // 成功 emit 出去的条数
    pid: -1       // 服务器告诉我们的玩家下标
  };
  var lastDrive = { turn: -1, at: 0 };
  // 第 4 个参数是官方前端的 attackIndex（单调递增序号），不是 turn。
  // 服务端只做 Math.max 推进，所以本地自增即可。
  var attackSeq = 0;
  var socketRef = null;
  var ui = null;
  var version = '';

  function log() {
    var args = Array.prototype.slice.call(arguments);
    args.unshift('[GBAuto]');
    console.log.apply(console, args);
  }

  function postSettings() {
    try {
      window.postMessage({ __gb: 'save', settings: settings }, '*');
    } catch (e) {
      /* 忽略：bridge 不在也能跑 */
    }
  }

  // 公开匹配和自建房间一视同仁：进对局就接管
  function drive() {
    var S = state;
    stats.blocked = '';
    if (!S.ready || S.playerIndex < 0 || S.ended) return;
    if (!settings.enabled) {
      stats.blocked = '已暂停';
      return;
    }
    if (S.turn === lastDrive.turn) return;

    var now = performance.now();
    if (now - lastDrive.at < 100) return;
    lastDrive.turn = S.turn;
    lastDrive.at = now;

    var moves;
    try {
      moves = GB.bot.plan(S, settings);
    } catch (e) {
      stats.error = String((e && e.message) || e);
      log('plan failed', e);
      return;
    }
    if (moves && moves.length) stats.dec += 1;
    if (!moves.length || !socketRef) return;

    // 每个半回合只下发一条；服务端本回合也只消费一条，多发只会积压成过时命令。
    // mv[2] 是「只送一半」（协议里的 is50）：引擎按一半算的账必须原样告诉服务器，
    // 否则本地以为将军留了一半、服务器把它全送出去，下一步就全是空过。
    var mv = moves[0];
    try {
      socketRef.emit('attack', mv[0], mv[1], !!mv[2], attackSeq++);
      stats.snd += 1;
    } catch (e) {
      stats.error = 'emit: ' + ((e && e.message) || e);
    }

    stats.moves += 1;
    stats.last = mv[0] + '>' + mv[1];
  }

  // 事件处理集中在这里：socket 订阅和 GB.feed（调试/自动化注入）走同一份
  var handlers = {
    game_start: function (m) {
      state.applyStart(m);
      lastDrive.turn = -1;
      stats.last = '-';
      stats.error = '';
    },
    game_update: function (m) {
      state.applyUpdate(m);
      drive();
    },
    game_over: function () {
      state.end();
    },
    game_won: function () {
      state.end();
    },
    game_lost: function () {
      state.end();
    }
  };

  function note(name, payload) {
    stats.ev += 1;
    stats.lastEv = name;
    if (state.playerIndex >= 0) stats.pid = state.playerIndex;
    GB.lastPayload = payload;
  }

  // 事件可能从两条路进来（我们自己按名字订阅 + 挂在官方订阅上的 tap），
  // 同一个包在两条路上是**同一个对象引用**，所以按引用去重最准：
  // 用 turn 去重会漏掉同一 tick 的两条更新，按名字去重会把 tick 吃掉。
  var lastPayload = null;

  function feed(name, payload) {
    var h = handlers[name];
    if (!h) return false;
    if (payload && payload === lastPayload) return true;
    lastPayload = payload;
    note(name, payload);
    h(payload);
    return true;
  }
  GB.feed = feed;

  /*
   * 给官方前端的 .on 包一层。
   *
   * 我们自己按事件名订阅是主路径（官方 bundle 里就是 at.on("game_start", ...) 这种
   * 字面名字）。但协议层是官方自己压的，万一哪天换成下标或者加一层中介，
   * 我们按名字订阅就会静默失效——面板上表现成"事件 0"，而游戏一切正常。
   * 官方注册的回调拿到的是**它自己解码后的 payload**，所以只要挂在它的订阅上，
   * 不管名字怎么变都能拿到数据。
   */
  function tapOn(sock) {
    if (sock.__gbTapped) return;
    var rawOn = sock.on;
    if (typeof rawOn !== 'function') return;
    try {
      sock.on = function (name, fn) {
        if (typeof fn !== 'function' || !handlers[name]) return rawOn.apply(this, arguments);
        var self = this;
        return rawOn.call(self, name, function (payload) {
          // 官方回调必须照常执行——它负责把地图写进 redux、重画棋盘，
          // 少一次屏幕就停住。我们只是先插一脚，不能顶掉它。
          try {
            feed(name, payload);
          } catch (e) {
            log('tap failed: ' + name, e);
          }
          return fn.apply(self, arguments);
        });
      };
      sock.__gbTapped = true;
    } catch (e) {
      log('tapOn failed', e);
    }
  }

  function attach(sock) {
    if (!sock || sock === socketRef) return;
    if (typeof sock.emit !== 'function' || typeof sock.on !== 'function') return;
    socketRef = sock;
    GB.socket = sock;
    log('socket attached');

    Object.keys(handlers).forEach(function (name) {
      try {
        sock.on(name, function (payload) {
          feed(name, payload);
        });
      } catch (e) {
        log('subscribe failed: ' + name, e);
      }
    });
    tapOn(sock);
  }

  try {
    Object.defineProperty(window, 'socket', {
      configurable: true,
      enumerable: true,
      get: function () {
        return socketRef;
      },
      set: function (v) {
        attach(v);
      }
    });
  } catch (e) {
    log('socket trap failed', e);
  }

  // 兜底：万一站点换成交互式赋值方式，直接轮询
  setInterval(function () {
    if (socketRef) return;
    var s = window.socket;
    if (s && typeof s.emit === 'function') attach(s);
  }, 300);

  /* ---------------- 面板 ---------------- */

  var PANEL = [
    '<style>',
    ':host{all:initial}',
    '.box{position:fixed;top:70px;right:12px;z-index:2147483646;width:224px;',
    'background:rgba(16,20,24,.92);color:#e6edf3;border:1px solid #39424d;border-radius:10px;',
    'padding:9px 11px;font:12px/1.55 "Segoe UI",system-ui,sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.45)}',
    '.hd{display:flex;justify-content:space-between;align-items:center;cursor:pointer;',
    'font-weight:600;color:#7fd1ff;letter-spacing:.02em}',
    '.ver{color:#8c99a6;font-weight:400;font-size:11px;margin-left:6px}',
    '.row{display:flex;justify-content:space-between;align-items:center;gap:8px;margin-top:5px}',
    '.k{color:#8c99a6;white-space:nowrap}',
    '.v{color:#dbe6ef;text-align:right;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.sw{flex:0 0 auto;width:34px;height:18px;border-radius:9px;background:#3a434d;position:relative;',
    'cursor:pointer;transition:background .15s}',
    '.sw.on{background:#2f9e52}',
    '.sw i{position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;',
    'background:#fff;transition:left .15s}',
    '.sw.on i{left:18px}',
    'input{width:42px;background:#0b0f13;color:#e6edf3;border:1px solid #4a5560;border-radius:4px;',
    'padding:1px 4px;font:inherit;text-align:right}',
    '.err{color:#ff8a80}',
    '.ok{color:#5ddc85}',
    '.warn{color:#ffc857}',
    '.dim{color:#7d8894}',
    '</style>',
    '<div class="box">',
    '  <div class="hd"><span>AutoPilot<span class="ver" id="ver"></span></span><span id="fold">−</span></div>',
    '  <div id="body">',
    '    <div class="row"><span class="k">启用</span><span class="sw" id="sw-enable"><i></i></span></div>',
    '    <div class="row"><span class="k">每半回合步数</span><input id="in-max" type="number" min="1" max="2" step="1" title="服务器每个半回合只执行 1 条，显示回合 = 2 个半回合，上限 2"></div>',
    '    <div class="row"><span class="k">状态</span><span class="v" id="st">未开局</span></div>',
    '    <div class="row"><span class="k">回合</span><span class="v" id="st2">-</span></div>',
    '    <div class="row"><span class="k">地块 / 兵力</span><span class="v" id="st3">-</span></div>',
    '    <div class="row"><span class="k">事件 / 决策 / 下发</span><span class="v" id="st6">0 / 0 / 0</span></div>',
    '    <div class="row"><span class="k">最近</span><span class="v" id="st5">-</span></div>',
    '  </div>',
    '</div>'
  ].join('');

  function el(root, id) {
    return root.getElementById(id);
  }

  function setSwitch(node, on) {
    if (!node) return;
    node.classList.toggle('on', !!on);
  }

  function ensureUI() {
    if (ui || !document.body) return;
    var host = document.createElement('div');
    host.id = 'gb-autopilot-host';
    var root = host.attachShadow({ mode: 'open' });
    root.innerHTML = PANEL;
    document.body.appendChild(host);

    ui = {
      root: root,
      enabled: el(root, 'sw-enable'),
      max: el(root, 'in-max'),
      ver: el(root, 'ver'),
      st: el(root, 'st'),
      st2: el(root, 'st2'),
      st3: el(root, 'st3'),
      st5: el(root, 'st5'),
      st6: el(root, 'st6'),
      body: el(root, 'body'),
      fold: el(root, 'fold')
    };

    ui.enabled.addEventListener('click', function () {
      settings.enabled = !settings.enabled;
      postSettings();
      refresh();
    });
    ui.max.addEventListener('change', function () {
      var v = parseInt(ui.max.value, 10);
      if (!(v >= 1 && v <= 2)) v = 1;
      settings.maxMoves = v;
      postSettings();
      refresh();
    });
    var folded = false;
    el(root, 'fold').parentNode.addEventListener('click', function () {
      folded = !folded;
      ui.body.style.display = folded ? 'none' : '';
      ui.fold.textContent = folded ? '+' : '−';
    });

    refresh();
  }

  // 面板每秒刷两次，任何一处抛异常都会让所有行停在旧值上（"数字不动"的经典现场），
  // 所以整段包起来：出错就把错误写进状态行，其余行照常更新。
  function refresh() {
    if (!ui) return;
    try {
      setSwitch(ui.enabled, settings.enabled);
      if (document.activeElement !== ui.max) ui.max.value = settings.maxMoves;
      if (ui.ver) ui.ver.textContent = version ? 'v' + version : '';

      var S = state;
      var status;
      var cls = '';
      if (!S.ready) {
        // 没开局就是没开局，别用"等待连接/等开局"这种含糊话——
        // 两种情况在这里合并成一个词，细节挪到 title 里。
        status = '未开局';
        cls = 'dim';
      } else if (S.ended) status = '对局结束';
      else if (stats.blocked) {
        status = stats.blocked;
        cls = 'warn';
      } else status = '运行中';

      var tip =
        (socketRef ? 'socket 已抓到' : 'socket 还没抓到（陷阱没命中，任何事件都收不到）') +
        '；已收 ' + stats.ev + ' 个事件，最近 ' + stats.lastEv +
        '；玩家下标 ' + (S.playerIndex >= 0 ? S.playerIndex : '-');

      ui.st.textContent = stats.error || status;
      ui.st.className = 'v ' + (stats.error ? 'err' : cls);
      ui.st.title = tip + (stats.error ? ' / 错误：' + stats.error : '');

      if (!S.ready) {
        ui.st2.textContent = '-';
        ui.st3.textContent = '-';
      } else {
        var tiles = 0;
        var army = 0;
        for (var i = 0; i < S.n; i++) {
          if (S.terrain[i] === S.playerIndex) {
            tiles++;
            army += S.armies[i];
          }
        }
        ui.st2.textContent = String(S.turn >> 1);
        ui.st3.textContent = tiles + ' / ' + army;
      }
      ui.st6.textContent = stats.ev + ' / ' + stats.dec + ' / ' + stats.snd;
      ui.st6.title = '事件 / 引擎给出决策 / 成功下发。事件一直 0 是订阅问题；事件在涨但没有决策是引擎问题';
      ui.st5.textContent = stats.last;
    } catch (e) {
      try {
        ui.st.textContent = '面板异常: ' + ((e && e.message) || e);
        ui.st.className = 'v err';
      } catch (e2) {
        /* 连这个都失败就只能等控制台 */
      }
    }
  }

  window.addEventListener('message', function (e) {
    var d = e.data;
    if (e.source !== window || !d) return;
    if (d.__gb === 'version' && typeof d.version === 'string') {
      version = d.version;
      refresh();
      return;
    }
    if (d.__gb !== 'settings') return;
    var s = d.settings || {};
    if (typeof s.enabled === 'boolean') settings.enabled = s.enabled;
    if (Number.isInteger(s.maxMoves) && s.maxMoves >= 1 && s.maxMoves <= 2) {
      settings.maxMoves = s.maxMoves;
    }
    refresh();
  });

  // 隔离世界的 bridge 可能比本脚本后执行，也可能先执行（谁先把版本号推过来都行），
  // 所以这里主动要一次，再隔一秒补一次，两边都不依赖加载顺序。
  function askVersion() {
    try {
      window.postMessage({ __gb: 'hello' }, '*');
    } catch (e) {
      /* 忽略 */
    }
  }
  askVersion();
  setTimeout(askVersion, 800);

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', ensureUI);
  } else {
    ensureUI();
  }
  setInterval(refresh, 400);
})();
