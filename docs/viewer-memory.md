# Viewer memory

The viewer decodes one frame, draws it to a reusable Canvas, then closes the ImageBitmap in `finally`. Obsolete frames are also released. Polling stays sequential and timestamps are published after drawing.

```mermaid
flowchart LR
    Capture[Capture scoped application] --> Decode[Decode one frame]
    Decode --> Draw[Draw to Canvas]
    Draw --> Release[Release bitmap]
    Release --> Next[Next poll]
```

The original image-element approach retained hundreds of MiB of decoded image storage in a renderer. Changing URLs alone did not resolve that observation. Canvas rendering, disk-backed profiles and earlier cache reclaim supported a successful 600-second scripted run at about 5 FPS. See [validation](validation.md) and [resource limits](resources.md).

This does not prove all browser caches remain bounded under arbitrary workloads. Profiles are retained on disk and need an explicit retention policy. Human takeover and simultaneous-work confirmation remain separate from scripted performance results.
