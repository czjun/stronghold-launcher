# Electron 客户端迁移清单（第 2/3 步）

> 目标：**页面仍然来自目标服务器（各服 UI/规则保真）**，但 `/assets/**` 由本机磁盘直接提供
> （零下载、不被浏览器清理、不需要导入素材包）；同时把「返回大厅」等 UI 集成改成原生，告别 CDP 注入。

---

## 0. 为什么 Electron 能同时做到这两件事

```js
// 主进程：进程级接管所有请求 —— 这就是 Edge 方案做不到的能力
protocol.handle('https', async (req) => {
  const u = new URL(req.url);
  if (!u.pathname.startsWith('/assets/')) return net.fetch(req.url);   // 其余（HTML/JS/API）原样走网络
  const rel = stripContentSet(u.pathname);                              // /~<内容集哈希>/local/fx/… → local/fx/…
  const file = path.join(ASSETS_DIR, rel);
  if (fs.existsSync(file)) return diskResponse(file, req);              // ★ 本机磁盘直出
  return net.fetch(req.url);                                            // ★ 未命中 → 回退原服（天然有回退）
});
```
- 页面/JS/API 走网络 → **UI 是那个服务器自己的** ✅
- 素材走磁盘 → **零服务器上行、秒开、与浏览器缓存无关** ✅
- 不再需要：素材导入、重客户端替换 UI、CSP 放宽、CDP 注入、`--app` 参数

---

## 1. 工程结构

```
overlay/electron/
├─ package.json            electron / electron-builder 依赖 + 打包脚本
├─ main.js                 主进程（窗口/协议拦截/原生菜单/更新/日志）
├─ preload.cjs             注入到页面：返回大厅按钮、素材来源标记（可选）
├─ src/
│  ├─ assets.js            protocol.handle 的素材处理（含 Range、MIME）
│  ├─ server.js            起本机服务器（复用现有 server/index.js）
│  ├─ sync.js              CDN 增量（从 core.cjs 搬）
│  ├─ pack.js              素材包装载 / 现打 zip（从 core.cjs 搬）
│  └─ update.js            自更新（复用已上线的 latest.json 或换 electron-updater）
└─ build/                  图标等打包资源
```

---

## 2. 现有 core.cjs 的资产怎么搬

| 现有 | 去向 | 说明 |
|---|---|---|
| `menuPage()` 选择界面 HTML | **原样复用** | 主进程起一个本机 http 小服务渲染它（也可改成 BrowserWindow + 原生列表，先复用最省事） |
| `installAssetPack()` / `packForImport()` | `src/pack.js` | 纯 fs/child_process，直接搬 |
| `sync()` + `manifest` 逻辑 | `src/sync.js` | 直接搬（含 `/assets/` 前缀剥离那个已修的 bug） |
| `nodeForServer()` / `run()` | `src/server.js` | 改用 `utilityProcess.fork()`（Electron 自带 Node，不必再带 `runtime/node.exe`） |
| `sessionHelper()`（CDP 注入返回大厅） | **删除** | 换成原生菜单 + preload |
| `autoImport()`（CDP 驱动导入） | **删除/可选** | 素材已本机直出，不再需要导入 |
| `applyPendingUpdate()` / `downloadUpdate()` | `src/update.js` | 逻辑可复用；也可换 electron-updater |
| `findEdge()` / `spawn(edge, --app …)` | **删除** | 不再依赖系统 Edge |
| `runtime/node.exe`（83 MB） | **删除** | Electron 自带 Node → 包体反而省 83 MB |

> 净体积账：**+Chromium(~100–150 MB) − runtime node(83 MB) ≈ 净增 20–70 MB**，比一开始估的 +100 MB 乐观。

---

## 3. 素材拦截的三个必须处理点

1. **MIME**：按扩展名给 `content-type`（复用 upstream `server/http/static.js` 的表或自建小表）
2. **Range（必需）**：音频/视频会带 `Range: bytes=` → 命中磁盘时必须回 **206 + Content-Range**，否则 BGM/音效 seek 会坏
3. **内容集前缀**：`/assets/~<hash>/<真实路径>` → 剥掉 `~<hash>/` 再找磁盘（同一个已修的坑）

```js
function diskResponse(file, req) {
  const buf = fs.readFileSync(file);
  const type = mimeOf(file);
  const range = req.headers.get('range');
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    const start = m && m[1] ? +m[1] : 0;
    const end = m && m[2] ? +m[2] : buf.length - 1;
    return new Response(buf.subarray(start, end + 1), {
      status: 206,
      headers: { 'content-type': type, 'content-range': `bytes ${start}-${end}/${buf.length}`,
                 'accept-ranges': 'bytes', 'cache-control': 'no-store' },
    });
  }
  return new Response(buf, { headers: { 'content-type': type, 'cache-control': 'no-store', 'accept-ranges': 'bytes' } });
}
```

