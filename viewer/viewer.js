const element = id => document.getElementById(id);
const token = location.hash.slice(1);
const pointer = element('agent-pointer');
let agentName = 'SbarOrbit', actor = 'agent';
let previewMode = 'balanced', captureQueued = false, pollFailures = 0;
let lastCost = 0, lastGap = 0, lastRpc = 0, lastDecode = 0, lastDraw = 0;
/*
 * Language. Every string a person reads is written here in English and looked up in the table below,
 * the same way the website carries its Arabic. Which one a person gets is the browser's own answer:
 * English unless the reader has asked for Arabic, and the switch in the rail overrides that and is
 * remembered per browser. Nothing an agent or a test keys off moves: ids, `data-state`, `data-working`
 * and the session states themselves stay in English.
 */
const arabic = {
  'Watch what your assistants are doing. Your own screen stays yours.': 'تابع ما يفعله مساعدوك. شاشتك تبقى لك وحدك.',
  'Assistants': 'المساعدون',
  'Assistants · {n}': 'المساعدون · {n}',
  'All': 'الكل',
  'Show': 'اعرض',
  'Nothing here is {filter}': 'لا شيء هنا ضمن: {filter}',
  'No sessions yet. Create one from your agent or the CLI.': 'لا توجد جلسات بعد. ابدأ واحدة من وكيلك أو من سطر الأوامر.',
  'Connecting': 'جارٍ الاتصال',
  'Connected': 'متصل',
  'Lost the connection, trying again': 'انقطع الاتصال، تجري إعادة المحاولة',
  'This link is incomplete': 'هذا الرابط ناقص',
  'Open the complete preview link printed by Orbit.': 'افتح رابط المتابعة الكامل الذي طبعه أوربت.',
  'Open the complete preview link printed by Orbit, including its access token.': 'افتح رابط المتابعة الكامل الذي طبعه أوربت، مع رمز الوصول الذي فيه.',
  'Viewer connection failed.': 'تعذر الاتصال بنافذة المتابعة.',
  'Match my desktop colours': 'استخدم ألوان سطح مكتبي',
  'Using my desktop colours': 'ألوان سطح المكتب مفعلة',
  'Hide sidebar': 'إخفاء القائمة الجانبية',
  'Show sidebar': 'إظهار القائمة الجانبية',
  'Toggle sidebar': 'إظهار القائمة الجانبية أو إخفاؤها',
  'Project not provided': 'لا يوجد مشروع محدد',
  'Agent workspace': 'مساحة عمل الوكيل',
  'Nothing selected yet': 'لم تختر جلسة بعد',
  'Open': 'مفتوحة',
  'You are in control': 'التحكم بيدك',
  'Finishing': 'جارٍ الإنهاء',
  'Finished': 'انتهت',
  'Working': 'يعمل الآن',
  'Unknown': 'غير معروفة',
  'Take over': 'تولَّ التحكم',
  'Hand back': 'أعد التحكم',
  'Refresh the picture': 'تحديث الصورة',
  'Focus view': 'ملء الشاشة للصورة',
  'Exit focus': 'إنهاء وضع التركيز',
  'Fullscreen': 'شاشة كاملة',
  'Enter fullscreen': 'دخول الشاشة الكاملة',
  'Exit fullscreen': 'خروج من الشاشة الكاملة',
  'Fullscreen is unavailable here. Use Focus view to enlarge the picture.': 'الشاشة الكاملة غير متاحة هنا. استخدم وضع التركيز لتكبير الصورة.',
  'Waiting for a page or application': 'بانتظار صفحة أو تطبيق',
  'Waiting to see what it is looking at': 'بانتظار رؤية ما ينظر إليه',
  'Untitled page or application': 'صفحة أو تطبيق بلا عنوان',
  'Nothing here yet. Ask one of your assistants to start a session.': 'لا شيء هنا بعد. اطلب من أحد مساعديك أن يبدأ جلسة.',
  'This session has finished.': 'انتهت هذه الجلسة.',
  'Waiting for the first picture': 'بانتظار أول صورة',
  'Picture is up to date': 'الصورة محدثة',
  'Picture is {n} seconds old': 'عمر الصورة {n} ثانية',
  'Nothing has happened yet': 'لم يحدث شيء بعد',
  '{who} is {verb} {outcome} · step {n}': '{who} · {verb} {outcome} · الخطوة {n}',
  'You were {verb} {outcome} · step {n}': 'أنت · {verb} {outcome} · الخطوة {n}',
  'switching pages': 'الانتقال بين الصفحات',
  'opening a tab': 'فتح تبويب',
  'managing a window': 'إدارة نافذة',
  'resizing the workspace': 'تغيير قياس مساحة العمل',
  'opening a page': 'فتح صفحة',
  'filling in a box': 'تعبئة حقل',
  'clicking': 'النقر',
  'reading the page': 'قراءة الصفحة',
  'scrolling': 'التمرير',
  'typing': 'الكتابة',
  'pasting': 'اللصق',
  'pressing a key': 'الضغط على مفتاح',
  'opening an application': 'فتح تطبيق',
  'doing something': 'تنفيذ إجراء',
  'right now': 'الآن',
  'just now': 'قبل قليل',
  'and it did not work': 'ولم ينجح',
  'Take over to switch pages': 'تولَّ التحكم لتبديل الصفحات',
  'Take over first to change this': 'تولَّ التحكم أولا لتغيير هذا',
  'Typing for your assistant': 'الكتابة نيابة عن مساعدك',
  'Text to send': 'النص المرسل',
  'Key to send': 'المفتاح المرسل',
  'What should go in the box': 'ما الذي يكتب في الحقل',
  'Send text': 'أرسل النص',
  'Paste text': 'ألصق النص',
  'Press it': 'اضغطه',
  'Choose Take over first. Then click the picture above to pick a box, and type here.': 'تولَّ التحكم أولا، ثم انقر على الصورة أعلاه لاختيار حقل، واكتب هنا.',
  'Choose Take over first. Then click or scroll on the picture above, and type here. Wait for each step to finish before the next one.': 'تولَّ التحكم أولا، ثم انقر أو مرر على الصورة أعلاه، واكتب هنا. انتظر انتهاء كل خطوة قبل التالية.',
  'Staying signed in': 'إبقاء تسجيل الدخول',
  'This session signs in as {name}. Take over, then save it so the next session starts already signed in.': 'هذه الجلسة مسجلة الدخول باسم {name}. تولَّ التحكم ثم احفظها لتبدأ الجلسة التالية وهي مسجلة الدخول.',
  'Remember this sign in': 'احفظ تسجيل الدخول',
  ' Account state saved.': ' تم حفظ حالة الحساب.',
  // Named for what it holds, now that the desktop's settings are a view of their own: what this
  // sheet carries is about the session on screen and about this viewer, not about Orbit.
  'Session tools': 'أدوات الجلسة',
  'Updates': 'تحديث الصورة',
  'Every second': 'كل ثانية',
  'Only when I ask': 'عند الطلب فقط',
  'As smooth as possible': 'أسلس ما يمكن',
  'Screen size': 'قياس الشاشة',
  'Fill the screen': 'املأ الشاشة',
  'Back to normal': 'عد إلى الوضع الطبيعي',
  "Focus view and fullscreen enlarge your view. Screen size changes the agent's workspace and requires taking over first.": 'وضع التركيز والشاشة الكاملة يكبران العرض عندك فقط. أما قياس الشاشة فيغير مساحة عمل الوكيل، ويحتاج أن تتولى التحكم أولا.',
  'Report a problem': 'أبلغ عن مشكلة',
  'Orbit prepares the technical details for you. No page content, typed text or screenshots are included. GitHub reports are public and require a GitHub account.': 'يجهز أوربت التفاصيل التقنية نيابة عنك. لا يضم التقرير محتوى الصفحات ولا النصوص المكتوبة ولا الصور. تقارير GitHub علنية وتحتاج حسابا هناك.',
  'Prepare problem report': 'جهز تقرير المشكلة',
  'Reports stay on this device until you choose to share them.': 'تبقى التقارير على جهازك حتى تختار مشاركتها.',
  'Preparing your report...': 'جارٍ تجهيز التقرير...',
  'Report ready: {n} recorded errors.': 'التقرير جاهز: {n} أخطاء مسجلة.',
  'Some diagnostic records could not be saved or read.': 'تعذر حفظ بعض سجلات التشخيص أو قراءتها.',
  'Recent tool history is included.': 'يتضمن التقرير سجل الأدوات الأخير.',
  'Orbit is unavailable. Run sbar-orbit diagnostics to recover the saved report without the service.': 'أوربت غير متاح. نفذ sbar-orbit diagnostics لاستخراج التقرير المحفوظ دون الخدمة.',
  'Continue to GitHub': 'تابع إلى GitHub',
  'Download report': 'نزّل التقرير',
  'Review the prepared issue, then choose Submit new issue on GitHub. Opening GitHub shares the diagnostic summary with GitHub.': 'راجع البلاغ المجهز ثم اختر إرساله على GitHub. فتح GitHub يشارك ملخص التشخيص معه.',
  'Technical details': 'تفاصيل تقنية',
  'Viewer cycle: {cost} ms of every {total} ms ({share}%) · request {rpc} ms · decode {decode} ms · draw {draw} ms': 'دورة العرض: {cost} ms من كل {total} ms ({share}%) · الطلب {rpc} ms · فك الترميز {decode} ms · الرسم {draw} ms',
  'Session actions': 'إجراءات الجلسة',
  'End this workspace when the work is done.': 'أنهِ مساحة العمل عند انتهاء المهمة.',
  'End session': 'أنهِ الجلسة',
  'Remove this finished session from the list': 'احذف هذه الجلسة المنتهية من القائمة',
  'Remove': 'احذف',
  'Last activity {when}': 'آخر نشاط {when}',
  'Sessions': 'الجلسات',
  'Open sessions': 'الجلسات المفتوحة',
  'Session tabs': 'تبويبات الجلسة',
  'Live image of the selected Orbit session': 'صورة حية للجلسة المختارة في أوربت',
  'Today': 'اليوم',
  'Yesterday': 'أمس',
};
/*
 * Which language the page opens in. The browser is asked first: English unless one of the languages
 * the reader has asked for is Arabic. A choice made with the switch outranks that, and is remembered
 * per browser; a browser that tells us nothing, or storage that is blocked, leaves English.
 */
