# Diagnostic reports

Orbit records operation metadata locally and prepares a GitHub issue without an external monitoring service or a new dependency. This is bounded diagnostic history, not a recording of everything the person does.

## Report a problem

In the viewer, choose **Prepare problem report**. A viewer error prepares it automatically. While the viewer is open, it also checks for new agent-tool errors every 15 seconds, with report preparation limited to once per 30 seconds. **Continue to GitHub** opens the project's new-issue page with a title and compact diagnostic summary already filled in. Review it and choose **Submit new issue** on GitHub. A GitHub account is required, and the issue is public. Opening the link shares the summary with GitHub, before submitting the issue. Orbit never opens or submits it automatically.

**Download report** saves the full retained diagnostic history as JSON. No manual log collection is needed. The link includes recent failures and recent events, capped at 7,000 URL characters; the full history stays in the download. There is no automatic attachment upload and no GitHub token stored in Orbit.

Agents can use `orbit_diagnostics` to prepare the same report. `diagnosticId` in a failed tool response matches the event's `traceId`. Tool retries share a hashed request identifier but get distinct trace IDs.

From a terminal:

```sh
sbar-orbit diagnostics > ~/orbit-diagnostics.json
```

This tries the selected broker, then reads managed storage if the broker is unavailable. It works after a broker crash. A fresh installation with no recorded events reports an empty history, not successful operation.

## Collection and privacy

Each dispatched session operation records a start and an outcome, operation name, action type, backend where known, elapsed milliseconds and a generated trace ID. Session and retry identifiers are hashed. Unexpected backend exits are recorded. An operation with a start but no outcome may still be running, or may have been interrupted. An `ok` outcome means the tool returned successfully, not that an application accepted the intended effect.

Arguments, typed or pasted text, URLs, page content, screenshots, cookies, account names, agent/task names, file paths, environment values and raw exception text are excluded. Error codes and operation names use fixed allowlists. Unknown failures become `BACKEND_ERROR`; this protects privacy at the cost of detailed exception causes. The existing session policy journal is separate and is never attached automatically, because it includes browsing origins.

Managed storage is `$XDG_STATE_HOME/sbar-orbit/diagnostics`, defaulting to `~/.local/state/sbar-orbit/diagnostics`. The directory uses mode 700 and files mode 600. Two JSONL files retain at most 1 MiB each. Rotation discards the oldest file. Retention is based on size, not a guaranteed number of days; frequent preview polling shortens it. Idle logs remain until rotated or the directory is removed. Temporary test brokers keep isolated logs inside their disposable workspace.

Writes are serialized and awaited before returning an operation result. There is no per-event `fsync`, so sudden power loss can still lose recent records. Failed writes do not break an otherwise usable tool: the report includes failure counters and up to 1,000 in-memory events. Those fallback events disappear on restart. Corrupt or unsafe files are not trusted as report content. Reports revalidate allowed metadata on read.

## Coverage limits

This covers session dispatch, including browser actions, native actions, observations, lifecycle requests and unexpected backend exits. It does not yet capture pre-dispatch MCP schema rejection, native process stderr, service startup failures before dispatch, host-side tool selection or tools outside Orbit. A broker killed without a pending operation may leave no direct crash event. The offline command recovers retained operations, not a core dump. Disk persistence failure counters describe the current process only.

What a client is told and what an operator can read are deliberately different, and it is worth being exact about both. A `BACKEND_ERROR` reaches its caller as the fixed words `Request failed`, and the journal records the code without the message, because a Playwright error quotes the selector it was given and a navigation error quotes the URL, so exception text is page content by another name and cannot go to an agent. What would otherwise be lost goes to the broker's own stderr instead, beside its trace ID, and only for exceptions that are not Orbit's own: an `OrbitError` already carries its message to the caller, so nothing about it is missing. On a managed install that stderr is the systemd journal, `journalctl --user -u sbar-orbit.service`, and the trace ID in the failed reply is what finds the line. The honest limit is that this is the operator's journal only as long as the broker is the managed service: a private broker started by a test or by an agent writes its stderr wherever its parent points, which is the agent's own output when the agent started it.

Both halves were learned the same day, 13 September 2026, and each cost about a day. A self-closing browser tab was read as a flaky test because `click: Target page, context or browser has been closed` could only be seen by calling `BrowserBackend` in process, outside the wrapper; and every `session.create` on a fresh machine failed with the cause discarded, until `ENOENT: no such file or directory, posix_spawn '/usr/bin/btrfs'` was put back on stderr. Reproducing in process is still the route when the thing that threw was an `OrbitError`, since nothing is written for those.

No claim is made that every application failure can be diagnosed from metadata alone. Add targeted safe error categories when investigation requires more detail, rather than enabling raw argument or screenshot logging.

## Research and choice

[OpenTelemetry's log model](https://opentelemetry.io/docs/specs/otel/logs/) connects logs and traces using identifiers. Orbit follows this correlation principle without claiming OTLP compatibility or installing an exporter. [Sentry user feedback](https://docs.sentry.io/product/issues/issue-details/) links reports to errors; the project uses GitHub instead, as requested.

[GitHub documents issue query parameters](https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/creating-an-issue) for prefilled titles and bodies. This provides a reviewable submission flow with the existing project repository and no separate paid service. GitHub's normal account and repository availability rules still apply.

## Verification

`tests/diagnostics.test.ts` checks failed-call correlation, secret exclusion, restart recovery, rotation, private permissions, unsafe-file refusal, in-flight starts, retry linkage, URL bounds and authenticated viewer access. The initial correlation test failed against the unmodified dispatcher before implementation.

Measured on 13 September 2026: the focused diagnostics, private viewer and MCP run passed 7 tests with 61 assertions, and TypeScript passed. Desktop and mobile report preparation, download and link generation produced no page errors or external requests. Actual GitHub submission was not performed. A full-suite attempt had 178 passes, 12 skips and 16 failures, including Chrome timeouts and resource-budget rejection; it is not a suite-wide pass. Native crash detection is implemented but was not separately exercised against a real private-display crash in this task.
