import { LocaleContext, useCopy, type Locale } from './locale';
import { useEffect, useRef, useState } from 'react';
import { ArrowRight, ArrowUpRight, Check, Copy, Eye, GithubLogo, Heart, List, Monitor, TerminalWindow, X, ArrowDown, PlugsConnected, ShieldCheck, Translate } from '@phosphor-icons/react';

const repo = 'https://github.com/M7MMAD-OMAR/sbar-orbit';
const docs = `${repo}/blob/main/docs`;
const installCommands = (windows: boolean) => `git clone https://github.com/M7MMAD-OMAR/sbar-orbit\ncd sbar-orbit\n${windows ? 'install.cmd' : './install.sh'}`;

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

function Evidence() {
  const { t } = useCopy();
  return <article className="bento-tile bento-viewer" id="in-control"><div className="tile-copy"><h3>{t("Evidence beside each claim.")}</h3><p>{t("Original editor input and saving have been observed on Fedora 44 with Hyprland. Each workflow needs its own evidence.")}</p><a className="text-link" href={`${docs}/native-opening.md`}>{t("Read the real application results")} <ArrowUpRight size={18}/></a></div><div className="viewer-story"><h4>{t("What a successful opening means")}</h4><p>{t("A new window belongs to the requested launch, is on the selected workspace, and has measured floating geometry. It does not prove work inside the application.")}</p></div></article>;
}

function Install() {
  const { locale, t } = useCopy();
  const [windows, setWindows] = useState(false);
  useEffect(() => { setWindows(/win/i.test(navigator.platform)); }, []);
  const install = installCommands(windows);
  const [copyStatus, setCopyStatus] = useState('');
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  async function copy() {
    try { await navigator.clipboard.writeText(install); setCopyStatus(t('Copied')); }
    catch { setCopyStatus(t('Select the commands below to copy.')); }
    clearTimeout(timer.current); timer.current = setTimeout(() => setCopyStatus(''), 4000);
  }
  return <section className="section install-section" id="get-started" aria-labelledby="install-heading"><div className="container install-layout"><div><span className="eyebrow">{t("START LOCAL")}</span><h2 id="install-heading">{t("A place for your")}<br />{t("agent to begin.")}</h2><p className="section-intro">{t("Install Orbit, configure the native connection, then choose an original application.")}</p><a className="text-link" href={`${docs}/agent-install.md`}>{t("Full installation reference (English)")} <ArrowUpRight className="directional-arrow" size={19} /></a></div>
    <div className="installation"><div className="install-platform" role="group" aria-label={t("Installation platform")}><button type="button" aria-pressed={!windows} onClick={() => { setWindows(false); setCopyStatus(''); }}>{t("Linux installer")}</button><button type="button" aria-pressed={windows} onClick={() => { setWindows(true); setCopyStatus(''); }}>{t("Windows installer only")}</button></div><div className="code-top"><span><TerminalWindow size={19} />{t("In your terminal")}</span><button className="copy-button" onClick={copy} aria-label={t("Copy installation commands")}>{copyStatus === t('Copied') ? <Check size={17} /> : <Copy size={17} />}{copyStatus === t('Copied') ? t('Copied') : t('Copy')}</button></div><pre dir="ltr" tabIndex={0} aria-label={t("Installation commands")}><code>{install}</code></pre><span className="copy-status" role="status">{copyStatus}</span>
    <p className="prerequisites">{t("Bun and a shared resource budget are required. Native opening currently requires Hyprland. See the")} <a href={`${docs}/agent-install.md`}>{t("native setup")}</a>.</p><div className="alpha-note"><span className="alpha-dot" /><div><strong>{t("Development checkout")}</strong><p>{t("Limited: original opening measured on Fedora 44 with Hyprland. Windows, macOS and other Linux compositors have no opening adapter.")}</p><p>{t("Metadata discovery and service installation are separate from native application support. No complete cross-platform control is claimed.")} <a href={`${docs}/support-tiers.md`}>{t("See support tiers")}</a>.</p><p>{t("Native control needs the matching plugin and an explicit application handoff.")} <a href={`${docs}/native-handoff-incident.md`}>{t("Read the incident history")}</a>.</p></div></div></div>
  </div></section>;
}

