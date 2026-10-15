// Vitest shim for the Nitro auto-import globals the /v1 route handlers and
// the startup plugin reference. Nitro injects these identifiers at build
// time; a unit test must provide them before any route module evaluates.
import { defineEventHandler, getRouterParam, setResponseStatus } from "h3";

Object.assign(globalThis, {
  defineEventHandler,
  getRouterParam,
  setResponseStatus,
  // Nitro's plugin helper is the identity over the plugin function here.
  defineNitroPlugin: (plugin: unknown) => plugin,
});
