import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['scripts/cpu-bench.test.ts'] } });
