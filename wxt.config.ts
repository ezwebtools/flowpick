import { defineConfig } from 'wxt';
import tailwindcss from "@tailwindcss/vite";
import { SHORTCUT_ROWS } from './utils/shortcuts';

// Firefox MV2 names the toolbar action `browser_action`, so its command id is
// `_execute_browser_action`. Chromium MV3 renamed both to `_execute_action`,
// and using the wrong one silently drops the binding.
const ACTION_COMMAND = (browser: string) =>
  browser === 'firefox' ? '_execute_browser_action' : '_execute_action';

function buildCommands(browser: string) {
  return Object.fromEntries(SHORTCUT_ROWS.map(row => {
    const id = row.id === '_execute_action' ? ACTION_COMMAND(browser) : row.id;
    return [id, {
      suggested_key: { default: row.fallbackKey },
      // `_execute_*` takes no description: the browser labels it itself.
      ...(id.startsWith('_execute_') ? {} : { description: row.descriptionKey }),
    }];
  }));
}

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
      // `contextMenus` powers the two pause entries (page right-click and the
      // toolbar icon). It raises no user-facing warning in Chromium.
      'storage', 'tabs', 'webRequest', 'webNavigation', 'downloads', 'declarativeNetRequest', 'notifications', 'contextMenus',
      ...(browser !== 'firefox' ? ['sidePanel', 'tabCapture'] : ['webRequestBlocking']),
    ],
    host_permissions: ['<all_urls>'],
    // Without a commands block chrome://extensions/shortcuts is a blank sheet,
    // which made Settings → Keyboard Shortcuts a dead link.
    commands: buildCommands(browser),
    web_accessible_resources: [
      {
        // injected.js is loaded into the page's main world by content.ts.
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
