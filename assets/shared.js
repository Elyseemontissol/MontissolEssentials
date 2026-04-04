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
