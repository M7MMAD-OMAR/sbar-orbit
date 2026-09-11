import QtQuick
import QtQuick.Layouts
import QtQuick.Shapes
import qs.modules.common
import qs.modules.common.widgets
import qs.services

/**
 * The project mark in the bar, saying what Orbit is doing in the shell's own colours.
 *
 * No number on it: the colour is the whole message, the accent while an agent is working, the
 * tertiary accent while one is paused, quiet while sessions are open but idle. It blinks once when a
 * session or a window appears. Hovering lists the sessions, clicking opens the viewer.
 *
 * Showing and hiding it is the bar layout's job, the way it is for every other indicator: wrap this
 * in a Revealer whose `reveal` is `SbarOrbit.count > 0`, so a bar with no agents running looks
 * exactly as it did before this was installed.
 */
MouseArea {
    id: root

    readonly property color stateColor: SbarOrbit.state === "working" ? Appearance.colors.colPrimary
        : SbarOrbit.state === "paused" ? Appearance.colors.colTertiary
        : Appearance.colors.colOnSurfaceVariant

    implicitWidth: capsule.implicitWidth + 8
    implicitHeight: Appearance.sizes.barHeight
    hoverEnabled: true
    onClicked: SbarOrbit.openViewer()

    Item {
        id: capsule
        anchors.centerIn: parent
        // The mark keeps its own orientation on a vertical bar. A logo that turns on its side is a
        // different logo; only the capsule it replaced had a direction to follow.
        //
        // 18 rather than the capsule's 14: the mark spends part of its width on the outlined square,
        // so at 15 its filled square read lighter than the 16 pixel glyphs beside it. Measured
        // against stand-in neighbours at 15, 18, 20 and 22; 18 is the one that matches.
        readonly property real side: 18
        readonly property real unit: side / 20
        property color tint: root.stateColor

        implicitWidth: side
        implicitHeight: side * 18.21 / 20

        Behavior on tint {
            animation: Appearance.animation.elementMoveFast.colorAnimation.createObject(this)
        }

        // The mark's box is exactly its ink: brand/orbit-mark-small.svg with the safe area taken
        // off, so every coordinate is positive and a bar that clips its indicators cannot cut a
        // corner off it. Scaled from the top left, so the stroke thins with the shape rather than
        // staying at its authored weight.
        Shape {
            width: 20
            height: 18.21
            transformOrigin: Item.TopLeft
            scale: capsule.unit
            antialiasing: true

            ShapePath {
                fillColor: capsule.tint
                strokeWidth: -1
                PathSvg { path: "M2.6 6.05H9.56A2.6 2.6 0 0 1 12.16 8.65V15.61A2.6 2.6 0 0 1 9.56 18.21H2.6A2.6 2.6 0 0 1 0 15.61V8.65A2.6 2.6 0 0 1 2.6 6.05Z" }
            }
            ShapePath {
                fillColor: "transparent"
                strokeColor: capsule.tint
                strokeWidth: 2.2
                capStyle: ShapePath.RoundCap
                PathSvg { path: "M7.15 3.35V2.68A1.58 1.58 0 0 1 8.73 1.1H17.32A1.58 1.58 0 0 1 18.9 2.68V11.27A1.58 1.58 0 0 1 17.32 12.85H14.86" }
            }
        }

        SequentialAnimation {
            id: blink
            loops: 2
            NumberAnimation {
                target: capsule
                property: "opacity"
                to: 0.2
                duration: Appearance.animation.elementMoveFast.duration
            }
            NumberAnimation {
                target: capsule
                property: "opacity"
                to: 1.0
                duration: Appearance.animation.elementMoveFast.duration
            }
        }
    }

    Connections {
        target: SbarOrbit
        function onAppeared() {
            blink.restart();
        }
    }

    StyledPopup {
        hoverTarget: root

        ColumnLayout {
            anchors.centerIn: parent
            spacing: 8

            StyledPopupHeaderRow {
                icon: "orbit"
                label: SbarOrbit.summary
            }

            Repeater {
                model: SbarOrbit.sessions

                ColumnLayout {
                    id: session
                    required property var modelData
                    readonly property string viewsLabel: session.modelData.views > 0
                        ? `${session.modelData.views} ${session.modelData.backend === "fedora" ? "window" : "tab"}${session.modelData.views === 1 ? "" : "s"}`
                        : ""
                    readonly property string stateLabel: session.modelData.activityState === "working"
                        ? "working" : (session.modelData.state ?? "")
                    spacing: 0

                    StyledText {
                        text: session.modelData.agentName ?? "Agent"
                        font.weight: Font.DemiBold
                        color: Appearance.colors.colOnSurfaceVariant
                    }
                    StyledText {
                        text: session.modelData.taskName ?? ""
                        visible: text !== ""
                        elide: Text.ElideRight
                        Layout.maximumWidth: 320
                        color: Appearance.colors.colOnSurfaceVariant
                    }
                    StyledText {
                        text: [session.modelData.title ?? "", session.viewsLabel, session.stateLabel]
                            .filter(part => part !== "").join("  ·  ")
                        elide: Text.ElideRight
                        Layout.maximumWidth: 320
                        color: Appearance.colors.colSubtext
                    }
                }
            }

            StyledText {
                text: "Click to open the viewer"
                color: Appearance.colors.colSubtext
            }
        }
    }
}
