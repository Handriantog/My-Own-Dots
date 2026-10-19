import { mergeConfig } from 'vite';
import config from './vite.config.ts';
export default mergeConfig(config, {
  base: '/',
  build: { outDir: 'dist/desktop/renderer/workspace', emptyOutDir: true },
});