function Spaces() {
  const { t } = useCopy();
  return <section className="section solution-section" id="how-it-works" aria-labelledby="solution-heading"><div className="container"><div className="bento-heading"><h2 id="solution-heading">{t("Original applications. Visible workspaces.")}</h2><p>{t("Choose a numbered workspace on the same desktop session.")}</p></div><div className="workspace-bento"><Evidence /><article className="bento-tile bento-spaces"><div className="tile-copy"><h3>{t("One session. Two workspaces.")}</h3><p>{t("You use workspace 1. Request an original application on workspace 2, floating at a bounded size.")}</p></div><img src="/images/native-workspaces.svg" width="1200" height="620" loading="lazy" alt={t("Diagram of two numbered workspaces in one existing desktop session, not a screenshot")} /><div className="space-captions"><span><Monitor size={20}/>{t("Diagram, not a live demonstration")}</span></div></article><article className="bento-tile bento-connect"><div className="tile-copy"><h3>{t("Bring your agent.")}</h3><p>{t("Connect a tool-capable agent host through MCP or the CLI.")}</p></div><div className="connect-picture"><span>MCP / CLI</span><ArrowRight size={24}/><strong>Orbit</strong></div></article></div></div></section>;
}

function Architecture() {
  const { t } = useCopy();
  return <section className="architecture-section" id="architecture" aria-labelledby="architecture-heading"><div className="container"><div className="bento-heading"><h2 id="architecture-heading">{t("From a request to an original window.")}</h2><p>{t("Each step has a specific responsibility.")}</p></div><div className="architecture-board" data-step="static"><div className="hierarchy"><div className="hierarchy-node agent-node"><TerminalWindow size={28}/><strong>{t("Your agent")}</strong><span>MCP / CLI</span></div><ArrowDown className="hierarchy-down" size={24} aria-hidden="true"/><div className="hierarchy-node broker-node"><strong>{t("Orbit broker")}</strong><span>{t("Registered app, owner controls, workspace")}</span></div><ArrowDown className="hierarchy-down" size={24} aria-hidden="true"/><div className="hierarchy-node"><Monitor size={28}/><strong>{t("Original application")}</strong><span>{t("Normal owner state, measured window geometry")}</span></div></div><aside className="architecture-aside"><ShieldCheck size={44}/><h3>{t("Input uses an explicit handoff.")}</h3><p>{t("Select the exact application before input or capture. Verify actual results; opening alone does not prove account state.")}</p><a className="text-link" href={`${docs}/support-tiers.md`}>{t("See support tiers")}</a></aside></div></div></section>;
}

function Guide() {
  const { t } = useCopy();
  return <section className="guide-section section" id="guide" aria-labelledby="guide-heading"><div className="container">
    <div className="bento-heading"><h2 id="guide-heading">{t("From setup to your first task.")}</h2><p>{t("Three steps. The essentials are right here.")}</p></div>
    <ol className="quick-guide">
      <li><div className="guide-visual"><TerminalWindow size={60} weight="thin"/><span>01</span></div><h3>{t("Install on your machine.")}</h3><p>{t("Use the commands below. The installer checks what your system needs.")}</p><a className="text-link" href="#get-started">{t("Go to installation")}<ArrowDown size={18}/></a></li>
      <li><div className="guide-visual"><PlugsConnected size={60} weight="thin"/><span>02</span></div><h3>{t("Connect your agent.")}</h3><p>{t("After installation, run this in your terminal. It prints configuration to paste into your agent host’s MCP settings; it does not connect the host for you.")}</p><code className="guide-command" dir="ltr">sbar-orbit connector-config</code></li>
      <li><div className="guide-visual"><Eye size={60} weight="thin"/><span>03</span></div><h3>{t("Give it a first task.")}</h3><p>{t("Discover registrations, choose full or protected native controls, then select the workspace and application.")}</p><code className="guide-command" dir="ltr">{'sbar-orbit applications'}</code><p className="command-hint">{t("This command lists installed executable paths and available usage metadata without launching applications. Read the reported limits before choosing an application.")}</p></li>
    </ol>
    <div className="guide-footnote"><p>{t("Orbit does not collect usage data. Your agent tools and applications still make their own network requests.")}</p><a className="text-link" href="https://github.com/M7MMAD-OMAR/sbar-orbit/tree/main/docs">{t("Developer reference (English)")}<ArrowUpRight className="directional-arrow" size={18}/></a></div>
  </div></section>;
}

