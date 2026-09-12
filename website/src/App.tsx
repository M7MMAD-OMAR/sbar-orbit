import { LocaleContext, useCopy, type Locale } from './locale';
import { useEffect, useRef, useState } from 'react';
import { ArrowRight, ArrowUpRight, Check, Copy, Cursor, Eye, GithubLogo, Heart, List, Monitor, Pause, Play, TerminalWindow, X, Browser, CaretDown } from '@phosphor-icons/react';

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
    <button ref={toggle} className="menu-toggle" aria-label={t(open ? 'Close navigation' : 'Open navigation')} aria-expanded={open} aria-controls="navigation" onClick={() => setOpen(!open)}>{open ? <X size={25} /> : <List size={25} />}</button>
    <a className="language-switch" href={locale === 'ar' ? '/' : '/ar/'} lang={locale === 'ar' ? 'en' : 'ar'} hrefLang={locale === 'ar' ? 'en' : 'ar'}>{locale === 'ar' ? 'English' : 'العربية'}</a>
    <nav id="navigation" aria-label={t("Main navigation")} className={open ? 'nav is-open' : 'nav'} onClick={() => setOpen(false)}>
      <a href="#why-orbit">{t("Why Orbit")}</a><a href={`${repo}#start`}>{t("Docs")} <ArrowUpRight className="directional-arrow" size={13} /></a><a href="#support">{t("Support")}</a><a className="button button-small" href="#get-started">{t("Get started")} <ArrowRight className="directional-arrow" size={16} /></a>
    </nav>
  </div></header>;
}

function Viewer() {
  const { locale, t } = useCopy();
  const [selected, setSelected] = useState(0);
  const current = viewerStates[selected] ?? viewerStates[0];
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);
  if (!current) return null;
  return <section className="viewer-section" id="in-control" aria-labelledby="viewer-heading"><div className="container">
    <div className="section-heading viewer-heading"><span className="eyebrow">{t("YOU STAY IN CONTROL")}</span><h2 id="viewer-heading">{t("Let it work.")}<br />{t("Step in when you want.")}</h2><p>{t("A private workspace, with a door you can open.")}</p></div>
    <div className="viewer-layout"><img className="viewer-art" src="/images/viewer-control.webp" width="1200" height="850" loading="lazy" alt={t("A person watching the agent\u2019s application windows through the Orbit viewer")} />
      <div className="viewer-explanation"><span className="small-label">{t("EXPLORE THE VIEWER")}</span><div className="viewer-tabs" role="tablist" aria-label={t("Viewer capabilities")}>
        {viewerStates.map((state, index) => <button key={t(state.label)} ref={element => { tabs.current[index] = element; }} role="tab" id={`viewer-tab-${index}`} aria-selected={selected === index} aria-controls="viewer-panel" tabIndex={selected === index ? 0 : -1} onClick={() => setSelected(index)} onKeyDown={event => {
          let next = index;
          if (event.key === (locale === 'ar' ? 'ArrowLeft' : 'ArrowRight')) next = (index + 1) % viewerStates.length;
          else if (event.key === (locale === 'ar' ? 'ArrowRight' : 'ArrowLeft')) next = (index + viewerStates.length - 1) % viewerStates.length;
          else if (event.key === 'Home') next = 0;
          else if (event.key === 'End') next = viewerStates.length - 1;
          else return;
          event.preventDefault(); setSelected(next); tabs.current[next]?.focus();
        }}><state.icon size={23} weight={selected === index ? 'fill' : 'regular'} /><span>{t(state.label)}</span></button>)}
      </div><div id="viewer-panel" role="tabpanel" tabIndex={0} aria-labelledby={`viewer-tab-${selected}`}><h3>{t(current.title)}</h3><p>{t(current.text)}</p></div><a className="text-link light-link" href={`${docs}/preview.md`}>{t("How the viewer works")} <ArrowUpRight className="directional-arrow" size={18} /></a></div>
    </div>
  </div></section>;
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
  return <section className="section install-section" id="get-started" aria-labelledby="install-heading"><div className="container install-layout"><div><span className="eyebrow">{t("START LOCAL")}</span><h2 id="install-heading">{t("A place for your")}<br />{t("agent to begin.")}</h2><p className="section-intro">{t("Install Orbit, connect your agent, and open its first workspace.")}</p><a className="text-link" href={`${docs}/agent-install.md`}>{t("Read the installation guide")} <ArrowUpRight className="directional-arrow" size={19} /></a></div>
    <div className="installation"><div className="code-top"><span><TerminalWindow size={19} />{t("In your terminal")}</span><button className="copy-button" onClick={copy} aria-label={t("Copy installation commands")}>{copyStatus === t('Copied') ? <Check size={17} /> : <Copy size={17} />}{copyStatus === t('Copied') ? t('Copied') : t('Copy')}</button></div><pre dir="ltr" tabIndex={0} aria-label={t("Installation commands")}><code>{install}</code></pre><span className="copy-status" role="status">{copyStatus}</span>
    <p className="prerequisites">{t("Linux with user cgroup delegation, Bun and Chrome/Chromium. Native apps need the")} <a href={`${docs}/fedora-results.md`}>{t("Fedora setup")}</a>.</p><div className="alpha-note"><span className="alpha-dot" /><div><strong>{t("Experimental alpha")}</strong><p>{t("Measured on Fedora 44 with wlroots. Other platforms: not measured.")} <a href={`${docs}/support-tiers.md`}>{t("See support tiers")}</a>.</p></div></div></div>
  </div></section>;
}

