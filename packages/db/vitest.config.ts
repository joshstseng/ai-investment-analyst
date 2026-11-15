import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: '@aia/db',
    // DB tests share one Postgres; run files one at a time so their transactions don't collide.
    fileParallelism: false,
  },
});
