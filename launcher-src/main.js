// main.js — Electron 客户端主进程（M1+M2）
//
// 设计要点（见 docs/06-Electron客户端.md）：
//   · 页面/JS/API 走网络 → **各服自己的 UI/规则保真**
//   · /assets/** 由 protocol.handle 从本机磁盘直出（含 Range 206），未命中回退原服
//   · 选择界面用 ipc 从主进程取服务器列表（避开 CORS）
//   · 「返回大厅」= 原生菜单 / Ctrl+H（彻底告别 CDP 注入）
const { app, BrowserWindow, protocol, session, net, Menu, shell, ipcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { createAssetInterceptor } = require('./src/assets.js');
const upd = require('./src/update.js');
const setup = require('./src/assets-setup.js');
const localSrv = require('./src/local-server.js');

// ★ 中转站（目录服务）：0.3.3 起旧「中转大厅」失效，改为
//   首次进入手动输入中转站地址 → 记住（relay.json）→ 之后自动使用，也可随时修改。
// ★ 不内置任何中转站地址：避免为特定站点背书/争议。
//   用户自己填写一次（会记进 relay.json 的 history），之后从「快捷地址」里点选。
//   这里保留数组是为了接口形状稳定（relayQuickList 仍按「预设 + 历史」合并）。
const RELAY_PRESETS = [];
// ★ 数据与素材都放在【安装目录】下 —— 随游戏一起、好找、卸载即清（与主流游戏一致）。
//   优先级：SP_DATA_DIR / SP_ASSETS_DIR（高级用法）→ 安装目录 → LOCALAPPDATA 回退（安装目录不可写时）
//   注意：setPath('userData') 必须在 app ready 之前调用，所以这段在模块顶层。
// ★ 数据根放在【安装目录的同级目录】<安装目录名>-data，**不能**放在安装目录里面 ——
//   实测：手动跑 setup.exe 覆盖安装时 NSIS 会清空安装目录，1.1 GB 素材被删、又要重新解压。
//   （electron-updater 的差分更新不清目录，所以那条路没问题；但手动安装很常见。）
function migrateOldData(newRoot, installDir) {
  for (const sub of ['assets', 'cache']) {
    try {
      const from = path.join(installDir, sub);
      const to = path.join(newRoot, sub);
      if (!fs.existsSync(from)) continue;
      let empty = true;
      try { empty = !fs.existsSync(to) || fs.readdirSync(to).length === 0; } catch (e) { empty = false; }
      if (!empty) continue;
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.renameSync(from, to);                      // 同盘是秒级重命名；跨盘会抛错 → 忽略，继续用旧位置
      log(`已迁移 ${sub} → ${to}`);
    } catch (e) { log(`迁移 ${sub} 失败（忽略）：${e.message}`); }
  }
}

function resolveDataRoot() {
  const envD = String(process.env.SP_DATA_DIR || '').trim();
  if (envD) return { root: envD, why: 'SP_DATA_DIR' };
  // 便携版(portable)：程序实际被解压到临时目录运行，exe 路径指向临时目录 → 必须用
  // electron-builder 提供的 PORTABLE_EXECUTABLE_DIR（= 用户放 portable.exe 的那个目录）
  const base = process.env.PORTABLE_EXECUTABLE_DIR
    ? process.env.PORTABLE_EXECUTABLE_DIR
    : (app.isPackaged ? path.dirname(app.getPath('exe')) : __dirname);
  // 同级数据目录：<父目录>\<安装目录名>-data\   （portable 则是 <exe所在目录>-data）
  const sibling = path.join(path.dirname(base), path.basename(base) + '-data');
  try {
    fs.mkdirSync(sibling, { recursive: true });
    const probe = path.join(sibling, '.sp-write-test');
    fs.writeFileSync(probe, 'x'); fs.rmSync(probe, { force: true });
    migrateOldData(sibling, base);                                       // 把安装目录里的旧素材/缓存搬出来
    return { root: sibling, why: (app.isPackaged ? '安装目录同级' : '开发目录同级') + '（' + path.basename(sibling) + '）' };
  } catch (e) {
    const fb = path.join(process.env.LOCALAPPDATA || app.getPath('appData'), 'StrongholdLauncher');
    try { fs.mkdirSync(fb, { recursive: true }); } catch (e2) { /* ignore */ }
    return { root: fb, why: '同级不可写 → LOCALAPPDATA 回退' };
  }
}
const DATA = resolveDataRoot();
try { app.setPath('userData', path.join(DATA.root, 'data')); } catch (e) { /* 保持默认 */ }
const ASSETS_DIR = String(process.env.SP_ASSETS_DIR || '').trim() || path.join(DATA.root, 'assets');

const LOG_FILE = () => path.join(app.getPath('userData'), 'launcher.log');
function log(...a) {
  const line = `[${new Date().toISOString().slice(11, 19)}] ${a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')}`;
  console.log(line);
  try { fs.appendFileSync(LOG_FILE(), line + '\n'); } catch { /* ignore */ }
}

// ---------------- 中转站地址：读取 / 保存 / 归一化 ----------------
const RELAY_FILE = () => path.join(app.getPath('userData'), 'relay.json');
function normalizeRelay(u) {
  let v = String(u || '').trim();
  if (!v) return '';
  if (!/^https?:\/\//i.test(v)) v = 'https://' + v;
  try { v = new URL(v).origin; } catch { v = v.replace(/\/+$/, ''); }
  return v;
}
function readRelay() {
  try {
    const j = JSON.parse(fs.readFileSync(RELAY_FILE(), 'utf8'));
    return normalizeRelay(j && j.url);
  } catch { return ''; }
}

// 用户自己输入过的中转站地址（历史列表）：新地址最前、去重、上限 MAX_RELAY_HISTORY
const MAX_RELAY_HISTORY = 8;

/** 只读历史列表（跳过无效项）。 */
function readRelayHistory() {
  try {
    const j = JSON.parse(fs.readFileSync(RELAY_FILE(), 'utf8'));
    const arr = Array.isArray(j && j.history) ? j.history : [];
    const out = [];
    for (const u of arr) {
      const v = normalizeRelay(u);
      if (v && !out.includes(v)) out.push(v);
      if (out.length >= MAX_RELAY_HISTORY) break;
    }
    return out;
  } catch { return []; }
}

/** 快捷地址 = 内置预设（保序）+ 历史（最近优先）+ 当前地址，去重。 */
function relayQuickList(currentUrl = '') {
  const out = [];
  const seen = new Set();
  const push = (u) => { const v = normalizeRelay(u); if (v && !seen.has(v)) { seen.add(v); out.push(v); } };
  for (const p of RELAY_PRESETS) push(p);
  for (const h of readRelayHistory()) push(h);
  if (currentUrl) push(currentUrl);
  return out;
}
function saveRelay(u) {
  const v = normalizeRelay(u);
  if (!v) {
    // 清空当前地址，但保留历史（下次还能一键选回来）
    try {
      const hist = readRelayHistory();
      if (hist.length) {
        fs.mkdirSync(path.dirname(RELAY_FILE()), { recursive: true });
        fs.writeFileSync(RELAY_FILE(), JSON.stringify({ url: '', history: hist, updatedAt: Date.now() }, null, 2));
      } else {
        fs.rmSync(RELAY_FILE(), { force: true });
      }
    } catch { /* ignore */ }
    return '';
  }
  try {
    // ★ 保存的地址同时进入历史（最近一次排最前）→ 下次启动就在快捷列表里
    const hist = readRelayHistory().filter((h) => h !== v);
    hist.unshift(v);
    fs.mkdirSync(path.dirname(RELAY_FILE()), { recursive: true });
    fs.writeFileSync(RELAY_FILE(), JSON.stringify({
      url: v,
      history: hist.slice(0, MAX_RELAY_HISTORY),
      updatedAt: Date.now(),
    }, null, 2));
  } catch (e) { log('保存中转站地址失败：' + e.message); }
  return v;
}

// ---------------- 上次进入的服务器（用于「与服务器同步素材」） ----------------
const LAST_SERVER_FILE = () => path.join(app.getPath('userData'), 'last-server.json');
function readLastServer() {
  try { const j = JSON.parse(fs.readFileSync(LAST_SERVER_FILE(), 'utf8')); return String((j && j.url) || ''); } catch { return ''; }
}
function writeLastServer(url) {
  const u = String(url || '').trim();
  if (!u) return;
  try {
    fs.mkdirSync(path.dirname(LAST_SERVER_FILE()), { recursive: true });
    fs.writeFileSync(LAST_SERVER_FILE(), JSON.stringify({ url: u, at: Date.now() }));
  } catch (e) { log('记录上次服务器失败：' + e.message); }
}
/** 不同中转站的目录接口字段名不一样，统一成界面用的形状。
 *  已知三种：
 *    · /api/servers  → {servers:[{title,url,region,version,notes,tags,status…}]}   (中转站 A 的 JSON 形状)
 *    · /api/servers  → {servers:[{name,address,regionLabel,note,health…}]}         (中转站 B 的 JSON 形状)
 *    · /api/entries  → {entries:[{name,url,online,humans,rooms,gameVersion…}]}     (中转站 C「门户」型 JSON 形状)
 */
function normalizeServers(list) {
  const out = [];
  for (const s of Array.isArray(list) ? list : []) {
    if (!s || typeof s !== 'object') continue;
    const url = String(s.url || s.address || s.origin || s.endpoint || '').trim();
    if (!url) continue;
    const ver = s.version || s.gameVersion || (s.status && s.status.version) || (s.health && s.health.raw && s.health.raw.app) || '';
    // 门户站点没有 status 对象，用 online/humans/rooms 合成，卡片才能显示在线数
    let status = s.status;
    if (!status && s.health) {
      const h = s.health; const hr = h.raw || {};
      status = {
        state: h.ok === false || h.reachable === false ? 'unreachable' : 'online',
        online: hr.humans != null ? hr.humans : undefined,
        rooms: hr.rooms,
        matches: hr.matches,
        sessions: hr.sessions,
        version: hr.app || ver,
        latencyMs: h.latencyMs,
      };
    }
    if (!status && (s.humans != null || s.online != null || s.gameVersion || s.checkedAt)) {
      status = {
        state: s.ok === false ? 'unreachable' : 'online',
        online: s.humans != null ? s.humans : s.online,
        rooms: s.rooms,
        matches: s.matches,
        sessions: s.sessions,
        version: s.gameVersion || ver,
        latencyMs: s.latencyMs,
      };
    }
    out.push({
      ...s,
      id: s.id != null ? s.id : url,
      title: s.title || s.name || s.label || s.server || url,
      url,
      region: s.region || s.regionLabel || '',
      notes: s.notes || s.note || '',
      maintainer: s.maintainer || s.owner || s.author || '',
      version: ver,
      tags: Array.isArray(s.tags) ? s.tags : (s.tag ? [s.tag] : []),
      statusPath: s.statusPath || '',
      status,
    });
  }
  return out;
}

/** 取中转站的服务器列表：按已知目录接口依次尝试（各站实现不同）。 */
const RELAY_DIR_ENDPOINTS = ['/api/servers', '/api/entries', '/api/list'];
async function fetchRelayServers(relay) {
  let lastErr = null;
  for (const ep of RELAY_DIR_ENDPOINTS) {
    try {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 8000);
      const r = await net.fetch(relay + ep, { headers: { Accept: 'application/json' }, signal: ac.signal });
      clearTimeout(timer);
      if (!r.ok) { lastErr = new Error(`${ep} 返回 HTTP ${r.status}`); continue; }
      const j = await r.json();
      const raw = Array.isArray(j) ? j : (j.servers || j.entries || j.list || j.data || []);
      const servers = normalizeServers(raw);
      if (servers.length) {
        log(`中转站目录 ${relay}${ep} → ${servers.length} 个节点`);
        return { servers, pollSeconds: (j && j.pollSeconds) || 30, endpoint: ep };
      }
      lastErr = new Error(`${ep} 没有可用节点`);
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('该地址没有可识别的目录接口');
}

let win = null;
// 回退用 net.fetch(req)：保留原始请求方法/请求头（否则对头敏感的服务器会 412/403，页面起不来）
//   bypassCustomProtocolHandlers 防止再次进入本处理器造成递归
const interceptor = createAssetInterceptor(ASSETS_DIR, (req) => net.fetch(req, { bypassCustomProtocolHandlers: true }), { log, cacheDir: path.join(DATA.root, 'cache') });

/** 正在进行的素材同步（退出时中止，避免"已经退出还在下载"） */
let syncCtl = null;

/** 读某个服务器的版本号（healthz.app） */
async function fetchServerVersion(server) {
  try {
    const r = await net.fetch(String(server).replace(/\/+$/, '') + '/healthz', { headers: { accept: 'application/json' } });
    if (!r.ok) return null;
    const j = await r.json();
    return j && j.app ? 'v' + String(j.app).replace(/^v/i, '') : null;
  } catch (e) { return null; }
}

/** 与服务器同步素材（大厅「同步素材」按钮 / 菜单共用）；进度通过 assets-sync-progress 推给渲染进程 */
async function runAssetSync(urlOverride, force = false) {
  const server = String(urlOverride || '').trim() || readLastServer();
  if (!server) return { ok: false, error: '还没有进入过服务器：请先在列表里进一次服务器，再同步素材。' };
  if (syncCtl) return { ok: false, error: '已有同步在进行中' };
  const send = (ch, data) => { try { if (win && !win.isDestroyed()) win.webContents.send(ch, data); } catch (e) { /* ignore */ } };

  // ★ 版本防护：目标服的版本与本机素材版本不一致时，不直接改本机素材（避免把 9服的素材刷成别的服的）
  if (!force) {
    const serverTag = await fetchServerVersion(server);
    const localTag = (setup.readTag(ASSETS_DIR) || {}).tag || null;
    if (serverTag && localTag && serverTag !== localTag) {
      log(`同步前置检查：服务器 ${serverTag} ≠ 本机素材 ${localTag} → 需要确认`);
      return { ok: false, reason: 'version-mismatch', server, serverTag, localTag };
    }
  }

  syncCtl = new AbortController();
  log(`开始同步素材 ← ${server}`);
  try {
    const r = await interceptor.syncFromServer(server, {
      log,
      signal: syncCtl.signal,
      onProgress: (p) => send('assets-sync-progress', p),
    });
    try {
      const st = await setup.status(ASSETS_DIR);
      if (r.tag && !r.stopped) setup.writeTag(ASSETS_DIR, { tag: r.tag, files: st.files, bytes: st.bytes, at: Date.now(), source: 'server:' + server });
      log(`素材同步结束：更新 ${r.updated}（新增 ${r.newFiles || 0}）/ 失败 ${r.failed}${r.stopped ? ' / 中止:' + r.stopped : ''} / 本机 ${st.files} 文件 ${(st.bytes / 1048576).toFixed(0)} MB / 版本 ${r.tag || '?'}`);
      r.files = st.files; r.totalBytes = st.bytes;
    } catch (e) { log('写素材版本标记失败：' + ((e && e.message) || e)); }
    return r;
  } catch (e) {
    log('素材同步失败：' + ((e && e.message) || e));
    return { ok: false, error: String((e && e.message) || e) };
  } finally {
    syncCtl = null;
  }
}
/** 本地单人服务器（null = 未启动） */
let localServer = null;

/** 内嵌服务器根目录：开发时 = electron/server-embedded；打包后 = resources/server-embedded */
function embeddedServerRoot() {
  const candidates = [
    path.join(__dirname, 'server-embedded'),                                   // 开发（源码目录）
    path.join(process.resourcesPath || '', 'server-embedded'),                 // 打包后（extraResources）
    path.join(app.getAppPath(), 'server-embedded'),                            // asar 内（若打进 asar）
    path.join(process.resourcesPath || '', 'app.asar.unpacked', 'server-embedded'),
  ];
  for (const c of candidates) {
    try { if (c && fs.existsSync(path.join(c, 'server', 'index.js'))) return c; } catch { /* ignore */ }
  }
  return null;
}

/** 启动本地单人服务器（幂等：已在跑就复用） */
async function ensureLocalServer() {
  if (localServer) return localServer;
  const root = embeddedServerRoot();
  if (!root) throw new Error('安装包里缺少内嵌服务器文件（server-embedded）');
  log('启动本地单人服务器…');
  localServer = await localSrv.startLocalServer({
    appRoot: root,
    dataRoot: DATA.root,
    preferredPort: 3001,
    log,
    onProgress: (p) => { try { if (win && !win.isDestroyed()) win.webContents.send('local-server-progress', p); } catch { /* ignore */ } },
  });
  return localServer;
}

/** 停止本地单人服务器 */
async function stopLocalServer() {
  if (!localServer) return false;
  try { localServer.stop(); } catch { /* ignore */ }
  log('本地单人服务器已停止');
  localServer = null;
  return true;
}

function createWindow() {
  win = new BrowserWindow({
    width: 1100, height: 820, backgroundColor: '#0c0f0e', show: false,
    title: '卫戍协议：盟约',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true, nodeIntegration: false,
      partition: 'persist:sp',              // 独立、持久的数据目录
    },
  });
  win.once('ready-to-show', () => win.show());
  win.on('closed', () => { win = null; });
  win.loadFile(path.join(__dirname, 'selection.html'));
}

/** 原生菜单：返回大厅 / 素材统计 / 打开数据目录 / 日志。 */
function buildMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: '游戏',
      submenu: [
        { label: `检查更新（当前 v${upd.currentVersion()}）`, click: async () => {
            log('手动检查更新…');
            const r = await upd.checkAndInstall(log, (p) => log(`下载 ${p}%`));
            if (!r.updated) { const { dialog } = require('electron'); dialog.showMessageBox({ message: r.reason || '已是最新', detail: `当前版本 v${upd.currentVersion()}` }); }
          } },
        { type: 'separator' },
        { label: '返回大厅（服务器选择）', accelerator: 'Ctrl+H', click: () => win && win.loadFile(path.join(__dirname, 'selection.html')) },
        { label: '修改中转站地址…', click: () => win && win.loadFile(path.join(__dirname, 'selection.html'), { hash: 'relay' }) },
        { label: '刷新（当前页面）', accelerator: 'F5', click: () => win && win.reload() },
        { type: 'separator' },
        { label: '退出', role: 'quit' },
      ],
    },
    {
      label: '素材',
      submenu: [
        { label: '素材来源统计', click: () => {
            const s = interceptor.stat;
            const mb = (n) => ((n || 0) / 1048576).toFixed(1);
            log('素材统计', s);
            const cache = interceptor.cacheSize();
            const text = [
              `本机命中      ${s.hit} 次（${mb(s.bytes)} MB）`,
              `回源缓存命中  ${s.cacheHit || 0} 次（上次回源落盘的结果）`,
              `回源网络      ${s.miss} 次（本次新缓存 ${s.cached || 0}）`,
              `已刷新到本机  ${s.refreshed || 0} 次（本机旧文件被更新）`,
              `版本不符回源  ${s.stale || 0} 次`,
              `非素材透传    ${s.passthrough || 0} 次`,
              '',
              `哈希绑定      ${interceptor.bindingCount()} 条（已持久化，重启后仍生效）`,
              `回源缓存目录  ${cache.files} 个文件 / ${mb(cache.bytes)} MB`,
            ].join('\n');
            win && win.webContents.executeJavaScript(`alert(${JSON.stringify(text)});`);
          } },
        { label: '代理缓存', submenu: [ 
          { label: '查看大小', click: () => { const c = interceptor.cacheSize(); const s = interceptor.stat; log('缓存 ' + JSON.stringify(c)); win && win.webContents.executeJavaScript('alert(' + JSON.stringify('回源缓存：' + c.files + ' 个文件 / ' + (c.bytes/1048576).toFixed(1) + ' MB\n目录：' + interceptor.cacheDir + '\n\n本次统计（仅统计素材请求）：\n  本机素材命中 ' + s.hit + ' 次 · ' + ((s.bytes||0)/1048576).toFixed(1) + ' MB\n  回源缓存命中 ' + s.cacheHit + ' 次\n  回源网络 ' + s.miss + ' 次（其中本次新缓存 ' + s.cached + '）\n  非素材请求透传 ' + (s.passthrough||0) + ' 次') + ')'); } },
          { label: '清理缓存', click: () => { try { fs.rmSync(interceptor.cacheDir, { recursive: true, force: true }); log('已清理代理缓存'); } catch (e) { log('清理失败：' + e.message); } } },
          { label: '打开缓存目录', click: () => shell.openPath(interceptor.cacheDir) },
        ] },
        { label: '打开素材目录', click: () => shell.openPath(ASSETS_DIR) },
        { label: '打开数据目录', click: () => shell.openPath(app.getPath('userData')) },
        { label: '打开日志', click: () => shell.openPath(LOG_FILE()) },
      ],
    },
    {
      label: '调试',
      submenu: [{ label: '开发者工具', accelerator: 'F12', click: () => win && win.webContents.toggleDevTools() }],
    },
  ]));
}

