# Beatifics Dental Clinic — Website & Admin Portal

Web app for **Beatifics Dental Clinic** (Dr. Rebecca D. Vivo, DMD — 0200 E National Highway, Tunasan, Muntinlupa City, 1773 Metro Manila; (02) 8775 9896).

Two parts:
1. **Public website** (`/`) — the clinic's one-page site where patients **request appointments**.
2. **Admin portal** (`/admin`) — a login-protected area where clinic staff **view and manage booking requests**.

**Always consider UX: number of clicks and mouse travel.** Every change should be checked for what patients (mostly on phones) and staff (often at a reception desk or tablet) actually experience: as few clicks as possible (inline actions, smart defaults, prefilled forms, keyboard shortcuts), primary actions placed next to what they act on, clear copy, loading/empty/error states, mobile layout, accessibility. Verify UI with real screenshots at desktop and ~390px.

## Commands

```bash
npm install
npm run dev            # API on :3001 + Vite on :5173 (open http://localhost:5173)
npm run seed:demo      # dev only: admin@ / reception@ / dentist@beatifics.local (password beatifics-demo) + 2 demo dentists
npm run create-admin -- <email> "<name>" <password>   # create staff account (or reset its password)
npm test               # Vitest: shared logic + API tests
npm run typecheck
npm run build          # type-check + build React app into dist/
npm start              # serve API + built site on :3001 (set NODE_ENV=production in deployment)
npm run video          # re-record the client showcase video → docs/demo/beatifics-walkthrough.mp4 (own DB + port; scripts/video/)
```

Requires **Node 22.13+** (uses the built-in `node:sqlite`; no native modules).

## Tech stack & layout

- **React 19 + Vite + TypeScript** (`client/`), React Router. Plain CSS with design tokens as CSS variables (`client/src/styles/`).
- **Node.js + Express 5** (`server/`), run with `tsx`.
- **SQLite** via built-in `node:sqlite`, file at `DATABASE_PATH` (default `./data/beatifics.db`, git-ignored). Schema migrations are an append-only list in [server/db.ts](server/db.ts) tracked with `PRAGMA user_version`.
- **Zod** schemas in `shared/` are used by **both** client and server: one source of truth for validation, status rules and Manila date logic.
- **Vitest** + Supertest for tests.

```
shared/        constants.ts (clinic info, services), booking.ts (statuses, transitions, Zod schemas, API types),
               dates.ts (Manila time helpers), schedule.ts (slots, capacity, closures, durations, calendar lanes)
server/        app.ts (wiring), routes/{public,auth,admin}.ts, context.ts, auth.ts (passwords, sessions, roles),
               bookings.ts (queries, availability, reports), closures.ts, audit.ts, settings.ts, db.ts (migrations)
client/src/    site/ (public page, BookingForm, SlotPicker, ManagePage), admin/ (lazy-loaded portal), lib/api.ts, styles/
scripts/       create-admin.ts, seed-demo.ts
```

### Admin portal map

- **Bookings** (`/admin`): views Needs action / Today / Upcoming / All, search, one-click **Confirm** on pending rows, patient tags (New patient / Returning / no-shows). Detail panel: confirm/adjust time & length, status actions, staff notes, **patient history** (same mobile), **activity log**, "Next request →" after confirming.
- **Calendar** (`/admin/calendar?date=&show=all|<dentistId>`): week strip + day timeline with **one column per dentist** (plus "No dentist yet" when needed), blocked times hatched, days off shaded, now-line. Click an empty time in a column → new appointment prefilled with that time and dentist (`new?date=&time=&dentist=`); "Block time" for closures. Panels: `new`, `block`, `:id`.
- **Reports** (`/admin/reports?period=`): stat tiles + single-series bar/column charts with table view.
- **Settings** (`/admin/settings/...`): General (time per patient, capacity, length per treatment; admin-only edit), Dentists (working days, login link, active; changes save instantly), Blocked times, Staff (admin), Activity (admin), My account (change password).
- The dentist list is loaded once per session by `DentistsProvider` ([client/src/admin/dentists.tsx](client/src/admin/dentists.tsx)); use `useDentists()`, `DentistBadge`, `DentistSelect`.
- **Alerts**: the layout polls `/api/admin/updates` (20 s) and shows a toast + soft chime + optional desktop notification for patient actions; pending count in the tab title and nav. `emitBookingsChanged()` ([client/src/admin/events.ts](client/src/admin/events.ts)) refreshes all open views.
- **Shortcuts**: `N` new appointment, `/` search, `C` calendar, `B` bookings, `←`/`→`/`T` in the calendar, Ctrl+Enter saves notes.
- Patients manage their own booking at **`/manage`** (reference + mobile): cancel, or pick a new slot (goes back to pending). Allowed until the day before the appointment.

