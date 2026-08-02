import { createApp } from 'vue';
import './style.css';
import App from './App.vue';

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
