"""Every setting Orbit has, described once.

The panel used to hold its defaults, its ranges and its validation inline, and the settings window
repeated the names in its own labels. That was fine while the only way to change a setting was to click
it. It stops being fine the moment a second reader exists: a command line that accepts a value the panel
then silently clamps, or a search that cannot find a setting because the word the person typed appears
nowhere near its label.

So the schema is the single source, and it feeds three consumers: `panel.py` for validation and its
rows, `sbar-orbit config` for reading and writing from a terminal, and the search box in the settings
window. A setting added here appears in all three, and one added anywhere else appears in none.

Every entry carries search terms, in English and in Arabic, because the person this was built for
writes Arabic and a settings search that only answers the label is a settings search that answers the
question you already knew how to ask. The labels stay English, as all shipped text in this project is.

Imported by `panel.py` under /usr/bin/python3, and run directly by `sbar-orbit config`, which needs no
GTK and therefore works over ssh and inside a service.
"""
import json
import os
import sys

EDGE_NAMES = ("left", "right", "top", "bottom")
STYLES = ("mark", "bar", "dot", "count")
STATE_KEYS = ("idle", "working", "paused", "offline")
SETTINGS_PATH = os.path.join(os.environ.get("XDG_CONFIG_HOME") or os.path.expanduser("~/.config"), "sbar-orbit", "panel.json")

GROUPS = ("Startup", "Placement", "The mark", "The viewer", "Working glow", "Motion and blending", "Notifications")

# What each group is called in the other language the person searching uses. Carried on every setting in
# the group, so a word that names the whole group finds all of it rather than the one row that happens to
# repeat the group's name in its own terms.
GROUP_TERMS = {
    "Startup": "بدء تشغيل إقلاع",
    "Placement": "مكان موضع تموضع",
    "The mark": "العلامة الشعار المؤشر",
    "The viewer": "العارض المشاهدة نافذة تطبيق متصفح",
    "Working glow": "توهج إضاءة أثناء العمل",
    "Motion and blending": "حركة مزج شفافية",
    "Notifications": "إشعارات تنبيهات",
}


def setting(key, group, label, default, kind, description, terms, choices=None, bounds=None, stored=True):
    """One setting. `stored` is false for the ones that are not ours to store: whether Orbit starts with
    the desktop is systemd's answer and an autostart entry's, and keeping a copy of it here would be a
    second opinion about a thing that already has one."""
    return {"key": key, "group": group, "label": label, "default": default, "kind": kind,
            "description": description, "terms": tuple(terms), "choices": choices, "bounds": bounds,
            "stored": stored}


