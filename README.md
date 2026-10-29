# 卫戍协议：盟约 · 桌面客户端

**Stronghold Protocol: Alliance — Desktop Launcher**

《明日方舟》限时玩法「卫戍协议：盟约」**非官方同人复刻**的桌面客户端（Electron）。

> ⚠️ 本项目与上海鹰角网络科技有限公司（Hypergryph）、Yostar 及其关联方**没有任何关联**，也未获得其授权或认可。详见 [NOTICE.md](NOTICE.md)。

---

## 这是什么

一个**启动器 / 大厅客户端**，不是游戏本体。它做三件事：

1. **服务器大厅** —— 从社区中转站拉取服务器列表，一键进入
2. **本机素材库** —— 缓存游戏素材到本地，再次进入同一台服几乎不联网（命中率 99%+）
3. **自动更新** —— 从更新源拉新版安装包

游戏页面（棋盘、对局、渲染）由**服务端下发**，不在本仓库内。

## 下载

前往 [Releases](../../releases) 页面下载：

| 文件 | 说明 |
|---|---|
| `StrongholdLauncher-x.y.z-setup.exe` | 安装版（可自选安装目录、建桌面快捷方式） |
| `StrongholdLauncher-x.y.z-portable.exe` | 免安装单文件版 |

**首次使用**：进入大厅后按提示填写**中转站地址**（如 `https://wei.bbsmc.cn`），只需设置一次，之后自动记住。

## 源码结构

```
launcher-src/
├── main.js           主进程：窗口、服务器列表、素材同步、中转站记忆、自动更新
├── preload.cjs       contextBridge 暴露给页面的 IPC
├── selection.html    大厅页（服务器列表 + 中转站 + 素材状态 + 更新）
├── package.json      electron-builder 配置
└── src/
    ├── assets.js          素材拦截器：本机命中 → 代理缓存 → 回源写回
    ├── assets-setup.js    素材包导入 / 版本记录 / 同步
    └── update.js          自动更新
```

## 构建

```bash
cd launcher-src
npm install
npx electron-builder --win nsis portable
```

产物在 `dist/`。

> 游戏美术素材（`public/assets/`，约 1 GB）**不在仓库内**，客户端从游戏服务器按需下载到本机。

## 数据存放

```
<安装目录同级>/StrongholdLauncher-data/
├── assets/            本机素材库
├── cache/             代理缓存 + 哈希绑定
└── data/              日志、中转站、上次服务器
```

卸载即清；换安装目录时旧数据目录不会自动迁移。

## 许可证

代码以 **GPL-3.0-or-later** 发布（见 [LICENSE](LICENSE)）。
本项目基于上游开源复刻项目修改而来，第三方声明见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。

## 致谢

- 上游开源复刻项目的作者与贡献者
- 各社区服务器运维者
