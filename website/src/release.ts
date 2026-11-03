import { version } from '../../package.json';

// Runtime version is shared with the CLI/MCP package, not website/package.json.
// Publication/deployment must verify these exact assets before exposing this build.
const repository = 'https://github.com/M7MMAD-OMAR/sbar-orbit';
const tag = `v${version}`;
const downloads = `${repository}/releases/download/${tag}`;
const sourceName = `sbar-orbit-${version}-source.tar.gz`;
const packageName = `sbar-orbit-${version}.tgz`;

export const release = Object.freeze({
  version, tag, url: `${repository}/releases/tag/${tag}`,
  source: `${downloads}/${sourceName}`, sourceChecksum: `${downloads}/${sourceName}.sha256`,
  package: `${downloads}/${packageName}`, packageChecksum: `${downloads}/${packageName}.sha256`,
});
