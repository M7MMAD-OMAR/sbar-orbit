// Owned fixture for UUID routing and widget lifetime, never native acceptance.
#include <QtWidgets/QApplication>
#include <QtWidgets/QWidget>
#include <QtWidgets/QVBoxLayout>
#include <QtWidgets/QPushButton>
#include <QtWidgets/QCheckBox>
#include <QtWidgets/QLineEdit>
#include <QtWidgets/QToolButton>
#include <QtWidgets/QDialog>
#include <QtWidgets/QDoubleSpinBox>
#include <QtGui/QAccessible>
#include <QtDBus/QDBusVirtualObject>
#include <QtDBus/QDBusConnection>
#include <QtDBus/QDBusMessage>
#include <QtCore/QTimer>
#include <QtCore/QPointer>
#include <QtCore/QJsonDocument>
#include <QtCore/QJsonObject>
#include <QtCore/QTextStream>

QString path(QObject *object) {
    return QStringLiteral("/org/a11y/atspi/accessible/") + QString::number(QAccessible::uniqueId(QAccessible::queryAccessibleInterface(object)));
}
struct Fixture final : QDBusVirtualObject {
    QWidget root, outsider;
    QDialog childDialog{&root};
    QPushButton dialogButton{QStringLiteral("Other window"), &childDialog};
    QVBoxLayout layout{&root};
    QPushButton *button = new QPushButton(QStringLiteral("Counter"), &root);
    QCheckBox check{QStringLiteral("Check"), &root};
    QLineEdit edit{QStringLiteral("before"), &root};
    QDoubleSpinBox value{&root};
    QToolButton modal{&root};
    QPointer<QDialog> dialog;
    int count = 0;
    Fixture() {
        root.setWindowTitle(QStringLiteral("Orbit owned Qt lifetime fixture"));
        layout.addWidget(button); layout.addWidget(&check); layout.addWidget(&edit);
        value.setRange(-10,10); value.setValue(2.5); layout.addWidget(&value);
        modal.setText(QStringLiteral("Modal")); layout.addWidget(&modal);
        QObject::connect(&modal, &QToolButton::clicked, &root, [this] { QDialog owned(&root); dialog=&owned; owned.exec(); });
        QObject::connect(button, &QPushButton::clicked, &root, [this] { ++count; });
        root.show();
    }
    QString introspect(const QString &) const override { return QString(); }
    bool handleMessage(const QDBusMessage &m, const QDBusConnection &c) override {
        if (m.member() == QStringLiteral("State")) c.send(m.createReply(QVariantList{count,check.isChecked(),edit.text(),value.value()}));
        else if (m.member() == QStringLiteral("ReadOnlyValue")) { value.setReadOnly(true); c.send(m.createReply()); }
        else if (m.member() == QStringLiteral("ModalOpen")) c.send(m.createReply(!dialog.isNull()));
        else if (m.member() == QStringLiteral("CloseModal")) { if (dialog) dialog->reject(); c.send(m.createReply()); }
        else if (m.member() == QStringLiteral("InvalidateInterface")) {
            QAccessible::deleteAccessibleInterface(QAccessible::uniqueId(QAccessible::queryAccessibleInterface(button)));
            c.send(m.createReply(path(button)));
        }
        else if (m.member() == QStringLiteral("Delete")) {
            delete button; button = new QPushButton(QStringLiteral("Counter"), &root); layout.addWidget(button);
            QObject::connect(button, &QPushButton::clicked, &root, [this] { count += 100; });
            c.send(m.createReply(path(button)));
        } else if (m.member() == QStringLiteral("Quit")) { c.send(m.createReply()); QTimer::singleShot(0, qApp, &QCoreApplication::quit); }
        else return false;
        return true;
    }
};
int main(int argc, char **argv) {
    QApplication app(argc,argv);
    Fixture fixture;
    auto session=QDBusConnection::sessionBus();
    session.registerVirtualObject(QStringLiteral("/fixture"), &fixture);
    session.registerService(QStringLiteral("org.sbar.Orbit.QtFixture.p")+QString::number(app.applicationPid()));
    QTimer::singleShot(100, &app, [&] {
        QJsonObject info{{"pid",double(app.applicationPid())},{"root",path(&fixture.root)},{"button",path(fixture.button)},
                         {"value",path(&fixture.value)},{"modal",path(&fixture.modal)},{"check",path(&fixture.check)},{"edit",path(&fixture.edit)},{"outsider",path(&fixture.outsider)},{"dialogButton",path(&fixture.dialogButton)}};
        QTextStream(stdout) << QJsonDocument(info).toJson(QJsonDocument::Compact) << Qt::endl;
    });
    return app.exec();
}
