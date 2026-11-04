# Owned reader producer and pre-spawn debt evidence

4 November 2026, Asia/Dubai. The final owned-scope probe ran from 6:41:18 PM to
6:41:19 PM (2:41:18.337547 PM to 2:41:19.715313 PM UTC) on Linux
7.2.15-200.fc44.x86_64, x86_64, Python 3.14.8. The source baseline was
`3a7427e04fe8728ab24aa17d85d51d9a654ebfec` with the measured working-tree files
listed below. This is not original-application capture qualification.

## Real kernel evidence

The [manual owned scope probe](../experiments/reader-scope-probe.py) used only a
fresh private cgroup parent and disposable stdlib helper processes. It performed
no desktop input, capture, application launch, clipboard operation or broker
restart. Seven scenarios completed, including:

- A fixed bootstrap owned by a coordinator that died before admission was reaped.
- Tracked child birth was durably bound before migration and admission. A root
  could exit and close pipes while its descendant kept the scope populated;
  retirement refused until the owned leaf was stopped and root separately reaped.
- An owner death after admission left durable debt. Recovery pinned the original
  leaf and refused to manufacture the former owner's root-reaped receipt.
- Sixty-four healthy checkpoints retained the same inode; cumulative pre-checkpoint
  journal history was 106368 bytes and the largest checkpoint was 291 bytes.
- A durable unbound spawn intent remained UNKNOWN after the owned leaf was empty
  and killed. Empty cgroup state did not clear the possibility of an unbound root.

The probe exited 0, removed its fresh owned parent, reported no cleanup errors and
confirmed shared cgroup control values unchanged. The deliberately unresolved
fixture journal remains in the private cache. It was never used as production
recovery authority. Source hashes from that exact run:

| Source | SHA-256 |
| --- | --- |
| [Reader scope](../src/native/reader_scope.py) | 4ddc6b6e41460e92e3f3e55320e9732d08e2e18f8f7728df8bc19b856fb30931 |
| [Probe](../experiments/reader-scope-probe.py) | dba23c097f04c44d2fce83ab5caacef5bc47350f82e5ee04c285ff0c2fb3a262 |
| [Manual entry](../experiments/reader-scope-probe.ts) | f67b859d8d1cc7730c0ce0d47f9b74bdd9920939cb4f6d9692c6c6ea0e4334ca |

The leaf ceilings used were 32 MiB, 8 tasks, no swap and 50000/100000 CPU quota.
They do not establish total application, compositor, GPU or full-device memory.

## Internal producer and validation

The new [one-shot producer](../src/native/reader_process.py) composes an explicit
pre-spawn reservation, fixed stopped [bootstrap](../src/native/reader_bootstrap.py),
retained child identity, scope admission, pidfd resume, bounded [pipe reader](../src/native/reader_pipe.py),
strict [PNG validation](../src/native/reader_png.py), separate root-reap and scope-empty
retirement. Its tests use controlled process/scope fixtures, not a compositor.
The bootstrap invokes only the fixed `grim -T` route after admission; it validates
its runtime/socket and nonprivileged provider metadata. No generic command, PPM
fallback or resizing is authorized. Deadline checks are cooperative and cannot
preempt every filesystem or subprocess syscall.

A pending spawn without a bound child remains durable UNKNOWN even when the
leaf is empty. No Popen exception, timeout, signal, EOF or parent death alone
clears it. A bound but unadmitted root must be separately stopped/reaped. Every
producer error reports owned scope and external provider completion UNKNOWN.
Even a validated image and an empty owned leaf leave external compositor/provider
completion UNKNOWN; an integrating device scheduler must quarantine the conflicting
credit until that separate boundary is qualified. The modules are not wired into
a production consumer, so no automatic capture or new public capability is enabled.

The source fixtures separately validate 76 journal cases, 28 producer cases,
28 PNG cases and 26 bootstrap cases. These do not prove physical visibility,
frame correctness in an installed application, external GPU drain, peak memory
or multi-view safety. The current 1280x960 physical limit is enforced rather than
raised to fit the earlier Calculator result.
