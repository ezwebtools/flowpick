export default defineUnlistedScript(() => {
  console.log("Hello from injected.ts");

  /* fetch hook */

const originalFetch = window.fetch

window.fetch = async (...args)=>{

  const url = args[0]

  if(typeof url==="string" && url.includes("m3u8")){
    send(url)
  }

  return originalFetch(...args)
}

/* xhr hook */

const open = XMLHttpRequest.prototype.open

XMLHttpRequest.prototype.open = function(...args){

  const url = args[1]

  if(typeof url==="string" && url.includes("m3u8")){
    send(url)
  }

  return open.apply(this,args)
}
  
});


function send(url:String){
 window.postMessage({
    type:"M3U8_DETECTED",
    url
  })


}