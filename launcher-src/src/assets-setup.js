// src/assets-setup.js — 首次运行的素材准备
//
// ★ 关键：整个过程**必须异步、可让出事件循环**，否则同步解压/拷贝会阻塞 Electron 主进程 →
//   窗口画不出来、进度横幅也刷不了，玩家看到的就是"卡很久且毫无反应"（实测反馈）。
//
// 顺序：① 已就绪 → ② 附近有素材包 zip（首次发行随包）→ 解压装载 → ③ 否则 CDN 增量
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');

const READY_MIN_FILES = 1000;
const CDN_HOSTS = (process.env.SP_MANIFEST_HOSTS
  || 'https://speedcdn.jiangjiangze.icu,https://weishucdn2.jiangjiangze.icu,https://downcdn.jiangjiangze.icu')
  .split(',').map((s) => s.trim().replace(/\/$/, '')).filter(Boolean);
const PACK_RE = /^(stronghold-protocol-.*assets.*|assets|素材包).*\.zip$/i;

const tarPath = () => path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
const psPath = () => path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const yieldLoop = () => new Promise((r) => setImmediate(r));

async function countFiles(dir) {
  let n = 0;
  const walk = async (d) => {
    let ents; try { ents = await fsp.readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) { if (e.isDirectory()) await walk(path.join(d, e.name)); else n++; }
  };
  await walk(dir);
  return n;
}

async function dirBytes(dir) {
  let b = 0;
  const walk = async (d) => {
    let ents; try { ents = await fsp.readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else { try { b += (await fsp.stat(p)).size; } catch { /* ignore */ } }
    }
  };
  await walk(dir);
  return b;
}

