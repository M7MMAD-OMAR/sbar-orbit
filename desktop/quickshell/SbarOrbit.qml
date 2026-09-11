pragma Singleton
pragma ComponentBehavior: Bound

import Quickshell
import Quickshell.Io
import QtQuick

/**
 * What Orbit is doing, for a shell bar.
 *
 * It reads one long running helper that prints a JSON line whenever something changes, so there is
 * no polling in QML and a quiet desktop costs nothing. The helper is `desktop/orbit-stream.py` from
 * the Sbar Orbit checkout, expected at ~/.local/bin/orbit-stream or named by ORBIT_STREAM.
 * `sbar-orbit status --watch` prints a related shape but not the same one, so it is not a drop in
 * replacement: it carries no `reachable` field and no per session view count.
 *
 * The helper is restarted if it exits, so the bar recovers on its own when the broker or the
 * checkout comes back.
 */
Singleton {
    id: root

    // An absolute path, because a shell started at login does not always carry the person's PATH,
    // and Process does not go looking. ORBIT_STREAM overrides it for a checkout somewhere else.
    readonly property string program: Quickshell.env("ORBIT_STREAM")
        || (Quickshell.env("HOME") + "/.local/bin/orbit-stream")
    property bool reachable: false
    property var sessions: []
    property int working: 0
    property int paused: 0
    property int views: 0
    property string summary: "Orbit not running"
    readonly property int count: root.sessions.length
    readonly property string state: !root.reachable ? "offline"
        : root.working > 0 ? "working"
        : root.paused > 0 ? "paused" : "idle"

    /** Raised when a session or one of its windows appears, which is what a bar blinks for. */
    signal appeared

    function forget() {
        root.reachable = false;
        root.sessions = [];
        root.working = 0;
        root.paused = 0;
        root.views = 0;
        root.summary = "Orbit not running";
    }

    function ingest(line) {
        let status;
        try {
            status = JSON.parse(line);
        } catch (error) {
            console.warn("[SbarOrbit] could not read a line from", root.program, error);
            return;
        }
        const wasCount = root.count, wasViews = root.views;
        root.reachable = status.reachable ?? false;
        root.sessions = status.sessions ?? [];
        root.working = status.working ?? 0;
        root.paused = status.paused ?? 0;
        root.views = (status.tabs ?? 0) + (status.windows ?? 0);
        root.summary = status.summary ?? "Orbit not running";
        if (root.count > wasCount || root.views > wasViews)
            root.appeared();
    }

    function openViewer() {
        viewerProcess.running = true;
    }

    Process {
        id: stream
        running: true
        command: [root.program]
        stdout: SplitParser {
            onRead: line => root.ingest(line)
        }
        onExited: (code, status) => {
            root.forget();
            retry.start();
        }
    }

    Process {
        id: viewerProcess
        command: [root.program, "--open-viewer"]
    }

    Timer {
        id: retry
        // Not restarted straight from onExited: a missing helper would then respawn at full speed.
        interval: 5000
        onTriggered: stream.running = true
    }
}
