import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { ConversationUsage } from "../src/conversation-usage";

const PRIVATE = "PRIVATE-owned-local-doctor-read";
const MARKER = "OWNED_DOCTOR_READ_ENTERED";
const retained = new Set<DoctorFixture>();
const linux = process.platform === "linux" ? test : test.skip;
const MAX_OUTPUT = 16 * 1024;
async function bounded<T>(work: Promise<T>, ms = 4000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([work, new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error("Owned doctor fixture completion unknown")), ms); })]); }
  finally { if (timer !== undefined) clearTimeout(timer); }
}
class DoctorFixture {
  root?: string;
  copy?: string;
  usage?: ConversationUsage;
  readonly conversation = "doctor-read-" + crypto.randomUUID();
  readonly pending = new Set<Promise<unknown>>();
  readonly children = new Set<Bun.Subprocess>();
  readonly inputEnds: (() => Promise<void>)[] = [];
  closing = false;
  unknown = false;
  track<T>(p: Promise<T>) { this.pending.add(p); void p.then(() => { this.pending.delete(p); }, () => { this.pending.delete(p); }); return p; }
  open() { if (this.closing) throw new Error("Owned doctor fixture closing"); }
  async setup() {
    this.root = await this.track(mkdtemp(join(tmpdir(), "orbit-doctor-read-"))); this.open();
    const root = this.root, shim = join(root, "fixed-desktop.mjs"), copy = join(root, "cli-derived.ts");
    this.copy = copy; this.usage = new ConversationUsage(this.conversation, join(root,"u"));
    await this.track(this.usage.set("on")); this.open();
    // This fixed module has NO native/desktop imports. Only its selected async
    // read is gated by the owned child's stdin, never the host's native probes.
    await this.track(writeFile(shim, [
      "const marker=" + JSON.stringify(MARKER) + ", secret=" + JSON.stringify(PRIVATE) + ";",
      "async function gate(stage){if(process.env.FIXTURE_STAGE!==stage)return;console.log(marker);const r=Bun.stdin.stream().getReader();try{const x=await r.read();if(x.done||x.value.length!==1||x.value[0]!==71)throw new Error('Owned gate EOF');const end=await r.read();if(!end.done)throw new Error('Owned gate excess');}finally{r.releaseLock();}if(process.env.FIXTURE_OUTCOME==='error')throw new Error(secret);}",
      "export async function describeDesktopMachine(){await gate('machine');return {report:'owned-fixed-doctor-report',detail:secret};}",
      "export async function desktopHostClassTier(){await gate('tier');return {assigned:'Owned',why:'Fixed metadata only'};}",
    ].join("\n"), { mode:0o600,flag:"wx" })); this.open();
    const productionPath = join(import.meta.dir,"../src/cli.ts"), original = await this.track(readFile(productionPath,"utf8"));
    const imports = /(\bfrom\s+|\bimport\s*\(\s*)(["'])([^"']+)\2/g;
    let bound = 0;
    const isolated = original.replace(imports, (all: string, prefix: string, _quote: string, specifier: string) => {
      if (!specifier.startsWith(".")) return all;
      const target = specifier === "./desktop-machine" ? (bound++,shim)
        : resolve(dirname(productionPath), specifier.endsWith(".json") ? specifier : specifier+".ts");
      return prefix + JSON.stringify(pathToFileURL(target).href);
    });
    expect(bound).toBe(1);
    // Exact branch target only: imported dependencies may load pure definitions,
    // but this report can invoke ONLY the fixed replacement read functions.
    expect(isolated).not.toContain('import("./desktop-machine")');
    expect(isolated).toContain("import(" + JSON.stringify(pathToFileURL(shim).href) + ")");
    const shape = (source: string) => source.replace(imports, (_all: string,prefix: string) => prefix+'"<MODULE>"');
    expect(shape(isolated)).toBe(shape(original)); // Only literal import targets changed, no CLI logic.
    await this.track(writeFile(copy,isolated,{mode:0o600,flag:"wx"})); this.open();
  }
  set(mode: "on"|"off") { this.open(); const usage=this.usage;if(!usage)throw new Error("Usage missing");return this.track(usage.set(mode)); }
  corrupt() { this.open();const root=this.root;if(!root)throw new Error("Root missing");return this.track(writeFile(join(root,"u",createHash("sha256").update(this.conversation).digest("hex")+".json"),PRIVATE+"{",{mode:0o600})); }
  async readCapped(stream: ReadableStream<Uint8Array>, progress?: (text: string) => void) {
    const reader = stream.getReader(), decoder = new TextDecoder(); let text = "", bytes = 0;
    try {
      for (;;) {
        const part = await reader.read(); if (part.done) break;
        bytes += part.value.byteLength;
        if (bytes > MAX_OUTPUT) throw new Error("Owned doctor output exceeds 16 KiB; EOF unknown");
        text += decoder.decode(part.value, { stream: true }); progress?.(text);
      }
      text += decoder.decode(); progress?.(text); return text;
    } catch (error) {
      this.unknown = true;
      // Best effort pipe cancellation is NOT child exit or successful stream EOF.
      try { const cancelled = this.track(reader.cancel()); void cancelled.catch(() => {}); } catch {}
      throw error;
    } finally { reader.releaseLock(); }
  }
  run(stage:"machine"|"tier",outcome:"success"|"error",policy:"on"|"off"|"invalid") {
    this.open();const root=this.root,copy=this.copy;if(!root||!copy)throw new Error("Fixture missing");
    const child=Bun.spawn([process.execPath,copy,"doctor","--report"],{cwd:root,stdin:"pipe",stdout:"pipe",stderr:"pipe",env:{
      PATH:process.env.PATH??"/usr/bin:/bin",HOME:root,LANG:"C.UTF-8",ORBIT_SOCKET:join(root,"no-broker.sock"),
      ORBIT_USAGE_DIR:join(root,"u"),ORBIT_CONVERSATION_ID:this.conversation,ORBIT_DEBUG:"1",XDG_STATE_HOME:join(root,"s"),
      XDG_CONFIG_HOME:join(root,"c"),XDG_DATA_HOME:join(root,"d"),XDG_CACHE_HOME:join(root,"k"),XDG_RUNTIME_DIR:join(root,"r"),
      FIXTURE_STAGE:stage,FIXTURE_OUTCOME:outcome,
    }});this.children.add(child);
    let announce!: (entered:boolean)=>void;const entered=new Promise<boolean>(resolve=>{announce=resolve;});
    let seen = false;
    const output = this.track(this.readCapped(child.stdout, text => {
      if (!seen && text.startsWith(MARKER+"\n")) { seen = true; announce(true); }
    }).then(text => {
      if (!seen) announce(false);
      return { out: seen ? text.slice(MARKER.length+1) : text, hits: text.split(MARKER+"\n").length-1 };
    }, error => { announce(false); throw error; }));
    let ending:Promise<void>|undefined;
    const end=()=>{if(!ending)ending=this.track(Promise.resolve(child.stdin.end()).then(()=>{}));return ending;};this.inputEnds.push(end);
    const input=this.track((async()=>{try{
      if(await entered){if(policy==="off")await this.set("off");else if(policy==="invalid")await this.corrupt();
        if(!this.closing){const accepted=await Promise.resolve(child.stdin.write("G"));if(accepted!==1){this.unknown=true;throw new Error("Owned gate byte acceptance unknown");}}}
    }finally{await end();}})());
    const exited=this.track(child.exited),error=this.track(this.readCapped(child.stderr));
    const completed=this.track(Promise.all([output,error,exited,input]).then(([output,err,code])=>{
      this.children.delete(child);return {...output,err,code};
    },failure=>{this.unknown=true;throw failure;}));
    return bounded(completed);
  }
  async settle(){const end=performance.now()+4000;while(this.pending.size)await bounded(Promise.allSettled([...this.pending]),Math.max(1,end-performance.now()));}
  async close(){this.closing=true;
    try{for(const end of this.inputEnds)await bounded(end());await this.settle();if(this.unknown||this.children.size)throw new Error("Child/EOF unknown");}
    catch{retained.add(this);for(const child of this.children)child.unref();throw new Error("Owned doctor fixture retained; cleanup unknown");}
    if(this.root)await rm(this.root,{recursive:true,force:true});
  }
}
async function fixture(work:(f:DoctorFixture)=>Promise<void>){const f=new DoctorFixture();let primary:unknown,failed=false;
  try{await bounded(f.track(f.setup()));await bounded(f.track(Promise.resolve().then(()=>work(f))),10000);}catch(error){primary=error;failed=true;}
  try{await f.close();}catch(cleanup){if(failed)throw new AggregateError([primary,cleanup],"Doctor fixture and cleanup failed");throw cleanup;}if(failed)throw primary;
}

for(const stage of ["machine","tier"] as const)linux("local doctor "+stage+" result and error stay private after observed off/invalid",()=>fixture(async f=>{
  for(const policy of ["off","invalid"] as const)for(const outcome of ["success","error"] as const){
    await f.set("on");const value=await f.run(stage,outcome,policy);
    expect(value.hits).toBe(1);expect(value.code).toBe(1);expect(value.out).toBe("");
    expect(JSON.parse(value.err)).toMatchObject({ok:false,error:{code:policy==="off"?"ORBIT_DISABLED":"USAGE_STATE_INVALID"}});
    expect(value.err).not.toContain(PRIVATE);
  }
}),20000);

linux("enabled local doctor keeps pretty result and original local error",()=>fixture(async f=>{
  for(const stage of ["machine","tier"] as const){
    await f.set("on");const success=await f.run(stage,"success","on");
    expect(success.hits).toBe(1);expect(success.code).toBe(0);expect(success.err).toBe("");
    expect(JSON.parse(success.out)).toMatchObject({report:"owned-fixed-doctor-report",detail:PRIVATE,tier:{assigned:"Owned",reference:"docs/desktop-only.md"}});
    expect(success.out).toContain('  "report":');
    const failed=await f.run(stage,"error","on");expect(failed.hits).toBe(1);expect(failed.code).toBe(1);expect(failed.out).toBe("");
    expect(JSON.parse(failed.err)).toMatchObject({ok:false,error:{code:"CLI_ERROR"}});expect(failed.err).toContain(PRIVATE);
  }
}),20000);

test("owned capped output reader checks bytes before decoding and latches overflow unknown", async () => {
  const exact = new DoctorFixture();
  const normal = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(MAX_OUTPUT).fill(65)); controller.close(); } });
  expect((await exact.readCapped(normal)).length).toBe(MAX_OUTPUT); expect(exact.unknown).toBe(false);
  let cancelled = 0; const overflow = new DoctorFixture();
  const excessive = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(MAX_OUTPUT+1)); }, cancel() { cancelled++; } });
  await expect(overflow.readCapped(excessive)).rejects.toThrow("16 KiB");
  await Promise.allSettled([...overflow.pending]); expect(overflow.unknown).toBe(true); expect(cancelled).toBe(1);
});
