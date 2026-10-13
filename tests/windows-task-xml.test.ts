import { expect, test } from "bun:test";
import { brokerTaskXml, taskActionMatches } from "../src/windows-autostart";
import { taskEnvironmentMatches } from "../src/installed-startup-diagnostic";
import { taskOwned } from "../src/managed-lifecycle";

function fixture() {
  const launcher = "C:\\Orbit\\prefix\\bin\\sbar-orbit.cmd", sid = "S-1-5-21-123";
  const environment = { ORBIT_MANAGED_ENV_SCHEMA: "1", ORBIT_BUN: "C:\\Runtime\\runtime.exe" };
  return { launcher, sid, environment, diagnostic: brokerTaskXml(launcher, sid, environment), owned: brokerTaskXml(launcher, sid, environment, true) };
}

test("registered task XML refuses forbidden character data", () => {
  const f = fixture();
  expect(taskActionMatches(f.diagnostic, f.diagnostic)).toBe(true);
  expect(taskEnvironmentMatches(f.diagnostic, f.environment, f.launcher)).toBe(true);
  expect(taskOwned(f.owned, f.launcher, f.sid)).toBe(true);
  const malformed = (xml: string) => xml.replace("</RegistrationInfo>", "]]></RegistrationInfo>");
  expect(taskActionMatches(malformed(f.diagnostic), f.diagnostic)).toBe(false);
  expect(taskEnvironmentMatches(malformed(f.diagnostic), f.environment, f.launcher)).toBe(false);
  expect(taskOwned(malformed(f.owned), f.launcher, f.sid)).toBe(false);
});
test("registered task XML refuses invalid raw scalar", () => {
  const f = fixture();
  expect(taskActionMatches(f.diagnostic, f.diagnostic)).toBe(true);
  expect(taskOwned(f.owned, f.launcher, f.sid)).toBe(true);
  const malformed = (xml: string) => xml.replace("</RegistrationInfo>", "\uFFFF</RegistrationInfo>");
  expect(taskActionMatches(malformed(f.diagnostic), f.diagnostic)).toBe(false);
  expect(taskEnvironmentMatches(malformed(f.diagnostic), f.environment, f.launcher)).toBe(false);
  expect(taskOwned(malformed(f.owned), f.launcher, f.sid)).toBe(false);
});
test("registered task XML applies raw and referenced XML 1.0 scalar boundaries", () => {
  const f = fixture();
  const legal = [0x9, 0xa, 0xd, 0x20, 0x7f, 0x85, 0xd7ff, 0xe000, 0xfeff, 0xfffd, 0x10000, 0x1ffff, 0x10ffff];
  const illegal = [0, 8, 0xb, 0xc, 0x1f, 0xd800, 0xdbff, 0xdc00, 0xdfff, 0xfffe, 0xffff, 0x110000];
  for (const [points, admitted] of [[legal, true], [illegal, false]] as const) {
    for (const point of points) {
      const representations = [`&#${point};`, `&#x${point.toString(16)};`];
      if (point <= 0x10ffff) representations.push(String.fromCodePoint(point));
      for (const value of representations) {
        const mutate = (xml: string) => xml.replace("</RegistrationInfo>", `${value}</RegistrationInfo>`);
        expect(taskActionMatches(mutate(f.diagnostic), f.diagnostic)).toBe(admitted);
        expect(taskEnvironmentMatches(mutate(f.diagnostic), f.environment, f.launcher)).toBe(admitted);
        expect(taskOwned(mutate(f.owned), f.launcher, f.sid)).toBe(admitted);
        const attribute = (xml: string) => xml.replace("<RegistrationInfo>", `<RegistrationInfo fixture="${value}">`);
        expect(taskActionMatches(attribute(f.diagnostic), f.diagnostic)).toBe(admitted);
        expect(taskEnvironmentMatches(attribute(f.diagnostic), f.environment, f.launcher)).toBe(admitted);
        expect(taskOwned(attribute(f.owned), f.launcher, f.sid)).toBe(admitted);
      }
    }
  }
  for (const value of ["\ud800x", "x\udfff", "\ud800\ud800", "\udfff\udfff", "&#x;", "&#-1;", "&#1114112;", "&#999999999999999999999999;"]) {
    const mutate = (xml: string) => xml.replace("</RegistrationInfo>", `${value}</RegistrationInfo>`);
    expect(taskActionMatches(mutate(f.diagnostic), f.diagnostic)).toBe(false);
    expect(taskEnvironmentMatches(mutate(f.diagnostic), f.environment, f.launcher)).toBe(false);
    expect(taskOwned(mutate(f.owned), f.launcher, f.sid)).toBe(false);
  }
});
test("registered task XML distinguishes attribute content and declaration placement", () => {
  const f = fixture();
  const declaration = /^<\?xml[^?]*\?>\s*/;
  const legal = [
    (xml: string) => xml.replace("<RegistrationInfo>", '<RegistrationInfo fixture="]]>">'),
    (xml: string) => xml.replace("<RegistrationInfo>", "<RegistrationInfo fixture=']]>'>"),
    (xml: string) => xml.replace("</RegistrationInfo>", "]]&gt;</RegistrationInfo>"),
    (xml: string) => xml.replace("</RegistrationInfo>", "&#93;&#93;&#62;</RegistrationInfo>"),
    (xml: string) => "\uFEFF" + xml,
    (xml: string) => "\uFEFF \t\r\n" + xml.replace(declaration, ""),
    (xml: string) => xml.replace('encoding="UTF-16"', 'encoding="utf-8"'),
    (xml: string) => " \t\r\n" + xml.replace(declaration, "") + "\r\n ",
    (xml: string) => xml.replace(/>\s+</g, ">\r\n\t<"),
  ];
  for (const mutate of legal) {
    expect(taskActionMatches(mutate(f.diagnostic), f.diagnostic)).toBe(true);
    expect(taskEnvironmentMatches(mutate(f.diagnostic), f.environment, f.launcher)).toBe(true);
    expect(taskOwned(mutate(f.owned), f.launcher, f.sid)).toBe(true);
  }
  const illegal = [
    (xml: string) => " " + xml,
    (xml: string) => "\n" + xml,
    (xml: string) => "\uFEFF\uFEFF" + xml,
    (xml: string) => " \uFEFF" + xml,
    (xml: string) => "\u00a0" + xml.replace(declaration, ""),
    (xml: string) => xml + "\uFEFF",
    (xml: string) => xml + "\u00a0",
    (xml: string) => xml.replace('<Actions Context="Author">', '<Actions\u00a0Context="Author">'),
    (xml: string) => xml.replace("<RegistrationInfo>", '<RegistrationInfo fixture="raw<value">'),
    (xml: string) => xml.replace("<RegistrationInfo>", '<RegistrationInfo fixture="&unknown;">'),
  ];
  for (const mutate of illegal) {
    expect(taskActionMatches(mutate(f.diagnostic), f.diagnostic)).toBe(false);
    expect(taskEnvironmentMatches(mutate(f.diagnostic), f.environment, f.launcher)).toBe(false);
    expect(taskOwned(mutate(f.owned), f.launcher, f.sid)).toBe(false);
  }
});
