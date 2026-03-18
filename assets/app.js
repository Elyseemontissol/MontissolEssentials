(() => {
  // Mobile menu toggle
  const header = document.querySelector('.site-header');
  const btn = document.querySelector('.menu-btn');
  if (header && btn) {
    btn.addEventListener('click', () => {
      header.classList.toggle('open');
      const expanded = header.classList.contains('open');
      btn.setAttribute('aria-expanded', expanded);
    });
  }

  // Close mobile menu when clicking a nav link
  const navLinks = document.querySelectorAll('.nav a');
  navLinks.forEach(link => {
    link.addEventListener('click', () => {
      if (header) header.classList.remove('open');
      if (btn) btn.setAttribute('aria-expanded', 'false');
    });
  });

  // FAQ Accordion
  const faqItems = document.querySelectorAll('.faq-item');
  faqItems.forEach(item => {
    const question = item.querySelector('.faq-question');
    if (!question) return;
    question.addEventListener('click', () => {
      const isActive = item.classList.contains('active');
      // Close all others
      faqItems.forEach(other => {
        other.classList.remove('active');
        const otherBtn = other.querySelector('.faq-question');
        if (otherBtn) otherBtn.setAttribute('aria-expanded', 'false');
      });
      // Toggle current
      if (!isActive) {
        item.classList.add('active');
        question.setAttribute('aria-expanded', 'true');
      }
    });
  });

})();

// Newsletter form handling
document.addEventListener('DOMContentLoaded', () => {
  const form = document.getElementById('newsletterForm');
  if (!form) return;

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const btn = form.querySelector('button[type="submit"]');
    const input = form.querySelector('input[type="email"]');
    if (btn) btn.textContent = 'Subscribed!';
    if (input) input.value = '';
  });
});
