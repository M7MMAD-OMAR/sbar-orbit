# Multi-view platforms: evidence, taxonomy, and adoption boundaries

Source check: 4 November 2026. Documentation and public source review only. No upstream application, VM, model, extension, recorder, input adapter, or browser session was installed or run for this review. No comparative speed, reliability, isolation, or input-concurrency result was measured locally. This is input to a future plan, not an implementation or an acceptance record.

## Decision in brief

Adopt explicit target identity, separate conversation namespaces, bounded observations, dependency scheduling, an action lease for contested resources, and visible human controls. Do not equate more views, sessions, agents, or cursor drawings with independent native input. Admit parallel actions only after proving that their actual effect domains are independent. Otherwise parallelize planning and bounded reads while serializing conflicting effects.

Current Orbit native-control evidence is Hyprland/Linux. Windows companion or discovery support does not establish native Windows control, and this comparison qualifies no new Windows or macOS adapter. Orbit continues to use original installed applications in explicit visible numbered workspaces. Preserve ordinary owner state, unsaved work, focus, pointer, and the normal shared system clipboard. No copied profiles, hidden substitute desktops, or VM substitution for an original-application task. Browser-specific tooling remains useful for ordinary web work through the host, not a silent replacement for Orbit native application control. See the [product contract](<../desktop-only.md>) and the earlier [pinned agent-desktop comparison](<agent-desktop.md>).

Nothing here authorizes screenshot streaming, always-on screen or audio history, clipboard history, global clipboard save/restore, new accounts, remote access, permissions changes, or unattended approvals. A bounded observation of an explicitly selected target is not permission to record every view.

## Evidence and revision discipline

Hosted documentation was retrieved directly on the source-check date. Repository branch identities were read through the public GitHub Git-reference API, without cloning, building, or changing authentication. A repository pin does not pin a separately hosted documentation deployment. Claims below are upstream documentation claims unless explicitly described as a planning inference.

