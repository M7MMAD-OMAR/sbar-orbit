/*
 * The settings, in the viewer.
 *
 * They used to be a GTK window beside the mark. That window was a second interface to design, to
 * translate, to mirror for Arabic and to test, for a set of values that a page can draw perfectly
 * well; and it was where a person ended up reading paragraphs about which mouse button does what.
 * So the mark keeps what only a mark can do, and this draws the rest.
 *
 * Nothing about the settings themselves moved. `desktop/orbit_settings.py` is still the one schema,
 * still the one validator, and the file it writes is still the source of truth: the panel watches
 * that file and reloads, so a switch flipped here reaches the desktop before the hand leaves the
 * mouse. With no browser open, or no viewer at all, `sbar-orbit config` changes the same values from
 * a terminal, which is what makes this a way in rather than the way in.
 */
(() => {
  Object.assign(arabic, {
    'Sessions': 'الجلسات',
    'Settings': 'الإعدادات',
    'Views': 'الأقسام',
    'Search the settings': 'ابحث في الإعدادات',
    'Put everything back the way it came': 'أعد كل شيء إلى أصله',
    'Nothing matches {query}': 'لا شيء يطابق {query}',
    'Saved': 'حفظ',
    'Could not save: {reason}': 'تعذر الحفظ: {reason}',
    'Settings are unavailable. Orbit is not answering.': 'الإعدادات غير متاحة. أوربت لا يستجيب.',
    'Default': 'الأصل',
    'Back to default': 'عد إلى الأصل',
    'Automatic': 'تلقائي',
    'Largest screen': 'أكبر شاشة',
    'opens a tab': 'يفتح تبويبا',
    'Name of the monitor': 'اسم الشاشة',
    // The groups.
    'Startup': 'بدء التشغيل',
    'Placement': 'الموضع',
    'The mark': 'العلامة',
    'The viewer': 'نافذة المتابعة',
    'Working glow': 'توهج العمل',
    'Motion and blending': 'الحركة والمزج',
    'Notifications': 'الإشعارات',
    // The settings, label and explanation, in the words of the schema.
    'Start Orbit with my desktop': 'ابدأ أوربت مع سطح المكتب',
    'Whether the broker and the mark come back on their own. Installed by default; this is systemd and an autostart entry rather than a value in the settings file.': 'هل يعود الوسيط والعلامة وحدهما بعد إعادة التشغيل. مفعل عند التثبيت، وهو قيد في systemd ومدخل بدء تلقائي، لا قيمة في ملف الإعدادات.',
    'Screen edge': 'حافة الشاشة',
    'Which edge of the screen the mark is docked to.': 'الحافة التي ترسو عليها العلامة.',
    'Monitor': 'الشاشة',
    'Which monitor it appears on. Unset means whichever the compositor calls first.': 'الشاشة التي تظهر عليها العلامة. تركها فارغة يعني أول شاشة يسميها مدير النوافذ.',
    'Distance from the edge': 'المسافة عن الحافة',
    'Pixels between the mark and the edge of the screen.': 'عدد البكسلات بين العلامة وحافة الشاشة.',
    'Place along the edge': 'الموضع على طول الحافة',
    'Where along its edge the mark sits, from the start of the edge to the end. Dragging the mark sets this.': 'أين تجلس العلامة على حافتها، من أولها إلى آخرها. سحب العلامة بيدك يضبط هذه القيمة.',
    'Shape': 'الشكل',
    'What the mark looks like: the logo, a plain capsule, a dot, or a dot carrying a count.': 'شكل العلامة: الشعار، أو كبسولة بسيطة، أو نقطة، أو نقطة تحمل عددا.',
    'Size': 'الحجم',
    'How large the mark is, in pixels.': 'حجم العلامة بالبكسل.',
    'Hide it while nothing runs': 'أخفها ما لم يكن هناك عمل',
    'Show the mark only while a session exists, instead of always.': 'أظهر العلامة فقط عند وجود جلسة، بدل إظهارها دائما.',
    'State colours': 'ألوان الحالات',
    "One colour per state: idle, working, paused, and Orbit not running. Working is Orbit's blue, the same colour as the screen edge glow and the agent pointer, so one colour means an agent is acting wherever it appears.": 'لون لكل حالة: ساكن، يعمل، متوقف مؤقتا، وأوربت غير مشغل. لون العمل هو أزرق أوربت نفسه الذي يضيء حواف الشاشة ويرسم مؤشر الوكيل، فلون واحد يعني أن وكيلا يتصرف أينما ظهر.',
    'Open the viewer in': 'افتح نافذة المتابعة في',
    "Which installed browser the viewer opens in. Unset picks the desktop's own browser when it can open a window of its own, and otherwise the first installed browser that can.": 'أي متصفح مثبت تفتح فيه نافذة المتابعة. تركه تلقائيا يختار متصفح سطح المكتب إن كان يفتح نافذة مستقلة، وإلا أول متصفح مثبت يستطيع ذلك.',
    'Open it as its own window': 'افتحها كنافذة مستقلة',
    'A window with no tab strip and no address bar, the way an installed web application opens. Browsers in the Firefox family have no such mode and open a tab whatever this says.': 'نافذة بلا شريط تبويبات ولا شريط عنوان، كما يفتح تطبيق ويب مثبت. متصفحات عائلة فايرفوكس لا تملك هذا الوضع وتفتح تبويبا مهما كان هذا الإعداد.',
    'Glow the screen edges while working': 'أضئ حواف الشاشة أثناء العمل',
    'A soft glow inside the edges of the screen while an agent is working, with no border and nothing to click through.': 'توهج خفيف داخل حواف الشاشة أثناء عمل الوكيل، بلا إطار ولا شيء يعترض النقر.',
    'Breathe while working': 'تنفس أثناء العمل',
    'The glow rises and falls while work is in flight. Separable from the glow itself, because motion is the part that costs.': 'يعلو التوهج ويخفت ما دام هناك عمل جار. منفصل عن التوهج نفسه لأن الحركة هي الجزء المكلف.',
    'Glow colour': 'لون التوهج',
    "Orbit's blue by default, the colour the agent pointer is drawn in. The word accent follows the desktop theme instead, light and dark, and any colour here overrides both.": 'أزرق أوربت افتراضيا، وهو لون مؤشر الوكيل. كلمة accent تتبع لون سطح المكتب في الوضعين الفاتح والداكن، وأي لون تختاره هنا يتقدم عليهما.',
    'Liquid motion': 'حركة سائلة',
    'The card is pulled out of the capsule rather than appearing. Turning it off removes the animation, not the card.': 'تسحب البطاقة من الكبسولة بدل أن تظهر فجأة. إيقافها يزيل الحركة لا البطاقة.',
    'How solid the card is': 'مدى صلابة البطاقة',
    'How much of the wallpaper shows through the glass, from mostly transparent to solid.': 'كم تظهر خلفية سطح المكتب عبر الزجاج، من شبه شفاف إلى صلب.',
    'Desktop notifications': 'إشعارات سطح المكتب',
    "A notification through the person's own daemon when a session or an application appears.": 'إشعار عبر خدمة الإشعارات في جهازك عند ظهور جلسة أو تطبيق.',
    'Blink when something happens': 'اومض عند حدوث شيء',
    'The mark blinks once when a session or an application appears.': 'تومض العلامة مرة واحدة عند ظهور جلسة أو تطبيق.',
    // The values a choice offers.
    'left': 'يسار', 'right': 'يمين', 'top': 'أعلى', 'bottom': 'أسفل',
    'mark': 'الشعار', 'bar': 'شريط', 'dot': 'نقطة', 'count': 'عدد',
    'idle': 'ساكن', 'working': 'يعمل', 'paused': 'متوقف مؤقتا', 'offline': 'غير مشغل',
  });

  const view = element('settings-view');
  const groups = element('settings-groups');
  const status = element('settings-status');
  const search = element('settings-search');
  let schema = [], browsers = [], monitors = [], loaded = false, writing = 0;
  const timers = new Map();

  /** Say what happened, briefly. A change that worked says so and then gets out of the way. */
  function say(text, lasting = false) {
    status.textContent = text;
    status.dataset.error = String(lasting);
    if (!lasting && text) setTimeout(() => { if (status.textContent === text) status.textContent = ''; }, 2000);
  }

  async function load() {
    try {
      const answer = await rpc('settings.list');
      schema = answer.settings || []; browsers = answer.browsers || []; monitors = answer.monitors || [];
      loaded = true;
      draw();
    } catch { groups.replaceChildren(note(t('Settings are unavailable. Orbit is not answering.'))); }
  }

  /*
   * Write one value. The schema's own program does the coercing and the clamping, so a number typed
   * into a box is judged by exactly the code that judges one typed into a terminal, and what comes
   * back is the whole settings list as it now stands rather than what this page hoped it wrote.
   */
  async function write(key, value, options = {}) {
    writing++;
    try {
      const answer = await rpc('settings.write', options.all ? { all: true } : options.reset ? { key, reset: true } : { key, value });
      schema = answer.settings || schema;
      say(t('Saved'));
      if (options.redraw !== false) draw();
    } catch (error) {
      say(t('Could not save: {reason}', { reason: error.message }), true);
      draw();
    } finally { writing--; }
  }

  /** A slider fires on every pixel. The file is written once the hand stops. */
  function later(key, value) {
    clearTimeout(timers.get(key));
    timers.set(key, setTimeout(() => write(key, value, { redraw: false }), 400));
  }

  const note = text => { const line = document.createElement('p'); line.className = 'settings-note'; line.textContent = text; return line; };

  function matches(entry) {
    const query = search.value.trim().toLowerCase();
    if (!query) return true;
    const haystack = [t(entry.label), t(entry.description), entry.key, entry.group, t(entry.group), ...(entry.terms || [])];
    return haystack.some(word => String(word).toLowerCase().includes(query));
  }

  function draw() {
    const wanted = schema.filter(matches);
    if (!wanted.length) { groups.replaceChildren(note(t('Nothing matches {query}', { query: search.value.trim() }))); return; }
    const named = [...new Set(wanted.map(entry => entry.group))];
    groups.replaceChildren(...named.map(name => {
      const card = document.createElement('section');
      card.className = 'settings-group';
      const heading = document.createElement('h3');
      heading.textContent = t(name);
      card.append(heading);
      for (const entry of wanted.filter(one => one.group === name)) card.append(row(entry));
      return card;
    }));
  }

  /** One setting: what it is called, what it does, and the control that changes it. */
  function row(entry) {
    const line = document.createElement('div');
    line.className = 'setting';
    line.dataset.kind = entry.kind;
    const text = document.createElement('div');
    text.className = 'setting-text';
    const label = document.createElement('span');
    label.className = 'setting-label';
    label.textContent = t(entry.label);
    const about = document.createElement('p');
    about.className = 'setting-about';
    about.textContent = t(entry.description);
    text.append(label, about);
    const control = document.createElement('div');
    control.className = 'setting-control';
    control.append(...widgets(entry));
    line.append(text, control);
    return line;
  }

  function widgets(entry) {
    if (entry.kind === 'switch') return [toggle(entry.value === true, next => write(entry.key, next))];
    if (entry.kind === 'choice') return [segmented(entry.choices || [], entry.value, next => write(entry.key, next))];
    if (entry.kind === 'number' || entry.kind === 'fraction') {
      const [low, high] = entry.range || (entry.kind === 'fraction' ? [0, 1] : [0, 100]);
      return [slider(entry, low, high)];
    }
    if (entry.kind === 'accent_color') return [swatch(entry.value, next => write(entry.key, next))];
    if (entry.kind === 'colors') return Object.keys(entry.value || {}).map(state => {
      const pair = document.createElement('span');
      pair.className = 'swatch-pair';
      const name = document.createElement('span');
      name.className = 'swatch-name';
      name.textContent = t(state);
      pair.append(swatch(entry.value[state], next => write(`colors.${state}`, next)), name);
      return pair;
    });
    if (entry.kind === 'browser') return [picker([{ value: '', label: t('Automatic') },
      ...browsers.map(browser => ({ value: browser.id, label: `${browser.name || browser.id}${browser.appWindow ? '' : ` (${t('opens a tab')})`}` }))],
      entry.value || '', next => write(entry.key, next))];
    if (entry.kind === 'monitor') {
      // With no panel running there is no list to choose from, so the name is typed instead of picked.
      if (!monitors.length) return [textbox(entry.value || '', next => write(entry.key, next))];
      return [picker([{ value: '', label: t('Largest screen') },
        ...monitors.map(screen => ({ value: screen.connector, label: `${screen.connector} (${screen.width} × ${screen.height})` }))],
        entry.value == null ? '' : String(entry.value), next => write(entry.key, next))];
    }
    return [textbox(String(entry.value ?? ''), next => write(entry.key, next))];
  }

  /* --- The controls ------------------------------------------------------------------------------
   * Drawn here rather than handed to the browser. A checkbox, a range and a select carry whatever the
   * operating system thinks those look like, and the point of this page is that Orbit looks like
   * Orbit on any desktop it is opened on. The one exception is the colour picker's own dialog, which
   * belongs to the browser; only the swatch that opens it is ours.
   */
  function toggle(on, onChange) {
    const button = document.createElement('button');
    button.type = 'button'; button.className = 'toggle';
    button.setAttribute('role', 'switch');
    button.setAttribute('aria-checked', String(on));
    button.append(document.createElement('span'));
    button.onclick = () => { const next = button.getAttribute('aria-checked') !== 'true'; button.setAttribute('aria-checked', String(next)); onChange(next); };
    return button;
  }

  function segmented(choices, current, onChange) {
    const group = document.createElement('div');
    group.className = 'segmented';
    group.setAttribute('role', 'radiogroup');
    for (const choice of choices) {
      const button = document.createElement('button');
      button.type = 'button'; button.className = 'segment';
      button.setAttribute('role', 'radio');
      button.setAttribute('aria-checked', String(choice === current));
      button.textContent = t(choice);
      button.onclick = () => onChange(choice);
      group.append(button);
    }
    return group;
  }

  function slider(entry, low, high) {
    const wrap = document.createElement('div');
    wrap.className = 'slider';
    const input = document.createElement('input');
    input.type = 'range';
    input.min = String(low); input.max = String(high);
    input.step = entry.kind === 'fraction' ? '0.01' : '1';
    input.value = String(entry.value ?? low);
    input.setAttribute('aria-label', t(entry.label));
    const readout = document.createElement('span');
    readout.className = 'slider-value';
    const show = value => { readout.textContent = entry.kind === 'fraction' ? `${Math.round(Number(value) * 100)}%` : String(value); };
    show(input.value);
    input.oninput = () => { show(input.value); later(entry.key, input.value); };
    wrap.append(input, readout);
    return wrap;
  }

  function swatch(value, onChange) {
    const input = document.createElement('input');
    input.type = 'color';
    input.className = 'swatch';
    input.value = /^#[0-9a-fA-F]{6}$/.test(String(value)) ? String(value) : '#255fce';
    input.onchange = () => onChange(input.value);
    return input;
  }

  function picker(options, current, onChange) {
    const select = document.createElement('select');
    select.className = 'picker-control';
    for (const option of options) {
      const node = document.createElement('option');
      node.value = option.value; node.textContent = option.label;
      node.selected = option.value === current;
      select.append(node);
    }
    select.onchange = () => onChange(select.value);
    return select;
  }

  function textbox(value, onChange) {
    const input = document.createElement('input');
    input.type = 'text'; input.className = 'setting-input';
    input.value = value;
    input.setAttribute('aria-label', t('Name of the monitor'));
    input.onchange = () => onChange(input.value);
    return input;
  }

  /* --- Which view is on screen -------------------------------------------------------------------
   * Two views in one page rather than two pages: the rail, the identity and the connection state are
   * the same in both, and a settings page that lost them would be a second application again.
   */
  const shell = document.getElementById('shell');
  function show(name) {
    shell.dataset.view = name;
    view.hidden = name !== 'settings';
    // One button at the foot of the rail, pressed while the settings are on screen, the way a control
    // panel keeps its own door in a fixed place rather than as one of a pair of tabs above the list.
    element('view-settings').setAttribute('aria-pressed', String(name === 'settings'));
    if (name === 'settings' && !loaded) load();
  }
  element('view-settings').onclick = () => show(shell.dataset.view === 'settings' ? 'sessions' : 'settings');
  // Choosing a session is asking for the sessions, so the settings stand aside.
  element('sessions').addEventListener('click', () => { if (shell.dataset.view === 'settings') show('sessions'); });
  search.addEventListener('input', () => { if (loaded) draw(); });
  element('settings-reset').onclick = async () => {
    // Every setting at once, which is the one destructive thing this page can do, so it asks first.
    if (element('settings-reset').dataset.confirm !== 'true') {
      element('settings-reset').dataset.confirm = 'true';
      const wording = element('settings-reset').textContent;
      element('settings-reset').textContent = `${wording}?`;
      setTimeout(() => { element('settings-reset').dataset.confirm = ''; element('settings-reset').textContent = wording; }, 4000);
      return;
    }
    element('settings-reset').dataset.confirm = '';
    element('settings-reset').textContent = t('Put everything back the way it came');
    await write('', '', { all: true });
  };
  // The language switch rewrites the page's own words; these are drawn from a schema, so they are
  // redrawn here rather than left in the language they were first painted in.
  element('language').addEventListener('click', () => { if (loaded) draw(); });
  // The words above were added to the table after the page's first language pass ran, so it runs again.
  applyLanguage();
  show(new URLSearchParams(location.search).get('view') === 'settings' ? 'settings' : 'sessions');
})();
