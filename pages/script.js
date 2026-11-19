// Small enhancements for the static GitHub Pages site. The page works fully without JavaScript.
(function () {
  'use strict';

  // ---------- Mobile menu ----------
  var menuButton = document.querySelector('.menu-button');
  var menu = document.getElementById('mobile-menu');
  var menuIcon = document.querySelector('.menu-icon');
  var menuLabel = menuButton && menuButton.querySelector('.visually-hidden');

  function setMenu(open) {
    if (!menuButton || !menu) return;
    menu.hidden = !open;
    menuButton.setAttribute('aria-expanded', String(open));
    menuIcon.classList.toggle('is-open', open);
    menuLabel.textContent = open ? 'Close menu' : 'Open menu';
  }

  if (menuButton && menu) {
    menuButton.addEventListener('click', function () {
      setMenu(menu.hidden);
    });
    menu.addEventListener('click', function (e) {
      if (e.target.closest('a')) setMenu(false);
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !menu.hidden) {
        setMenu(false);
        menuButton.focus();
      }
    });
  }

  // ---------- Today's hours & "Open now" (always Manila time) ----------
  var HOURS = { 0: null, 1: [9, 17], 2: [9, 17], 3: null, 4: [9, 17], 5: [9, 17], 6: [9, 17] };
  var WEEKDAYS = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

  function manilaNow() {
    var parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Manila',
      weekday: 'short',
      hour: 'numeric',
      hourCycle: 'h23',
    }).formatToParts(new Date());
    var out = {};
    parts.forEach(function (p) {
      out[p.type] = p.value;
    });
    return { wd: WEEKDAYS[out.weekday], hour: Number(out.hour) };
  }

  function updateStatus() {
    var now = manilaNow();

    document.querySelectorAll('.hours > div').forEach(function (row) {
      var isToday = Number(row.getAttribute('data-wd')) === now.wd;
      row.classList.toggle('is-today', isToday);
      if (isToday) row.setAttribute('aria-current', 'date');
      else row.removeAttribute('aria-current');
      var tag = row.querySelector('.today-tag');
      if (isToday && !tag) {
        tag = document.createElement('span');
        tag.className = 'today-tag';
        tag.textContent = 'Today';
        row.querySelector('dt').appendChild(tag);
      } else if (!isToday && tag) {
        tag.remove();
      }
    });

    var h = HOURS[now.wd];
    var openNow = !!h && now.hour >= h[0] && now.hour < h[1];
    var label = document.querySelector('[data-status-label]');
    var detail = document.querySelector('[data-status-detail]');
    if (label && detail) {
      label.textContent = openNow ? 'Open now' : 'Clinic hours';
      detail.textContent = openNow ? 'Until 5:00 PM today' : 'Mon, Tue & Thu–Sat, 9–5';
    }
  }

  updateStatus();
  setInterval(updateStatus, 60000);

  var year = document.querySelector('[data-year]');
  if (year) year.textContent = String(new Date().getFullYear());

  if (!('IntersectionObserver' in window)) return;

  // ---------- Fade sections up as they scroll in ----------
  if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    var revealIo = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (e) {
          if (e.isIntersecting) {
            e.target.classList.add('is-visible');
            revealIo.unobserve(e.target);
          }
        });
      },
      { rootMargin: '0px 0px -40px 0px' },
    );
    document.body.classList.add('reveal-ready');
    document.querySelectorAll('[data-reveal]').forEach(function (el) {
      revealIo.observe(el);
    });
  }

  // ---------- Floating "Book a visit": after the hero, hidden once the booking section is on screen ----------
  var sticky = document.querySelector('.sticky-book');
  var hero = document.querySelector('.hero');
  var book = document.getElementById('book');
  var pastHero = false;
  var bookVisible = false;

  var stickyIo = new IntersectionObserver(function (entries) {
    entries.forEach(function (e) {
      if (e.target === hero) pastHero = !e.isIntersecting && e.boundingClientRect.top < 0;
      if (e.target === book) bookVisible = e.isIntersecting;
    });
    var show = pastHero && !bookVisible;
    sticky.classList.toggle('is-shown', show);
    sticky.setAttribute('aria-hidden', String(!show));
    sticky.tabIndex = show ? 0 : -1;
  });
  if (sticky && hero && book) {
    stickyIo.observe(hero);
    stickyIo.observe(book);
  }
})();
