import { usePresentation } from './usePresentation';
import { LocaleContext, useCopy, type Locale } from './locale';
import { useEffect, useRef, useState } from 'react';
import { ArrowRight, ArrowUpRight, Check, Copy, Cursor, Eye, GithubLogo, Heart, List, Monitor, Pause, Play, TerminalWindow, X, Browser, ArrowDown, PlugsConnected, ShieldCheck, TreeStructure, Translate } from '@phosphor-icons/react';

const repo = 'https://github.com/M7MMAD-OMAR/sbar-orbit';
const docs = `${repo}/blob/main/docs`;
const install = `git clone https://github.com/M7MMAD-OMAR/sbar-orbit\ncd sbar-orbit\n./install.sh`;
const viewerStates = [
  { label: 'Watch', icon: Eye, title: 'A window into the work.', text: 'Open the viewer to see the agent’s private workspace while your own desktop stays yours.' },
  { label: 'Pause', icon: Pause, title: 'A moment to check.', text: 'Pause the session to stop new agent actions. Take a look before the work continues.' },
  { label: 'Take over', icon: Cursor, title: 'Your turn at the controls.', text: 'While paused, use the viewer to interact with the private workspace yourself.' },
  { label: 'Resume', icon: Play, title: 'Hand it back.', text: 'Resume the session when you are ready for the agent to continue.' },
];

function Brand({ white = false }: { white?: boolean }) {
  const { locale, t } = useCopy();
  return <a href="#top" className="brand" aria-label={t("Sbar Orbit home")}><img src={`/brand/logo${white ? '-white' : ''}.png`} width="181" height="60" alt="sbarorbit" /></a>;
}

function Header() {
  const { locale, t } = useCopy();
  const [open, setOpen] = useState(false);
  const toggle = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape') { setOpen(false); toggle.current?.focus(); } };
    document.addEventListener('keydown', close);
    return () => document.removeEventListener('keydown', close);
  }, [open]);
  return <header className="header"><div className="container nav-wrap"><Brand />
    <nav id="navigation" aria-label={t("Main navigation")} className={open ? 'nav is-open' : 'nav'} onClick={() => setOpen(false)}>
      <a href="#why-orbit">{t("Why Orbit")}</a><a href="#guide">{t("Quick guide")}</a><a href="#architecture">{t("How it connects")}</a><a href="#support">{t("Support")}</a><a className="button button-small" href="#get-started">{t("Get started")} <ArrowRight className="directional-arrow" size={16} /></a>
    </nav>
    <div className="nav-controls">
      <a className="language-switch" href={locale === 'ar' ? '/' : '/ar/'} lang={locale === 'ar' ? 'en' : 'ar'} hrefLang={locale === 'ar' ? 'en' : 'ar'} aria-label={locale === 'ar' ? 'Switch to English' : 'التبديل إلى العربية'} title={locale === 'ar' ? 'Switch to English' : 'التبديل إلى العربية'}><Translate size={23} aria-hidden="true" /></a>
      <button ref={toggle} className="menu-toggle" aria-label={t(open ? 'Close navigation' : 'Open navigation')} aria-expanded={open} aria-controls="navigation" onClick={() => setOpen(!open)}>{open ? <X size={23} /> : <List size={23} />}</button>
    </div>
  </div></header>;
}

function Viewer() {
  const { t } = useCopy();
  const show = usePresentation(viewerStates.length, 4000);
  const current = viewerStates[show.step] ?? viewerStates[0];
  if (!current) return null;
  return <article ref={show.element} {...show.interaction} className="bento-tile bento-viewer" id="in-control" aria-labelledby="viewer-heading" aria-roledescription={t("Automatic presentation")} data-running={show.running}>
    <div className="tile-copy"><h3 id="viewer-heading">{t("Watch. Pause. Step in.")}</h3><p>{t("See the work, then take the controls when you need.")}</p></div>
    <img className="viewer-art" src="/images/viewer-control.webp" width="1200" height="850" loading="lazy" alt={t("A person watching the agent’s application windows through the Orbit viewer")} />
    <div className="viewer-story">
      <div className="story-toolbar"><span>{t("A walkthrough, not a live session")}</span>{!show.reduced && <button className="motion-toggle" onClick={()=>show.setPaused(!show.paused)} aria-pressed={show.paused} aria-label={t(show.paused ? 'Play presentation' : 'Pause presentation')}>{show.paused ? <Play size={16}/> : <Pause size={16}/>}</button>}</div>
      <div className={show.reduced ? 'story-slides reduced-story' : 'story-slides'} aria-live="off">
        {viewerStates.map((state,index)=><div key={state.label} className="story-slide" hidden={!show.reduced && index!==show.step} data-slide={index}><div className="story-title"><state.icon size={26}/><h4>{t(state.label)}</h4><span>{String(index+1).padStart(2,'0')} / 04</span></div><p>{t(state.text)}</p></div>)}
      </div>
      {!show.reduced && <div className="story-progress" aria-hidden="true">{viewerStates.map((state,index)=><span key={state.label} className={index===show.step?'is-current':index<show.step?'is-complete':''}><i key={index===show.step?show.step:-1}/></span>)}</div>}
    </div>
  </article>;
}

