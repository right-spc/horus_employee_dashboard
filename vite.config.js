import { defineConfig } from 'vite';
import { copyFileSync, mkdirSync } from 'fs';
import { join } from 'path';

// Plugin to copy static files after build
const copyStaticFiles = () => ({
  name: 'copy-static-files',
  closeBundle() {
    const filesToCopy = ['config.js', 'dashboard.js'];
    filesToCopy.forEach(file => {
      try {
        copyFileSync(file, join('dist', file));
        console.log(`Copied ${file} to dist/`);
      } catch (e) {
        console.error(`Failed to copy ${file}:`, e.message);
      }
    });
  }
});

export default defineConfig({
  plugins: [copyStaticFiles()],
  build: {
    assetsInlineLimit: 0,
    rollupOptions: {
      input: {
        main: 'index.html'
      }
    }
  }
});
