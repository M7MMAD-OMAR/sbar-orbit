import { version as runtimeVersion } from '../../package.json';

// Source descriptors are not publication proof. Verify CI and all exact assets before deployment.
const repository = 'https://github.com/M7MMAD-OMAR/sbar-orbit';
// Explicit release allowlist, never a version threshold or moving latest feed.
const windowsCompanionVersions: ReadonlySet<string> = new Set(['0.4.3']);

export function releaseForVersion(version: string) {
  const tag = `v${version}`;
  const downloads = `${repository}/releases/download/${tag}`;
  const sourceName = `sbar-orbit-${version}-source.tar.gz`;
  const packageName = `sbar-orbit-${version}.tgz`;
  const installerName = `SbarOrbit-${version}-windows-x64-setup.exe`;
  return Object.freeze({
    version, tag, url: `${repository}/releases/tag/${tag}`,
    source: `${downloads}/${sourceName}`, sourceChecksum: `${downloads}/${sourceName}.sha256`,
    package: `${downloads}/${packageName}`, packageChecksum: `${downloads}/${packageName}.sha256`,
    windowsCompanion: windowsCompanionVersions.has(version) ? Object.freeze({
      name: installerName, installer: `${downloads}/${installerName}`, checksum: `${downloads}/${installerName}.sha256`,
      architecture: 'x64' as const, signing: 'unsigned' as const, nativeApplicationControl: 'unsupported' as const,
    }) : null,
  });
}

export type ReleaseInfo = ReturnType<typeof releaseForVersion>;
// Runtime version is shared with CLI/MCP, not website/package.json.
export const release = releaseForVersion(runtimeVersion);
