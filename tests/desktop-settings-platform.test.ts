import { expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

for (const platform of ['darwin', 'win32']) {
  test(`desktop mark settings refuse ${platform} before any interpreter spawn`, async () => {
    const source = process.env.ORBIT_SETTINGS_SOURCE ?? resolve(import.meta.dir, '../src/desktop-settings.ts');
    // A fresh process carries the simulated OS. The trap prevents the old source from
    // invoking an interpreter, including macOS's installer stub. This is a boundary
    // simulation, not a measurement of an actual macOS or Windows settings interface.
    const probe = `
      const { settingsRequest } = await import(${JSON.stringify(pathToFileURL(source).href)});
      Object.defineProperty(process, 'platform', { value: ${JSON.stringify(platform)} });
      let spawns = 0;
      Bun.spawn = () => { spawns++; throw new Error('INTERPRETER_SPAWN_ATTEMPTED'); };
      const errors = [];
      for (const request of [
        {method:'settings.list'},
        {method:'settings.write',params:{key:'blink',value:false}},
        {method:'settings.write',params:{key:'blink',reset:true}},
        {method:'settings.write',params:{all:true}}
      ]) { try { await settingsRequest(request); errors.push('accepted'); }
          catch (error) { errors.push(error.code || error.message); } }
      console.log(JSON.stringify({spawns,errors}));
    `;
    const child = Bun.spawn([process.execPath, '--eval', probe], { stdout: 'pipe', stderr: 'pipe' });
    const [output, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect({ code, error }).toEqual({ code: 0, error: '' });
    expect(JSON.parse(output)).toEqual({ spawns: 0, errors: Array(4).fill('UNSUPPORTED') });
  });
}
