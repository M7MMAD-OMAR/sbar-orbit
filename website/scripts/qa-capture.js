window.__qaErrors=[];
window.addEventListener('error',e=>window.__qaErrors.push(String(e.message)));
window.addEventListener('unhandledrejection',e=>window.__qaErrors.push(String(e.reason)));
const originalError=console.error;
console.error=(...args)=>{window.__qaErrors.push(args.map(String).join(' '));originalError(...args)};
if(new URLSearchParams(location.search).has('qa')){
  const update=()=>{
    let output=document.getElementById('qa-report');
    if(!output){output=document.createElement('pre');output.id='qa-report';output.style.display='none';document.body.append(output)}
    const images=[...document.images];
    output.textContent=JSON.stringify({
      width:innerWidth,height:innerHeight,documentWidth:document.documentElement.scrollWidth,
      overflow:document.documentElement.scrollWidth>innerWidth,
      overflowing:[...document.querySelectorAll('main *')].filter(e=>e.getBoundingClientRect().right>innerWidth+1).map(e=>e.tagName+'.'+e.className).slice(0,10),
      brokenImages:images.filter(i=>i.complete&&!i.naturalWidth).map(i=>i.src),
      unloadedImages:images.filter(i=>!i.complete).map(i=>i.src),
      hero:document.querySelector('.hero-figure img')?.currentSrc,
      h1Count:document.querySelectorAll('h1').length,
      missingAnchors:[...document.querySelectorAll('a[href^="#"]')].filter(a=>!document.getElementById(a.hash.slice(1))).map(a=>a.hash),
      emptyLinks:[...document.querySelectorAll('a')].filter(a=>!a.getAttribute('href')||a.getAttribute('href')==='#').length,
      coffee:document.querySelector('.coffee-link')?.href,
      menuExpanded:document.querySelector('.menu-toggle')?.getAttribute('aria-expanded'),
      selectedViewer:document.querySelector('[role=tab][aria-selected=true]')?.textContent,
      font:getComputedStyle(document.querySelector('h1')).fontFamily,
      errors:window.__qaErrors
    });
  };
  window.addEventListener('load',()=>{update();setTimeout(update,1000)});
  window.addEventListener('resize',()=>setTimeout(update,200));
  document.addEventListener('click',()=>setTimeout(update,250));
}
