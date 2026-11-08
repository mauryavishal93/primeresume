import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';

const frontendRoot = fileURLToPath(new URL('./frontend', import.meta.url));

export default defineConfig({
  root: frontendRoot,
  server: {
    proxy: {
      '/api': 'http://127.0.0.1:3000'
    }
  },
  build: {
    chunkSizeWarningLimit: 1000,
    outDir: fileURLToPath(new URL('./dist', import.meta.url)),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        home: fileURLToPath(new URL('./frontend/home.html', import.meta.url)),
        index: fileURLToPath(new URL('./frontend/index.html', import.meta.url)),
        resumeWizard: fileURLToPath(new URL('./frontend/resume-wizard.html', import.meta.url)),
        community: fileURLToPath(new URL('./frontend/community.html', import.meta.url)),
        myPosts: fileURLToPath(new URL('./frontend/my-posts.html', import.meta.url)),
        admin: fileURLToPath(new URL('./frontend/admin.html', import.meta.url)),
        editor: fileURLToPath(new URL('./frontend/editor.html', import.meta.url)),
        about: fileURLToPath(new URL('./frontend/about.html', import.meta.url)),
        privacy: fileURLToPath(new URL('./frontend/privacy.html', import.meta.url)),
        pricing: fileURLToPath(new URL('./frontend/pricing.html', import.meta.url)),
        billing: fileURLToPath(new URL('./frontend/billing.html', import.meta.url)),
        terms: fileURLToPath(new URL('./frontend/terms.html', import.meta.url)),
        refunds: fileURLToPath(new URL('./frontend/refunds.html', import.meta.url)),
        support: fileURLToPath(new URL('./frontend/support.html', import.meta.url))
      }
    }
  }
});