# Hack-the-Campus
AI for Good

---

# EduVenue

**Smart campus facilities discovery, scheduling and booking — built for Maseno University.**

EduVenue lets students *see* what rooms exist and when they are free, and lets class
representatives *book* an eligible free slot with immediate confirmation. It is a
runnable local application: one command seeds a demonstration campus, one command starts
the API and the web client together.

> **Demonstration data only.** Every facility, capacity, opening hours and booking in this
> repository is invented sample data. None of it describes Maseno University's real
> venues, and this application is not connected to any university system. See
> [Honesty notes](#honesty-notes).

---

## Contents

- [What it does](#what-it-does)
- [The one rule that matters](#the-one-rule-that-matters)
- [Quick start (Windows PowerShell)](#quick-start-windows-powershell)
- [Demo accounts](#demo-accounts)
- [How the pieces fit](#how-the-pieces-fit)
- [Tests](#tests)
- [API surface](#api-surface)
- [What is deliberately not built](#what-is-deliberately-not-built)
- [Security notes](#security-notes)
- [Honesty notes](#honesty-notes)
- [Troubleshooting](#troubleshooting)

---

## What it does

| Capability | Where |
|---|---|
| Browse six categories of facility (lecture, computing, science, medical/health-training, collaborative, other) | Directory |
| Search and filter by category, building, minimum capacity, free text | Directory |
| See any facility's day: what is booked, what is blocked, what is free | Facility page |
| Book an eligible free slot, **confirmed immediately** | Booking form |
| Get a ranked shortlist with the reasons for each choice | *Find me a room* |
| View, and cancel, your own bookings | My bookings |
| Understand why a facility is out of reach | Everywhere a rule applies |

**Roles**

| Role | Can do |
|---|---|
| Student | Browse facilities and schedules. Cannot book. |
| Class representative | Everything above, **plus** immediate booking of eligible facilities. |
| Supervisor | Everything a representative can, **plus** supervised facilities (laboratories). |
| Facility administrator | Everything, plus cancelling any booking that has started. |

There is no self-registration. An account's role is what makes a booking trustworthy, so
accounts are issued rather than claimed.

## The one rule that matters

> **Two confirmed bookings can never overlap for the same facility.**

That is enforced on the server, and it holds when two representatives submit at the same
instant. Three things combine to provide it:

1. **Half-open intervals.** A booking occupies `[start, end)`. A booking ending at 11:00
   and one starting at 11:00 do not overlap — which is what makes back-to-back classes
   possible at all. The predicate is
   `newStart < existingEnd AND newEnd > existingStart`, both comparisons strict.

2. **`BEGIN IMMEDIATE`.** Every booking runs inside a single transaction that takes
   SQLite's write lock *at the start*, not lazily at the first write. A second request
   therefore waits, then observes the first request's committed row and is correctly
   refused. The form of the transaction is the guarantee — see
   `server/src/db/connection.ts`.

3. **Atomic check-then-insert.** `better-sqlite3` is synchronous and Node is
   single-threaded, so the transaction body cannot be interleaved by another request.
   Checking for a conflict and inserting cannot be separated.

The client also checks, but that is only a courtesy: the check that counts happens inside
the transaction, where the data cannot go stale between validation and write.

**Honest limitation.** This guarantee holds **within one server process.** It would not
hold across multiple processes or hosts. A deployment would use PostgreSQL's
`EXCLUDE USING gist (facility_id WITH =, tstzrange(start_time, end_time) WITH &&)`,
which enforces the same rule inside the index and therefore survives horizontal scaling.
SQLite has no equivalent, which is why the transaction form is doing the work here.

## Quick start (Windows PowerShell)

Requires **Node.js 18 or newer** (developed and tested on Node 22). Nothing else — no
database server, no Docker.

```powershell
# 1. Install everything (root, server and client)
npm run setup

# 2. Create your .env from the template
Copy-Item .env.example .env

# 3. Generate a real session secret and write it into .env
$secret = -join ((1..64) | ForEach-Object { '{0:x}' -f (Get-Random -Max 16) })
(Get-Content .env) -replace '^SESSION_SECRET=.*', "SESSION_SECRET=$secret" | Set-Content .env

# 4. Create and seed the demonstration database
npm run db:reset

# 5. Start the API and the web client together
npm run dev
```

Then open **http://localhost:5173**.

- The client runs on **5173** (Vite).
- The API runs on **4000** (Express).
- Vite proxies `/api` to the API, so the session cookie is same-origin. There is no CORS
  configuration anywhere, deliberately.
- The SQLite file is created at `data/eduvenue.db` on first run.

Other commands:

```powershell
npm test           # unit and API tests
npm run typecheck  # TypeScript, server and client
npm run build      # production build of the client
npm run db:reset   # wipe and re-seed the demonstration data
```

## Demo accounts

All demonstration accounts share the password **`Demo#Pass2026`**. They are listed on the
sign-in page with one-click buttons while `ENABLE_DEMO_LOGINS=true`.

| Email | Role | What to look at |
|---|---|---|
| `student@eduvenue.test` | Student | Browse only — booking is refused |
| `rep.brian@eduvenue.test` | Representative | Book a free slot, get it confirmed instantly |
| `rep.cynthia@eduvenue.test` | Representative | The second person competing for the same room |
| `supervisor@eduvenue.test` | Supervisor | A supervised laboratory that representatives cannot book |
| `admin@eduvenue.test` | Administrator | Cancel a booking that has already started |

`eduvenue.test` is a reserved domain (RFC 2606) — these addresses cannot receive mail.

## How the pieces fit

```
EduVenue/
├── server/                     Express API (TypeScript, run through tsx)
│   └── src/
│       ├── db/
│       │   ├── schema.sql      Tables, CHECK constraints, partial index, triggers
│       │   ├── connection.ts   Pragmas + inImmediateTransaction — the guarantee lives here
│       │   ├── migrate.ts      Applies schema.sql (idempotent)
│       │   ├── seed.ts         The demonstration dataset
│       │   └── reset.ts        Delete, migrate, seed
│       ├── lib/
│       │   ├── overlap.ts      The overlap predicate, pure and dependency-free
│       │   ├── time.ts         Campus time (Africa/Nairobi, UTC+3, no DST)
│       │   ├── roles.ts        Role hierarchy
│       │   ├── errors.ts       Typed API errors
│       │   └── validation.ts   Zod schemas
│       ├── middleware/         Session, authorization, error handling
│       ├── services/
│       │   ├── bookingService.ts        The booking engine, and the dry-run evaluator
│       │   ├── facilityService.ts       Directory + availability
│       │   ├── recommendationService.ts The rules-based matcher
│       │   ├── sessionService.ts        Server-side sessions
│       │   ├── authService.ts           Password verification
│       │   └── auditService.ts          Audit trail
│       ├── routes/             auth, facilities, bookings
│       └── tests/              overlap, time, booking engine, API
└── client/                     React 18 + TypeScript + Vite + Tailwind
    └── src/
        ├── lib/                api client, types, time formatting, role helpers
        ├── auth/               session context
        ├── components/         layout, facility card, shared UI states
        ├── hooks/              useResource
        └── pages/              login, dashboard, directory, facility, booking, suggest, bookings
```

### Why the recommendation engine shares the booking rules

`bookingService.evaluateBookingRequest` runs the **full** rule set and reports the outcome
instead of throwing. The recommendation engine calls it for every candidate.

That is not a tidiness choice. A second copy of the rules would drift, and the failure
mode — *the app suggests a slot, then refuses to book it* — is exactly the kind of thing
that destroys trust in a booking system. Sharing one implementation makes that failure
impossible by construction, and there is an API test that books every facility the
recommender offers and asserts each one is accepted.

The engine is also **not artificial intelligence**. It filters, scores and explains,
deterministically. The same request always produces the same answer.

## Tests

```powershell
npm test
```

Four suites, none of which need a database server or a network connection:

| File | Covers |
|---|---|
| `src/tests/overlap.test.ts` | The overlap predicate in isolation: symmetry, containment, adjacency, buffers, gap subtraction |
| `src/tests/time.test.ts` | Campus time: the fixed UTC+3 assumption *verified against `Intl`*, leap days, impossible dates, day boundaries |
| `src/tests/booking.test.ts` | The rules through the real service: adjacency, all four overlap shapes, buffers, opening hours, closed days, blocks, capacity, activities, roles, cancellation, and that a rejected booking leaves nothing behind |
| `src/tests/api.test.ts` | The whole request path over HTTP: sessions, role gates, error shapes, availability privacy, and **eight simultaneous requests for one slot — exactly one confirmed** |

Tests run against a **separate, in-memory database** (`TEST_DATABASE_FILE`), created fresh
per test file. Running the suite cannot touch `data/eduvenue.db`.

## API surface

Every route is under `/api`. Nothing here is public except `/health` and `/auth/*`.

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/health` | Liveness |
| `POST` | `/api/auth/login` | Sets an httpOnly session cookie |
| `POST` | `/api/auth/logout` | Revokes the session |
| `GET` | `/api/auth/me` | `{ user: null }` when signed out |
| `GET` | `/api/auth/demo-accounts` | Only when demo mode is enabled |
| `GET` | `/api/facilities` | Filters: `q`, `categoryId`, `building`, `activity`, `minCapacity`, `sort`, `direction` |
| `GET` | `/api/facilities/categories` | With active facility counts |
| `GET` | `/api/facilities/buildings` | Distinct buildings |
| `GET` | `/api/facilities/activities` | Distinct approved activities |
| `GET` | `/api/facilities/:id` | One facility |
| `GET` | `/api/facilities/:id/availability?date=` | That facility's day |
| `POST` | `/api/bookings` | Create a booking. Requires a representative or above |
| `POST` | `/api/bookings/recommendations` | The rules-based matcher |
| `GET` | `/api/bookings/mine?scope=` | `upcoming`, `past`, `all` |
| `GET` | `/api/bookings/:id` | Owner or administrator only |
| `POST` | `/api/bookings/:id/cancel` | Owner or administrator only |

Errors are always `{ "error": { "code", "message", "details? } }`. Clients switch on
`code` — `CONFLICT`, `OUTSIDE_OPERATING_HOURS`, `SUPERVISION_REQUIRED`, and so on — rather
than matching on message text.

The booking path checks **authorization before business rules**, so a refusal never leaks
operational detail about a facility the caller has no right to use.

## What is deliberately not built

Listed so the gaps are visible rather than discovered.

- **Administrator screens.** The API has no facility-management routes yet. The
  administrator role can see withdrawn facilities in the directory and cancel bookings
  that have started, but there is no in-app editor for facilities, blocks or policies.
  Facilities and blocks are configured through the seed data.
- **In-app notifications.** Bookings are visible in *My bookings*; nothing is pushed.
- **Recurring bookings.** A weekly class is a series of individual bookings.
- **Overnight operating hours.** A facility must close on the same day it opens. The
  schema enforces this, because "free at 02:00" is far more often a bug than a request.
- **Multi-process concurrency.** See the limitation above.
- **Password change and reset.** Demo accounts only.
- **Registration.** Deliberate — see [What it does](#what-it-does).

## Security notes

- **Authorization is server-side only.** Hiding a button is usability; the role guards in
  `middleware/auth.ts` are the control. Every privileged route is guarded individually.
- **Sessions are server-side and revocable.** The cookie holds an opaque random token;
  the database stores only its SHA-256 hash. The cookie is `httpOnly` and `SameSite=Lax`,
  and `secure` in production. Signing out revokes the row, so a stolen cookie is
  worthless afterwards.
- **Passwords** are hashed with bcrypt. An unknown email still performs a hash comparison
  against a dummy value, so response timing does not reveal which addresses have accounts,
  and the failure message is identical either way.
- **Input is validated twice** — shape and range in Zod, business rules in the service
  layer — and every query binds parameters. No user input is concatenated into SQL; LIKE
  wildcards in search terms are escaped so a search for `%` is a literal search.
- **Errors do not leak internals.** Known failures are described; anything unexpected
  becomes a generic 500, with the detail logged server-side only.
- **Availability is privacy-conscious.** Responses say that a room is taken and for what,
  but never who booked it — that is not needed to schedule, and it is not collected.
- **Secrets live in `.env`**, which `.gitignore` excludes. `.env.example` contains
  placeholders only. `SESSION_SECRET` is validated at boot: missing, short or still the
  template value stops the server with an instruction rather than a stack trace.
- **Auditability.** Logins, failed logins, bookings and cancellations are recorded with
  the actor, the action and non-sensitive context. Credentials are never recorded.

## Honesty notes

This project's own claims are held to the same standard as its code.

- **It is not AI-powered.** The recommendation engine is deterministic, rule-based
  filtering and scoring. Calling it AI would be false, so it is not called that anywhere
  in this repository or in the interface.
- **The data is invented.** Facility names, capacities, equipment and schedules were
  written for this project. They are illustrative, and the interface says so on every
  page. No claim is made about Maseno University's actual venues or booking processes.
- **Not production-ready.** It is a local demonstration: single-process concurrency
  guarantee, no administrator screens, no deployment configuration. The
  [limitation above](#the-one-rule-that-matters) is the one that matters most.
- **The timezone assumption is tested, not trusted.** `Africa/Nairobi` is UTC+3 with no
  daylight saving, which lets the code convert with arithmetic instead of a timezone
  database. A test compares that against `Intl`, so if the assumption ever became false a
  test fails rather than bookings shifting by an hour.

## Troubleshooting

**`SESSION_SECRET is not set`** — step 2 or 3 of the quick start was skipped. Create
`.env` from `.env.example` and generate a secret.

**`The database has no schema yet`** — run `npm run db:reset`.

**`'concurrently' is not recognized`** — `npm run setup` has not been run, so the root
dependencies are missing.

**`Could not reach the server`** in the browser — the API on port 4000 is not running.
`npm run dev` starts both; check the server output for a startup error.

**`better-sqlite3` fails to install** — it ships prebuilt binaries for current Node
versions. On an unsupported version it falls back to compiling, which needs a C++ build
toolchain. Use a supported Node release.