# The Arabic of every word this file owns, keyed by the English it translates. It lives here rather
# than in the page that draws the rows, because a description edited here and translated there goes
# quietly back to English the moment the two stop matching character for character, and nothing fails.
# The search terms above are already carried in both languages for the same reason.
ARABIC = {
    "Startup": "بدء التشغيل",
    "Placement": "الموضع",
    "The mark": "العلامة",
    "The viewer": "نافذة المتابعة",
    "Working glow": "توهج العمل",
    "Motion and blending": "الحركة والمزج",
    "Notifications": "الإشعارات",
    "Start Orbit with my desktop": "ابدأ أوربت مع سطح المكتب",
    "Whether the broker and the mark come back on their own. Installed by default; this is systemd and an autostart entry rather than a value in the settings file.": "هل يعود الوسيط والعلامة وحدهما بعد إعادة التشغيل. مفعل عند التثبيت، وهو قيد في systemd ومدخل بدء تلقائي، لا قيمة في ملف الإعدادات.",
    "Screen edge": "حافة الشاشة",
    "Which edge of the screen the mark is docked to.": "الحافة التي ترسو عليها العلامة.",
    "Monitor": "الشاشة",
    "Which monitor it appears on. Unset means whichever the compositor calls first.": "الشاشة التي تظهر عليها العلامة. تركها فارغة يعني أول شاشة يسميها مدير النوافذ.",
    "Distance from the edge": "المسافة عن الحافة",
    "Pixels between the mark and the edge of the screen.": "عدد البكسلات بين العلامة وحافة الشاشة.",
    "Place along the edge": "الموضع على طول الحافة",
    "Where along its edge the mark sits, from the start of the edge to the end. Dragging the mark sets this.": "أين تجلس العلامة على حافتها، من أولها إلى آخرها. سحب العلامة بيدك يضبط هذه القيمة.",
    "Shape": "الشكل",
    "What the mark looks like: the logo, a plain capsule, a dot, or a dot carrying a count.": "شكل العلامة: الشعار، أو كبسولة بسيطة، أو نقطة، أو نقطة تحمل عددا.",
    "Size": "الحجم",
    "How large the mark is, in pixels.": "حجم العلامة بالبكسل.",
    "Hide it while nothing runs": "أخفها ما لم يكن هناك عمل",
    "Show the mark only while a session exists, instead of always.": "أظهر العلامة فقط عند وجود جلسة، بدل إظهارها دائما.",
    "State colours": "ألوان الحالات",
    "One colour per state: idle, working, paused, and Orbit not running. Working is Orbit's blue, the same colour as the screen edge glow and the agent pointer, so one colour means an agent is acting wherever it appears.": "لون لكل حالة: ساكن، يعمل، متوقف مؤقتا، وأوربت غير مشغل. لون العمل هو أزرق أوربت نفسه الذي يضيء حواف الشاشة ويرسم مؤشر الوكيل، فلون واحد يعني أن وكيلا يتصرف أينما ظهر.",
    "Open the viewer in": "افتح نافذة المتابعة في",
    "Which installed browser the viewer opens in. Unset picks the desktop's own browser when it can open a window of its own, and otherwise the first installed browser that can.": "أي متصفح مثبت تفتح فيه نافذة المتابعة. تركه تلقائيا يختار متصفح سطح المكتب إن كان يفتح نافذة مستقلة، وإلا أول متصفح مثبت يستطيع ذلك.",
    "Open it as its own window": "افتحها كنافذة مستقلة",
    "A window with no tab strip and no address bar, the way an installed web application opens. Browsers in the Firefox family have no such mode and open a tab whatever this says.": "نافذة بلا شريط تبويبات ولا شريط عنوان، كما يفتح تطبيق ويب مثبت. متصفحات عائلة فايرفوكس لا تملك هذا الوضع وتفتح تبويبا مهما كان هذا الإعداد.",
    "Glow the screen edges while working": "أضئ حواف الشاشة أثناء العمل",
    "A soft glow inside the edges of the screen while an agent is working, with no border and nothing to click through.": "توهج خفيف داخل حواف الشاشة أثناء عمل الوكيل، بلا إطار ولا شيء يعترض النقر.",
    "Breathe while working": "تنفس أثناء العمل",
    "The glow rises and falls while work is in flight. Separable from the glow itself, because motion is the part that costs.": "يعلو التوهج ويخفت ما دام هناك عمل جار. منفصل عن التوهج نفسه لأن الحركة هي الجزء المكلف.",
    "Glow colour": "لون التوهج",
    "Orbit's blue by default, the colour the agent pointer is drawn in. The word accent follows the desktop theme instead, light and dark, and any colour here overrides both.": "أزرق أوربت افتراضيا، وهو لون مؤشر الوكيل. كلمة accent تتبع لون سطح المكتب في الوضعين الفاتح والداكن، وأي لون تختاره هنا يتقدم عليهما.",
    "Liquid motion": "حركة سائلة",
    "The card is pulled out of the capsule rather than appearing. Turning it off removes the animation, not the card.": "تسحب البطاقة من الكبسولة بدل أن تظهر فجأة. إيقافها يزيل الحركة لا البطاقة.",
    "How solid the card is": "مدى صلابة البطاقة",
    "How much of the wallpaper shows through the glass, from mostly transparent to solid. It sets the "
    "capsule around the mark; the card below it stays solid enough for its rows to be read over a "
    "window full of text, whatever this says.":
    "كم تظهر خلفية سطح المكتب عبر الزجاج، من شبه شفاف إلى صلب. يضبط الكبسولة حول العلامة، أما البطاقة "
    "تحتها فتبقى صلبة بما يكفي لقراءة سطورها فوق نافذة مليئة بالنص مهما كانت هذه القيمة.",
    "Desktop notifications": "إشعارات سطح المكتب",
    "A notification through the person's own daemon when a session or an application appears.": "إشعار عبر خدمة الإشعارات في جهازك عند ظهور جلسة أو تطبيق.",
    "Blink when something happens": "اومض عند حدوث شيء",
    "The mark blinks once when a session or an application appears.": "تومض العلامة مرة واحدة عند ظهور جلسة أو تطبيق.",
}


