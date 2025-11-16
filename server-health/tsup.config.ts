import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['health-server.ts'],
  format: ['esm'],
  target: 'node22',
  outDir: 'dist/server',
  sourcemap: true,
  clean: true,
  minify: false,
  bundle: true,
  // Keep dependencies external (they'll be in node_modules)
  external: ['express', 'dockerode'],
  splitting: false,
  treeshake: true,
  dts: false, // We don't need .d.ts files for the server executable
});
