# Native acceptance status

Updated 27 October 2026. This is the maintained index of dated measurements, not a
claim that every operation works in every application or on every machine.

| Evidence date | Measured scope | Record and limits |
| --- | --- | --- |
| 22 October 2026 | Original application opening, capture and exact cleanup matrix; real editor Save, Arabic input and shared clipboard Calculator workflows; external-agent and visible-indicator observations | [Native application report](native-acceptance-0.3.0.md). Individual failures and inconclusive owner-activity samples remain explicit. |
| 26 October 2026 | Original Chrome local document and address selection replacement, modifier aliases and recovery after a rejected key; original Calculator result `19134` followed by exact normal closure | [Keyboard reliability investigation](native-input-reliability.md). No platform account or detection test; earlier selection-collapse cause remains unestablished. |
| 26 October 2026 | Source and installation contracts on Linux, Windows and macOS; static English/Arabic website | [Exact 0.3.2 provider run](https://github.com/M7MMAD-OMAR/sbar-orbit/actions/runs/40376588771). These jobs do not control native desktop applications. |
| 30 October 2026 | Hyprland 0.57.0 (0aa6745f705f): plugin ported and loaded on the live compositor; original GNOME Text Editor on workspace 20 took click, typed text, Return, Ctrl+A, Ctrl+C and Ctrl+V; capture showed the whole window after the 0.56 UV correction was removed; label, agent cursor and frame rendered on the presented monitor; test window closed and discarded. Drag, scroll and the click ring were not exercised | [Port commits](https://github.com/M7MMAD-OMAR/sbar-orbit/commits/main) |

Earlier [opening observations](native-opening.md) and
[external-agent failures](external-agent-acceptance.md) describe their older
revisions. Their former category refusals and incident hold do not govern the
current runtime. Use [the product contract](desktop-only.md) for current behavior.

Native Windows/macOS and other compositor adapters remain unimplemented. Signed-in
state, complete workflows and concurrent owner activity need evidence for each
application and host. Fixtures, source CI, installation and delivery receipts do
not fill those gaps. See [support tiers](support-tiers.md) and
[the real acceptance procedure](acceptance-procedure.md).
