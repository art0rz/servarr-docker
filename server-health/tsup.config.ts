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
  external: ['express'],
  splitting: false,
  treeshake: true,
  dts: false, // We don't need .d.ts files for the server executable
  // Copy ui.html to dist/server/lib/
  onSuccess: async () => {
    const fs = await import('fs/promises');
    await fs.mkdir('dist/server/lib', { recursive: true });
    await fs.copyFile('lib/ui.html', 'dist/server/lib/ui.html');
  },
});
