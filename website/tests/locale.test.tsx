import { expect, test } from 'bun:test';
import { renderToString } from 'react-dom/server';
import App from '../src/App';
import { arabic } from '../src/locale';
import { release } from '../src/release';
import { version } from '../../package.json';

test('release links use the runtime package version in both prerendered languages', () => {
  const repository = 'https://github.com/M7MMAD-OMAR/sbar-orbit';
  const downloads = `${repository}/releases/download/v${version}`;
  expect(release.version).toBe(version);
  expect(release.url).toBe(`${repository}/releases/tag/v${version}`);
  expect(release.source).toBe(`${downloads}/sbar-orbit-${version}-source.tar.gz`);
  expect(release.package).toBe(`${downloads}/sbar-orbit-${version}.tgz`);
  expect(release.sourceChecksum).toBe(`${release.source}.sha256`);
  expect(release.packageChecksum).toBe(`${release.package}.sha256`);
  for (const locale of ['en', 'ar'] as const) {
    const html = renderToString(<App locale={locale} />);
    for (const url of [release.url, release.source, release.sourceChecksum, release.package, release.packageChecksum])
      expect(html).toContain(`href="${url}"`);
    expect(html).toContain(`<bdi dir="ltr">${version}</bdi>`);
    expect(html).not.toContain('/releases/latest');
    expect(html).not.toContain('.exe');
    expect(html).not.toContain('.msi');
    expect(html).toContain(locale === 'ar' ? 'نسخة التطوير' : 'Development checkout');
    expect(html).toContain(locale === 'ar' ? 'مع انتظار 72 ساعة' : '72-hour release delay');
    expect(html).toContain(locale === 'ar' ? 'لا توجد آلية فتح على Windows' : 'Windows, macOS and other Linux compositors have no opening adapter.');
  }
});

test('every copy lookup has an Arabic rewrite', async () => {
  const source = await Bun.file(new URL('../src/App.tsx', import.meta.url)).text();
  for (const match of source.matchAll(/\bt\(("(?:[^"\\]|\\.)*"|'[^']*')\)/g)) {
    const literal = match[1];
    if (!literal) continue;
    const key = literal.startsWith('"') ? JSON.parse(literal) : literal.slice(1, -1);
    expect(arabic[key], key).toBeTruthy();
  }
});

test('Arabic renders without JavaScript, keeps shell commands intact and offers English', () => {
  const html = renderToString(<App locale="ar" />);
  expect(html).toContain('افتح تطبيقات نظامك الأصلية.');
  expect(html).toContain('لوكيلك عمل.');
  expect(html).not.toContain('وعملك يستمر دون مقاطعة.');
  expect(html).toContain('ادعم المشروع بفنجان قهوة');
  expect(html).toContain('href="/" lang="en"');
  expect(html).toContain('dir="ltr"');
  expect(html).toContain('git clone https://github.com/M7MMAD-OMAR/sbar-orbit');
  expect(html).not.toContain('Your agent has work.');
});

test('English remains available with an Arabic language link', () => {
  const html = renderToString(<App locale="en" />);
  expect(html).toContain('Your agent has work.');
  expect(html).toContain('href="/ar/" lang="ar"');
});

test('onboarding offers desktop discovery and states measured platform support', () => {
  for (const locale of ['en', 'ar'] as const) {
    const html = renderToString(<App locale={locale} />);
    expect(html).not.toContain('export ORBIT_SOCKET');
    expect(html).not.toContain('Version 0.1.1');
    expect(html).toContain('native-handoff-incident.md');
    expect(html).toContain('support-tiers.md');
    expect(html).toContain('sbar-orbit applications');
    expect(html).toContain('Fedora');
    expect(html).toContain('Windows');
    expect(html).toContain('macOS');
  }
});

test('essential guidance is visible without disclosures or JavaScript', () => {
  const html=renderToString(<App locale="ar" />);
  expect(html).not.toContain('<details');
  expect(html).toContain('id="architecture"');
  expect(html).toContain('id="guide"');
  expect(html).toContain('sbar-orbit connector-config');
  expect(html).toContain('sbar-orbit applications');
});

test('public diagrams describe the current original application route without a retired viewer', () => {
  const html = renderToString(<App locale="en" />);
  expect(html).toContain('native-workspaces.svg');
  expect(html).toContain('Diagram, not a live demonstration');
  expect(html).toContain('Registered app, owner controls, workspace');
  expect(html).toContain('Input uses an explicit handoff.');
  expect(html).not.toMatch(/private desktop|private workspace|take over|optional viewer|viewer-control\.webp/i);
});

test('Arabic copy and metadata contain no vocalization marks or long dashes', async () => {
  const texts = [Object.values(arabic).join(' '), renderToString(<App locale="ar" />), await Bun.file(new URL('../scripts/prerender.tsx', import.meta.url)).text()];
  for (const text of texts) expect(text).not.toMatch(/[\u064b-\u0652\u0670\u2013\u2014]/u);
});
