/** CLI guard fixture: a regression must fail, never start a real helper. */
export {};
const denied = (): never => { throw new Error("Unexpected reader helper spawn"); };
Bun.spawn = denied;
Bun.spawnSync = denied;