SCHEMA = (
    setting("autostart", "Startup", "Start Orbit with my desktop", True, "switch",
            "Whether the broker and the mark come back on their own. Installed by default; this is systemd and an autostart entry rather than a value in the settings file.",
            ["autostart", "auto start", "startup", "boot", "login", "start", "service", "systemd", "enable", "launch",
             "بدء", "تشغيل", "تلقائي", "إقلاع", "دخول", "خدمة", "عند التشغيل"],
            stored=False),
    setting("edge", "Placement", "Screen edge", "right", "choice",
            "Which edge of the screen the mark is docked to.",
            ["edge", "side", "left", "right", "top", "bottom", "place", "position", "move",
             "حافة", "جهة", "يمين", "يسار", "فوق", "تحت", "مكان", "موضع"],
            choices=EDGE_NAMES),
    setting("monitor", "Placement", "Monitor", None, "monitor",
            "Which monitor it appears on. Unset means whichever the compositor calls first.",
            ["monitor", "screen", "display", "output", "external", "second",
             "شاشة", "شاشات", "خارجية", "عرض"]),
    setting("margin", "Placement", "Distance from the edge", 0, "number",
            "Pixels between the mark and the edge of the screen.",
            ["margin", "gap", "distance", "offset", "spacing", "inset",
             "مسافة", "هامش", "فراغ", "بعد"],
            bounds=(0, 64)),
    setting("position", "Placement", "Place along the edge", 0.5, "fraction",
            "Where along its edge the mark sits, from the start of the edge to the end. Dragging the mark sets this.",
            ["position", "along", "slide", "centre", "center", "corner", "drag", "higher", "lower",
             "موضع", "طول", "وسط", "زاوية", "سحب", "أعلى", "أسفل"],
            bounds=(0.0, 1.0)),
    setting("style", "The mark", "Shape", "mark", "choice",
            "What the mark looks like: the logo, a plain capsule, a dot, or a dot carrying a count.",
            ["style", "shape", "look", "logo", "capsule", "dot", "count", "icon", "design",
             "شكل", "تصميم", "شعار", "نقطة", "كبسولة", "عدد", "أيقونة"],
            choices=STYLES),
    setting("size", "The mark", "Size", 8, "number",
            "How large the mark is, in pixels.",
            ["size", "big", "small", "thick", "thin", "scale", "width",
             "حجم", "كبير", "صغير", "سماكة", "عرض"],
            bounds=(6, 40)),
    setting("hideWhenIdle", "The mark", "Hide it while nothing runs", False, "switch",
            "Show the mark only while a session exists, instead of always.",
            ["hide", "idle", "invisible", "auto hide", "show", "empty", "nothing",
             "إخفاء", "خفي", "ظهور", "خمول", "فارغ"]),
    setting("colors", "The mark", "State colours",
            {"idle": "#8a8a8a", "working": "#255fce", "paused": "#ff9800", "offline": "#585858"}, "colors",
            "One colour per state: idle, working, paused, and Orbit not running. Working is Orbit's blue, the same colour as the screen edge glow and the agent pointer, so one colour means an agent is acting wherever it appears.",
            ["colour", "color", "blue", "green", "amber", "grey", "gray", "state", "working", "paused", "idle", "offline", "palette",
             "لون", "ألوان", "أزرق", "أخضر", "برتقالي", "رمادي", "حالة", "يعمل", "متوقف"]),
    setting("viewerBrowser", "The viewer", "Open the viewer in", "", "browser",
            "Which installed browser the viewer opens in. Unset picks the desktop's own browser when it can open a window of its own, and otherwise the first installed browser that can.",
            ["browser", "viewer", "open", "chrome", "chromium", "edge", "firefox", "zen", "default", "which",
             "متصفح", "العارض", "فتح", "افتراضي", "كروم", "حافة", "أي متصفح"]),
    setting("viewerAppWindow", "The viewer", "Open it as its own window", True, "switch",
            "A window with no tab strip and no address bar, the way an installed web application opens. Browsers in the Firefox family have no such mode and open a tab whatever this says.",
            ["app", "pwa", "window", "tab", "standalone", "chromeless", "application", "kiosk",
             "تطبيق", "نافذة", "تبويب", "مستقل", "بي دبليو ايه"]),
    setting("frame", "Working glow", "Glow the screen edges while working", True, "switch",
            "A soft glow inside the edges of the screen while an agent is working, with no border and nothing to click through.",
            ["glow", "frame", "edge", "border", "halo", "light", "working", "signal", "aura",
             "توهج", "إضاءة", "إطار", "حواف", "هالة", "أثناء العمل"]),
    setting("framePulse", "Working glow", "Breathe while working", True, "switch",
            "The glow rises and falls while work is in flight. Separable from the glow itself, because motion is the part that costs.",
            ["pulse", "breathe", "animate", "animation", "blink", "motion", "throb", "fade",
             "نبض", "تنفس", "حركة", "وميض", "تلاشي"]),
    setting("frameColor", "Working glow", "Glow colour", "#255fce", "accent_color",
            "Orbit's blue by default, the colour the agent pointer is drawn in. The word accent follows the desktop theme instead, light and dark, and any colour here overrides both.",
            ["accent", "theme", "colour", "color", "blue", "glow", "match", "desktop", "matugen",
             "لون", "أزرق", "تمييز", "ثيم", "سمة", "توهج", "سطح المكتب"],
            # The word this colour also accepts, said here rather than known only by `coerce`: a reader
            # that draws the control cannot offer a value the schema never mentions.
            choices=("accent",)),
    setting("motion", "Motion and blending", "Liquid motion", True, "switch",
            "The card is pulled out of the capsule rather than appearing. Turning it off removes the animation, not the card.",
            ["motion", "animation", "liquid", "morph", "smooth", "still", "performance", "cost",
             "حركة", "سائل", "انتقال", "سلاسة", "أداء", "تكلفة"]),
    setting("blend", "Motion and blending", "How solid the card is", 80, "number",
            "How much of the wallpaper shows through the glass, from mostly transparent to solid. It sets the "
            "capsule around the mark; the card below it stays solid enough for its rows to be read over a "
            "window full of text, whatever this says.",
            ["blend", "opacity", "transparent", "translucent", "glass", "solid", "alpha", "blur",
             "شفافية", "زجاج", "معتم", "صلب", "مزج"],
            bounds=(30, 100)),
    setting("notifications", "Notifications", "Desktop notifications", True, "switch",
            "A notification through the person's own daemon when a session or an application appears.",
            ["notification", "notify", "toast", "popup", "alert", "message", "desktop",
             "إشعار", "إشعارات", "تنبيه", "رسالة"]),
    setting("blink", "Notifications", "Blink when something happens", True, "switch",
            "The mark blinks once when a session or an application appears.",
            ["blink", "flash", "attention", "appear", "new session", "signal",
             "وميض", "لمعة", "تنبيه", "جلسة جديدة"]),
)

