# Efficiency native acceptance: original Calculator

Recorded 4 November 2026 (Asia/Dubai). This is a partial, operation-level live run, not a comparative speed result or general desktop compatibility claim.

## Identity and method

- Production source through commit `723ba87`, including `f8e8c81` queued-authority and observation acknowledgement changes. The manual controller used the real host conversation usage state, a normal verified adapter claim and the production MCP -> IPC broker -> Sessions -> native worker path.
- The controller owned a private control socket and broker lifecycle only. It used the original installed `org.gnome.Calculator.desktop` registration, normal owner application state and real Hyprland desktop. No hidden desktop, copied profile, browser/account task, owner credential or shared-broker restart was used.
- Native readiness was restored normally for Hyprland 0.57.1, commit `acc1aa0bfd4bd575dcb0f76c35ccf12b660a1ab9`, after signed matching headers were verified and a private source-stamped plugin was compiled. [Build/readiness ledger](efficiency-plan.md#native-readiness-repair-not-application-acceptance).
- Cold observation mode only: `ORBIT_A11Y_WARM_HOST=0`. Warm helper, semantic AT-SPI input and public refs were not enabled.
- Preflight discovery verified Calculator was not running. Workspace 1 was displayed on unfocused eDP-1; HDMI-A-5 was focused on workspace 4. Opening used an explicit 640 by 480 floating request on that already visible numbered workspace, without changing any monitor workspace. Five unrelated original window identities were sampled without reading their titles or pixels.

## Operation results

| Operation | Evidence | Limit |
| --- | --- | --- |
| Registered original opening | `opened:true`, launch-ancestry attribution, new exact Wayland address/stable identity and process. Controller required absence from its pre-open candidate list. | This proves the attributed opening, not input or long-term geometry stability. |
| Exact handoff | Fresh registration/PID and candidate checks, then selected exact address/stable identity. Returned native app/window handles and one client lease. | Opening and fresh discovery corroborated PID; MCP handoff did not supply a separate target PID field. |
| Initial native image plus text | Inspected the returned Calculator PNG, 853 by 821 pixels for a 640 by 616 logical surface. Tree: 36 nodes, complete bounded filtered traversal, cold read mode. | The image showed the initial empty input field, not the later arithmetic result. No full owner-desktop screenshot or continuous cursor/focus guarantee is claimed. |
| Native arithmetic input | One batch: key `1`, `plus`, `2`, `Return`. Four `ok` delivery receipts; input was never replayed. | Receipts alone did not establish application acceptance. |
| Settled post-input capture | Failed with `captureError.code:NATIVE_FAILED`, unknown delivery/unsafe retry, preserving all four input receipts. The inspected private traceback showed nonzero capture failure wrapped in a single-cause exception group; capture stderr was empty. | Nonzero capture with empty stderr does not establish a visibility, geometry or application cause. The final screenshot is absent. |
| Independent post-state read | Paused the session, then requested read-only text. The exact Calculator tree contained history label `1+2`, equals label and result label `3`, with 40 nodes and complete bounded filtered traversal. | This establishes the arithmetic UI result without replay. It is not a save/reopen workflow or proof of physical visibility at that later time. |
| Pause/resume/cleanup | Pause acknowledged. Resumed only to request one normal close of the exact proven test window. Later native candidates no longer contained it; independent compositor metadata also showed it absent. Stopped only this controller caller, with no failed stops. | Normal closure was checked independently, not inferred from `closeRequested:true`. Calculator may retain the intentional test expression in its normal history. No profile/history files were deleted. |
| Controller lifecycle | EOF cleanup completed with process exit 0; owned terminal closed; native lease listing empty. | Shared broker and owner applications were not restarted or killed. |

## Important live findings

1. Geometry was negotiated over time: the opening receipt observed 640 by 480, handoff/initial image observed 640 by 616, and post-input text observed 640 by 637. The run does not prove which toolkit constraint caused each change. This is concrete evidence for [#32](https://github.com/M7MMAD-OMAR/sbar-orbit/issues/32), not an invented `min_size_enforced` diagnosis.
2. At a later metadata sample, eDP-1 displayed workspace 3 rather than 1, while the owner remained focused on HDMI-A-5/workspace 4. The session still returned its legacy `visible:true` native-backend marker; that field was not a current monitor visibility sample. No test command presented or switched a workspace. Attribution of that change is not established. Further task input was paused; no workspace was forced back. Independent read-only inspection and exact test cleanup continued.
3. All five original window identities remained after cleanup, and the sampled owner focused window identity matched its preflight identity. The physical pointer sample differed. It was not warped back; the run does not attribute that difference or claim continuous pointer/focus preservation. Original window geometry and all intervening owner activity were not controlled.
4. Captures need typed unavailable/deadline/observed-geometry-change reporting and one observation budget, without replaying input or silently presenting a workspace. The existing bounded same-target resize resampling must not turn a prior frame into a fresh final result. Source repair and regression tests are separate from this recorded failure.

## Measurement limits

Initial image+text MCP call: 265.413 ms; local worker 258.836 ms; cold tree read 184.526 ms including process/read cost, helper-reported query 146 ms. Later paused text-only MCP call: 170.816 ms; worker 167.099 ms; cold tree read 160.190 ms, query 125 ms. These observations differ in format, tree size, geometry and application state. They are not compatible baseline/candidate runs.

There were no 20-per-task samples, no warm run and no measured end-to-end productivity gain. No 80% claim, account safety/ban guarantee, complete visual indicator acceptance or semantic identity support follows. Raw reply/image artifacts remained in a private local cache, not this repository. Subsequent source repair introduced typed capture errors, a shared observation deadline and crop/text geometry guards, with default verification of 349 passed, 4 skipped and 0 failed. Those fixtures do not retroactively turn this failed settled capture into a successful native re-run. The [efficiency plan](efficiency-plan.md), [host safety design](accessibility-host-design.md) and [provider identity audit](research/atspi-identity-lifetimes.md) define remaining gates.
