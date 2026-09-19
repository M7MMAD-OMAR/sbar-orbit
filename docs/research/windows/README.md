# Windows research

The sourced groundwork behind the Windows adapter, kept in the repository for the same reason the
macOS research is: a design is only checkable against the sources it came from.

| Document | Question it answers |
|---|---|
| [port-research.md](port-research.md) | What a Windows 10 1809+ and Windows 11 port can and cannot rely on: job objects, pipes, Chromium's behaviour, Application Bound Encryption, and the network stack |

## How to read this

It was written before the Windows port, on Linux, against Microsoft Learn, the sdk-api source behind
that documentation, Chromium source, libuv source, and the Node and Bun issue trackers. Every claim
carries the URL it came from, and anything without a primary source is labelled **not confirmed**.
Struct layouts marked "derived" were computed from documented field types under the x64 ABI rather
than quoted, which is a weaker kind of claim and is marked as one.

What was subsequently measured on a real Windows guest is in
[../../windows-measured.md](../../windows-measured.md). Where a measurement contradicted the
research, the measurement won.

## Its counterpart

[../macos/](../macos/) is the same exercise for macOS, done later and with the audit of the finished
adapter included. The two ports reached one conclusion independently, which is the reason both
documents are kept: Chromium's crash handler escapes a process group sweep on purpose, so it has to
be disabled rather than contained.
