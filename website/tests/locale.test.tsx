import { expect, test } from 'bun:test';
import { renderToString } from 'react-dom/server';
import App from '../src/App';
import { arabic } from '../src/locale';
import { release, releaseForVersion } from '../src/release';
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
    if (release.windowsCompanion) {
      expect(html).toContain(`href="${release.windowsCompanion.installer}"`);
      expect(html).toContain(`href="${release.windowsCompanion.checksum}"`);
    } else expect(html).not.toContain('.exe');
    expect(html).not.toContain('.msi');
    expect(html).toContain(locale === 'ar' ? 'نسخة التطوير' : 'Development checkout');
    expect(html).toContain(locale === 'ar' ? 'مع انتظار 72 ساعة' : '72-hour release delay');
    expect(html).toContain(locale === 'ar' ? 'لا توجد آلية فتح على Windows' : 'Windows, macOS and other Linux compositors have no opening adapter.');
  }
});

test('Windows companion availability is explicit, never inferred from a version threshold', () => {
  for (const historicalOrUnapproved of ['0.4.2', '0.4.4', '0.5.0', '1.0.0', '0.4.3-rc.1'])
    expect(releaseForVersion(historicalOrUnapproved).windowsCompanion).toBeNull();
  const companion = releaseForVersion('0.4.3').windowsCompanion;
  expect(companion).not.toBeNull();
  expect(companion?.name).toBe('SbarOrbit-0.4.3-windows-x64-setup.exe');
  expect(companion?.installer).toBe('https://github.com/M7MMAD-OMAR/sbar-orbit/releases/download/v0.4.3/SbarOrbit-0.4.3-windows-x64-setup.exe');
  expect(companion?.checksum).toBe(companion?.installer + '.sha256');
  expect(companion?.signing).toBe('unsigned');
  expect(companion?.nativeApplicationControl).toBe('unsupported');
});

test('both languages preserve source-only 0.4.2 and gate future Windows links without module mocks', () => {
  for (const selectedVersion of ['0.4.2', '0.4.3', '0.4.4']) for (const locale of ['en', 'ar'] as const) {
    const info = releaseForVersion(selectedVersion);
    const html = renderToString(<App locale={locale} releaseInfo={info} />);
    for (const url of [info.url, info.source, info.sourceChecksum, info.package, info.packageChecksum])
      expect(html).toContain('href="' + url + '"');
    expect(html).toContain('<bdi dir="ltr">' + selectedVersion + '</bdi>');
    if (info.windowsCompanion) {
      expect(html).toContain('href="' + info.windowsCompanion.installer + '"');
      expect(html).toContain('href="' + info.windowsCompanion.checksum + '"');
      expect(html).toContain(locale === 'ar' ? 'دون توقيع رقمي' : 'unsigned');
      expect(html).toContain(locale === 'ar' ? 'التحكم الأصلي بتطبيقات Windows غير مدعوم' : 'Native control of original Windows applications is unsupported.');
      expect(html).toContain(locale === 'ar' ? 'بعد موافقتك الصريحة فقط' : 'only with your explicit consent');
      expect(html).toContain(locale === 'ar' ? 'لا يتضمن المثبت Bun' : 'Bun is not bundled');
      expect(html).toContain('WebView2 Runtime');
      expect(html).toContain(locale === 'ar' ? 'ولا يثبته خفية' : 'does not silently install it');
      expect(html).toContain(locale === 'ar' ? 'وأبق وسائل الحماية مفعلة' : 'keep security protections enabled');
      expect(html).toContain(locale === 'ar' ? 'أوامر نسخة التطوير' : 'Development checkout commands');
    } else {
      expect(html).not.toContain('.exe');
      expect(html).not.toContain('windows-companion');
      expect(html).toContain(locale === 'ar' ? 'هذه حزم مصدر' : 'These are source packages');
    }
    expect(html).not.toContain('update-overlay.zip');
    expect(html).not.toContain('.msi');
    expect(html).not.toContain('/releases/latest');
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

test("English and Arabic metadata describe explicit handoff without an obsolete hold", async () => {
  const en = await Bun.file(new URL("../index.html", import.meta.url)).text();
  const prerender = await Bun.file(new URL("../scripts/prerender.tsx", import.meta.url)).text();
  expect(en).not.toContain("Input and capture remain on hold");
  expect(en.match(/Input and capture use explicit handoff/g)).toHaveLength(2);
  expect(prerender).not.toContain("الإدخال والتقاط الشاشة ما زالا موقوفين");
  expect(prerender.match(/يبدأ الإدخال والتقاط الشاشة بتسليم صريح/g)).toHaveLength(2);
});
