# Windows owned browser cleanup evidence

This change repairs cleanup contracts found while investigating a Windows installed-browser startup failure. It does not establish the cause of that startup failure.

## Observed failure and limits

Run [37411189838](https://github.com/M7MMAD-OMAR/sbar-orbit/actions/runs/37411189838), source `66e1594`, first Windows installed-browser attempt: Chrome remained alive without publishing DevToolsActivePort within 15 seconds. The command took 15502 milliseconds. The authorized targeted rerun passed on unchanged source. Preserve both attempts; readiness root cause remains unknown. Installer stderr being empty does not establish that owned Chrome stderr was empty, and a public stop acknowledgement did not prove zero surviving processes under the old contract.

## Cleanup contract

The job handle stays open while TerminateJobObject acts only on the owned job. Within the existing four second cleanup deadline, both the job membership query and the root exit code must confirm that the tree is gone. A query error, late observation or live root/descendant retains uncertainty. CloseHandle must succeed before the handle is marked closed. Failed cleanup can be retried.

A failed startup with uncertain cleanup retains its profile, profile-key lease, account, clone and egress resources together with a cleanup callback in the current broker. Shutdown attempts active stops and retained callbacks even when one fails, then reports their failures. Retained startups count toward the session limit. Active session stop and browser close also reset failed pending promises so a subsequent stop can retry. No broker restart or persistent retry capability is claimed by these in-memory callbacks.

Startup diagnostics record numeric owned root/job state before and after stop, bounded job PID lists, budget and accounting, query errors, endpoint state and stderr byte/EOF/error metadata. They do not log environment, arguments, profile paths or raw stderr in the new structured evidence. Post-close accounting is not used as proof of surviving or exited processes. The endpoint readiness timeout is unchanged.

## Pure regression evidence

The same eight test cases ran against the unfixed source and the correction in one bounded command per comparison: eight baseline test failures, then eight passes with 26 assertions. The cases cover CloseHandle failure and retry, unobserved root exit, remaining descendants, membership query failure, observations after the deadline, retry after failed handle closure, startup profile/lease retention through cleanup retry, and retained startup cleanup despite an active stop failure.

An initial baseline driver selected the Linux stop method by mistake, producing three ReferenceError setup failures. That result is not accepted as red evidence. The driver was corrected to restrict extraction to launchOnWindows and require its original child-exit Promise.race. Later comparisons produced the expected assertion failures listed above.

Candidate pure tests are reproducible with:

```sh
bun run scripts/limited.ts bun test tests/windows-owned-cleanup.test.ts tests/browser-cleanup-retention.test.ts
```

The optional ORBIT_WINDOWS_JOB_SOURCE, ORBIT_WINDOWS_STOP_SOURCE and ORBIT_SESSION_CLEANUP_SOURCE test variables select the preserved original source for a red comparison. They are test-only inputs. The session baseline must sit beside its original imports, and temporary baseline files must be removed before typecheck or packaging.

No local Windows browser, Windows kernel API, owner compositor, application, pointer or screen operation ran for these tests. Local typecheck and actual Windows API/browser validation remain pending remote verification. Pure fixtures support a Limited contract result, not actual Windows zero-survivor evidence or a readiness diagnosis.

## Compatibility

WindowsJob.close retains its void signature, but now throws when CloseHandle fails. Its direct callers retain the kill-on-close fallback. Broker request schemas are unchanged. Cleanup errors preserve the primary failure and the cleanup failure in an AggregateError with a retry capability held inside the broker; callers must not interpret an error as successful cleanup.
