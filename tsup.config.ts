import { readFileSync } from 'node:fs';
import { defineConfig } from 'tsup';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as {
  version: string;
};

export default defineConfig({
  entry: ['src/cli.ts'],
  format: ['cjs'],
  platform: 'node',
  target: 'node18',
  sourcemap: true,
  clean: true,
  dts: false,
  shims: false,
  banner: {
    js: '#!/usr/bin/env node',
  },
  define: {
    __VERSION__: JSON.stringify(pkg.version),
  },
});
