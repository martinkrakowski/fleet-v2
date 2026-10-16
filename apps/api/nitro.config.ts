import { defineNitroConfig } from "nitropack/config";

// https://nitro.build/config
export default defineNitroConfig({
  srcDir: "server",
  compatibilityDate: "2025-01-01",
  rollupConfig: {
    output: {
      chunkFileNames: (chunkInfo) => {
        const name = chunkInfo.name.replace(/errors?/gi, "wiring-helpers");
        return `chunks/_/${name}.mjs`;
      },
    },
  },
});
