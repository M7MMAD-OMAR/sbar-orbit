import { expect, test } from "bun:test";
import { browserWitness, type WitnessIO } from "../experiments/browser-performance";
import { runtimeAdmission } from "../experiments/browser-performance-identity";
function acquisition(namespace = "20", owner = 20) {
 let detached = false;
 const browser = {newBrowserCDPSession:async()=>({
  send:async(method:string)=>method==="Browser.getVersion" ? {product:"Chrome/fixture"} : {processInfo:[{type:"browser",id:20}]},
  detach:async()=>{detached=true;}
 })} as unknown as import("playwright").Browser;
 const io: WitnessIO = {workerPid:10,canonical:async()=>"/owned/browser",read:async path=>{
  if(path==="/owner") return JSON.stringify({pid:owner});
  if(path.endsWith("/status")) return `NSpid:\t${namespace}\n`;
  const pid=path.includes("/20/")?20:10;
  const fields=Array.from({length:20},()=>"0");fields[0]="S";fields[1]=pid===20?"10":"1";fields[19]=String(pid*10);
  return `${pid} (fixture) ${fields.join(" ")}`;
 }};
 return {browser,io,detached:()=>detached};
}
test("acquisition accepts exact live namespace and owner",async()=>{
 const f=acquisition();const witness=await browserWitness(f.browser,"/owned/browser","/owner",f.io);
 expect(witness.pid).toBe(20);expect(witness.ancestry).toHaveLength(2);expect(f.detached()).toBe(true);
});
for(const namespace of ["20 1","1",""])test(`acquisition refuses namespace ${JSON.stringify(namespace)}`,async()=>{
 const f=acquisition(namespace);await expect(browserWitness(f.browser,"/owned/browser","/owner",f.io)).rejects.toThrow("namespace");
 expect(f.detached()).toBe(true);
});
test("acquisition refuses mismatched Orbit owner",async()=>{
 const f=acquisition("20",21);await expect(browserWitness(f.browser,"/owned/browser","/owner",f.io)).rejects.toThrow("owner PID");
 expect(f.detached()).toBe(true);
});
function delivered(row: {path:string;sha256:string;bytes:number}, loader: string = "js", delivery: string = "bun-source-contents") {
 return {...row,loader,delivery,argumentSha256:row.sha256,argumentBytes:row.bytes,completed:true,wrapperSha256:"e910b2e09229145d7b352098cdd39f393fa0b1f50562926622d50a73f0154260",wrapperBytes:239};
}
function receipt(){
 const binary={path:"/bun",sha256:"bun",bytes:1}, browser={path:"/browser",sha256:"browser",bytes:1};
 const entry={path:"/dependency/entry.js",sha256:"dependency",bytes:1};
 const extra={path:"/source/orbit-extra.ts",sha256:"source-extra",bytes:1};
 const before={bun:binary,browser,lock:{path:"/lock",sha256:"locked",bytes:1},package:{path:"/package.json",sha256:"package",bytes:1},dependencies:[entry],source:[extra]};
 const producer={experiment:{path:"/experiment.ts",sha256:"source",bytes:1},identity:{path:"/identity.ts",sha256:"identity",bytes:1},runner:{path:"/runner.ts",sha256:"runner",bytes:1}};
 const python={executable:"/python",sha256:"python",version:"fixture",loadedModules:{"/python/module.py":"module"}};
 return {runtime:{schema:2,failures:[] as string[],attempts:[delivered(entry)],stable:true,entryLoaded:true,loadedStable:true,workerPid:10,bunVersion:"fixture",entry:entry.path,before,after:structuredClone(before),producer,producerAfter:structuredClone(producer),loaded:[delivered(entry)],loadedAfter:[{...entry}]},
  tree:{worker:10,browserIdentity:{witness:{workerPid:10,browserVersion:"fixture"}},pythonBefore:python,pythonAfter:structuredClone(python),cleanup:"wait returned ECHILD",sampleFailures:0,timedOut:false,exitCode:0},
  binaries:{producer:structuredClone(producer),bun:binary,browser,python:{path:"/python",sha256:"python"}},shared:structuredClone(before)};
}

test("runtime admission accepts a stable linked receipt",()=>{const r=receipt();expect(runtimeAdmission(r.runtime,r.tree,r.binaries,r.shared)).toBe(true);});
for(const mode of ["entry","dependencies","loaded","producer","worker","python","browser","bun","cleanup"])test(`runtime admission rejects ${mode}`,()=>{
 const r=receipt();
 if(mode==="entry")r.runtime.entryLoaded=false;
 if(mode==="dependencies")r.runtime.after.dependencies[0]={path:"/dependency/entry.js",sha256:"changed",bytes:1};
 if(mode==="loaded")r.runtime.loadedStable=false;
 if(mode==="producer")r.runtime.producerAfter.experiment.sha256="changed";
 if(mode==="worker")r.runtime.workerPid=11;
 if(mode==="python")r.tree.pythonAfter.sha256="changed";
 if(mode==="browser")r.runtime.after.browser.sha256="changed";
 if(mode==="bun")r.runtime.after.bun.sha256="changed";
 if(mode==="cleanup")r.tree.cleanup="not measured";
 expect(runtimeAdmission(r.runtime,r.tree,r.binaries,r.shared)).toBe(false);
});

