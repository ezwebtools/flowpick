<script lang="ts" setup>
  interface MediaItem {
    url: string
    format: string
  }

  function itemToMediaItem(item: any): MediaItem {
    // 兼容旧数据格式
    if (typeof item === 'string') {
      return { url: item, format: 'm3u8' }
    } else if (item && typeof item === 'object') {
      return {
        url: item.url || '',
        format: item.format || 'm3u8'
      }
    }
    return { url: '', format: 'm3u8' }
  }

  const expandedId = ref<number | null>(null)
  const showMore = ref(false)
  const showToast = ref(false)
  const toastMessage = ref('')
  const mediaList = ref<MediaItem[]>([])
  const activeTab = ref<'all' | 'm3u8' | 'mp4' | 'mp3' | 'other'>('all')
  let currentTabId: number | undefined

  const version = browser.runtime.getManifest().version

  function onMessage(msg: { type: string; tabId?: number; list?: Array<{url: string, format: string}> }) {
    console.log('Popup: Received message:', msg.type, 'for tab:', msg.tabId, 'current tab:', currentTabId)
    if (msg.type === 'LIST_UPDATED' && msg.tabId === currentTabId && msg.list) {
      console.log('Popup: Updating list with', msg.list.length, 'items')
      mediaList.value = msg.list.map(itemToMediaItem)
    }
  }

  onMounted(async () => {
    console.log('Popup: onMounted')
    const tabs = await browser.tabs.query({ active: true, currentWindow: true })
    currentTabId = tabs[0]?.id
    console.log('Popup: Current tab ID:', currentTabId)
    if (currentTabId === undefined) return
    const list = (await browser.runtime.sendMessage({ type: 'GET_LIST', tabId: currentTabId })) as Array<{url: string, format: string}> | undefined
    console.log('Popup: Received list with', list?.length || 0, 'items')
    mediaList.value = (list ?? []).map(itemToMediaItem)
    browser.runtime.onMessage.addListener(onMessage)
  })

  onUnmounted(() => {
    browser.runtime.onMessage.removeListener(onMessage)
  })

  const getFileName = (url: string): string => {
    try {
      const pathname = new URL(url).pathname
      const name = pathname.split('/').pop()
      return name || url
    } catch {
      return url.split('/').pop() || url
    }
  }

  const getFormatLabel = (format: string): string => {
    if (!format) return browser.i18n.getMessage('unknown')
    const formatMap: Record<string, string> = {
      m3u8: 'HLS',
      mp4: 'MP4',
      mp3: 'MP3',
      flv: 'FLV',
      mkv: 'MKV',
      webm: 'WebM',
      mov: 'MOV',
      avi: 'AVI',
      wmv: 'WMV',
      ogv: 'OGV',
      m4a: 'M4A',
      oga: 'OGA',
      weba: 'WEBA',
      wav: 'WAV',
      flac: 'FLAC',
      aac: 'AAC',
      gif: 'GIF',
      jpg: 'JPG',
      png: 'PNG',
      webp: 'WebP',
      svg: 'SVG',
      media: 'MEDIA',
    }
    return formatMap[format.toLowerCase()] || format.toUpperCase()
  }

  const getFormatColor = (format: string): string => {
    if (!format) return 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-400'
    const colorMap: Record<string, string> = {
      m3u8: 'bg-purple-100 text-purple-700 dark:bg-purple-900 dark:text-purple-300',
      mp4: 'bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300',
      mp3: 'bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300',
      flv: 'bg-orange-100 text-orange-700 dark:bg-orange-900 dark:text-orange-300',
      mkv: 'bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300',
      webm: 'bg-teal-100 text-teal-700 dark:bg-teal-900 dark:text-teal-300',
      mov: 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900 dark:text-indigo-300',
      avi: 'bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-300',
      wmv: 'bg-lime-100 text-lime-700 dark:bg-lime-900 dark:text-lime-300',
      ogv: 'bg-emerald-100 text-emerald1-700 dark:bg-emerald1-900 dark:text-emerald1-300',
      m4a: 'bg-cyan-100 text-cyan-700 dark:bg-cyan-900 dark:text-cyan-300',
      oga: 'bg-fuchsia-100 text-fuchsia-700 dark:bg-fuchsia-900 dark:text-fuchsia-300',
      weba: 'bg-rose-100 text-rose-700 dark:bg-rose-900 dark:text-rose-300',
      wav: 'bg-violet-100 text-violet-700 dark:bg-violet-900 dark:text-violet-300',
      flac: 'bg-pink-100 text-pink-700 dark:bg-pink-900 dark:text-pink-300',
      aac: 'bg-sky-100 text-sky-700 dark:bg-sky-900 dark:text-sky-300',
      gif: 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900 dark:text-yellow-300',
      jpg: 'bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-300',
      png: 'bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300',
      webp: 'bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300',
      svg: 'bg-purple-100 text-purple-700 dark:bg-purple-900 dark:text-purple-300',
      media: 'bg-gray-100 text-gray-700 dark:bg-gray-900 dark:text-gray-300',
    }
    return colorMap[format.toLowerCase()] || 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-400'
  }

  // 计算各个tab的数量
  const tabCounts = computed(() => {
    const counts = {
      all: mediaList.value.length,
      m3u8: 0,
      mp4: 0,
      mp3: 0,
      other: 0
    }
    
    mediaList.value.forEach(item => {
      const format = item.format.toLowerCase()
      if (format === 'm3u8') {
        counts.m3u8++
      } else if (format === 'mp4') {
        counts.mp4++
      } else if (format === 'mp3') {
        counts.mp3++
      } else {
        counts.other++
      }
    })
    
    return counts
  })

  // 根据当前激活的tab过滤列表
  const filteredMediaList = computed(() => {
    if (activeTab.value === 'all') {
      return mediaList.value
    } else if (activeTab.value === 'm3u8') {
      return mediaList.value.filter(item => item.format.toLowerCase() === 'm3u8')
    } else if (activeTab.value === 'mp4') {
      return mediaList.value.filter(item => item.format.toLowerCase() === 'mp4')
    } else if (activeTab.value === 'mp3') {
      return mediaList.value.filter(item => item.format.toLowerCase() === 'mp3')
    } else if (activeTab.value === 'other') {
      return mediaList.value.filter(item => {
        const format = item.format.toLowerCase()
        return format !== 'm3u8' && format !== 'mp4' && format !== 'mp3'
      })
    }
    return mediaList.value
  })

  const toggleExpand = (id: number) => {
    expandedId.value = expandedId.value === id ? null : id
  }

  const showToastMsg = (msg: string) => {
    toastMessage.value = msg
    showToast.value = true
    setTimeout(() => { showToast.value = false }, 2000)
  }

  const playUrl = (url: string) => {
    browser.tabs.create({ url })
  }

  const copyUrl = (url: string) => {
    navigator.clipboard.writeText(url).then(() => {
      showToastMsg(browser.i18n.getMessage('copyTips'))
    })
  }

  const downloadUrl = (url: string) => {
    const filename = getFileName(url)
    browser.downloads.download({ url, filename })
  }

  const openSettings = () => {
    browser.runtime.openOptionsPage?.()
  }

  const openFeedback = () => {
    showMore.value = false
    browser.tabs.create({ url: 'https://github.com' })
  }

  const openHelp = () => {
    showMore.value = false
    browser.tabs.create({ url: 'https://github.com' })
  }
