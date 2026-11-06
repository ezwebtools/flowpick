import { installPlayerMediaPick } from '../utils/player-media-pick'

export default defineContentScript({
  matches: ['*://*/*'],
  allFrames: true,
  runAt: 'document_start',
  world: 'MAIN',
  main: installPlayerMediaPick,
})
