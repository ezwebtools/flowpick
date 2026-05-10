<script lang="ts" setup>
  const version = browser.runtime.getManifest().version
  const t = (key: string) => browser.i18n.getMessage(key as any)

  interface FaqItem {
    questionKey: string
    answerKey: string
    open: boolean
  }

  const faqs = ref<FaqItem[]>([
    { questionKey: 'faq1Q', answerKey: 'faq1A', open: false },
    { questionKey: 'faq2Q', answerKey: 'faq2A', open: false },
    { questionKey: 'faq3Q', answerKey: 'faq3A', open: false },
    { questionKey: 'faq4Q', answerKey: 'faq4A', open: false },
    { questionKey: 'faq5Q', answerKey: 'faq5A', open: false },
    { questionKey: 'faq6Q', answerKey: 'faq6A', open: false },
    { questionKey: 'faq7Q', answerKey: 'faq7A', open: false },
    { questionKey: 'faq8Q', answerKey: 'faq8A', open: false },
    { questionKey: 'faq9Q', answerKey: 'faq9A', open: false },
  ])

  function toggleFaq(index: number) {
    faqs.value[index].open = !faqs.value[index].open
  }
</script>

<template>
  <div class="min-h-screen bg-gradient-to-b from-blue-50 to-white dark:from-gray-950 dark:to-gray-900 text-gray-900 dark:text-gray-100">

    <div class="max-w-3xl mx-auto px-6 py-12">

      <div class="text-center mb-14">
        <img src="/icon/128.png" alt="FlowPick" class="block mx-auto w-20 h-20 rounded-2xl shadow-lg shadow-blue-600/25 mb-6" />
        <h1 class="text-3xl font-bold mb-2">FlowPick</h1>
        <p class="text-gray-500 dark:text-gray-400 text-sm">v{{ version }}</p>
        <p class="text-gray-500 dark:text-gray-400 mt-3 text-base">{{ t('welcomeSubtitle') }}</p>
      </div>

      <section class="mb-14">
        <h2 class="text-xl font-semibold mb-6 flex items-center gap-2">
          <span class="inline-flex items-center justify-center w-8 h-8 rounded-lg bg-blue-100 dark:bg-blue-900/40 text-blue-600 dark:text-blue-400">
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253" />
            </svg>
          </span>
          {{ t('tutorialTitle') }}
        </h2>

        <div class="space-y-4">
          <div class="flex gap-4 bg-white dark:bg-gray-800/60 rounded-2xl border border-gray-200 dark:border-gray-700/60 p-5">
            <div class="flex-shrink-0 w-9 h-9 rounded-full bg-blue-600 text-white flex items-center justify-center text-sm font-bold">1</div>
            <div>
              <h3 class="font-medium text-gray-900 dark:text-gray-100 mb-1">{{ t('step1Title') }}</h3>
              <p class="text-sm text-gray-500 dark:text-gray-400 leading-relaxed">{{ t('step1Desc') }}</p>
            </div>
          </div>

          <div class="flex gap-4 bg-white dark:bg-gray-800/60 rounded-2xl border border-gray-200 dark:border-gray-700/60 p-5">
            <div class="flex-shrink-0 w-9 h-9 rounded-full bg-blue-600 text-white flex items-center justify-center text-sm font-bold">2</div>
            <div>
              <h3 class="font-medium text-gray-900 dark:text-gray-100 mb-1">{{ t('step2Title') }}</h3>
              <p class="text-sm text-gray-500 dark:text-gray-400 leading-relaxed">{{ t('step2Desc') }}</p>
            </div>
          </div>

          <div class="flex gap-4 bg-white dark:bg-gray-800/60 rounded-2xl border border-gray-200 dark:border-gray-700/60 p-5">
            <div class="flex-shrink-0 w-9 h-9 rounded-full bg-blue-600 text-white flex items-center justify-center text-sm font-bold">3</div>
            <div>
              <h3 class="font-medium text-gray-900 dark:text-gray-100 mb-1">{{ t('step3Title') }}</h3>
              <p class="text-sm text-gray-500 dark:text-gray-400 leading-relaxed">{{ t('step3Desc') }}</p>
            </div>
          </div>

          <div class="flex gap-4 bg-white dark:bg-gray-800/60 rounded-2xl border border-gray-200 dark:border-gray-700/60 p-5">
            <div class="flex-shrink-0 w-9 h-9 rounded-full bg-blue-600 text-white flex items-center justify-center text-sm font-bold">4</div>
            <div>
              <h3 class="font-medium text-gray-900 dark:text-gray-100 mb-1">{{ t('step4Title') }}</h3>
              <p class="text-sm text-gray-500 dark:text-gray-400 leading-relaxed">{{ t('step4Desc') }}</p>
            </div>
          </div>

          <div class="flex gap-4 bg-white dark:bg-gray-800/60 rounded-2xl border border-gray-200 dark:border-gray-700/60 p-5">
            <div class="flex-shrink-0 w-9 h-9 rounded-full bg-blue-600 text-white flex items-center justify-center text-sm font-bold">5</div>
            <div>
              <h3 class="font-medium text-gray-900 dark:text-gray-100 mb-1">{{ t('step5Title') }}</h3>
              <p class="text-sm text-gray-500 dark:text-gray-400 leading-relaxed">{{ t('step5Desc') }}</p>
            </div>
          </div>

          <div class="flex gap-4 bg-white dark:bg-gray-800/60 rounded-2xl border border-gray-200 dark:border-gray-700/60 p-5">
            <div class="flex-shrink-0 w-9 h-9 rounded-full bg-blue-600 text-white flex items-center justify-center text-sm font-bold">6</div>
            <div>
              <h3 class="font-medium text-gray-900 dark:text-gray-100 mb-1">{{ t('step6Title') }}</h3>
              <p class="text-sm text-gray-500 dark:text-gray-400 leading-relaxed">{{ t('step6Desc') }}</p>
            </div>
          </div>
        </div>
      </section>

      <section class="mb-14">
        <h2 class="text-xl font-semibold mb-6 flex items-center gap-2">
          <span class="inline-flex items-center justify-center w-8 h-8 rounded-lg bg-amber-100 dark:bg-amber-900/40 text-amber-600 dark:text-amber-400">
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          </span>
          {{ t('faqTitle') }}
        </h2>

        <div class="space-y-3">
          <div
            v-for="(faq, index) in faqs"
            :key="index"
            class="bg-white dark:bg-gray-800/60 rounded-2xl border border-gray-200 dark:border-gray-700/60 overflow-hidden transition-all duration-200"
          >
            <button
              @click="toggleFaq(index)"
              class="w-full flex items-center justify-between px-5 py-4 text-left hover:bg-gray-50 dark:hover:bg-gray-700/30 transition-colors"
            >
              <span class="text-sm font-medium text-gray-800 dark:text-gray-200 pr-4">{{ t(faq.questionKey) }}</span>
              <svg
                :class="['w-5 h-5 text-gray-400 dark:text-gray-500 flex-shrink-0 transition-transform duration-200', faq.open ? 'rotate-180' : '']"
                fill="none" stroke="currentColor" viewBox="0 0 24 24"
              >
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
              </svg>
            </button>
            <div
              v-show="faq.open"
              class="px-5 pb-4"
            >
              <p class="text-sm text-gray-500 dark:text-gray-400 leading-relaxed">{{ t(faq.answerKey) }}</p>
            </div>
          </div>
        </div>
      </section>

      <section class="mb-8">
        <div class="bg-white dark:bg-gray-800/60 rounded-2xl border border-gray-200 dark:border-gray-700/60 p-6 text-center">
          <h3 class="font-medium text-gray-900 dark:text-gray-100 mb-2">{{ t('needMoreHelp') }}</h3>
          <p class="text-sm text-gray-500 dark:text-gray-400 mb-4">{{ t('needMoreHelpDesc') }}</p>
          <a
            href="https://github.com/ezwebtools/flowpick/discussions"
            target="_blank"
            rel="noopener noreferrer"
            class="inline-flex items-center gap-2 px-5 py-2.5 bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900 rounded-xl text-sm font-medium hover:opacity-90 transition-opacity"
          >
            <svg class="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
              <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"/>
            </svg>
            GitHub
          </a>
        </div>
      </section>

      <footer class="text-center text-xs text-gray-400 dark:text-gray-600 pb-8">
        FlowPick v{{ version }}
      </footer>

    </div>
  </div>
</template>
