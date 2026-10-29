"""The words the panel's session controls use, in English and Arabic, and the small formatters they need.

No GTK in here, for the same reason as `panel_broker`: the time format and the state vocabulary are the
parts that were wrong most often elsewhere, and a test can only reach them without a display.

Digits are always Western (0 to 9), times are always 12 hour, and nothing here uses guillemets.
"""
import os
from datetime import datetime

STRINGS = {
    "en": {
        "no-sessions": "No agent is working",
        "offline": "Orbit is not running",
        "workspace": "Workspace {n}",
        "no-workspace": "Workspace not recorded",
        "last-activity": "Last activity {time}",
        "pause": "Pause", "resume": "Resume", "stop": "Stop", "remove": "Remove",
        "stop-ask": "Stop this session? Orbit returns control and leaves the application open.",
        "stop-confirm": "Stop session", "cancel": "Cancel",
        "remove-hint": "Remove from the list",
        "pause-hint": "Pause: the agent waits until you resume",
        "resume-hint": "Resume the agent",
        "stop-hint": "Stop: returns control, the application stays open",
        "working": "Working", "idle": "Ready", "paused": "Paused", "pausing": "Pausing",
        "closing": "Closing", "closed": "Closed",
        "details": "Details", "back": "Back", "close": "Close",
        "target": "Current window", "no-target": "No window selected",
        "f-target": "Window", "f-workspace": "Workspace", "f-scope": "Handoff scope",
        "f-clipboard": "Clipboard", "f-activity": "Last activity",
        "err-SESSION_OPEN": "End the session before removing it from the list",
        "scope-entire-wayland-client": "The whole application",
        "clipboard-shared": "Shared with the desktop",
        "recent": "Recent actions", "no-actions": "Nothing recorded yet",
        "allowed": "Allowed", "denied": "Denied", "ok": "Done", "failed": "Failed",
        "copy-report": "Copy report", "copied": "Report copied",
        "copy-failed": "Could not build the report", "copying": "Preparing the report",
        "about": "About", "settings": "Settings",
        "config-hint": "Configure with sbar-orbit config",
        "label-card": "{agent}: {task}, {state}",
        "am": "AM", "pm": "PM",
        "unknown-error": "The request did not go through",
    },
    "ar": {
        "no-sessions": "لا يعمل أي وكيل الآن",
        "offline": "أوربت لا يعمل",
        "workspace": "مساحة العمل {n}",
        "no-workspace": "مساحة العمل غير مسجلة",
        "last-activity": "آخر نشاط {time}",
        "pause": "إيقاف مؤقت", "resume": "استئناف", "stop": "إنهاء", "remove": "إزالة",
        "stop-ask": "إنهاء هذه الجلسة؟ يعيد أوربت التحكم إليك ويترك التطبيق مفتوحا.",
        "stop-confirm": "إنهاء الجلسة", "cancel": "تراجع",
        "remove-hint": "إزالة من القائمة",
        "pause-hint": "إيقاف مؤقت: ينتظر الوكيل حتى تستأنف",
        "resume-hint": "استئناف عمل الوكيل",
        "stop-hint": "إنهاء: يعيد التحكم إليك ويبقى التطبيق مفتوحا",
        "working": "يعمل", "idle": "جاهز", "paused": "متوقف مؤقتا", "pausing": "جار الإيقاف",
        "closing": "جار الإغلاق", "closed": "منتهية",
        "details": "التفاصيل", "back": "رجوع", "close": "إغلاق",
        "target": "النافذة الحالية", "no-target": "لم تحدد نافذة",
        "f-target": "النافذة", "f-workspace": "مساحة العمل", "f-scope": "نطاق التسليم",
        "f-clipboard": "الحافظة", "f-activity": "آخر نشاط",
        "err-SESSION_OPEN": "أنه الجلسة قبل إزالتها من القائمة",
        "scope-entire-wayland-client": "التطبيق كله",
        "clipboard-shared": "مشتركة مع سطح المكتب",
        "recent": "آخر الإجراءات", "no-actions": "لم يسجل شيء بعد",
        "allowed": "مسموح", "denied": "مرفوض", "ok": "تم", "failed": "فشل",
        "copy-report": "نسخ التقرير", "copied": "تم نسخ التقرير",
        "copy-failed": "تعذر إعداد التقرير", "copying": "جار إعداد التقرير",
        "about": "حول", "settings": "الإعدادات",
        "config-hint": "للضبط استخدم sbar-orbit config",
        "label-card": "{agent}: {task}، {state}",
        "am": "ص", "pm": "م",
        "unknown-error": "لم يكتمل الطلب",
    },
}

# A shape as well as a colour, so a state is never carried by colour alone. The colour class is one of
# the four the panel's palette defines. The drawn shapes are distinct in outline: a triangle for work,
# two bars for a pause, a ring for ready, a square for over.
CHIPS = {
    "working": ("▶", "working"),
    "idle": ("○", "idle"),
    "paused": ("❚❚", "paused"),
    "pausing": ("❚❚", "paused"),
    "closing": ("◌", "offline"),
    "closed": ("■", "offline"),
}


def language():
    """Arabic when the desktop is set to it. There is no panel setting for this and the schema is not
    this module's to extend, so the locale decides; ORBIT_PANEL_LANG overrides it for a run."""
    for name in ("ORBIT_PANEL_LANG", "LC_ALL", "LC_MESSAGES", "LANGUAGE", "LANG"):
        value = os.environ.get(name, "")
        if value:
            return "ar" if value.lower().startswith("ar") else "en"
    return "en"


def text(key, lang=None, **fields):
    table = STRINGS.get(lang or language(), STRINGS["en"])
    value = table.get(key) or STRINGS["en"].get(key, key)
    return value.format(**fields) if fields else value


def state_key(session):
    """The one word that names a session's state: what the chip says and what picks its shape."""
    state = session.get("state", "")
    if state in ("closed", "closing", "paused", "pausing"):
        return state
    return "working" if (session.get("activity") or {}).get("state") == "working" else "idle"


def clock(moment, lang=None, now=None):
    """An absolute 12 hour time, formatted by hand: strftime's %p follows the process locale, which GTK
    sets, and would print a different marker, or Arabic-Indic digits, depending on the machine.

    Takes epoch milliseconds or an ISO string. A time on another day carries its date, day first, so
    a card that has sat for a week does not look as if it acted this morning.
    """
    if isinstance(moment, bool) or moment is None:
        return ""
    try:
        if isinstance(moment, (int, float)):
            when = datetime.fromtimestamp(moment / 1000.0)
        else:
            when = datetime.fromisoformat(str(moment).replace("Z", "+00:00")).astimezone()
    except (ValueError, OverflowError, OSError):
        return ""
    hour = when.hour % 12 or 12
    marker = text("pm" if when.hour >= 12 else "am", lang)
    stamp = f"{hour}:{when.minute:02d} {marker}"
    today = (now or datetime.now()).date()
    if when.date() != today:
        stamp = f"{when.day}/{when.month} {stamp}"
    return stamp
