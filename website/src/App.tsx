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
  return <a href="#top" className="brand" aria-label="Sbar Orbit home"><img src={`/brand/logo${white ? '-white' : ''}.png`} width="181" height="60" alt="sbarorbit" /></a>;
}

function Header() {
  const [open, setOpen] = useState(false);
  const toggle = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape') { setOpen(false); toggle.current?.focus(); } };
    document.addEventListener('keydown', close);
    return () => document.removeEventListener('keydown', close);
  }, [open]);
  return <header className="header"><div className="container nav-wrap"><Brand />
    <button ref={toggle} className="menu-toggle" aria-label={open ? 'Close navigation' : 'Open navigation'} aria-expanded={open} aria-controls="navigation" onClick={() => setOpen(!open)}>{open ? <X size={25} /> : <List size={25} />}</button>
    <nav id="navigation" aria-label="Main navigation" className={open ? 'nav is-open' : 'nav'} onClick={() => setOpen(false)}>
      <a href="#why-orbit">Why Orbit</a><a href={`${repo}#start`}>Docs <ArrowUpRight size={13} /></a><a href="#support">Support</a><a className="button button-small" href="#get-started">Get started <ArrowRight size={16} /></a>
    </nav>
  </div></header>;
}

function Viewer() {
  const [selected, setSelected] = useState(0);
  const current = viewerStates[selected] ?? viewerStates[0];
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);
  if (!current) return null;
  return <section className="viewer-section" id="in-control" aria-labelledby="viewer-heading"><div className="container">
    <div className="section-heading viewer-heading"><span className="eyebrow">YOU STAY IN CONTROL</span><h2 id="viewer-heading">Let it work.<br />Step in when you want.</h2><p>A private workspace, with a door you can open.</p></div>
    <div className="viewer-layout"><img className="viewer-art" src="/images/viewer-control.webp" width="1200" height="850" loading="lazy" alt="A person watching the agent’s application windows through the Orbit viewer" />
      <div className="viewer-explanation"><span className="small-label">EXPLORE THE VIEWER</span><div className="viewer-tabs" role="tablist" aria-label="Viewer capabilities">
        {viewerStates.map((state, index) => <button key={state.label} ref={element => { tabs.current[index] = element; }} role="tab" id={`viewer-tab-${index}`} aria-selected={selected === index} aria-controls="viewer-panel" tabIndex={selected === index ? 0 : -1} onClick={() => setSelected(index)} onKeyDown={event => {
          let next = index;
          if (event.key === 'ArrowRight') next = (index + 1) % viewerStates.length;
          else if (event.key === 'ArrowLeft') next = (index + viewerStates.length - 1) % viewerStates.length;
          else if (event.key === 'Home') next = 0;
          else if (event.key === 'End') next = viewerStates.length - 1;
          else return;
          event.preventDefault(); setSelected(next); tabs.current[next]?.focus();
        }}><state.icon size={23} weight={selected === index ? 'fill' : 'regular'} /><span>{state.label}</span></button>)}
      </div><div id="viewer-panel" role="tabpanel" tabIndex={0} aria-labelledby={`viewer-tab-${selected}`}><h3>{current.title}</h3><p>{current.text}</p></div><a className="text-link light-link" href={`${docs}/preview.md`}>How the viewer works <ArrowUpRight size={18} /></a></div>
    </div>
  </div></section>;
}

function Install() {
  const [copyStatus, setCopyStatus] = useState('');
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  async function copy() {
    try { await navigator.clipboard.writeText(install); setCopyStatus('Copied'); }
    catch { setCopyStatus('Select the commands below to copy.'); }
    clearTimeout(timer.current); timer.current = setTimeout(() => setCopyStatus(''), 4000);
  }
  return <section className="section install-section" id="get-started" aria-labelledby="install-heading"><div className="container install-layout"><div><span className="eyebrow">START LOCAL</span><h2 id="install-heading">A place for your<br />agent to begin.</h2><p className="section-intro">Install Orbit, connect your agent, and open its first workspace.</p><a className="text-link" href={`${docs}/agent-install.md`}>Read the installation guide <ArrowUpRight size={19} /></a></div>
    <div className="installation"><div className="code-top"><span><TerminalWindow size={19} /> In your terminal</span><button className="copy-button" onClick={copy} aria-label="Copy installation commands">{copyStatus === 'Copied' ? <Check size={17} /> : <Copy size={17} />}{copyStatus === 'Copied' ? 'Copied' : 'Copy'}</button></div><pre tabIndex={0} aria-label="Installation commands"><code>{install}</code></pre><span className="copy-status" role="status">{copyStatus}</span>
    <p className="prerequisites">Linux with user cgroup delegation, Bun and Chrome/Chromium. Native apps need the <a href={`${docs}/fedora-results.md`}>Fedora setup</a>.</p><div className="alpha-note"><span className="alpha-dot" /><div><strong>Experimental alpha</strong><p>Measured on Fedora 44 with wlroots. Other platforms: not measured. <a href={`${docs}/support-tiers.md`}>See support tiers</a>.</p></div></div></div>
  </div></section>;
}

