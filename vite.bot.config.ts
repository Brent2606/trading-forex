import { defineConfig } from 'vite';

// Bundles the headless 24/7 bot into a single Node ESM file: dist-bot/neonfx-bot.mjs
export default defineConfig({
  build: {
    ssr: 'bot/main.ts',
    outDir: 'dist-bot',
    target: 'node20',
    emptyOutDir: true,
    minify: false,
    rollupOptions: { output: { entryFileNames: 'neonfx-bot.mjs' } },
  },
  ssr: { noExternal: true },
});
