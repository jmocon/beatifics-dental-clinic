import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { CLINIC } from '../../../shared/booking.ts';
import { CLINIC_HOURS, manilaHour, manilaToday, weekdayOf } from '../../../shared/dates.ts';
import { BookingForm } from './BookingForm.tsx';
import { NAV, SERVICES, STEPS, VALUES } from './content.ts';
import '../styles/site.css';

/** Fade elements marked `data-reveal` up into view as they scroll in. */
function useReveal(root: React.RefObject<HTMLElement | null>) {
  useEffect(() => {
    const el = root.current;
    if (!el || window.matchMedia('(prefers-reduced-motion: reduce)').matches || !('IntersectionObserver' in window)) return;
    const targets = Array.from(el.querySelectorAll<HTMLElement>('[data-reveal]'));
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            e.target.classList.add('is-visible');
            io.unobserve(e.target);
          }
        }
      },
      { rootMargin: '0px 0px -40px 0px' },
    );
    el.classList.add('reveal-ready');
    targets.forEach((t) => io.observe(t));
    return () => io.disconnect();
  }, [root]);
}

const HOURS_ROWS = [1, 2, 3, 4, 5, 6, 0].map((wd) => {
  const h = CLINIC_HOURS[wd];
  return {
    wd,
    day: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][wd],
    time: h ? `${h.open}:00 AM – ${h.close - 12}:00 PM` : 'Closed',
  };
});

function useClinicStatus() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(t);
  }, []);
  const wd = weekdayOf(manilaToday(now));
  const hours = CLINIC_HOURS[wd];
  const hour = manilaHour(now);
  const openNow = !!hours && hour >= hours.open && hour < hours.close;
  return { todayWd: wd, openNow };
}

function Header() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  return (
    <header className="site-header">
      <div className="site-header-inner">
        <a href="#top" className="site-logo" aria-label="Beatifics Dental Clinic home">
          <img src="/images/wordmark-smooth-teal.png" alt="Beatifics" width={121} height={36} />
        </a>
        <nav className="site-nav" aria-label="Main">
          {NAV.map((n) => (
            <a key={n.href} href={n.href}>
              {n.label}
            </a>
          ))}
          <Link to="/manage" className="site-nav-manage">
            My booking
          </Link>
          <a href="#book" className="btn btn-primary">
            Book a visit
          </a>
        </nav>
        <div className="site-nav-mobile">
          <a href="#book" className="btn btn-primary">
            Book
          </a>
          <button
            type="button"
            className="menu-button"
            aria-expanded={open}
            aria-controls="mobile-menu"
            onClick={() => setOpen((o) => !o)}
          >
            <span className="visually-hidden">{open ? 'Close menu' : 'Open menu'}</span>
            <span className={`menu-icon${open ? ' is-open' : ''}`} aria-hidden="true" />
          </button>
        </div>
      </div>
      <nav id="mobile-menu" className="mobile-menu" hidden={!open} aria-label="Main">
        {NAV.map((n) => (
          <a key={n.href} href={n.href} onClick={() => setOpen(false)}>
            {n.label}
          </a>
        ))}
        <Link to="/manage">Change or cancel my booking</Link>
        <a href={CLINIC.phoneHref} className="mobile-menu-call">
          Call {CLINIC.phoneDisplay}
        </a>
      </nav>
    </header>
  );
}

/** Floating "Book a visit" button: shown after the hero, hidden once the booking form is on screen. */
function StickyBook({ heroRef, bookRef }: { heroRef: React.RefObject<HTMLElement | null>; bookRef: React.RefObject<HTMLElement | null> }) {
  const [pastHero, setPastHero] = useState(false);
  const [bookVisible, setBookVisible] = useState(false);

  useEffect(() => {
    if (!('IntersectionObserver' in window)) return;
    const hero = heroRef.current;
    const book = bookRef.current;
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (e.target === hero) setPastHero(!e.isIntersecting && e.boundingClientRect.top < 0);
        if (e.target === book) setBookVisible(e.isIntersecting);
      }
    });
    if (hero) io.observe(hero);
    if (book) io.observe(book);
    return () => io.disconnect();
  }, [heroRef, bookRef]);

  const show = pastHero && !bookVisible;
  return (
    <a href="#book" className={`sticky-book btn btn-primary${show ? ' is-shown' : ''}`} aria-hidden={!show} tabIndex={show ? 0 : -1}>
      Book a visit
    </a>
  );
}

