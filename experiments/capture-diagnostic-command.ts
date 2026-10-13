export type DiagnosticCommandResult = {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  directExitConfirmed: boolean;
  outputComplete: boolean;
  collectionErrors: string[];
  signalErrors: string[];
};

async function within<T>(promise: Promise<T>, milliseconds: number): Promise<{ value: T } | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise.then(value => ({ value })),
      new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), milliseconds); })]);
  } finally { clearTimeout(timer); }
}

/** Bounds the exact launched child and its pipes. Descendant absence is not measured. */
export async function diagnosticCommand(argv: string[], options: {
  timeoutMs: number;
  maxOutputBytes?: number;
  graceMs?: number;
  env?: Record<string, string | undefined>;
}): Promise<DiagnosticCommandResult> {
  const maxBytes = options.maxOutputBytes ?? 64 * 1024 * 1024;
  const graceMs = options.graceMs ?? 5000;
  for (const value of [options.timeoutMs, maxBytes, graceMs])
    if (!Number.isSafeInteger(value) || value < 1) throw new Error("Invalid diagnostic command bound");
  const child = Bun.spawn(argv, { stdin: "ignore", stdout: "pipe", stderr: "pipe", env: options.env });
  const result: DiagnosticCommandResult = { stdout: "", stderr: "", exitCode: null, timedOut: false,
    directExitConfirmed: false, outputComplete: false, collectionErrors: [], signalErrors: [] };
  let abort: (() => void) | undefined;
  const aborted = new Promise<"failed">(resolve => { abort = () => resolve("failed"); });
  const interrupted = (signal: string) => {
    result.collectionErrors.push(`interrupted by ${signal}`);
    abort?.();
  };
  const term = () => interrupted("SIGTERM"), int = () => interrupted("SIGINT");
  process.on("SIGTERM", term); process.on("SIGINT", int);
  const readers = [child.stdout.getReader(), child.stderr.getReader()];
  const states = readers.map(() => ({ chunks: [] as Uint8Array[], bytes: 0, complete: false, cancelled: false }));
  const collectors = readers.map(async (reader, index) => {
    const state = states[index];
    if (!state) throw new Error("Missing diagnostic output state");
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) { state.complete = !state.cancelled; break; }
        const available = maxBytes - state.bytes;
        const admitted = next.value.subarray(0, available);
        state.chunks.push(admitted); state.bytes += admitted.byteLength;
        if (next.value.byteLength > available) {
          result.collectionErrors.push(index === 0 ? "stdout bound exceeded" : "stderr bound exceeded");
          abort?.(); break;
        }
      }
    } catch {
      result.collectionErrors.push(index === 0 ? "stdout read failed" : "stderr read failed");
      abort?.();
    }
  });
  const exit = child.exited.then(code => {
    result.exitCode = code; result.directExitConfirmed = true;
  }, () => { result.collectionErrors.push("direct child exit observation failed"); abort?.(); });
  try {
    const complete = Promise.all([...collectors, exit]).then(() => "complete" as const);
    const observed = await within(Promise.race([complete, aborted]), options.timeoutMs);
    result.timedOut = observed === undefined;
    if (observed?.value !== "complete" || !result.directExitConfirmed) {
      if (!result.directExitConfirmed) {
        try { child.kill("SIGTERM"); } catch { result.signalErrors.push("SIGTERM failed"); }
        await within(exit, graceMs);
      }
      if (!result.directExitConfirmed) {
        try { child.kill("SIGKILL"); } catch { result.signalErrors.push("SIGKILL failed"); }
        await within(exit, graceMs);
      }
    }
  } finally {
    const cancellations = readers.map((reader, index) => {
      const state = states[index];
      if (state?.complete) return Promise.resolve();
      if (state) state.cancelled = true;
      return reader.cancel().then(() => {}, () => {
        result.collectionErrors.push(index === 0 ? "stdout cancellation failed" : "stderr cancellation failed");
      });
    });
    const drained = await within(Promise.all([...collectors, ...cancellations]), graceMs);
    if (!drained) result.collectionErrors.push("output drain unconfirmed");
    for (const reader of readers) {
      try { reader.releaseLock(); } catch { result.collectionErrors.push("output reader release failed"); }
    }
    result.stdout = Buffer.concat(states[0]?.chunks ?? []).toString("utf8");
    result.stderr = Buffer.concat(states[1]?.chunks ?? []).toString("utf8");
    result.outputComplete = states.every(state => state.complete) && result.collectionErrors.length === 0;
    process.off("SIGTERM", term); process.off("SIGINT", int);
  }
  return result;
}

export class DiagnosticCommandFailure extends Error {
  constructor(readonly result: DiagnosticCommandResult) {
    super("Diagnostic command failed; exact child exit and output observations are retained");
  }
}