/** 异步拷贝（每 300 个文件让出一次事件循环，保证窗口能刷新）。 */
async function copyTree(src, dst, state) {
  let ents; try { ents = await fsp.readdir(src, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    const s = path.join(src, e.name), d = path.join(dst, e.name);
    if (e.isDirectory()) { await fsp.mkdir(d, { recursive: true }); await copyTree(s, d, state); }
    else {
      try { await fsp.copyFile(s, d); } catch { /* ignore */ }
      state.done++;
      if (state.done % 300 === 0 || state.done === state.total) {
        state.onProgress({ phase: 'pack', done: state.done, total: state.total });
        await yieldLoop();
      }
    }
  }
}

function runAsync(cmd, args, timeout = 30 * 60 * 1000) {
  return new Promise((resolve) => {
    let done = false;
    const p = spawn(cmd, args, { stdio: 'ignore' });
    const t = setTimeout(() => { try { p.kill(); } catch { /* ignore */ } ; if (!done) { done = true; resolve(1); } }, timeout);
    p.on('error', () => { clearTimeout(t); if (!done) { done = true; resolve(1); } });
    p.on('exit', (code) => { clearTimeout(t); if (!done) { done = true; resolve(code || 0); } });
  });
}

/** 记住上次成功使用的素材包路径：素材万一丢了可自动复用，不用重新下载/手动找 */
function rememberFile(assetsDir) { return path.join(path.dirname(assetsDir), 'pack-path.txt'); }
function readRemembered(assetsDir) {
  try { const p = fs.readFileSync(rememberFile(assetsDir), 'utf8').trim(); if (p && fs.existsSync(p)) return p; } catch (e) { /* ignore */ }
  return null;
}
function writeRemembered(assetsDir, pack) {
  try { fs.writeFileSync(rememberFile(assetsDir), String(pack), 'utf8'); } catch (e) { /* ignore */ }
}

function findPack(extraDirs = [], remembered = null) {
  const all = [...new Set([remembered, path.dirname(process.execPath), path.dirname(path.dirname(process.execPath)),
    process.cwd(), ...extraDirs].filter(Boolean))];
  for (const d of all) {
    if (fs.existsSync(d) && fs.statSync(d).isFile() && /\.zip$/i.test(d)) return d;   // 记住的是文件路径，直接用
  }
  const dirs = [...new Set([path.dirname(process.execPath), path.dirname(path.dirname(process.execPath)),
    process.cwd(), ...extraDirs].filter(Boolean))];
  for (const d of dirs) {
    let names = [];
    try { names = fs.readdirSync(d); } catch { continue; }
    const hit = names.find((n) => PACK_RE.test(n));
    if (hit) return path.join(d, hit);
  }
  return null;
}

async function getJsonAny(p) {
  let last;
  for (const h of CDN_HOSTS) {
    try {
      const r = await fetch(h + p, { headers: { 'user-agent': 'sp-electron-setup/1.0' }, signal: AbortSignal.timeout(30000) });
      if (!r.ok) { last = new Error(`${h}${p} → ${r.status}`); continue; }
      return await r.json();
    } catch (e) { last = e; }
  }
  throw last || new Error('no manifest host');
}

// ---------- 素材清单版本标记（方案 A：版本一致才跳过） ----------
//
// 背景（2026-10-18）：原先 status().ready 只看「文件数 ≥ 1000」，
// 于是装好一次素材的客户端（3 万文件）永远返回 ready，**永不比对 CDN 清单**，
// 上游更新后的增量素材（0.3.1 是 103 个 / 67 MB）永远拉不到。
//
// 现在：本地记录上次同步的清单 tag + ETag。启动时带 ETag 条件请求：
//   · 304（版本没变）→ 几乎零流量，直接用本机素材
//   · 200（版本变了）→ 逐文件比 size，只下差异
// CDN 实测支持 If-None-Match / If-Modified-Since → 304。

const TAG_FILE = 'assets-tag.json';

function readTag(assetsDir) {
  try {
    const p = path.join(path.dirname(assetsDir), TAG_FILE);
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (j && typeof j === 'object') return j;
  } catch (e) { /* ignore */ }
  return null;
}

function writeTag(assetsDir, obj) {
  try {
    fs.writeFileSync(path.join(path.dirname(assetsDir), TAG_FILE), JSON.stringify(obj), 'utf8');
  } catch (e) { /* ignore */ }
}

/**
 * 带 ETag 条件请求取清单。
 * @returns {Promise<{notModified:true, tag:string|null}|{notModified:false, idx:object, etag:string|null, host:string}>}
 */
async function fetchIndexConditional(saved) {
  const etag = saved && saved.etag ? saved.etag : null;
  const lastModified = saved && saved.lastModified ? saved.lastModified : null;
  let last;
  for (const h of CDN_HOSTS) {
    try {
      const headers = { 'user-agent': 'sp-electron-setup/1.0' };
      if (etag) headers['if-none-match'] = etag;
      else if (lastModified) headers['if-modified-since'] = lastModified;
      const r = await fetch(h + '/cdn/v1/index.json', { headers, signal: AbortSignal.timeout(60000) });
      if (r.status === 304) return { notModified: true, tag: (saved && saved.tag) || null };
      if (!r.ok) { last = new Error(`${h} → ${r.status}`); continue; }
      const idx = await r.json();
      return {
        notModified: false, idx,
        etag: r.headers.get('etag') || null,
        lastModified: r.headers.get('last-modified') || null,
        host: h,
      };
    } catch (e) { last = e; }
  }
  throw last || new Error('no manifest host');
}

/** 素材现状（供 UI 常驻显示）。 */
async function status(assetsDir) {
  const files = await countFiles(assetsDir);
  const bytes = await dirBytes(assetsDir);
  const saved = readTag(assetsDir);
  return { files, bytes, ready: files >= READY_MIN_FILES, tag: (saved && saved.tag) || null };
}

/**
 * 确保素材就绪（全程异步、带进度）。
 *
 * 判定顺序（方案 A，2026-10-18）：
 *   ① 本地已有素材 + 清单版本一致（ETag → 304）→ 直接用
 *   ② 本地没有素材包 → 找 zip 装载
 *   ③ 版本不一致（或没记录过版本）→ 逐文件比 size，只下差异
 *
 * @returns {Promise<{source:'ready'|'pack'|'cdn', files:number, bytes:number, tag?:string|null, updated?:number, error?:string}>}
 */
async function ensureAssets(o) {
  const { assetsDir, log = () => {}, onProgress = () => {}, extraPackDirs = [], explicitPack = null } = o;
  await fsp.mkdir(assetsDir, { recursive: true });

  let st = await status(assetsDir);
  onProgress({ phase: 'check', files: st.files, bytes: st.bytes });

  // ---------- ① 已有素材：先做低成本版本检查（方案 A） ----------
  const saved = readTag(assetsDir);
  if (st.ready) {
    // ★ 2026-10-25：素材包导入 / 与服务器同步过的素材，直接判定就绪，不再比对 CDN。
    //   原因：(a) 包导入以前不写版本记录 → 每次启动都去比 CDN（还停在旧版）→ 可能把文件降级；
    //        (b) CDN 永远滞后于游戏服务器，不该当素材版本的权威。
    const src = String((saved && saved.source) || '');
    if (saved && saved.tag && (src.startsWith('pack:') || src.startsWith('server:'))) {
      log(`素材已就绪（${saved.tag}，来源 ${src}）：${st.files} 个文件 / ${(st.bytes / 1048576).toFixed(0)} MB → 跳过 CDN 比对`);
      onProgress({ phase: 'done', files: st.files, bytes: st.bytes, source: 'ready', tag: saved.tag });
      return { source: 'ready', ...st, tag: saved.tag, updated: 0 };
    }
    if (!saved || !saved.tag) {
      // 没有版本记录（素材包导入的老客户端）：直接视为就绪，并提示可手动与服务器对齐
      log(`素材已有 ${st.files} 个文件但没有版本记录 → 视为就绪；可用客户端「同步素材」与服务器对齐`);
      onProgress({ phase: 'done', files: st.files, bytes: st.bytes, source: 'ready', tag: null });
      return { source: 'ready', ...st, tag: null, updated: 0 };
    }
    {
      try {
        onProgress({ phase: 'check', text: '正在检查素材版本…', files: st.files, bytes: st.bytes });
        const r = await fetchIndexConditional(saved);
        if (r.notModified) {
          log(`素材已是最新（清单 ${saved.tag}，304 未修改）：${st.files} 个文件 / ${(st.bytes / 1048576).toFixed(0)} MB`);
          onProgress({ phase: 'done', files: st.files, bytes: st.bytes, source: 'ready', tag: saved.tag });
          return { source: 'ready', ...st, tag: saved.tag, updated: 0 };
        }
        // 版本变了 → 落到下面的增量逻辑
        log(`素材清单有更新：${saved.tag} → ${r.idx && r.idx.tag}，开始增量`);
        onProgress({ phase: 'cdn', text: `素材清单有更新（${saved.tag} → ${(r.idx && r.idx.tag) || '?'}）`, files: st.files });
        return await syncFromIndex(assetsDir, r.idx, { tag: r.idx && r.idx.tag, etag: r.etag, lastModified: r.lastModified }, st, log, onProgress);
      } catch (e) {
        // 网络失败 → 不阻塞进游戏，本机素材继续用（缺失的走回源）
        log('素材版本检查失败（继续用本机素材）：' + ((e && e.message) || e));
        return { source: 'ready', ...st, tag: saved.tag, updated: 0, error: String((e && e.message) || e) };
      }
    }
  }

  const remembered = readRemembered(assetsDir);
  if (remembered) log('上次用过的素材包：' + remembered);
  const pack = (explicitPack && fs.existsSync(explicitPack)) ? explicitPack : findPack(extraPackDirs, remembered);
  if (pack) {
    const packMB = (() => { try { return (fs.statSync(pack).size / 1048576).toFixed(0); } catch { return '?'; } })();
    log(`发现素材包：${pack}（${packMB} MB）— 预计需要 1–3 分钟，期间窗口可以正常显示进度`);
    const tmp = path.join(path.dirname(assetsDir), '.packtmp');
    await fsp.rm(tmp, { recursive: true, force: true });
    await fsp.mkdir(tmp, { recursive: true });
    onProgress({ phase: 'unzip', text: `正在解压素材包（${packMB} MB）…` });
    const t0 = Date.now();
    let code = await runAsync(tarPath(), ['-xf', pack, '-C', tmp]);
    if (code !== 0) {
      onProgress({ phase: 'unzip', text: 'tar 解压失败，改用 PowerShell…' });
      const q = (s) => s.replace(/'/g, "''");
      code = await runAsync(psPath(), ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${q(pack)}' -DestinationPath '${q(tmp)}' -Force`]);
    }
    if (code === 0) {
      let root = null;
      for (const e of await fsp.readdir(tmp, { withFileTypes: true }).catch(() => [])) {
        if (e.isDirectory() && fs.existsSync(path.join(tmp, e.name, 'public', 'assets'))) { root = path.join(tmp, e.name, 'public', 'assets'); break; }
      }
      for (const cand of [path.join(tmp, 'public', 'assets'), path.join(tmp, 'assets')]) {
        if (!root && fs.existsSync(cand)) root = cand;
      }
      if (root) {
        const total = await countFiles(root);
        log(`解压完成，正在装载 ${total} 个文件…`);
        onProgress({ phase: 'pack', done: 0, total });
        await copyTree(root, assetsDir, { done: 0, total, onProgress });
        await fsp.rm(tmp, { recursive: true, force: true });
        st = await status(assetsDir);
        // ★ 2026-10-25：导入素材包后写版本记录（以前不写 → 界面显示「未记录版本」，且下次启动会去比 CDN）
        try {
          const m = /v?(\d+\.\d+\.\d+)/i.exec(path.basename(pack));
          writeTag(assetsDir, {
            tag: m ? 'v' + m[1] : 'pack', files: st.files, bytes: st.bytes,
            at: Date.now(), source: 'pack:' + path.basename(pack),
          });
          log(`素材包导入完成，已记录版本 ${m ? 'v' + m[1] : '(未知)'}（${path.basename(pack)}）`);
        } catch (e) { log('写素材版本记录失败：' + ((e && e.message) || e)); }
        log(`素材装载完成：${st.files} 个文件 / ${(st.bytes / 1048576).toFixed(0)} MB（用时 ${((Date.now() - t0) / 1000).toFixed(0)} 秒）`);
        writeRemembered(assetsDir, pack);
        onProgress({ phase: 'done', files: st.files, bytes: st.bytes, source: 'pack' });
        return { source: 'pack', ...st };
      }
      log('素材包结构不认识（没找到 assets/），改用 CDN。');
    } else {
      log('解压素材包失败，改用 CDN。');
    }
    await fsp.rm(tmp, { recursive: true, force: true });
  } else {
    log('未找到素材包 zip（查找：启动器目录 / 上级目录 / cwd / 下载目录）→ 改为 CDN 增量');
  }

  // CDN 增量（首次或没有素材包时）
  try {
    onProgress({ phase: 'cdn', text: '正在读取 CDN 素材清单…' });
    const idx = await getJsonAny('/cdn/v1/index.json');
    return await syncFromIndex(assetsDir, idx, { tag: idx && idx.tag, etag: null, lastModified: null }, st, log, onProgress);
  } catch (e) {
    const msg = String((e && e.message) || e);
    log('CDN 增量失败：' + msg);
    onProgress({ phase: 'error', text: msg });
    return { source: 'cdn', files: st.files, bytes: st.bytes, error: msg };
  }
}

/**
 * 按 CDN 清单做增量同步（逐文件比 size，只下差异），完成后写 tag。
 * 供「首次拉取」和「版本更新」两条路径复用。
 *
 * @param {string} assetsDir
 * @param {object} idx        CDN /cdn/v1/index.json 的内容
 * @param {{tag:string|null, etag:string|null, lastModified:string|null}} meta
 * @param {{files:number, bytes:number}} st0  同步前的状态
 * @returns {Promise<{source:'cdn', files:number, bytes:number, tag:string|null, updated:number, error?:string}>}
 */
async function syncFromIndex(assetsDir, idx, meta, st0, log, onProgress) {
  const files = (idx && idx.files) || {};
  const keys = Object.keys(files);
  const todo = [];
  for (const k of keys) {
    if (!k.startsWith('assets/')) continue;
    const rel = k.slice('assets/'.length);
    const abs = path.join(assetsDir, rel);
    let need = true;
    try { const s = await fsp.stat(abs); need = !(s.isFile() && s.size === files[k].size); } catch { need = true; }
    if (need) todo.push({ rel, size: files[k].size });
  }
  const bytes = todo.reduce((a, b) => a + (b.size || 0), 0);
  log(`CDN 增量：需要下载 ${todo.length} 个文件 / ${(bytes / 1048576).toFixed(1)} MB（清单 ${meta.tag || '?'}）`);
  let done = 0, got = 0;
  onProgress({ phase: 'cdn', done: 0, total: todo.length, bytes, got, tag: meta.tag });
  const base = CDN_HOSTS[0] + '/assets/';
  for (const item of todo) {
    try {
      const r = await fetch(base + item.rel, { headers: { 'user-agent': 'sp-electron-setup/1.0' }, signal: AbortSignal.timeout(60000) });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const buf = Buffer.from(await r.arrayBuffer());
      const abs = path.join(assetsDir, item.rel);
      await fsp.mkdir(path.dirname(abs), { recursive: true });
      await fsp.writeFile(abs, buf);
      got += buf.length;
    } catch (e) { log('下载失败 ' + item.rel + '：' + e.message); }
    done++;
    if (done % 10 === 0 || done === todo.length) { onProgress({ phase: 'cdn', done, total: todo.length, bytes, got, tag: meta.tag }); await yieldLoop(); }
  }
  const st = await status(assetsDir);
  log(`CDN 增量完成：${st.files} 个文件（本次下载 ${(got / 1048576).toFixed(1)} MB，清单 ${meta.tag || '?'}）`);
  // ★ 只有全部成功才写 tag，避免下载失败后误判"已最新"
  if (done === todo.length) {
    writeTag(assetsDir, { tag: meta.tag || null, etag: meta.etag || null, lastModified: meta.lastModified || null, at: Date.now(), files: st.files });
  }
  onProgress({ phase: 'done', files: st.files, bytes: st.bytes, source: 'cdn', tag: meta.tag, updated: todo.length });
  return { source: 'cdn', ...st, tag: meta.tag || null, updated: todo.length };
}

module.exports = { ensureAssets, status, findPack, readRemembered, writeRemembered, countFiles, dirBytes, READY_MIN_FILES, readTag, writeTag, fetchIndexConditional, syncFromIndex };
