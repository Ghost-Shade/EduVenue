-- ===========================================================================
-- EduVenue - Smart Campus Facilities Discovery, Scheduling and Booking
-- PostgreSQL schema
-- ===========================================================================
--
-- DESIGN NOTES (read these before changing anything)
--
-- 1. TIME. Every instant is a native `timestamptz`. Not a string, not a
--    "seconds since epoch" integer.
--
--    The previous SQLite build stored instants as fixed-width ISO-8601 TEXT so
--    that lexicographic comparison happened to equal chronological comparison.
--    That was a workaround for the absence of a real type, and it was enforced
--    by a CHECK constraint because a single non-canonical row would have
--    silently broken every range query. A `timestamptz` column makes the same
--    guarantee at the type level, so those CHECKs are gone rather than ported.
--
--    Local wall-clock values (operating hours) are still stored separately as
--    "HH:MM" text, because "the lab opens at 08:00" is inherently a local
--    statement and is not an instant. The campus timezone is Africa/Nairobi;
--    see server/src/lib/time.ts.
--
-- 2. INTERVALS ARE HALF-OPEN: [start_time, end_time).
--    A booking ending at 16:00 and one starting at 16:00 do NOT overlap. This
--    allows back-to-back bookings and is relied on by the conflict logic. The
--    `tstzrange` values below are constructed with the default `[)` bounds,
--    which is the same convention expressed in the type system.
--
-- 3. CONFLICT PREVENTION IS A DATABASE CONSTRAINT.
--
--    The rule is: two confirmed bookings can never overlap for one facility.
--    It is enforced by `bookings_no_overlap` below, an exclusion constraint on
--    `bookings`, and NOT by anything the application does.
--
--    That is a deliberate change from the SQLite build, which relied on
--    BEGIN IMMEDIATE plus a synchronous driver to serialise the check and the
--    insert. That worked, but only inside a single process: two instances of the
--    application would each hold their own lock and could both accept the same
--    slot. An exclusion constraint is enforced by the database inside an index,
--    so it holds across processes, instances and hosts.
--
--    The application ALSO checks before inserting, because that is where a
--    friendly "this clashes with Brian's revision session" message comes from.
--    That check is a courtesy. This constraint is the guarantee.
--
-- 4. THE BUFFER IS WIDENED BY HALF ON EACH SIDE, AND THE WIDENED WINDOW IS
--    STORED. See the long comment above `bookings_no_overlap`.
--
-- 5. THIS IS A HACKATHON PROTOTYPE. All seeded facility names, capacities and
--    schedules are illustrative sample data. There is no integration with any
--    Maseno University system, and no sample schedule reflects reality.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- btree_gist
--
-- Required by the exclusion constraint below. A GiST index can compare ranges
-- with `&&` natively, but it cannot compare a plain `text` with `=` unless this
-- extension supplies the operator class that lets it. Without btree_gist,
-- `facility_id with =` is rejected outright.
--
-- Installed into `public` explicitly, rather than into "the first schema on the
-- search_path". The test suite creates a schema per test file and puts it first
-- on the path; if this landed in one of those, every other test schema would
-- create its tables successfully and then fail to find the operator class.
-- ---------------------------------------------------------------------------
create extension if not exists btree_gist with schema public;

