import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { CLINIC } from '../../../shared/booking.ts';
import '../styles/site.css';

/**
 * Patient privacy notice (Philippine Data Privacy Act of 2012, RA 10173).
 * Keep it true to what the system actually does. When features change (e.g. SMS reminders,
 * a new hosting provider, analytics), update the relevant section and LAST_UPDATED.
 */
const LAST_UPDATED = 'October 7, 2026';

const SECTIONS = [
  { id: 'summary', title: 'The short version' },
  { id: 'collect', title: 'What we collect' },
  { id: 'use', title: 'How we use it' },
  { id: 'basis', title: 'Why we’re allowed to' },
  { id: 'share', title: 'Who can see it' },
  { id: 'keep', title: 'How long we keep it' },
  { id: 'protect', title: 'How we protect it' },
  { id: 'rights', title: 'Your rights' },
  { id: 'children', title: 'Children' },
  { id: 'website', title: 'Cookies and the website' },
  { id: 'changes', title: 'Changes to this policy' },
  { id: 'contact', title: 'Contact us' },
];

export function PrivacyPage() {
  useEffect(() => {
    document.title = 'Privacy policy · Beatifics Dental Clinic';
    // Opened from a #section link: scroll to it once rendered.
    if (window.location.hash) document.getElementById(window.location.hash.slice(1))?.scrollIntoView();
  }, []);

  return (
    <div className="manage-page privacy-page">
      <header className="manage-header">
        <Link to="/" aria-label="Beatifics Dental Clinic home">
          <img src="/images/wordmark-smooth-teal.png" alt="Beatifics" width={121} height={36} />
        </Link>
        <a href="/#book" className="btn btn-primary btn-sm">
          Book a visit
        </a>
      </header>

      <main className="privacy-main">
        <div className="manage-intro">
          <span className="eyebrow">Your privacy</span>
          <h1 className="section-title">Privacy policy for patients</h1>
          <p>
            How {CLINIC.name} collects, uses and protects your personal information when you book online, call us, or visit
            the clinic. Last updated {LAST_UPDATED}.
          </p>
        </div>

        <nav className="privacy-toc" aria-label="On this page">
          <span className="detail-label">On this page</span>
          <ol>
            {SECTIONS.map((s) => (
              <li key={s.id}>
                <a href={`#${s.id}`}>{s.title}</a>
              </li>
            ))}
          </ol>
        </nav>

        <article className="privacy-body">
          <section id="summary">
            <h2>The short version</h2>
            <ul className="privacy-highlights">
              <li>We only ask for what we need to book and look after your dental care.</li>
              <li>Your details are seen only by our clinic team. We never sell them or use them for advertising.</li>
              <li>We don’t use tracking cookies or analytics on our website.</li>
              <li>You can ask to see, correct or delete your information at any time.</li>
            </ul>
          </section>

          <section id="collect">
            <h2>What we collect</h2>
            <h3>When you request an appointment online or by phone</h3>
            <ul>
              <li>Your full name and mobile number</li>
              <li>The reason for your visit (for example, a check-up or tooth pain)</li>
              <li>The day, time and dentist you choose</li>
              <li>
                Anything you choose to tell us in the “Anything we should know?” box. This may include health information,
                so please share only what helps us prepare for your visit.
              </li>
              <li>Your consent to be contacted about your request</li>
            </ul>
            <h3>When you become our patient</h3>
            <ul>
              <li>Your appointment history: dates, treatments, which dentist you saw, cancellations and missed visits</li>
              <li>Notes our team writes to help with your care and appointments (for example, “prefers afternoon calls”)</li>
              <li>Dental and health records created during your treatment, kept as part of your patient file</li>
            </ul>
            <h3>When you use our website</h3>
            <ul>
              <li>
                Your device’s internet (IP) address is used for a short time to stop spam and repeated sign-in attempts. We
                don’t store it with your booking.
              </li>
            </ul>
            <p>
              Information about your health is <strong>sensitive personal information</strong> under the Data Privacy Act. We
              handle it with extra care, as described below.
            </p>
          </section>

          <section id="use">
            <h2>How we use it</h2>
            <ul>
              <li>To arrange, confirm, change or cancel your appointments, and to call or text you about them</li>
              <li>To match you with an available dentist, and with the same dentist on future visits if you’ve seen them before</li>
              <li>To prepare for and provide your dental care, and to keep accurate patient records</li>
              <li>To let you check, move or cancel your own booking online using your reference and mobile number</li>
              <li>To run the clinic: planning schedules and understanding, in summary form, how busy we are</li>
              <li>To keep our systems secure and to meet our legal and professional obligations</li>
            </ul>
            <p>
              We do <strong>not</strong> use your information for marketing, and we do not make automated decisions about you.
            </p>
          </section>

          <section id="basis">
            <h2>Why we’re allowed to</h2>
            <p>Under the Data Privacy Act of 2012 (Republic Act No. 10173), we process your information because:</p>
            <ul>
              <li>
                <strong>You consent</strong> when you tick the box on our booking form or ask us to book for you. You can
                withdraw consent at any time, though we may then be unable to book or treat you.
              </li>
              <li>
                <strong>It’s needed to provide your care</strong>: arranging your appointments and treating you as our
                patient, including medical and dental treatment.
              </li>
              <li>
                <strong>The law requires it</strong>, for example keeping certain records or responding to a lawful order.
              </li>
            </ul>
          </section>

          <section id="share">
            <h2>Who can see it</h2>
            <ul>
              <li>
                <strong>Our clinic team</strong>: dentists and front-desk staff who need it to manage appointments and care.
                Each person has their own login, and the system records who changed what.
              </li>
              <li>
                <strong>Our website and system host</strong>, who stores the information securely on our behalf and isn’t
                allowed to use it for anything else.
              </li>
              <li>
                <strong>Others only when required or with your permission</strong>: for example, a specialist you’re referred
                to, or a government authority with a lawful request.
              </li>
            </ul>
            <p>We never sell, rent or trade your personal information.</p>
          </section>

          <section id="keep">
            <h2>How long we keep it</h2>
            <p>
              We keep appointment and patient records for as long as you are our patient and afterwards for as long as we need
              them for your continuing care and to meet legal and professional record-keeping requirements. After that, we
              securely delete or anonymise them.
            </p>
            <p>
              If you made an online request but never visited, you can ask us to delete it at any time (see{' '}
              <a href="#rights">Your rights</a>).
            </p>
          </section>

          <section id="protect">
            <h2>How we protect it</h2>
            <ul>
              <li>Only signed-in clinic staff can see bookings, and each person’s access matches their role.</li>
              <li>Staff passwords are stored in scrambled (hashed) form, and staff sessions expire automatically.</li>
              <li>The website uses an encrypted connection (HTTPS).</li>
              <li>
                To look up or change a booking online, you need both your booking reference and the mobile number you used.
                Other patients’ details are never shown.
              </li>
              <li>Every change to a booking is recorded with who made it and when.</li>
            </ul>
            <p>
              If a data breach ever puts your information at risk, we will notify you and the National Privacy Commission as
              required by law, normally within 72 hours of discovering it.
            </p>
          </section>

          <section id="rights">
            <h2>Your rights</h2>
            <p>Under the Data Privacy Act, you have the right to:</p>
            <ul className="privacy-rights">
              <li>
                <strong>Be informed</strong> about how your information is collected and used (this policy)
              </li>
              <li>
                <strong>Access</strong> the personal information we hold about you
              </li>
              <li>
                <strong>Correct</strong> anything that is wrong or out of date
              </li>
              <li>
                <strong>Object</strong> to processing, or <strong>withdraw consent</strong>
              </li>
              <li>
                <strong>Erasure or blocking</strong> of information that is no longer needed or was processed unlawfully
              </li>
              <li>
                <strong>Data portability</strong>: get a copy of your information in a commonly used format
              </li>
              <li>
                <strong>Damages</strong> if you suffer harm from inaccurate, unlawfully obtained or unauthorised use of your
                information
              </li>
              <li>
                <strong>File a complaint</strong> with the National Privacy Commission (privacy.gov.ph)
              </li>
            </ul>
            <p>
              To use any of these rights, <a href="#contact">contact us</a>. We may ask you to confirm your identity first, to
              protect your information. We’ll respond as soon as we can and within the time the law allows. You can change or
              cancel an upcoming appointment yourself at any time on our <Link to="/manage">manage your booking</Link> page.
            </p>
          </section>

          <section id="children">
            <h2>Children</h2>
            <p>
              We care for children, but bookings for anyone under 18 should be made by a parent or guardian, who gives consent
              on the child’s behalf and can use the rights above for them.
            </p>
          </section>

          <section id="website">
            <h2>Cookies and the website</h2>
            <ul>
              <li>
                Our public website does <strong>not</strong> use cookies, advertising trackers or analytics.
              </li>
              <li>
                Our clinic staff portal uses a single essential cookie to keep staff signed in. It isn’t used for patients.
              </li>
              <li>
                Our website loads its fonts from Google Fonts, so your browser connects to Google to download them. Google may
                receive your IP address as part of that request.
              </li>
              <li>
                Links to Facebook, Instagram and Google Maps take you to those services, which have their own privacy policies.
              </li>
            </ul>
          </section>

          <section id="changes">
            <h2>Changes to this policy</h2>
            <p>
              We’ll update this page if the way we handle your information changes, and change the “last updated” date at the
              top. If a change significantly affects you, we’ll tell you directly where we can.
            </p>
          </section>

          <section id="contact">
            <h2>Contact us</h2>
            <p>For privacy questions or requests, please contact our Data Protection Officer:</p>
            <div className="privacy-contact">
              <strong>Data Protection Officer, {CLINIC.name}</strong>
              <span>
                {CLINIC.addressLine1}, {CLINIC.addressLine2}
              </span>
              <span>
                Phone: <a href={CLINIC.phoneHref}>{CLINIC.phoneDisplay}</a>
              </span>
              <span>Or ask any of our staff at the clinic, Monday–Thursday and Saturday, 9:00 AM – 5:00 PM.</span>
            </div>
            <p>
              If you’re not satisfied with our response, you can contact the <strong>National Privacy Commission</strong> at
              privacy.gov.ph.
            </p>
          </section>
        </article>

        <p className="privacy-back">
          <Link to="/">← Back to the clinic website</Link>
        </p>
      </main>
    </div>
  );
}
