import { defineConfig } from 'wxt';
import tailwindcss from "@tailwindcss/vite";
export default defineConfig({
  vite: () => ({
    plugins: [tailwindcss()],
    build: {
      sourcemap: false
    }
  }),
  modules: ['@wxt-dev/module-vue'],
  manifest: ({ browser }) => ({
    name: '__MSG_extName__',
    description: '__MSG_extDescription__',
    default_locale: 'en',
    permissions: [
      'storage', 'tabs', 'webRequest', 'downloads', 'declarativeNetRequest', 'notifications',
      ...(browser !== 'firefox' ? ['sidePanel'] : ['webRequestBlocking']),
    ],
    host_permissions: ['<all_urls>'],
    content_security_policy: {
      extension_pages: "script-src 'self' 'wasm-unsafe-eval';"
    },
    web_accessible_resources: [
      {
        // injected.js is loaded into the page's main world by content.ts.
        // MediaInfo WASM is loaded only by the extension background.
        resources: ['/injected.js'],
        matches: ['<all_urls>'],
      },
    ],
    homepage_url: 'https://flowpick.net',
    minimum_chrome_version: browser === 'firefox' ? undefined : '102',
    ...(browser !== 'firefox'
      ? {}
      : {
        browser_specific_settings: {
          gecko: {
            id: 'flowpick@flowpick.net',
            data_collection_permissions: {
              required: ["none"]
            }
          },
        },
        sidebar_action: {
          default_panel: 'sidepanel.html',
          default_title: 'FlowPick',
          default_popup: 'popup.html',
          default_icon: {
            '16': 'icon/16.png',
            '32': 'icon/32.png',
            '48': 'icon/48.png',
            '128': 'icon/128.png',
          },
          browser_style: false,
          open_at_install: false,
        },
        browser_action: {
          default_title: 'FlowPick',
          default_popup: 'popup.html',
          default_icon: {
            '16': 'icon/16.png',
            '32': 'icon/32.png',
            '48': 'icon/48.png',
            '128': 'icon/128.png',
          },
        },
      }),
  }),
});