app.whenReady().then(() => {
  fs.mkdirSync(ASSETS_DIR, { recursive: true });
  log(`启动：数据根 = ${DATA.root}（${DATA.why}）`);
  log(`启动：素材根 = ${ASSETS_DIR}`);
  log(`启动：日志/配置 = ${app.getPath('userData')}`);
  log(`素材目录文件数 = ${(() => { let n = 0; const walk = (d) => { try { for (const e of fs.readdirSync(d, { withFileTypes: true })) e.isDirectory() ? walk(path.join(d, e.name)) : n++; } catch { } }; walk(ASSETS_DIR); return n; })()}`);

  // ★ 进程级素材拦截：http/https 全接管，非 /assets/** 一律原样走网络
  // ★ 必须注册在**窗口使用的那个分区 session** 上（默认 session 对 persist:sp 窗口无效）
  const ses = session.fromPartition('persist:sp');
  // ★ 用**标准浏览器 UA**：Electron 默认 UA 带 "Electron/xx"，会被部分服（如四服的 nginx）判为机器人 → 其 /_v024/** 资源 404 → 页面永远白屏
  ses.setUserAgent(`Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${process.versions.chrome} Safari/537.36`);
  log('User-Agent 已设为浏览器 UA（Chrome/' + process.versions.chrome + '）');
  // ★ 补齐 Referer 等"浏览器式"请求头：部分服（四服实测）对缺少 Referer 的请求返回 412，
  //   而主进程 net.fetch 转发默认不带 Referer → 页面资源被拒 → 白屏。
  //   用 session 级 onBeforeSendHeaders，对本窗口发出的**所有**请求（含我们转发的）生效。
  ses.webRequest.onBeforeSendHeaders((details, cb) => {
    try {
      const h = details.requestHeaders;
      const u = new URL(details.url);
      if (!h.Referer && !h.referer) h.Referer = u.origin + '/';
      if (!h['Accept-Language'] && !h['accept-language']) h['Accept-Language'] = 'zh-CN,zh;q=0.9,en;q=0.8';
      if (!h.Accept && !h.accept) h.Accept = '*/*';
    } catch (e) { /* ignore */ }
    cb({ requestHeaders: details.requestHeaders });
  });
  for (const scheme of ['http', 'https']) {
    try { ses.protocol.handle(scheme, (req) => interceptor.handle(req)); }
    catch (e) { log(`注册 ${scheme} 拦截失败：${e.message}`); }
  }

  // 选择界面从主进程拿列表（避开 CORS）——现在走「中转站地址」
  ipcMain.handle('servers', async () => {
    const relay = readRelay();
    if (!relay) return { ok: false, needRelay: true, error: '还没有设置中转站地址', relay: '', presets: relayQuickList('') };
    try {
      const r = await fetchRelayServers(relay);
      return { ok: true, relay, servers: r.servers, pollSeconds: r.pollSeconds, presets: relayQuickList(relay) };
    } catch (e) {
      log(`读取中转站失败（${relay}）：${(e && e.message) || e}`);
      return { ok: false, error: String((e && e.message) || e), relay, presets: relayQuickList(relay) };
    }
  });
  ipcMain.handle('relay-get', () => { const cur = readRelay(); return { url: cur, presets: relayQuickList(cur), builtin: RELAY_PRESETS, history: readRelayHistory() }; });
  ipcMain.handle('relay-set', (_e, url) => {
    const v = saveRelay(url);
    log('中转站地址已设置为：' + (v || '(清空)'));
    const presets = relayQuickList(v);
    if (!v) return { ok: false, url: '', error: '地址为空', presets };
    return { ok: true, url: v, presets, history: readRelayHistory() };
  });
  // 与当前游戏服务器同步素材（以服务端清单为权威，逐文件比对 SHA-256，只下差异）
  ipcMain.handle('assets-sync', (_e, urlOverride, force) => runAssetSync(urlOverride, force === true));
  // 探测能力（原版 0.3.0 特征：/plugins/index.json 是否 200）
  ipcMain.handle('probe', async (_e, url) => {
    try {
      const ac = new AbortController(); const t = setTimeout(() => ac.abort(), 3500);
      const r = await net.fetch(String(url).replace(/\/+$/, '') + '/plugins/index.json', { signal: ac.signal });
      clearTimeout(t); return r.ok;
    } catch { return null; }
  });
  // 本地单人：启动内嵌服务器并把窗口指过去
  ipcMain.handle('local-server-start', async () => {
    try {
      const s = await ensureLocalServer();
      writeLastServer(s.url);
      if (win) win.loadURL(s.url);
      return { ok: true, url: s.url, port: s.port };
    } catch (e) {
      const msg = String((e && e.message) || e);
      log('本地单人启动失败：' + msg);
      return { ok: false, error: msg };
    }
  });
  ipcMain.handle('local-server-stop', async () => ({ ok: await stopLocalServer() }));
  ipcMain.handle('local-server-status', () => ({ ok: !!localServer, url: localServer ? localServer.url : null, port: localServer ? localServer.port : null }));

  ipcMain.handle('open', (_e, url) => {
    const u = String(url);
    log(`进入：${u}`);
    writeLastServer(u);
    if (win) win.loadURL(u);
    return true;
  });
  ipcMain.handle('stats', () => interceptor.stat);
  ipcMain.handle('assets-status', async () => { try { return await setup.status(ASSETS_DIR); } catch (e) { return { files: 0, bytes: 0, ready: false }; } });
  // ---- 更新：版本显示 / 检查 / 下载安装（**单飞**，避免重复点击并发下载多份）----
  let updating = false;
  const push = (ch, data) => { try { if (win && !win.isDestroyed()) win.webContents.send(ch, data); } catch (e) { /* ignore */ } };
  ipcMain.handle('app-version', () => ({ version: app.getVersion(), assets: ASSETS_DIR }));
  ipcMain.handle('update-check', async () => {
    if (updating) return { updating: true, current: app.getVersion() };
    const r = await upd.check((m) => log(String(m)));
    if (r && r.has) push('update-available', { version: r.version, notes: (r.info && r.info.notes) || '' });
    return { has: !!r.has, version: r.version || null, notes: (r.info && r.info.notes) || '', error: r.error || null, current: app.getVersion() };
  });
  ipcMain.handle('update-start', async () => {
    if (updating) return { ok: false, reason: '已有更新在进行中' };
    updating = true;
    try {
      push('update-progress', { phase: 'start', percent: 0 });
      const r = await upd.checkAndInstallSmart((m) => log(String(m)), (p) => push('update-progress', { phase: 'download', percent: p }));
      if (r && r.updated) { push('update-progress', { phase: 'installing', percent: 100 }); return { ok: true, version: r.version }; }
      push('update-progress', { phase: 'idle', percent: 0 });
      return { ok: false, reason: (r && r.reason) || '已是最新' };
    } finally { updating = false; }
  });

  buildMenu();
  createWindow();
  // 素材引导：已就绪 / 随包 zip（安装目录·下载目录）/ CDN 增量；进度注入窗口横幅
  (async () => {
    const { dialog } = require('electron');
    const extraPackDirs = [app.getPath('downloads'), path.dirname(app.getPath('exe'))];
    let explicitPack = null;
    try {
      const st0 = await setup.status(ASSETS_DIR);
      const known = setup.findPack(extraPackDirs, setup.readRemembered(ASSETS_DIR));
      if (!st0.ready && !known) {
        // 找不到任何素材包 → 让玩家选：直接指定 zip（推荐）或从 CDN 下载（约 1 GB）
        const r = await dialog.showMessageBox(win, {
          type: 'question',
          buttons: ['选择素材包 zip…（推荐）', '从 CDN 下载（约 1 GB，较慢）', '稍后再说'],
          defaultId: 0, cancelId: 2,
          message: '没有找到素材包',
          detail: '启动器会自动在：安装目录 · 上级目录 · 「下载」文件夹 里查找素材包 zip。\n\n推荐直接选择你手上的素材包 zip（几秒后开始装载）；\n也可以从 CDN 逐个下载（约 1 GB，视网络可能很久）。',
        });
        if (r.response === 1) log('玩家选择：从 CDN 下载素材');
        else if (r.response === 0) {
          const sel = await dialog.showOpenDialog(win, { title: '选择素材包 zip', filters: [{ name: '素材包 zip', extensions: ['zip'] }], properties: ['openFile'] });
          if (sel && !sel.canceled && sel.filePaths && sel.filePaths[0]) explicitPack = sel.filePaths[0];
          else log('玩家取消了选择素材包');
        } else { log('玩家选择稍后处理素材（本次不装载）'); return; }
      } else if (known) log('素材包：' + known);
    } catch (e) { log('素材向导出错（继续）：' + ((e && e.message) || e)); }

    const r = await setup.ensureAssets({
      assetsDir: ASSETS_DIR, log, explicitPack, extraPackDirs,
      onProgress: (p) => { try { if (win && !win.isDestroyed()) win.webContents.executeJavaScript('window.__spProgress && window.__spProgress(' + JSON.stringify(p) + ')').catch(() => {}); } catch (e) { /* ignore */ } },
    });
    log('素材准备结束：source=' + r.source + ' files=' + r.files + (r.error ? ' error=' + r.error : ''));
  })().catch((e) => log('素材准备异常：' + ((e && e.message) || e)));
  setTimeout(async () => { try { const r = await upd.check((m) => log(String(m))); if (r && r.has) { log('发现新版本 v' + r.version); push('update-available', { version: r.version, notes: (r.info && r.info.notes) || '' }); } } catch (e) { /* ignore */ } }, 5000);   // 启动 5 秒后静默查一次更新
});

// 退出前把「素材哈希绑定」立即落盘 —— 下次启动才能直接命中本机素材（否则每次启动都要回源确认一遍）
app.on('before-quit', () => {
  try { if (localServer) { localServer.stop(); localServer = null; log('退出：已停止本地单人服务器'); } } catch { /* ignore */ }
  try { interceptor.flushBindings(); } catch (e) { /* ignore */ }
  // 退出时立刻中止正在进行的素材同步（否则"已经关闭客户端还在下载"）
  try { if (syncCtl) { syncCtl.abort(); log('退出：已中止素材同步'); } } catch (e) { /* ignore */ }
});

app.on('window-all-closed', () => {
  try { interceptor.flushBindings(); } catch (e) { /* ignore */ }
  try { log('素材统计 ' + JSON.stringify(Object.assign({}, interceptor.stat, { cache: interceptor.cacheSize(), bindings: interceptor.bindingCount() }))); } catch (e) {}
  app.quit();
});