In dev, Vite proxies `/api` to the Node server. In production, the Node server serves `dist/` and falls back to `index.html` for client routes. The admin portal is code-split, so patients never download it.

## Design source of truth

- Approved layout: [docs/assets/Beatifics Dental Website Draft/Beatifics Dental.dc.html](docs/assets/Beatifics%20Dental%20Website%20Draft/Beatifics%20Dental.dc.html) (the "main" teal version). Options B/C/D in the same folder are **rejected alternatives**; do not use them.
- `.dc.html` files are Claude Design exports. Treat them as a visual/content spec; do not ship them or `support.js` / `image-slot.js`.
- Images used by the site are copied to `client/public/images/`.
- The admin portal reuses the same tokens but is denser and task-focused.

### Design tokens (CSS variables in [client/src/styles/base.css](client/src/styles/base.css))

| Token | Value | Use |
|---|---|---|
| `--bg` | `#FAFAF7` | page background |
| `--surface` | `#FFFFFF` | cards |
| `--primary` | `#1B4B5A` | buttons, links, dark section |
| `--primary-hover` | `#123744` | |
| `--accent` / `--accent-bright` | `#2A6878` / `#3E8E9A` | eyebrows, italics, focus ring |
| `--tint` | `#E1F0EF` | chips, icon squares |
| `--ink` | `#14323D` | headings |
| `--text` | `#1A2A30` | body |
| `--muted` / `--muted-2` | `#48595F` / `#5C6D73` | secondary text |

- Fonts: **Newsreader** (headings, weight 300, italic accents) and **Figtree** (body/UI).
- Shape: pill buttons, cards `22–28px` radius, soft teal shadows, hairline borders.
- Motion: 18px fade-up reveal on scroll; disabled under `prefers-reduced-motion`.
- `base.css` must be imported **first** in `main.tsx` so page styles can override it.

## Domain rules (implemented in `shared/`)

- Clinic hours: **Mon, Tue & Thu–Sat, 9:00 AM – 5:00 PM. Wednesday and Sunday closed.**
- Timezone is always **Asia/Manila** (UTC+8). Calendar dates are `YYYY-MM-DD` strings; instants are stored as UTC ISO strings.
- Mobile numbers are normalised to `09XXXXXXXXX` (accepts spaces, dashes, `+63`).
- **Time slots** ([shared/schedule.ts](shared/schedule.ts)): every booking has `start_at` + `duration_minutes`. Patients pick a day (**tomorrow up to 60 days ahead**, clinic days only), then a free start time. Starts are offered every 30 min and must end by closing time. Same-day visits go by phone.
- **Clinic settings** (admin → Settings, `settings` table): *time per patient* (default 60 min), optional *length per treatment* (overrides it per service), and *patients at the same time* (capacity, default 2). A start time is offered only if, at every moment of the slot, fewer than `capacity` active (pending + confirmed) bookings overlap **and** it doesn't touch a blocked time.
- **Closures / blocked times** (`closures` table): once (optionally over several days), daily, or weekly; all day or a time range. They block online booking only; existing bookings stay and staff are shown which are affected.
- **Dentists** ([shared/dentists.ts](shared/dentists.ts), `dentists` table): name, identity colour (fixed validated palette, always shown with the name), working days, optional linked staff login. **Each dentist sees one patient at a time**; capacity (chairs) still caps the whole clinic. With no dentists set up, the app behaves as before (chairs only).
  - Online: optional dentist choice ("Any dentist" default). "Any" auto-assigns a free dentist, preferring the patient's **regular dentist** (last confirmed/completed), else the least busy. `dentist_requested` marks patients who chose; patient reschedules keep that dentist.
  - Blocked times can be clinic-wide or for one dentist (`closures.dentist_id`).
  - Staff can assign/reassign any booking (clears `dentist_requested`); Settings → Dentists → "Assign automatically" places unassigned upcoming bookings with free dentists without creating clashes.
  - A linked dentist's Bookings and Calendar default to their own patients ("My patients" / their column).
