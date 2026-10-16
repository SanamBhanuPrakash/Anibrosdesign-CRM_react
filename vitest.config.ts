/// <reference types="vitest" />
import { defineConfig, mergeConfig } from 'vitest/config';
import viteConfig from './vite.config';

export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      // Server/DB suites create their own disposable databases and must not run in parallel.
      fileParallelism: false,
      // Front-end component tests opt in to the DOM per file: `// @vitest-environment jsdom`
      environment: 'node',
      setupFiles: ['./src/test/setup.ts'],
      testTimeout: 30_000,
      hookTimeout: 90_000,
    },
  })
);
