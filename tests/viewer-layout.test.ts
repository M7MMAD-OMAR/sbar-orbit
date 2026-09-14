import { test, expect } from 'bun:test';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { startBroker, call } from '../src/ipc';
import { Sessions } from '../src/session';
import { BrowserBackend } from '../src/browser';
import { createWorkspaceDirectory } from '../src/workspace-storage';

const fixture = `<!doctype html><html><head><title>Workspace library</title><style>*{box-sizing:border-box}body{margin:0;background:#f5f6f8;color:#20282f;font:16px system-ui}header{padding:26px 40px;background:white;display:flex;justify-content:space-between}main{padding:45px 60px}small{color:#71818e}h1{font-size:34px;letter-spacing:-1px;margin:8px 0}p{color:#687684}.cards{display:flex;gap:18px;margin:32px 0}.card{background:white;border-radius:16px;padding:24px;flex:1}strong{font-size:32px;display:block;margin-top:16px}table{width:100%;background:white;border-radius:16px;padding:20px;text-align:left}th,td{padding:18px;font-size:14px}th{color:#79838f;font-weight:500}.tag{background:#e7f4ec;border-radius:20px;padding:6px 12px;color:#377354}</style></head><body><header><b>Studio / Workspace</b><small>Product team</small></header><main><small>PROJECT OVERVIEW</small><h1>Workspace library</h1><p>A clear view of the work in progress.</p><div class="cards"><div class="card"><small>Active projects</small><strong>12</strong></div><div class="card"><small>In review</small><strong>4</strong></div><div class="card"><small>Completed this week</small><strong>8</strong></div></div><table><tr><th>Project</th><th>Owner</th><th>Status</th></tr><tr><td>Workspace navigation</td><td>Design team</td><td><span class="tag">In review</span></td></tr><tr><td>Account settings</td><td>Product team</td><td>In progress</td></tr><tr><td>Diagnostic reports</td><td>Engineering</td><td>Ready</td></tr></table></main></body></html>`;

/*
 * Selectors here are ids, classes and data attributes only. The viewer's words move between Arabic
 * and English at the reader's choice, and a test that clicks a button by the sentence printed on it
 * breaks on the next copy change while the interface it is guarding is perfectly fine.
 */
