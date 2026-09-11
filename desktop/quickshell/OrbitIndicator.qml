import QtQuick
import QtQuick.Layouts
import qs.modules.common
import qs.modules.common.widgets
import qs.services

/**
 * A capsule in the bar that says what Orbit is doing, in the shell's own colours.
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

    Rectangle {
        id: capsule
        anchors.centerIn: parent
        // Lying along the bar's own direction, so it reads as a mark rather than a stray dot.
        implicitWidth: Config.options.bar.vertical ? 14 : 4
        implicitHeight: Config.options.bar.vertical ? 4 : 14
        radius: Appearance.rounding.full
        color: root.stateColor

        Behavior on color {
            animation: Appearance.animation.elementMoveFast.colorAnimation.createObject(this)
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
