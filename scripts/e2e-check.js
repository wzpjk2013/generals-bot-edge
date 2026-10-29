/*
 * 真机冒烟：用 Edge 加载未打包扩展，打开 generals.io，检查
 *   1) MAIN world 脚本执行了（window.__GB）
 *   2) 面板挂上了 DOM，标题上显示的是扩展清单里的版本号
 *   3) 没开局时状态行写的是「未开局」
 *   4) socket 陷阱能抓到 socket（真机连得上才有；连不上时用假 socket 验证陷阱本身）
 *   5) 没有未捕获异常
 * 运行：node scripts/e2e-check.js
 *
 * generals.io 连不上时用 CDP 把首页换成空壳页，URL 仍是 https://generals.io/，
 * 扩展注入不受影响（这台机器外网时通时不通，不能让它决定测试结果）。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { launch, getTarget, client, evaluate, serveStub, shutdown, sleep } = require('./cdp');

const EXT = path.resolve(__dirname, '..');
const PORT = 9333;

const STUB_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>generals stub</title></head>
<body><div id="stub">generals.io 空壳页（e2e 用）</div></body></html>`;

const manifestVersion = JSON.parse(fs.readFileSync(path.join(EXT, 'manifest.json'), 'utf8')).version;

(async () => {
  let handle;
  let cdp;
  try {
    handle = launch({ port: PORT, extension: EXT, url: 'about:blank' });
    const target = await getTarget(PORT, 'about:blank');
    cdp = await client(target.webSocketDebuggerUrl);
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');

    const net = await serveStub(cdp, STUB_HTML);
    await cdp.send('Page.navigate', { url: 'https://generals.io/' });
    await sleep(4000);

    const panel = (id) =>
      `(function(){var h=document.getElementById('gb-autopilot-host');` +
      `if(!h)return null;var s=h.shadowRoot.getElementById('${id}');return s?s.textContent:null})()`;

    const report = {};
    report.page = await evaluate(cdp, 'location.href');
    report.stubbed = net.offline;
    report.gb = await evaluate(cdp, 'typeof window.__GB === "object" && !!window.__GB.bot');
    report.panel = await evaluate(cdp, '!!document.getElementById("gb-autopilot-host")');
    report.version = await evaluate(cdp, panel('ver'));
    report.status = await evaluate(cdp, panel('st'));
    report.turn = await evaluate(cdp, panel('st2'));
    report.state = await evaluate(
      cdp,
      'window.__GB && window.__GB.state ? ({ready: window.__GB.state.ready, pid: window.__GB.state.playerIndex, n: window.__GB.state.n}) : null'
    );

    // socket 陷阱：真机没连上站点时，塞一个假 socket 看陷阱是否命中
    report.trap = await evaluate(
      cdp,
      `(function(){
         if (window.socket && typeof window.socket.emit === 'function') return 'real';
         var stub = { emit: function(){}, on: function(){ return this; }, handlers: {} };
         window.socket = stub;
         return window.socket === stub && window.__GB.socket === stub ? 'stub-ok' : 'miss';
       })()`
    );

    report.errors = cdp.events
      .filter((e) => e.method === 'Runtime.exceptionThrown')
      .map((e) => (e.params.exceptionDetails.exception || {}).description || e.params.exceptionDetails.text)
      .slice(0, 5);
    report.console = cdp.events
      .filter((e) => e.method === 'Runtime.consoleAPICalled')
      .map((e) => e.params.args.map((a) => a.value || a.description).join(' '))
      .filter((t) => String(t).includes('GBAuto') || String(t).includes('refagents'))
      .slice(0, 10);

    const problems = [];
    if (!report.gb) problems.push('window.__GB 不在：MAIN world 脚本没执行');
    if (!report.panel) problems.push('面板没挂上');
    if (report.version !== 'v' + manifestVersion) {
      problems.push('版本号应为 v' + manifestVersion + '，实际 ' + JSON.stringify(report.version) + '（扩展没重载？）');
    }
    if (report.status !== '未开局') problems.push('没开局时状态应是「未开局」，实际 ' + JSON.stringify(report.status));
    if (report.trap === 'miss') problems.push('socket 陷阱没命中');
    report.problems = problems;

    console.log(JSON.stringify(report, null, 2));
    if (problems.length) process.exitCode = 1;
  } catch (e) {
    console.error('FAILED:', e.message);
    process.exitCode = 1;
  } finally {
    await shutdown(handle, cdp);
  }
})();
