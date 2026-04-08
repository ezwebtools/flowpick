# Media Sniffer Extension

A powerful browser extension that automatically detects and extracts media streams (M3U8, MP4, MP3, etc.) from webpages. Built with Vue 3, TypeScript, and WXT framework.

## Features

- **Multi-format Detection**: Automatically detects various media formats including:
  - **Video**: MP4, MOV, AVI, WMV, FLV, MKV, WebM, OGV, 3GP, 3G2
  - **Audio**: MP3, M4A, OGA, WEBA, WAV, FLAC, AAC
  - **Streaming**: M3U8 (HLS), MPD (DASH)
  - **Images**: GIF, JPG, PNG, WebP, SVG

- **Real-time Monitoring**: Captures media requests through network monitoring
- **File Size Display**: Shows file size information for all detected media
- **Built-in Players**: 
  - HLS video player with streaming support
  - Audio player with spectrum visualization
  - Image preview
- **Tab Management**: Independent media list for each browser tab
- **Dark Mode**: Automatic theme adaptation
- **Internationalization**: Multi-language support (English, Chinese)

## Installation

### From Source

1. Clone the repository:
```bash
git clone https://github.com/yourusername/m3u8-downloader-ext.git
cd m3u8-downloader-ext
```

2. Install dependencies:
```bash
npm install
```

3. Build for production:
```bash
# For Chrome
npm run build

# For Firefox
npm run build:firefox
```

4. Load the extension:
   - **Chrome**: Go to `chrome://extensions/`, enable "Developer mode", click "Load unpacked", and select the `.output/chrome-mv3` directory
   - **Firefox**: Go to `about:debugging#/runtime/this-firefox`, click "Load Temporary Add-on", and select the `.output/firefox-mv2/manifest.json` file

### Development

Run in development mode with hot reload:

```bash
# For Chrome
npm run dev

# For Firefox
npm run dev:firefox
```

## Usage

1. **Automatic Detection**: The extension automatically detects media files when you browse webpages
2. **View Media List**: Click the extension icon to see all detected media files for the current tab
3. **Filter by Type**: Use the tabs to filter media by format (All, HLS, MP4, MP3, Other)
4. **Play Media**: 
   - Click the play button to play HLS streams, audio files, or preview images
   - Built-in HLS player for streaming video
   - Audio player with real-time spectrum visualization
5. **Copy URL**: Copy the media URL to clipboard
6. **Download**: Download the media file directly

## Technology Stack

- **Framework**: [WXT](https://wxt.dev/) - Modern web extension framework
- **UI**: [Vue 3](https://vuejs.org/) with Composition API
- **Styling**: [Tailwind CSS](https://tailwindcss.com/) v4
- **Language**: [TypeScript](https://www.typescriptlang.org/)
- **HLS Player**: [hls.js](https://hlsjs.org/)
- **Build Tool**: [Vite](https://vitejs.dev/)

## Project Structure

```
m3u8-downloader-ext/
├── entrypoints/
│   ├── background.ts      # Background script for network monitoring
│   ├── content.ts         # Content script for page injection
│   ├── injected.ts        # Injected script for fetch/XHR interception
│   └── popup/             # Popup UI
│       ├── App.vue        # Main popup component
│       ├── main.ts        # Entry point
│       └── style.css      # Styles
├── utils/
│   ├── detect.ts          # Media format detection utilities
│   └── storage.ts         # Storage management
├── public/
│   ├── _locales/          # Internationalization files
│   └── icon/              # Extension icons
├── wxt.config.ts          # WXT configuration
└── package.json           # Project dependencies
```

## Detection Mechanism

The extension uses multiple methods to detect media files:

1. **Network Request Monitoring**: Intercepts network requests via `webRequest` API
2. **Content-Type Analysis**: Prioritizes `content-type` headers for accurate format detection
3. **URL Pattern Matching**: Detects media files by URL patterns and extensions
4. **Fetch/XHR Interception**: Injects scripts to capture dynamic requests

## Permissions

- `storage`: Store detected media lists
- `tabs`: Manage tab-specific media lists
- `webRequest`: Monitor network requests
- `downloads`: Enable file downloads
- `<all_urls>`: Access all URLs for media detection

## Browser Support

- Chrome/Chromium (Manifest V3)
- Firefox (Manifest V2)

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## License

MIT License - see [LICENSE](LICENSE) for details.

## Acknowledgments

- [WXT](https://wxt.dev/) for the excellent extension framework
- [hls.js](https://hlsjs.org/) for HLS streaming support
- [Tailwind CSS](https://tailwindcss.com/) for the utility-first CSS framework
