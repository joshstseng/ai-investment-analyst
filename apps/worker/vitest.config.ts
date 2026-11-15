import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: '@aia/worker',
    // DB tests share one Postgres; run files one at a time.
    fileParallelism: false,
  },
});
