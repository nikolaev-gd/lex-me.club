/* balance.js — the mock balance on the pricing card ticks down a little.
 * Purely decorative: it illustrates "you spend it as you learn" without
 * claiming any real per-minute rate. Stops when scrolled out of view, and
 * does nothing at all for anyone who asked for reduced motion. */
(function () {
  'use strict';
  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  var el = document.getElementById('bal');
  if (!el) return;

  var v = 10.00;
  var timer = null;

  var io = new IntersectionObserver(function (entries) {
    entries.forEach(function (e) {
      if (e.isIntersecting) {
        clearInterval(timer);
        timer = setInterval(function () {
          v -= 0.01;
          if (v <= 9.62) v = 10.00;
          el.textContent = v.toFixed(2);
        }, 900);
      } else {
        clearInterval(timer);
      }
    });
  }, { threshold: .4 });

  io.observe(el);
})();
