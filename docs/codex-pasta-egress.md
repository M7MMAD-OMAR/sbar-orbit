# Codex private namespace egress

Status on 28 September 2026: disposable network proof, no production launch.

`experiments/codex-pasta-egress-probe.py` starts a private user and network
namespace through the installed `pasta` binary. It passes `--config-net` to
configure the namespace interface and `-t none -u none` to disable forwarding
guest TCP and UDP listeners to the host. A child in that namespace reads a
marker from a disposable HTTP fixture on the host. While the child listens on
its own loopback port, a host sibling cannot connect to that port. The run
printed `modelReplyCorrect: true` and
`hostCanReachPrivateExecutorPort: false`.

```sh
bun run scripts/limited.ts /usr/bin/python3 experiments/codex-pasta-egress-probe.py
```

The fixture uses pasta's default gateway mapping to reach a host loopback
server. That mapping also makes other host loopback services reachable from
the namespace, so this configuration is not a final egress policy. It did not
contact an external model API, start Codex, read a personal profile, or prove
authentication. The private executor port remained unforwarded in this run.
