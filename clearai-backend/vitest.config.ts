import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Tests live in a sibling tree mirroring src/ so the file explorer
    // isn't cluttered with *.test.ts next to every module. Imports inside
    // tests reach into ../../src/<domain>/<file>.js.
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    globals: false,
  },
});
