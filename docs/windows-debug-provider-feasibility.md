# Windows debugging handle provider, preparation only

This separate opt-in fixture proposes creator-owned `DEBUG_PROCESS` observation of one
disposable Bun root and its native-created grandchild. It does not repair the production
collector. Full unchanged Chrome descendant coverage, compatibility, performance and
debugger-sensitive behavior remain not measured and open prerequisites.

The controller owns two noninherited jobs with kill-on-close and no breakaway.
The suspended debugger helper joins the outer containment job before resume. Its
native-created root and grandchild inherit that containment even before a root
receipt exists. A separate measurement job contains the debuggees; the helper stays
outside that measurement job. No job handle is inherited or duplicated. Nested job
compatibility remains not measured.

The controller passes only its own `PROCESS_DUP_HANDLE` process handle through an
explicit `STARTUPINFOEX` handle list. The helper creates the root suspended with
`DEBUG_PROCESS`, checks `DebugSetProcessKillOnExit(FALSE)`, and transfers the exact
creator root with query/synchronization plus `PROCESS_SET_QUOTA|PROCESS_TERMINATE`
rights. Descendant observation duplicates retain only query/synchronization rights.
The minimal root handoff is published and registered before fallible identity queries.
The helper waits for exact-handle assignment to the measurement job before resume.
The helper's debug API loop checks the actual creator thread ID on every iteration.

Creation events provide exact process handles before user-mode execution. The helper
duplicates those into the controller before continuing. The controller verifies the
same creation/image identity and private job membership on those exact handles.
No candidate PID is opened and no existing process is attached. Ownership records
bind the private session and actual root generation to the OS debug chain. Immediate
parent generation stays not measured; numeric PPID does not fill that gap.

Before either lifetime control, the controller requests a transfer seal. The producer
checks that request on its creator thread after both delivered handles have exact
acknowledgements and no transfer is inflight. It closes transfer admission before
publishing the final sequence and exact inventory. The controller validates that
inventory against both registered handles before intentional debugger death.
A third creation is rejected before duplication, before or after sealing; its event
still receives exceptional continuation and its owned image file closes. A missing
or contradictory seal refuses the controlled lane. This two-generation fixture
barrier is not a complete Chrome provider protocol.

Two controls distinguish mechanisms. The job-close lane closes the sole private job
handle while the debugger remains alive and continues exit events. The debugger-death
lane terminates only its known helper while the private job remains open, requires
both gated debuggees still alive and contained, then permits natural exit. A dead
debugger with its default kill policy would invalidate that second control.

System-managed debug process/thread handles are never explicitly closed. Creation
image and DLL file handles close explicitly. Observer duplicates have independent
retryable ownership; failed closure retains the exact handle. Real exceptions use
normal exception dispatch, except the expected first loader-breakpoint candidate.
That classification still needs actual Windows scrutiny. Every ordinary event is
continued. Failures request bounded cooperative abort and reconcile the exact root
and transferred-handle inventory before helper termination. An unreconciled creator
is terminated through the already-owned outer containment job, never helper first.
Cleanup requires known helper/root exits and empty exact job accounting. Missing
transfer inventory remains unknown even if process containment has emptied. Failed
handle closures stay retryable only after process exit proof. A controller timeout
closes both sole job handles; actual exit confirmation is still not inferred.

Each lane has an absolute 20 second deadline, plus 4 seconds for cleanup, at most
8192 events and 64 process generations. The Windows job has a 5 minute outer bound;
the controller command has 60 seconds plus a 5 second observation grace. A timeout
is not cleanup success. Reports and raw private event/gate files upload on failure.

Unsupported nested debug-chain splits, external process creators and lost handoffs
remain unknown. The initial Bun workload deliberately covers only its controlled
chain. A future native split control and actual unchanged Chrome lane are required
before judging provider coverage. Debug events pause processes and exit completion,
so even a successful fixture cannot establish uninstrumented runtime parity.

Portable controls retain the actual older PING creation record, contrast the unchanged
numeric ancestry helper with generation/session/job admission, preserve real exception
semantics, reject incomplete coverage, exercise failed-close retry ownership and
contrast the old identity-before-root-registration order with an injected query failure.
Partial handoffs, widened observation rights, missing seals, inflight transfers, late
third generations and missing abort acknowledgements are
rejected without native execution.
They are preparation only until run. The existing production helper and PR 8 stay unchanged.

See the official [debug event contract](https://learn.microsoft.com/en-us/windows/win32/debug/debugging-events),
[debug inheritance flags](https://learn.microsoft.com/en-us/windows/win32/procthread/process-creation-flags)
and [debugger exit policy](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-debugsetprocesskillonexit).