export function SitePage() {
  const rootRef = useRef<HTMLDivElement>(null);
  const heroRef = useRef<HTMLElement>(null);
  const bookRef = useRef<HTMLElement>(null);
  const { todayWd, openNow } = useClinicStatus();
  useReveal(rootRef);

  return (
    <div className="site" ref={rootRef}>
      <a href="#main" className="skip-link">
        Skip to content
      </a>
      <Header />

      <main id="main">
        <span id="top" />
        {/* ---------- Hero ---------- */}
        <section ref={heroRef} className="hero container" aria-labelledby="hero-title">
          <div className="hero-copy">
            <span className="chip">
              <span className="chip-dot" aria-hidden="true" />
              Family dentistry in Tunasan, Muntinlupa
            </span>
            <h1 id="hero-title" className="hero-title">
              Gentle dental care for <em>beatific</em> smiles.
            </h1>
            <p className="hero-lede">
              Check-ups, cleanings, restorations and cosmetic treatments for adults and children, in a calm clinic on the
              National Highway.
            </p>
            <div className="hero-actions">
              <a href="#book" className="btn btn-primary btn-lg">
                Book an appointment
              </a>
              <a href={CLINIC.phoneHref} className="btn btn-secondary btn-lg">
                Call {CLINIC.phoneDisplay}
              </a>
            </div>
          </div>
          <div className="hero-media">
            <div className="hero-photo">
              <img
                src="/images/hero-clinic.png"
                alt="A bright, calm treatment room at Beatifics Dental Clinic"
                fetchPriority="high"
              />
            </div>
            <div className="hero-badge">
              <span className="eyebrow-sm">{openNow ? 'Open now' : 'Clinic hours'}</span>
              <span className="hero-badge-detail">{openNow ? 'Until 5:00 PM today' : 'Mon, Tue & Thu–Sat, 9–5'}</span>
            </div>
          </div>
        </section>

        {/* ---------- Services ---------- */}
        <section id="services" className="band" aria-labelledby="services-title">
          <div className="container section stack-56">
            <div className="section-head" data-reveal>
              <div className="section-head-main">
                <span className="eyebrow">Services</span>
                <h2 id="services-title" className="section-title">
                  Everything your family's smiles need, under one roof.
                </h2>
              </div>
              <p className="section-aside">
                Not sure what you need? Start with a consultation and we'll walk you through your options.
              </p>
            </div>
            <ul className="services-grid">
              {SERVICES.map((s) => (
                <li key={s.num} className="service-card" data-reveal>
                  <span className="service-num" aria-hidden="true">
                    {s.num}
                  </span>
                  <h3>{s.title}</h3>
                  <p>{s.desc}</p>
                </li>
              ))}
            </ul>
          </div>
        </section>

        {/* ---------- Our Dentist ---------- */}
        <section id="about" className="about container section" aria-labelledby="about-title">
          <div className="about-photo" data-reveal>
            <img src="/images/dentist-portrait.png" alt="Dr. Rebecca D. Vivo, DMD" loading="lazy" />
          </div>
          <div className="about-copy" data-reveal>
            <span id="about-title" className="eyebrow">
              Meet your dentist
            </span>
            <blockquote className="about-quote">“We’re called to create Beatific Smiles.”</blockquote>
            <div className="about-name">
              <span>Dr. Rebecca D. Vivo, DMD</span>
              <span>Dentist, Beatifics Dental Clinic</span>
            </div>
            <p className="about-text">
              Every visit starts with listening. We explain what we see, what we recommend and why, so you can make
              decisions about your care with confidence and without pressure.
            </p>
            <ul className="values">
              {VALUES.map((v) => (
                <li key={v.title}>
                  <span>{v.title}</span>
                  <span>{v.desc}</span>
                </li>
              ))}
            </ul>
          </div>
        </section>

        {/* ---------- Your Visit ---------- */}
        <section id="visit" className="visit-wrap" aria-labelledby="visit-title">
          <div className="visit">
            <div className="visit-head" data-reveal>
              <span className="eyebrow eyebrow-on-dark">Your first visit</span>
              <h2 id="visit-title" className="section-title on-dark">
                Unhurried, clear and comfortable from start to finish.
              </h2>
            </div>
            <ol className="steps">
              {STEPS.map((s) => (
                <li key={s.num} data-reveal>
                  <span className="step-num" aria-hidden="true">
                    {s.num}
                  </span>
                  <span className="step-title">{s.title}</span>
                  <span className="step-desc">{s.desc}</span>
                </li>
              ))}
            </ol>
          </div>
        </section>

        {/* ---------- Book ---------- */}
        <section id="book" ref={bookRef} className="book container section" aria-labelledby="book-title">
          <div className="book-copy" data-reveal>
            <span className="eyebrow">Book an appointment</span>
            <h2 id="book-title" className="section-title">
              Request a time that suits you.
            </h2>
            <p>
              Send a request and our team will call or message you to confirm. For dental pain or urgent concerns, please
              call the clinic directly.
            </p>
            <a href={CLINIC.phoneHref} className="book-phone">
              {CLINIC.phoneDisplay}
            </a>
            <ul className="book-reassure">
              <li>No payment needed to request</li>
              <li>We confirm by call or text, usually within the clinic day</li>
              <li>Need to change it? Just call us</li>
            </ul>
          </div>
          <div className="book-card" data-reveal>
            <BookingForm />
          </div>
        </section>

        {/* ---------- Contact ---------- */}
        <section id="contact" className="contact container" aria-label="Contact and opening hours">
          <div className="contact-card" data-reveal>
            <h2 className="eyebrow">Clinic hours</h2>
            <dl className="hours">
              {HOURS_ROWS.map((h) => (
                <div
                  key={h.day}
                  className={h.wd === todayWd ? 'is-today' : h.time === 'Closed' ? 'is-closed' : undefined}
                  aria-current={h.wd === todayWd ? 'date' : undefined}
                >
                  <dt>
                    {h.day}
                    {h.wd === todayWd && <span className="today-tag">Today</span>}
                  </dt>
                  <dd>{h.time}</dd>
                </div>
              ))}
            </dl>
          </div>
          <div className="contact-card" data-reveal>
            <h2 className="eyebrow">Find us</h2>
            <address className="address">
              <span>{CLINIC.addressLine1}</span>
              <span>{CLINIC.addressLine2}</span>
            </address>
            <div className="contact-links">
              <a href={CLINIC.phoneHref}>{CLINIC.phoneDisplay}</a>
              <a href={CLINIC.facebook} target="_blank" rel="noopener noreferrer">
                Facebook
              </a>
              <a href={CLINIC.instagram} target="_blank" rel="noopener noreferrer">
                Instagram
              </a>
            </div>
            <a href={CLINIC.maps} target="_blank" rel="noopener noreferrer" className="btn btn-tint contact-directions">
              Get directions
            </a>
          </div>
          <div className="contact-photo" data-reveal>
            <img src="/images/reception.png" alt="The reception area at Beatifics Dental Clinic" loading="lazy" />
          </div>
        </section>
      </main>

      <footer className="site-footer">
        <div className="container site-footer-inner">
          <span>© {new Date().getFullYear()} Beatifics Dental Clinic, Muntinlupa City</span>
          <span className="site-footer-links">
            <Link to="/privacy">Privacy policy</Link>
            <Link to="/manage">Manage my booking</Link>
            <a href="#top">Back to top ↑</a>
          </span>
        </div>
      </footer>

      <StickyBook heroRef={heroRef} bookRef={bookRef} />
    </div>
  );
}