---

## 4. 窗口与存储

- `BrowserWindow({ webPreferences: { partition: 'persist:sp' } })` → 独立、持久的数据目录（`userData`）
- **多服隔离（推荐）**：按 host 用 `persist:<host>` 分区 → 各服独立的缓存/身份/设置，互不干扰
- 因为素材已由磁盘直出，**浏览器缓存会不会被清理不再重要**（前面 `persist()` 被拒的问题自动消失）

---

## 5. 原生集成（替掉所有 CDP 技巧）

| 功能 | 实现 |
|---|---|
| 返回大厅 | 菜单项 / `Ctrl+H` → `win.loadURL(selectionUrl)`（稳，不再依赖注入时机） |
| 切换服务器 | 菜单里列出探测通过/失败的服 |
| 打开数据目录 / 日志 | `shell.openPath(userData)`；把控制台输出改成窗口内的日志面板（可折叠） |
| 检查更新 | 菜单项 → `src/update.js` |
| 强制本机素材开关 | 菜单勾选项（对魔改服可关掉，回退到纯网络） |

---

## 6. 打包与分发

```
electron-builder：
  · nsis（安装器，推荐：可写开始菜单/桌面快捷方式）
  · portable（免安装单文件，备用）
体积控制：
  · 主进程进 asar；public/assets **不进包**（保持 lite 级体积）
  · 素材首次运行由 sync 从 CDN 增量拉（或由「完整包」另发一个 assets.zip）
签名：无证书 → SmartScreen 首次提示（与现在一样）；有证书可消除
```

---

## 7. 自更新（两条路，二选一）

| 方案 | 说明 |
|---|---|
| **A. 沿用已上线的 `latest.json`** | 第 1 步已完成：下载 → sha256 校验 → 退出 → 替换 → 重启。Electron 里把「换文件」改成 `app.relaunch()` + 退出即可 |
| **B. electron-updater** | 成熟、差分、跨平台；需要发布 `<app>-Setup.exe` + `latest.yml`（我们的 `/launcher/` 静态目录可继续用） |

> 建议：**先 A**（已跑通、零新依赖），需要差分/跨平台时再换 B。

---

## 8. 测试计划（验收标准）

```
① 进 1 服 / 4 服：页面是**它们自己的 UI**（无我们的房间一览/聊天），且可正常联机
② DevTools Network：/assets/** 全部来自本机（不走网络），且断网后素材仍能加载
③ 未命中的素材 → 自动回退到原服务器（造一个删掉的本机文件验证）
④ 对局内音频正常、**拖动/切换 BGM 正常**（验证 Range 206）
⑤ Ctrl+H / 菜单「返回大厅」随时回到选择界面
⑥ 自更新：改版本 → 发布 latest.json → 启动检测到 → 下载 → 重启换入
⑦ 冷启动时间、内存占用与 Edge 方案对比（记录基线）
```

---

## 9. 里程碑（建议 2–3 天）

| # | 里程碑 | 产出 | 估时 |
|---|---|---|---|
| M1 | 骨架跑起来 | Electron 窗口加载选择界面、能起本机服、能进 9 服（素材仍走网络） | 半天 |
| M2 | **素材拦截** | `protocol.handle` + Range + 回退；① ② ③ ④ 通过 | 半天–1 天 |
| M3 | 原生集成 + 打包 | 菜单/快捷键/日志面板；nsis + portable 出包；⑤ 通过 | 半天 |
| M4 | 自更新 + 验收 | ⑥⑦ + 双包分发（lite/含素材） | 半天 |

---

## 10. 已知风险与对策

| 风险 | 对策 |
|---|---|
| `protocol.handle` 与 Service Worker 的交互 | 上游客户端未注册 SW（实测 `supportsSW: true` 但未使用）；若注册了，SW 内请求也走 protocol → 仍被拦截 |
| 音频 Range 处理不当 → BGM 卡/不能 seek | 必须实现 206（见 §3），并进对局实测 |
| 打包后 assets 路径 | 统一用 `app.getPath('userData')/assets`，与打包位置解耦 |
| Electron 下载 ~100 MB（首次） | `npm i -D electron` 会拉二进制；国内可设 `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/` |
| 与现有 SEA 启动器并存 | 两个入口并存一段时间：Electron 版走 `electron/`，旧 exe 保留可回滚 |

---

## 11. 实施记录（M1–M4 已完成 + 实测结果）

### 11.1 实际踩到的 5 个坑（都已修，复现时直接照做）