function Landing() {
  const { locale, t } = useCopy();
  return <><a className="skip-link" href="#main">{t("Skip to content")}</a><div id="top" /><Header /><main id="main">
    <section className="hero" aria-labelledby="hero-heading"><div className="container"><div className="hero-copy"><span className="eyebrow hero-eyebrow"><span className="status-dot" />{t("OPEN SOURCE. ON YOUR MACHINE.")}</span><h1 id="hero-heading">{t("Your agent has work.")}<br />{t("You have your own.")}</h1><p>{t("Give your AI agent a private browser or display.")}<br className="desktop-break" />{t("Keep your desktop, your focus, and your flow.")}</p><div className="hero-actions"><a className="button" href="#get-started">{t("Get started")} <ArrowRight className="directional-arrow" size={20} /></a><a className="button button-outline" href={repo}><GithubLogo weight="fill" size={23} />{t("View on GitHub")}</a></div><span className="hero-note">{t("Experimental alpha")} <span>·</span> Apache-2.0 <span>·</span>{t("No telemetry")}</span></div>
      <figure className="hero-figure"><picture><source media="(max-width: 700px)" srcSet="/images/hero-workspaces-mobile.webp" /><img src="/images/hero-workspaces.webp" width="1870" height="841" fetchPriority="high" alt={t("You work at your own desk while an agent uses separate browser and application windows beside it")} /></picture><figcaption><span>{t("Your desktop. Your rhythm.")}</span><span>{t("The agent’s own workspace.")}</span></figcaption></figure>
    </div></section>
    <section className="problem-section" id="why-orbit" aria-labelledby="problem-heading"><div className="container problem-layout"><span className="eyebrow">{t("THE PROBLEM")}</span><div><h2 id="problem-heading">{t("One desktop.")}<br />{t("Two things competing.")}</h2><p>{t("When an agent works on your screen, its clicks, windows and typing get in the way of yours. You end up waiting for your own computer.")}</p><p className="problem-answer">{t("You should both be able to keep working.")}</p></div></div></section>
    <section className="section solution-section" id="how-it-works" aria-labelledby="solution-heading"><div className="container"><div className="solution-layout"><div><span className="eyebrow">{t("THE ORBIT WAY")}</span><h2 id="solution-heading">{t("Separate spaces.")}<br />{t("Same machine.")}</h2><p className="section-intro">{t("Orbit opens a browser or private display for your agent. Your windows, pointer and personal browser stay out of its way.")}</p><a className="text-link" href={`${docs}/architecture.md`}>{t("See the architecture")} <ArrowUpRight className="directional-arrow" size={18} /></a></div><img className="spaces-art" src="/images/private-spaces.webp" width="1518" height="1036" loading="lazy" alt={t("Two hand drawn windows: a private browser and a native application on a private display")} /></div>
      <div className="benefits"><article><Browser size={29} /><h3>{t("Keep your browser yours.")}</h3><p>{t("Fresh browser sessions, separate from your personal profile.")}</p></article><article><Monitor size={29} /><h3>{t("Keep using your desktop.")}</h3><p>{t("Native applications run on the agent’s private display.")}</p></article><article><TerminalWindow size={29} /><h3>{t("Bring your agent.")}</h3><p>{t("Connect a tool-capable agent host through MCP or the CLI.")}</p></article></div>
      <details className="architecture"><summary>{t("A little more on how it fits together")} <CaretDown size={18} /></summary><div className="architecture-body"><ol className="architecture-flow"><li><TerminalWindow size={27} /><strong>{t("Your agent")}</strong><span>{t("MCP or CLI")}</span></li><li><ArrowRight className="directional-arrow" size={20} aria-hidden="true" /><strong>{t("Orbit broker")}</strong><span>{t("Local session manager")}</span></li><li><Browser size={27} /><strong>{t("Private workspace")}</strong><span>{t("Browser or display")}</span></li></ol><p>{t("The optional viewer connects to the broker so you can watch, pause, take over and resume. Your own desktop stays separate.")}</p><a className="text-link" href={`${docs}/architecture.md`}>{t("Read the technical details")} <ArrowUpRight className="directional-arrow" size={16} /></a></div></details>
    </div></section>
    <Viewer /><Install />
    <section className="faq-section" aria-labelledby="questions-heading"><div className="container faq-layout"><div><span className="eyebrow">{t("GOOD TO KNOW")}</span><h2 id="questions-heading">{t("A few clear answers.")}</h2></div><div className="faqs">
      <details><summary>{t("Is Orbit a security sandbox?")} <CaretDown size={18} /></summary><p>{t("No. Orbit separates displays and input, but applications retain your OS user’s permissions.")} <a href={`${repo}/blob/main/SECURITY.md`}>{t("Read the security model")}</a>.</p></details>
      <details><summary>{t("Does it work with every AI agent?")} <CaretDown size={18} /></summary><p>{t("Your agent host needs custom tools through MCP or a shell. Closed applications without custom tool support are not automatically compatible.")} <a href={`${docs}/connectors.md`}>{t("See connector setup")}</a>.</p></details>
      <details><summary>{t("Does anything get sent to Orbit?")} <CaretDown size={18} /></summary><p>{t("Orbit has no telemetry, crash uploads or usage counters. Agent tools and the websites you visit still make their own network requests.")}</p></details>
    </div></div></section>
    <section className="support-section" id="support" aria-labelledby="support-heading"><div className="container support-layout"><div className="support-heading"><Heart size={30} weight="duotone" /><span className="eyebrow">{t("BUILT IN THE OPEN")}</span><h2 id="support-heading">{t("A little coffee.")}<br />{t("More room to build.")}</h2></div><div className="support-copy"><p>{t("Orbit is free and open source. If it makes your workday a little better, you can support the person building it.")}</p><a className="coffee-link" href="https://www.buymeacoffee.com/m7mmadomar" target="_blank" rel="noopener noreferrer" aria-label={t("Support Sbarah on Buy Me a Coffee, opens in a new tab")}>{locale === 'ar' ? <span className="arabic-coffee">☕ اعزمني على قهوة</span> : <img src="/images/coffee-button.webp" width="217" height="61" loading="lazy" alt="Buy me a coffee" />}</a><span className="support-note">{t("Always optional. Always appreciated.")}</span></div></div></section>
  </main><footer><div className="container footer-top"><Brand /><p>{t("A workspace beside yours.")}</p><div className="footer-links"><a href={repo}>GitHub <ArrowUpRight className="directional-arrow" size={14} /></a><a href={`${repo}/blob/main/CONTRIBUTING.md`}>{t("Contribute")}</a><a href={`${repo}/blob/main/LICENSE`}>Apache-2.0</a></div></div><div className="container footer-bottom"><span>{t("Built by")} <a href="https://github.com/M7MMAD-OMAR">{t("Sbarah")}</a>{t(". Shared with everyone.")}</span><a href="#top">{t("Back to top")} <ArrowUpRight className="directional-arrow" size={15} /></a></div></footer></>;
}

export default function App({ locale = 'en' }: { locale?: Locale }) {
  return <LocaleContext.Provider value={locale}><Landing /></LocaleContext.Provider>;
}
