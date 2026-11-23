<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, shallowRef } from 'vue'
import { loadAppearance, t } from '../../utils/i18n'
import type { PlayerSession } from '../../utils/media-player-tabs'
import { attachPlayer } from './playback'
import { cloneMediaItem } from '../../utils/media-message'

const session = shallowRef<PlayerSession>()
const media = ref<HTMLMediaElement>()
const error = ref('')
const status = ref('')
const loading = ref(true)
const audioFormats = ['mp3', 'm4a', 'oga', 'weba', 'wav', 'flac', 'aac', 'ogg']
const isAudio = computed(() => audioFormats.includes(session.value?.item.format.toLowerCase() || ''))
let disposed = false
let disposePlayer: (() => void) | undefined

async function copy() {
  try { await navigator.clipboard.writeText(session.value!.item.url); status.value = t('copyTips') }
  catch { status.value = t('copyUrl') + ': ' + session.value!.item.url }
}
async function download() {
  const item = cloneMediaItem(session.value!.item)
  try {
    const result = await browser.runtime.sendMessage({ type: 'OPEN_DOWNLOAD_PAGE', ...item, filename: session.value!.title,
      audioUrl: item.audioUrl || item.audioOptions?.[0]?.url,
      requestHeaders: { ...item.requestHeaders, Referer: session.value!.referrer },
    })
    if (!result?.ok) throw new Error()
  } catch { status.value = t('docDownloadFailed') }
}
onMounted(async () => {
  await loadAppearance().catch(() => {})
  try {
    const sessionId = new URL(location.href).searchParams.get('session')
    const result = await browser.runtime.sendMessage({ type: 'GET_MEDIA_PLAYER', sessionId })
    if (!result?.ok || !result.session) throw new Error()
    if (disposed) return
    session.value = result.session
    document.title = `${session.value!.title} · FlowPick`
    await nextTick()
    if (disposed || !media.value) return
    disposePlayer = attachPlayer(media.value, session.value!, message => { error.value = message })
  } catch { if (!disposed) error.value = t('playerSessionUnavailable') }
  finally { loading.value = false }
})
onUnmounted(() => { disposed = true; disposePlayer?.() })
window.addEventListener('pagehide', () => { disposed = true; disposePlayer?.() }, { once: true })
</script>

<template>
  <main class="min-h-screen text-gray-900 dark:text-gray-100">
    <header class="border-b border-gray-200 bg-white px-5 py-4 dark:border-gray-800 dark:bg-gray-900">
      <div class="mx-auto flex max-w-6xl items-center gap-3">
        <img src="/icon/48.png" alt="FlowPick" class="h-8 w-8 shrink-0" />
        <div class="min-w-0"><p class="text-xs font-semibold text-blue-600 dark:text-blue-400">FlowPick</p><h1 class="truncate text-base font-semibold" :title="session?.title">{{ session?.title || t('playbackSettings') }}</h1></div>
      </div>
    </header>
    <div class="mx-auto max-w-6xl px-4 py-8 sm:px-6">
      <div v-if="loading" role="status" class="py-12 text-center text-gray-500">{{ t('mseLoading') }}</div>
      <div v-if="session" class="overflow-hidden rounded-2xl bg-black shadow-lg">
        <div v-if="isAudio" class="flex min-h-64 items-center justify-center p-8 text-5xl text-blue-400" aria-hidden="true">♫</div>
        <component :is="isAudio ? 'audio' : 'video'" ref="media" controls playsinline preload="metadata"
          :class="isAudio ? 'block w-full' : 'block max-h-[75vh] min-h-48 w-full'"
          @error="error = t('unplayable')" />
      </div>
      <p v-if="error" role="alert" class="mt-4 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">{{ error }}</p>
      <div v-if="session" class="mt-5 flex flex-wrap items-center gap-3">
        <span class="rounded bg-gray-200 px-2 py-1 text-xs font-semibold uppercase dark:bg-gray-800">{{ session.item.format }}</span>
        <button type="button" class="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-500" @click="download">{{ t('download') }}</button>
        <button type="button" class="rounded-lg border border-gray-300 px-4 py-2 text-sm hover:bg-gray-100 dark:border-gray-700 dark:hover:bg-gray-800" @click="copy">{{ t('copyUrl') }}</button>
        <p role="status" class="break-all text-sm text-gray-500 dark:text-gray-400">{{ status }}</p>
      </div>
    </div>
  </main>
</template>