| # | 现象 | 原因 / 对策 |
|---|---|---|
| 1 | 启动即崩：`TypeError: Cannot read properties of undefined (reading 'whenReady')` | 环境里有 **`ELECTRON_RUN_AS_NODE=1`** → Electron 退化成普通 Node，`require('electron')` 只返回路径字符串。启动前必须 `delete env.ELECTRON_RUN_AS_NODE` |
| 2 | 页面加载正常，但 `/assets/**` **一次都没命中**（拦截器统计为 0） | protocol 注册在**默认 session**，而窗口用 `partition: 'persist:sp'` → 完全不生效。必须 `session.fromPartition('persist:sp').protocol.handle(...)` |
| 3 | 本机有素材也 miss | 客户端请求带**内容集前缀** `/assets/~<hash>/…` → 必须先剥掉 `~<hash>/` 再找磁盘 |
| 4 | 音频 seek 坏 | 命中磁盘时必须回 **206 + Content-Range**（见 §3） |
| 5 | 打包后缺文件 / 产物互相覆盖 | `build.files` 要显式含 `selection.html`；nsis 与 portable 默认同名 → 分别设 `artifactName`（`-setup` / `-portable`） |

### 11.2 验收实测（M2）

```
1 服 http://8.134.50.56:3000     页面=它自己的 UI ✓  命中 3 / 回退 1
9 服 https://wei.czjun.top:11451 页面=它自己的 UI ✓  命中 5 / 回退 1
探针  /assets/local/fx/index.json → 200 · 6,786,353 B（= 本机文件大小）
      /assets/__sp_nope__.png     → 404（本机无 → 回退原服 → 它也无）
      Range: bytes=0-1023         → 206 · content-range: bytes 0-1023/854143 · 1024 B ✓
命中样例含 /assets/~d4a90301d39bf6da/ui/entry/bkg_01.png → 前缀剥离生效 ✓
失败请求 / 控制台错误：无
```

### 11.3 体积实测（比预期好）

```
Electron 产物：StrongholdLauncher-2.0.0-setup.exe   77.9 MB
              StrongholdLauncher-2.0.0-portable.exe 77.7 MB
旧 SEA 包：   package-lite.zip                       83.1 MB
→ Electron 反而更小：不再需要随包 runtime\node.exe(83 MB)，且 Electron 载荷压缩率高
```

### 11.4 产物与启动方式

```
开发：  cd overlay/electron && npm start        （务必先清 ELECTRON_RUN_AS_NODE）
出包：  npx electron-builder --win --x64        （electron-builder-binaries 走 npmmirror 镜像）
        → dist\StrongholdLauncher-<ver>-setup.exe / -portable.exe
环境变量：
  SP_ASSETS_DIR        素材根（默认 <安装目录>-data\assets；测试时可指向已装好的素材）
  SP_LOG_ASSETS=1      逐条打印素材 hit/miss（验收用）
  SP_UPDATE_URL        自更新清单地址（默认线上 /launcher/electron/latest.json）
```

### 11.4.1 🆕 中转站地址改为「手动输入 + 记忆 + 可修改」（2026-10-25）

**背景**：旧的「中转大厅」目录服务（`https://wei.isomer319.xyz/api/servers`）已失效，
不能再写死在客户端里，否则大厅永远是「目录读取失败」。

**新行为**（`main.js` + `selection.html` + `preload.cjs`）：

```
首次进入 → 大厅顶部「中转站」输入框 + 三个快捷地址按钮：
             https://wei.bbsmc.cn
             https://game.rainya.me
             https://game.xiaolubao.com
           点「保存并刷新」后写入 <userData>\relay.json，之后自动使用、不用再填
随时修改 → 同一输入框改完保存；或菜单「游戏 → 修改中转站地址…」
```

**目录接口自动探测**（各站实现不同，`fetchRelayServers()` 依次尝试）：

| 站 | 命中接口 | 字段 |
|---|---|---|
| `wei.bbsmc.cn` | `/api/servers` | `title / url / region / version / notes / tags` |
| `game.xiaolubao.com` | `/api/servers` | `name / address / regionLabel / note / health.raw{humans,rooms,app,latencyMs}` |
| `game.rainya.me` | `/api/entries` | `name / url / online / humans / rooms / gameVersion` |

`normalizeServers()` 把三家字段统一成界面用的 `{title,url,region,version,notes,tags,status{state,online,rooms,version,latencyMs}}`，
门户站没有 `status` 时用 `online/humans/rooms/gameVersion` 或 `health.raw` 合成。

**为什么不用写死的中转大厅**：目录服务会换域名/下线；写死 = 客户端彻底不可用。
改成「可输入 + 记忆」后，换中转站只是改个地址，不需要重新发版。

### 11.4.2 🔴 发布物存放规范（固定路径，避免每次都找不到）

