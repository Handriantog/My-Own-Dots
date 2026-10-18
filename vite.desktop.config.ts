import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  root: fileURLToPath(new URL('./src/desktop/renderer', import.meta.url)),
  base: './',
  publicDir: false,
  build: {
    outDir: fileURLToPath(new URL('./dist/desktop/renderer', import.meta.url)),
    emptyOutDir: true,
    target: 'es2023',
    rolldownOptions: {
      input: {
        menu: fileURLToPath(
          new URL('./src/desktop/renderer/menu.html', import.meta.url),
        ),
        chat: fileURLToPath(
          new URL('./src/desktop/renderer/chat.html', import.meta.url),
        ),
        overlay: fileURLToPath(
          new URL('./src/desktop/renderer/index.html', import.meta.url),
        ),
        settings: fileURLToPath(
          new URL('./src/desktop/renderer/settings.html', import.meta.url),
        ),
      },
    },
  },
});
