// Canonical production origin for GregSweeper.
//
// Deliberately HARDCODED to the production domain rather than derived from
// window.location.origin: share and crux links copied from the /test/ build
// must still point at the public site (a runtime-origin base would send a
// tester's shared link to /test/). On a domain move, change this one line and
// everything that builds a public-facing link follows.
export const PROD_SITE_BASE = 'https://gregsweeper.com/';

// Bare host for display contexts (e.g. the share-card footer watermark),
// derived so the domain is defined in exactly one place.
export const PROD_SITE_DOMAIN = new URL(PROD_SITE_BASE).host; // 'gregsweeper.com'
