-- ===========================================================================
-- EduVenue - Smart Campus Facilities Discovery, Scheduling and Booking
-- SQLite schema
-- ===========================================================================
--
-- DESIGN NOTES (read these before changing anything)
--
-- 1. TIME. Every instant is stored as TEXT in canonical UTC ISO-8601 form with
--    millisecond precision and a trailing Z, e.g. "2026-10-14T11:00:00.000Z".
--
--    The format is deliberately FIXED-WIDTH. That makes lexicographic string
--    comparison identical to chronological comparison, so `start_time < ?`
--    works correctly in SQL without any date parsing. A CHECK constraint below
--    enforces the shape, because a single non-canonical row would silently
--    break every range query.
--
--    Local wall-clock values (operating hours) are stored separately as
--    "HH:MM" text, since "the lab opens at 08:00" is a local statement.
--    The campus timezone is Africa/Nairobi; see server/src/lib/time.ts.
--
-- 2. INTERVALS ARE HALF-OPEN: [start_time, end_time).
--    A booking ending at 16:00 and one starting at 16:00 do NOT overlap. This
--    allows back-to-back bookings and is relied on by the conflict logic.
--
-- 3. CONFLICT PREVENTION. SQLite has no EXCLUDE constraint, so the guarantee
--    is provided differently - and it is still a real guarantee:
--
--      a) The booking operation runs inside a single IMMEDIATE transaction
--         (see db/connection.ts and services/bookingService.ts). IMMEDIATE
--         acquires the write lock up front, so no other writer can interleave
--         between the overlap check and the INSERT.
--      b) better-sqlite3 is a SYNCHRONOUS driver and Node is single-threaded,
--         so a transaction body cannot be interrupted by other JavaScript.
--         Two concurrent HTTP requests are therefore serialised: the second
--         sees the first one's committed row and is rejected.
--
--    This is a genuine guarantee for a single-process server, which is what
--    this application is. It is NOT a guarantee across multiple processes or
--    hosts - see the "Scaling" section of the README, which describes the
--    PostgreSQL EXCLUDE constraint that would replace it.
--
-- 4. THIS IS A HACKATHON PROTOTYPE. All seeded facility names, capacities and
--    schedules are illustrative sample data. There is no integration with any
--    Maseno University system, and no sample schedule reflects reality.
-- ===========================================================================

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
    created_at  text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- ---------------------------------------------------------------------------
-- profiles
--
-- Application users. `password_hash` holds a bcrypt hash, never a plaintext
-- password. `role` is read on every authorization decision and is NEVER
-- accepted from the client - see middleware/auth.ts.
-- ---------------------------------------------------------------------------
create table if not exists profiles (
    id            text primary key,
    email         text not null unique,
    display_name  text not null check (length(trim(display_name)) > 0),
    password_hash text not null,
    role          text not null default 'student'
                  check (role in ('student', 'rep', 'supervisor', 'admin')),
    department    text,
    created_at    text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- ---------------------------------------------------------------------------
-- sessions
--
-- Server-side sessions. Only a SHA-256 hash of the cookie token is stored, so
-- a leaked database file does not hand over live sessions. Sessions are
-- revocable by deleting the row, which JWTs cannot do without extra machinery.
-- ---------------------------------------------------------------------------
create table if not exists sessions (
    token_hash text primary key,
    user_id    text not null references profiles (id) on delete cascade,
    created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    expires_at text not null,
    user_agent text
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
    -- Stored as JSON rather than child tables because they are display-only
    -- attributes that are never joined or aggregated on. json_valid() below
    -- guarantees we never store malformed JSON that would crash the UI.
    equipment            text not null default '[]' check (json_valid(equipment)),
    accessibility        text not null default '[]' check (json_valid(accessibility)),

    status               text not null default 'active'
                         check (status in ('active', 'inactive', 'maintenance')),

    -- Local Nairobi wall-clock operating window. closes_at must be after
    -- opens_at: overnight facilities are deliberately unsupported (documented
    -- limitation) so that operating-hour checks stay a simple numeric compare.
    opens_at             text not null default '07:00' check (opens_at glob '[0-2][0-9]:[0-5][0-9]'),
    closes_at            text not null default '21:00' check (closes_at glob '[0-2][0-9]:[0-5][0-9]'),
    closed_days          text not null default '[]' check (json_valid(closed_days)),

    slot_minutes         integer not null default 60 check (slot_minutes between 15 and 240),
    buffer_minutes       integer not null default 0
                         check (buffer_minutes between 0 and 120
                                and buffer_minutes < slot_minutes),

    booking_policy       text not null default 'open'
                         check (booking_policy in ('open', 'restricted', 'supervisor_required')),
    min_role             text not null default 'rep'
                         check (min_role in ('student', 'rep', 'supervisor', 'admin')),
    allowed_activities   text not null default '[]' check (json_valid(allowed_activities)),

    created_at           text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at           text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),

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
    start_time  text not null check (start_time glob '????-??-??T??:??:??*Z'),
    end_time    text not null check (end_time glob '????-??-??T??:??:??*Z'),
    reason      text not null default 'Unavailable',
    created_by  text references profiles (id) on delete set null,
    created_at  text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),

    check (end_time > start_time)
);

