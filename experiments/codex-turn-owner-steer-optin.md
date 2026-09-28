# Candidate owner routing for active turn input

The [source patch](codex-turn-owner-steer-optin.patch) targets the exact Codex tag `rust-v0.155.0-alpha.9.2`, commit `4607249e430dac1c961df4dc615beae88e33cec8`. It is separate from the dynamic tool callback owner patch. Apply the zero-context patch with `git apply --unidiff-zero`. It was prepared in `/var/tmp/orbit-codex-steer-owner-optin` and has not been applied to an installed executable or any personal profile.

The [red fixture](codex-two-client-active-steer-red.py) measured that a second app-server connection could submit `turn/start` into an active turn started by the first connection. The second RPC returned the same turn ID. The [green fixture](codex-two-client-active-steer-green.py) enables `CODEX_APP_SERVER_TURN_OWNER_EXPERIMENT=1` in a disposable app-server. It asks both clients to use `turn/start` and `turn/steer` while the mock model holds the first client's turn open. Its assertions require rejection for the second client and acceptance for the first.

When enabled, the patch records the connection and turn ID after a `turn/start` starts a turn. A later `turn/start` from that connection uses Core's `steer_turn` with the expected turn ID. An input from any other connection uses `start_turn_if_idle`, so it can start a new turn after the prior one ends but cannot steer an active turn. A stale owner mapping may try `steer_turn`; on `NoActiveTurn` or `ExpectedTurnMismatch`, the code retries only with `start_turn_if_idle`. The explicit `turn/steer` RPC also requires the recorded connection and turn ID before it calls Core. Without the environment variable, the existing `start_or_steer_turn` route remains selected.

The rejection decision in these two RPC paths is based on Core operations, not only on an app-server status snapshot. Core's `start_if_idle` reserves `active_turn` under its mutex and returns `NotIdle` when one exists. Core's `steer_input` holds that mutex while checking the expected turn ID and adding input to the queue. This avoids a check-then-submit gap for `turn/start` and `turn/steer` as patched. The app-server owner map is still registered after Core returns a started turn; until that registration, another client uses the idle-only operation and fails closed while the turn is active.

## Validation and limits

- `git apply --check --cached --unidiff-zero` passed against the clean exact-tag source index.
- `git diff --check` passed in the isolated source worktree. The green Python fixture parsed successfully.
- A bounded Rust build compiled the patched app-server source. Its first final link failed because the extracted mold linker could not locate `libmimalloc.so.2`. A bounded incremental link with `LD_LIBRARY_PATH` set to the extracted library directory completed in 5.77 seconds. The resulting `codex-app-server` reported version `0.155.0-alpha.9.2` and had SHA-256 `dc7d3de21376152d68f9b0c7432d57435d406c646389b2d6286391adfdb120dc`.
- The green two-client fixture ran against that freshly built app-server executable in a disposable home with a local mock model. Both non-owner `turn/start` and non-owner `turn/steer` were rejected. The owner used both methods on the original turn ID. The mock model had received exactly two requests before release, one warm-up and one owner turn. Fixture exit code was 0. The measured result applies to this fixture and these two RPC methods.
- The runtime binary was built from exact tag `4607249e430dac1c961df4dc615beae88e33cec8` with the source diff already present for the legacy read-only RPC experiment plus this steering patch. Before applying the steering patch, `git diff HEAD --binary` had SHA-256 `dc3fc07b3f6a4270a015d4925f96713459fb350647b93c3efbdbbf226cb5d123` across 35 files. The steering patch alone had SHA-256 `8e00fe6cbc973a1760935336495042ee50c3ebeea560d24188b34816f92614aa` and changed only `turn_processor.rs` and `thread_state.rs`. The composed diff had SHA-256 `e0001c8a523960b69e4f2adf23416ac991643e8ab1bc64612cfaf928399de334` across 37 files. This is a composed runtime result, not an isolated runtime measurement of the steering patch alone.
- After the probe, the new binary was preserved at `/var/tmp/orbit-codex-steer-app-server-green`, the shared target binary was restored to its prior SHA-256 `c1214554e7ea7412cd9072e8f57f710539226b394260422c8170b5c1e46c4042`, and the two steering source edits were reversed in the shared build tree. No installed executable or personal profile was changed.
- `thread/injectItems`, realtime input, internal turn producers, and dynamic tool callbacks are outside this patch. It does not prove that all ways of changing a running turn are owner-bound.
- Work before input submission in `turn/start`, including client-info assignment and thread-setting construction, was not audited for mutation by a rejected non-owner request. The fixture counts model requests but does not prove that every setting and side effect stayed unchanged.
- A turn begun inside `thread/start` without a later `turn/start` has no recorded owner here, so steering it is rejected while the experiment is enabled. A disconnected owner's active turn also remains unavailable to a new connection until it ends.
- Core's `steer_turn` currently accepts user input, not a standalone `toolOutput`. Under this opt-in route, a `toolOutput` can start an idle turn but cannot steer an active turn. The patch also rejects an empty `turn/start` with no `toolOutput` to preserve the current requirement for explicit input.
- This patch has not been composed with the dynamic tool callback patch or the legacy read-only RPC experiment. Account continuity, Desktop rendering, existing-thread write safety, and other applications remain unmeasured by this candidate.

The dynamic tool callback owner patch applies cleanly with this steering patch
in a disposable source tree, but their two owner records and terminal cleanup
have not been compiled or tested together. The per-turn `allowedTools` patch
replaces the same `turn/start` submission block as the steering patch and
requires a manual merge. In that merge, a request with a new tool ceiling must
use `start_turn_if_idle`; only the recorded owner may use expected-ID steering
without a new ceiling. A joint build and two-client tool inventory and
steering fixtures are required before any combined behavior can be claimed.