**所有对外发布的客户端产物固定放在 `release/Electron发布/`，不要放到别处。**

```
release/Electron发布/
├─ StrongholdLauncher-<版本>-setup.exe         安装版（推荐分发）
├─ StrongholdLauncher-<版本>-portable.exe      免安装单文件版
├─ StrongholdLauncher-<版本>-setup.exe.blockmap  差分更新用（配合 latest.yml）
├─ latest.yml                                  自动更新清单（做自动更新时才需要）
├─ Stronghold-Protocol-v<游戏版本>-assets.zip   与客户端配套的素材包
└─ README.txt                                  给玩家的说明（版本、装哪个、素材怎么用）
```

**出包流程（固定三步）**：

```bash
cd overlay/electron && npx electron-builder --win nsis portable --publish never
# 产物在 overlay/electron/dist/（临时目录，不要当发布位置）
# → 复制到 release/Electron发布/，再更新 README.txt 与 latest.yml
```

**清理规则**：发布新版本后删掉过期旧版本包体（旧 exe/zip），只保留**当前版本**；
素材包同理，只留与当前游戏版本匹配的那一个。
（旧版再需要时，客户端安装包可按需重打，素材包可从上游 Release 重新下载。）

**注意**：`overlay/electron/dist/` 是构建临时区，会被下次构建覆盖/清理，**不能作为分发位置**。

### 11.5 素材首次获取（缺口 #1，已实现）

`src/assets-setup.js`：① 已就绪（≥1000 文件）→ 直接用 ② 找到素材包 zip → 自动装载
（搜索：启动器目录 · 其上级 · cwd · 系统「下载」文件夹）③ 否则 CDN 逐文件比 size 增量拉。
进度经主进程 `executeJavaScript` 注入 `selection.html` 顶部的橙色横幅。

### 11.5.1 🔴 素材版本更新（方案 A，2026-10-18 修复）

**原缺陷**：`status().ready` 只看「文件数 ≥ 1000」（`READY_MIN_FILES`），
装好一次素材的客户端（3 万文件）永远返回 `ready` → `ensureAssets()` 直接 return
→ **永不比对 CDN 清单** → 上游更新后的增量素材永远拉不到。

实测（0.3.1 上线后）：客户端 30,929 文件，缺 **129 个 / 81 MB**
（0.3.1 新增的 4 个攻击音效、62 个 `local/scene`、19 个 `local/guide`、13 个 `local/map` 等），
但 UI 显示「素材：已完整」。

**修复**：把 ready 判据从「文件数」改为「**清单版本一致**」。

```
启动时：
  ① 读 <数据根>/assets-tag.json（记录上次同步的 tag + ETag）
  ② 有记录 → 带 If-None-Match 条件请求 /cdn/v1/index.json
       · 304（版本没变）→ 几乎零流量，直接用本机素材    ← CDN 实测支持 304
       · 200（版本变了）→ 逐文件比 size，只下差异
  ③ 无记录（老客户端）→ 强制做一次全量比对（补历史欠账）
  ④ 网络失败 → 不阻塞进游戏，本机素材继续用（缺失的走 assets.js 三级回退）
```

**新增函数**（`src/assets-setup.js`，均已导出）：

| 函数 | 作用 |
|---|---|
| `readTag(assetsDir)` / `writeTag(assetsDir, obj)` | 读写 `assets-tag.json`（tag / etag / lastModified / at / files） |
| `fetchIndexConditional(saved)` | 带 `If-None-Match` / `If-Modified-Since` 取清单，返回 `{notModified}` 或 `{idx, etag}` |
| `syncFromIndex(assetsDir, idx, meta, st0, log, onProgress)` | 逐文件比 size 增量下载；**全部成功才写 tag** |
| `status()` | 返回值新增 `tag` 字段，供 UI 显示当前素材版本 |

**实测（2026-10-18，真实客户端目录）**：

```
修复前  30,929 文件 / 990 MB    tag=null
条件请求 200 新清单 v0.3.1（2.5 s / 4.2 MB）
差异     129 个 / 81 MB
同步后  31,031 文件 / 1061 MB   tag=v0.3.1
再查     304 未修改 ✅（下次启动零流量）
```

**容错设计**：

- 下载失败不写 tag（否则误判「已最新」）
- 网络不可用不阻塞启动（缺失素材由 `assets.js` 第 ③ 级「回源+落盘缓存」兜底）
- 首次遇到新素材会多一次网络请求，第二次走缓存

**注意**：`selection.html` 的「素材：已完整」文案随之需要改成显示清单版本，
避免玩家误以为「文件数够 = 与服务器一致」。

### 11.5.2 🔴 素材内容哈希校验（2026-10-18 修复「部分地图 3D 地形不显示」）

