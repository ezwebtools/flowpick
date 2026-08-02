import { createApp } from 'vue';
import './style.css';
import App from './App.vue';

browser.runtime.sendMessage({ type: 'SIDEPANEL_OPENED' }).catch(() => {})

const _port = browser.runtime.connect({ name: 'sidepanel' })

_port.onMessage.addListener((msg: any) => {
  if (msg?.type === 'SIDEPANEL_CLOSE_REQUEST') {
    window.close()
  }
})

browser.tabs.query({ active: true, currentWindow: true }).then((tabs) => {
  const tabId = tabs[0]?.id
  if (tabId !== undefined) {
    _port.postMessage({ type: 'SIDEPANEL_TAB_ID', tabId })
  }
}).catch(() => {})

window.addEventListener('pagehide', () => {
  browser.runtime.sendMessage({ type: 'SIDEPANEL_CLOSED' }).catch(() => {})
})

async function initTheme() {
  const result = await browser.storage.local.get('ext_appearance')
  const stored = result['ext_appearance'] as any
  const theme = stored?.theme ?? 'system'
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches
  if (theme === 'dark' || (theme === 'system' && prefersDark)) {
    document.documentElement.classList.add('dark')
  }
}

initTheme().finally(() => {
  createApp(App).mount('#app')
})
