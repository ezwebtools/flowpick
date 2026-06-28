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
| **Streaming** | M3U8 (HLS), MPD (DASH) |
| **Video** | MP4, WebM, MKV, AVI, MOV, WMV, FLV, OGV, 3GP, 3G2, MPEG |
| **Audio** | MP3, M4A, OGA, WEBA, WAV, FLAC, AAC, OGG |
| **Image** | GIF, JPG, PNG, WebP, SVG, BMP, ICO |

- **Network Request Interception** — Real-time monitoring via `webRequest` API
- **Content-Type Priority** — Analyzes response headers first for accurate format detection
- **URL Pattern Matching** — Smart recognition of media signatures in URL paths and parameters
- **Fetch/XHR Injection** — Injected scripts capture dynamically loaded media requests

### 🎬 Built-in Playback & Preview

Preview media without leaving the extension panel:

- **Stream Playback** — Built-in HLS.js / DASH.js players with automatic error recovery
- **Audio Spectrum** — Real-time frequency visualization powered by Web Audio API
- **Image Preview** — Full-screen lightbox with automatic dimension detection

### 🔍 Smart Filtering

Quickly locate target resources:

- **Category Tabs** — One-click switch between All / Stream / Video / Audio / Image
- **Format Filter** — Filter by specific media format
- **Size Filter** — Set min/max file size range
- **Resolution Filter** — Filter by video resolution (8K/4K/1080P/720P, etc.)
- **Dimension Filter** — Filter by image width and height

### ⚙️ Flexible Sniffing Rules

Fine-grained control over sniffing behavior:

- **Per-type Toggle** — Independently enable/disable sniffing for streaming/video/audio/image
- **Minimum Capture Size** — Set file size thresholds per type to filter out fragments
- **Domain Exclusion** — Exclude specific domains to avoid unwanted captures

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

### 🌐 More Features

- **Tab Isolation** — Independent media list per browser tab
- **Badge Counter** — Real-time capture count on the extension icon
- **Dark Mode** — Automatic system theme adaptation
- **i18n** — English, Simplified Chinese, Traditional Chinese, Japanese
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
| [hls.js](https://hlsjs.org/) | HLS streaming playback |
| [dash.js](https://dashif.org/) | DASH streaming playback |
| [mediainfo.js](https://github.com/buzz/mediainfo.js) | Media metadata parsing |
| [Vite](https://vitejs.dev/) | Build tooling |

---

## 📁 Project Structure

```
flowpick/
├── entrypoints/
│   ├── background.ts      # Background: network monitoring, media detection, download management
│   ├── content.ts         # Content script: page injection, message relay
│   ├── injected.ts        # Injected script: Fetch/XHR interception
│   ├── popup/             # Popup panel UI
│   │   ├── App.vue        # Main component: list, playback, settings
│   │   ├── main.ts        # Entry point
│   │   └── style.css      # Styles
│   ├── download/          # Download page
│   │   ├── App.vue        # Download progress component
│   │   └── index.html     # Download page entry
│   └── options/           # Options page
│       └── App.vue        # Settings component
├── utils/
│   ├── detect.ts          # Media format detection (Content-Type + URL pattern)
│   ├── settings.ts        # Settings management (sniffing rules, domain exclusion)
│   └── storage.ts         # Storage management (per-tab data persistence)
├── public/
│   ├── _locales/          # Internationalization (en / zh_CN / zh_TW / ja)
│   ├── icon/              # Extension icons
│   └── MediaInfoModule.wasm  # MediaInfo WASM module
├── wxt.config.ts          # WXT configuration
└── package.json           # Project dependencies
```

---

## 🔐 Permissions

| Permission | Purpose |
|------------|---------|
| `storage` | Store detected media lists and user settings |
| `tabs` | Manage tab-specific media lists |
| `webRequest` | Monitor network requests for media detection |
| `downloads` | Enable file download functionality |
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
- [mediainfo.js](https://github.com/buzz/mediainfo.js) — Media metadata parsing
- [Tailwind CSS](https://tailwindcss.com/) — Utility-first CSS framework
