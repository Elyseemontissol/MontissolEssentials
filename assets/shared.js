// Inject the page loader on the first visit of a session only.
// sessionStorage persists across in-site navigations but clears when the
// tab is closed, so returning visitors see the animation again.
(async function () {
  try {
    if (sessionStorage.getItem('me_loader_seen') === '1') return;
    sessionStorage.setItem('me_loader_seen', '1');

    const res = await fetch('assets/loader.html');
    const html = await res.text();
    const mount = document.createElement('div');
    mount.innerHTML = html;
    document.body.insertBefore(mount, document.body.firstChild);
    mount.querySelectorAll('script').forEach(old => {
      const s = document.createElement('script');
      if (old.src) s.src = old.src;
      s.textContent = old.textContent;
      old.parentNode.replaceChild(s, old);
    });
  } catch (err) {
    console.warn('Loader could not be injected:', err);
  }
})();

(async function () {
  const headerEl = document.getElementById('shared-header');
  const footerEl = document.getElementById('shared-footer');

  if (headerEl) {
    const res = await fetch('assets/header.html');
    headerEl.innerHTML = await res.text();
    // Set aria-current on the nav link matching the current page
    const page = location.pathname.split('/').pop() || 'index.html';
    const link = headerEl.querySelector(`a[href="${page}"]`);
    if (link) link.setAttribute('aria-current', 'page');
  }

  if (footerEl) {
    const res = await fetch('assets/footer.html');
    footerEl.innerHTML = await res.text();
    const yearEl = document.getElementById('year');
    if (yearEl) yearEl.textContent = new Date().getFullYear();
  }

  // Header scroll-aware shrink
  var header = document.querySelector('.site-header');
  if (header) {
    var lastScroll = 0;
    window.addEventListener('scroll', function () {
      var y = window.scrollY;
      if (y > 60) header.classList.add('scrolled');
      else header.classList.remove('scrolled');
      lastScroll = y;
    }, { passive: true });
  }
})();

// Scroll reveal via Intersection Observer
(function () {
  var reveals = document.querySelectorAll('.reveal');
  if (!reveals.length) return;

  var observer = new IntersectionObserver(function (entries) {
    entries.forEach(function (entry) {
      if (entry.isIntersecting) {
        entry.target.classList.add('revealed');
        observer.unobserve(entry.target);
      }
    });
  }, { threshold: 0.12, rootMargin: '0px 0px -40px 0px' });

  reveals.forEach(function (el) { observer.observe(el); });
})();

// Lightning effect for cloud banner
(function () {
  var el = document.querySelector('.hero-lightning');
  if (!el) return;

  function flashAt(x, y) {
    el.style.background =
      'radial-gradient(ellipse at ' + x + '% ' + y + '%, rgba(255,255,255,.85) 0%, rgba(200,210,255,.35) 25%, transparent 65%)';
    el.style.opacity = (.5 + Math.random() * .4).toFixed(2);
    setTimeout(function () { el.style.opacity = '0'; }, 80);
  }

  function triggerLightning() {
    var x = 15 + Math.random() * 70;
    var y = 5 + Math.random() * 30;
    flashAt(x, y);
    setTimeout(function () { flashAt(x + (Math.random() * 10 - 5), y + (Math.random() * 6 - 3)); }, 150);
  }

  function schedule() {
    triggerLightning();
    setTimeout(schedule, 3000 + Math.random() * 4000);
  }

  // Expose for index.html carousel to pause/resume
  window._lightningSchedule = schedule;
  window._lightningEl = el;

  schedule();
})();

// Particle canvas for hero sections
(function () {
  var canvas = document.getElementById('particleCanvas');
  if (!canvas) return;
  var ctx = canvas.getContext('2d');
  var particles = [];
  var count = 60;

  function resize() {
    var hero = canvas.parentElement;
    canvas.width = hero.offsetWidth;
    canvas.height = hero.offsetHeight;
  }
  resize();
  window.addEventListener('resize', resize);

  for (var i = 0; i < count; i++) {
    particles.push({
      x: Math.random() * canvas.width,
      y: Math.random() * canvas.height,
      r: Math.random() * 2 + .5,
      dx: (Math.random() - .5) * .4,
      dy: (Math.random() - .5) * .3,
      o: Math.random() * .4 + .1
    });
  }

  function draw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (var i = 0; i < particles.length; i++) {
      var p = particles[i];
      p.x += p.dx;
      p.y += p.dy;
      if (p.x < 0) p.x = canvas.width;
      if (p.x > canvas.width) p.x = 0;
      if (p.y < 0) p.y = canvas.height;
      if (p.y > canvas.height) p.y = 0;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(231, 77, 16, ' + p.o + ')';
      ctx.fill();

      // Draw connections
      for (var j = i + 1; j < particles.length; j++) {
        var p2 = particles[j];
        var dist = Math.hypot(p.x - p2.x, p.y - p2.y);
        if (dist < 120) {
          ctx.beginPath();
          ctx.moveTo(p.x, p.y);
          ctx.lineTo(p2.x, p2.y);
          ctx.strokeStyle = 'rgba(231, 77, 16, ' + (.08 * (1 - dist / 120)) + ')';
          ctx.lineWidth = .5;
          ctx.stroke();
        }
      }
    }
    requestAnimationFrame(draw);
  }
  draw();
})();

// ── Theme toggle (dark / light) ────────────────────────────────
// The inline <head> script already applied the saved theme or system
// preference on first paint. This handler lives on the shared header,
// which is injected asynchronously, so we wire via document delegation
// and also listen for the header mount.
(function () {
  var KEY = 'me-theme';

  function current() {
    var attr = document.documentElement.getAttribute('data-theme');
    if (attr === 'light' || attr === 'dark') return attr;
    // No explicit theme -> report system preference so toggle moves to the opposite
    if (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) return 'light';
    return 'dark';
  }

  function apply(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    try { localStorage.setItem(KEY, theme); } catch (e) {}
  }

  function toggle() {
    apply(current() === 'light' ? 'dark' : 'light');
  }

  // Delegated click — covers the toggle rendered inside the injected header
  document.addEventListener('click', function (e) {
    var btn = e.target.closest && e.target.closest('#themeToggleBtn');
    if (btn) { e.preventDefault(); toggle(); }
  });

  // Respond to system preference changes when the user hasn't explicitly chosen
  if (window.matchMedia) {
    var mq = window.matchMedia('(prefers-color-scheme: light)');
    var listener = function (evt) {
      var stored;
      try { stored = localStorage.getItem(KEY); } catch (e) {}
      if (stored === 'light' || stored === 'dark') return; // user chose, honor it
      document.documentElement.setAttribute('data-theme', evt.matches ? 'light' : 'dark');
    };
    if (mq.addEventListener) mq.addEventListener('change', listener);
    else if (mq.addListener) mq.addListener(listener);
  }
})();