function Install() {
  const { locale, t } = useCopy();
  const [copyStatus, setCopyStatus] = useState('');
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  async function copy() {
    try { await navigator.clipboard.writeText(install); setCopyStatus(t('Copied')); }
    catch { setCopyStatus(t('Select the commands below to copy.')); }
    clearTimeout(timer.current); timer.current = setTimeout(() => setCopyStatus(''), 4000);
  }
  return <section className="section install-section" id="get-started" aria-labelledby="install-heading"><div className="container install-layout"><div><span className="eyebrow">{t("START LOCAL")}</span><h2 id="install-heading">{t("A place for your")}<br />{t("agent to begin.")}</h2><p className="section-intro">{t("Install Orbit, connect your agent, and open its first workspace.")}</p><a className="text-link" href={`${docs}/agent-install.md`}>{t("Full installation reference (English)")} <ArrowUpRight className="directional-arrow" size={19} /></a></div>
    <div className="installation"><div className="code-top"><span><TerminalWindow size={19} />{t("In your terminal")}</span><button className="copy-button" onClick={copy} aria-label={t("Copy installation commands")}>{copyStatus === t('Copied') ? <Check size={17} /> : <Copy size={17} />}{copyStatus === t('Copied') ? t('Copied') : t('Copy')}</button></div><pre dir="ltr" tabIndex={0} aria-label={t("Installation commands")}><code>{install}</code></pre><span className="copy-status" role="status">{copyStatus}</span>
    <p className="prerequisites">{t("Linux, macOS or Windows, with Bun and Chrome/Chromium. Linux additionally needs user cgroup delegation, and the private display for native apps is Linux only and needs the")} <a href={`${docs}/fedora-results.md`}>{t("Fedora setup")}</a>.</p><div className="alpha-note"><span className="alpha-dot" /><div><strong>{t("Version 0.1.1")}</strong><p>{t("Measured on Fedora 44 with wlroots, on Windows, and on Apple silicon macOS. The private browser runs on all three.")}</p><p>{t("The resource budget is enforced by the kernel on Linux and Windows. On macOS it is advisory, because the platform offers no equivalent.")} <a href={`${docs}/support-tiers.md`}>{t("See support tiers")}</a>.</p></div></div></div>
  </div></section>;
}

function Spaces() {
  const { t } = useCopy();
  return <section className="section solution-section" id="how-it-works" aria-labelledby="solution-heading"><div className="container">
    <div className="bento-heading"><h2 id="solution-heading">{t("Separate spaces.")} {t("Same machine.")}</h2><p>{t("Two ways to work. Neither takes over your desktop.")}</p></div>
    <div className="workspace-bento"><Viewer />
      <article className="bento-tile bento-spaces"><div className="tile-copy"><h3>{t("A workspace of its own.")}</h3><p>{t("A fresh browser for web tasks. A private display for native apps.")}</p></div><img src="/images/private-spaces.webp" width="1518" height="1036" loading="lazy" alt={t("Two hand drawn windows: a private browser and a native application on a private display")} /><div className="space-captions"><span><Browser size={20}/>{t("Private browser")}</span><span><Monitor size={20}/>{t("Private display")}</span></div></article>
      <article className="bento-tile bento-connect"><div className="tile-copy"><h3>{t("Bring your agent.")}</h3><p>{t("Connect a tool-capable agent host through MCP or the CLI.")}</p></div><div className="connect-picture" aria-label={t("MCP and CLI connect your agent to Orbit")}><div><span><PlugsConnected size={24}/>MCP</span><span><TerminalWindow size={24}/>CLI</span></div><ArrowRight className="directional-arrow" size={32}/><div className="connect-orbit"><img src="/favicon.svg" width="36" height="36" alt=""/><strong>Orbit</strong></div></div></article>
    </div>
  </div></section>;
}