BY_KEY = {entry["key"]: entry for entry in SCHEMA}
STORED = tuple(entry for entry in SCHEMA if entry["stored"])
DEFAULT_SETTINGS = {entry["key"]: (dict(entry["default"]) if isinstance(entry["default"], dict) else entry["default"]) for entry in STORED}
NUMBER_KEYS = {entry["key"]: entry["bounds"] for entry in STORED if entry["kind"] in ("number", "fraction")}
EDGES_FALLBACK = "right"


def defaults():
    return {k: (dict(v) if isinstance(v, dict) else v) for k, v in DEFAULT_SETTINGS.items()}


def matches(entry, query):
    """Does this setting answer that word? Label, group, description and both term lists, case folded.

    Substring rather than prefix, because a person looking for the glow types "glow" and the label says
    "Glow the screen edges while working", while another types "توهج" and no label says anything at all.
    """
    needle = query.strip().casefold()
    if not needle:
        return True
    haystack = " ".join([entry["key"], entry["label"], entry["group"], GROUP_TERMS.get(entry["group"], ""),
                         entry["description"], *entry["terms"]]).casefold()
    return all(word in haystack for word in needle.split())


def search(query):
    return [entry for entry in SCHEMA if matches(entry, query)]


def coerce(key, value):
    """One value, validated the way the panel would validate it.

    Returns (value, note). A note means the value was not usable as given and says what happened, so a
    caller can print it rather than a person discovering it from the panel looking wrong.
    """
    entry = BY_KEY.get(key)
    if entry is None:
        return None, f"There is no setting called {key}."
    kind = entry["kind"]
    if kind == "switch":
        if isinstance(value, bool):
            return value, None
        text = str(value).strip().casefold()
        if text in ("true", "on", "yes", "1"):
            return True, None
        if text in ("false", "off", "no", "0"):
            return False, None
        return None, f"{key} is on or off, not {value!r}."
    if kind == "choice":
        text = str(value).strip().casefold()
        if text not in entry["choices"]:
            return None, f"{key} is one of {', '.join(entry['choices'])}, not {value!r}."
        return text, None
    if kind in ("number", "fraction"):
        low, high = entry["bounds"]
        try:
            number = float(value)
        except (TypeError, ValueError):
            return None, f"{key} is a number between {low} and {high}, not {value!r}."
        clamped = min(high, max(low, number))
        note = None if clamped == number else f"{key} was clamped to {clamped}, its range is {low} to {high}."
        return (clamped if kind == "fraction" else int(round(clamped))), note
    if kind == "browser":
        # A desktop entry id, or empty for the automatic choice. It is not checked against the installed
        # list here: this module runs without a broker, and a browser that is missing today may be back
        # tomorrow, so resolution happens where the viewer is actually opened.
        text = str(value).strip()
        return ("" if text.casefold() in ("", "none", "auto", "default") else text), None
    if kind == "monitor":
        text = str(value).strip()
        if text.casefold() in ("", "none", "auto", "null"):
            return None, None
        return (int(text) if text.isdigit() else text), None
    if kind == "accent_color":
        text = str(value).strip()
        if text.casefold() == "accent":
            return "accent", None
        if not is_hex(text):
            return None, f"{key} is a #rrggbb colour or the word accent, not {value!r}."
        return text, None
    if kind == "colors":
        if not isinstance(value, dict):
            return None, f"{key} is a set of state colours, so set one at a time as colors.working."
        cleaned = dict(DEFAULT_SETTINGS["colors"])
        cleaned.update({k: v for k, v in value.items() if k in STATE_KEYS and isinstance(v, str) and is_hex(v)})
        return cleaned, None
    return value, None


