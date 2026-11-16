// Single place for the visit-statistics settings. Change the host, the
// website id or the allowed hostnames here (or through the env variables),
// and rebuild: vite.config.mjs injects the tag into every built page.
const env = process.env;

export const analytics = {
  host: env.ORBIT_STATS_HOST || 'https://stats.sbarah.com',
  websiteId: env.ORBIT_STATS_WEBSITE_ID || '0ad1716f-c107-4040-83f5-77a60dadd404',
  // Production hostnames only, so local previews and other origins are not counted.
  domains: env.ORBIT_STATS_DOMAINS || 'orbit.sbarah.com',
};

export function analyticsTag({ host, websiteId, domains } = analytics) {
  return `<script defer src="${host}/script.js" data-website-id="${websiteId}" data-domains="${domains}" data-do-not-track="true" data-performance="true" data-errors="true"></script>`;
}

// The heatmap recorder reads only data-website-id (and an optional data-host-url,
// which defaults to the origin of its own src). It has no domain filter attribute.
export function recorderTag({ host, websiteId } = analytics) {
  return `<script defer src="${host}/recorder.js" data-website-id="${websiteId}"></script>`;
}

// A Content-Security-Policy is not set today (see public/_headers). If one is
// added, build its script-src and connect-src from this origin.
export const analyticsOrigin = new URL(analytics.host).origin;