-- ---------------------------------------------------------------------------
-- facility_categories
--
-- Configurable category directory. Admins can add categories without any code
-- change, satisfying the "extensible facility types" requirement.
-- ---------------------------------------------------------------------------
create table if not exists facility_categories (
    id          text primary key,
    name        text not null unique,
    description text not null default '',
    sort_order  integer not null default 0,
    created_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- profiles
--
-- Application users. `role` is read on every authorization decision and is NEVER
-- accepted from the client - see middleware/identity.ts. A request may choose
-- WHICH profile it acts as; it may never choose a role.
--
-- NOTE: THERE IS NO CREDENTIAL COLUMN, and that is the current design rather
-- than an oversight. This build has no authentication: the acting user is
-- chosen from the demo list (see services/identityService.ts), so a profile is
-- a label describing who you are pretending to be, not an account anyone proves
-- they own. Anyone can act as anyone.
--
-- That is a deliberate, documented reduction in scope for a prototype holding
-- invented data. It means `role` here is a SIMULATION of the role model the
-- brief describes, not a security control: nothing prevents a caller from
-- choosing the administrator. See the honesty notes in README.md. If this were
-- ever to hold real data, the credential column, the session table and the
-- login route would all have to come back together - they were removed as one
-- piece, and half of them alone would be worse than none.
-- ---------------------------------------------------------------------------
create table if not exists profiles (
    id            text primary key,
    email         text not null unique,
    display_name  text not null check (length(trim(display_name)) > 0),
    role          text not null default 'student'
                  check (role in ('student', 'rep', 'supervisor', 'admin')),
    department    text,
    created_at    timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- facilities
--
-- One row per bookable space. Booking behaviour is data-driven:
--   booking_policy     - who may book at all
--   min_role           - minimum role required
--   allowed_activities - which purposes are permitted
--   buffer_minutes     - required transition gap between bookings
--   slot_minutes       - scheduling granularity offered by the UI
--
-- `status = 'inactive'` is a soft removal. Facilities are never hard-deleted
-- while bookings reference them (ON DELETE RESTRICT below), which keeps booking
-- history intact when a facility is withdrawn.
-- ---------------------------------------------------------------------------
create table if not exists facilities (
    id                   text primary key,
    name                 text not null unique check (length(trim(name)) > 0),
    category_id          text not null references facility_categories (id) on delete restrict,
    building             text not null default 'Unspecified',
    location_description text not null default '',
    capacity             integer not null check (capacity > 0),
    description          text not null default '',

    -- Equipment and accessibility are JSON arrays of short display strings,
    -- e.g. ["Projector", "Whiteboard"] and ["Ground floor", "Step-free access"].
    -- Stored as jsonb rather than child tables because they are display-only
    -- attributes that are never joined or aggregated on. `jsonb` is always
    -- well-formed, so the `json_valid()` CHECKs the SQLite schema needed are
    -- replaced by the type itself - and `@>` containment becomes available for
    -- exact membership tests (see facilityService.ts).
    equipment            jsonb not null default '[]'::jsonb,
    accessibility        jsonb not null default '[]'::jsonb,

    status               text not null default 'active'
                         check (status in ('active', 'inactive', 'maintenance')),

    -- Local Nairobi wall-clock operating window. closes_at must be after
    -- opens_at: overnight facilities are deliberately unsupported (documented
    -- limitation) so that operating-hour checks stay a simple comparison.
    opens_at             text not null default '07:00'
                         check (opens_at ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
    closes_at            text not null default '21:00'
                         check (closes_at ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
    closed_days          jsonb not null default '[]'::jsonb,

    slot_minutes         integer not null default 60 check (slot_minutes between 15 and 240),
    buffer_minutes       integer not null default 0
                         check (buffer_minutes between 0 and 120
                                and buffer_minutes < slot_minutes),

    booking_policy       text not null default 'open'
                         check (booking_policy in ('open', 'restricted', 'supervisor_required')),
    min_role             text not null default 'rep'
                         check (min_role in ('student', 'rep', 'supervisor', 'admin')),
    allowed_activities   jsonb not null default '[]'::jsonb,

    created_at           timestamptz not null default now(),
    updated_at           timestamptz not null default now(),

    check (closes_at > opens_at)
);

-- ---------------------------------------------------------------------------
-- facility_blocks
--
-- Maintenance windows, closures and reserved periods that make a facility
-- unavailable regardless of bookings. Checked inside the booking transaction.
-- ---------------------------------------------------------------------------
create table if not exists facility_blocks (
    id          text primary key,
    facility_id text not null references facilities (id) on delete cascade,
    start_time  timestamptz not null,
    end_time    timestamptz not null,
    reason      text not null default 'Unavailable',
    created_by  text references profiles (id) on delete set null,
    created_at  timestamptz not null default now(),

    check (end_time > start_time)
);

-- ---------------------------------------------------------------------------
-- booking_reference_seq
--
-- Monotonic source of the numeric part of a booking reference (EDU-2026-0007).
--
-- A dedicated sequence table rather than MAX(id) or COUNT(*), because an
-- identity column never reuses a value even after deletes - so a reference
-- shown to a user is never later reassigned to a different booking. This was
-- AUTOINCREMENT in SQLite, which promises exactly the same thing;
-- `generated always as identity` is the PostgreSQL equivalent. (A bare `serial`
-- would NOT do: a serial is backed by a plain sequence that is not bound to the
-- table's lifetime, which is a weaker promise than the one this relies on.)
-- ---------------------------------------------------------------------------
create table if not exists booking_reference_seq (
    id         integer primary key generated always as identity,
    created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- bookings
--
-- The central table. `status` drives almost everything:
--   confirmed - holds the slot; the overlap check considers it
--   cancelled - releases the slot; ignored by the overlap check
--   completed - past and attended; ignored by the overlap check
--
-- NOTE the CHECK constraints below. They encode business rules that must hold
-- no matter which code path writes a row, so a bug in a service cannot produce
-- a database state that the rest of the application cannot reason about.
--
-- `buffer_minutes`, `effective_start` and `effective_end` are explained in the
-- comment above the exclusion constraint.
-- ---------------------------------------------------------------------------
create table if not exists bookings (
    id                  text primary key,
    booking_reference   text not null unique,

    facility_id         text not null references facilities (id) on delete restrict,
    booked_by           text not null references profiles (id) on delete restrict,

    activity_purpose    text not null check (length(trim(activity_purpose)) > 0),
    expected_attendance integer not null check (expected_attendance > 0),

    start_time          timestamptz not null,
    end_time            timestamptz not null,

    -- The facility's buffer_minutes AT THE TIME OF BOOKING, and the resulting
    -- widened window. See the comment above the exclusion constraint.
    buffer_minutes      integer not null default 0 check (buffer_minutes between 0 and 120),
    effective_start     timestamptz not null,
    effective_end       timestamptz not null,

    status              text not null default 'confirmed'
                        check (status in ('confirmed', 'cancelled', 'completed')),

    created_at          timestamptz not null default now(),
    updated_at          timestamptz not null default now(),

    cancelled_at        timestamptz,
    cancelled_by        text references profiles (id) on delete set null,
    cancellation_reason text,

    -- Half-open interval sanity: zero-length and inverted bookings are invalid.
    check (end_time > start_time),

    -- The widened window must be exactly what the stated buffer produces. A
    -- CHECK is allowed to call a non-immutable function, so this can do the
    -- arithmetic that an index expression cannot, and the derived columns are
    -- therefore impossible to drift. Without this the constraint could be
    -- enforcing a window that does not correspond to any rule.
    constraint bookings_effective_window_matches_buffer check (
        effective_start = start_time - make_interval(secs => buffer_minutes * 30)
        and effective_end = end_time + make_interval(secs => buffer_minutes * 30)
    ),

    check (effective_end > effective_start),

    -- Cancellation bookkeeping must be internally consistent: either all of the
    -- cancellation columns are populated, or none are.
    check (
        (status = 'cancelled' and cancelled_at is not null)
        or (status <> 'cancelled' and cancelled_at is null)
    ),

    -- =======================================================================
    -- THE GUARANTEE
    -- =======================================================================
    --
    -- No two CONFIRMED bookings may occupy overlapping time in one facility.
    -- Enforced by the index below, by the database, for every connection from
    -- every process or host.
    --
    -- WHY THE STORED `effective_*` COLUMNS RATHER THAN AN EXPRESSION HERE
    --
    -- The rule includes a preparation buffer, so the window to compare is not
    -- [start_time, end_time) but that interval WIDENED BY HALF THE BUFFER AT
    -- EACH END:
    --
    --     [start_time - b/2, end_time + b/2)
    --
    -- Widening each row by half the buffer is algebraically identical to the
    -- application's rule (newStart < existingEnd + b AND newEnd + b >
    -- existingStart): the distance between two windows is b/2 + b/2 = b, which
    -- is exactly the gap the rule demands. Widening each side by the FULL
    -- buffer would instead require a 2b gap and reject legal bookings - the
    -- double-application bug that bookingService.ts warns about in a comment of
    -- its own.
    --
    -- The buffer is per-facility data, and an exclusion constraint cannot read
    -- another table, so it must be snapshotted onto the booking row. That also
    -- happens to be more correct: it records the gap that was in force when the
    -- booking was made, so a later change to the facility's buffer does not
    -- retroactively invalidate bookings that were legal at the time.
    --
    -- The widened window is then materialised as `effective_start` /
    -- `effective_end` rather than computed in this expression, so that the
    -- index covers two plain columns. The CHECK constraint above keeps them
    -- exactly in step with start_time, end_time and buffer_minutes, which is
    -- what makes the materialisation safe rather than a second source of truth.
    --
    -- `with =` compares facility ids; `with &&` tests whether the two ranges
    -- intersect. Both are GiST operators, which is why the index is GiST and
    -- why btree_gist is required for the text equality.
    --
    -- `where (status = 'confirmed')` makes this a partial constraint: cancelled
    -- and completed rows are not indexed and cannot block a slot. Cancelling a
    -- booking releases it, without any code having to remember to.
    -- =======================================================================
    constraint bookings_no_overlap
        exclude using gist (
            facility_id with =,
            tstzrange(effective_start, effective_end) with &&
        ) where (status = 'confirmed')
);

-- ---------------------------------------------------------------------------
-- audit_logs
--
-- Append-only record of significant actions. `metadata` holds non-sensitive
-- change detail only - deliberately never a password, token, or personal data.
-- ---------------------------------------------------------------------------
create table if not exists audit_logs (
    id          text primary key,
    actor_id    text references profiles (id) on delete set null,
    action      text not null,
    entity_type text not null,
    entity_id   text,
    metadata    jsonb not null default '{}'::jsonb,
    created_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Indexes
--
-- bookings_facility_active_idx serves the availability query and the
-- application-level overlap check. It is PARTIAL, excluding cancelled and
-- completed rows, because those are never consulted for conflict purposes and
-- should not inflate the index.
--
-- Note this is a separate index from the one the exclusion constraint builds
-- for itself. They look similar but answer different questions: this one does
-- range scans over a facility's confirmed bookings, and the constraint's does
-- interval-intersection lookups.
-- ---------------------------------------------------------------------------
create index if not exists bookings_facility_active_idx
    on bookings (facility_id, start_time, end_time)
    where status = 'confirmed';

create index if not exists bookings_user_idx
    on bookings (booked_by, start_time desc);

create index if not exists blocks_facility_time_idx
    on facility_blocks (facility_id, start_time, end_time);

create index if not exists facilities_category_idx
    on facilities (category_id);

create index if not exists facilities_status_idx
    on facilities (status);

create index if not exists audit_created_idx
    on audit_logs (created_at desc);

create index if not exists audit_entity_idx
    on audit_logs (entity_type, entity_id);

-- ---------------------------------------------------------------------------
-- updated_at maintenance
--
-- Centralised in a trigger so no service function can forget to stamp it.
--
-- This is a BEFORE trigger that rewrites the row about to be stored, rather
-- than the SQLite schema's AFTER trigger that ran a second UPDATE. A
-- PostgreSQL AFTER trigger doing the same thing would fire itself again and
-- recurse; assigning to `new` in a BEFORE trigger has no such problem.
--
-- The WHEN clause keeps the trigger from firing when a statement does not
-- change updated_at itself, which is cheaper and avoids surprising a caller
-- that deliberately set the column.
-- ---------------------------------------------------------------------------
create or replace function set_updated_at() returns trigger as $$
begin
    if new.updated_at = old.updated_at then
        new.updated_at := now();
    end if;
    return new;
end;
$$ language plpgsql;

drop trigger if exists facilities_set_updated_at on facilities;
create trigger facilities_set_updated_at
    before update on facilities
    for each row
    when (new.updated_at = old.updated_at)
    execute function set_updated_at();

drop trigger if exists bookings_set_updated_at on bookings;
create trigger bookings_set_updated_at
    before update on bookings
    for each row
    when (new.updated_at = old.updated_at)
    execute function set_updated_at();