function Architecture() {
  const { t } = useCopy();
  const flow = usePresentation<HTMLDivElement>(4, 1800);
  return <section className="architecture-section" id="architecture" aria-labelledby="architecture-heading"><div className="container">
    <div className="bento-heading"><h2 id="architecture-heading">{t("One agent. A clear chain of control.")}</h2><p>{t("Your agent gives instructions. Orbit manages the workspace.")}</p></div>
    <div ref={flow.element} {...flow.interaction} className="architecture-board" data-step={flow.reduced ? 'static' : flow.step} data-running={flow.running}>
      <div className="hierarchy" aria-label={t("The agent connects to the broker, which manages a private browser or display. The viewer is optional.")}>
        <div className="hierarchy-node agent-node"><TerminalWindow size={28}/><strong>{t("Your agent")}</strong><span>{t("MCP or CLI")}</span></div>
        <ArrowDown className="hierarchy-down" size={24} aria-hidden="true"/>
        <div className="broker-row"><div className="hierarchy-node broker-node"><img src="/favicon.svg" width="32" height="32" alt=""/><strong>{t("Orbit broker")}</strong><span>{t("Local session manager")}</span></div><div className="viewer-branch"><span className="dashed-connector"/><div className="hierarchy-node optional-node"><Eye size={24}/><strong>{t("Viewer")}</strong><span>{t("Optional: watch and control")}</span></div></div></div>
        <div className="workspace-branches"><div className="branch-line" aria-hidden="true"/><div className="hierarchy-node"><Browser size={28}/><strong>{t("Private browser")}</strong><span>{t("Websites and web tools")}</span></div><div className="hierarchy-node"><Monitor size={28}/><strong>{t("Private display")}</strong><span>{t("Native applications")}</span></div></div>
        <div className="flow-caption" aria-live="off">{t(flow.reduced ? 'Instructions go from your agent through Orbit to its workspace.' : ['Your agent sends an instruction.', 'Orbit routes it to the session.', 'The private workspace carries it out.', 'Follow the result in the optional viewer.'][flow.step] ?? 'Your agent sends an instruction.')}</div><div className="diagram-legend"><span><i/>{t("Agent actions")}</span><span><i className="dashed"/>{t("Optional viewer connection")}</span></div>
      </div>
      <aside className="architecture-aside">{!flow.reduced && <button className="flow-toggle text-link" onClick={()=>flow.setPaused(!flow.paused)} aria-pressed={flow.paused}>{flow.paused ? <Play size={16}/> : <Pause size={16}/>} {t(flow.paused ? 'Play animation' : 'Pause animation')}</button>}<Monitor size={56} weight="thin"/><h3>{t("Your desktop stays separate.")}</h3><p>{t("Your windows, pointer and personal browser are not the agent’s workspace.")}</p><div className="boundary-note"><ShieldCheck size={24}/><p>{t("Separate screens, not a security sandbox. Apps still have your OS user’s permissions.")}</p></div></aside>
    </div>
  </div></section>;
}

function Guide() {
  const { t } = useCopy();
  return <section className="guide-section section" id="guide" aria-labelledby="guide-heading"><div className="container">
    <div className="bento-heading"><h2 id="guide-heading">{t("From setup to your first task.")}</h2><p>{t("Three steps. The essentials are right here.")}</p></div>
    <ol className="quick-guide">
      <li><div className="guide-visual"><TerminalWindow size={60} weight="thin"/><span>01</span></div><h3>{t("Install on your machine.")}</h3><p>{t("Use the commands below. The installer checks what your system needs.")}</p><a className="text-link" href="#get-started">{t("Go to installation")}<ArrowDown size={18}/></a></li>
      <li><div className="guide-visual"><PlugsConnected size={60} weight="thin"/><span>02</span></div><h3>{t("Connect your agent.")}</h3><p>{t("After installation, run this in your terminal. It prints configuration to paste into your agent host’s MCP settings; it does not connect the host for you.")}</p><code className="guide-command" dir="ltr">sbar-orbit connector-config</code></li>
      <li><div className="guide-visual"><Eye size={60} weight="thin"/><span>03</span></div><h3>{t("Give it a first task.")}</h3><p>{t("Ask your connected agent to open a private browser with Orbit and carry out a task. Open the viewer whenever you want to follow along.")}</p><code className="guide-command" dir="ltr">{'export ORBIT_SOCKET="$XDG_RUNTIME_DIR/sbar-orbit/broker.sock"\nsbar-orbit preview'}</code><p className="command-hint">{t("For the installed service: copy the printed URL into your browser. This command does not open a window. If you started Orbit with serve, use the socket path it printed instead.")}</p></li>
    </ol>
    <div className="guide-footnote"><p>{t("Orbit does not collect usage data. Your agent tools and visited websites still make their own network requests.")}</p><a className="text-link" href="https://github.com/M7MMAD-OMAR/sbar-orbit/tree/main/docs">{t("Developer reference (English)")}<ArrowUpRight className="directional-arrow" size={18}/></a></div>
  </div></section>;
}

