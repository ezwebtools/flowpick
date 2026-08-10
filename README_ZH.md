# 🌊 FlowPick

> **智能媒体嗅探 · 一键预览下载** — 自动捕获网页中的视频流、音频、图片等媒体资源，内置播放预览，即嗅即得。

[🇨🇳 中文文档](README_ZH.md) | [🇬🇧 English](README.md)

[![License](https://img.shields.io/github/license/ezwebtools/flowpick)](LICENSE)
[![Stars](https://img.shields.io/github/stars/ezwebtools/flowpick)](stargazers)
[![Platform](https://img.shields.io/badge/platform-Chrome%20%7C%20Edge%20%7C%20Firefox-blue.svg)](#安装)
[![Website](https://img.shields.io/badge/website-flowpick.net-4B8BBE.svg)](https://flowpick.net)

---

## 🎯 核心功能

### 📡 全能媒体嗅探

四层检测机制，精准捕获网页中所有媒体资源：

| 类型 | 支持格式 |
|------|---------|
| **流媒体** | M3U8 (HLS)、MPD (DASH)、HTTP-FLV、MPEG-TS |
| **视频** | MP4、WebM、MKV、AVI、MOV、WMV、FLV、OGV、3GP、3G2、MPEG |
| **音频** | MP3、M4A、OGA、WEBA、WAV、FLAC、AAC、OGG |
| **图片** | GIF、JPG、PNG、WebP、SVG、BMP、ICO、data: URL (base64) |
| **文档** | PDF 等文档资源 |
| **字幕** | SRT、VTT、ASS 等字幕文件 |

- **网络请求拦截** — 通过 `webRequest` API 实时监控浏览器网络请求
- **Content-Type 优先** — 优先解析响应头 `content-type`，确保格式识别准确
- **URL 模式匹配** — 智能识别 URL 路径与参数中的媒体特征
- **Fetch/XHR 注入** — 注入页面脚本捕获动态加载的媒体请求
- **MSE 流捕获** — 拦截 MediaSource 流数据，捕获无直链 URL 的视频（如部分网页播放器），支持下载已捕获的 MSE 流
- **平台深度适配** — 针对抖音等站点内置专用脚本，解析页面 JSON 数据提取多码率视频/音频候选；通过通用 `PlatformMediaTask` 接口可扩展更多平台

### 🎬 内置播放预览

无需离开插件面板，直接预览播放：

- **流媒体播放** — 内置 HLS.js / DASH.js / mpegts.js 播放器，支持 M3U8、MPD、HTTP-FLV、MPEG-TS 流式播放，自动错误恢复
- **流媒体首帧缩略图** — 自动解码流媒体首帧生成列表缩略图，LRU 缓存 + 并发控制 + 失败重试，列表一目了然
- **HLS 代理加载器** — 通过后台代理 fetch 拉取分片，携带鉴权头与 Referer，突破跨域与防盗链限制
- **DRM 检测** — 自动检测 Widevine / PlayReady 等 DRM 保护内容，提示无法预览
- **直播流录制** — HTTP-FLV / MPEG-TS 直播流可边播边录，达到 500MB 上限自动停止
- **音频频谱** — 实时音频频谱可视化，Web Audio API 驱动
- **图片预览** — 全屏灯箱预览，自动识别图片尺寸

### 🔍 智能过滤与筛选

快速定位目标资源：

- **分类标签页** — All / Stream / Video / Audio / Image 一键切换
- **格式过滤** — 按媒体格式精确筛选
- **大小过滤** — 设置最小/最大文件大小范围
- **分辨率过滤** — 按视频分辨率（8K/4K/1080P/720P 等）筛选
- **尺寸过滤** — 按图片宽高筛选
- **正则搜索** — URL 搜索支持普通匹配与正则匹配一键切换，实时校验正则语法
- **时间排序** — 按检测时间升序/降序排列

### ⚙️ 灵活的嗅探规则

精细控制嗅探行为：

- **按类型开关** — 独立控制流媒体/视频/音频/图片/文档/字幕的嗅探启用状态
- **最小捕获大小** — 为每种类型设置最小文件大小阈值，过滤碎片资源
- **域名排除** — 排除指定域名，避免在特定网站上误捕获
- **隐藏流媒体分片** — 隐藏 HLS/DASH 的 .ts/.m4s 分片，只显示播放列表入口（m3u8/mpd），保持列表整洁
- **data: 图片捕获** — 检测 `<img src="data:image/...">` 内嵌的 base64 图片，可配置最小大小过滤 1×1 跟踪像素
- **每标签页条目上限** — 可配置 10–5000 条，超出后自动淘汰最旧条目，避免内存膨胀

### � 流媒体清单解析

深入解析 M3U8 / MPD 清单，提取完整元数据：

- **多码率变体** — 列出所有清晰度变体（分辨率 + 码率 + 标签）
- **音频轨道** — 识别分离的音频轨道（EXT-X-MEDIA）
- **总时长估算** — 累加 EXTINF 或解析 MPD 的 mediaPresentationDuration
- **总大小估算** — 优先 byterange 求和，否则多点抽样分片取平均 × 片数（HEAD + Range 探测，省流量）

### � 批量操作

- **一键全选** — 快速选中所有媒体项
- **批量下载** — 批量下载选中的媒体文件
- **URL 复制** — 一键复制媒体链接到剪贴板

### 🏷️ 丰富的媒体信息

自动获取并展示：

- **文件大小** — 实时显示媒体文件体积
- **视频分辨率** — 通过 MediaInfo 解析视频宽高与分辨率标签
- **音频时长** — 自动获取音频文件时长
- **图片尺寸** — 自动识别图片宽高像素
- **流媒体时长/大小** — 通过清单解析估算 VOD 流的总时长与总大小

### 🌐 其他特性

- **侧边栏模式** — 支持 Chrome Side Panel 与 Firefox Sidebar，提供更宽敞的操作面板，长列表浏览更顺手
- **欢迎引导页** — 首次使用提供 6 步图文教程与 9 条常见问题 FAQ
- **下载器页面跳转** — 一键跳转 flowpick.net 专用下载器（m3u8 / dash / video），支持多语言路由
- **M3U8 扩展联动** — 检测外部 M3U8 下载扩展并联动调用
- **标签页隔离** — 每个浏览器标签页独立管理媒体列表
- **Badge 计数** — 扩展图标实时显示当前页面捕获数量
- **外观主题** — 系统 / 浅色 / 深色三种主题自由切换
- **列表密度** — 紧凑 / 舒适两种显示密度
- **多语言** — 支持英语、简体中文、繁体中文、日语、德语、西班牙语、韩语（共 7 种，可跟随系统）
- **键盘快捷键** — 可配置快捷键快速打开面板

---

## 📦 安装

### 从商店安装

| 浏览器 | 链接 |
|--------|------|
| **Chrome** | [Chrome 网上应用店](https://chromewebstore.google.com/detail/flowpick-media-sniffer-do/mfinfkkabangbkanlfhhbokgfekjklea) |
| **Edge** | [Edge 加载项](https://microsoftedge.microsoft.com/addons/detail/flowpick-media-sniffer-/egbfhgcifljmeaomlbhggplohemjombb) |
| **Firefox** | [Firefox 附加组件](https://addons.mozilla.org/zh-CN/firefox/addon/flowpick/) |

> 🌐 官网：[flowpick.net](https://flowpick.net)

### 从源码构建

1. 克隆仓库：
```bash
git clone https://github.com/ezwebtools/flowpick.git
cd flowpick
```

2. 安装依赖：
```bash
npm install
```

3. 构建生产版本：
```bash
# Chrome
npm run build

# Firefox
npm run build:firefox
```

4. 加载扩展：
   - **Chrome/Edge**：访问 `chrome://extensions/`，开启「开发者模式」，点击「加载已解压的扩展程序」，选择 `.output/chrome-mv3` 目录
   - **Firefox**：访问 `about:debugging#/runtime/this-firefox`，点击「临时载入附加组件」，选择 `.output/firefox-mv2/manifest.json`

### 开发模式

```bash
# Chrome（热重载）
npm run dev

# Firefox（热重载）
npm run dev:firefox
```

---

## 🚀 使用指南

1. **自动嗅探** — 浏览网页时，FlowPick 自动捕获页面中的媒体请求
2. **查看列表** — 点击扩展图标，查看当前标签页检测到的所有媒体
3. **分类筛选** — 使用标签页和过滤器快速定位目标资源
4. **播放预览** — 点击播放按钮，流媒体/音频直接在面板内播放，图片全屏预览
5. **复制链接** — 一键复制媒体 URL
6. **下载文件** — 点击下载按钮直接下载媒体文件

> 💡 **提示**：部分视频需要先在页面上点击播放，才能被检测到。

---

## 🛠️ 技术栈

| 技术 | 用途 |
|------|------|
| [WXT](https://wxt.dev/) | 现代浏览器扩展框架 |
| [Vue 3](https://vuejs.org/) | Composition API 驱动的 UI |
| [TypeScript](https://www.typescriptlang.org/) | 类型安全 |
| [Tailwind CSS](https://tailwindcss.com/) v4 | 原子化样式 |
| [hls.js](https://hlsjs.org/) | HLS 流媒体播放 / 首帧缩略图 |
| [dash.js](https://dashif.org/) | DASH 流媒体播放 / 首帧缩略图 |
| [mpegts.js](https://github.com/xqq/mpegts.js) | HTTP-FLV / MPEG-TS 直播流播放与录制 |
| [m3u8-parser](https://github.com/videojs/m3u8-parser) | M3U8 清单解析 |
| [mpd-parser](https://github.com/videojs/mpd-parser) | MPD 清单解析 |
| [mediainfo.js](https://github.com/buzz/mediainfo.js) | 媒体元数据解析 |
| [Vite](https://vitejs.dev/) | 构建工具 |

---

## 📁 项目结构

```
flowpick/
├── entrypoints/
│   ├── background.ts      # 后台脚本：网络监控、媒体检测、下载管理、代理 fetch、DRM 检测
│   ├── content.ts         # 内容脚本：页面注入、消息中转、MSE 流捕获
│   ├── douyin.content.ts  # 抖音平台适配：解析页面 JSON 提取多码率候选
│   ├── injected.ts        # 注入脚本：Fetch/XHR 拦截、MSE 拦截
│   ├── popup/             # 弹出面板 UI
│   │   ├── App.vue        # 主组件：列表、播放、设置（同时驱动侧边栏）
│   │   ├── components/
│   │   │   └── SettingsView.vue  # 设置面板组件
│   │   ├── composables/
│   │   │   ├── useMediaFilters.ts      # 筛选/搜索/排序（含正则搜索）
│   │   │   ├── useMediaStore.ts        # 媒体列表状态管理
│   │   │   ├── useMediaViewModels.ts   # 媒体视图模型缓存
│   │   │   └── useStreamThumbnails.ts  # 流媒体首帧缩略图
│   │   ├── utils/
│   │   │   └── hlsProxyLoader.ts       # HLS 后台代理加载器
│   │   ├── main.ts        # 入口
│   │   └── style.css      # 样式
│   ├── sidepanel/         # 侧边栏入口（Chrome Side Panel / Firefox Sidebar）
│   ├── welcome/           # 欢迎引导页：教程 + FAQ
│   ├── download/          # 下载页面
│   │   ├── App.vue        # 下载进度组件
│   │   └── index.html     # 下载页入口
│   └── options/           # 选项页
│       └── App.vue        # 设置组件
├── utils/
│   ├── detect.ts          # 媒体格式检测（Content-Type + URL 模式）
│   ├── settings.ts        # 设置管理（嗅探规则、域名排除、捕获开关）
│   ├── storage.ts         # 存储管理（标签页数据持久化）
│   ├── stream-parser.ts   # M3U8/MPD 清单解析（多码率/时长/大小估算）
│   ├── platform-media.ts  # 平台适配通用接口（PlatformMediaTask）
│   ├── useM3u8Ext.ts      # 外部 M3U8 下载扩展联动
│   └── i18n.ts            # 国际化与主题/密度管理（7 种语言）
├── public/
│   ├── _locales/          # 国际化（en / zh_CN / zh_TW / ja / de / es / ko）
│   ├── icon/              # 扩展图标
│   └── MediaInfoModule.wasm  # MediaInfo WASM 模块
├── wxt.config.ts          # WXT 配置（权限、Side Panel、Sidebar）
└── package.json           # 项目依赖
```

---

## 🔐 权限说明

| 权限 | 用途 |
|------|------|
| `storage` | 存储检测到的媒体列表与用户设置 |
| `tabs` | 管理标签页级别的媒体列表 |
| `webRequest` | 监控网络请求以检测媒体资源 |
| `declarativeNetRequest` | 代理 fetch 时剥离 Origin/Cookie 等头，突破防盗链 |
| `downloads` | 启用文件下载功能 |
| `notifications` | 下载完成等状态通知 |
| `sidePanel` | Chrome 侧边栏模式（仅 Chromium） |
| `<all_urls>` | 在所有页面上进行媒体检测 |

---

## 🌍 浏览器支持

- Chrome / Edge / Chromium（Manifest V3）
- Firefox（Manifest V2）

---

## 🤝 贡献

欢迎贡献代码！请随时提交 Pull Request。

## 📄 许可证

MIT License - 详见 [LICENSE](LICENSE)

## 🙏 致谢

- [WXT](https://wxt.dev/) — 优秀的浏览器扩展框架
- [hls.js](https://hlsjs.org/) — HLS 流媒体播放支持
- [dash.js](https://dashif.org/) — DASH 流媒体播放支持
- [mpegts.js](https://github.com/xqq/mpegts.js) — HTTP-FLV / MPEG-TS 直播流支持
- [m3u8-parser](https://github.com/videojs/m3u8-parser) / [mpd-parser](https://github.com/videojs/mpd-parser) — 流媒体清单解析
- [mediainfo.js](https://github.com/buzz/mediainfo.js) — 媒体元数据解析
- [Tailwind CSS](https://tailwindcss.com/) — 原子化 CSS 框架