| Project or branch | Observed commit | Primary evidence |
| --- | --- | --- |
| agent-desktop main | `6660fbac768dc7e7332837b90ed465684859afa3` | [System command reference](https://github.com/vercel-labs/agent-desktop/blob/6660fbac768dc7e7332837b90ed465684859afa3/skills/agent-desktop/references/commands-system.md#L168-L213) |
| Cua main | `752539e559e07d728a53a378c053037a8bb22457` | [README and licensing boundaries](https://github.com/trycua/cua/blob/752539e559e07d728a53a378c053037a8bb22457/README.md) |
| Microsoft UFO main | `eae3c0a8d168c47cb10df0652e293e092eda1078` | [Galaxy overview](https://microsoft.github.io/UFO/galaxy/overview/) and [repository license](https://github.com/microsoft/UFO/blob/eae3c0a8d168c47cb10df0652e293e092eda1078/LICENSE) |
| Screenpipe main | `a5cf53ad5b94ddcabc69256066b3b0b933b5332f` | [License at the pin](https://github.com/screenpipe/screenpipe/blob/a5cf53ad5b94ddcabc69256066b3b0b933b5332f/LICENSE.md), separately hosted architecture below |
| Magentic main, now MagenticLite | `d3c9d13c39288257286a66daabf7c5b5fb72ee69` | [Current README](https://github.com/microsoft/magentic-ui/blob/d3c9d13c39288257286a66daabf7c5b5fb72ee69/README.md) |
| Magentic historical `magentic-ui-0.1` | `f705b0ee29af5ddc03953e6d3be4c0a880a78b09` | [Historical README](https://github.com/microsoft/magentic-ui/blob/f705b0ee29af5ddc03953e6d3be4c0a880a78b09/README.md) |

The published [agent-desktop sessions Markdown](https://agent-browser.dev/desktop/sessions.md) returned its full page during this review, with a page update date of 2 November 2026. Retrieval has varied between clients. The guessed repository path `docs/sessions.md` returned 404 and is not evidence. The pinned source command reference above independently documents namespaces and the interaction lease. Do not invent a source file path or treat an inaccessible page as read.

## Taxonomy: what each extra unit really buys

These are architectural distinctions, not claims that Orbit already implements every branch. A proposed multi-view registry should keep their identities separate.

| Unit | Meaning and useful fit | What it does not establish |
| --- | --- | --- |
| Physical screen or output | A display with its own geometry, scale, orientation, and lifetime. Useful for visible presentation and human review. | A second output does not create another keyboard, seat, application instance, or permission boundary. |
| Workspace or virtual desktop | A compositor or OS grouping of windows. Useful for visible numbered task organization and retaining unrelated windows. | Usually shares the user session, clipboard, applications, focus machinery, and input devices. Switching views can itself disturb the owner. |
| Window | A particular application surface qualified by process generation and native identity. Useful for target-scoped actions and bounded capture. | Two windows may share one process, document, modal dialog, undo history, or singleton application state. |
| Tab or page | A browser or application content view. Browser tools may address pages without foreground activation. | Tabs can share login, storage, downloads, account effects, application menus, and native dialogs. A native tab is not automatically a Playwright Page. |
| Logical tool session | A namespace for snapshots, refs, traces, or connections. Useful for keeping observations from different tasks distinct. | A label is not a credential, independent seat, desktop, or input lane. The term session is overloaded between products. |
| OS login session | An interactive OS execution environment with a particular user and permissions. Relevant to native visibility and session-scoped APIs. | A second tool session does not create one. A remote service context may not reach an interactive desktop. |
| Seat or input channel | An independently addressed pointer/keyboard focus domain implemented by the compositor or OS. Potentially useful for genuine independent delivery. | A drawn cursor, output, window, or session id is not a seat. Independent seats do not remove shared-document, app-modal, clipboard, or account conflicts. |
| Device | Another explicitly authorized computer with its own local input resources. Useful for genuinely separated local execution in a dependency graph. | Devices may still race on the same cloud account, repository, document, or remote service. No automatic connection is authorized. |
| Conversation | A human-visible intent, policy, approval, and cancellation scope. Useful for ownership and resumption. | Another conversation does not grant another input lane, broaden permissions, or invalidate conversation off. |
| Agent or worker | A reasoning or execution actor assigned a scoped task. Useful for independent analysis and scheduling ready work. | More workers do not imply more safe parallel UI mutations. Agent count must not be reported as measured input concurrency. |

## 1. agent-desktop: namespaces and cursors with serialized effects

Primary sources: the [published sessions page](https://agent-browser.dev/desktop/sessions.md) and [pinned source reference](https://github.com/vercel-labs/agent-desktop/blob/6660fbac768dc7e7332837b90ed465684859afa3/skills/agent-desktop/references/commands-system.md#L168-L213).

A session owns an on-disk snapshot namespace and, if enabled upstream, trace storage. Ref lookup stays within that namespace. Several agents may share a session, but its latest-snapshot pointer is shared; each actor must use refs from its own qualified observation. Starting a session does not activate it in later independent processes.

The multi-agent cursor feature names actors and presents their intended targets. Its headless cursor travel happens before acquisition of the interaction lease, so cursor animations may overlap while actions take turns. Commands drawing the same cursor serialize from travel through click effect. The pinned reference calls the overlay presentation-only and qualifies multi-agent cursors to macOS and Windows. This is not proof of arbitrary parallel native input or of identical behavior on Linux.

Adopt: conversation-scoped observation identities, explicit actor badges, ended-session refusal, bounded state, and a visible queued/running distinction. Avoid: using session names or concurrent cursor motion as input authority; copying upstream trace or screenshot-retention defaults. An upstream trace can contain sensitive observations even when some event fields are redacted. Orbit should keep a content-free execution ledger unless a separately authorized bounded artifact is needed.

## 2. Cua Driver: exact targets, delivery ladders, and a narrow seat exception

Primary sources: [How Cua Driver works](https://cua.ai/docs/cua-driver/concepts/how-cua-driver-works.md), [Platform support](https://cua.ai/docs/cua-driver/concepts/platform-support.md), and the [pinned repository README](https://github.com/trycua/cua/blob/752539e559e07d728a53a378c053037a8bb22457/README.md).

The docs distinguish semantic element actions, background pixel delivery, browser-page tools, and explicit foreground delivery. Each action names an exact target. Delivery is not an observed application effect: upstream separates confirmed, unverifiable, suspected-noop, partial, and refused outcomes. A recommended next delivery rung is not permission for Orbit to retry after uncertain delivery or change foreground focus. Re-observation, idempotency, owner state, and policy still matter.

By default its sessions share one screen, keyboard, and focus, and native input is admitted one action at a time. Session labels and cursor badges are not credentials. This default architecture is distinct from the optional Hyprland plugin described below.

The current platform-support page describes an experimental Hyprland/Omarchy plugin, off by default and outside the normal installer. It adds exactly 2 named agent seats, `Cua-Agent` and `Cua-Agent-2`. The page attributes its narrow qualification to Driver 0.24.0, not to every later build or every application:

- Calc from `libreoffice-fresh 26.2.5-3` and Inkscape `1.4.4-6`, with package metadata checked before every action.
- Matching compositor ABI and compiler toolchain. Hyprland does not inherit Sway qualification.
- No listed proof for Chromium, Electron, or XWayland raw input; Unicode/IME; multiple layouts; or modified pointer gestures.
- Explicit foreground actions change focus and pointer without restoring them on this route.

The linked upstream evidence is [PR 3547](https://github.com/trycua/cua/pull/3547), [PR 3557](https://github.com/trycua/cua/pull/3557), and [PR 3572](https://github.com/trycua/cua/pull/3572). These links are upstream evidence pointers, not locally reproduced results or proof that Orbit can reuse an installed plugin.

Adopt: capability-qualified target/delivery receipts and a future seat branch with exact build identity and app-owned effect checks. Avoid: describing all Wayland compositors as one input API, treating 2 seats as unlimited concurrency, silently using foreground fallback, or claiming an unrelated app inherits Calc/Inkscape coverage. A future Orbit seat design must independently preserve original visible applications, owner pointer/focus, UI visibility, cancellation, and shared-resource serialization.

Cua Spaces and its profile teleport/VM workflow are separate products. Their isolation and multiplayer descriptions do not authorize copying the owner profile or substituting a VM for an original Orbit application task.

## 3. Microsoft UFO Galaxy: dependency parallelism across devices

Primary source: [Galaxy overview](https://microsoft.github.io/UFO/galaxy/overview/).

Galaxy describes a dynamic directed acyclic graph: task nodes have dependencies and device assignments, readiness follows completion events, and capability/load metadata guides placement. Its asynchronous parallelism is explicitly across devices. Assignment locking and graph invariants are coordination claims, not a guarantee of multiple independent keyboards on one shared desktop. The docs also describe retry, migration, and graph editing; these do not establish idempotent external side effects.

Adopt: separate planning from placement, explicit dependency edges, per-device capabilities, ready/blocked states, and controlled failure recovery. Keep both a device lock and finer document/account/output conflicts. Avoid: importing a distributed concurrency claim as shared-desktop input proof, starting remote agents without authorization, or retrying a submission because a node timed out. No remote device was connected for this research.

## 4. Screenpipe: monitor discovery and observation history are not control lanes

Primary sources: [architecture](https://docs.screenpipe.com/architecture.md), [list monitors](https://docs.screenpipe.com/api-reference/vision/list-monitors.md), [recording, memory, workflows, and automation](https://docs.screenpipe.com/recording-memory-and-automation.md).

The architecture describes event-triggered capture paired with accessibility data, OCR fallback, deduplication, and storage, with an idle fallback. It is not a claim that every screenshot is triggered solely by a content change. Listed triggers include app/focus changes, clicks/scrolls, typing pauses, and clipboard-copy events. The monitor endpoint enumerates display ids, stable ids, names, dimensions, and default status. Multiple monitor records establish observation topology, not multiple input seats.

The recording/memory document explicitly separates observed history, inferred workflow, proposed automation, and proof that an output was actually saved. That distinction is useful even when a product also offers automation integrations. It would be incorrect to call the whole product observation-only, or to infer successful control from capture availability.

Adopt: event invalidation, target freshness, bounded change-driven re-observation, and separate capture/effect/persistence receipts. Avoid: adopting its continuous recording, audio capture, searchable history, clipboard events, database retention, or cloud/team data paths as Orbit defaults. A thumbnail or stale capture is neither permission to act nor a fresh target. Do not carry upstream performance figures into an Orbit capacity claim.

## 5. Playwright and Browserbase: different meanings of context

Primary sources: Playwright [pages](https://playwright.dev/docs/pages) and [browser contexts](https://playwright.dev/docs/browser-contexts); Browserbase [Contexts](https://docs.browserbase.com/features/contexts.md).

Playwright defines a Page as a tab or popup within a BrowserContext. Each page behaves like an active page and need not be brought to the front. A BrowserContext isolates cookies and storage like an incognito-like profile, while multiple pages inside one context share that context. This is a browser API capability, not a native OS seat guarantee. Native dialogs and account-wide effects can still conflict.

Browserbase Context is persistent Chromium user data reused by browser sessions, including sensitive authentication/storage state. Its docs advise avoiding simultaneous sessions using the same Context because sites may force logout. Persistence occurs when a writing session closes, with a synchronization wait before reuse. Its merge recipe specifies one writer for the destination Context and copies cookies, not an entire merged profile. These are state/concurrency warnings, not a guarantee that arbitrary concurrent writers converge safely. No general numeric concurrent-session limit is asserted here.

Adopt: explicit page handles, navigation generations, page-created/popup ownership, and a single-writer rule for shared persistent state. Avoid: assuming a Browserbase Context is a Playwright BrowserContext or native desktop session; copying login state or profiles; merging credentials; and treating browser isolation as authorization to replace an original owner browser. Ordinary web research should use the host browser tools. Orbit control of an original browser/profile still requires the explicit owner request and exact installed registration.

## 6. Magentic: current Lite versus historical 0.1

Primary sources: [current pinned README](https://github.com/microsoft/magentic-ui/blob/d3c9d13c39288257286a66daabf7c5b5fb72ee69/README.md) and [historical pinned README](https://github.com/microsoft/magentic-ui/blob/f705b0ee29af5ddc03953e6d3be4c0a880a78b09/README.md).

Current main identifies itself as MagenticLite, uses the 0.2 line, and describes a smaller-model orchestrator/browser-use combination with Quicksand VM-backed browser sessions and human steering/approval. It explicitly points readers seeking the previous 0.1 release to another branch. The historical 0.1 README describes co-planning, co-tasking, action guards, a plan gallery, parallel task execution, and status indicators. Do not relabel those historical interfaces as measured current Lite behavior.

Adopt: a reviewable proposed plan, visible waiting-for-human state, interruption/takeover, explicit sensitive-action approval, and task status separate from success proof. Avoid: using browser VM demos as evidence of original native application control, claiming sandbox guarantees for Orbit, or equating parallel task cards with independent local input. No VM, browser sandbox, or model was launched.

## Future branches and selection gates

These are proposed choices for a later implementation plan, not enabled features.

| Branch | Good fit | Required proof or reason to stay serial |
| --- | --- | --- |
| Parallel analysis, no UI effects | Independent source reading, planning, or calculations with disjoint outputs. | Bound CPU/memory and separate write scopes. Agents must not each rediscover or mutate the same target. |
| Multiple views, one native channel | Distinct original windows/workspaces where tasks spend time waiting or observing. | One owner-visible action lease; exact window generation; reserve process-modal/shared-document effects too. Extra views improve organization, not raw input throughput. |
| Parallel semantic actions | Different qualified controls whose effects do not use global focus or a shared app transaction. | Per-adapter/per-app proof of independent effects, stable identity, modal handling, and owner preservation. Otherwise serialize. |
| Browser page addressing | Ordinary authorized web workflows through the host tools. | Explicit Page ownership and context/account conflicts. No implicit original-profile attachment or copied credentials. |
| Native independent seats | A deliberately qualified compositor extension on original visible apps. | Exact ABI/package identities, real independent delivery/effect measurements, ordinary clipboard conflicts, UI visibility, pause/off and crash cleanup. Fail closed for unlisted routes. |
| Multiple authorized devices | Subtasks genuinely benefit from separate local execution resources. | Separate human authorization and connection setup, identity/health proof, bounded resources, and global account/document conflicts. This research grants none of that access. |
| Serial human handoff | Modal, destructive, credentialed, irreversible, owner-active, or uncertain-delivery steps. | Stop at a visible checkpoint, show exact target/effect, await the applicable human decision, then revalidate. Do not switch to a hidden environment. |

A future registry should distinguish conversation, agent, task, device, output, workspace, process generation, window generation, page generation, observation, and action lease. Do not overload one session string with all of them. A queued view must not look like it is actively typing. A drawn cursor must show intended or observed target and must never be counted as delivered input.

## When parallel execution is worse

- Two workers contend for one keyboard/focus domain, shared modal dialog, clipboard, undo stack, or document. More retries make correctness worse.
- One application is single-instance or its background route only appears to succeed. Use an effect check and serialize rather than escalating automatically.
- Views become stale faster than they can be refreshed, or workers invalidate each other's qualified targets. Re-observe once under the action lease rather than capturing every view continuously.
- Model, capture, accessibility walks, OCR, rendering, and memory compete for the same budget. Reduce active workers before lowering identity/permission checks. No speedup is promised.
- Tasks share a website login, cloud-side object, destination filename, or repository write scope, even on different devices. Resource locks must follow effects, not merely windows.
- Owner activity, display hotplug, scale changes, window movement, conversation off, or permission revocation invalidates the plan. Cancel queued effects; do not replay a held click on a new target.
- Too many approval requests or cursors overload the human. Prefer one clear decision queue and a smaller number of active actors.

## Human UI and future acceptance obligations

The proposed UI should expose a task/view roster, exact visible target, actor, resource conflicts, queued/running/paused/waiting-for-approval states, and whether an observation or effect is unverified. Show permission and native-capability limits rather than pretending every platform has the same controls.

Conversation off must stop that conversation's future effects across every route. A proposed owner-wide pause must be clearly distinct from per-conversation and per-task controls and report its scope. Ending one task must not reset or restart a shared broker underneath another active task. Approval belongs to a specific target, action, and current policy scope. It is not a blanket grant to other conversations, new foreground routes, new profiles, native permissions, or other devices. Existing owner authorization governs ordinary actions; use explicit human UI checkpoints for scope changes and sensitive commitments, not an arbitrary prompt before every keystroke.

Before enabling a branch, test original-app identity across restart/replacement; observation completeness/expiry; stale and identical targets; owner pointer/focus and unsaved-state preservation; modal interference; normal clipboard races without clipboard snapshots; cancellation and off; partial/uncertain delivery without unsafe retry; hotplug/scale changes; and resource pressure. Verify an actual application effect and saved output where relevant. Tests or demonstrations from another product do not satisfy these gates.

Public evidence should contain fixed counters, durations, failure categories, and source/runtime identities only. No private window titles, page URLs, screenshots, tree contents, clipboard data, credentials, or account identifiers. Private bounded content observations remain governed by the normal task policy and are not a new screenshot stream or retention service.

## Provenance and licensing before any port

This document copies no implementation, model, binary, profile, or dataset. The observations below report upstream declarations, not legal advice or a redistribution clearance. Re-check the exact component, revision, generated assets, dependencies, model files, notices, trademarks, and distribution/use terms before any port; involve the owner or qualified reviewer where needed. Root licenses are not transitive licenses for every component.

| Source | Declaration actually observed | Adoption boundary |
| --- | --- | --- |
| agent-desktop | [Apache-2.0 at the pin](https://github.com/vercel-labs/agent-desktop/blob/6660fbac768dc7e7332837b90ed465684859afa3/LICENSE) | Preserve applicable provenance/notices if a later approved port occurs; compare current code with the earlier reviewed pin. |
| Cua | [Pinned README licensing](https://github.com/trycua/cua/blob/752539e559e07d728a53a378c053037a8bb22457/README.md#licensing) describes Driver/core as MIT, with directory exceptions. Spaces and Driver Bench are separately FSL-1.1-MIT; optional perception includes separately licensed model/runtime components. | Do not treat Spaces, perception models, streaming clients, or all dependencies as covered by the Driver root license. Review each exact artifact before reuse. |
| Microsoft UFO | [MIT at the pin](https://github.com/microsoft/UFO/blob/eae3c0a8d168c47cb10df0652e293e092eda1078/LICENSE) | A scheduling pattern can be studied without importing code or its remote-device runtime. |
| Screenpipe | [Current pinned license](https://github.com/screenpipe/screenpipe/blob/a5cf53ad5b94ddcabc69256066b3b0b933b5332f/LICENSE.md) is named Screenpipe Commercial License and describes source-available restrictions. It distinguishes earlier MIT versions. | Do not call current main MIT or copy current code based on historical MIT publicity. Any reuse needs a separate exact-revision/component rights review. |
| MagenticLite / historical Magentic-UI | The [current](https://github.com/microsoft/magentic-ui/blob/d3c9d13c39288257286a66daabf7c5b5fb72ee69/README.md#license) and [historical](https://github.com/microsoft/magentic-ui/blob/f705b0ee29af5ddc03953e6d3be4c0a880a78b09/README.md#license) READMEs declare MIT for repository code. | Models, VM images, dependencies, and service terms still need separate provenance and licensing checks. |
| Playwright / Browserbase | Playwright's [current root license](https://github.com/microsoft/playwright/blob/main/LICENSE) is Apache-2.0. Browserbase documentation describes a hosted service, not a reusable desktop-input license. | Review any exact SDK/dependency license and service/data-processing terms separately. No account or hosted session is created here. |

## Research conclusion

The strongest reusable pattern is not a wall of screenshots or a cursor per worker. It is a precise mapping from human intent to qualified targets, independent observation state, effect-aware resource admission, visible ownership, and honest verification. Start with serial native effects and parallel reasoning. Promote a branch to genuine concurrent delivery only when its original-app, platform, permission, identity, owner-state, and resource evidence supports that exact claim.