let language = 'en';
try {
  const asked = navigator.languages?.length ? navigator.languages : [navigator.language];
  if (asked.some(tag => String(tag).toLowerCase().startsWith('ar'))) language = 'ar';
} catch { language = 'en'; }
try { const chosen = localStorage.getItem('orbit-language'); if (chosen === 'ar' || chosen === 'en') language = chosen; } catch { /* not remembered */ }
/** One string, in the reader's language, with `{name}` placeholders filled from `values`. */
function t(source, values) {
  const line = language === 'ar' ? arabic[source] ?? source : source;
  return values ? line.replace(/\{(\w+)\}/g, (whole, name) => (name in values ? String(values[name]) : whole)) : line;
}
/*
 * Dates a person reads rather than a duration that ticks. A relative time would have to be recomputed
 * every second, and the rail is rebuilt from a signature of what its cards say, so a ticking string
 * there would rebuild every card once a second for no new information. Latin digits in both languages
 * and a 12 hour clock, which is how this workstation writes times.
 */
let formatters;
function when(stamp) {
  if (!stamp) return '';
  try {
    // Built once per language rather than once per card per poll: a formatter is expensive to make
    // and this runs for every session on every tick, only to compare the string it produces.
    if (formatters?.language !== language) {
      const locale = language === 'ar' ? 'ar-u-nu-latn' : 'en-GB';
      formatters = { language,
        clock: new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit', hour12: true }),
        day: new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short' }) };
    }
    const date = new Date(stamp), now = new Date();
    const clock = formatters.clock.format(date);
    const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    if (stamp >= midnight) return `${t('Today')} ${clock}`;
    if (stamp >= midnight - 86400000) return `${t('Yesterday')} ${clock}`;
    return `${formatters.day.format(date)} ${clock}`;
  } catch { return ''; }
}
const languageButton = element('language');
function applyLanguage() {
  const root = document.documentElement;
  root?.setAttribute?.('lang', language);
  root?.setAttribute?.('dir', language === 'ar' ? 'rtl' : 'ltr');
  // The switch names the language it moves to, in that language, so it reads the same to somebody
  // who cannot read the one the page is currently in.
  languageButton.textContent = language === 'ar' ? 'English' : 'العربية';
  languageButton.setAttribute('lang', language === 'ar' ? 'en' : 'ar');
  languageButton.setAttribute('dir', language === 'ar' ? 'ltr' : 'rtl');
  languageButton.setAttribute('aria-label', language === 'ar' ? 'Switch to English' : 'التحويل إلى العربية');
  if (typeof document.querySelectorAll !== 'function') return;
  for (const node of document.querySelectorAll('[data-i18n]')) node.textContent = t(node.dataset.i18n);
  for (const node of document.querySelectorAll('[data-i18n-title]')) node.setAttribute('title', t(node.dataset.i18nTitle));
  for (const node of document.querySelectorAll('[data-i18n-label]')) node.setAttribute('aria-label', t(node.dataset.i18nLabel));
  for (const node of document.querySelectorAll('[data-i18n-placeholder]')) node.setAttribute('placeholder', t(node.dataset.i18nPlaceholder));
}
/**
 * How a module loaded after this one adds its own words. It assigns and then repaints the static
 * markup, because a table extended after the first pass leaves whatever it translates in English and
 * nothing says so.
 */
function registerStrings(table) { Object.assign(arabic, table); applyLanguage(); }
/**
 * A button that asks once. The second press inside four seconds does the thing; the first only says
 * what it is about to do, in the button itself, which is the only place a person is already looking.
 */
function confirmOnce(button, action) {
  const resting = button.textContent;
  button.onclick = () => {
    if (button.dataset.confirm === 'true') { button.dataset.confirm = ''; button.textContent = resting; action(); return; }
    button.dataset.confirm = 'true';
    button.textContent = `${resting}?`;
    setTimeout(() => { if (button.dataset.confirm === 'true') { button.dataset.confirm = ''; button.textContent = resting; } }, 4000);
  };
}
element('preview-mode').addEventListener('change', () => { previewMode = element('preview-mode').value; captureQueued = false; });
element('refresh-frame').onclick = () => { captureQueued = true; };
const frame = element('frame'), sessions = element('sessions'), tabStrip = element('tabs'), shell = element('shell');
/*
 * Orbit's own palette is what the stylesheet falls back to, and the desktop's generated one is applied
 * only under this attribute, so following the desktop is a switch rather than the default. The choice is
 * remembered per browser; storage that is unavailable or blocked leaves Orbit's palette in place.
 */
const paletteButton = element('palette');
let desktopPalette = false;
try { desktopPalette = localStorage.getItem('orbit-palette') === 'desktop'; } catch { desktopPalette = false; }
function applyPalette() {
  document.documentElement?.setAttribute?.('data-palette', desktopPalette ? 'desktop' : 'orbit');
  paletteButton.setAttribute('aria-pressed', String(desktopPalette));
  paletteButton.textContent = t(desktopPalette ? 'Using my desktop colours' : 'Match my desktop colours');
}
/*
 * Bigger: the rail, the panels and the heading go away and the picture takes the
 * window. It changes nothing about the session, so unlike the screen size below
 * it needs no pause; it is the answer to "let me see it properly" that does not
 * move a single coordinate out from under the assistant.
 */
const biggerButton = element('expand');
let bigger = false;
languageButton.onclick = () => {
  language = language === 'ar' ? 'en' : 'ar';
  try { localStorage.setItem('orbit-language', language); } catch { /* not remembered */ }
  applyLanguage();
  // Everything the poll writes is rewritten on its own next tick; these are the two whose text is
  // state dependent, so the language pass cannot know which of the two words to paint, plus the rail,
  // whose signature would otherwise hold the old language.
  applyPalette();
  biggerButton.textContent = t(bigger ? 'Exit focus' : 'Focus view');
  redrawRail();
  controls();
};
paletteButton.onclick = () => {
  desktopPalette = !desktopPalette;
  try { localStorage.setItem('orbit-palette', desktopPalette ? 'desktop' : 'orbit'); } catch { /* not remembered */ }
  applyPalette();
};
applyPalette();
applyLanguage();
// Sizes an agent or a person can pick. The broker caps the total pixel count, because every frame
// at the chosen size is captured, encoded and decoded again on each poll.
const surfaces = [[1280, 800], [1440, 900], [1600, 1000], [1920, 1080], [1920, 1200]];
let tabs = [], surfaceValue = '1280x800', listed = [], railSignature = '';
let selected = '', state = '', backend = '', accountName = '', capturedAt = 0, imageWidth = 1280, imageHeight = 800, busy = false;
function error(message) { element('error').textContent = message; element('error').hidden = !message; }
async function rpc(method, params = {}) {
  const response = await fetch('/rpc', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ method, params }), signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error(response.status === 403 ? t('Open the complete preview link printed by Orbit, including its access token.') : t('Viewer connection failed.'));
  const result = await response.json();
  if (!result.ok) throw new Error(result.error.message);
  return result.result;
}
/*
 * What each state is called on screen. The state itself stays on `data-state`,
 * which is what anything reading the page for the state should use: the words
 * here are for a person, and a person should not have to learn that an assistant
 * is "running" or that they themselves are a "pause".
 */
