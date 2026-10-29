// ★ 优先走 electron-updater：它支持**差分下载**（只下变化的块，小更新通常几 MB），
//   发布端由 electron-builder 自动生成 latest.yml + blockmap；失败时回退到下面的自研整包更新。
let autoUpdater = null;
try { autoUpdater = require('electron-updater').autoUpdater; } catch (e) { autoUpdater = null; }

async function checkAndInstallSmart(log = () => {}, onPct = () => {}) {
  if (!autoUpdater) { log('（未安装 electron-updater，使用内置整包更新）'); return checkAndInstall(log, onPct); }
  return await new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.logger = { info: (m) => log(String(m)), warn: (m) => log(String(m)), error: (m) => log(String(m)), debug: () => {} };
    autoUpdater.on('error', (e) => { log('electron-updater 出错，回退整包更新：' + (e && e.message)); finish(null); });
    autoUpdater.on('download-progress', (p) => onPct(Math.round(p.percent || 0), p.transferred, p.total));
    autoUpdater.checkForUpdates().then(async (r) => {
      const v = r && r.updateInfo && r.updateInfo.version;
      if (!v || v === app.getVersion()) { log(`已是最新（v${app.getVersion()}）`); return finish({ updated: false, reason: '已是最新' }); }
      log(`发现新版本 v${v}（差分更新中…）`);
      await autoUpdater.downloadUpdate();
      log('下载完成，正在安装并重启…');
      autoUpdater.quitAndInstall();
      finish({ updated: true, version: v });
    }).catch((e) => { log('检查更新失败，回退整包更新：' + (e && e.message)); finish(null); });
  });
}
// src/update.js — Electron 内自更新（M4）
//
// 清单（默认 https://wei.czjun.top:11451/launcher/electron/latest.json，可用 SP_UPDATE_URL 覆盖）：
//   { "schema":1, "version":"2.0.0",
//     "url":"https://…/StrongholdLauncher-2.0.0-setup.exe",
//     "sha256":"…", "notes":"本次更新说明" }
//
// 流程：查清单 → 比版本 → 下载到临时目录 → 校验 sha256 → 启动 nsis 静默安装(/S) → 退出
//   （nsis 安装器会替换文件；因为 exe 不是运行中被覆盖的同一个句柄，不会遇到 Windows 运行锁问题）
const { app } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const UPDATE_URL = () => process.env.SP_UPDATE_URL || 'https://wei.czjun.top:11451/launcher/electron/latest.json';
const currentVersion = () => app.getVersion();

function cmpVer(a, b) {
  const pa = String(a || '').replace(/^v/i, '').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b || '').replace(/^v/i, '').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (x !== y) return x > y ? 1 : -1;
  }
  return 0;
}

/** @returns {{has:boolean, version?:string, info?:object, error?:string}} */
async function check(log = () => {}) {
  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 8000);
    const r = await fetch(UPDATE_URL(), { signal: ac.signal, headers: { 'user-agent': 'sp-electron/' + currentVersion() } });
    clearTimeout(t);
    if (!r.ok) return { has: false, error: `HTTP ${r.status}` };
    const m = await r.json();
    if (!m || !m.version) return { has: false, error: '清单格式不对' };
    const has = cmpVer(m.version, currentVersion()) > 0;
    if (has) log(`发现新版本 v${m.version}（当前 v${currentVersion()}）${m.notes ? '：' + m.notes : ''}`);
    else log(`已是最新（v${currentVersion()}）`);
    return { has, version: String(m.version), info: m };
  } catch (e) {
    return { has: false, error: String((e && e.message) || e) };
  }
}

/** 下载 + 校验；返回安装包路径（失败返回 null）。 */
async function download(info, log = () => {}, onPct = () => {}) {
  if (!info || !info.url) { log('清单里没有 url'); return null; }
  const out = path.join(os.tmpdir(), `sp-update-${info.version || Date.now()}.exe`);
  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 30 * 60 * 1000);
    const res = await fetch(info.url, { signal: ac.signal });
    clearTimeout(t);
    if (!res.ok || !res.body) { log(`下载失败 HTTP ${res.status}`); return null; }
    const total = Number(res.headers.get('content-length')) || 0;
    const hash = crypto.createHash('sha256');
    const fd = fs.openSync(out, 'w');
    let got = 0, last = -1;
    for await (const chunk of res.body) {
      fs.writeSync(fd, chunk); hash.update(chunk); got += chunk.length;
      if (total) { const p = Math.floor((got / total) * 100); if (p !== last && p % 5 === 0) { last = p; onPct(p, got, total); } }
    }
    fs.closeSync(fd);
    const got256 = hash.digest('hex');
    if (info.sha256 && got256 !== String(info.sha256).toLowerCase()) {
      log(`校验失败，已删除：期望 ${info.sha256} / 实际 ${got256}`);
      fs.rmSync(out, { force: true });
      return null;
    }
    log(`下载并校验通过：${(got / 1048576).toFixed(1)} MB → ${out}`);
    return out;
  } catch (e) {
    log('下载出错：' + ((e && e.message) || e));
    try { fs.rmSync(out, { force: true }); } catch { /* ignore */ }
    return null;
  }
}

/** 静默安装并退出（nsis 的 /S）。安装器替换文件后由用户或安装器重新启动。 */
function installAndQuit(setupPath, log = () => {}, installDir = null) {
  try {
    // ★ 传 /D=<当前安装目录>，否则 NSIS 会装到默认目录，玩家原目录还是旧版（实测踩过）
    const args = ['/S'];
    if (installDir) args.push('/D=' + installDir);   // NSIS 约定：/D= 必须是最后一个参数且不加引号
    log('启动安装器（静默）' + (installDir ? '，目标目录 ' + installDir : '') + ' …');
    spawn(setupPath, args, { detached: true, stdio: 'ignore' }).unref();
    setTimeout(() => app.quit(), 800);
    return true;
  } catch (e) {
    log('启动安装器失败：' + ((e && e.message) || e));
    return false;
  }
}

/** 一键：查 → 下 → 装。 */
async function checkAndInstall(log = () => {}, onPct = () => {}) {
  const r = await check(log);
  if (!r.has) return { updated: false, reason: r.error || '已是最新' };
  const file = await download(r.info, log, onPct);
  if (!file) return { updated: false, reason: '下载/校验失败' };
  installAndQuit(file, log);
  return { updated: true, version: r.version };
}

module.exports = { check, download, installAndQuit, checkAndInstall, checkAndInstallSmart, currentVersion, updateUrl: UPDATE_URL };
