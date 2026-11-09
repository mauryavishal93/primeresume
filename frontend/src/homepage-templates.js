import { templateDefs } from '../../Templates/index.js';
import { isProTemplate } from './plan-access.js';

const track = document.querySelector('[data-template-carousel]');

if (track) {
  const section = track.closest('#templates');
  const viewport = document.createElement('div');
  viewport.className = 'landing-template-viewport';
  viewport.setAttribute('aria-label', 'Resume templates');
  const controls = document.createElement('div');
  controls.className = 'landing-template-controls';
  controls.setAttribute('aria-label', 'Template carousel controls');

  const previous = document.createElement('button');
  previous.type = 'button';
  previous.setAttribute('aria-label', 'Show previous templates');
  previous.textContent = '‹';

  const position = document.createElement('span');
  position.className = 'landing-template-position';
  position.setAttribute('aria-live', 'off');

  const next = document.createElement('button');
  next.type = 'button';
  next.setAttribute('aria-label', 'Show next templates');
  next.textContent = '›';
  controls.append(previous, position, next);

  const escapeHtml = value => String(value).replace(/[&<>"']/g, character => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[character]);

  const sectionMarkup = (title, content, type = 'summary') => `<section class="resume-section" data-section-type="${type}">
    <h2 class="section-heading">${title}</h2>
    <div class="section-body">${content}</div>
  </section>`;
  const experience = sectionMarkup('Experience', '<div class="entry"><div class="entry-top"><span class="entry-title">Senior Product Designer</span><span class="entry-date">2021–Present</span></div><div class="entry-sub">Northstar Studio</div><ul class="pointer-list"><li>Led product design from research through launch.</li><li>Improved onboarding and accessibility across core experiences.</li></ul></div><div class="entry"><div class="entry-top"><span class="entry-title">Product Designer</span><span class="entry-date">2018–2021</span></div><div class="entry-sub">Brightside Digital</div><ul class="pointer-list"><li>Built reusable design patterns with engineering teams.</li></ul></div>', 'experience');
  const projects = sectionMarkup('Selected Projects', '<div class="entry"><div class="entry-top"><span class="entry-title">Customer Insights</span><span class="entry-date">2023</span></div><p>Designed a research dashboard that helps teams turn feedback into product decisions.</p></div>');
  const skills = sectionMarkup('Skills', '<div class="skill-list"><span class="skill">Product strategy</span><span class="skill">Prototyping</span><span class="skill">Design systems</span></div>', 'skills');
  const education = sectionMarkup('Education', '<p>B.Des. Interaction Design</p><p>University of Design · 2017–2021</p>', 'education');
  const certifications = sectionMarkup('Certifications', '<p>Certified UX Designer</p><p>Accessibility Fundamentals</p>');
  const summary = sectionMarkup('Profile', '<p>Designer focused on clear, thoughtful digital experiences.</p>');
  const profilePhoto = '<span class="photo photo-placeholder" aria-hidden="true"></span>';

  function renderResume(template) {
    const cls = escapeHtml(template.cls);
    if (template.id === 'peach-mint') {
      return `<div class="sheet-inner pm-sheet">
        <aside class="pm-sidebar">
          <header class="pm-profile">${profilePhoto}<h1 class="name">Jordan Taylor</h1><div class="headline">Product Designer</div><span class="pm-name-underline"></span></header>
          <div class="pm-contact"><div class="pm-contact-item">⌖ <span>Bengaluru, India</span></div><div class="pm-contact-item">✉ <span>jordan@email.com</span></div></div>
          <div class="pm-sidebar-sections">${skills}${certifications}</div>
        </aside>
        <main class="pm-main"><div class="sections-area">${summary}${experience}${projects}${education}</div></main>
      </div>`;
    }

    if (template.id === 'teal-modern') {
      return `<div class="sheet-inner tr-sheet">
        <header class="tr-header"><div class="tr-header-art" aria-hidden="true"></div><div class="tr-header-copy"><div class="tr-kicker"><span></span>PROFILE</div><h1 class="tr-name">Jordan Taylor</h1><div class="tr-title">Product Designer</div><div class="tr-header-rule"></div><div class="tr-contact-row"><span class="tr-contact-item">⌖ Bengaluru, India</span><span class="tr-contact-item">✉ jordan@email.com</span></div></div><div class="tr-photo-frame">${profilePhoto}</div></header>
        <div class="tr-layout"><aside class="tr-sidebar"><div class="tr-sidebar-sections">${skills}${education}${certifications}</div></aside><main class="tr-main"><div class="sections-area">${summary}${experience}${projects}</div></main></div>
      </div>`;
    }

    if (template.id === 'interio-designer') {
      return `<div class="sheet-inner interio-layout">
        <div class="interio-resume-label">RESUME</div>
        <aside class="interio-sidebar">${'<span class="interio-photo interio-photo-placeholder">JT</span>'}<div class="interio-contact-block"><h3>Address</h3><p>Bengaluru, India</p></div><div class="interio-contact-block"><h3>Email</h3><p>jordan@email.com</p></div><div class="interio-sidebar-sections">${skills}${certifications}</div></aside>
        <main class="interio-main"><header class="resume-header"><h1 class="name">Jordan Taylor</h1><div class="headline">Product Designer</div></header><div class="sections-area">${summary}${experience}${projects}${education}</div></main>
      </div>`;
    }

    if (template.id === 'brian-baxter') {
      return `<div class="sheet-inner br-sheet">
        <header class="br-header"><div class="br-yellow-panel"></div><div class="br-header-photo"><span class="br-portrait br-portrait-placeholder">JT</span></div><div class="br-header-name"><h1>Jordan Taylor</h1><p>Product Designer</p></div></header>
        <div class="br-body"><aside class="br-sidebar"><section class="br-side-section"><h2 class="br-section-title">Contact</h2><ul class="br-contact-list"><li class="br-contact-item">☎ +91 98765 43210</li><li class="br-contact-item">✉ jordan@email.com</li></ul></section><div class="br-sidebar-sections">${skills}${certifications}</div></aside><main class="br-main"><div class="sections-area">${summary}${experience}${projects}${education}</div></main></div>
      </div>`;
    }

    const header = `<header class="resume-header${template.photo ? ' has-photo' : ''}"${template.photo ? ' data-photo-pos="right"' : ''}>
      ${template.photo ? profilePhoto : ''}
      <div class="header-text"><h1 class="name">Jordan Taylor</h1><div class="headline">Product Designer</div><div class="contact">jordan@email.com · Bengaluru, India</div></div>
    </header>`;
    const content = template.layout === 'two'
      ? `<div class="section-columns"><div class="section-column">${summary}${experience}${projects}</div><div class="section-column">${skills}${education}${certifications}</div></div>`
      : `${summary}${experience}${projects}${skills}${education}${certifications}`;

    return `<div class="sheet-inner">${header}<div class="sections-area">${content}</div></div>`;
  }

  track.classList.add('landing-template-track');
  track.setAttribute('role', 'list');
  track.innerHTML = templateDefs.map(template => {
    const pro = isProTemplate(template.id);
    const cls = escapeHtml(template.cls);
    const link = pro ? '/editor.html#templates' : `/editor.html?template=${encodeURIComponent(template.id)}`;
    const label = pro ? `Explore the ${template.name} Pro resume template` : `Use the ${template.name} resume template`;
    return `<a class="landing-template-card" role="listitem" href="${link}" aria-label="${escapeHtml(label)}">
      <div class="landing-template-preview" aria-hidden="true">
        <div class="landing-resume-frame">
          <article class="sheet ${cls} landing-resume-paper" data-layout="${escapeHtml(template.id)}" style="--resume-accent:${escapeHtml(template.accent)};--mx:32px;--mt:32px;--mb:32px;--resume-size:18px;--resume-heading:22px;--c1:1.2fr;--c2:.8fr;--col-gap:20px">${renderResume(template)}</article>
        </div>
      </div>
      <div class="landing-template-meta"><strong>${escapeHtml(template.name)}</strong><span class="landing-template-tag${pro ? ' landing-template-tag-pro' : ''}">${pro ? 'Pro' : 'Free'}</span></div>
      <span class="landing-template-description">${escapeHtml(template.sub)}</span>
      <span class="landing-template-link">${pro ? 'Explore in editor' : 'Use template'} →</span>
    </a>`;
  }).join('');

  track.parentNode.insertBefore(viewport, track);
  viewport.append(track);
  section.insertBefore(controls, viewport.nextSibling);

  let offset = 0;
  let hovered = false;
  let focused = false;
  let hidden = document.hidden;
  let manualPauseUntil = 0;
  let autoAdvanceTimer;
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

  function visibleCount() {
    if (window.innerWidth <= 640) return 1;
    if (window.innerWidth <= 980) return 2;
    return 4;
  }

  function maxOffset() {
    return Math.max(0, templateDefs.length - visibleCount());
  }

  function updateCarousel() {
    const firstCard = track.firstElementChild;
    if (!firstCard) return;
    const gap = Number.parseFloat(getComputedStyle(track).columnGap) || 0;
    const step = firstCard.getBoundingClientRect().width + gap;
    offset = Math.min(offset, maxOffset());
    track.style.transform = `translateX(${-offset * step}px)`;
    position.textContent = `Showing ${offset + 1}–${Math.min(offset + visibleCount(), templateDefs.length)} of ${templateDefs.length}`;
  }

  function scheduleAutoAdvance() {
    window.clearTimeout(autoAdvanceTimer);
    if (reducedMotion.matches || hovered || focused || hidden || templateDefs.length <= visibleCount()) return;
    const delay = Math.max(5000, manualPauseUntil - Date.now());
    autoAdvanceTimer = window.setTimeout(() => {
      offset = offset >= maxOffset() ? 0 : Math.min(offset + visibleCount(), maxOffset());
      updateCarousel();
      scheduleAutoAdvance();
    }, delay || 5000);
  }

  function move(direction) {
    const maximum = maxOffset();
    offset = direction > 0
      ? (offset >= maximum ? 0 : Math.min(offset + visibleCount(), maximum))
      : (offset <= 0 ? maximum : Math.max(offset - visibleCount(), 0));
    manualPauseUntil = Date.now() + 10000;
    updateCarousel();
    scheduleAutoAdvance();
  }

  previous.addEventListener('click', () => move(-1));
  next.addEventListener('click', () => move(1));
  section.addEventListener('pointerenter', () => { hovered = true; scheduleAutoAdvance(); });
  section.addEventListener('pointerleave', () => { hovered = false; scheduleAutoAdvance(); });
  section.addEventListener('focusin', () => { focused = true; scheduleAutoAdvance(); });
  section.addEventListener('focusout', event => {
    if (!section.contains(event.relatedTarget)) {
      focused = false;
      scheduleAutoAdvance();
    }
  });
  document.addEventListener('visibilitychange', () => {
    hidden = document.hidden;
    scheduleAutoAdvance();
  });
  reducedMotion.addEventListener('change', scheduleAutoAdvance);
  window.addEventListener('resize', () => {
    updateCarousel();
    scheduleAutoAdvance();
  });

  updateCarousel();
  scheduleAutoAdvance();
}