test('the rail is the only session list, newest first, and mirrors for Arabic', async () => {
  const broker = await startBroker();
  const root = await createWorkspaceDirectory('viewer-layout-qa');
  const viewing = new Sessions(root);
  const server = Bun.serve({hostname:'127.0.0.1',port:0,fetch:() => new Response(fixture,{headers:{'Content-Type':'text/html'}})});
  const shots = process.env.ORBIT_QA_OUTPUT ?? '/tmp/orbit-viewer-layout';
  try {
    const a = await call(broker.socket,'session.create',{backend:'browser',agentName:'Codex',taskName:'Review navigation',conversationName:'Polish the workspace',projectName:'Sbar Orbit'}) as {sessionId:string};
    const b = await call(broker.socket,'session.create',{backend:'browser',agentName:'Hermes',taskName:'Review account settings',conversationName:'Account settings',projectName:'Studio'}) as {sessionId:string};
    expect(a).toMatchObject({conversationName:'Polish the workspace',projectName:'Sbar Orbit'});
    // Every session is stamped when it opens and again whenever something happens in it. The rail
    // reads these; nothing else in the product does.
    expect(typeof (a as unknown as {createdAt:number}).createdAt).toBe('number');
    await call(broker.socket,'session.act',{...a,requestId:'navigate',action:{type:'navigate',url:`http://127.0.0.1:${server.port}`}});
    await call(broker.socket,'session.act',{...a,requestId:'tab',action:{type:'open-tab',url:`http://127.0.0.1:${server.port}/settings`}});
    const preview = await call(broker.socket,'preview.open') as {url:string};
    const own = await viewing.dispatch({method:'session.create',params:{backend:'browser',agentName:'Codex',taskName:'Viewer design QA'}}) as {sessionId:string};
    const backend = (viewing as unknown as {sessions:Map<string,{backend:BrowserBackend}>}).sessions.get(own.sessionId)?.backend;
    const page = backend?.context.pages()[0];
    if (!page) throw new Error('Private Orbit page missing');
    const errors:string[]=[]; page.on('pageerror',e=>errors.push(e.message));
    /* The rail opens and closes over about a third of a second now, and the picture is sized from
       what is left, so anything measuring the picture waits for the movement to finish first. */
    const settled = () => page.evaluate(() => new Promise<void>(done => setTimeout(() => requestAnimationFrame(() => done()), 500)));
    await page.setViewportSize({width:1440,height:1000});
    // The viewer follows the languages the browser asks for. This one asks for Arabic; the English
    // default is checked at the end of the test, from the same page with nothing remembered.
    await page.addInitScript(()=>Object.defineProperty(navigator,'languages',{get:()=>['ar-SY','ar'],configurable:true}));
    await page.goto(preview.url,{waitUntil:'domcontentloaded'});
    await page.locator('#frame').waitFor({state:'visible'});

    // Arabic, right to left, for a reader whose browser asks for it, and the picture never mirrors.
    expect(await page.evaluate(()=>document.documentElement.dir)).toBe('rtl');
    expect(await page.evaluate(()=>document.documentElement.lang)).toBe('ar');
    expect(await page.locator('#stage').evaluate(node=>getComputedStyle(node).direction)).toBe('ltr');
    expect(await page.locator('.rail-note').textContent()).toContain('شاشتك');

    // One list. The conversation strip that repeated it is gone.
    expect(await page.locator('#conversation-tabs').count()).toBe(0);
    expect(await page.locator('.session').count()).toBe(2);
    // Newest activity first: session a was acted on after b was created.
    const order = await page.locator('.session .session-agent').allTextContents();
    expect(order[0]).toBe('Polish the workspace');
    expect(await page.locator('.session-when').first().textContent()).toContain('اليوم');
    // The frame is the window, margin included: a shell one margin too tall scrolls the whole page.
    expect(await page.evaluate(()=>document.documentElement.scrollHeight<=innerHeight)).toBe(true);
    // Foreign names keep their own reading direction inside the mirrored layout, and stay where the
    // layout puts them rather than drifting to the far end of the line.
    const title = await page.locator('#task-name').boundingBox();
    const identity = await page.locator('.head-identity').boundingBox();
    expect((identity?.x ?? 0) + (identity?.width ?? 0) - ((title?.x ?? 0) + (title?.width ?? 0))).toBeLessThan(2);
    expect(await page.title()).toBe('Polish the workspace · Sbar Orbit | Orbit');
    // The same moment, for the session on the stage rather than in the list.
    expect(await page.locator('#last-activity').textContent()).toContain('اليوم');
    // The state a card is in is said in a shape as well as in a word, and the rail can be narrowed
    // to one state at a time.
    expect(await page.locator('.session .session-state').first().textContent()).toBe('مفتوحة');
    expect(await page.locator('.filter').count()).toBe(4);
    // Nothing has finished yet, so that answer is offered as empty rather than as a dead end.
    expect(await page.locator('.filter[data-filter="finished"]').isDisabled()).toBe(true);
    /*
     * The rail survives an idle poll. It is rebuilt from a signature of what its cards say, so a
     * signature carrying a raw timestamp instead of the printed minute would rebuild every card on
     * every tick and take hover, focus and a half finished removal off the card under the pointer.
     */
    await page.evaluate(()=>document.querySelector('.session')?.setAttribute('data-probe','1'));
    await page.evaluate(()=>new Promise<void>(done=>setTimeout(done,2600)));
    expect(await page.locator('.session').first().getAttribute('data-probe')).toBe('1');

    const normal = await page.locator('#frame').boundingBox();
    if (!normal) throw new Error('Frame missing');
    expect(normal.height).toBeGreaterThan(600);
    await page.locator('#sidebar-toggle').click();
    await page.locator('#sidebar').waitFor({state:'hidden'});
    expect(await page.locator('#sidebar').isVisible()).toBe(false);
    await page.reload({waitUntil:'domcontentloaded'});
    expect(await page.locator('#sidebar').isVisible()).toBe(false);
    await page.locator('#sidebar-toggle').click();
    await page.locator('#sidebar').waitFor({state:'visible'});
    await page.locator('#frame').waitFor({state:'visible'});
    await settled();
    await page.locator('#expand').click();
    await page.locator('#sidebar').waitFor({state:'hidden'});
    await settled();
    const focused = await page.locator('#frame').boundingBox();
    expect(focused?.width ?? 0).toBeGreaterThan(normal.width);
    const surface = await page.locator('.surface').boundingBox();
    expect(Math.abs((surface?.width ?? 0)-(focused?.width ?? 1))).toBeLessThan(1);
    await mkdir(shots,{recursive:true});
    await page.screenshot({path:join(shots,'focus.png'),fullPage:true});
    await page.keyboard.press('Escape');
    expect(await page.locator('#expand').getAttribute('aria-pressed')).toBe('false');
    await page.locator('#sidebar').waitFor({state:'visible'});
    await page.locator('#viewer-fullscreen').click();
    await page.waitForFunction(()=>!!document.fullscreenElement);
    await page.locator('#viewer-fullscreen').click();
    await page.waitForFunction(()=>!document.fullscreenElement);
    await page.keyboard.press('Escape');

    // Picking a session from the rail, and the page tabs of the one that is on the stage.
    await page.locator('.session .session-open').nth(1).click();
    await page.waitForFunction(()=>document.title.startsWith('Account settings'));
    expect(await page.locator('#project-name').textContent()).toBe('Studio');
    await page.locator('.session .session-open').nth(0).click();
    await page.waitForFunction(()=>document.title.startsWith('Polish the workspace'));
    await page.locator('#tabs button').nth(1).waitFor({state:'visible'});
    expect(await page.locator('#tabs button').nth(0).isDisabled()).toBe(true);
    // Typing for the assistant is offered only while a person holds the controls.
    expect(await page.locator('#manual').isVisible()).toBe(false);
    await page.locator('#pause').click();
    await page.locator('#manual').waitFor({state:'visible'});
    await page.locator('#tabs button').nth(0).click();
    await page.waitForFunction(()=>document.querySelector('#tabs button')?.getAttribute('aria-selected')==='true');
    const presence = await call(broker.socket,'session.presence',a) as {pageIndex:number};
    expect(presence.pageIndex).toBe(1);
    await page.locator('#resume').click();
    await page.locator('#manual').waitFor({state:'hidden'});
    expect(await page.locator('#frame').evaluate(element => element.getBoundingClientRect().bottom <= innerHeight)).toBe(true);
    await page.screenshot({path:join(shots,'desktop.png'),fullPage:true});

    // English on request, and a chosen language outranks the browser's own.
    await page.locator('#language').click();
    await page.waitForFunction(()=>document.documentElement.dir==='ltr');
    expect(await page.locator('.rail-note').textContent()).toContain('assistants');
    await page.reload({waitUntil:'domcontentloaded'});
    expect(await page.evaluate(()=>document.documentElement.dir)).toBe('ltr');
    await page.locator('#language').click();
    await page.waitForFunction(()=>document.documentElement.dir==='rtl');

    // A finished session can be removed from the list, and asks once first.
    await call(broker.socket,'session.stop',b);
    await page.waitForFunction(()=>document.querySelectorAll('.session[data-state="closed"]').length===1);
    // Narrowing the rail to one state, now that there is one of each.
    await page.locator('.filter[data-filter="finished"]').click();
    await page.waitForFunction(() => document.querySelectorAll('.session').length === 1);
    expect(await page.locator('.session-state').first().textContent()).toBe('انتهت');
    // The open one is still open, and nothing is acting, so that answer is empty and says so.
    expect(await page.locator('.filter[data-filter="open"]').textContent()).toBe('مفتوحة 1');
    expect(await page.locator('.filter[data-filter="working"]').isDisabled()).toBe(true);
    await page.locator('.filter[data-filter="all"]').click();
    await page.waitForFunction(() => document.querySelectorAll('.session').length === 2);

    const closed = page.locator('.session[data-state="closed"]');
    await closed.hover();
    await closed.locator('.session-forget').click();
    expect(await closed.getAttribute('data-confirm')).toBe('true');
    await closed.locator('.session-forget').click();
    await page.waitForFunction(()=>document.querySelectorAll('.session').length===1);
    const remaining = await call(broker.socket,'session.list') as {sessionId:string}[];
    expect(remaining.map(s=>s.sessionId)).toEqual([a.sessionId]);
    // An id the broker has already forgotten is not an error on screen.
    expect(await call(broker.socket,'session.forget',b)).toMatchObject({forgotten:false});

    // A browser that asks for nothing Arabic, and nothing remembered: English, left to right.
    await page.addInitScript(()=>Object.defineProperty(navigator,'languages',{get:()=>['en-US','en'],configurable:true}));
    await page.evaluate(()=>localStorage.removeItem('orbit-language'));
    await page.reload({waitUntil:'domcontentloaded'});
    expect(await page.evaluate(()=>document.documentElement.dir)).toBe('ltr');
    expect(await page.evaluate(()=>document.documentElement.lang)).toBe('en');
    await page.locator('#frame').waitFor({state:'visible'});

    await page.setViewportSize({width:390,height:844});
    await page.locator('#sidebar').waitFor({state:'hidden'});
    expect(await page.locator('#sidebar').isVisible()).toBe(false);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await page.screenshot({path:join(shots,'mobile.png'),fullPage:true});
    await page.locator('#sidebar-toggle').click();
    await page.locator('#sidebar').waitFor({state:'visible'});
    await page.keyboard.press('Escape');
    await page.locator('#sidebar').waitFor({state:'hidden'});
    expect(errors).toEqual([]);
  } finally {await viewing.close();await broker.close();server.stop(true);await rm(root,{recursive:true,force:true});}
},60000);
