/** Select a configured origin from the actual request Host, never forwarded headers. */
export function createOriginPolicy({origin = '', appOrigin = '', production = false, boundOrigin = () => ''}) {
  function parse(value, setting) {
    if (!value) return null;
    const url = new URL(value);
    if (url.origin !== value || !['http:', 'https:'].includes(url.protocol) || (production && url.protocol !== 'https:')) throw new Error(setting + ' must be an exact HTTPS origin in production');
    return url;
  }
  const canonical = parse(origin, 'COMMUNITY_ORIGIN');
  const installed = parse(appOrigin, 'COMMUNITY_APP_ORIGIN');
  if (installed && !canonical) throw new Error('COMMUNITY_APP_ORIGIN requires COMMUNITY_ORIGIN');
  const origins = [canonical, installed].filter(Boolean);
  if (canonical && installed && canonical.host === installed.host && canonical.origin !== installed.origin) throw new Error('Application origins cannot differ only by scheme');
  return {
    appOrigin: installed?.origin || '',
    forRequest(req) {
      const available = origins.length ? origins : [new URL(boundOrigin())];
      const host = typeof req.headers.host === 'string' ? req.headers.host.toLowerCase() : '';
      return available.find(url => url.host.toLowerCase() === host)?.origin || null;
    },
  };
}