def is_hex(text):
    return isinstance(text, str) and len(text) == 7 and text.startswith("#") and all(c in "0123456789abcdefABCDEF" for c in text[1:])


def validate(stored):
    """A whole settings dict, from whatever a file happened to contain. Never raises: an unusable value
    falls back to its default, because the alternative is a panel that will not draw."""
    settings = defaults()
    if not isinstance(stored, dict):
        return settings
    for key in DEFAULT_SETTINGS:
        if key not in stored:
            continue
        value, note = coerce(key, stored[key])
        settings[key] = DEFAULT_SETTINGS[key] if note and value is None else value
        if isinstance(DEFAULT_SETTINGS[key], dict) and not isinstance(settings[key], dict):
            settings[key] = dict(DEFAULT_SETTINGS[key])
    return settings


def load(path=None):
    """The person's choices, or the defaults, and a note when the file could not be read at all."""
    target = path or SETTINGS_PATH
    try:
        with open(target, encoding="utf-8") as handle:
            return validate(json.load(handle)), None
    except FileNotFoundError:
        return defaults(), None
    except (OSError, ValueError) as error:
        # Say so rather than silently reverting every choice the person made.
        return defaults(), f"could not read {target} ({error}); using defaults and leaving the file alone"


def save(settings, path=None):
    """Written beside the real file and renamed over it. A truncating write that is interrupted leaves an
    empty file, which reads back as no settings at all."""
    target = path or SETTINGS_PATH
    try:
        os.makedirs(os.path.dirname(target), mode=0o700, exist_ok=True)
        temporary = target + ".new"
        with open(temporary, "w", encoding="utf-8") as handle:
            json.dump({k: settings[k] for k in DEFAULT_SETTINGS}, handle, indent=2)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temporary, 0o600)
        os.replace(temporary, target)
        return None
    except OSError as error:
        return f"could not save settings: {error}"