</script>

<template>
  <div class="w-[500px] min-w-[500px] h-[600px] max-h-[600px] bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100 flex flex-col">
    <div class="border-b border-gray-200 dark:border-gray-700 sticky top-0 bg-white dark:bg-gray-900 z-10 shrink-0">
      <nav class="flex -mb-px">
        <button
          @click="activeTab = 'all'"
          :class="[
            activeTab === 'all'
              ? 'border-blue-500 text-blue-600 dark:text-blue-400 dark:border-blue-400'
              : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300 dark:text-gray-400 dark:hover:text-gray-300',
            'flex-1 py-3 px-1 text-center border-b-2 font-medium text-sm transition-colors'
          ]"
        >
          全部({{ tabCounts.all }})
        </button>
        <button
          @click="activeTab = 'm3u8'"
          :class="[
            activeTab === 'm3u8'
              ? 'border-purple-500 text-purple-600 dark:text-purple-400 dark:border-purple-400'
              : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300 dark:text-gray-400 dark:hover:text-gray-300',
            'flex-1 py-3 px-1 text-center border-b-2 font-medium text-sm transition-colors'
          ]"
        >
          HLS({{ tabCounts.m3u8 }})
        </button>
        <button
          @click="activeTab = 'mp4'"
          :class="[
            activeTab === 'mp4'
              ? 'border-blue-500 text-blue-600 dark:text-blue-400 dark:border-blue-400'
              : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300 dark:text-gray-400 dark:hover:text-gray-300',
            'flex-1 py-3 px-1 text-center border-b-2 font-medium text-sm transition-colors'
          ]"
        >
          MP4({{ tabCounts.mp4 }})
        </button>
        <button
          @click="activeTab = 'mp3'"
          :class="[
            activeTab === 'mp3'
              ? 'border-green-500 text-green-600 dark:text-green-400 dark:border-green-400'
              : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300 dark:text-gray-400 dark:hover:text-gray-300',
            'flex-1 py-3 px-1 text-center border-b-2 font-medium text-sm transition-colors'
          ]"
        >
          MP3({{ tabCounts.mp3 }})
        </button>
        <button
          @click="activeTab = 'other'"
          :class="[
            activeTab === 'other'
              ? 'border-gray-500 text-gray-600 dark:text-gray-400 dark:border-gray-400'
              : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300 dark:text-gray-400 dark:hover:text-gray-300',
            'flex-1 py-3 px-1 text-center border-b-2 font-medium text-sm transition-colors'
          ]"
        >
          其他({{ tabCounts.other }})
        </button>
      </nav>
    </div>

    <main class="flex-1 overflow-y-auto min-h-0">
      <div v-if="filteredMediaList.length === 0"
        class="h-full flex flex-col items-center justify-center text-gray-400 dark:text-gray-500 px-6 py-12">
        <div class="w-20 h-20 mb-4 rounded-full bg-gray-100 dark:bg-gray-800 flex items-center justify-center">
          <svg class="w-10 h-10 text-gray-400 dark:text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5"
              d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
          </svg>
        </div>
        <p class="text-base font-medium text-gray-600 dark:text-gray-400 mb-2">{{ browser.i18n.getMessage('notFound') }}</p>
        <p class="text-sm text-center text-gray-500 dark:text-gray-500 leading-relaxed">{{ browser.i18n.getMessage('playTips') }}</p>
      </div>

      <ul v-else class="divide-y divide-gray-200 dark:divide-gray-800">
        <li v-for="(item, index) in filteredMediaList" :key="index"
          class="hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors">
          <div @click="toggleExpand(index)" class="p-3 flex items-center justify-between gap-2 cursor-pointer">
            <div class="flex-1 min-w-0 flex items-center gap-2">
              <svg class="w-4 h-4 text-gray-400 transition-transform flex-shrink-0"
                :class="{ 'rotate-90': expandedId === index }" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" />
              </svg>
              <p class="font-medium text-sm truncate">{{ getFileName(item.url) }}</p>
            </div>
            <div class="flex items-center gap-2" @click.stop>
              <span :class="getFormatColor(item.format)" class="px-1.5 py-0.5 rounded text-xs font-medium flex-shrink-0">
                {{ getFormatLabel(item.format) }}
              </span>
              <div class="flex gap-1">
                <button @click="copyUrl(item.url)"
                  class="p-1.5 rounded bg-gray-200 dark:bg-gray-700 hover:bg-gray-300 dark:hover:bg-gray-600 transition-colors"
                  :title="browser.i18n.getMessage('copyUrl')">
                  <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                      d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                  </svg>
                </button>
                <button @click="playUrl(item.url)"
                  class="p-1.5 rounded bg-green-600 hover:bg-green-500 text-white transition-colors"
                  :title="browser.i18n.getMessage('play')">
                  <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                      d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                      d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                </button>
                <button @click="downloadUrl(item.url)"
                  class="p-1.5 rounded bg-blue-600 hover:bg-blue-500 text-white transition-colors"
                  :title="browser.i18n.getMessage('download')">
                  <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                      d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                  </svg>
                </button>
              </div>
            </div>
          </div>
          <div v-if="expandedId === index" class="px-3 pb-3 pl-9">
            <p class="text-xs text-gray-500 dark:text-gray-400 break-all bg-gray-50 dark:bg-gray-800 p-2 rounded">
              {{ item.url }}
            </p>
          </div>
        </li>
      </ul>
    </main>

    <footer
      class="px-3 py-2 border-t border-gray-200 dark:border-gray-700 flex items-center justify-between text-xs relative shrink-0 bg-white dark:bg-gray-900">
      <button @click="openSettings"
        class="flex items-center gap-1 text-gray-500 dark:text-gray-400 hover:text-blue-500 dark:hover:text-blue-400 transition-colors">
        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
            d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
        </svg>
        <span>{{ browser.i18n.getMessage('settings') }}</span>
      </button>

      <span class="text-gray-400 dark:text-gray-500">v{{ version }}</span>

      <div class="relative">
        <button @click="showMore = !showMore"
          class="flex items-center gap-1 text-gray-500 dark:text-gray-400 hover:text-blue-500 dark:hover:text-blue-400 transition-colors">
          <span>{{ browser.i18n.getMessage('more') }}</span>
          <svg class="w-4 h-4 transition-transform" :class="{ 'rotate-180': showMore }" fill="none"
            stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
          </svg>
        </button>

        <div v-if="showMore"
          class="absolute bottom-full right-0 mb-1 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-md shadow-lg overflow-hidden min-w-24">
          <a href="#" @click.prevent="openFeedback"
            class="flex items-center gap-2 px-3 py-2 text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors">
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                d="M7 8h10M7 12h4m1 8l-4-4H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-3l-4 4z" />
            </svg>
            <span>{{ browser.i18n.getMessage('feedback') }}</span>
          </a>
          <a href="#" @click.prevent="openHelp"
            class="flex items-center gap-2 px-3 py-2 text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors">
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <span>{{ browser.i18n.getMessage('help') }}</span>
          </a>
        </div>
      </div>
    </footer>

    <Transition enter-active-class="transition ease-out duration-300" enter-from-class="opacity-0 translate-y-2"
      enter-to-class="opacity-100 translate-y-0" leave-active-class="transition ease-in duration-200"
      leave-from-class="opacity-100 translate-y-0" leave-to-class="opacity-0 translate-y-2">
      <div v-if="showToast"
        class="absolute bottom-16 left-1/2 -translate-x-1/2 px-4 py-2 bg-gray-800 dark:bg-gray-100 text-white dark:text-gray-800 rounded-lg shadow-lg text-sm flex items-center gap-2">
        <svg class="w-4 h-4 text-green-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" />
        </svg>
        {{ toastMessage }}
      </div>
    </Transition>
  </div>
</template>

<style scoped></style>
