// src/assets.js — 素材拦截核心（本机素材库 + 回源落盘缓存）
//
// 目标：页面与 JS 走网络（各服 UI 保真），素材优先本机；本机没有就回源**并落盘缓存**，
//       下次直接本地返回 —— 这样即使原服发了 no-store/no-cache（或返回 412），也不会每次重下。
//
// 三个必须处理点：① MIME ② Range（音频/视频 seek 必需 → 206）③ 内容集前缀 /~<hash>/ 要剥掉
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.map': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.gif': 'image/gif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.avif': 'image/avif',
  '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.wav': 'audio/wav',
  '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.flac': 'audio/flac',
  '.mp4': 'video/mp4', '.webm': 'video/webm',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf',
  '.skel': 'application/octet-stream', '.atlas': 'text/plain; charset=utf-8',
  '.bin': 'application/octet-stream', '.wasm': 'application/wasm',
};
const mimeOf = (p) => MIME[path.extname(p).toLowerCase()] || 'application/octet-stream';

/** 可落入代理缓存的扩展名（**不含 .html**：避免把页面钉在旧版本上） */
const CACHEABLE = new Set(['.js', '.mjs', '.css', '.json', '.map', '.png', '.jpg', '.jpeg', '.webp', '.gif',
  '.svg', '.ico', '.avif', '.mp3', '.ogg', '.oga', '.wav', '.m4a', '.aac', '.flac', '.mp4', '.webm',
  '.woff', '.woff2', '.ttf', '.otf', '.skel', '.atlas', '.bin', '.wasm', '.txt', '.xml']);
const MAX_CACHE_BYTES = 64 * 1024 * 1024;   // 单文件上限 64 MB

/** /assets/~<内容集哈希>/local/fx/x.json → local/fx/x.json（剥前缀；上游客户端用这种路径） */
function stripContentSet(p) {
  const m = /^~[0-9a-f]{6,}\/(.+)$/i.exec(p);
  return m ? m[1] : p;
}

/**
 * @param {string} assetsDir   本机素材根（<数据根>/assets）
 * @param {(req:Request)=>Promise<Response>} forward  回源
 * @param {{log?:Function, cacheDir?:string}} [opts]  cacheDir：回源落盘缓存根（<数据根>/cache）
 */