def launcher_path():
    return os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "bin", "sbar-orbit")


def autostart(*args):
    """Ask the launcher, which owns the units and the desktop entries. None when it could not answer."""
    import subprocess
    try:
        finished = subprocess.run([launcher_path(), "autostart", *args], capture_output=True, text=True, timeout=60)
        return json.loads(finished.stdout)
    except (OSError, ValueError, subprocess.SubprocessError):
        return None


def autostart_value():
    state = autostart("status")
    if state is None:
        return None
    return bool(state.get("startsWithTheDesktop"))


def wording(entry):
    """What a setting is called, in both languages. A reader that draws these picks one; a reader that
    prints them at a terminal uses the English and never sees the rest."""
    return {"key": entry["key"], "group": entry["group"], "label": entry["label"], "description": entry["description"],
            "arabic": {field: ARABIC[entry[field]] for field in ("group", "label", "description") if entry[field] in ARABIC}}


def describe(entry, settings):
    if not entry["stored"]:
        return {**wording(entry), "kind": entry["kind"], "value": autostart_value(), "default": entry["default"],
                "terms": list(entry["terms"]) + [GROUP_TERMS.get(entry["group"], "")],
                "storedIn": "systemd and an autostart entry, not the settings file"}
    value = settings.get(entry["key"], entry["default"])
    # The kind travels with the setting. A reader that draws a control has to know whether a string is
    # a colour, a browser or a monitor, and guessing that from the value is how a colour picker ends up
    # on a browser name.
    described = {**wording(entry), "kind": entry["kind"], "value": value, "default": entry["default"],
                 # The search terms travel too, so a settings box in the viewer answers the same Arabic
                 # word `sbar-orbit config search` answers rather than only the label it can see.
                 "terms": list(entry["terms"]) + [GROUP_TERMS.get(entry["group"], "")]}
    if entry["choices"]:
        described["choices"] = list(entry["choices"])
    if entry["bounds"]:
        described["range"] = list(entry["bounds"])
    return described