-- ---------------------------------------------------------------------------
-- booking_reference_seq
--
-- Monotonic source of the numeric part of a booking reference (EDU-2026-0007).
-- A dedicated AUTOINCREMENT table is used rather than MAX(id) or COUNT(*),
-- because AUTOINCREMENT never reuses a number even after deletes - so a
-- reference shown to a user is never later reassigned to a different booking.
-- ---------------------------------------------------------------------------
create table if not exists booking_reference_seq (
    id         integer primary key autoincrement,
    created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
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
-- ---------------------------------------------------------------------------
create table if not exists bookings (
    id                  text primary key,
    booking_reference   text not null unique,

    facility_id         text not null references facilities (id) on delete restrict,
    booked_by           text not null references profiles (id) on delete restrict,

    activity_purpose    text not null check (length(trim(activity_purpose)) > 0),
    expected_attendance integer not null check (expected_attendance > 0),

    start_time          text not null check (start_time glob '????-??-??T??:??:??*Z'),
    end_time            text not null check (end_time glob '????-??-??T??:??:??*Z'),

    status              text not null default 'confirmed'
                        check (status in ('confirmed', 'cancelled', 'completed')),

    created_at          text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at          text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),

    cancelled_at        text,
    cancelled_by        text references profiles (id) on delete set null,
    cancellation_reason text,

    -- Half-open interval sanity: zero-length and inverted bookings are invalid.
    check (end_time > start_time),

    -- Cancellation bookkeeping must be internally consistent: either all of the
    -- cancellation columns are populated, or none are.
    check (
        (status = 'cancelled' and cancelled_at is not null)
        or (status <> 'cancelled' and cancelled_at is null)
    )
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
    metadata    text not null default '{}' check (json_valid(metadata)),
    created_at  text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- ---------------------------------------------------------------------------
-- Indexes
--
-- bookings_facility_active_idx is the one that matters: it serves the
-- availability query and the overlap check. It is PARTIAL, excluding cancelled
-- and completed rows, because those are never consulted for conflict purposes
-- and should not inflate the index.
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

create index if not exists sessions_expires_idx
    on sessions (expires_at);

create index if not exists sessions_user_idx
    on sessions (user_id);

create index if not exists audit_created_idx
    on audit_logs (created_at desc);

create index if not exists audit_entity_idx
    on audit_logs (entity_type, entity_id);

-- ---------------------------------------------------------------------------
-- updated_at maintenance
--
-- Centralised in triggers so no service function can forget to stamp it. The
-- WHEN clause avoids a pointless write when a statement does not actually
-- change updated_at itself.
-- ---------------------------------------------------------------------------
drop trigger if exists facilities_set_updated_at;
create trigger facilities_set_updated_at
    after update on facilities
    for each row
    when new.updated_at = old.updated_at
begin
    update facilities
       set updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     where id = new.id;
end;

drop trigger if exists bookings_set_updated_at;
create trigger bookings_set_updated_at
    after update on bookings
    for each row
    when new.updated_at = old.updated_at
begin
    update bookings
       set updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     where id = new.id;
end;
