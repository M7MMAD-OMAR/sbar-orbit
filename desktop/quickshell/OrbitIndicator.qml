import QtQuick
import QtQuick.Layouts
import qs.modules.common
import qs.modules.common.widgets
import qs.services

/**
 * A capsule in the bar that says what Orbit is doing, in the shell's own colours.
 *
 * No number on it: the colour is the whole message, green while an agent is working, the tertiary
 * accent while one is paused, dim while sessions are open but idle. It blinks once when a session or
 * a window appears. Hovering lists the sessions, clicking opens the viewer.
 *
 * It shows nothing at all when no session is open, so a bar with no agents running looks exactly as
 * it did before this was installed.
 */
MouseArea {
    id: root

    readonly property bool shown: SbarOrbit.count > 0
    readonly property color stateColor: SbarOrbit.state === "working" ? Appearance.colors.colPrimary
        : SbarOrbit.state === "paused" ? Appearance.colors.colTertiary
        : Appearance.colors.colOnSurfaceVariant

    implicitWidth: shown ? capsule.implicitWidth + 8 : 0
    implicitHeight: Appearance.sizes.barHeight
    hoverEnabled: true
    visible: shown
    onClicked: SbarOrbit.openViewer()

    Behavior on implicitWidth {
        animation: Appearance.animation.elementMoveFast.numberAnimation.createObject(this)
    }

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
            NumberAnimation { target: capsule; property: "opacity"; to: 0.2; duration: 190 }
            NumberAnimation { target: capsule; property: "opacity"; to: 1.0; duration: 190 }
            loops: 2
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
                    required property var modelData
                    spacing: 0

                    StyledText {
                        text: modelData.agentName ?? "Agent"
                        font.weight: Font.DemiBold
                        color: Appearance.colors.colOnSurfaceVariant
                    }
                    StyledText {
                        text: modelData.taskName ?? ""
                        visible: text !== ""
                        elide: Text.ElideRight
                        Layout.maximumWidth: 320
                        color: Appearance.colors.colOnSurfaceVariant
                    }
                    StyledText {
                        text: [modelData.title ?? "", modelData.views > 0
                                ? `${modelData.views} ${modelData.backend === "fedora" ? "window" : "tab"}${modelData.views === 1 ? "" : "s"}`
                                : "", modelData.activity?.state === "working" ? "working" : modelData.state ?? ""]
                            .filter(part => part !== "").join("  ·  ")
                        elide: Text.ElideRight
                        Layout.maximumWidth: 320
                        opacity: 0.7
                        color: Appearance.colors.colOnSurfaceVariant
                    }
                }
            }

            StyledText {
                text: "Click to open the viewer"
                opacity: 0.7
                color: Appearance.colors.colOnSurfaceVariant
            }
        }
    }
}
