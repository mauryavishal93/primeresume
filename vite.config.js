import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';

const frontendRoot = fileURLToPath(new URL('./frontend', import.meta.url));

const cachedAccountAvatarScript = `<script>
try {
  const cachedAvatar = JSON.parse(localStorage.getItem('resumeout:session-cache:v1:account-avatar-hint') || 'null');
  const photo = cachedAvatar?.photoDataUrl;
  if (typeof cachedAvatar?.uid === 'string' && cachedAvatar.uid
    && Number.isFinite(cachedAvatar.savedAt) && Date.now() >= cachedAvatar.savedAt
    && Date.now() - cachedAvatar.savedAt <= 30 * 24 * 60 * 60 * 1000
    && typeof photo === 'string' && photo.length <= 350000
    && /^data:image\\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/]+=*$/.test(photo)) {
    const menu = document.querySelector('[data-account-menu-shell], #accountMenu');
    const avatar = menu?.querySelector('#accountAvatar, .account-avatar');
    if (avatar) {
      const image = document.createElement('img');
      image.alt = '';
      image.draggable = false;
      image.loading = 'eager';
      image.src = photo;
      avatar.replaceChildren(image);
      menu.dataset.authShellVisible = 'true';
    }
  }
} catch (error) {
  console.warn('Could not render the cached account icon.', error);
}
</script>`;

function cachedAccountAvatarPlugin() {
  return {
    name: 'cached-account-avatar',
    transformIndexHtml(html) {
      if (html.includes('data-account-menu-shell')) {
        return html;
      }
      if (html.includes('class="about-nav"')) {
        const shell = `<details class="account-menu site-account-menu" data-account-menu-shell>
  <summary class="account-menu-trigger" aria-label="Open account menu"><span class="account-avatar" aria-hidden="true">U</span></summary>
</details>
${cachedAccountAvatarScript}`;
        return html.replace(/(<nav\b[^>]*class="[^"]*\babout-nav\b[^"]*"[^>]*>[\s\S]*?)(<\/nav>)/, `$1${shell}$2`);
      }
      if (html.includes('id="accountMenu"')) {
        return html.replace(/(<details\b[^>]*id="accountMenu"[^>]*>[\s\S]*?<\/details>)/, `$1${cachedAccountAvatarScript}`);
      }
      return html;
    }
  };
}

export default defineConfig({
  root: frontendRoot,
  plugins: [cachedAccountAvatarPlugin()],
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
        myAccount: fileURLToPath(new URL('./frontend/my-account.html', import.meta.url)),
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