const WORDS = { running: 'Open', paused: 'You are in control', closing: 'Finishing', closed: 'Finished' };
/* A session with nothing in flight is open, not working, and saying "Working" over an assistant that is
   sitting still is the kind of small lie that teaches a person to stop believing the screen. */
const words = (state, working) => working ? t('Working') : WORDS[state] ? t(WORDS[state]) : state || t('Unknown');
function controls() {
  element('state').textContent = state ? words(state, element('state').dataset.working === 'true') : t('Nothing selected yet');
  element('state').dataset.state = state;
  shell.dataset.state = state;
  const live = !!selected && !['closed', 'closing'].includes(state);
  element('pause').disabled = !live || busy || state !== 'running';
  element('resume').disabled = !live || busy || state !== 'paused';
  element('stop').disabled = !live || busy;
  for (const id of ['text', 'send', 'key', 'press']) element(id).disabled = !live || busy || state !== 'paused';
  // Typing for the assistant is only possible while you hold the controls, so the panel is there only
  // then. A disabled row of boxes that is always on screen is one more thing to read past.
  element('manual').hidden = state !== 'paused';
  if (backend === 'fedora') { element('key').disabled = true; element('press').disabled = true; }
  element('send').textContent = t(backend === 'fedora' ? 'Paste text' : 'Send text');
  element('text').maxLength = backend === 'fedora' ? 2048 : 16384;
  element('input-hint').textContent = t(backend === 'fedora'
    ? 'Choose Take over first. Then click or scroll on the picture above, and type here. Wait for each step to finish before the next one.'
    : 'Choose Take over first. Then click the picture above to pick a box, and type here.');
  element('account-controls').hidden = !accountName;
  element('account-label').textContent = accountName ? t('This session signs in as {name}. Take over, then save it so the next session starts already signed in.', { name: accountName }) : '';
  element('save-account').disabled = !accountName || !live || busy || state !== 'paused';
  const adjustable = live && !busy && state === 'paused';
  element('surface').disabled = !adjustable;
  // A greyed control with no reason beside it teaches nobody anything. Changing the screen size moves
  // every coordinate the assistant just read, which is why it waits for you to take over first.
  element('size-note').textContent = !live ? '' : adjustable ? '' : t('Take over first to change this');
  for (const id of ['fullscreen', 'restore']) { element(id).hidden = backend !== 'fedora'; element(id).disabled = !adjustable; }
  for (const button of tabStrip.children || []) button.disabled = !adjustable;
  element('tab-hint').textContent = tabs.length > 1 && live && !adjustable ? t('Take over to switch pages') : '';
  frame.classList.toggle('controllable', adjustable);
}
/**
 * The rail: one card per session, which is the whole of navigation here. The strip of conversation
 * tabs that used to sit above the picture is gone: it listed the same sessions a second time, in a
 * second shape, and a person reading two lists of the same thing learns to trust neither.
 *
 * Newest first, by whatever happened last in the session, so the one an agent touched a moment ago is
 * at the top and the ones that finished this morning sink below it. The order is made here and not in
 * `session.list`, which several other readers share and which returns sessions in the order they were
 * created.
 *
 * Rebuilt only when a card's own text changes, because this runs inside the poll and the viewer's cost
 * is the thing it is measured on. That is also why the card carries an absolute time rather than a
 * duration: a string that ticks would put every card through a rebuild once a second.
 */
