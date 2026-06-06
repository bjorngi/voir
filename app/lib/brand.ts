// Single source of truth for the product name. Update these two
// constants (and the `name` field in package.json) to rebrand the app.
// Everything else — ACP `clientInfo`, README prose, the launcher's
// base-URL flag, etc. — derives from here or is a literal that you
// `grep` once on a rename.

/** Display name shown to humans. */
export const BRAND = "Voir";

/** Machine name: package name, env-var prefix, ACP client id. */
export const BRAND_SLUG = "voir";
