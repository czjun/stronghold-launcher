// overlay/electron/src/local-server.js — [sp-ext] 本地单人：在客户端内起一个内嵌服务器子进程
//
// 用途：不依赖任何线上服务器，直接本地开一局单人。
// 做法：把 server/ data/ public/ 等打进安装包（见 package.json build.files 的 server-embedded/**），
//       启动时用 Electron 自带的 Node 以子进程方式跑 server/index.js，等 /healthz 就绪后把窗口指过去。
//
// 设计要点：
//   · 端口：优先用固定 127.0.0.1:PORT，被占用就自动找空闲端口（不弹系统防火墙）
//   · 数据目录：<数据根>/local-server（素材仍用客户端本机素材库，两者互不干扰）
//   · 生命周期：客户端退出时一并结束子进程；也可手动「停止本地服务器」
//   · 失败可见：子进程 stderr 写进客户端日志，启动失败给出明确原因

const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const net = require('node:net');

/** Electron 以 ELECTRON_RUN_AS_NODE=1 跑脚本时，electron 可执行文件就是 Node —— 不必额外带 node.exe。 */
function nodeRuntime() {
  // 打包后：process.execPath 是 StrongholdLauncher.exe；用 RUN_AS_NODE 复用其内置 Node
  return { exe: process.execPath, env: { ELECTRON_RUN_AS_NODE: '1' } };
}

/** 找一个可用端口（先试 preferred，被占用就随机）。 */
async function findPort(preferred = 3001) {
  const tryBind = (port) => new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(null));
    srv.once('listening', () => srv.close(() => resolve(port)));
    srv.listen(port, '127.0.0.1');
  });
  const p = await tryBind(preferred);
  if (p) return p;
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.once('listening', () => { const port = srv.address().port; srv.close(() => resolve(port)); });
    srv.listen(0, '127.0.0.1');
  });
}

/**
 * 启动内嵌服务器。
 * @param {{ appRoot: string, dataRoot: string, preferredPort?: number, log?: Function, onProgress?: Function }} o
 *   appRoot   ：内嵌服务器根目录（打包后 = resources/server-embedded）
 *   dataRoot  ：客户端数据根（本地服务器的 world 数据放这里）
 * @returns {Promise<{ url: string, port: number, stop: Function, child: any }>}
 */
async function startLocalServer(o) {
  const { appRoot, dataRoot, preferredPort = 3001, log = () => {}, onProgress = () => {} } = o;

  if (!appRoot || !fs.existsSync(path.join(appRoot, 'start-local.mjs'))) {
    throw new Error('客户端里没有找到内嵌服务器（server-embedded/start-local.mjs）');
  }

  const port = await findPort(preferredPort);
  onProgress({ phase: 'start', text: `启动本地服务器（端口 ${port}）…` });

  // 本地服务器的持久数据（存档、房间等）
  const serverData = path.join(dataRoot, 'local-server');
  fs.mkdirSync(serverData, { recursive: true });

  const rt = nodeRuntime();
  const env = {
    ...process.env,
    ...rt.env,
    PORT: String(port),
    HOST: '127.0.0.1',
    // 关掉不需要的：插件工作台、素材 CDN、线上公告管理密码无关紧要
    SP_STUDIO: 'off',
    SP_ASSET_CDN: '',
    SP_ADMIN_PASSWORD: '',
    SP_VERIFY: 'off',
    SP_COMBAT: '',
  };

  const child = spawn(rt.exe, [path.join(appRoot, 'start-local.mjs')], {
    cwd: appRoot,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  let outBuf = '';
  const onLine = (stream, line) => {
    if (!line) return;
    if (/error|fail|exception|throw/i.test(line)) log(`[本地服务器:${stream}] ${line}`);
    else log(`[本地服务器] ${line}`);
  };
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (d) => {
    outBuf += d;
    const lines = outBuf.split(/\r?\n/);
    outBuf = lines.pop() || '';
    for (const l of lines) onLine('out', l);
  });
  child.stderr.on('data', (d) => {
    for (const l of String(d).split(/\r?\n/)) onLine('err', l);
  });

  const deadline = Date.now() + 45000;
  const base = `http://127.0.0.1:${port}`;

  // 等 /healthz 200
  while (Date.now() < deadline) {
    if (child.exitCode != null) break;
    try {
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), 2000);
      const r = await fetch(base + '/healthz', { signal: ac.signal });
      clearTimeout(t);
      if (r.ok) {
        const body = await r.json().catch(() => ({}));
        onProgress({ phase: 'ready', text: '本地服务器已就绪', version: body.app });
        log(`本地服务器已就绪：${base}（版本 ${body.app || '?'}）`);
        return {
          url: base,
          port,
          child,
          stop: () => stopChild(child),
        };
      }
    } catch { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 500));
  }

  const reason = child.exitCode != null
    ? `内嵌服务器启动失败（退出码 ${child.exitCode}），详见日志`
    : '内嵌服务器启动超时（45 秒未就绪）';
  try { stopChild(child); } catch { /* ignore */ }
  throw new Error(reason);
}

function stopChild(child) {
  try {
    if (!child || child.exitCode != null) return;
    child.kill();
    // Windows 下 SIGTERM 对子进程树不一定生效，兜底强杀
    setTimeout(() => { try { if (child.exitCode == null) child.kill('SIGKILL'); } catch { /* ignore */ } }, 3000).unref?.();
  } catch { /* ignore */ }
}

module.exports = { startLocalServer, findPort };