function renderSessions(list) {
  listed = list;
  // The rendered time, not the stamp behind it. A stamp moves on every action, and a rail rebuilt on
  // every action takes the hover, the focus ring and a half finished removal off the card under the
  // person's hand. The printed minute is what a card actually says, so it is what is compared.
  const line = entry => JSON.stringify([entry.sessionId, entry.state, entry.agentName, entry.taskName, entry.conversationName, entry.projectName, entry.activity?.state, when(recency(entry)), entry.sessionId === selected]);
  const signature = [language, filter, ...list.map(line)].join('|');
  setText('session-count', list.length ? t('Assistants · {n}', { n: list.length }) : t('Assistants'));
  if (signature === railSignature) return;
  railSignature = signature;
  renderFilters(list);
  const shown = filtered(list);
  if (list.length && !shown.length) {
    const note = document.createElement('p');
    note.className = 'rail-note';
    note.textContent = t('Nothing here is {filter}', { filter: t(FILTERS.find(one => one.id === filter)?.label ?? 'All') });
    sessions.replaceChildren(note);
    return;
  }
  if (!list.length) {
    const note = document.createElement('p');
    note.className = 'rail-note'; note.textContent = t('No sessions yet. Create one from your agent or the CLI.');
    sessions.replaceChildren(note);
    return;
  }
  sessions.replaceChildren(...shown.map(entry => {
    const card = document.createElement('div');
    card.className = 'session';
    card.dataset.state = entry.state || '';
    card.dataset.working = String(entry.activity?.state === 'working' && entry.state === 'running');
    const open = document.createElement('button');
    open.type = 'button'; open.className = 'session-open';
    // A plain button, announced as a button. `aria-current` says which session is on the stage without
    // promising the arrow key navigation a listbox role would, which the select this replaced gave for
    // free and this does not.
    if (entry.sessionId === selected) { open.setAttribute('aria-current', 'true'); card.setAttribute('aria-current', 'true'); }
    const top = document.createElement('span'); top.className = 'session-top';
    const light = document.createElement('span'); light.className = 'dot';
    const who = document.createElement('span'); who.className = 'session-agent';
    who.textContent = entry.conversationName || entry.taskName || t('Agent workspace');
    top.append(light, who);
    const task = document.createElement('span'); task.className = 'session-task';
    task.textContent = entry.projectName || t('Project not provided');
    const meta = document.createElement('span'); meta.className = 'session-meta';
    // The short identifier earns its place only when two cards would otherwise read the same. It was
    // there to tell duplicates apart, and on every other card it is four characters of noise.
    const twin = list.filter(other => (other.agentName || '') === (entry.agentName || '')
      && (other.taskName || '') === (entry.taskName || '')).length > 1;
    const busyHere = entry.activity?.state === 'working' && entry.state === 'running';
    meta.textContent = `${entry.agentName || 'SbarOrbit'}${twin ? ` · ${String(entry.sessionId).slice(0, 4)}` : ''}`;
    // The state, on its own, rather than buried in a line of dot separated words. A person scanning
    // the rail is asking which of these is working, and that question should be answered by a shape.
    const foot = document.createElement('span'); foot.className = 'session-foot';
    const state = document.createElement('span'); state.className = 'session-state';
    state.textContent = words(entry.state, busyHere);
    const stamp = document.createElement('span'); stamp.className = 'session-when';
    const moment = when(recency(entry));
    stamp.textContent = moment ? t('Last activity {when}', { when: moment }) : '';
    foot.append(state, stamp);
    open.append(top, task, meta, foot);
    open.onclick = () => selectSession(entry.sessionId);
    card.append(open);
    /*
     * A finished session can still be removed from the list, and nothing else. It asks once, in place,
     * because the click is small and the card is already quiet; the second click removes the entry from
     * the broker and leaves the session's journal where it is, since that record is what a run is
     * reviewed from afterwards.
     */
    if (entry.state === 'closed') {
      const forget = document.createElement('button');
      forget.type = 'button'; forget.className = 'session-forget';
      forget.setAttribute('aria-label', t('Remove this finished session from the list'));
      forget.title = t('Remove this finished session from the list');
      forget.textContent = '\u2715';
      forget.onclick = () => {
        if (card.dataset.confirm === 'true') { forgetSession(entry.sessionId); return; }
        card.dataset.confirm = 'true';
        forget.textContent = t('Remove');
        setTimeout(() => { card.dataset.confirm = ''; forget.textContent = '\u2715'; }, 4000);
      };
      card.append(forget);
    }
    return card;
  }));
}
/*
 * Which sessions the rail shows. Four answers rather than a search box: a person running several
 * agents asks which of them is working and which is still open, and those are states the session
 * already reports. The choice is remembered per browser, because it is a way of working rather than
 * something to set up again every morning.
 */
