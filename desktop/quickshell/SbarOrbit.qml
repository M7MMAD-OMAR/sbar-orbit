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
 * the Sbar Orbit checkout, expected on PATH as `orbit-stream`, or named by ORBIT_STREAM.
 * `sbar-orbit status --watch` prints the same shape and can be used instead, at the cost of a Bun
 * runtime that measured 117 MB resident against the helper's 17 MB.
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
    property int tabs: 0
    property int windows: 0
    property string summary: "Orbit not running"
    readonly property int count: root.sessions.length
    readonly property int views: root.tabs + root.windows
    readonly property string state: !root.reachable ? "offline"
        : root.working > 0 ? "working"
        : root.paused > 0 ? "paused" : "idle"

    /** Raised when a session or one of its windows appears, which is what a bar blinks for. */
    signal appeared

    property int lastCount: 0
    property int lastViews: 0

    function ingest(line) {
        let status;
        try {
            status = JSON.parse(line);
        } catch (error) {
            console.warn("[SbarOrbit] could not read a line from", root.program, error);
            return;
        }
        root.reachable = status.reachable ?? false;
        root.sessions = status.sessions ?? [];
        root.working = status.working ?? 0;
        root.paused = status.paused ?? 0;
        root.tabs = status.tabs ?? 0;
        root.windows = status.windows ?? 0;
        root.summary = status.summary ?? "Orbit not running";
        if (root.count > root.lastCount || root.views > root.lastViews)
            root.appeared();
        root.lastCount = root.count;
        root.lastViews = root.views;
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
            root.reachable = false;
            root.sessions = [];
            root.summary = "Orbit not running";
            retry.start();
        }
    }

    Process {
        id: viewerProcess
        command: [root.program, "--open-viewer"]
    }

    Timer {
        id: retry
        interval: 5000
        onTriggered: stream.running = true
    }
}