test("shared snapshot permits Orbit to load extra pinned modules",()=>{
 const r=receipt();const extra=r.shared.source[0];
 if(!extra)throw new Error("Fixture missing source module");
 r.runtime.loaded.push(delivered(extra,"ts"));r.runtime.attempts.push(delivered(extra,"ts"));r.runtime.loadedAfter.push({...extra});
 expect(runtimeAdmission(r.runtime,r.tree,r.binaries,r.shared)).toBe(true);
});
for(const mode of ["cross-worker-dependency","cross-worker-lock","cross-worker-source","loaded-content-substitution"])test(`shared snapshot rejects ${mode}`,()=>{
 const r=receipt();
 if(mode==="cross-worker-dependency"){
  const changed={path:"/dependency/entry.js",sha256:"changed",bytes:1};
  r.runtime.before.dependencies[0]=changed;r.runtime.after.dependencies[0]={...changed};
  r.runtime.loaded[0]=delivered(changed);r.runtime.loadedAfter[0]={...changed};
 }
 if(mode==="cross-worker-lock"){r.runtime.before.lock.sha256="changed";r.runtime.after.lock.sha256="changed";}
 if(mode==="cross-worker-source"){
  r.runtime.before.source[0]={path:"/source/orbit-extra.ts",sha256:"changed",bytes:1};
  r.runtime.after.source[0]={path:"/source/orbit-extra.ts",sha256:"changed",bytes:1};
 }
 if(mode==="loaded-content-substitution"){
  r.runtime.loaded[0]=delivered({path:"/dependency/entry.js",sha256:"changed",bytes:1});
  r.runtime.loadedAfter[0]={path:"/dependency/entry.js",sha256:"changed",bytes:1};
 }
 expect(runtimeAdmission(r.runtime,r.tree,r.binaries,r.shared)).toBe(false);
});

test("schema 2 admission rejects an absent schema",()=>{
 const r=receipt();const {schema,...withoutSchema}=r.runtime;
 expect(schema).toBe(2);expect(runtimeAdmission(withoutSchema,r.tree,r.binaries,r.shared)).toBe(false);
});
for(const schema of [1,999])test(`schema 2 admission rejects schema ${schema}`,()=>{
 const r=receipt();r.runtime.schema=schema;expect(runtimeAdmission(r.runtime,r.tree,r.binaries,r.shared)).toBe(false);
});
for(const mode of ["missing-completion","false-completion","argument-sha","argument-bytes","invalid-delivery","invalid-loader","compile-json","compile-tsx","parse-js","missing-attempts","failed-attempt","sticky-failure","attempt-substitution"])test(`schema 2 admission rejects ${mode}`,()=>{
 const r=receipt(),row=r.runtime.loaded[0],attempt=r.runtime.attempts[0];if(!row||!attempt)throw new Error("Missing admission fixture");
 if(mode==="missing-completion") { const {completed,...missing}=row;expect(completed).toBe(true);return expect(runtimeAdmission({...r.runtime,loaded:[missing],attempts:[missing]},r.tree,r.binaries,r.shared)).toBe(false); }
 if(mode==="false-completion")row.completed=false;
 if(mode==="argument-sha")row.argumentSha256="substituted";
 if(mode==="argument-bytes")row.argumentBytes=2;
 if(mode==="invalid-delivery")row.delivery="unknown";
 if(mode==="invalid-loader")row.loader="object";
 if(mode==="compile-json"){row.loader="json";row.delivery="commonjs-module-compile";}
 if(mode==="compile-tsx"){row.loader="tsx";row.delivery="commonjs-module-compile";}
 if(mode==="parse-js")row.delivery="commonjs-json-parse";
 if(mode==="missing-attempts")r.runtime.attempts=[];
 if(mode==="failed-attempt")r.runtime.attempts.unshift({...attempt,completed:false});
 if(mode==="sticky-failure")r.runtime.failures.push("actual prior compile failed");
 if(mode==="attempt-substitution")attempt.argumentSha256="substituted";
 if(["false-completion","argument-sha","argument-bytes","invalid-delivery","invalid-loader","compile-json","compile-tsx","parse-js"].includes(mode)) r.runtime.attempts=[structuredClone(row)];
 expect(runtimeAdmission(r.runtime,r.tree,r.binaries,r.shared)).toBe(false);
});
for(const [loader,delivery] of [["js","commonjs-module-compile"],["jsx","commonjs-module-compile"],["ts","commonjs-module-compile"],["json","commonjs-json-parse"],["json","bun-source-contents"],["tsx","bun-source-contents"]])test(`schema 2 admission accepts ${loader}/${delivery}`,()=>{
 if(!loader||!delivery)throw new Error("Missing delivery fixture");
 const r=receipt(),entry=r.shared.dependencies[0];if(!entry)throw new Error("Missing entry fixture");
 r.runtime.loaded=[delivered(entry,loader,delivery)];r.runtime.attempts=structuredClone(r.runtime.loaded);
 expect(runtimeAdmission(r.runtime,r.tree,r.binaries,r.shared)).toBe(true);
});

for(const mode of ["empty-bun-version","empty-browser-version","nonstring-python-version","nonobject-python-modules"])test(`runtime whole-receipt version consistency rejects ${mode}`,()=>{
 const r=receipt();
 if(mode==="empty-bun-version")r.runtime.bunVersion="";
 if(mode==="empty-browser-version")r.tree.browserIdentity.witness.browserVersion="";
 if(mode==="nonstring-python-version") { const python={...r.tree.pythonBefore,version:123}; return expect(runtimeAdmission(r.runtime,{...r.tree,pythonBefore:python,pythonAfter:structuredClone(python)},r.binaries,r.shared)).toBe(false); }
 if(mode==="nonobject-python-modules") { const python={...r.tree.pythonBefore,loadedModules:[]}; return expect(runtimeAdmission(r.runtime,{...r.tree,pythonBefore:python,pythonAfter:structuredClone(python)},r.binaries,r.shared)).toBe(false); }
 expect(runtimeAdmission(r.runtime,r.tree,r.binaries,r.shared)).toBe(false);
});