const FILTERS = [
  { id: 'all', label: 'All', keep: () => true },
  { id: 'working', label: 'Working', keep: entry => entry.activity?.state === 'working' && entry.state === 'running' },
  { id: 'open', label: 'Open', keep: entry => !['closed', 'closing'].includes(entry.state) },
  { id: 'finished', label: 'Finished', keep: entry => entry.state === 'closed' },
];
let filter = 'all';
try { if (FILTERS.some(one => one.id === localStorage.getItem('orbit-filter'))) filter = localStorage.getItem('orbit-filter'); } catch { filter = 'all'; }
const filtered = list => list.filter(FILTERS.find(one => one.id === filter)?.keep ?? (() => true));
function renderFilters(list) {
  const row = element('session-filters');
  row.hidden = list.length < 2;
  row.replaceChildren(...FILTERS.map(one => {
    const count = list.filter(one.keep).length;
    const chip = document.createElement('button');
    chip.type = 'button'; chip.className = 'filter';
    chip.dataset.filter = one.id;
    chip.setAttribute('aria-pressed', String(filter === one.id));
    // The count is beside the word, so an answer with nothing behind it is visible before it is asked.
    chip.textContent = count ? `${t(one.label)} ${count}` : t(one.label);
    chip.disabled = !count && one.id !== 'all' && filter !== one.id;
    chip.onclick = () => {
      filter = one.id;
      try { localStorage.setItem('orbit-filter', filter); } catch { /* not remembered */ }
      redrawRail();
    };
    return chip;
  }));
}
/** Repaint the rail from what it already has: the signature is what stops it, so it goes first. */
function redrawRail() { railSignature = ''; renderSessions(listed); }
/** How recently anything happened in a session, which is the order the rail is read in. */
const recency = entry => Math.max(entry.lastActivityAt || 0, entry.createdAt || 0);
async function forgetSession(id) {
  try {
    await rpc('session.forget', { sessionId: id });
    // The next list answers without it, and `refreshSessions` already reselects when the session that
    // was on the stage is no longer in the list.
    railSignature = '';
    await refreshSessions();
  } catch (e) { error(e.message); }
}
/** One entry per browser tab or per window of the private display, numbered the way observe reports them. */
function renderTabs(list) {
  const same = list.length === tabs.length && list.every((entry, index) => entry.tab === tabs[index].tab && entry.label === tabs[index].label && entry.active === tabs[index].active);
  tabs = list;
  tabStrip.hidden = list.length < 2;
  if (same) return;
  tabStrip.replaceChildren(...list.map(entry => {
    const button = document.createElement('button');
    button.type = 'button'; button.className = 'tab'; button.textContent = entry.label || `Tab ${entry.tab}`;
    button.title = entry.label || `Tab ${entry.tab}`;
    button.setAttribute('role', 'tab'); button.setAttribute('aria-selected', String(!!entry.active));
    button.onclick = () => command('session.control', { input: backend === 'fedora'
      ? { type: 'window', command: 'focus', tab: entry.tab } : { type: 'select-tab', tab: entry.tab } });
    return button;
  }));
  controls();
}
async function refreshSessions() {
  // Newest first. `sort` is stable, so sessions the broker has no timestamp for keep the order it
  // gave them rather than shuffling between polls.
  const list = [...await rpc('session.list')].sort((a, b) => recency(b) - recency(a));
  const previous = selected;
  if (!list.some(s => s.sessionId === selected)) selected = list.find(s => s.state !== 'closed')?.sessionId || list[0]?.sessionId || '';
  renderSessions(list);
  if (previous !== selected) { element('account-result').textContent = ''; capturedAt = 0; frame.hidden = true; pointer.hidden = true; element('page-title').textContent = t('Waiting to see what it is looking at'); element('page-location').textContent = '';  }
  const current = list.find(s => s.sessionId === selected);
  agentName = current?.agentName || 'SbarOrbit';
  actor = current?.activity?.actor || 'agent';
  element('agent-name').textContent = agentName;
  element('task-name').textContent = current?.conversationName || current?.taskName || t('Agent workspace');
  element('project-name').textContent = current?.projectName || t('Project not provided');
  document.title = current ? `${current.conversationName || current.taskName || t('Agent workspace')}${current.projectName ? ` · ${current.projectName}` : ''} | Orbit` : 'Orbit workspace';
  const activity = current?.activity;
  const verbs = { 'select-tab': 'switching pages', 'open-tab': 'opening a tab', window: 'managing a window', resize: 'resizing the workspace', navigate: 'opening a page', fill: 'filling in a box', click: 'clicking', read: 'reading the page', scroll: 'scrolling', pointer: 'clicking', text: 'typing', paste: 'pasting', key: 'pressing a key', launch: 'opening an application' };
  const outcome = { working: 'right now', done: 'just now', failed: 'and it did not work' };
  // Whole sentence, not words glued together: Arabic puts the doer, the deed and the moment in an
  // order English does not, and a sentence assembled from fragments reads as a machine wrote it.
  const parts = activity ? { who: agentName, verb: t(verbs[activity.type] || 'doing something'),
    outcome: outcome[activity.state] ? t(outcome[activity.state]) : activity.state, n: activity.sequence } : undefined;
  element('activity').textContent = parts
    ? t(activity.actor === 'human' ? 'You were {verb} {outcome} · step {n}' : '{who} is {verb} {outcome} · step {n}', parts)
    : t('Nothing has happened yet');
  // The same moment the card carries, for the session a person is actually looking at.
  const moment = current ? when(recency(current)) : '';
  element('last-activity').textContent = moment ? t('Last activity {when}', { when: moment }) : '';
  // What makes the stage glow. An action in flight is the only honest signal the viewer has for "the
  // agent is doing something right now"; a running session with nothing in flight is merely open.
  const working = String(activity?.state === 'working' && current?.state === 'running');
  shell.dataset.working = working;
  element('state').dataset.working = working;
  element('agent-badge').dataset.working = working;
  // controls() reads this back for the chip's word, so it is set before that call, not after.
  state = current?.state || '';
  backend = list.find(s => s.sessionId === selected)?.backend || '';
  const size = current?.surface;
  if (size) {
    const value = `${size.width}x${size.height}`;
    if (value !== surfaceValue || !(element('surface').options || []).length) {
      surfaceValue = value;
      const choices = surfaces.some(([w, h]) => `${w}x${h}` === value) ? surfaces : [...surfaces, [size.width, size.height]];
      element('surface').replaceChildren(...choices.map(([w, h]) => {
        const option = document.createElement('option');
        option.value = `${w}x${h}`; option.textContent = `${w} × ${h}`; return option;
      }));
      element('surface').value = value;
    }
  }
  accountName = list.find(s => s.sessionId === selected)?.accountName || '';
  element('empty').hidden = !!selected && !frame.hidden;
  if (state === 'closed') { capturedAt = 0; frame.hidden = true; pointer.hidden = true; element('page-title').textContent = t('Waiting to see what it is looking at'); element('page-location').textContent = '';  element('empty').hidden = false; element('empty').textContent = t('This session has finished.'); element('empty').dataset.reason = 'closed'; }
  else element('empty').dataset.reason = selected ? 'waiting' : 'none';
  controls();
}
function selectSession(id) {
  if (id === selected) return;
  selected = id; state = ''; capturedAt = 0; frame.hidden = true; pointer.hidden = true;
  renderTabs([]); captureQueued = true;
  const current = listed.find(entry => entry.sessionId === id);
  element('task-name').textContent = current?.conversationName || current?.taskName || t('Agent workspace');
  element('project-name').textContent = current?.projectName || t('Project not provided');
  element('page-title').textContent = t('Waiting to see what it is looking at');
  element('page-location').textContent = '';
  controls(); renderSessions(listed);
}
async function command(method, params = {}) {
  if (busy || !selected) return;
  busy = true; controls(); error('');
  try { await rpc(method, { sessionId: selected, ...params }); if (method === 'session.account.save') element('account-result').textContent = t(' Account state saved.'); await refreshSessions(); }
  catch (e) { error(e.message); }
  finally { busy = false; controls(); }
}
element('surface').addEventListener('change', () => {
  const [width, height] = element('surface').value.split('x').map(Number);
  if (width && height) command('session.control', { input: { type: 'resize', width, height } });
});
element('fullscreen').onclick = () => command('session.control', { input: { type: 'window', command: 'fullscreen' } });
element('restore').onclick = () => command('session.control', { input: { type: 'window', command: 'restore' } });
element('save-account').onclick = () => command('session.account.save');
for (const name of ['pause', 'resume', 'stop']) element(name).onclick = () => command(`session.${name}`);
element('send').onclick = () => command('session.control', { input: { type: backend === 'fedora' ? 'paste' : 'text', text: element('text').value } });
element('press').onclick = () => command('session.control', { input: { type: 'key', key: element('key').value } });
frame.onclick = event => {
  if (state !== 'paused' || busy) return;
  const rect = frame.getBoundingClientRect();
  command('session.control', { input: { type: 'click', x: Math.min(imageWidth - 1, Math.max(0, (event.clientX - rect.left) / rect.width * imageWidth)), y: Math.min(imageHeight - 1, Math.max(0, (event.clientY - rect.top) / rect.height * imageHeight)) } });
};
frame.addEventListener('wheel', event => {
  if (!['fedora', 'browser'].includes(backend) || state !== 'paused' || frame.hidden || !capturedAt) return;
  if (!Number.isFinite(event.deltaY) || event.deltaY === 0) return;
  event.preventDefault();
  // Keep manual input serial, without replaying queued gestures after resume.
  if (busy) return;
  const rect = frame.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const unit = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 3 : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? 0.2 : 100;
  const steps = Math.sign(event.deltaY) * Math.min(20, Math.max(1, Math.round(Math.abs(event.deltaY) / unit)));
  command('session.control', { input: { type: 'scroll',
    x: Math.min(imageWidth - 1, Math.max(0, Math.round((event.clientX - rect.left) / rect.width * imageWidth))),
    y: Math.min(imageHeight - 1, Math.max(0, Math.round((event.clientY - rect.top) / rect.height * imageHeight))),
    deltaY: steps } });
}, { passive: false });
async function poll() {
  const started = performance.now();
  try {
    if (document.hidden) { setTimeout(poll, 1000); return; }
    await refreshSessions();
    element('connection').textContent = t('Connected');
    element('connection').dataset.connected = 'true';
    const id = selected;
    // No picture while the settings are on screen: nothing is showing it, and a frame a second is the
    // most expensive thing this page does.
    if (!document.hidden && id && shell.dataset.view !== 'settings' && !['closed', 'closing'].includes(state) && (previewMode !== 'manual' || captureQueued)) {
      captureQueued = false;
      const requested = performance.now();
      const image = await rpc('session.observe', { sessionId: id });
      lastRpc = performance.now() - requested;
      if (!document.hidden && selected === id && !['closed', 'closing'].includes(state)) {
        const decodeStarted = performance.now();
        // The engine's own base64 decoder where it exists, rather than a JavaScript callback per byte of
        // every frame. A data URL through fetch would do the same, and the page's connect-src forbids it.
        const bytes = typeof Uint8Array.fromBase64 === 'function' ? Uint8Array.fromBase64(image.image) : Uint8Array.from(atob(image.image), character => character.charCodeAt(0));
        const bitmap = await createImageBitmap(new Blob([bytes], { type: image.mimeType }));
        lastDecode = performance.now() - decodeStarted;
        try {
          if (!document.hidden && selected === id && !['closed', 'closing'].includes(state)) {
            if (frame.width !== image.width || frame.height !== image.height) {
              frame.width = image.width; frame.height = image.height;
            }
            const drawStarted = performance.now();
            frame.getContext('2d').drawImage(bitmap, 0, 0);
            lastDraw = performance.now() - drawStarted;
            capturedAt = image.capturedAt; imageWidth = image.width; imageHeight = image.height;
            // Read by the bigger view, which sizes the picture from the height of the window. It is set
            // as a width so the canvas and the box the pointer is placed in stay the same rectangle.
            element('stage').style.setProperty?.('--shot-width', String(image.width));
            element('stage').style.setProperty?.('--shot-height', String(image.height));
            frame.dataset.capturedAt = String(capturedAt);
            frame.hidden = false; element('empty').hidden = true;
            const presence = image.presence;
            element('page-title').textContent = presence?.title || t('Untitled page or application');
            // The size used to be repeated here; it is on the Screen size control, which is also where a
            // person can do something about it.
            element('page-location').textContent = `${presence?.location || ''}${presence?.pageCount > 1 ? ` · tab ${presence.pageIndex || 1} of ${presence.pageCount}` : ''}`;
            renderTabs(Array.isArray(presence?.tabs) ? presence.tabs : []);
            const position = presence?.pointer;
            pointer.hidden = !position;
            if (position) {
              pointer.classList.toggle('stale', false);
              pointer.style.left = `${position.x / imageWidth * 100}%`;
              pointer.style.top = `${position.y / imageHeight * 100}%`;
              pointer.classList.toggle('human', actor === 'human');
              pointer.classList.toggle('near-right', position.x > imageWidth * 0.75);
              element('pointer-label').textContent = actor === 'human' ? 'You' : agentName;
            }
          }
        } finally { bitmap.close(); }
      }
    }
  pollFailures = 0;
  } catch (e) { pollFailures++; element('connection').textContent = t('Lost the connection, trying again'); element('connection').dataset.connected = 'false'; error(e.message); }
  const cadence = pollFailures ? Math.min(10000, 1000 * 2 ** Math.min(pollFailures - 1, 4)) : previewMode === 'smooth' ? 200 : 1000;
  // Idle at least as long as the iteration cost, so a viewer that cannot keep up
  // drops its frame rate instead of polling back to back and taking a whole core.
  lastCost = Math.max(0, performance.now() - started);
  lastGap = Math.max(cadence - lastCost, lastCost, 50);
  setTimeout(poll, lastGap);
}
// Text is assigned only when it changes: at four ticks a second, rewriting an unchanged node still
// invalidates it, and the readout is looked at far less often than it is ticked.
const setText = (id, text) => { const node = element(id); if (node.textContent !== text) node.textContent = text; };
setInterval(() => {
  if (document.hidden) return;
  const age = capturedAt ? Date.now() - capturedAt : Infinity;
  const share = lastCost + lastGap > 0 ? Math.round(lastCost / (lastCost + lastGap) * 100) : 0;
  setText('freshness', capturedAt
    ? age < 1500 ? t('Picture is up to date') : t('Picture is {n} seconds old', { n: Math.round(age / 1000) })
    : t('Waiting for the first picture'));
  setText('cost', lastCost
    ? t('Viewer cycle: {cost} ms of every {total} ms ({share}%) · request {rpc} ms · decode {decode} ms · draw {draw} ms',
      { cost: Math.round(lastCost), total: Math.round(lastCost + lastGap), share, rpc: Math.round(lastRpc), decode: Math.round(lastDecode), draw: Math.round(lastDraw) })
    : '');
  const staleAfter = previewMode === 'smooth' ? 1000 : 2000;
  element('freshness').classList.toggle('stale', age > staleAfter);
  // A pointer over a stale frame is dimmed rather than removed. Hiding it meant that at the default one
  // frame a second it spent most of its life invisible, so the marker that says where the agent is
  // working was the one thing on the page you could not rely on seeing.
  pointer.classList.toggle('stale', age > staleAfter);
}, 250);
if (!token) { element('connection').textContent = t('This link is incomplete'); element('connection').dataset.connected = 'false'; error(t('Open the complete preview link printed by Orbit.')); }
else poll();

