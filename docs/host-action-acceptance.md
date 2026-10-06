# Actual agent host action acceptance

U7/T7 in [acceptance.md](acceptance.md) requires the same navigation, input,
observation and stop contract through CLI, MCP and API, plus two actual host
integrations. Registration, MCP negotiation by a generic SDK, importing a host's
renderer and finding an executable do not meet that requirement.

This experiment invokes the installed `codex` app-server and the installed
`claude --bare --print` launcher. Their own MCP machinery launches Orbit's
`src/mcp.ts` adapter. A loopback deterministic endpoint emits only `orbit_create`,
`orbit_act`, `orbit_observe` and `orbit_stop`. It is not a model reasoning test.
The Codex mock uses Responses events. The Claude mock uses Anthropic Messages
streaming events, following the [streaming contract](https://platform.claude.com/docs/en/build-with-claude/streaming)
and the [custom endpoint configuration](https://code.claude.com/docs/en/llm-gateway).

The probe also runs the same fresh-browser action sequence through broker HTTP
RPC and the actual Orbit CLI executable source. All four use the default fresh
profile policy. Custom policy configuration parity is not measured: the current
CLI create syntax cannot express every MCP/API create option.

## Isolation and evidence

Each invocation creates a disposable HOME, Codex/Claude/Hermes config roots,
XDG roots, Orbit account root, conversation usage root, broker socket and browser
profile. No personal config or credential is copied or read by the probe. The
host environment is an allowlist, with a dummy local key and a loopback model
URL. Non-loopback proxy traffic is pointed at an unavailable loopback listener.
This proxy setting is not an OS network sandbox. There is no real provider
credential, forwarded model request, browser profile clone, native compositor,
viewer opening or shared broker interaction. Claude minimal mode skips keychain
reads and automatic context discovery. The disposable Codex authority uses a
sandbox that permits MCP actions, because read-only mode with approval policy
`never` refuses the mutating create tool before it reaches Orbit.

The installed launcher path, resolved binary digest, version and invocation are
retained. A separate Unix HTTP relay records actual broker calls and replies.
The model learns the session ID from the actual host-returned create result.
Later steps require the preceding host-returned result to match the relay's
independent witness. The relay never repairs missing host content.

Each path must create a browser, navigate, fill a field, click a submit button,
read the submitted marker, capture a JPEG and stop. The loopback page records
exactly one submitted marker. The actual host client must receive the text, image and metadata. For Codex,
the image comes only from its native app-server MCP completion event, correlated
by call ID, server, tool and exact session arguments. The mock-provider request
carried metadata without image bytes in the observed third attempt; model image
forwarding remains not measured in this setup. Claude's tool result image is
checked in the actual next model request. In both paths,
image bytes must match the broker witness, and JPEG header dimensions must be
1280 by 800. A viewable JPEG is retained beside the JSON report. No automated
pixel-content comparison is claimed.

Host checks require seven successful tool events in order and a successful final
turn. Before stop, the probe records owned descendant PID and start-time pairs.
It checks those identities for exit, requires the session registry to report
closed and rejects a post-stop presence request. Finally it closes owned groups,
removes the disposable root and checks recorded survivors. These witnesses are
limited to the descendants captured before stop. They are not a general crash
cleanup or host interference measurement.

The comparison script rejects different source digests, missing paths, duplicate
host binary identities and differing normalized action requests or contract
results. Dynamic session IDs and loopback ports are normalized. Repository source
and experiment digests are retained; checks also have checkpoint source hashes.

## Recorded attempts

On 6 October 2026, the actual installed launchers reported Codex
`0.150.0-alpha.8` and Claude Code `2.1.290` under disposable configuration.
Hermes exited before help and version with `no dependency environment is committed
for this install`. Its actual action integration remains **not measured**.
No global repair, alternate interpreter or direct library import was used to turn
that failure into a host pass.

The first Codex attempt failed in 28.38 seconds. Its read-only host sandbox and
approval policy `never` refused `orbit_create`; no broker action occurred. The
second attempt failed in 7.77 seconds after one real successful create. The
result validator did not recognize Codex's timing and `Output` prefix on the
actual tool text. Its private root was removed, and no recorded cleanup survivor
remained. Both failed source-bound reports are retained separately. Neither is a
successful integration.

The third Codex attempt failed in 6.32 seconds under the original stricter
model-image gate. Six real actions reached Orbit, including the correct submitted
marker and a native host MCP event carrying a 11214-byte JPEG. That local model
request carried metadata without the image. This remains a failed model-image
measurement. The revised limited host-client contract accepts only that authentic
app-server image event; it does not claim model visual use.

The first actual Claude Code CLI attempt passed seven actions in 9.02 seconds,
including model-visible tool text and the exact JPEG. Its final result was
successful. All 14 captured process identities exited, and its disposable root
was removed. It precedes the final harness revision and is retained separately.

The first matched final bundle passed Codex in 11.81 seconds, Claude in
10.06 seconds and API in 8.97 seconds. The CLI attempt failed in 12.02 seconds:
its observe subprocess exited with code 0, but returned an unterminated JSON image
string. A separately instrumented CLI reproduction failed in 12.90 seconds and
retained exactly 8192 stdout bytes, ending inside the base64 image, with empty
stderr. The broker returned a 11214-byte JPEG, requiring 14952 base64 characters
before the remaining JSON metadata. Stop was not reached by that failed CLI path;
the fixture cleaned it up. This failure remains preserved.

A focused test with the same Python stdlib pipe fixture then failed against the
unchanged CLI: 8192 bytes received instead of 96141. Its UTF-8 list companion
passed. A Bun-spawn pipe fixture had passed the old source and is explicitly
non-discriminating. The corrected common broker RPC output awaits the stdout
write callback before exit, retaining the same JSON and newline. Both final pipe
tests passed. An initial `Bun.write` candidate timed out in the fixture and is not
the implementation delivered. The correction does not change native preparation,
native callbacks or unrelated report output paths.

The first validation bundle after that correction passed the 11 harness controls
and Codex in 19.85 seconds. Its Claude command was interrupted by an artificial
25-second bundle cap after 25.33 seconds. That result is invalid, with no assertion
failure established. The original 90-second command deadline remains in force.
The interrupted run did not retain pre-stop process witnesses or an exact budget
scope identity. A later read-only scan found no process command line or environment
referencing its exact private root, and no loaded Orbit command scope remained.
Those later checks do not fill the missing interruption-time witnesses.

The final source-matched measurements after the stdout correction passed:

| Path or check | Result | Bounded command duration |
| --- | --- | --- |
| Actual Codex app-server | Seven actions, successful turn, native client JPEG event | 19.85 seconds |
| Actual Claude Code CLI | Seven actions, successful turn, model-request JPEG | 11.35 seconds |
| Orbit API | Seven actions and JPEG | 23.30 seconds |
| Orbit CLI | Seven actions and complete JSON/JPEG | 13.20 seconds |
| Four-path contract comparison | Default policy, actions, dimensions and stop state agree | 0.12 seconds |
| Harness controls | 11 passed | 0.27 seconds |
| CLI pipe regressions | Two passed, 16 assertions, no skips | 2.60 seconds |

These are command durations, including fixture startup and cleanup, rather than
action latency benchmarks. All four reports have source digest
`df60c20d09b0155e05bb273556b25df8a03c7e56c60c29dc94156db92c799bb7`.
The checkpoint source hash is
`27c6eb36660eee22b31b281edcff5b28879f2268bc306c525eba58e290b9d927`.
Both digests bind the measured working-tree files, including the uncommitted
stdout correction, rather than claiming the base Git commit already contained it.

Each final path submitted and read the exact marker, delivered a 11214-byte JPEG,
reported the session closed, rejected stale presence with `SESSION_CLOSED`, and
removed its private root. All 14 captured process identities per path exited;
the recorded post-stop and final survivor lists are empty. The final actual CLI
observation reply contains 15282 bytes, with all 14952 base64 image characters and
its final newline, compared with the retained old-source 8192-byte truncation.
Codex's mock-provider request still contains no image nodes. Its successful
measurement remains limited to the authentic host-client image event.

Independent artifact review passed for this source and these retained reports.
The experiment supports only the limited
fresh-browser host-client contract. Full U7/T7 acceptance, including model visual
use and broader host behavior, is not closed. Native handoff remains under the
unconditional release hold documented in [native-handoff-incident.md](native-handoff-incident.md).

## Reproduce

Install locked dependencies with Bun, then run one bounded command at a time.
On the coordinated development host, obtain the current exclusive test lease
before each runtime command. The output directory must already exist.

```sh
bun install --frozen-lockfile --ignore-scripts
bun run typecheck
bun run scripts/limited.ts python3 experiments/host-action-acceptance.py codex --output /var/tmp/orbit-codex-actions.json
bun run scripts/limited.ts python3 experiments/host-action-acceptance.py claude --output /var/tmp/orbit-claude-actions.json
bun run scripts/limited.ts python3 experiments/host-action-acceptance.py api --output /var/tmp/orbit-api-actions.json
bun run scripts/limited.ts python3 experiments/host-action-acceptance.py cli --output /var/tmp/orbit-cli-actions.json
python3 experiments/host-action-acceptance-compare.py /var/tmp/orbit-codex-actions.json /var/tmp/orbit-claude-actions.json /var/tmp/orbit-api-actions.json /var/tmp/orbit-cli-actions.json --output /var/tmp/orbit-action-parity.json
python3 experiments/host-action-acceptance.test.py -v
```

A failed or absent launcher result is retained as failed or not measured. The
experiment exits unsuccessfully when a required path is absent or fails. Fresh
local fixtures can support only **Limited**, with the disposable Fedora browser
and deterministic model limit beside it, following [support-tiers.md](support-tiers.md).
Real-provider reasoning, paid-host behavior, account continuity, arbitrary
workloads, native actions and other operating systems remain not measured.
