export default defineContentScript({
  matches: ["*://*/*"],
  allFrames: true,
  runAt: "document_end",
  main(ctx) {

    const script = document.createElement('script');
    script.src = browser.runtime.getURL('/injected.js'); // 需在 manifest 定义为 web_accessible_resources
    (document.head || document.documentElement).appendChild(script);

    const html = document.documentElement.innerHTML
    const regex = /(https?:\/\/[^"' ]+\.m3u8[^"' ]*)/g
    const matches = html.match(regex) || []
    matches.forEach(url => {
      browser.runtime.sendMessage({
        type: "M3U8_FOUND",
        url
      })

    })
    window.addEventListener('message', (event) => {
      if (event.data.type === 'M3U8_DETECTED') {
        browser.runtime.sendMessage({
          type: "M3U8_FOUND",
          url: event.data.url
        });
      }
    });
  },
});