// Keep layout in the existing asset so a running broker can serve it without interrupting sessions.
if (typeof window !== "undefined") {
(() => {
  const toggle = document.getElementById('sidebar-toggle');
  const mobile = matchMedia('(max-width: 900px)');
  let collapsed = mobile.matches;
  try { collapsed = mobile.matches || localStorage.getItem('orbit-sidebar') === 'collapsed'; } catch {}
  function sidebar() {
    shell.classList.toggle('sidebar-collapsed', collapsed);
    toggle.setAttribute('aria-expanded', String(!collapsed));
    toggle.setAttribute('aria-label', t(collapsed ? 'Show sidebar' : 'Hide sidebar'));
  }
  toggle.onclick = () => {
    collapsed = !collapsed;
    try { localStorage.setItem('orbit-sidebar', collapsed ? 'collapsed' : 'open'); } catch {}
    sidebar();
  };
  mobile.addEventListener('change', () => { collapsed = mobile.matches; sidebar(); });
  sidebar();
  // See the note beside `.shell.animated`: the first state is arrived at, not animated into.
  requestAnimationFrame(() => requestAnimationFrame(() => shell.classList.add('animated')));
  let sizing = false;
  function fitScreen() {
    if (sizing) return;
    sizing = true;
    requestAnimationFrame(() => {
      sizing = false;
      const stage = document.getElementById('stage');
      const caption = document.querySelector('.caption');
      const panels = document.querySelector('.panels');
      const footer = bigger ? 0 : Math.min(56, panels.getBoundingClientRect().height);
      const top = stage.getBoundingClientRect().top + scrollY;
      const available = Math.max(180, innerHeight - top - caption.getBoundingClientRect().height - footer - 56);
      stage.style.setProperty('--available-height', `${available}px`);
    });
  }
  const sizingObserver = new ResizeObserver(fitScreen);
  for (const target of [document.querySelector('.head'), document.querySelector('.stage-bar'), document.querySelector('.tab-row'), document.querySelector('.panels')]) sizingObserver.observe(target);
  // The language switch changes how tall the panels are, and the stage is measured from what is left.
  languageButton.addEventListener('click', fitScreen);
  window.addEventListener('resize', fitScreen);
  fitScreen();
  function focusView(enabled) {
    bigger = enabled;
    shell.classList.toggle('bigger', bigger);
    biggerButton.setAttribute('aria-pressed', String(bigger));
    biggerButton.textContent = t(bigger ? 'Exit focus' : 'Focus view');
    fitScreen();
  }
  biggerButton.onclick = () => focusView(!bigger);
  const fullscreen = document.getElementById('viewer-fullscreen');
  fullscreen.onclick = async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await document.documentElement.requestFullscreen();
    } catch { error(t('Fullscreen is unavailable here. Use Focus view to enlarge the picture.')); }
  };
  document.addEventListener('fullscreenchange', () => {
    fullscreen.setAttribute('aria-label', t(document.fullscreenElement ? 'Exit fullscreen' : 'Enter fullscreen'));
    if (document.fullscreenElement) focusView(true);
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') { if (bigger) focusView(false); else if (mobile.matches && !collapsed) { collapsed = true; sidebar(); toggle.focus(); } }
  });
})();
}
