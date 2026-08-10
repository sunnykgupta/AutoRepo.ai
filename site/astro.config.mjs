import { defineConfig } from 'astro/config';

const base = process.env.PUBLIC_BASE_PATH ?? '/';

export default defineConfig({
  output: 'static',
  site: 'https://autorepo.ai',
  base: base.endsWith('/') ? base.slice(0, -1) || '/' : base,
});