function Landing() {
  const { locale, t } = useCopy();
  return <><a className="skip-link" href="#main">{t("Skip to content")}</a><div id="top" /><Header /><main id="main">
    <section className="hero" aria-labelledby="hero-heading"><div className="container"><div className="hero-copy"><span className="eyebrow hero-eyebrow"><span className="status-dot" />{t("OPEN SOURCE. ON YOUR MACHINE.")}</span><h1 id="hero-heading">{t("Your agent has work.")}<br />{t("You have your own.")}</h1><p>{t("Open your original native applications.")}<br className="desktop-break" />{" "}{t("Choose the workspace and window size. See the actual support limits.")}</p><div className="hero-actions"><a className="button" href="#get-started">{t("Get started")} <ArrowRight className="directional-arrow" size={20} /></a><a className="button button-outline" href={repo}><GithubLogo weight="fill" size={23} />{t("View on GitHub")}</a></div><span className="hero-note">{t("Development checkout")} <span>·</span> Apache-2.0 <span>·</span>{t("No telemetry")}</span></div>
      <figure className="hero-figure"><img src="/images/native-workspaces.svg" width="1200" height="620" fetchPriority="high" alt={t("Diagram of two numbered workspaces in one existing desktop session, not a screenshot")} /><figcaption><span>{t("Workspace 1: your work.")}</span><span>{t("Workspace 2: requested native windows.")}</span></figcaption></figure>
    </div></section>
    <section className="problem-section" id="why-orbit" aria-labelledby="problem-heading"><div className="container problem-layout"><span className="eyebrow">{t("THE PROBLEM")}</span><div><h2 id="problem-heading">{t("One desktop.")}<br />{t("Two things competing.")}</h2><p>{t("When an agent works on your screen, its clicks, windows and typing get in the way of yours. You end up waiting for your own computer.")}</p><p className="problem-answer">{t("You should both be able to keep working.")}</p></div></div></section>
    <Spaces /><Architecture /><Guide /><Install />
    <section className="support-section" id="support" aria-labelledby="support-heading"><div className="container support-layout"><div className="support-heading"><Heart size={30} weight="duotone" /><span className="eyebrow">{t("BUILT IN THE OPEN")}</span><h2 id="support-heading">{t("A little coffee.")}<br />{t("More room to build.")}</h2></div><div className="support-copy"><p>{t("Orbit is free and open source. If it makes your workday a little better, you can support the person building it.")}</p><a className="coffee-link" href="https://www.buymeacoffee.com/m7mmadomar" target="_blank" rel="noopener noreferrer" aria-label={t("Support Sbarah on Buy Me a Coffee, opens in a new tab")}>{locale === 'ar' ? <span className="arabic-coffee">☕ ادعم المشروع بفنجان قهوة</span> : <img src="/images/coffee-button.webp" width="217" height="61" loading="lazy" alt="Buy me a coffee" />}</a><span className="support-note">{t("Always optional. Always appreciated.")}</span></div></div></section>
  </main><footer><div className="container footer-top"><Brand /><p>{t("Original applications on a selected workspace.")}</p><div className="footer-links"><a href={repo}>GitHub <ArrowUpRight className="directional-arrow" size={14} /></a><a href={`${repo}/blob/main/CONTRIBUTING.md`}>{t("Contribute")}</a><a href={`${repo}/blob/main/LICENSE`}>Apache-2.0</a></div></div><div className="container footer-bottom"><a href="https://sbarah.com/">{t("Built by")} {t("Sbarah")}</a><a href="#top">{t("Back to top")} <ArrowUpRight className="directional-arrow" size={15} /></a></div></footer></>;
}

export default function App({ locale = 'en' }: { locale?: Locale }) {
  return <LocaleContext.Provider value={locale}><Landing /></LocaleContext.Provider>;
}
