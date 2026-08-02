<script lang="ts" setup>
  import { computed } from 'vue'
  import { currentLocale, currentTheme, currentDensity, t, LOCALE_OPTIONS, type ThemeMode, type DensityMode } from '../../../utils/i18n'
  import type { Settings, SniffingGroup } from '../../../utils/settings'

  defineProps<{ saved: boolean; resetConfirm: boolean }>()
  const emit = defineEmits<{
    close: []
    save: []
    'text-save': []
    shortcuts: []
    reset: []
  }>()
  const settings = defineModel<Settings>('settings', { required: true })
  const excludeDomainsText = defineModel<string>('excludeDomainsText', { required: true })
  const SNIFFING_ROWS = computed<{ key: SniffingGroup; label: string; icon: string }[]>(() => [
    { key: 'streaming', label: t('streaming'), icon: '📡' },
    { key: 'video', label: t('video'), icon: '🎬' },
    { key: 'audio', label: t('audio'), icon: '🎵' },
    { key: 'image', label: t('image'), icon: '🖼️' },
    { key: 'document', label: t('document'), icon: '📄' },
    { key: 'subtitle', label: t('subtitleGroup'), icon: '📝' },
  ])
</script>

<template>      <div class="flex flex-col h-full absolute inset-0 z-20 bg-white dark:bg-gray-900">

        <!-- Header -->
        <div class="shrink-0 px-4 py-3 border-b border-gray-200 dark:border-gray-700 flex items-center justify-between bg-white dark:bg-gray-900 shadow-sm">
          <div class="flex items-center gap-2">
            <button @click="emit('close')"
              class="p-1.5 rounded-lg text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 active:scale-90 transition-all duration-150">
              <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7" />
              </svg>
            </button>
            <span class="font-semibold text-sm">{{ t('settings') }}</span>
          </div>

          <!-- Saved indicator - banner style -->
          <Transition
            enter-active-class="transition-all duration-300 ease-out"
            enter-from-class="opacity-0 scale-75"
            enter-to-class="opacity-100 scale-100"
            leave-active-class="transition-all duration-200 ease-in"
            leave-from-class="opacity-100 scale-100"
            leave-to-class="opacity-0 scale-75"
          >
            <div v-if="saved"
              class="flex items-center gap-1.5 px-3 py-1 bg-green-500 text-white text-xs font-semibold rounded-full shadow-sm shadow-green-200 dark:shadow-green-900">
              <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M5 13l4 4L19 7" />
              </svg>
              {{ t('saved') }}
            </div>
          </Transition>
        </div>

        <div class="flex-1 overflow-y-auto min-h-0 px-4 py-4 space-y-3">

          <!-- Appearance -->
          <div class="bg-gray-50 dark:bg-gray-800/80 rounded-2xl overflow-hidden border border-gray-100 dark:border-gray-700/50 shadow-sm">
            <div class="px-4 py-3 border-b border-gray-200 dark:border-gray-700/70 flex items-center gap-2">
              <div class="w-1.5 h-4 bg-purple-500 rounded-full"></div>
              <p class="text-xs font-bold text-gray-600 dark:text-gray-300 uppercase tracking-wider">{{ t('appearance') }}</p>
            </div>
            <div class="divide-y divide-gray-100 dark:divide-gray-700/50">
              <div class="flex items-center justify-between px-4 py-3">
                <span class="text-sm text-gray-700 dark:text-gray-300 font-medium">{{ t('theme') }}</span>
                <div class="flex items-center gap-1 bg-gray-100 dark:bg-gray-700/60 rounded-lg p-0.5">
                  <button
                    v-for="opt in [{ value: 'system', icon: '💻', label: t('themeSystem') }, { value: 'light', icon: '☀️', label: t('themeLight') }, { value: 'dark', icon: '🌙', label: t('themeDark') }]"
                    :key="opt.value"
                    @click="currentTheme = opt.value as ThemeMode"
                    :class="['flex items-center gap-1 px-2 py-1 rounded-md text-xs font-medium transition-all', currentTheme === opt.value ? 'bg-white dark:bg-gray-600 text-gray-800 dark:text-gray-100 shadow-sm' : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200']"
                    :title="opt.label"
                  >
                    <span>{{ opt.icon }}</span>
                    <span class="hidden sm:inline">{{ opt.label }}</span>
                  </button>
                </div>
              </div>
              <div class="flex items-center justify-between px-4 py-3">
                <span class="text-sm text-gray-700 dark:text-gray-300 font-medium">{{ t('density') }}</span>
                <div class="flex items-center gap-1 bg-gray-100 dark:bg-gray-700/60 rounded-lg p-0.5">
                  <button
                    v-for="opt in [{ value: 'compact', label: t('densityCompact') }, { value: 'comfortable', label: t('densityComfortable') }]"
                    :key="opt.value"
                    @click="currentDensity = opt.value as DensityMode"
                    :class="['px-2 py-1 rounded-md text-xs font-medium transition-all', currentDensity === opt.value ? 'bg-white dark:bg-gray-600 text-gray-800 dark:text-gray-100 shadow-sm' : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200']">
                    {{ opt.label }}
                  </button>
                </div>
              </div>
              <div class="flex items-center justify-between px-4 py-3">
                <span class="text-sm text-gray-700 dark:text-gray-300 font-medium">{{ t('language') }}</span>
                <select
                  v-model="currentLocale"
                  class="text-xs px-2 py-1.5 rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-purple-500 focus:border-transparent transition-all"
                >
                  <option v-for="opt in LOCALE_OPTIONS" :key="opt.code" :value="opt.code">
                    {{ opt.nativeLabel }}{{ opt.code === 'system' ? '' : ` (${opt.label})` }}
                  </option>
                </select>
              </div>
            </div>
          </div>

          <!-- Sniffing Groups -->
          <div class="bg-gray-50 dark:bg-gray-800/80 rounded-2xl overflow-hidden border border-gray-100 dark:border-gray-700/50 shadow-sm">
            <div class="px-4 py-3 border-b border-gray-200 dark:border-gray-700/70 flex items-center gap-2">
              <div class="w-1.5 h-4 bg-blue-500 rounded-full"></div>
              <p class="text-xs font-bold text-gray-600 dark:text-gray-300 uppercase tracking-wider">{{ t('sniffingRules') }}</p>
            </div>
            <div class="grid grid-cols-[minmax(120px,1fr)_88px_minmax(100px,auto)] items-center px-4 py-2 border-b border-gray-100 dark:border-gray-700/50 bg-gray-100/60 dark:bg-gray-700/40 min-w-0">
              <span class="text-xs font-semibold text-gray-400 dark:text-gray-500 uppercase tracking-wider col-start-1">{{ t('type') }}</span>
              <span class="text-xs font-semibold text-gray-400 dark:text-gray-500 uppercase tracking-wider text-center col-start-2">{{ t('sniff') }}</span>
              <span class="text-xs font-semibold text-gray-400 dark:text-gray-500 uppercase tracking-wider text-right col-start-3">{{ t('minSizeKB') }}</span>
            </div>
            <div class="divide-y divide-gray-100 dark:divide-gray-700/50">
               <div v-for="row in SNIFFING_ROWS" :key="row.key"
                class="grid grid-cols-[minmax(120px,1fr)_88px_minmax(100px,auto)] items-center px-4 py-3 hover:bg-gray-100/60 dark:hover:bg-gray-700/40 transition-colors duration-150 min-w-0">
                <div class="flex items-center gap-2 min-w-0 overflow-hidden">
                  <span class="text-base leading-none select-none flex-shrink-0">{{ row.icon }}</span>
                  <span class="text-sm text-gray-700 dark:text-gray-300 font-medium truncate min-w-0">{{ row.label }}</span>
                </div>
                <div class="flex justify-center">
                  <button
                    type="button"
                    role="switch"
                    :aria-checked="settings.sniffingRules[row.key].enabled"
                    @click="settings.sniffingRules[row.key].enabled = !settings.sniffingRules[row.key].enabled; emit('save')"
                    :class="['relative inline-flex h-5 w-9 flex-shrink-0 rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none shadow-inner', settings.sniffingRules[row.key].enabled ? 'bg-blue-500' : 'bg-gray-300 dark:bg-gray-600']"
                  >
                    <span :class="['pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow-md transition-transform duration-200 ease-in-out', settings.sniffingRules[row.key].enabled ? 'translate-x-4' : 'translate-x-0']" />
                  </button>
                </div>
                <div class="flex items-center gap-2 justify-end min-w-0">
                  <input
                  type="number" min="0" step="1"
                    v-model.number="settings.sniffingRules[row.key].minSizeKB"
                    @change="emit('save')"
                    :disabled="!settings.sniffingRules[row.key].enabled"
                    class="w-20 px-2.5 py-1.5 text-sm text-right rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all duration-150 disabled:opacity-35 disabled:cursor-not-allowed flex-shrink-0"
                  />
                  <span class="text-xs text-gray-400 dark:text-gray-500 flex-shrink-0">{{ t('kb') }}</span>
                </div>
              </div>
            </div>
          </div>

          <!-- Max Items -->
          <div class="bg-gray-50 dark:bg-gray-800/80 rounded-2xl overflow-hidden border border-gray-100 dark:border-gray-700/50 shadow-sm">
            <div class="px-4 py-3 border-b border-gray-200 dark:border-gray-700/70 flex items-center gap-2">
              <div class="w-1.5 h-4 bg-yellow-500 rounded-full"></div>
              <p class="text-xs font-bold text-gray-600 dark:text-gray-300 uppercase tracking-wider">{{ t('maxItems') }}</p>
            </div>
            <div class="px-4 py-4 flex items-center gap-3">
              <input
                type="number" min="10" max="5000" step="100"
                v-model.number="settings.maxItems"
                @change="emit('save')"
                class="w-28 px-2.5 py-1.5 text-sm text-right rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-yellow-500 focus:border-transparent transition-all duration-150"
              />
              <span class="text-xs text-gray-400 dark:text-gray-500">{{ t('maxItemsDesc') }}</span>
            </div>
          </div>

          <!-- MSE Capture -->
          <div class="bg-gray-50 dark:bg-gray-800/80 rounded-2xl overflow-hidden border border-gray-100 dark:border-gray-700/50 shadow-sm">
            <div class="px-4 py-3 border-b border-gray-200 dark:border-gray-700/70 flex items-center gap-2">
              <div class="w-1.5 h-4 bg-rose-500 rounded-full"></div>
              <p class="text-xs font-bold text-gray-600 dark:text-gray-300 uppercase tracking-wider">MSE {{ t('capture') || 'Capture' }}</p>
            </div>
            <div class="px-4 py-4 flex items-center justify-between gap-3">
              <div class="flex-1 min-w-0">
                <p class="text-sm text-gray-700 dark:text-gray-300 font-medium">{{ t('enableMseCapture') || '启用 MSE 流捕获' }}</p>
                <p class="text-xs text-gray-400 dark:text-gray-500 mt-0.5 leading-relaxed">{{ t('enableMseCaptureDesc') || '拦截 MediaSource 流数据，支持捕获无 URL 的视频（如部分网页播放器）。会占用较多内存，建议按需开启。' }}</p>
              </div>
              <button
                type="button"
                role="switch"
                :aria-checked="settings.enableMseCapture"
                @click="settings.enableMseCapture = !settings.enableMseCapture; emit('save')"
                :class="['relative inline-flex h-5 w-9 flex-shrink-0 rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none shadow-inner', settings.enableMseCapture ? 'bg-rose-500' : 'bg-gray-300 dark:bg-gray-600']"
              >
                <span :class="['pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow-md transition-transform duration-200 ease-in-out', settings.enableMseCapture ? 'translate-x-4' : 'translate-x-0']" />
              </button>
            </div>
            <div class="px-4 py-4 flex items-center justify-between gap-3 border-t border-gray-200 dark:border-gray-700/70">
              <div class="flex-1 min-w-0">
                <p class="text-sm text-gray-700 dark:text-gray-300 font-medium">{{ t('hideStreamSegments') || '隐藏流媒体分片' }}</p>
                <p class="text-xs text-gray-400 dark:text-gray-500 mt-0.5 leading-relaxed">{{ t('hideStreamSegmentsDesc') || '隐藏 HLS/DASH 的分片（如 .ts/.m4s），只显示其播放列表入口（m3u8/mpd）。关闭后可单独查看/下载分片。' }}</p>
              </div>
              <button
                type="button"
                role="switch"
                :aria-checked="settings.hideStreamSegments"
                @click="settings.hideStreamSegments = !settings.hideStreamSegments; emit('save')"
                :class="['relative inline-flex h-5 w-9 flex-shrink-0 rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none shadow-inner', settings.hideStreamSegments ? 'bg-rose-500' : 'bg-gray-300 dark:bg-gray-600']"
              >
                <span :class="['pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow-md transition-transform duration-200 ease-in-out', settings.hideStreamSegments ? 'translate-x-4' : 'translate-x-0']" />
              </button>
            </div>
            <div class="px-4 py-4 flex items-center justify-between gap-3 border-t border-gray-200 dark:border-gray-700/70">
              <div class="flex-1 min-w-0">
                <p class="text-sm text-gray-700 dark:text-gray-300 font-medium">{{ t('captureDataImages') || '捕获 data: URL 图片' }}</p>
                <p class="text-xs text-gray-400 dark:text-gray-500 mt-0.5 leading-relaxed">{{ t('captureDataImagesDesc') }}</p>
              </div>
              <button
                type="button"
                role="switch"
                :aria-checked="settings.captureDataImages"
                @click="settings.captureDataImages = !settings.captureDataImages; emit('save')"
                :class="['relative inline-flex h-5 w-9 flex-shrink-0 rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none shadow-inner', settings.captureDataImages ? 'bg-rose-500' : 'bg-gray-300 dark:bg-gray-600']"
              >
                <span :class="['pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow-md transition-transform duration-200 ease-in-out', settings.captureDataImages ? 'translate-x-4' : 'translate-x-0']" />
              </button>
            </div>
            <div v-if="settings.captureDataImages" class="px-4 py-4 flex items-center justify-between gap-3 border-t border-gray-200 dark:border-gray-700/70">
              <div class="flex-1 min-w-0">
                <p class="text-sm text-gray-700 dark:text-gray-300 font-medium">{{ t('dataImageMinSizeKB') || 'data: 图片最小大小 (KB)' }}</p>
                <p class="text-xs text-gray-400 dark:text-gray-500 mt-0.5 leading-relaxed">{{ t('dataImageMinSizeKBDesc') }}</p>
              </div>
              <input
                type="number"
                min="0"
                step="10"
                v-model.number="settings.dataImageMinSizeKB"
                @change="emit('save')"
                class="w-20 px-2 py-1 text-sm rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-rose-500"
              />
            </div>
          </div>

          <!-- Exclude Domains -->
          <div class="bg-gray-50 dark:bg-gray-800/80 rounded-2xl overflow-hidden border border-gray-100 dark:border-gray-700/50 shadow-sm">
            <div class="px-4 py-3 border-b border-gray-200 dark:border-gray-700/70 flex items-center gap-2">
              <div class="w-1.5 h-4 bg-red-500 rounded-full"></div>
              <p class="text-xs font-bold text-gray-600 dark:text-gray-300 uppercase tracking-wider">{{ t('excludeDomains') }}</p>
            </div>
            <div class="px-4 py-4">
              <textarea
                v-model="excludeDomainsText"
                @input="emit('text-save')"
                @blur="emit('save')"
                rows="3"
                :placeholder="t('excludeDomainsPlaceholder')"
                class="w-full px-3 py-2 text-sm rounded-xl border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all duration-150 resize-none font-mono shadow-sm"
              />
              <p class="mt-2 text-xs text-gray-400 dark:text-gray-500">{{ t('excludeDomainsDesc') }}</p>
            </div>
          </div>

          <!-- Keyboard Shortcuts -->
          <div class="bg-gray-50 dark:bg-gray-800/80 rounded-2xl overflow-hidden border border-gray-100 dark:border-gray-700/50 shadow-sm">
            <div class="px-4 py-3 border-b border-gray-200 dark:border-gray-700/70 flex items-center gap-2">
              <div class="w-1.5 h-4 bg-indigo-500 rounded-full"></div>
              <p class="text-xs font-bold text-gray-600 dark:text-gray-300 uppercase tracking-wider">{{ t('keyboardShortcuts') }}</p>
            </div>
            <div class="px-4 py-4 flex items-center justify-between">
              <p class="text-sm text-gray-600 dark:text-gray-400">{{ t('keyboardShortcutsDesc') }}</p>
              <button type="button" @click="emit('shortcuts')"
                class="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-900/30 rounded-lg hover:bg-blue-100 dark:hover:bg-blue-900/50 active:scale-95 transition-all duration-150">
                {{ t('open') }}
                <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                </svg>
              </button>
            </div>
          </div>

          <!-- Reset -->
          <div class="pt-1 pb-3">
            <button
              type="button"
              @click="emit('reset')"
              :class="[
                'w-full py-3 rounded-2xl font-semibold text-sm transition-all duration-200 active:scale-98',
                resetConfirm
                  ? 'bg-red-500 hover:bg-red-600 text-white shadow-lg shadow-red-200 dark:shadow-red-900/40 scale-[1.01]'
                  : 'bg-red-50 hover:bg-red-100 dark:bg-red-900/20 dark:hover:bg-red-900/30 text-red-600 dark:text-red-400 border-2 border-red-200 dark:border-red-800'
              ]"
            >
              <span v-if="resetConfirm" class="flex items-center justify-center gap-2">
                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                </svg>
                {{ t('resetConfirm') }}
              </span>
              <span v-else class="flex items-center justify-center gap-2">
                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                </svg>
                {{ t('resetToDefaults') }}
              </span>
            </button>
          </div>

        </div>
      </div>

</template>