function Landing() {
  const { locale, t } = useCopy();
  return <><a className="skip-link" href="#main">{t("Skip to content")}</a><div id="top" /><Header /><main id="main">
    <section className="hero" aria-labelledby="hero-heading"><div className="container"><div className="hero-copy"><span className="eyebrow hero-eyebrow"><span className="status-dot" />{t("OPEN SOURCE. ON YOUR MACHINE.")}</span><h1 id="hero-heading">{t("Your agent has work.")}<br />{t("You have your own.")}</h1><p>{t("Give your AI agent a private browser or display.")}<br className="desktop-break" />{" "}{t("Keep your desktop, your focus, and your flow.")}</p><div className="hero-actions"><a className="button" href="#get-started">{t("Get started")} <ArrowRight className="directional-arrow" size={20} /></a><a className="button button-outline" href={repo}><GithubLogo weight="fill" size={23} />{t("View on GitHub")}</a></div><span className="hero-note">{t("Version 0.1.1")} <span>·</span> Apache-2.0 <span>·</span>{t("No telemetry")}</span></div>
      <figure className="hero-figure"><picture><source media="(max-width: 700px)" srcSet="/images/hero-workspaces-mobile.webp" /><img src="/images/hero-workspaces.webp" width="1870" height="841" fetchPriority="high" alt={t("You work at your own desk while an agent uses separate browser and application windows beside it")} /></picture><figcaption><span>{t("Your desktop. Your rhythm.")}</span><span>{t("The agent’s own workspace.")}</span></figcaption></figure>
    </div></section>
    <section className="problem-section" id="why-orbit" aria-labelledby="problem-heading"><div className="container problem-layout"><span className="eyebrow">{t("THE PROBLEM")}</span><div><h2 id="problem-heading">{t("One desktop.")}<br />{t("Two things competing.")}</h2><p>{t("When an agent works on your screen, its clicks, windows and typing get in the way of yours. You end up waiting for your own computer.")}</p><p className="problem-answer">{t("You should both be able to keep working.")}</p></div></div></section>
    <Spaces /><Architecture /><Guide /><Install />
    <section className="support-section" id="support" aria-labelledby="support-heading"><div className="container support-layout"><div className="support-heading"><Heart size={30} weight="duotone" /><span className="eyebrow">{t("BUILT IN THE OPEN")}</span><h2 id="support-heading">{t("A little coffee.")}<br />{t("More room to build.")}</h2></div><div className="support-copy"><p>{t("Orbit is free and open source. If it makes your workday a little better, you can support the person building it.")}</p><a className="coffee-link" href="https://www.buymeacoffee.com/m7mmadomar" target="_blank" rel="noopener noreferrer" aria-label={t("Support Sbarah on Buy Me a Coffee, opens in a new tab")}>{locale === 'ar' ? <span className="arabic-coffee">☕ ادعم المشروع بفنجان قهوة</span> : <img src="/images/coffee-button.webp" width="217" height="61" loading="lazy" alt="Buy me a coffee" />}</a><span className="support-note">{t("Always optional. Always appreciated.")}</span></div></div></section>
  </main><footer><div className="container footer-top"><Brand /><p>{t("A workspace beside yours.")}</p><div className="footer-links"><a href={repo}>GitHub <ArrowUpRight className="directional-arrow" size={14} /></a><a href={`${repo}/blob/main/CONTRIBUTING.md`}>{t("Contribute")}</a><a href={`${repo}/blob/main/LICENSE`}>Apache-2.0</a></div></div><div className="container footer-bottom"><span>{t("Built by")} <a href="https://sbarah.com/">{t("Sbarah")}</a>{t(". Shared with everyone.")}</span><a href="#top">{t("Back to top")} <ArrowUpRight className="directional-arrow" size={15} /></a></div><div className="container maker-signature"><a href="https://sbarah.com/" aria-label={locale === 'ar' ? 'زيارة موقع صبارة' : 'Visit Sbarah'}><img src="/brand/sbarah.svg" width="112" height="59" loading="lazy" alt={t("Sbarah")} /><span>SBARAH.COM <ArrowUpRight size={14} aria-hidden="true" /></span></a></div></footer></>;
}

export default function App({ locale = 'en' }: { locale?: Locale }) {
  return <LocaleContext.Provider value={locale}><Landing /></LocaleContext.Provider>;
}