USAGE = """Usage: sbar-orbit config [COMMAND]

  list                    Every setting, its value and its default
  search WORDS            The settings a word matches, in English or Arabic
  get KEY                 One value
  set KEY VALUE           Change one, live: the panel reloads it
  reset [KEY]             Back to the default, one setting or all of them
  path                    Where the settings file is

A nested colour is addressed as colors.working."""


def main(argv):
    command = argv[0] if argv else "list"
    settings, note = load()
    if note:
        print(f"config: {note}", file=sys.stderr)
    if command in ("help", "--help", "-h"):
        print(USAGE)
        return 0
    if command == "path":
        print(SETTINGS_PATH)
        return 0
    if command == "list":
        print(json.dumps([describe(entry, settings) for entry in SCHEMA], indent=2, ensure_ascii=False))
        return 0
    if command == "search":
        found = search(" ".join(argv[1:]))
        if not found:
            print(json.dumps({"query": " ".join(argv[1:]), "found": 0, "settings": []}, ensure_ascii=False))
            return 1
        print(json.dumps([describe(entry, settings) for entry in found], indent=2, ensure_ascii=False))
        return 0
    if command == "get":
        if len(argv) < 2:
            print(USAGE, file=sys.stderr)
            return 1
        key, _, leaf = argv[1].partition(".")
        if key in BY_KEY and not BY_KEY[key]["stored"]:
            print(json.dumps(autostart_value()))
            return 0
        if key not in BY_KEY:
            print(f"config: there is no setting called {argv[1]}", file=sys.stderr)
            return 1
        value = settings[key]
        print(json.dumps(value.get(leaf) if leaf and isinstance(value, dict) else value, ensure_ascii=False))
        return 0
    if command in ("set", "reset"):
        if command == "set" and len(argv) < 3:
            print(USAGE, file=sys.stderr)
            return 1
        if command == "reset" and len(argv) < 2:
            settings = defaults()
        else:
            key, _, leaf = argv[1].partition(".")
            if key not in BY_KEY:
                print(f"config: there is no setting called {argv[1]}", file=sys.stderr)
                return 1
            if not BY_KEY[key]["stored"]:
                wanted, note = coerce(key, DEFAULT_SETTINGS.get(key, True) if command == "reset" else argv[2])
                if note and wanted is None:
                    print(f"config: {note}", file=sys.stderr)
                    return 1
                changed = autostart("enable" if wanted else "disable")
                if changed is None:
                    print("config: could not reach the launcher to change autostart", file=sys.stderr)
                    return 1
                print(json.dumps(changed.get("status", changed), indent=2, ensure_ascii=False))
                return 0
            if leaf:
                if key != "colors" or leaf not in STATE_KEYS:
                    print(f"config: {argv[1]} is not a setting; the nested ones are colors.{', colors.'.join(STATE_KEYS)}", file=sys.stderr)
                    return 1
                wanted = DEFAULT_SETTINGS["colors"][leaf] if command == "reset" else argv[2]
                if not is_hex(wanted):
                    print(f"config: colors.{leaf} is a #rrggbb colour, not {wanted!r}", file=sys.stderr)
                    return 1
                settings["colors"] = {**settings["colors"], leaf: wanted}
            else:
                value, note = coerce(key, DEFAULT_SETTINGS[key] if command == "reset" else argv[2])
                if note and value is None:
                    print(f"config: {note}", file=sys.stderr)
                    return 1
                if note:
                    print(f"config: {note}", file=sys.stderr)
                settings[key] = value
        failure = save(settings)
        if failure:
            print(f"config: {failure}", file=sys.stderr)
            return 1
        # The running panel is watching the file, so this has already taken effect on screen.
        print(json.dumps({"saved": SETTINGS_PATH, "settings": {k: settings[k] for k in DEFAULT_SETTINGS}}, indent=2, ensure_ascii=False))
        return 0
    print(USAGE, file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
