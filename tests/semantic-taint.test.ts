import { expect, test } from "bun:test";
import { Sessions } from "../src/session";

test("reading application controls records untrusted content before subsequent actions", async () => {
  const session = {
    restoreStore: "", tainted: false,
    backend: { act: async () => ({ nodes: [{ name: "Application supplied instructions" }] }) },
  };
  const broker = new Sessions("/unused-semantic-content-test") as unknown as {
    guarded(value: typeof session, action: { type: string }): Promise<unknown>;
  };
  expect(await broker.guarded(session, { type: "inspect" })).toEqual({
    nodes: [{ name: "Application supplied instructions" }],
  });
  expect(session.tainted).toBe(true);
});
