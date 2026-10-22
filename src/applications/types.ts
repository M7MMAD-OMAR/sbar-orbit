export type Application = {
  id: string; name: string; executable: string; packaging: "local" | "flatpak" | "bundle" | "registry" | "unknown";
  sources: string[]; runningPids: number[]; profileDirectories: string[];
  channel: "not measured" | "release" | "stable" | "beta" | "nightly"; channelSource?: string;
  version?: string; lastUsed?: string;
  flatpak?: FlatpakReference & { deploymentFiles: string };
  profileNames?: string[]; profileResolutionFailed?: boolean;
  availability?: "verified" | "unresolved";
  registrationIds?: string[];
};
export type FlatpakReference = { appId: string; branch?: string; architecture?: string; installation?: string };
export type DiscoveryOptions = {
  home?: string; env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform; query?: string;
  applicationDirectories?: string[]; bundleRoots?: string[]; procRoot?: string;
  registryEntries?: { id: string; executable: string }[]; includeRunning?: boolean;
  recentFile?: string;
  metadataProbe?: (reference: FlatpakReference) => Promise<string | undefined>;
};

export type ResolvedApplication = { argv: string[]; cwd?: string; busName?: string; applicationId: string };
