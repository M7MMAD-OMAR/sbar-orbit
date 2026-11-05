// Opt-in lifetime routing for original Qt QWidget applications.
// Each route retains a QPointer to one actual widget, never a reusable AT-SPI ID.
#include <QtCore/QCoreApplication>
#include <QtCore/QPointer>
#include <QtCore/QTimer>
#include <QtCore/QThread>
#include <QtCore/QUuid>
#include <QtCore/QHash>
#include <QtCore/QRegularExpression>
#include <QtDBus/QDBusConnection>
#include <QtDBus/QDBusMessage>
#include <QtDBus/QDBusVirtualObject>
#include <QtDBus/QDBusArgument>
#include <QtDBus/QDBusReply>
#include <QtDBus/QDBusMetaType>
#include <QtGui/QAccessible>
#include <QtWidgets/QApplication>
#include <QtWidgets/QWidget>
#include <chrono>
#include <cmath>
#include <memory>

namespace {
using Clock = std::chrono::steady_clock;
const QString base = QStringLiteral("/org/sbar/Orbit/QtWidget");
struct Binding { QPointer<QWidget> widget; QPointer<QWidget> root; QString original; QString rootOriginal; Clock::time_point expires; };
class Bridge final : public QDBusVirtualObject {
    QHash<QString, Binding> bindings;
    QDBusConnection bus;
    unsigned pendingActions = 0;
    static QWidget *widgetFor(const QString &path) {
        static const QRegularExpression pattern(QStringLiteral("^/org/a11y/atspi/accessible/([0-9]{1,10})$"));
        const auto match = pattern.match(path);
        bool valid = false;
        const auto id = match.captured(1).toUInt(&valid);
        if (!match.hasMatch() || !valid || id < 0x80000000U) return nullptr;
        auto iface = QAccessible::accessibleInterface(id);
        if (!iface || !iface->isValid()) return nullptr;
        auto widget = qobject_cast<QWidget *>(iface->object());
        // Exclude cells and virtual subelements that share another object's QObject.
        return widget && QAccessible::queryAccessibleInterface(widget) == iface ? widget : nullptr;
    }
    static bool belongs(QWidget *root, QWidget *node) {
        return root && node && root->window() == root && node->window() == root && (root == node || root->isAncestorOf(node));
    }
    void prune() {
        const auto now = Clock::now();
        for (auto it = bindings.begin(); it != bindings.end();) {
            if (it->widget.isNull() || it->root.isNull() || now >= it->expires) it = bindings.erase(it);
            else ++it;
        }
    }
    static bool error(const QDBusMessage &message, const QDBusConnection &connection, const QString &code) {
        connection.send(message.createErrorReply(QStringLiteral("org.sbar.Orbit.") + code, code));
        return true;
    }
public:
    explicit Bridge(const QDBusConnection &connection) : bus(connection) {}
    QString introspect(const QString &) const override { return QString(); }
    bool handleMessage(const QDBusMessage &message, const QDBusConnection &connection) override {
        if (!qApp || QThread::currentThread() != qApp->thread()) return error(message, connection, QStringLiteral("WrongThread"));
        prune();
        const auto args = message.arguments();
        if (message.path() == base && message.interface() == QStringLiteral("org.sbar.Orbit.QtWidget1")) {
            if (message.member() == QStringLiteral("Bind")) {
                if (message.signature() != QStringLiteral("sas") || args.size() != 2) return error(message, connection, QStringLiteral("InvalidRequest"));
                auto root = widgetFor(args[0].toString());
                const auto paths = qdbus_cast<QStringList>(args[1]);
                if (!root || root->window() != root || paths.isEmpty() || paths.size() > 301 || bindings.size() + paths.size() > 2048)
                    return error(message, connection, QStringLiteral("UnsupportedWidget"));
                QMap<QString, QString> routes;
                for (const auto &path : paths) {
                    auto widget = widgetFor(path);
                    if (!belongs(root, widget)) continue;
                    const auto route = base + u'/' + QUuid::createUuid().toString(QUuid::WithoutBraces).remove(u'-');
                    bindings.insert(route, {widget, root, path, args[0].toString(), Clock::now() + std::chrono::seconds(45)});
                    routes.insert(path, route);
                }
                connection.send(message.createReply(QVariant::fromValue(routes)));
                return true;
            }
            if (message.member() == QStringLiteral("Verify")) {
                if (message.signature() != QStringLiteral("a{ss}") || args.size() != 1) return error(message, connection, QStringLiteral("InvalidRequest"));
                const auto routes = qdbus_cast<QMap<QString, QString>>(args[0]);
                if (routes.isEmpty() || routes.size() > 302) return error(message, connection, QStringLiteral("InvalidRequest"));
                bool current = true;
                for (auto route = routes.cbegin(); route != routes.cend(); ++route) {
                    const auto found = bindings.constFind(route.value());
                    if (found == bindings.cend() || found->original != route.key()
                            || widgetFor(found->original) != found->widget || widgetFor(found->rootOriginal) != found->root
                            || !belongs(found->root, found->widget)) { current = false; break; }
                }
                connection.send(message.createReply(current)); return true;
            }
            if (message.member() == QStringLiteral("Release")) {
                if (message.signature() != QStringLiteral("as") || args.size() != 1) return error(message, connection, QStringLiteral("InvalidRequest"));
                const auto paths = qdbus_cast<QStringList>(args[0]);
                if (paths.size() > 301) return error(message, connection, QStringLiteral("InvalidRequest"));
                for (const auto &path : paths) bindings.remove(path);
                connection.send(message.createReply()); return true;
            }
            if (message.member() == QStringLiteral("Version") && args.isEmpty()) {
                connection.send(message.createReply(QVariantList{QStringLiteral("orbit-qt-widget-1"), QString::fromLatin1(qVersion())})); return true;
            }
            return error(message, connection, QStringLiteral("UnsupportedMethod"));
        }
        auto binding = bindings.find(message.path());
        if (binding == bindings.end() || widgetFor(binding->original) != binding->widget
                || widgetFor(binding->rootOriginal) != binding->root) return error(message, connection, QStringLiteral("StaleRef"));
        const auto rootIface = QAccessible::queryAccessibleInterface(binding->root);
        if (!rootIface || !rootIface->isValid() || rootIface->object() != binding->root.data()
                || !belongs(binding->root, binding->widget)) return error(message, connection, QStringLiteral("StaleRef"));
        QPointer<QWidget> held = binding->widget;
        auto iface = QAccessible::queryAccessibleInterface(held);
        if (!iface || !iface->isValid() || iface->object() != held.data()) return error(message, connection, QStringLiteral("StaleRef"));
        if (message.interface() == QStringLiteral("org.a11y.atspi.Accessible") && message.member() == QStringLiteral("GetState") && args.isEmpty()) {
            const auto state = iface->state();
            QList<quint32> words{0, 0};
            auto set = [&](unsigned bit, bool value) { if (value) words[bit / 32] |= quint32(1) << (bit % 32); };
            set(4, state.checked); set(7, iface->editableTextInterface() && !state.readOnly); set(8, !state.disabled);
            set(11, state.focusable); set(12, state.focused); set(24, !state.disabled);
            set(25, !state.invisible && !state.offscreen); set(30, !state.invisible); set(41, state.checkable); set(43, state.readOnly);
            connection.send(message.createReply(QVariant::fromValue(words))); return true;
        }
        if (iface->state().disabled) return error(message, connection, QStringLiteral("UnavailableControl"));
        if (message.interface() == QStringLiteral("org.a11y.atspi.Action") && message.member() == QStringLiteral("DoAction")) {
            if (message.signature() != QStringLiteral("i") || args.size() != 1 || !iface->actionInterface()) return error(message, connection, QStringLiteral("UnsupportedInterface"));
            const auto names = iface->actionInterface()->actionNames(); const auto index = args[0].toInt();
            if (index < 0 || index >= names.size() || index > 31) return error(message, connection, QStringLiteral("InvalidRequest"));
            if (pendingActions >= 64) return error(message, connection, QStringLiteral("ActionQueueFull"));
            const auto action = names[index];
            const auto root = binding->root;
            const auto route = message.path();
            ++pendingActions;
            // A tool button may synchronously open a modal exec() loop. Acknowledge
            // bounded application work, then validate the exact lifetime again at
            // its UI-thread execution point. There is no retry or replacement path.
            QTimer::singleShot(0, this, [this, held, root, action, route] {
                --pendingActions;
                const auto queued = bindings.constFind(route);
                if (!held || !root || queued == bindings.cend() || queued->widget != held || queued->root != root
                        || Clock::now() >= queued->expires || widgetFor(queued->original) != held
                        || widgetFor(queued->rootOriginal) != root) return;
                auto rootIface = QAccessible::queryAccessibleInterface(root);
                auto current = QAccessible::queryAccessibleInterface(held);
                if (!rootIface || !rootIface->isValid() || rootIface->object() != root.data() || !current || !current->isValid()
                        || current->object() != held.data() || !belongs(root, held)) return;
                auto actions = current->actionInterface();
                if (!current->state().disabled && actions && actions->actionNames().contains(action)) actions->doAction(action);
            });
            connection.send(message.createReply(true)); return true;
        }
        if (message.interface() == QStringLiteral("org.a11y.atspi.EditableText") && message.member() == QStringLiteral("SetTextContents")) {
            if (message.signature() != QStringLiteral("s") || args.size() != 1 || !iface->editableTextInterface() || iface->state().readOnly)
                return error(message, connection, QStringLiteral("UnsupportedInterface"));
            const auto text = args[0].toString(); if (text.toUtf8().size() > 16000) return error(message, connection, QStringLiteral("InvalidRequest"));
            const auto textIface = iface->textInterface(); if (!textIface) return error(message, connection, QStringLiteral("UnsupportedInterface"));
            iface->editableTextInterface()->replaceText(0, textIface->characterCount(), text);
            connection.send(message.createReply(true)); return true;
        }
        if (message.interface() == QStringLiteral("org.freedesktop.DBus.Properties") && message.member() == QStringLiteral("Set")) {
            if (message.signature() != QStringLiteral("ssv") || args.size() != 3 || args[0].toString() != QStringLiteral("org.a11y.atspi.Value")
                    || args[1].toString() != QStringLiteral("CurrentValue") || !iface->valueInterface() || iface->state().readOnly) return error(message, connection, QStringLiteral("UnsupportedInterface"));
            const auto value = qvariant_cast<QDBusVariant>(args[2]).variant();
            if (value.metaType().id() != QMetaType::Double || !std::isfinite(value.toDouble())) return error(message, connection, QStringLiteral("InvalidRequest"));
            iface->valueInterface()->setCurrentValue(value);
            connection.send(message.createReply()); return true;
        }
        return error(message, connection, QStringLiteral("UnsupportedMethod"));
    }
};
void initialize() {
    if (!qobject_cast<QApplication *>(qApp) || QByteArray(qVersion()) != QByteArray(QT_VERSION_STR)) return;
    auto session = QDBusConnection::sessionBus();
    auto query = QDBusMessage::createMethodCall(QStringLiteral("org.a11y.Bus"), QStringLiteral("/org/a11y/bus"), QStringLiteral("org.a11y.Bus"), QStringLiteral("GetAddress"));
    QDBusReply<QString> address = session.call(query, QDBus::Block, 500);
    if (!address.isValid() || !address.value().startsWith(QStringLiteral("unix:"))) return;
    auto bus = QDBusConnection::connectToBus(address.value(), QStringLiteral("orbit-qt-widget-lifetime"));
    if (!bus.isConnected()) return;
    qDBusRegisterMetaType<QMap<QString, QString>>();
    auto bridge = new Bridge(bus);
    bridge->setParent(qApp);
    if (!bus.registerVirtualObject(base, bridge, QDBusConnection::SubPath)
            || !bus.registerService(QStringLiteral("org.sbar.Orbit.QtWidget.p") + QString::number(QCoreApplication::applicationPid()))) {
        bridge->deleteLater();
    }
}
void schedule() { QTimer::singleShot(0, qApp, initialize); }
__attribute__((constructor)) void install() { qAddPreRoutine(schedule); }
}