function createAssetInterceptor(assetsDir, forward, opts = {}) {
  const log = opts.log || (() => {});
  const CACHE_DIR = opts.cacheDir || path.join(path.dirname(assetsDir), 'cache');
  const stat = { hit: 0, bytes: 0, cacheHit: 0, miss: 0, passthrough: 0, cached: 0, cacheBytes: 0, errors: 0 };

  // ---------- 本机素材库 ----------
  //
  // ★ 内容集哈希校验（2026-10-18 修复「部分地图 3D 地形不显示」）
  //
  // 上游给素材 URL 带内容哈希：/assets/~<hash16>/local/scene/xxx/scene.bin
  // 原来的做法是直接把 ~<hash>/ 剥掉去找本机文件 —— 只要路径对上就返回，
  // **不校验内容**。于是本机留着旧版文件时（素材包旧、CDN 也旧），
  // 客户端永远返回旧文件，服务器明明有正确版本也拿不到。
  // 表现：棋盘和干员正常，但 3D 地形/建筑整片不显示（渲染器解析旧 scene.bin 失败）。
  //
  // 现在：命中本机文件后，用文件的 (size + mtime) 作为轻量指纹缓存，
  //       算出它的「内容集哈希」与 URL 里的比对；不一致 → 当作未命中 → 回源 → 覆盖本机。
  // 缓存放在内存（进程内），首次校验要读文件算哈希，之后同 size+mtime 直接复用。

  /** URL 里的内容集哈希（/assets/~abc123/… → 'abc123'），没有则 null */
  function contentHashOf(pathname) {
    const m = /^\/assets\/~([0-9a-f]{6,})\//i.exec(pathname);
    return m ? m[1].toLowerCase() : null;
  }

  // 内容集哈希算法（必须与服务器 assetIndex.js 完全一致）：
  //   server/http/assetIndex.js: hash16 = SHA-256(文件内容) 的前 ASSET_HASH_HEX(=16) 个十六进制字符
  //   /assets/~<hash16>/<relpath>
  //
  // ★ 2026-10-25 修复「本机命中 0、进对局前巨慢」：
  //   原来这里算的是 **SHA-1**，而服务器是 **SHA-256** → 本地哈希永远不等于 URL 里的哈希，
  //   于是每个素材在每次启动都被判成「可能过期」→ 全部回源。
  //   （0.3.1 时期服务端不给素材 URL 加哈希，客户端直接命中，所以那时不觉得慢；
  //     0.3.3 起服务端给全部 17,675 个素材 URL 加了哈希，问题才暴露。）
  //   改成 SHA-256 后：内容相同的本机文件直接命中，零网络请求。
  //   例外：Spine 模型（skel+atlas+贴图）的 URL 哈希是「模型聚合哈希」≠ 单文件 SHA-256，
  //   这些文件仍走一次回源绑定（见下方 _serverHashToLocalSha 持久化）。
  const _hashMemo = new Map();   // abs → { size, mtimeMs, hash }
  function fileHash16(abs) {
    try {
      const st = fs.statSync(abs);
      const memo = _hashMemo.get(abs);
      if (memo && memo.size === st.size && memo.mtimeMs === st.mtimeMs) return memo.hash;
      const buf = fs.readFileSync(abs);
      const h = crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16);
      _hashMemo.set(abs, { size: st.size, mtimeMs: st.mtimeMs, hash: h });
      return h;
    } catch (e) { return null; }
  }

  // 服务器哈希 ≠ sha1(内容)：不能直接比。
  // 所以我们缓存「服务器哈希 → 本机文件」的绑定关系：
  //   第一次遇到某个 ~hash/ 时，若本机文件算出的 sha1 与已绑定记录不符 → 视为旧文件 → 回源。
  //   回源拿到正确文件后，把它落盘并记录 (服务器hash → 落盘文件的 sha1)。
  // 这样第二次开始零成本，且服务器换了哈希（文件更新）时自动重新校验。
  // ★ 2026-10-25 修复「客户端命中率极低」：这张表原来只在内存里，进程一退出就清零，
  //   于是每次启动客户端、每个素材都要先回源确认一遍（实测「本机命中 0 · 回退网络 116」）。
  //   现在落盘到 <cache>/_hash-bindings.json：重启后直接命中；服务器换哈希时自然失配、
  //   该文件重新校验一次，仍然能拿到新版本。
  // ★ 键必须是「serverHash|相对路径」：Spine 模型的 skel/atlas/贴图**共用一个模型哈希**，
  //   只按哈希记会互相覆盖 → 三个文件每次都判不一致 → 无限重下（2026-10-25 实测）。
  const _serverHashToLocalSha = new Map();   // `${serverHash}|${相对路径}` → sha256(内容)前16
  // 旧格式（只有哈希、没有路径）的绑定：不能直接当权威（一个模型哈希对应 3 个文件），
  // 但可以作为「内容指纹提示」：若本机文件的 sha256 恰好等于旧记录值，可确认一致并升级为按文件记录。
  const _legacyHashToSha = new Map();        // serverHash → sha256(某个成员的内容)
  const bindKey = (serverHash, abs) => {
    try { return serverHash + '|' + path.relative(assetsDir, abs).split(path.sep).join('/'); }
    catch (e) { return serverHash + '|'; }
  };
  const BIND_FILE = path.join(CACHE_DIR, '_hash-bindings.json');

  function loadBindings() {
    try {
      const j = JSON.parse(fs.readFileSync(BIND_FILE, 'utf8'));
      if (j && typeof j === 'object') {
        for (const [k, v] of Object.entries(j)) {
          if (typeof k !== 'string' || typeof v !== 'string') continue;
          if (k.includes('|')) _serverHashToLocalSha.set(k, v);
          else _legacyHashToSha.set(k, v);   // 旧格式：留作迁移提示
        }
      }
      log(`已载入素材哈希绑定 ${_serverHashToLocalSha.size} 条`);
    } catch (e) { /* 首次运行没有该文件，正常 */ }
  }

  let _bindTimer = null;
  function writeBindings() {
    _bindTimer = null;
    try {
      fs.mkdirSync(CACHE_DIR, { recursive: true });
      const tmp = BIND_FILE + '.tmp';
      const obj = Object.fromEntries(_serverHashToLocalSha);
      for (const [k, v] of _legacyHashToSha) if (!(k in obj)) obj[k] = v;   // 未迁移的旧记录也保留
      fs.writeFileSync(tmp, JSON.stringify(obj));
      fs.renameSync(tmp, BIND_FILE);
    } catch (e) { log('保存素材哈希绑定失败：' + e.message); }
  }
  /** 绑定变化后延迟落盘（合并高频写入） */
  function saveBindingsSoon() {
    if (_bindTimer) return;
    _bindTimer = setTimeout(writeBindings, 1200);
    if (_bindTimer.unref) _bindTimer.unref();
  }
  /** 立即落盘（退出前调用，保证下次启动直接命中） */
  function flushBindings() {
    if (_bindTimer) { clearTimeout(_bindTimer); writeBindings(); }
  }

  loadBindings();

  /** 本机文件是否与 URL 的内容集哈希匹配。无法判断时返回 true（保持原行为，避免误回源）。 */
  function matchesContentHash(abs, serverHash) {
    if (!serverHash) return true;
    const local = fileHash16(abs);
    if (local == null) return true;
    const known = _serverHashToLocalSha.get(bindKey(serverHash, abs));
    if (known) return known === local;
    const legacy = _legacyHashToSha.get(serverHash);        // 旧格式迁移：内容一致即可确认
    if (legacy && legacy === local) {
      _serverHashToLocalSha.set(bindKey(serverHash, abs), local);
      saveBindingsSoon();
      return true;
    }
    // 首次遇到这个 serverHash：没有绑定记录。
    // 若本机文件的 sha1 恰好等于 serverHash（服务器用 sha1 内容做哈希的情形）→ 匹配
    if (local === serverHash) { _serverHashToLocalSha.set(bindKey(serverHash, abs), local); saveBindingsSoon(); return true; }
    // 否则无法确认：保守地认为「可能不匹配」，走回源验证一次，
    // 回源成功后 bindHash() 会把这个 serverHash 绑到正确内容的 sha1 上。
    return false;
  }

  /** 回源拿到正确内容后，把 serverHash 绑定到该内容的 sha1（下次不再重复回源） */
  function bindHash(serverHash, abs, buf) {
    if (!serverHash || !buf || !abs) return;
    try {
      const h = crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16);
      _serverHashToLocalSha.set(bindKey(serverHash, abs), h);
      saveBindingsSoon();
    } catch (e) { /* ignore */ }
  }

  function resolveDiskPath(pathname) {
    if (!pathname.startsWith('/assets/')) return null;
    let rel = decodeURIComponent(pathname.slice('/assets/'.length));
    rel = stripContentSet(rel);
    const abs = path.resolve(assetsDir, rel);
    const root = path.resolve(assetsDir);
    if (abs !== root && !abs.startsWith(root + path.sep)) return null;
    return abs;
  }

  /** 代理缓存路径：<cacheDir>/<host>/<sha1(path+query)><ext> */
  function cachePathFor(url) {
    try {
      const u = new URL(url);
      const ext = path.extname(u.pathname).toLowerCase();
      if (!CACHEABLE.has(ext)) return null;
      // ★ Service Worker 脚本一律不缓存、原样透传：它们常带 Service-Worker-Allowed 等头，改头会注册失败
      if (/sw\.js$|service-worker|workbox|resource-sw/i.test(u.pathname)) return null;
      const host = u.host.replace(/[^a-z0-9._-]/gi, '_');
      const h = crypto.createHash('sha1').update(u.pathname + (u.search || '')).digest('hex');
      return path.join(CACHE_DIR, host, h + ext);
    } catch { return null; }
  }

  function diskResponse(file, req, cacheable = false, extra = null) {
    const buf = fs.readFileSync(file);
    const type = mimeOf(file);
    const base = Object.assign({}, extra || {}, {
      'content-type': (extra && (extra['content-type'] || extra['Content-Type'])) || type,
      'accept-ranges': 'bytes',
      'cache-control': cacheable ? 'public, max-age=31536000, immutable' : 'no-store',
    });
    const range = req.headers.get('range');
    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      if (m) {
        const start = m[1] ? parseInt(m[1], 10) : 0;
        const end = m[2] ? parseInt(m[2], 10) : buf.length - 1;
        if (start <= end && start < buf.length) {
          const e = Math.min(end, buf.length - 1);
          const chunk = buf.subarray(start, e + 1);
          return new Response(chunk, { status: 206, headers: { ...base, 'content-range': `bytes ${start}-${e}/${buf.length}`, 'content-length': String(chunk.length) } });
        }
        return new Response(null, { status: 416, headers: { ...base, 'content-range': `bytes */${buf.length}` } });
      }
    }
    return new Response(buf, { status: 200, headers: { ...base, 'content-length': String(buf.length) } });
  }

  async function handle(req) {
    let pathname = '/';
    try { pathname = new URL(req.url).pathname; } catch { /* ignore */ }

    // ★ 非 /assets/** 一律直接透传（页面/JS/CSS/接口）：
    //   · 不参与命中统计（否则「回退网络」被页面请求灌水，实测 584 次里绝大多数不是素材）
    //   · 也**不做代理缓存** —— 避免把应用代码钉在旧版本上（服务端更新后取不到新代码）
    if (!pathname.startsWith('/assets/')) { stat.passthrough++; return forward(req); }

    // ① 本机素材库（真源）
    //   ⚠️ 「运行时清单」不能信本机缓存：index.json 这类文件服务器改了名字不变，
    //      URL 又没有 ~hash，本机命中会永远返回旧文件（2026-10-26 实测：
    //      后台新加表情后网页正常、客户端看不到，因为它用的是 10-26 01:33 的旧清单）。
    //      → 遇到 *.json 且路径含 sp- 清单名、或带 ?v= 的，一律走回源。
    const file = resolveDiskPath(pathname);
    const serverHash = contentHashOf(pathname);
    const isRuntimeManifest = /\/assets\/local\/sp-community-emotes\/index\.json$/i.test(pathname);
    if (file) {
      try {
        if (fs.existsSync(file) && fs.statSync(file).isFile()) {
          // ★ 内容集哈希校验：URL 带 ~hash/ 时，确认本机文件确实是那一版。
          //   不匹配 → 当作未命中，落到 ②/③ 回源，拿到正确内容后覆盖本机（见 ③）。
          if (!isRuntimeManifest && matchesContentHash(file, serverHash)) {
            stat.hit++; try { stat.bytes += fs.statSync(file).size; } catch (e) { /* ignore */ }
            return diskResponse(file, req);
          }
          stat.stale = (stat.stale || 0) + 1;
          log(`素材版本不符，回源更新：${pathname}`);
        }
      } catch (e) { stat.errors++; log('素材读取失败 ' + file + '：' + e.message); }
    }

    // ② 代理缓存（上次回源的结果）—— 这样即使原服 no-store，第二次也不再回源
    const cpath = isRuntimeManifest ? null : cachePathFor(req.url);   // 清单每次回源，不吃代理缓存
    const isRange = !!req.headers.get('range');
    if (cpath && !isRange && req.method === 'GET') {
      try {
        if (fs.existsSync(cpath) && fs.statSync(cpath).isFile()) {
          stat.cacheHit++;
          let extra = null;
          try { if (fs.existsSync(cpath + '.h.json')) extra = JSON.parse(fs.readFileSync(cpath + '.h.json', 'utf8')).h; } catch (e) { /* ignore */ }
          return diskResponse(cpath, req, true, extra);
        }
      } catch { /* ignore */ }
    }

    // ③ 回源，并落盘缓存（仅「可缓存扩展名 + 无 Range + GET + 2xx」）
    stat.miss++;

    // ★ 2026-10-25 修复「3D 棋盘贴图在客户端不显示、浏览器正常」：
    //   页面用 fetch(url, { cache: 'no-cache' }) 取 tiles.json 等派生文件时会带条件请求头
    //   （If-None-Match / If-Modified-Since）。服务器回 304 后，我们把 304 原样交给渲染进程 ——
    //   fetch 的 r.ok 为 false、正文为空 → 解析失败 → 棋盘贴图/UV 拿不到（浏览器有自己的缓存合并，
    //   所以不受影响）；同时我们也就拿不到内容，永远不写回、不记绑定 → 每次重来。
    //   现在：转发前剥掉条件头，强制拿 200 完整正文。
    let forwardReq = req;
    try {
      const h = new Headers(req.headers);
      let stripped = false;
      for (const k of ['if-none-match', 'if-modified-since', 'if-range']) {
        if (h.has(k)) { h.delete(k); stripped = true; }
      }
      if (stripped) forwardReq = new Request(req.url, { method: req.method, headers: h });
    } catch (e) { /* 构造失败就用原请求 */ }

    const res = await forward(forwardReq);

    // 万一仍然收到 304：说明服务端认为客户端缓存是最新的，本机文件可直接当命中用
    if (res && res.status === 304 && file) {
      try {
        if (fs.existsSync(file) && fs.statSync(file).isFile()) {
          if (serverHash) {
            const local = fileHash16(file);
            if (local) { _serverHashToLocalSha.set(bindKey(serverHash, file), local); saveBindingsSoon(); }
          }
          stat.hit++;
          try { stat.bytes += fs.statSync(file).size; } catch (e) { /* ignore */ }
          return diskResponse(file, req);
        }
      } catch (e) { /* ignore */ }
    }

    if (!isRange && req.method === 'GET' && res && res.ok) {   // ★ 不再要求 cpath：运行时清单需要写回本机
      try {
        const buf = Buffer.from(await res.arrayBuffer());
        // ★ 回源成功 → 把正确内容写回本机素材库（覆盖旧版），下次直接命中
        if (file && buf.length <= MAX_CACHE_BYTES) {
          try {
            fs.mkdirSync(path.dirname(file), { recursive: true });
            const tmp = file + '.tmp';
            fs.writeFileSync(tmp, buf);
            fs.renameSync(tmp, file);
            bindHash(serverHash, file, buf);
            _hashMemo.delete(file);           // 让下次重新算
            stat.refreshed = (stat.refreshed || 0) + 1;
            log(`素材已更新到本机：${pathname}`);
          } catch (e) { stat.errors++; log('素材写回失败 ' + file + '：' + e.message); }
        }
        if (cpath && buf.length <= MAX_CACHE_BYTES) {     // ★ cpath 可能为 null（运行时清单不吃缓存）
          fs.mkdirSync(path.dirname(cpath), { recursive: true });
          const tmp = cpath + '.tmp';
          fs.writeFileSync(tmp, buf);
          fs.renameSync(tmp, cpath);
          // ★ 连响应头一起存：命中缓存时回放，避免丢掉 Service-Worker-Allowed / etag 等关键头
          const keep = {};
          res.headers.forEach((v, k) => {
            const lk = k.toLowerCase();
            if (['content-encoding', 'content-length', 'transfer-encoding', 'connection', 'keep-alive', 'set-cookie'].includes(lk)) return;
            keep[lk] = v;
          });
          try { fs.writeFileSync(cpath + '.h.json', JSON.stringify({ s: res.status, h: keep })); } catch (e) { /* ignore */ }
          stat.cached++; stat.cacheBytes += buf.length;
        }
        const h = new Headers(res.headers);
        h.delete('content-encoding'); h.delete('transfer-encoding'); h.delete('connection');
        h.set('cache-control', 'public, max-age=31536000, immutable');
        h.set('content-length', String(buf.length));
        return new Response(buf, { status: res.status, headers: h });
      } catch (e) { stat.errors++; log('回源落盘失败 ' + pathname + '：' + e.message); }
    }
    return res;
  }

  function cacheSize() {
    let n = 0, b = 0;
    const walk = (d) => {
      let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
      for (const e of ents) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else { n++; try { b += fs.statSync(p).size; } catch { /* ignore */ } } }
    };
    walk(CACHE_DIR);
    return { files: n, bytes: b };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // 与服务端同步素材（2026-10-25，v2.3.0）
  //
  // 为什么需要：客户端的素材版本原来只认 CDN 清单（/cdn/v1/index.json），
  // 而 CDN 更新滞后于游戏服务端 —— 于是「服务端 0.3.3、客户端素材还显示 0.3.1」。
  // 这里改成以**当前游戏服务器**为准：拉它的 /data/assets.json 等清单（含每个文件的
  // 内容哈希），逐文件比对本地 SHA-256，只下载差异，然后写版本标记。
  // 好处：跟服务端永远对齐；换服自动匹配；不再依赖 CDN 是否更新。
  // ───────────────────────────────────────────────────────────────────────────

  const TAG_FILE = 'assets-tag.json';
  function tagPath() { return path.join(path.dirname(assetsDir), TAG_FILE); }
  function readTagFile() {
    try { return JSON.parse(fs.readFileSync(tagPath(), 'utf8')); } catch { return null; }
  }
  function writeTagFile(obj) {
    try {
      fs.mkdirSync(path.dirname(tagPath()), { recursive: true });
      fs.writeFileSync(tagPath(), JSON.stringify(obj));
    } catch (e) { log('写素材版本标记失败：' + e.message); }
  }

  /** 递归收集清单里所有 /assets/… 路径 → Map<相对路径, { hash, url }>（后出现的覆盖前面的） */
  function collectAssetPaths(doc, out) {
    const walk = (node) => {
      if (Array.isArray(node)) { for (const v of node) walk(v); return; }
      if (node && typeof node === 'object') { for (const v of Object.values(node)) walk(v); return; }
      if (typeof node !== 'string' || !node.startsWith('/assets/')) return;
      const m = /^\/assets\/(?:~([0-9a-f]{6,})\/)?(.+)$/i.exec(node);
      if (!m) return;
      out.set(m[2], { hash: m[1] ? m[1].toLowerCase() : null, url: node });
    };
    walk(doc);
    return out;
  }

  // 浏览器式请求头：部分社区服务器（实测三服）对非浏览器请求返回 412（防盗链）
  const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
  function browserHeaders(base, accept) {
    const h = { accept: accept || '*/*', 'user-agent': BROWSER_UA };
    try { const o = new URL(base); h.referer = o.origin + '/'; h.origin = o.origin; } catch (e) { /* ignore */ }
    return h;
  }

  async function getJson(url, timeoutMs = 30000, base = url) {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const r = await fetch(url, { headers: browserHeaders(base, 'application/json'), signal: ac.signal });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } finally { clearTimeout(t); }
  }

  /**
   * 以某个游戏服务器为准同步本机素材。
   * @param {string} serverUrl 例如 https://wei.czjun.top:11451
   * @param {{log?:Function, onProgress?:Function, dryRun?:boolean}} [opts]
   * @returns {Promise<{ok:boolean, server:string, tag:string|null, total:number, checked:number,
   *   need:number, updated:number, failed:number, bytes:number, missingManifest?:boolean}>}
   */
  async function syncFromServer(serverUrl, opts = {}) {
    const logf = opts.log || log;
    const onProgress = opts.onProgress || (() => {});
    const dryRun = opts.dryRun === true;
    const base = String(serverUrl || '').replace(/\/+$/, '');
    if (!/^https?:\/\//i.test(base)) throw new Error('服务器地址无效');

    onProgress({ phase: 'manifest', text: '读取服务器素材清单…' });

    const want = new Map();
    let gotManifest = 0;
    for (const p of ['/data/assets.json', '/data/local-assets.json', '/data/local-fx.json']) {
      try {
        const doc = await getJson(base + p, 45000, base);
        collectAssetPaths(doc, want);
        gotManifest++;
        logf(`素材清单 ${p} 已读取（累计 ${want.size} 项）`);
      } catch (e) {
        logf(`素材清单 ${p} 读取失败（继续）：${(e && e.message) || e}`);
      }
    }
    if (!gotManifest) {
      return { ok: false, server: base, tag: null, total: 0, checked: 0, need: 0, updated: 0, failed: 0, bytes: 0, missingManifest: true };
    }

    // 版本号：服务器 healthz 的 app（如 0.3.3）优先，其次 assets.json 的 hash
    let tag = null;
    try {
      const h = await getJson(base + '/healthz', 10000, base);
      if (h && h.app) tag = 'v' + String(h.app).replace(/^v/i, '');
    } catch { /* ignore */ }
    if (!tag) {
      try { const doc = await getJson(base + '/data/assets.json', 30000, base); if (doc && doc.hash) tag = 'v' + String(doc.hash).slice(0, 8); } catch { /* ignore */ }
    }

    // 逐文件比对
    const todo = [];
    let checked = 0;
    const entries = [...want.entries()];
    for (const [rel, info] of entries) {
      checked++;
      const abs = path.resolve(assetsDir, rel);
      const root = path.resolve(assetsDir);
      if (abs !== root && !abs.startsWith(root + path.sep)) continue;   // 防目录穿越
      let need = true;
      try {
        const st = fs.statSync(abs);
        if (st.isFile()) {
          if (!info.hash) {
            need = false;                       // 服务端没给哈希：本机有就不动
          } else {
            const local = fileHash16(abs);
            if (local && local === info.hash) need = false;              // 普通文件：SHA-256 一致
            else {
              const bound = _serverHashToLocalSha.get(bindKey(info.hash, abs)); // 模型聚合哈希：按「哈希|路径」查
              if (bound && local && bound === local) need = false;
            }
          }
        }
      } catch { need = true; }                  // 文件不存在
      if (need) todo.push({ rel, ...info });
      if (checked % 400 === 0) onProgress({ phase: 'check', checked, total: entries.length, need: todo.length });
    }
    onProgress({ phase: 'check', checked: entries.length, total: entries.length, need: todo.length });
    logf(`素材比对完成：清单 ${entries.length} 项，需要更新 ${todo.length} 项`);

    // ② 二次校验（只比大小，不下载内容）
    //
    // 为什么需要：Spine 模型（skel+atlas+贴图）的 URL 是「模型聚合哈希」，客户端算不出，
    // 所以在没有绑定记录时全部被判「需更新」——即使本机文件其实一模一样。
    // 实测完整 0.3.3 素材会被判 2,276 项、约 250MB 的无效重下。
    // 这里对「本机已有但无法校验」的文件发一个 Range: bytes=0-0 请求，从 Content-Range
    // 拿到服务端真实大小：与本地一致 → 跳过下载并记入绑定表（下次直接校验成功）。
    async function serverSize(url) {
      try {
        const ac = new AbortController();
        const t = setTimeout(() => ac.abort(), 15000);
        const r = await fetch(base + url, { headers: { range: 'bytes=0-0' }, signal: ac.signal });
        clearTimeout(t);
        let size = null;
        if (r.status === 206) {
          const m = /\/(\d+)\s*$/.exec(r.headers.get('content-range') || '');
          if (m) size = Number(m[1]);
        }
        if (size == null) {
          const cl = r.headers.get('content-length');
          if (cl) size = Number(cl);
        }
        try { await r.arrayBuffer(); } catch (e) { /* 丢弃 1 字节 */ }
        return size;
      } catch (e) { return null; }
    }

    const pending = [];
    let verified = 0;
    const sizeCandidates = todo.filter((t) => t.hash && (() => { try { return fs.statSync(path.resolve(assetsDir, t.rel)).isFile(); } catch { return false; } })());
    if (sizeCandidates.length) {
      logf(`二次校验：对 ${sizeCandidates.length} 个本机已有文件比对服务端大小…`);
      const CONC = 8;
      let idx = 0;
      const worker = async () => {
        while (idx < sizeCandidates.length) {
          const item = sizeCandidates[idx++];
          const abs = path.resolve(assetsDir, item.rel);
          let localSize = null;
          try { localSize = fs.statSync(abs).size; } catch { /* ignore */ }
          const remote = await serverSize(item.url);
          if (remote != null && localSize != null && remote === localSize) {
            // 大小一致 → 认为内容一致：计入绑定表，跳过下载
            const local = fileHash16(abs);
            if (local && item.hash) { _serverHashToLocalSha.set(bindKey(item.hash, abs), local); saveBindingsSoon(); }
            verified++;
          } else {
            pending.push(item);
          }
          if ((idx % 200) === 0) onProgress({ phase: 'verify', checked: idx, total: sizeCandidates.length, verified, need: pending.length });
        }
      };
      await Promise.all(Array.from({ length: CONC }, worker));
      onProgress({ phase: 'verify', checked: sizeCandidates.length, total: sizeCandidates.length, verified, need: pending.length });
      logf(`二次校验完成：大小一致跳过 ${verified} 项，仍需下载 ${pending.length} 项`);
    }
    // 本机没有的文件 + 大小不一致的文件
    const noLocal = todo.filter((t) => !sizeCandidates.includes(t));
    for (const t of noLocal) pending.push(t);
    saveBindingsSoon();

    if (dryRun) {
      return { ok: true, server: base, tag, total: entries.length, checked, need: pending.length, needBeforeVerify: todo.length, verified, updated: 0, failed: 0, bytes: 0, dryRun: true };
    }

    // 下载差异
    //   重试策略：只对「网络错误 / 5xx / 408 / 429」重试；
    //   4xx（如社区服的 412 防盗链）重试毫无意义 → 直接记失败。
    //   连续失败达到 8 个 → 判定该服不配合，立即中止剩余下载（不再刷 158×3 条日志）。
    //   opts.signal（退出时中止）：每个文件开下前检查一次。
    let updated = 0, failed = 0, bytes = 0, newFiles = 0;
    const failedItems = [];
    const signal = opts.signal || null;
    const aborted = () => !!(signal && signal.aborted);
    let consecutiveFailures = 0;
    let stopped = false;
    for (let i = 0; i < pending.length; i++) {
      if (aborted()) { logf('素材同步已中止（客户端退出）'); stopped = 'aborted'; break; }
      const { rel, hash, url } = pending[i];
      const abs = path.resolve(assetsDir, rel);
      let hadFile = false;
      try { hadFile = fs.statSync(abs).isFile(); } catch (e) { hadFile = false; }
      let ok = false;
      let lastErr = null;
      let hardFail = false;
      for (let attempt = 0; attempt < 3 && !ok; attempt++) {
        try {
          if (attempt > 0) await new Promise((res) => setTimeout(res, 500 * attempt));
          if (aborted()) { stopped = 'aborted'; break; }
          const ac = new AbortController();
          const t = setTimeout(() => ac.abort(), 90000);
          // 外部中止（客户端退出）要能立刻打断进行中的请求
          const sig = (signal && typeof AbortSignal.any === 'function') ? AbortSignal.any([ac.signal, signal]) : ac.signal;
          const r = await fetch(base + url, { signal: sig, headers: browserHeaders(base) });
          clearTimeout(t);
          if (!r.ok) {
            const err = new Error(`HTTP ${r.status}`);
            err.status = r.status;
            throw err;
          }
          const buf = Buffer.from(await r.arrayBuffer());
          if (!buf.length) throw new Error('空响应');
          fs.mkdirSync(path.dirname(abs), { recursive: true });
          const tmp = abs + '.tmp';
          fs.writeFileSync(tmp, buf);
          fs.renameSync(tmp, abs);
          _hashMemo.delete(abs);
          if (hash) {
            _serverHashToLocalSha.set(bindKey(hash, abs), fileHash16(abs));
            saveBindingsSoon();
          }
          updated++; bytes += buf.length;
          if (!hadFile) newFiles++;
          ok = true;
        } catch (e) {
          lastErr = e;
          const st = e && e.status;
          // 4xx（除 408/429）不重试
          if (typeof st === 'number' && st >= 400 && st < 500 && st !== 408 && st !== 429) { hardFail = true; break; }
          if (aborted()) { stopped = 'aborted'; break; }
        }
      }
      if (stopped === 'aborted') break;
      if (!ok) {
        failed++;
        failedItems.push(rel);
        consecutiveFailures++;
        logf(`素材下载失败 ${rel}：${(lastErr && lastErr.message) || lastErr}${hardFail ? '（4xx，不重试）' : ''}`);
        if (consecutiveFailures >= 8) {
          stopped = 'toomany';
          logf('连续失败 8 个，判定该服务器不配合，已中止剩余下载');
          break;
        }
      } else {
        consecutiveFailures = 0;
      }
      if ((i + 1) % 10 === 0 || i + 1 === pending.length) {
        onProgress({ phase: 'download', done: i + 1, total: pending.length, bytes, updated, failed, stopped });
      }
    }
    flushBindings();

    if (tag) {
      writeTagFile({ tag, files: 0, bytes: 0, at: Date.now(), source: 'server:' + base, updated, failed });
      // files/bytes 由调用方用 countFiles 补（这里不遍历 3 万文件）
    }
    stat.syncUpdated = (stat.syncUpdated || 0) + updated;
    stat.syncBytes = (stat.syncBytes || 0) + bytes;
    logf(`素材同步完成：更新 ${updated} 文件 / ${(bytes / 1048576).toFixed(1)} MB，失败 ${failed}，版本 ${tag || '?'}`);
    return { ok: failed === 0 && !stopped, server: base, tag, total: entries.length, checked, need: pending.length, needBeforeVerify: todo.length, verified, updated, newFiles, failed, stopped: stopped || null, failedItems: failedItems.slice(0, 20), bytes };
  }


  return { handle, stat, resolveDiskPath, stripContentSet, cacheSize, cacheDir: CACHE_DIR, flushBindings, bindingCount: () => _serverHashToLocalSha.size, syncFromServer, collectAssetPaths };
}

module.exports = { createAssetInterceptor, mimeOf, stripContentSet, MIME };
