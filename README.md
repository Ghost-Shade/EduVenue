# Hack-the-Campus
AI for Good

---

# EduVenue

**Smart campus facilities discovery, scheduling and booking — built for Maseno University.**

EduVenue lets students *see* what rooms exist and when they are free, and lets class
representatives *book* an eligible free slot with immediate confirmation. It is a
runnable local application: one command seeds a demonstration campus, one command starts
the API and the web client together. It runs on PostgreSQL, and the same code deploys to
Vercel as two services — a static client and the API — backed by a hosted Postgres.

> **Demonstration data only.** Every facility, capacity, opening hours and booking in this
> repository is invented sample data. None of it describes Maseno University's real
> venues, and this application is not connected to any university system. See
> [Honesty notes](#honesty-notes).

---

## Contents

- [What it does](#what-it-does)
- [The one rule that matters](#the-one-rule-that-matters)
- [Quick start (Windows PowerShell)](#quick-start-windows-powershell)
- [Deploying to Vercel](#deploying-to-vercel)
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

That is enforced in the database, and it holds when two representatives submit at the
same instant. Three things combine to provide it:

1. **Half-open intervals.** A booking occupies `[start, end)`. A booking ending at 11:00
   and one starting at 11:00 do not overlap — which is what makes back-to-back classes
   possible at all. The predicate is
   `newStart < existingEnd AND newEnd > existingStart`, both comparisons strict.

2. **A PostgreSQL exclusion constraint.** `bookings_no_overlap` makes it *impossible* for
   two confirmed rows for one facility to overlap, using a GiST index over
   `tstzrange(effective_start, effective_end)`:

   ```sql
   -- declared on the table, verbatim from server/src/db/schema.sql
   constraint bookings_no_overlap
     exclude using gist (
       facility_id with =,
       tstzrange(effective_start, effective_end) with &&
     ) where (status = 'confirmed')
   ```

   This is not a check the application performs and hopes to get right — it is a rule the
   storage engine will not let *any* writer break. A second application instance, a
   migration script or a careless `psql` session is refused identically.

3. **A transaction around the write.** `createBooking` runs inside a transaction, so the
   reference number, the audit row and the booking either all land or none do. If two
   requests do race, one of them loses to the constraint above: PostgreSQL raises SQLSTATE
   `23P01`, the transaction rolls back, and the loser is re-described using the *same*
   helper the ordinary pre-check uses — so the user sees the identical `409 CONFLICT`
   naming the booking that got there first, and cannot tell which path refused them.

The application still checks for a conflict before inserting, but that is now a courtesy:
it exists to produce a good error, not to provide the guarantee. The guarantee is the
index.

**Why the buffer is half-applied.** A facility with `buffer_minutes = b` requires a gap of
exactly `b` between bookings. The constraint gets that by widening each stored booking by
`b/2` at each end, and the halves are exact rather than a fudge: widening each side by the
*full* buffer would demand a `2b` gap and silently refuse legal bookings. The two forms
are proved equivalent, over a table of boundary cases, in `overlap.test.ts` — and
`overlapConstraint.test.ts` proves the database agrees, by asserting that a gap of exactly
`b` is accepted.

**This survives horizontal scaling.** The guarantee lives in the database, so it holds
across any number of application instances, hosts and regions. There is no single-process
caveat, because there is no single process holding a lock.

## Quick start (Windows PowerShell)

Requires:

- **Node.js 18 or newer** (developed and tested on Node 22).
- **PostgreSQL 16.** The quickest way is Docker Desktop, which the included
  `docker-compose.yml` uses. A Postgres you already run is fine too — point `DATABASE_URL`
  at it. This is the one real cost of the migration from SQLite: the database is no longer
  a file the application creates by itself.

```powershell
# 1. Install everything (root, server and client)
npm run setup

# 2. Start PostgreSQL (port 5433, to avoid colliding with an existing server)
docker compose up -d

# 3. Create your .env from the template
Copy-Item .env.example .env

# 4. Generate a real session secret and write it into .env
$secret = -join ((1..64) | ForEach-Object { '{0:x}' -f (Get-Random -Max 16) })
(Get-Content .env) -replace '^SESSION_SECRET=.*', "SESSION_SECRET=$secret" | Set-Content .env

# 5. Create the schema and seed the demonstration data
npm run db:reset

# 6. Start the API and the web client together
npm run dev
```

Then open **http://localhost:5173**.

- The client runs on **5173** (Vite).
- The API runs on **4000** (Express).
- Vite proxies `/api` to the API, so the session cookie is same-origin. There is no CORS
  configuration anywhere, deliberately.
- The database lives in a Docker volume, not a file in the repository. `docker compose
  down` stops it and keeps the data; `docker compose down -v` stops it and deletes the
  data.

Other commands:

```powershell
npm test           # unit, API and database-constraint tests (needs Postgres running)
npm run typecheck  # TypeScript, server and client
npm run build      # production build of the client
npm run db:reset   # wipe and re-seed the demonstration data
```

## Deploying to Vercel

`vercel.json` describes the project as **two services**, which is the shape this
application actually has:

| Service | Framework | Public path | Role |
|---|---|---|---|
| `client` | `vite` | `/` | The static React build. |
| `server` | `express` | `/api` | The API, as a serverless function. |

Both are routed by `rewrites` with object destinations, which pass the original path
through unchanged — so `/api/facilities` reaches the API as `/api/facilities`, matching the
Express router mounted at `/api`. **No bindings are needed**, because nothing here calls
another service over the network: the client is a static build and the API talks only to
Postgres.

Set `DATABASE_URL` in the Vercel project. The recommended route is the **Neon integration**,
which provisions the database and injects the variable for you; there is no default in
production, so a missing value stops the function with a clear error instead of falling
back to something local.

Because each serverless instance opens its own connection pool, `DATABASE_POOL_MAX` is
kept deliberately small (5 by default), and the API does **no** database work at module
scope — the app is constructed at import time, and the connection is opened lazily on the
first query. That keeps a cold start from waiting on Postgres.

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
├── docker-compose.yml          Local PostgreSQL 16 (+ the test database)
├── vercel.json                 Two services: client at /, server at /api
├── server/                     Express API (TypeScript, run through tsx)
│   ├── api/
│   │   └── index.ts            Vercel serverless entrypoint — exports the app
│   └── src/
│       ├── app.ts              createApp(): the shared factory. No boot, no DB access
│       ├── index.ts            Local dev boot: waits for the DB, then listens
│       ├── db/
│       │   ├── schema.sql      Tables, CHECK constraints, THE exclusion constraint, triggers
│       │   ├── connection.ts   pg Pool, transactions, the named-parameter shim
│       │   ├── migrate.ts      Applies schema.sql (idempotent)
│       │   ├── seed.ts         The demonstration dataset
│       │   └── reset.ts        Drop, migrate, seed
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
│       └── tests/              overlap, time, booking engine, API, database constraint
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

Five suites. The database must be running (`docker compose up -d`) but no network access
is needed beyond it.

| File | Covers |
|---|---|
| `src/tests/overlap.test.ts` | The overlap predicate in isolation: symmetry, containment, adjacency, buffers, gap subtraction, and the proof that the half-buffer form the constraint uses equals the full-buffer form the service uses |
| `src/tests/time.test.ts` | Campus time: the fixed UTC+3 assumption *verified against `Intl`*, leap days, impossible dates, day boundaries |
| `src/tests/booking.test.ts` | The rules through the real service: adjacency, all four overlap shapes, buffers, opening hours, closed days, blocks, capacity, activities, roles, cancellation, and that a rejected booking leaves nothing behind |
| `src/tests/api.test.ts` | The whole request path over HTTP: sessions, role gates, error shapes, availability privacy, case-insensitive search, exact activity matching, and **eight simultaneous requests for one slot — exactly one confirmed** |
| `src/tests/overlapConstraint.test.ts` | **The guarantee, against the database itself.** Writes overlapping rows with plain SQL, bypassing the service entirely, and asserts PostgreSQL refuses with SQLSTATE `23P01` — including the cases a service-layer test cannot reach: a cancelled row stops blocking, and a gap of exactly the buffer is accepted |

The last one is the important one. Every other booking test exercises the code that is
*supposed* to prevent an overlap, and code that is supposed to do something is exactly the
code that can be wrong. That file writes rows as a second application instance would and
checks that the storage engine says no.

Tests run against a **separate database** (`eduvenue_test`), not a schema inside the
development one, so a bug in the test teardown cannot reach development data. Within it,
each test file gets **its own schema**, fixed by the connection's `search_path`, so files
that `node --test` runs in parallel cannot see each other's rows.

They use the same Postgres engine as production. That is deliberate: the exclusion
constraint is the guarantee, so testing anything other than real Postgres would mean
testing a different system from the one that ships.

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
- **A CI pipeline.** `npm test` and `npm run typecheck` are the checks; nothing runs them
  automatically on push, so the test suite is a thing you run rather than a gate.
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
  becomes a generic 500, with the detail logged server-side only. A database constraint
  violation is translated rather than forwarded: SQLSTATE `23P01` becomes the same `409
  CONFLICT` the ordinary check produces, so a client cannot learn from an error code
  which mechanism rejected it — or probe the schema by triggering constraints.
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
- **Not production-ready.** It is a demonstration: no administrator screens, no CI, and
  demo credentials that are deliberately public. Two claims worth separating from that
  general one:
  - The concurrency guarantee is now a **database constraint**, so it *does* hold across
    instances, hosts and regions. The single-process caveat the earlier SQLite build had
    is gone, and the [section above](#the-one-rule-that-matters) no longer hedges.
  - The recommender is deliberately unoptimised — it runs one query per candidate per
    facility, which was free against an in-process file and is **not** free over a
    network. Its latency against hosted Postgres has not been measured, so it is described
    as unmeasured rather than as fast.
- **The Vercel configuration is written, not yet proven.** `vercel.json`, the serverless
  entrypoint and the runtime binding of `DATABASE_URL` are in place, but this README does
  not claim a live deployment works until one has been exercised end to end.
- **The timezone assumption is tested, not trusted.** `Africa/Nairobi` is UTC+3 with no
  daylight saving, which lets the code convert with arithmetic instead of a timezone
  database. A test compares that against `Intl`, so if the assumption ever became false a
  test fails rather than bookings shifting by an hour.

## Troubleshooting

**`SESSION_SECRET is not set`** — step 3 or 4 of the quick start was skipped. Create
`.env` from `.env.example` and generate a secret.

**`'concurrently' is not recognized`** — `npm run setup` has not been run, so the root
dependencies are missing.

**`Could not reach the server`** in the browser — the API on port 4000 is not running.
`npm run dev` starts both; check the server output for a startup error.

**`ECONNREFUSED 127.0.0.1:5433`**, or `waitForDatabase` timing out — PostgreSQL is not
running. `docker compose up -d` starts it; `docker compose ps` shows whether it is healthy.
If you run your own Postgres instead, point `DATABASE_URL` at it.

**`docker compose` is not recognized, or the daemon is not running** — Docker Desktop must
be installed and started. This is a new prerequisite compared with the earlier SQLite
build, and it is the price of testing against the same engine that runs in production.

**`extension "btree_gist" is not available`** — the constraint that prevents overlapping
bookings needs that extension, which ships with the standard `postgresql-contrib`. The
Docker Compose image has it. A Postgres you installed yourself may not; install the
contrib package for your version.

**`That DATABASE_URL points at a remote host, and this command DROPS EVERY TABLE`** —
`db:reset` refuses to wipe a non-local database, in case a deployed URL happens to be
exported in the same shell. If that is genuinely what you want, add `--force`:

```powershell
npm run db:reset -- --force
```

**`The database has no schema yet`** — run `npm run db:reset`.
