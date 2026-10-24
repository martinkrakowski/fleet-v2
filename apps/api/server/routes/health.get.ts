// GET /health — liveness probe (no configuration detail).
// `defineEventHandler` is auto-imported by Nitro (see ./.nitro/types).
export default defineEventHandler(() => ({ status: "up" }));
