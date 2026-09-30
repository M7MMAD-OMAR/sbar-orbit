# Bounded public CONNECT connectivity

The opt-in [diagnostic](egress-public-connectivity.ts) uses the normal namespace
lease for one exact origin, `https://nxcloud.masaar.com`. It attempts eight
sequential CONNECT requests and, after a 200 response, verifies a TLS handshake.
It uses no browser profile, HTTP page content, credentials or personal display.
It records durations, answer counts and fixed error/status codes, not addresses
or payloads. Every connection and the owned lease workspace are closed.

```sh
ORBIT_PUBLIC_CONNECTIVITY=1 bun run scripts/limited.ts bun run experiments/egress-public-connectivity.ts
```

On 30 September 2026 all eight attempts returned proxy status 502 after
5,002 to 5,032 ms. All eight DNS resolutions returned one answer in 0 to 25 ms.
No attempt reached the TLS handshake. This distinguishes connection failure
from DNS failure or an authority refusal during this measurement.

Two direct host controls also failed before connecting, using curl HEAD with
no response body retained, a six-second connect deadline and an eight-second
overall deadline. The second explicitly disabled environment proxies. Both
returned curl exit 28, HTTP status 000 and connect time zero after about six
seconds. Thus this measurement does not show an Orbit-only connectivity fault.
It does not prove the cause of the earlier intermittent Talk failures, a
permanent server outage, or future availability. No timeout was increased and
no confinement or authority check was relaxed. Type checking passed.