**现象**：客户端进对局，棋盘和干员正常，但 **3D 地形/建筑整片不显示**（地面是空的）。
浏览器直接访问同一服务器却正常。

**根因链（三重）**：

```
① 上游给素材 URL 带内容集哈希：/assets/~<hash16>/local/scene/xxx/scene.bin
   assets.js 的 stripContentSet() 把 ~<hash>/ 剥掉后**只按路径**找本机文件，
   命中就返回 —— 不校验内容是否与那个哈希对应。

② 本机素材来自随包 zip（v0.3.0），scene/mesh 是旧版。

③ CDN 清单（tag=v0.3.1）里**没有 local/scene 和 local/mesh**，
   而 CDN 上这些文件的实际内容也是旧的（实测与客户端完全一致）。
   → 素材自动更新永远拿不到正确版本。

结果：本机旧文件 → 按路径命中 → 返回旧 scene.bin → 渲染器解析失败 → 地形不显示
```

**实测证据**（客户端 vs 线上服务器 vs CDN）：

```
local/scene/act1autochess_m03/scene.bin
  客户端 2,090,668 = CDN 2,090,668   ← 都是旧的
  服务器 2,096,500                    ← 唯一正确

local/scene/tex/TX_AutochessSand_N.webp
  客户端 291,714 = CDN 291,714        ← 未压缩/旧版
  服务器  90,798                      ← 压缩后的正确版本
```

**修复（`src/assets.js`）**：命中本机文件后，**校验它的内容是否对应 URL 里的哈希**；不符则当作未命中 → 回源 → **把正确内容写回本机**（下次直接命中）。

```js
// 新增
contentHashOf(pathname)        // /assets/~abc123/… → 'abc123'
fileHash16(abs)                // 文件内容 sha1 前 16 位（按 size+mtime 做内存缓存）
matchesContentHash(abs, h)     // 本机文件是否匹配 URL 哈希
bindHash(serverHash, buf)      // 回源成功后把 serverHash 绑定到正确内容的 sha1

// 拦截流程改为
① 本机命中 → matchesContentHash() 校验
     匹配   → 直接返回
     不匹配 → stat.stale++，落到 ③
③ 回源 → 成功则 fs.writeFile(本机文件) + bindHash() + stat.refreshed++
```

**为什么用「首次回源验证 + 绑定」而不是直接比哈希**：
服务器的内容集哈希算法不一定是 `sha1(文件内容)`（可能是 path+size+mtime 的派生值），
所以不能直接相等比较。策略是：第一次遇到某个 `~hash/` 时回源一次拿到正确内容，
把 `serverHash → sha1(内容)` 记到内存；之后同一个 serverHash 零成本校验。
服务器换了哈希（文件更新）时自动重新验证。

**实测（真实文件，2026-10-18）**：

```
[1] 本机写入旧内容 → 请求带 ~7dd01bb086dfc490/ 的 URL
    → [log] 素材版本不符，回源更新
    → [回源] 拿到 2,096,500 B
    → [log] 素材已更新到本机
[2] 第二次请求 → 直接命中，不回源 ✅
统计: {"hit":1,"miss":1,"stale":1,"refreshed":1}
```

**配套修复（B：重打素材包）**：
`Stronghold-Protocol-v0.3.1-assets.zip` 的 `local/scene`（137 文件）与 `local/mesh`（15 文件）
改为**从线上服务器拉取的正确版本**（不再用客户端/ CDN 的旧版）。

**教训**：
```
「按路径命中」不等于「内容正确」。
缓存/本机素材库必须校验内容标识（哈希/版本），否则旧文件会永远遮蔽新文件。
这类 bug 的特征是：服务端正常、浏览器正常、只有客户端异常 —— 因为客户端多了一层本机缓存。
```

### 11.5.3 🔴 素材哈希算法用错 + 绑定未持久化（2026-10-25 修复，v2.2.1/v2.2.2）

**现象**（用户反馈）：0.3.3 上线后客户端「素材 → 素材来源统计」显示
`本机命中 0 次 · 回退网络 116 次`，进对局前明显变慢；0.3.1 时期没有这个问题。

**根因（两层）**：

```
① 哈希算法不一致（主因）
   服务端 server/http/assetIndex.js：hash16 = SHA-256(文件内容) 前 16 个 hex 字符
   客户端 src/assets.js:fileHash16    ：算的是 SHA-1 → **永远不可能相等**
   → 每个素材在每次启动都被判「可能过期」→ 全部回源。

   为什么 0.3.1 时没暴露：当时线上 data/assets.json 里的 URL **不带** ~hash
   （实测：旧版 带 hash = 0 / 不带 = 17,379；0.3.3 起 带 hash = 17,675 / 不带 = 0）。
   客户端对「无哈希 URL」直接判命中，所以那时几乎全本机命中、零网络。
   → 升级 0.3.3 后服务端开始给全部素材加哈希，问题才显形。

② 哈希绑定只在内存里
   _serverHashToLocalSha（serverHash → 本机内容哈希）进程退出即丢，
   每次启动都要重新回源确认一遍。Spine 模型（skel+atlas+贴图）的 URL 是
   「模型聚合哈希」，单文件 SHA-256 仍对不上，必须靠这张绑定表，所以持久化尤其重要。
```

