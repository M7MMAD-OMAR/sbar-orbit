/** Drain a complete RPC reply to stdout before the one-shot CLI exits. */
export function writeCliOutput(value: unknown): Promise<void> {
  const output = `${JSON.stringify(value)}\n`;
  return new Promise((resolve, reject) => {
    process.stdout.write(output, error => error ? reject(error) : resolve());
  });
}
