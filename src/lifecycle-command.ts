export type CommandResult = { ok: boolean; output: string; stopUnconfirmed?: boolean };
export type CommandRunner = (argv: string[], timeoutMs?: number) => Promise<CommandResult>;

/** Bounds both process completion and inherited output pipes. */
export const boundedCommand: CommandRunner = async (argv, timeoutMs = 40_000) => {
  try {
    const child = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" });
    let timedOut = false;
    const readers = [child.stdout.getReader(), child.stderr.getReader()];
    const drain = async (reader: ReadableStreamDefaultReader<Uint8Array>) => {
      let output = "";
      const decoder = new TextDecoder();
      while (true) {
        const next = await reader.read().catch(() => ({ done: true as const, value: undefined }));
        if (next.done) return output + decoder.decode();
        output = (output + decoder.decode(next.value, { stream: true })).slice(-524_288);
      }
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const completion = Promise.all([...readers.map(drain), child.exited]).then(([out, err, code]) =>
        timedOut ? { ok: false, output: "Lifecycle command timed out" }
          : { ok: code === 0, output: `${out}${err}`.trim() });
      const deadline = new Promise<CommandResult>(resolve => {
        timer = setTimeout(async () => {
          timedOut = true;
          try { child.kill("SIGKILL"); } catch {}
          for (const reader of readers) void reader.cancel().catch(() => {});
          let confirmationTimer: ReturnType<typeof setTimeout> | undefined;
          try {
            const confirmed = await Promise.race([
              child.exited.then(() => true, () => false),
              new Promise<boolean>(done => { confirmationTimer = setTimeout(() => done(false), 1_000); }),
            ]);
            resolve(confirmed ? { ok: false, output: "Lifecycle command timed out" }
              : { ok: false, output: "Lifecycle command timed out; command exit is not confirmed", stopUnconfirmed: true });
          } finally { if (confirmationTimer) clearTimeout(confirmationTimer); }
        }, timeoutMs);
      });
      return await Promise.race([completion, deadline]);
    } finally { if (timer) clearTimeout(timer); }
  } catch (error) {
    return { ok: false, output: error instanceof Error ? error.message : "Lifecycle command could not start" };
  }
};