**修复**：

```
① src/assets.js:fileHash16 → 改用 SHA-256（与服务端一致），16 hex
   → 内容相同的本机文件直接命中，零网络
② _serverHashToLocalSha 落盘到 <cache>/_hash-bindings.json
   退出前 flushBindings() 立即写盘；启动时载入 → 重启后模型文件也不用再回源
③ 「素材来源统计」补全：回源缓存命中 / 已刷新到本机 / 版本不符回源 / 透传 / 绑定条数
```

**验证（2.2.2，用线上真实 URL 哈希）**：

```
char/avatar/char_003_kalts.png        本机命中=1 回源=0   PASS
char/portrait/char_003_kalts_1.png    本机命中=1 回源=0   PASS
audio/bgm/m_sys_act1autochess_loop.mp3 本机命中=1 回源=0   PASS
spine/.../char_003_kalts.skel          本机命中=0 回源=1   PASS（模型聚合哈希，靠绑定表）
```

**教训**：
```
跨端哈希/指纹必须同算法、同截断长度。客户端「猜一个近似算法」会在服务端改变
URL 形式时突然全线失效，而且表现为「以前一直好用」的隐蔽回归。
判断依据要写进代码注释，并留一个「用线上真实 URL 校验」的测试。
```

### 11.5.4 🆕 与游戏服务器同步素材（2026-10-25，v2.3.0）

**问题**：客户端素材版本原来只认 CDN 清单（`/cdn/v1/index.json`）。CDN 更新滞后于
游戏服务端 → 服务端已经是 0.3.3，客户端素材仍显示「v0.3.1」，且不会自己对齐。

**方案**：以**当前游戏服务器**为权威，一键/自动对齐。

```
菜单「素材 → 与当前服务器同步素材…」   或   大厅「素材」那一行右侧的「同步素材」按钮
```

流程（`src/assets.js` 的 `syncFromServer()`）：

```
① 拉服务器清单：/data/assets.json、/data/local-assets.json、/data/local-fx.json
   解析每个 /assets/~<hash16>/<相对路径> → Map<相对路径, 服务器哈希>
② 版本标记：服务器 /healthz 的 app（→ "v0.3.3"）
③ 逐文件比对（本机 SHA-256 vs 服务器哈希，16 hex）
   · 普通文件：哈希相等 → 命中，跳过
   · Spine 模型：URL 是「模型聚合哈希」，本地算不出 → 查持久化的绑定表
   · 服务端没给哈希（老版本服务器）→ 本机有就保留
④ 二次校验（只比大小，不下载内容）
   对「本机已有但无法校验」的文件发 Range: bytes=0-0，读 Content-Range 的服务端真实大小
   大小一致 → 跳过下载 + 记入绑定表（现在完整 0.3.3 素材只需下 1 个文件）
⑤ 只下载真正不同的文件，写回本机素材目录，记入绑定表
⑥ 写 assets-tag.json（tag=v0.3.3, files/bytes）→ 界面显示版本随之更新
```

**实测（2026-10-25，线上 0.3.3）**：

```
清单 31,508 项；二次校验前判 2,280 项；Range 校验后实际只需下 5 个文件 / 1.4 MB
完整素材（31,599 文件 / 1.08 GB）比对 + 校验 + 修复：约 51–111 秒
端到端：故意删 3 个、改坏 1 个 → 同步后 4 个文件 sha256 全部恢复，失败 0
```

**为什么不用 CDN 清单做主**：CDN 是「分发加速」，会滞后；服务端清单才是「这个服
现在需要什么」的真相。换服时也能自动匹配（每个服的素材版本可能不同）。

**已知取舍**：二次校验按「大小相同视为内容相同」，理论上存在「同大小但内容变了」
的漏判；这类文件在**实际被请求时**仍会被拦截器按 SHA-256 校验并回源修正，不会长期错下去。

### 11.5.5 🔴 绑定表按哈希记录导致 Spine 模型无限重下（2026-10-25，v2.3.2）

**现象**：客户端日志刷屏，同一个模型反复「素材版本不符，回源更新」：

