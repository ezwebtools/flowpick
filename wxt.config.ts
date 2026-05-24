import { defineConfig } from 'wxt';
import tailwindcss from "@tailwindcss/vite";
export default defineConfig({
  vite: () => ({
    plugins: [tailwindcss()],
  }),
  modules: ['@wxt-dev/module-vue'],
  manifest: ({ browser }) => ({
    name: '__MSG_extName__',
    description: '__MSG_extDescription__',
    default_locale: 'en',
    permissions: [
      'storage', 'tabs', 'webRequest', 'downloads',
      ...(browser !== 'firefox' ? ['sidePanel'] : ['webRequestBlocking']),
    ],
    host_permissions: ['<all_urls>'],
    web_accessible_resources: [
      {
        resources: ['/injected.js', '/MediaInfoModule.wasm'],
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
              needed: false,
            },
          },
        },
        sidebar_action: {
          default_panel: 'sidepanel.html',
          default_title: 'FlowPick',
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
