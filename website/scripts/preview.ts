import { resolve, sep } from 'node:path';
const directory=resolve(import.meta.dir,'../dist');
Bun.serve({hostname:'127.0.0.1',port:4196,async fetch(request){
  if (!['GET','HEAD'].includes(request.method)) return new Response('Method not allowed',{status:405});
  let pathname:string;
  try { pathname=decodeURIComponent(new URL(request.url).pathname); } catch { return new Response('Bad request',{status:400}); }
  const path=resolve(directory,`.${pathname.endsWith('/') ? `${pathname}index.html` : pathname}`);
  if (!path.startsWith(directory+sep)) return new Response('Not found',{status:404});
  const file=Bun.file(path);
  if(await file.exists()) return new Response(request.method==='HEAD'?null:file,{headers:{'content-type':file.type}});
  return new Response(request.method==='HEAD'?null:Bun.file(resolve(directory,'404.html')),{status:404,headers:{'content-type':'text/html'}});
}});
console.log('Orbit website preview: http://127.0.0.1:4196/');
