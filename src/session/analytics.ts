/**
 * bundle entry — see analytics-{query,metrics,render}.
 *
 * The npm `bundle` script builds bin/analytics.bundle.mjs from THIS file, so
 * it stays as the single re-export surface. In-repo callers import from the
 * specific modules; only external consumers use this barrel.
 */

export * from "./analytics-query.js";
export * from "./analytics-metrics.js";
export * from "./analytics-render.js";
