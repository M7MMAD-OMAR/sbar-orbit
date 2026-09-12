import { mkdir, writeFile, readFile, unlink } from 'node:fs/promises';
const socket = `${process.env.XDG_RUNTIME_DIR}/sbar-orbit/broker.sock`;
const base = 'http://127.0.0.1:4196/';
async function rpc(method:string, params:Record<string,unknown> = {}) {
  const response = await fetch('http://localhost/rpc', { unix: socket, method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({method,params}) });
  const data = await response.json() as {ok:boolean;result:any;error?:{message:string}};
  if (!data.ok) throw new Error(`${method}: ${data.error?.message}`);
  return data.result;
}
await mkdir('evidence',{recursive:true});
const productionHTML=(await readFile('dist/index.html','utf8')).replaceAll('<script src="/__qa-capture.js"></script>','');
await writeFile('dist/__qa-capture.js',await readFile('scripts/qa-capture.js'));
await writeFile('dist/index.html',productionHTML.replace('<head>','<head><script src="/__qa-capture.js"></script>'));
const created = await rpc('session.create',{backend:'browser',agentName:'Codex',taskName:'Orbit website responsive and interaction audit',viewport:{width:1440,height:1000}});
const sessionId=created.sessionId;
await writeFile('evidence/session-id.txt',sessionId);
async function act(action:Record<string,unknown>){return rpc('session.act',{sessionId,requestId:crypto.randomUUID(),action})}
async function read(selector:string){return act({type:'read',selector})}
async function capture(name:string){const shot=await rpc('session.observe',{sessionId});await writeFile(`evidence/${name}.jpg`,Buffer.from(shot.image,'base64'))}
const wait = (ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
const report:Record<string,unknown>={};
try {
  for(const width of [1440,768,390,320]){
    await act({type:'resize',width,height:1000});
    await act({type:'navigate',url:`${base}?qa=1`});
    await wait(1200);
    report[String(width)]=await read('#qa-report');
    await capture(`viewport-${width}`);
  }
  await act({type:'resize',width:390,height:1000});
  await act({type:'navigate',url:`${base}?qa=1`});await wait(200);
  await act({type:'click',selector:'.menu-toggle'});
  report.menuOpen=await read('.menu-toggle[aria-expanded="true"]');
  await capture('mobile-menu');
  await act({type:'click',selector:'.nav a[href="#support"]'});await wait(900);
  report.menuClosed=await read('.menu-toggle[aria-expanded="false"]');
  await capture('mobile-support');
  await act({type:'resize',width:1440,height:1000});
  await act({type:'navigate',url:`${base}?qa=1#in-control`});await wait(900);
  for(const tab of [1,2,3,0]){await act({type:'click',selector:`#viewer-tab-${tab}`});report[`viewer${tab}`]=await read('#viewer-panel')}
  await wait(300);await capture('desktop-viewer');
  await act({type:'navigate',url:`${base}?qa=1#get-started`});await wait(600);
  await act({type:'click',selector:'.copy-button'});await wait(500);report.copy=await read('.copy-status');
  await capture('desktop-install');
  await act({type:'click',selector:'.faqs details:first-child summary'});report.faq=await read('.faqs details[open]');
  await act({type:'click',selector:'.architecture summary'});report.architecture=await read('.architecture[open]');
  await capture('desktop-architecture');
  await act({type:'navigate',url:`${base}?qa=1#support`});await wait(600);await capture('desktop-support');
  report.final=await read('#qa-report');
  await writeFile('evidence/browser-audit.json',JSON.stringify(report,null,2));
  const failures:string[]=[];
  for (const width of [1440,768,390,320]) {
    const metrics=JSON.parse((report[String(width)] as {text:string}).text);
    if(metrics.overflow||metrics.brokenImages.length||metrics.errors.length||metrics.missingAnchors.length||metrics.emptyLinks) failures.push(`${width}px: ${JSON.stringify(metrics)}`);
  }
  if((report.copy as {text:string}).text !== 'Copied') failures.push(`Clipboard: ${JSON.stringify(report.copy)}`);
  console.log(JSON.stringify({widths:[1440,768,390,320],failures,copy:report.copy,sessionId,evidence:'evidence/browser-audit.json'},null,2));
  if(failures.length) process.exitCode=1;
} finally {
  await writeFile('dist/index.html',productionHTML);
  await unlink('dist/__qa-capture.js').catch(()=>{});
  await rpc('session.stop',{sessionId}).catch(()=>{});
}