- **Roles**: `admin` (everything) and `staff` (bookings, calendar, blocked times, reports). Settings changes, staff accounts and the full activity feed are admin-only. At least one active admin must remain; nobody can deactivate or demote themselves.
- **Activity log** (`audit_log`): every booking, settings, closure and account change records who (staff name or "Patient") and a human summary.
- The server re-checks the slot on submit; if it was just taken it returns 409, and the form refreshes the times.
- **Staff** can change any pending/confirmed booking's time and length, and **add appointments themselves** (phone/walk-in, any date, confirmed or pending). Staff may exceed capacity on purpose; the portal warns them and shows that day's other appointments.
- A public booking is a **request**. Staff confirm it (optionally adjusting time/length) in the admin portal.
- Statuses: `pending → confirmed | cancelled`; `confirmed → completed | no_show | cancelled`; `cancelled → pending` (reopen). `completed` and `no_show` are final.
- The same mobile + day while pending is treated as a duplicate (returns the existing reference).
- Urgent cases: the site keeps telling patients to **call the clinic** for pain.

Do not add patient medical records without the owner explicitly asking. That is a much larger privacy scope.

## Security & privacy (non-negotiable)

- Patient data falls under the **Philippine Data Privacy Act of 2012 (RA 10173)**. Collect only what is needed. The booking form has a consent checkbox linking to the patient privacy policy at `/privacy` ([client/src/site/PrivacyPage.tsx](client/src/site/PrivacyPage.tsx)).
- **Keep the privacy policy true.** Any change to what we collect, who receives it (e.g. an SMS provider, analytics, a new host) or how long we keep it must update `PrivacyPage.tsx` and its `LAST_UPDATED` date in the same change.
- Public users can only **create** a booking (`POST /api/bookings`). Every other booking endpoint is under `/api/admin` behind `requireStaff`.
- Staff auth: scrypt-hashed passwords, random session tokens stored **hashed** in SQLite, `httpOnly` + `SameSite=Lax` cookie (`Secure` in production), 7-day expiry. No public sign-up.
- Rate limits on booking and login; honeypot field on the booking form; 20 KB JSON body limit.
- Secrets/config go in `.env` (git-ignored); keep `.env.example` up to date.

## API

| Method | Path | Auth |
|---|---|---|
| GET | `/api/availability?service=&dentist=<id\|any>` → `{durationMinutes, days: {date: ['HH:mm', …]}}` · GET `/api/dentists` | public |
| POST | `/api/bookings` (`{fullName, mobile, service, dentistId?, preferredDate, preferredTime, notes, consent}`) | public |
| POST | `/api/manage/lookup`, `/cancel`, `/availability`, `/reschedule` (all take `{reference, mobile}`) | public (rate-limited) |
| POST | `/api/auth/login`, `/logout`, `/password` · GET `/api/auth/me` | — / staff |
| GET / POST | `/api/admin/bookings?view=action\|today\|upcoming\|all&q=&dentist=<id\|unassigned>` · POST creates a staff appointment | staff |
| GET / PATCH | `/api/admin/bookings/:id` → `{booking, history, activity}` · PATCH `{status?, startAt?, durationMinutes?, dentistId?, staffNotes?}` | staff |
| GET · POST / PATCH · POST | `/api/admin/dentists` (+ `unassignedUpcoming`) · `/dentists`, `/dentists/:id` · `/dentists/auto-assign` | GET staff · rest admin |
| GET | `/api/admin/schedule?date=` (day + closures) · `/calendar?from=&to=` (≤6 weeks) · `/patients/lookup?mobile=` · `/updates?since=` · `/reports?from=&to=` | staff |
| GET / POST / DELETE | `/api/admin/closures` · `/closures/preview` (affected bookings) · `/closures/:id` | staff |
| GET / PUT | `/api/admin/settings` (`{appointmentMinutes, capacity, serviceMinutes}`) | GET staff · PUT admin |
| GET / POST / PATCH | `/api/admin/users`, `/users/:id` · GET `/api/admin/activity` | admin |

Errors are `{ error, fields? }`, with friendly, user-facing messages.

## Team of agents

Defined in [.claude/agents/](.claude/agents/). Typical flow for a feature:

1. **feature-strategist** proposes and specs the feature → `docs/features/<slug>.md`
2. **ui-ux-designer** adds the UX/visual spec to that doc (or reviews existing UI)
3. **developer** implements it, with tests for the logic it adds
4. **qa-tester** tests it against the spec's acceptance criteria and reports pass/fail with evidence
5. Any failures go back to **developer**

A feature is done only when qa-tester reports it passing.

## Conventions

- TypeScript `strict`; no `any` without a comment saying why.
- Put rules shared by client and server in `shared/`; validate every mutation on the server with Zod.
- Mobile-first: check at ~375–390px wide. Touch targets ≥ 44px. Inputs use 16px text so iOS doesn't zoom.
- Accessibility: semantic HTML, labelled inputs, `aria-invalid` + described errors, visible focus, WCAG AA contrast.
- Every async UI has loading, empty, error and success states.
- Add a new DB migration rather than editing an existing one.