```
15:20:29 char_450_necras.skel  版本不符 → 更新
15:20:29 char_450_necras.atlas 版本不符 → 更新
15:20:29 char_450_necras.png   版本不符 → 更新
15:20:37 char_450_necras.skel  又版本不符 → 再下   ← 死循环
```

表现：进对局长时间卡在「正在载入模拟数据…」、干员显示成菱形占位、日志暴涨。

**根因**：Spine 模型的 **skel / atlas / 贴图三个文件共用一个「模型聚合哈希」**，
而绑定表是 `Map<serverHash, sha256(内容)>` —— 一个哈希只存一个值：

```
请求 skel  → 绑定 HASH → sha(skel)
请求 atlas → 查 HASH 得到 sha(skel) ≠ sha(atlas) → 判不一致 → 下载 → 覆盖 HASH → sha(atlas)
请求 png   → 同样不匹配 → 下载 → 覆盖 …
下一轮 skel → 又不匹配 → 无限循环
```

**修复**：绑定键改为 **`${serverHash}|${相对路径}`**，每个文件一条；旧格式（只有哈希）
保留为「内容指纹提示」，内容一致时自动升级为按文件记录，不丢历史记录。

**验证**（`temp/_test-modelgroup.js`、`temp/_test-legacy-binding.js`）：

```
第一轮（本机旧内容）：回源 3 次，绑定 3 条（每个文件一条）
第二轮（同进程）    ：回源 0 次，本机命中 3
第三轮（模拟重启）  ：回源 0 次，本机命中 3
旧格式迁移          ：回源 0 次即可确认并升级为新键
```

**教训**：

```
「一个 URL 哈希」不等于「一个文件」：模型组 / 内容集会让多个文件共享哈希。
任何「哈希 → 单一值」的映射都要先确认哈希的作用域（单文件 or 组）；
缓存/绑定键必须带能唯一定位资源的字段（路径）。
```

### 11.5.6 🔴 条件请求(304)被当成失败 → 3D 棋盘贴图在客户端不显示（2026-10-25，v2.3.3）

**现象**：某个房间的地图/棋盘在**网页里正常**，但在客户端里**不显示**；客户端日志反复出现
`素材版本不符，回源更新：/assets/~<hash>/local/map/autochess/tiles.json`，而本机 `tiles.json`
的 mtime 一直不更新。

**为什么只有客户端有**：网页由浏览器直接请求服务器；客户端多了一层「本机素材拦截器」。

**根因链**：

```
① 3D 棋盘要读 tiles.json。它是提取工具**派生**出来的文件，不在 local-assets.json 清单里，
   于是页面按「同目录其他文件的 URL」推导目录：dir = TX_autochessi_D 的 URL 去掉文件名，
   再拼 /tiles.json → URL 里的哈希其实是「别的文件」的哈希（服务器照常 200 返回内容）。
② 客户端拦截器拿本机 tiles.json 的内容 SHA-256 与 URL 哈希比 → 永远不等 → 判定「需回源」。
③ 页面用 fetch(url, { cache: 'no-cache' }) → 请求带 If-None-Match；服务器回 **304**。
④ 拦截器把 304 原样交给渲染进程：fetch 的 r.ok=false、正文为空 →
   fetchJson 返回 null → 3D 棋盘拿不到 UV/材质表 → **地图不显示**。
   而且没拿到正文 → 不写回本机、不记绑定 → 每次重来（日志刷屏）。
   （浏览器有 HTTP 缓存合并，304 会被还原成 200+正文，所以网页正常。）
```

**修复（v2.3.3）**：

```
① 回源前剥掉条件请求头（if-none-match / if-modified-since / if-range）→ 强制拿 200 完整正文
② 万一仍收到 304 → 用本机文件内容当命中返回（并记绑定），不再把 304 抛给渲染进程
```

**验证**（`temp/_test-conditional.js`、`temp/_test-borrowed-hash.js`）：

```
带 If-None-Match 的请求       → 服务端收到条件头=false，返回 200 + 完整正文，写回本机 ✅
第二次同样请求               → 本机命中，0 回源 ✅
服务端始终回 304             → 兜底用本机文件返回 200 ✅
「借来的哈希」请求（图集场景）→ 首次写回+绑定，之后（含重启）0 回源 ✅
```

**教训**：

```
代理/拦截层不能把 HTTP 语义（304、Range、条件请求）原样丢给上层应用：
304 的意义是「用你的缓存」，而这层正是缓存的实现者，必须自己消化掉。
```
### 11.5.7 素材同步的入口与失败策略（2026-10-26，待发布）

**背景**：有玩家在「三服 sp.bbsmc.cn」的房间里点了大厅的「同步素材」按钮 → 该服对程序请求回
`HTTP 412`（防盗链），而它的清单里有皮肤素材（本服不提供）→ 158 个文件 × 3 次重试 = 260 行失败日志；
期间还成功写入 11 个该服独有素材（表情/名片 webp）。**素材本身没有损坏**（同步只在成功时写文件），
但产生大量噪音与无谓流量。

