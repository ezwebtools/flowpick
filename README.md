# 🌊 FlowPick

> **Smart Media Sniffer · Preview & Download** — Automatically capture video streams, audio, and images from web pages with built-in playback and instant download.

[🇨🇳 中文文档](README_zh.md) | [🇬🇧 English](README.md)

[![License](https://img.shields.io/github/license/ezwebtools/flowpick)](LICENSE)
[![Stars](https://img.shields.io/github/stars/ezwebtools/flowpick)](stargazers)
[![Platform](https://img.shields.io/badge/platform-Chrome%20%7C%20Edge%20%7C%20Firefox-blue.svg)](#installation)
[![Website](https://img.shields.io/badge/website-flowpick.net-4B8BBE.svg)](https://flowpick.net)

---

## 🎯 Core Features

### 📡 Universal Media Sniffing

Four-layer detection mechanism for precise media capture:

| Category | Supported Formats |
|----------|------------------|
| **Streaming** | M3U8 (HLS), MPD (DASH), HTTP-FLV, MPEG-TS |
| **Video** | MP4, WebM, MKV, AVI, MOV, WMV, FLV, OGV, 3GP, 3G2, MPEG |
| **Audio** | MP3, M4A, OGA, WEBA, WAV, FLAC, AAC, OGG |
| **Image** | GIF, JPG, PNG, WebP, SVG, BMP, ICO, data: URL (base64) |
| **Document** | PDF and other document resources |
| **Subtitle** | SRT, VTT, ASS and other subtitle files |

- **Network Request Interception** — Real-time monitoring via `webRequest` API
- **Content-Type Priority** — Analyzes response headers first for accurate format detection
- **URL Pattern Matching** — Smart recognition of media signatures in URL paths and parameters
- **Fetch/XHR Injection** — Injected scripts capture dynamically loaded media requests
- **MSE Stream Capture** — Intercepts MediaSource streams to capture videos with no direct URL (e.g. some web players); captured MSE streams can be downloaded
- **Platform-specific Adapters** — Built-in scripts for Douyin and similar sites parse page JSON to extract multi-bitrate video/audio candidates; extensible to more platforms via the generic `PlatformMediaTask` interface

### 🎬 Built-in Playback & Preview

Preview media without leaving the extension panel:

- **Stream Playback** — Built-in HLS.js / DASH.js / mpegts.js players supporting M3U8, MPD, HTTP-FLV, MPEG-TS with automatic error recovery
- **Stream Thumbnails** — Auto-decodes the first frame of streams as list thumbnails, with LRU cache + concurrency control + retry
- **HLS Proxy Loader** — Fetches segments via the background proxy with auth headers and Referer, bypassing CORS and hotlink protection
- **DRM Detection** — Automatically detects Widevine / PlayReady DRM-protected content and warns it cannot be previewed
- **Live Recording** — Record HTTP-FLV / MPEG-TS live streams while playing; auto-stops at the 500MB limit
- **Audio Spectrum** — Real-time frequency visualization powered by Web Audio API
- **Image Preview** — Full-screen lightbox with automatic dimension detection

### 🔍 Smart Filtering

Quickly locate target resources:

- **Category Tabs** — One-click switch between All / Stream / Video / Audio / Image
- **Format Filter** — Filter by specific media format
- **Size Filter** — Set min/max file size range
- **Resolution Filter** — Filter by video resolution (8K/4K/1080P/720P, etc.)
- **Dimension Filter** — Filter by image width and height
- **Regex Search** — Toggle between plain and regex matching for URL search, with real-time regex validation
- **Time Sorting** — Sort by detection time ascending/descending

### ⚙️ Flexible Sniffing Rules

Fine-grained control over sniffing behavior:

- **Per-type Toggle** — Independently enable/disable sniffing for streaming/video/audio/image/document/subtitle
- **Minimum Capture Size** — Set file size thresholds per type to filter out fragments
- **Domain Exclusion** — Exclude specific domains to avoid unwanted captures
- **Hide Stream Segments** — Hide HLS/DASH .ts/.m4s segments and show only the playlist entry (m3u8/mpd) to keep the list clean
- **data: Image Capture** — Detect `<img src="data:image/...">` inline base64 images, with a configurable min size to filter 1×1 tracking pixels
- **Per-tab Item Limit** — Configurable 10–5000 items per tab; oldest items are evicted automatically to avoid memory bloat

### 📊 Stream Manifest Parsing

Deep parsing of M3U8 / MPD manifests for complete metadata:

- **Multi-bitrate Variants** — Lists all quality variants (resolution + bandwidth + label)
- **Audio Tracks** — Identifies detached audio tracks (EXT-X-MEDIA)
- **Duration Estimation** — Sums EXTINF or parses MPD `mediaPresentationDuration`
- **Size Estimation** — Prefers byterange summation; otherwise multi-point segment sampling × count (HEAD + Range probing, saves bandwidth)

### 📋 Batch Operations

- **Select All** — Quickly select all media items
- **Batch Download** — Download multiple selected files at once
- **Copy URL** — One-click copy media links to clipboard

### 🏷️ Rich Media Information

Automatically fetched and displayed:

- **File Size** — Real-time file size display
- **Video Resolution** — MediaInfo-powered width/height parsing with resolution labels
- **Audio Duration** — Automatic duration detection
- **Image Dimensions** — Automatic width/height recognition
- **Stream Duration/Size** — Estimated total duration and size for VOD streams via manifest parsing

### 🌐 More Features

- **Side Panel Mode** — Supports Chrome Side Panel and Firefox Sidebar for a more spacious panel, easier for long lists
- **Welcome Guide** — First-run 6-step tutorial and 9 FAQ entries
- **Downloader Page Redirect** — One-click jump to dedicated flowpick.net downloaders (m3u8 / dash / video) with multi-language routing
- **M3U8 Extension Integration** — Detects and integrates with external M3U8 download extensions
- **Tab Isolation** — Independent media list per browser tab
- **Badge Counter** — Real-time capture count on the extension icon
- **Theme** — System / Light / Dark themes
- **List Density** — Compact / Comfortable display densities
- **i18n** — English, Simplified Chinese, Traditional Chinese, Japanese, German, Spanish, Korean (7 languages, can follow system)
- **Keyboard Shortcuts** — Configurable shortcut to open the panel

---

## 📦 Installation

### Install from Stores

| Browser | Link |
|---------|------|
| **Chrome** | [Chrome Web Store](https://chromewebstore.google.com/detail/flowpick-media-sniffer-do/mfinfkkabangbkanlfhhbokgfekjklea) |
| **Edge** | [Edge Add-ons](https://microsoftedge.microsoft.com/addons/detail/flowpick-media-sniffer-/egbfhgcifljmeaomlbhggplohemjombb) |
| **Firefox** | [Firefox Add-ons](https://addons.mozilla.org/firefox/addon/flowpick/) |

> 🌐 Website: [flowpick.net](https://flowpick.net)

### Build from Source

1. Clone the repository:
```bash
git clone https://github.com/ezwebtools/flowpick.git
cd flowpick
```

2. Install dependencies:
```bash
npm install
```

3. Build for production:
```bash
# Chrome
npm run build

# Firefox
npm run build:firefox
```

4. Load the extension:
   - **Chrome/Edge**: Go to `chrome://extensions/`, enable "Developer mode", click "Load unpacked", and select the `.output/chrome-mv3` directory
   - **Firefox**: Go to `about:debugging#/runtime/this-firefox`, click "Load Temporary Add-on", and select `.output/firefox-mv2/manifest.json`

### Development Mode

```bash
# Chrome (hot reload)
npm run dev

# Firefox (hot reload)
npm run dev:firefox
```

---

## 🚀 Usage

1. **Auto Sniffing** — FlowPick automatically captures media requests as you browse
2. **View List** — Click the extension icon to see all detected media for the current tab
3. **Filter & Sort** — Use tabs and filters to quickly locate target resources
4. **Preview & Play** — Click play to stream video/audio in-panel, or preview images full-screen
5. **Copy URL** — One-click copy media URL to clipboard
6. **Download** — Click download to save media files directly

> 💡 **Tip**: Some videos must start playing on the page before they can be detected.

---

## 🛠️ Tech Stack

| Technology | Purpose |
|------------|---------|
| [WXT](https://wxt.dev/) | Modern web extension framework |
| [Vue 3](https://vuejs.org/) | Composition API-driven UI |
| [TypeScript](https://www.typescriptlang.org/) | Type safety |
| [Tailwind CSS](https://tailwindcss.com/) v4 | Utility-first styling |
| [hls.js](https://hlsjs.org/) | HLS streaming playback / first-frame thumbnails |
| [dash.js](https://dashif.org/) | DASH streaming playback / first-frame thumbnails |
| [mpegts.js](https://github.com/xqq/mpegts.js) | HTTP-FLV / MPEG-TS live stream playback and recording |
| [m3u8-parser](https://github.com/videojs/m3u8-parser) | M3U8 manifest parsing |
| [mpd-parser](https://github.com/videojs/mpd-parser) | MPD manifest parsing |
| [mediainfo.js](https://github.com/buzz/mediainfo.js) | Media metadata parsing |
| [Vite](https://vitejs.dev/) | Build tooling |

---

## 📁 Project Structure

```
flowpick/
├── entrypoints/
│   ├── background.ts      # Background: network monitoring, media detection, download, proxy fetch, DRM detection
│   ├── content.ts         # Content script: page injection, message relay, MSE stream capture
│   ├── douyin.content.ts  # Douyin platform adapter: parses page JSON for multi-bitrate candidates
│   ├── injected.ts        # Injected script: Fetch/XHR interception, MSE interception
│   ├── popup/             # Popup panel UI
│   │   ├── App.vue        # Main component: list, playback, settings (also drives the side panel)
│   │   ├── components/
│   │   │   └── SettingsView.vue  # Settings panel component
│   │   ├── composables/
│   │   │   ├── useMediaFilters.ts      # Filter/search/sort (incl. regex search)
│   │   │   ├── useMediaStore.ts        # Media list state management
│   │   │   ├── useMediaViewModels.ts   # Media view-model cache
│   │   │   └── useStreamThumbnails.ts  # Stream first-frame thumbnails
│   │   ├── utils/
│   │   │   └── hlsProxyLoader.ts       # HLS background proxy loader
│   │   ├── main.ts        # Entry point
│   │   └── style.css      # Styles
│   ├── sidepanel/         # Side panel entry (Chrome Side Panel / Firefox Sidebar)
│   ├── welcome/           # Welcome guide: tutorial + FAQ
│   ├── download/          # Download page
│   │   ├── App.vue        # Download progress component
│   │   └── index.html     # Download page entry
│   └── options/           # Options page
│       └── App.vue        # Settings component
├── utils/
│   ├── detect.ts          # Media format detection (Content-Type + URL pattern)
│   ├── settings.ts        # Settings management (sniffing rules, domain exclusion, capture toggles)
│   ├── storage.ts         # Storage management (per-tab data persistence)
│   ├── stream-parser.ts   # M3U8/MPD manifest parsing (variants/duration/size estimation)
│   ├── platform-media.ts  # Generic platform adapter interface (PlatformMediaTask)
│   ├── useM3u8Ext.ts      # External M3U8 download extension integration
│   └── i18n.ts            # i18n + theme/density management (7 languages)
├── public/
│   ├── _locales/          # Internationalization (en / zh_CN / zh_TW / ja / de / es / ko)
│   ├── icon/              # Extension icons
│   └── MediaInfoModule.wasm  # MediaInfo WASM module
├── wxt.config.ts          # WXT configuration (permissions, Side Panel, Sidebar)
└── package.json           # Project dependencies
```

---

## 🔐 Permissions

| Permission | Purpose |
|------------|---------|
| `storage` | Store detected media lists and user settings |
| `tabs` | Manage tab-specific media lists |
| `webRequest` | Monitor network requests for media detection |
| `declarativeNetRequest` | Strip Origin/Cookie headers during proxy fetch to bypass hotlink protection |
| `downloads` | Enable file download functionality |
| `notifications` | Download completion and status notifications |
| `sidePanel` | Chrome side panel mode (Chromium only) |
| `<all_urls>` | Access all URLs for media detection |

---

## 🌍 Browser Support

- Chrome / Edge / Chromium (Manifest V3)
- Firefox (Manifest V2)

---

## 🤝 Contributing

Contributions are welcome! Feel free to submit a Pull Request.

## 📄 License

MIT License — see [LICENSE](LICENSE) for details.

## 🙏 Acknowledgments

- [WXT](https://wxt.dev/) — Excellent web extension framework
- [hls.js](https://hlsjs.org/) — HLS streaming playback support
- [dash.js](https://dashif.org/) — DASH streaming playback support
- [mpegts.js](https://github.com/xqq/mpegts.js) — HTTP-FLV / MPEG-TS live stream support
- [m3u8-parser](https://github.com/videojs/m3u8-parser) / [mpd-parser](https://github.com/videojs/mpd-parser) — Stream manifest parsing
- [mediainfo.js](https://github.com/buzz/mediainfo.js) — Media metadata parsing
- [Tailwind CSS](https://tailwindcss.com/) — Utility-first CSS framework
