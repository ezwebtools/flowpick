interface DashPlayer {
  getVersion(): string
  getVideoElement(): HTMLMediaElement
  getSource(): unknown
  on(event: string, listener: () => void): void
}

interface DashManifestModel {
  getValue(): { originalUrl?: string } | undefined
}

interface DashVideoModel {
  getElement(): HTMLMediaElement
}

interface DashMediaSourceController {
  attachMediaSource(model: DashVideoModel): string
}

interface DashJs {
  MediaPlayer: ((context?: object) => { create(): DashPlayer }) & {
    events?: { MANIFEST_LOADED?: string }
  }
  FactoryMaker?: {
    getSingletonInstance<T>(context: object, name: string): T | null
  }
}

function loadedManifest(player: DashPlayer, manifestModel: DashManifestModel) {
  const source = player.getSource()
  const originalUrl = manifestModel.getValue()?.originalUrl
  if (typeof source !== 'string' || !originalUrl) return
  const url = new URL(source, document.baseURI)
  if (/^https?:$/.test(url.protocol) && url.href === new URL(originalUrl, document.baseURI).href) return url.href
}

export function trackDashJsAttachments() {
  const tracked = new WeakSet<DashJs>()
  const attached = new WeakMap<HTMLMediaElement, () => string | undefined>()

  function observeGlobal() {
    try {
      const page = window as Window & { dashjs?: DashJs }
      const dash = page.dashjs
      if (!dash || tracked.has(dash) || typeof dash.MediaPlayer !== 'function') return
      const factoryMaker = dash.FactoryMaker
      const event = dash.MediaPlayer.events?.MANIFEST_LOADED
      if (!event || typeof factoryMaker?.getSingletonInstance !== 'function') return
      const descriptor = Object.getOwnPropertyDescriptor(dash, 'MediaPlayer')
      if (descriptor && 'value' in descriptor && !descriptor.configurable && !descriptor.writable) return

      const mediaPlayer = new Proxy(dash.MediaPlayer, {
        apply(factory, receiver, args) {
          // Only track contexts created here, where ownership is provable.
          if (args[0] !== undefined) return Reflect.apply(factory, receiver, args)
          const context = {}
          const instanceFactory = Reflect.apply(factory, receiver, [context, ...args.slice(1)])
          try {
            const create = instanceFactory.create
            let creations = 0
            instanceFactory.create = function (...createArgs: unknown[]) {
              const player: DashPlayer = Reflect.apply(create, this, createArgs)
              creations++
              if (creations !== 1) return player
              try {
                if (/^(?:4\.7|5)\./.test(player.getVersion())) observePlayer(player, context, () => creations === 1)
              } catch {
                // Leave playback running on an unsupported player.
              }
              return player
            }
          } catch {
            // A factory with an immutable create method still works as usual.
          }
          return instanceFactory
        },
      })

      function observePlayer(player: DashPlayer, context: object, ownsContext: () => boolean) {
        const controllers = new WeakSet<DashMediaSourceController>()
        player.on(event!, () => {
          if (!ownsContext()) return
          try {
            const controller = factoryMaker!.getSingletonInstance<DashMediaSourceController>(context, 'MediaSourceController')
            const manifestModel = factoryMaker!.getSingletonInstance<DashManifestModel>(context, 'ManifestModel')
            if (!controller || !manifestModel || controllers.has(controller) || typeof controller.attachMediaSource !== 'function') return
            const attach = controller.attachMediaSource
            controller.attachMediaSource = function (model) {
              const blob = Reflect.apply(attach, this, [model])
              try {
                const element = model.getElement()
                const manifest = loadedManifest(player, manifestModel)
                if (manifest && blob.startsWith('blob:') && player.getVideoElement() === element) {
                  attached.set(element, () => {
                    if (ownsContext() && player.getVideoElement() === element && element.src === blob
                      && element.currentSrc === blob && loadedManifest(player, manifestModel) === manifest) return manifest
                  })
                }
              } catch {
                // A blob without a verifiable manifest remains unresolved.
              }
              return blob
            }
            controllers.add(controller)
          } catch {
            // A site-specific controller may not be observable.
          }
        })
      }

      const wrapped = new Proxy(dash, {
        get(target, property, receiver) {
          return property === 'MediaPlayer' ? mediaPlayer : Reflect.get(target, property, receiver)
        },
      })
      page.dashjs = wrapped
      tracked.add(dash)
      tracked.add(wrapped)
    } catch {
      // Preserve the site's library when its global cannot be wrapped.
    }
  }

  observeGlobal()
  document.addEventListener('load', event => {
    if (event.target instanceof HTMLScriptElement) observeGlobal()
  }, true)

  return (element: HTMLMediaElement) => {
    try { return attached.get(element)?.() } catch { return undefined }
  }
}
