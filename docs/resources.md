# Resource limits

Supported Linux launchers share one user cgroup slice, `sbarorbit.slice`.

| Resource | Aggregate limit |
|---|---|
| CPU | One logical CPU worth of time |
| Memory pressure threshold | 1792 MiB |
| Hard RAM limit | 2 GiB |
| Added swap | 0 |
| Tasks, including threads | 512 |
| Scheduling | Reduced CPU/I/O weights and niceness 10 |

```sh
bun run serve
bun run verify
bun run scripts/limited.ts bun run experiments/viewer-timing.ts 600
```

Limits cover owned jobs collectively, not unrelated applications or a viewer opened in an existing user application. A limit failure must never trigger an unrestricted retry. Cgroup membership is checked at browser startup and sampled by diagnostics; this is not a security boundary against same-user programs.

Browser workspaces use private disk-backed directories. Retained profiles on tmpfs would consume RAM after processes exit. The viewer reuses a Canvas and explicitly releases decoded frames. The earlier memory-pressure failures informed these changes; the corrected scripted run completed 10 minutes. See [validation](validation.md).

Diagnostics sample shared and per-run accounting separately. File cache, retained files and active application memory are different contributors. Do not sum per-process RSS as if shared pages were unique. The timing experiment stops above 1900 MiB shared charged memory, before the unchanged hard cap.