**改动**：

```
① 删除大厅「素材」那一行的「同步素材」按钮 —— 只保留菜单「素材 → 与当前服务器同步素材…」
   （避免在别的服的房间里误点，把本机素材刷成别人的版本）
② 4xx（除 408/429）不再重试；连续失败 ≥ 8 个 → 判定该服不配合，立即中止剩余下载
③ 请求补浏览器式请求头（User-Agent / Referer / Origin），减少被防盗链挡
④ 退出客户端时立刻中止同步（含进行中的请求，AbortSignal.any 联动）
⑤ 版本防护：目标服版本 ≠ 本机素材版本时先弹确认，确认后才同步
⑥ 同步结果增加「新增 N 个」「中止原因」等信息
```

**为什么「退出了还在下载」**：同步跑在主进程，关掉房间/大厅只是切页面，不会停；
以前只有退出客户端才会随进程结束（且在途请求会拖到最后）。现在退出会即时中止。

**验证（本地）**：

```
假服务器全回 412：失败 8 个、中止=toomany、实际请求 8 次（每个只试 1 次，不再 158×3）  PASS
中途触发退出信号：中止=aborted、失败 0                                            PASS
既有回归（304 / 模型组绑定 / 同步幂等）                                           PASS
大厅 UI 自检：「同步素材」按钮已不存在，中转站/MANUAL 正常                          PASS
```

### 11.5.8 聊天表情包（2026-10-26，服务端下发，不需要新客户端）

**来源**：社区表情包（梗图/动图 webp），素材放在
`public/assets/local/sp-community-emotes/`（22 张 + `index.json`）。
不含官方表情套组（已按要求移除）。

**协议不变**：聊天仍是 `chat { text }`（≤200 字）。表情只是文本里的标记：

```
[[m:<id>]]     例：[[m:d32bfe4b05515f2f70ba]]
```

前端 `public/js/ext/spEmotes.js`：
- 收到消息时把标记渲染成 `<img>`（**只用 DOM 节点拼装，不碰 innerHTML**，防注入）
- 未知标记原样显示，不吞消息
- 表情面板：**4 列 × 2 行**（8 张可见，滚动看全部）

`public/js/ext/spExt.js`：
- 标题栏「☺」按钮（SVG 图标）开合表情面板
- 点击表情把标记插到输入框光标处
- 消息里的表情 **5em（≈63px）**，明显大于面板格（65px 视觉相当但更醒目）

**拖拽把手豁免规则（踩过坑）**：

```
标题栏整体是拖拽把手 → 里面的按钮点击会被当成「点标题栏」而收起聊天框。
修法：把手内部的可交互元素（button/input/.sc-emotes/img.sp-emote）不触发拖拽/开合，
      但**把手本身绝不豁免** —— 聊天按钮自己就是 <button>，豁免它会导致「聊天框点不开」。
```

**后台管理（/admin）**：新增「聊天表情包」面板

```
API：POST /api/emote（复用 admin 会话；写操作需登录，读列表前台也用来拿清单）
  action:'list' | 'upload' | 'remove' | 'enable' | 'disable' | 'rename'
实现：server/http/emoteApi.js（新文件），routes.js 一处 if + index.js 一处 import/实例
面板：public/admin/index.html + style.css + admin.js（缩略图网格、上传、停用、删除）
限制：单张 ≤ 2 MB，最多 80 张，文件名按 sha256 前 20 位（同图去重、无目录穿越）
```

**验证**（本地 8090）：

```
GET /api/emote                 → 22 条清单                    PASS
POST upload（png）             → ok, id=c414cd0e...           PASS
POST disable / remove          → ok，删除后回到 22 张          PASS
未登录 POST upload             → 401 unauthorized             PASS
后台面板渲染                   → 22 张卡片、图全加载、计数正确  PASS
```

**教训**：

```
① 复用自己的 API 前先看真实签名：sendJson(req,res,status,obj) 不是 sendJson(res,status,obj)。
② 拖拽把手的豁免要区分「把手本身」与「把手内部元素」，否则会互相打架。
```
### 11.6 仍待完成

| # | 项 | 说明 |
|---|---|---|
| 1 | 「本地开服」入口 | `utilityProcess.fork('server/index.js')` 起本机服 + 选择界面加入口 |
| 2 | 应用图标 | 现在是 Electron 默认图标（`build.icon`） |
| 3 | 多服独立分区（可选） | 按 host 用 `persist:<host>`，各服存储/身份互不干扰 |
| 4 | 代码签名 | 无证书 → SmartScreen 首次提示 |