export default function App() {
  return <><a className="skip-link" href="#main">Skip to content</a><div id="top" /><Header /><main id="main">
    <section className="hero" aria-labelledby="hero-heading"><div className="container"><div className="hero-copy"><span className="eyebrow hero-eyebrow"><span className="status-dot" /> OPEN SOURCE. ON YOUR MACHINE.</span><h1 id="hero-heading">Your agent has work.<br />You have your own.</h1><p>Give your AI agent a private browser or display.<br className="desktop-break" /> Keep your desktop, your focus, and your flow.</p><div className="hero-actions"><a className="button" href="#get-started">Get started <ArrowRight size={20} /></a><a className="button button-outline" href={repo}><GithubLogo weight="fill" size={23} /> View on GitHub</a></div><span className="hero-note">Experimental alpha <span>·</span> Apache-2.0 <span>·</span> No telemetry</span></div>
      <figure className="hero-figure"><picture><source media="(max-width: 700px)" srcSet="/images/hero-workspaces-mobile.webp" /><img src="/images/hero-workspaces.webp" width="1870" height="841" fetchPriority="high" alt="You work at your own desk while an agent uses separate browser and application windows beside it" /></picture><figcaption><span>Your desktop. Your rhythm.</span><span>The agent’s own workspace.</span></figcaption></figure>
    </div></section>
    <section className="problem-section" id="why-orbit" aria-labelledby="problem-heading"><div className="container problem-layout"><span className="eyebrow">THE PROBLEM</span><div><h2 id="problem-heading">One desktop.<br />Two things competing.</h2><p>When an agent works on your screen, its clicks, windows and typing get in the way of yours. You end up waiting for your own computer.</p><p className="problem-answer">You should both be able to keep working.</p></div></div></section>
    <section className="section solution-section" id="how-it-works" aria-labelledby="solution-heading"><div className="container"><div className="solution-layout"><div><span className="eyebrow">THE ORBIT WAY</span><h2 id="solution-heading">Separate spaces.<br />Same machine.</h2><p className="section-intro">Orbit opens a browser or private display for your agent. Your windows, pointer and personal browser stay out of its way.</p><a className="text-link" href={`${docs}/architecture.md`}>See the architecture <ArrowUpRight size={18} /></a></div><img className="spaces-art" src="/images/private-spaces.webp" width="1518" height="1036" loading="lazy" alt="Two hand drawn windows: a private browser and a native application on a private display" /></div>
      <div className="benefits"><article><Browser size={29} /><h3>Keep your browser yours.</h3><p>Fresh browser sessions, separate from your personal profile.</p></article><article><Monitor size={29} /><h3>Keep using your desktop.</h3><p>Native applications run on the agent’s private display.</p></article><article><TerminalWindow size={29} /><h3>Bring your agent.</h3><p>Connect a tool-capable agent host through MCP or the CLI.</p></article></div>
      <details className="architecture"><summary>A little more on how it fits together <CaretDown size={18} /></summary><div className="architecture-body"><ol className="architecture-flow"><li><TerminalWindow size={27} /><strong>Your agent</strong><span>MCP or CLI</span></li><li><ArrowRight size={20} aria-hidden="true" /><strong>Orbit broker</strong><span>Local session manager</span></li><li><Browser size={27} /><strong>Private workspace</strong><span>Browser or display</span></li></ol><p>The optional viewer connects to the broker so you can watch, pause, take over and resume. Your own desktop stays separate.</p><a className="text-link" href={`${docs}/architecture.md`}>Read the technical details <ArrowUpRight size={16} /></a></div></details>
    </div></section>
    <Viewer /><Install />
    <section className="faq-section" aria-labelledby="questions-heading"><div className="container faq-layout"><div><span className="eyebrow">GOOD TO KNOW</span><h2 id="questions-heading">A few clear answers.</h2></div><div className="faqs">
      <details><summary>Is Orbit a security sandbox? <CaretDown size={18} /></summary><p>No. Orbit separates displays and input, but applications retain your OS user’s permissions. <a href={`${repo}/blob/main/SECURITY.md`}>Read the security model</a>.</p></details>
      <details><summary>Does it work with every AI agent? <CaretDown size={18} /></summary><p>Your agent host needs custom tools through MCP or a shell. Closed applications without custom tool support are not automatically compatible. <a href={`${docs}/connectors.md`}>See connector setup</a>.</p></details>
      <details><summary>Does anything get sent to Orbit? <CaretDown size={18} /></summary><p>Orbit has no telemetry, crash uploads or usage counters. Agent tools and the websites you visit still make their own network requests.</p></details>
    </div></div></section>
    <section className="support-section" id="support" aria-labelledby="support-heading"><div className="container support-layout"><div className="support-heading"><Heart size={30} weight="duotone" /><span className="eyebrow">BUILT IN THE OPEN</span><h2 id="support-heading">A little coffee.<br />More room to build.</h2></div><div className="support-copy"><p>Orbit is free and open source. If it makes your workday a little better, you can support the person building it.</p><a className="coffee-link" href="https://www.buymeacoffee.com/m7mmadomar" target="_blank" rel="noopener noreferrer" aria-label="Support Sbarah on Buy Me a Coffee, opens in a new tab"><img src="/images/coffee-button.webp" width="217" height="61" loading="lazy" alt="Buy me a coffee" /></a><span className="support-note">Always optional. Always appreciated.</span></div></div></section>
  </main><footer><div className="container footer-top"><Brand /><p>A workspace beside yours.</p><div className="footer-links"><a href={repo}>GitHub <ArrowUpRight size={14} /></a><a href={`${repo}/blob/main/CONTRIBUTING.md`}>Contribute</a><a href={`${repo}/blob/main/LICENSE`}>Apache-2.0</a></div></div><div className="container footer-bottom"><span>Built by <a href="https://github.com/M7MMAD-OMAR">Sbarah</a>. Shared with everyone.</span><a href="#top">Back to top <ArrowUpRight size={15} /></a></div></footer></>;
}
