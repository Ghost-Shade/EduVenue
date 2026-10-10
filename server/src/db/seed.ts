/**
 * Demo seed data.
 *
 * ===========================================================================
 * THIS IS ILLUSTRATIVE SAMPLE DATA - READ THIS BEFORE USING IT ANYWHERE
 * ===========================================================================
 *
 * Every facility name, capacity, building and schedule below is INVENTED for
 * demonstration. None of it reflects Maseno University's real estate, and none
 * of it should be quoted, screenshotted as fact, or presented to anyone as
 * real university information. There is no integration with any university
 * system.
 *
 * Seed entity ids are deliberately readable strings ('fac-lecture-hall-a')
 * rather than UUIDs, so that any record in the database can be traced back to
 * this file at a glance. Records created through the application use real
 * UUIDs, which makes the two kinds of data trivially distinguishable - which is
 * what the requirement to "maintain sample and real records separately" asks
 * for.
 *
 * Bookings are seeded RELATIVE TO TODAY, not to fixed dates. Hardcoded
 * calendar dates would make every booking appear in the past a week after
 * writing this file, and the demo would show an empty schedule.
 *
 * Run with:  npm run db:seed
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { getConfig } from '../config.ts'
import {
  closePool,
  query,
  redactDatabaseUrl,
  waitForDatabase,
  withTransaction,
  type Queryable,
} from './connection.ts'
import { bufferWindow } from '../lib/overlap.ts'
import { combineLocalDateTimeToUtc, toLocalDateString, type LocalDateString } from '../lib/time.ts'

// ---------------------------------------------------------------------------
// Demo identities, and NO credential of any kind
//
// There used to be a shared password here, hashed with bcrypt at ten rounds.
// There is not any more, and the removal is the point rather than a tidy-up: see
// services/identityService.ts. The accounts below are names to act as, not
// accounts to sign into.
//
// That makes the demo accounts strictly WEAKER to rely on than before, and it
// should be read that way. Anyone who can reach the application can act as the
// administrator. That is acceptable only because every record in this database
// is invented sample data.
// ---------------------------------------------------------------------------

/** RFC 2606 reserves `.test`, so these addresses can never reach a real inbox. */
const DEMO_EMAIL_DOMAIN = 'eduvenue.test'

interface SeedCategory {
  id: string
  name: string
  description: string
  sortOrder: number
}

interface SeedFacility {
  id: string
  name: string
  categoryId: string
  building: string
  locationDescription: string
  capacity: number
  description: string
  equipment: string[]
  accessibility: string[]
  status: 'active' | 'inactive' | 'maintenance'
  opensAt: string
  closesAt: string
  closedDays: number[]
  slotMinutes: number
  bufferMinutes: number
  bookingPolicy: 'open' | 'restricted' | 'supervisor_required'
  minRole: 'student' | 'rep' | 'supervisor' | 'admin'
  allowedActivities: string[]
}

interface SeedUser {
  id: string
  email: string
  displayName: string
  role: 'student' | 'rep' | 'supervisor' | 'admin'
  department: string
}

// ---------------------------------------------------------------------------
// Categories - one per facility class in the brief. Administrators can add more
// through the UI; nothing here is hardcoded into application logic.
// ---------------------------------------------------------------------------
export const seedCategories: SeedCategory[] = [
  {
    id: 'cat-lecture',
    name: 'Lecture Venues',
    description: 'Lecture halls, classrooms and tutorial rooms for scheduled teaching.',
    sortOrder: 1,
  },
  {
    id: 'cat-computing',
    name: 'Computing Facilities',
    description: 'Computer, networking and programming laboratories.',
    sortOrder: 2,
  },
  {
    id: 'cat-science',
    name: 'Science Facilities',
    description: 'Physics, chemistry and biology teaching laboratories.',
    sortOrder: 3,
  },
  {
    id: 'cat-medical',
    name: 'Medical & Health Training Facilities',
    description:
      'Practical training spaces requiring supervision and additional authorization.',
    sortOrder: 4,
  },
  {
    id: 'cat-collaborative',
    name: 'Collaborative Learning Facilities',
    description: 'Seminar rooms, group study rooms and project spaces.',
    sortOrder: 5,
  },
  {
    id: 'cat-other',
    name: 'Other Educational Facilities',
    description: 'Additional bookable spaces administered by the university.',
    sortOrder: 6,
  },
]

// ---------------------------------------------------------------------------
// Facilities
//
// Note how booking behaviour varies by facility rather than being uniform:
//   - Ordinary lecture venues are 'open' and bookable by any representative.
//   - Computing and science laboratories are 'restricted' and additionally
//     require the requester to hold at least the 'rep' role.
//   - Medical training facilities are 'supervisor_required', modelling the
//     brief's requirement that specialized practical spaces need extra
//     authorization. These will reject ordinary representatives.
//   - Computing Lab A carries a 15-minute buffer, so back-to-back bookings are
//     not permitted there - it models a lab that must be reset between sessions.
//     This is what lets the demo show a facility where the buffer rule bites.
// ---------------------------------------------------------------------------
export const seedFacilities: SeedFacility[] = [
  // --- Lecture venues -----------------------------------------------------
  {
    id: 'fac-lecture-hall-a',
    name: 'Lecture Hall A',
    categoryId: 'cat-lecture',
    building: 'Main Building',
    locationDescription: 'Ground floor, west wing, opposite the main notice board',
    capacity: 150,
    description:
      'The largest general teaching venue, used for large-class lectures and plenary sessions.',
    equipment: ['Projector', 'Public address system', 'Whiteboard', 'Fixed seating'],
    accessibility: ['Ground floor', 'Step-free access', 'Wheelchair spaces at the front'],
    status: 'active',
    opensAt: '07:00',
    closesAt: '21:00',
    closedDays: [0],
    slotMinutes: 60,
    bufferMinutes: 0,
    bookingPolicy: 'open',
    minRole: 'rep',
    allowedActivities: [
      'Revision session',
      'Makeup class',
      'Group discussion',
      'CAT',
      'Guest lecture',
    ],
  },
  {
    id: 'fac-lecture-hall-b',
    name: 'Lecture Hall B',
    categoryId: 'cat-lecture',
    building: 'Main Building',
    locationDescription: 'First floor, east wing, beside the staircase',
    capacity: 120,
    description: 'General teaching venue for medium-to-large classes.',
    equipment: ['Projector', 'Whiteboard', 'Fixed seating'],
    accessibility: ['Lift access', 'Assistive listening system'],
    status: 'active',
    opensAt: '07:00',
    closesAt: '21:00',
    closedDays: [0],
    slotMinutes: 60,
    bufferMinutes: 0,
    bookingPolicy: 'open',
    minRole: 'rep',
    allowedActivities: ['Revision session', 'Makeup class', 'Group discussion', 'CAT'],
  },
  {
    id: 'fac-classroom-c1',
    name: 'Classroom C1',
    categoryId: 'cat-lecture',
    building: 'Arts Block',
    locationDescription: 'Ground floor, room 12, end of the corridor',
    capacity: 60,
    description: 'Standard classroom suited to a single class group.',
    equipment: ['Projector', 'Whiteboard'],
    accessibility: ['Ground floor', 'Step-free access'],
    status: 'active',
    opensAt: '07:00',
    closesAt: '20:00',
    closedDays: [0],
    slotMinutes: 60,
    bufferMinutes: 0,
    bookingPolicy: 'open',
    minRole: 'rep',
    allowedActivities: ['Revision session', 'Makeup class', 'Group discussion', 'CAT'],
  },
  {
    id: 'fac-tutorial-room-t1',
    name: 'Tutorial Room T1',
    categoryId: 'cat-lecture',
    building: 'Arts Block',
    locationDescription: 'First floor, room 21',
    capacity: 30,
    description: 'Small room arranged for tutorial-style discussion rather than lecturing.',
    equipment: ['Whiteboard', 'Movable tables'],
    accessibility: ['Lift access'],
    status: 'active',
    opensAt: '08:00',
    closesAt: '20:00',
    closedDays: [0],
    slotMinutes: 60,
    bufferMinutes: 0,
    bookingPolicy: 'open',
    minRole: 'rep',
    allowedActivities: ['Revision session', 'Group discussion', 'Tutorial'],
  },

  // --- Computing facilities ----------------------------------------------
  {
    id: 'fac-computing-lab-a',
    name: 'Computing Lab A',
    categoryId: 'cat-computing',
    building: 'ICT Centre',
    locationDescription: 'Ground floor, left of the main ICT reception',
    capacity: 40,
    description:
      'General-purpose computer laboratory with one workstation per seat.',
    equipment: ['40 workstations', 'Projector', 'Stable power backup', 'Local network storage'],
    accessibility: ['Ground floor', 'Step-free access', 'Height-adjustable workstation available'],
    status: 'active',
    opensAt: '08:00',
    closesAt: '20:00',
    closedDays: [0],
    slotMinutes: 60,
    // A 15-minute reset is required between sessions, so a booking ending at
    // 16:00 blocks the next one from starting until 16:15.
    bufferMinutes: 15,
    bookingPolicy: 'restricted',
    minRole: 'rep',
    allowedActivities: ['Practical session', 'Revision session', 'Programming session', 'CAT'],
  },
  {
    id: 'fac-networking-lab-a',
    name: 'Networking Lab A',
    categoryId: 'cat-computing',
    building: 'ICT Centre',
    locationDescription: 'First floor, room ICT-104',
    capacity: 30,
    description: 'Laboratory with switch, router and cabling equipment for networking practicals.',
    equipment: ['Network racks', 'Managed switches', 'Routers', 'Cabling kits', '30 workstations'],
    accessibility: ['Lift access'],
    status: 'active',
    opensAt: '08:00',
    closesAt: '18:00',
    closedDays: [0, 6],
    slotMinutes: 60,
    bufferMinutes: 0,
    bookingPolicy: 'restricted',
    minRole: 'rep',
    allowedActivities: ['Practical session', 'Revision session', 'CAT'],
  },
  {
    id: 'fac-programming-lab-a',
    name: 'Programming Lab A',
    categoryId: 'cat-computing',
    building: 'ICT Centre',
    locationDescription: 'Second floor, room ICT-201',
    capacity: 35,
    description: 'Workstation laboratory configured for software development practicals.',
    equipment: ['35 workstations', 'Dual displays', 'Projector'],
    accessibility: ['Lift access'],
    status: 'active',
    opensAt: '08:00',
    closesAt: '20:00',
    closedDays: [0],
    slotMinutes: 60,
    bufferMinutes: 0,
    bookingPolicy: 'restricted',
    minRole: 'rep',
    allowedActivities: ['Programming session', 'Practical session', 'Revision session'],
  },

  // --- Science facilities -------------------------------------------------
  {
    id: 'fac-physics-lab-a',
    name: 'Physics Lab A',
    categoryId: 'cat-science',
    building: 'Science Block',
    locationDescription: 'Ground floor, laboratory wing, room S-01',
    capacity: 24,
    description: 'Teaching laboratory for mechanics and electronics practicals.',
    equipment: ['Benches with power outlets', 'Oscilloscopes', 'Measurement instruments'],
    accessibility: ['Ground floor', 'Step-free access'],
    status: 'active',
    opensAt: '08:00',
    closesAt: '18:00',
    closedDays: [0],
    slotMinutes: 60,
    bufferMinutes: 0,
    bookingPolicy: 'restricted',
    minRole: 'rep',
    allowedActivities: ['Practical session', 'Revision session'],
  },
  {
    id: 'fac-chemistry-lab-a',
    name: 'Chemistry Lab A',
    categoryId: 'cat-science',
    building: 'Science Block',
    locationDescription: 'First floor, laboratory wing, room S-11',
    capacity: 24,
    description:
      'Wet laboratory with fume extraction. Requires an authorized supervisor present.',
    equipment: ['Fume hoods', 'Bunsen burners', 'Chemical storage', 'Emergency shower'],
    accessibility: ['Lift access', 'Emergency exit at both ends'],
    status: 'active',
    opensAt: '08:00',
    closesAt: '17:00',
    closedDays: [0, 6],
    slotMinutes: 60,
    bufferMinutes: 0,
    bookingPolicy: 'supervisor_required',
    minRole: 'supervisor',
    allowedActivities: ['Practical session'],
  },
  {
    id: 'fac-biology-lab-a',
    name: 'Biology Lab A',
    categoryId: 'cat-science',
    building: 'Science Block',
    locationDescription: 'First floor, laboratory wing, room S-14',
    capacity: 30,
    description: 'Teaching laboratory with microscopes and specimen preparation areas.',
    equipment: ['Microscopes', 'Specimen preparation benches', 'Incubators'],
    accessibility: ['Lift access'],
    status: 'active',
    opensAt: '08:00',
    closesAt: '18:00',
    closedDays: [0],
    slotMinutes: 60,
    bufferMinutes: 0,
    bookingPolicy: 'restricted',
    minRole: 'rep',
    allowedActivities: ['Practical session', 'Revision session'],
  },

  // --- Medical & health training -----------------------------------------
  {
    id: 'fac-medical-training-lab-a',
    name: 'Medical Training Lab A',
    categoryId: 'cat-medical',
    building: 'Health Sciences Block',
    locationDescription: 'Ground floor, controlled-access corridor, room H-02',
    capacity: 20,
    description:
      'Simulated clinical training space with mannequins and examination stations. Additional authorization and an authorized supervisor are required.',
    equipment: ['Training mannequins', 'Examination couches', 'Procedure trolleys', 'Hand-washing stations'],
    accessibility: ['Ground floor', 'Step-free access', 'Wide doorways'],
    status: 'active',
    opensAt: '08:00',
    closesAt: '17:00',
    closedDays: [0, 6],
    slotMinutes: 60,
    bufferMinutes: 0,
    bookingPolicy: 'supervisor_required',
    minRole: 'supervisor',
    allowedActivities: ['Practical session', 'Clinical skills session'],
  },
  {
    id: 'fac-clinical-skills-lab-a',
    name: 'Clinical Skills Lab A',
    categoryId: 'cat-medical',
    building: 'Health Sciences Block',
    locationDescription: 'First floor, room H-11',
    capacity: 16,
    description:
      'Skills station laboratory for supervised clinical practice. Restricted to authorized supervisors.',
    equipment: ['Skills stations', 'Task trainers', 'Procedure carts'],
    accessibility: ['Lift access'],
    status: 'active',
    opensAt: '08:00',
    closesAt: '17:00',
    closedDays: [0, 6],
    slotMinutes: 60,
    bufferMinutes: 0,
    bookingPolicy: 'supervisor_required',
    minRole: 'supervisor',
    allowedActivities: ['Clinical skills session', 'Practical session'],
  },

  // --- Collaborative learning --------------------------------------------
  {
    id: 'fac-seminar-room-a',
    name: 'Seminar Room A',
    categoryId: 'cat-collaborative',
    building: 'Library Complex',
    locationDescription: 'First floor, left of the periodicals section',
    capacity: 35,
    description: 'Seminar room with movable furniture for discussion-led sessions.',
    equipment: ['Projector', 'Movable tables and chairs', 'Whiteboard'],
    accessibility: ['Lift access', 'Assistive listening system'],
    status: 'active',
    opensAt: '08:00',
    closesAt: '21:00',
    closedDays: [0],
    slotMinutes: 60,
    bufferMinutes: 0,
    bookingPolicy: 'open',
    minRole: 'rep',
    allowedActivities: ['Group discussion', 'Revision session', 'Presentation practice', 'Tutorial'],
  },
  {
    id: 'fac-study-room-a',
    name: 'Study Room A',
    categoryId: 'cat-collaborative',
    building: 'Library Complex',
    locationDescription: 'Second floor, quiet zone, room L-08',
    capacity: 12,
    description: 'Small enclosed room for group study and project meetings.',
    equipment: ['Wall-mounted screen', 'Whiteboard'],
    accessibility: ['Lift access'],
    status: 'active',
    opensAt: '08:00',
    closesAt: '21:00',
    closedDays: [0],
    slotMinutes: 30,
    bufferMinutes: 0,
    bookingPolicy: 'open',
    minRole: 'rep',
    allowedActivities: ['Group discussion', 'Project work', 'Revision session'],
  },
  {
    id: 'fac-study-room-b',
    name: 'Study Room B',
    categoryId: 'cat-collaborative',
    building: 'Library Complex',
    locationDescription: 'Second floor, quiet zone, room L-09',
    capacity: 8,
    description: 'Very small room suited to a single discussion group.',
    equipment: ['Whiteboard'],
    accessibility: ['Lift access'],
    status: 'active',
    opensAt: '08:00',
    closesAt: '21:00',
    closedDays: [0],
    slotMinutes: 30,
    bufferMinutes: 0,
    bookingPolicy: 'open',
    minRole: 'rep',
    allowedActivities: ['Group discussion', 'Project work'],
  },
  {
    id: 'fac-project-room-a',
    name: 'Project Room A',
    categoryId: 'cat-collaborative',
    building: 'ICT Centre',
    locationDescription: 'Ground floor, room ICT-012',
    capacity: 15,
    description: 'Project space with a shared workstation setup for build sessions.',
    equipment: ['Shared workstations', 'Projector', 'Whiteboard', 'Storage cupboard'],
    accessibility: ['Ground floor', 'Step-free access'],
    status: 'active',
    opensAt: '08:00',
    closesAt: '20:00',
    closedDays: [0],
    slotMinutes: 60,
    bufferMinutes: 0,
    bookingPolicy: 'restricted',
    minRole: 'rep',
    allowedActivities: ['Project work', 'Group discussion', 'Programming session'],
  },

  // --- Other --------------------------------------------------------------
  {
    id: 'fac-auditorium-annex',
    name: 'Auditorium Annex',
    categoryId: 'cat-other',
    building: 'Main Building',
    locationDescription: 'Rear of the main auditorium, accessed from the north corridor',
    capacity: 200,
    description:
      'Large annex used for events and plenary sessions. Booking is restricted to administrators because of the scale of the space.',
    equipment: ['Stage', 'Projector', 'Public address system', 'Stage lighting'],
    accessibility: ['Ground floor', 'Step-free access', 'Wheelchair accessible stage ramp'],
    status: 'active',
    opensAt: '08:00',
    closesAt: '22:00',
    closedDays: [],
    slotMinutes: 60,
    bufferMinutes: 0,
    bookingPolicy: 'restricted',
    minRole: 'admin',
    allowedActivities: ['Event', 'Guest lecture', 'Plenary session'],
  },

  // --- An inactive record, so the demo can show deactivation --------------
  {
    id: 'fac-classroom-c2',
    name: 'Classroom C2',
    categoryId: 'cat-lecture',
    building: 'Arts Block',
    locationDescription: 'Ground floor, room 14',
    capacity: 55,
    description:
      'Withdrawn from booking while refurbishment is planned. Retained so that existing bookings are not lost.',
    equipment: ['Projector', 'Whiteboard'],
    accessibility: ['Ground floor'],
    status: 'inactive',
    opensAt: '07:00',
    closesAt: '20:00',
    closedDays: [0],
    slotMinutes: 60,
    bufferMinutes: 0,
    bookingPolicy: 'open',
    minRole: 'rep',
    allowedActivities: ['Revision session', 'Group discussion'],
  },
]

// ---------------------------------------------------------------------------
// Demo users. Invented names; `.test` addresses cannot receive mail.
// ---------------------------------------------------------------------------
export const seedUsers: SeedUser[] = [
  {
    id: 'user-admin',
    email: `admin@${DEMO_EMAIL_DOMAIN}`,
    displayName: 'Amina Okoth',
    role: 'admin',
    department: 'Facilities Office',
  },
  {
    id: 'user-rep-brian',
    email: `rep.brian@${DEMO_EMAIL_DOMAIN}`,
    displayName: 'Brian Otieno',
    role: 'rep',
    department: 'BSc Computer Science, Year 3',
  },
  {
    id: 'user-rep-cynthia',
    email: `rep.cynthia@${DEMO_EMAIL_DOMAIN}`,
    displayName: 'Cynthia Wanjiru',
    role: 'rep',
    department: 'BSc Education, Year 2',
  },
  {
    id: 'user-supervisor',
    email: `supervisor@${DEMO_EMAIL_DOMAIN}`,
    displayName: 'Dr. Esther Mbeki',
    role: 'supervisor',
    department: 'Health Sciences',
  },
  {
    id: 'user-student',
    email: `student@${DEMO_EMAIL_DOMAIN}`,
    displayName: 'David Kimani',
    role: 'student',
    department: 'BSc Computer Science, Year 1',
  },
]

// ---------------------------------------------------------------------------
// Date helpers
//
// Everything is computed relative to today in Nairobi local terms, so the demo
// always shows upcoming bookings regardless of when it is run.
// ---------------------------------------------------------------------------

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

/** Local `YYYY-MM-DD` date, `days` from today. May be negative. */
function localDateOffset(days: number): LocalDateString {
  const today = toLocalDateString(new Date())
  const [year, month, day] = today.split('-').map(Number)

  // Date.UTC normalises month and year overflow, so +40 days from January
  // correctly lands in February of the same year.
  const shifted = new Date(Date.UTC(year ?? 1970, (month ?? 1) - 1, (day ?? 1) + days))

  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`
}

/** Combines a relative day offset and a local time into an instant. */
function instant(daysFromToday: number, localTime: string): Date {
  return combineLocalDateTimeToUtc(localDateOffset(daysFromToday), localTime)
}

interface SeedBooking {
  id: string
  reference: string
  facilityId: string
  bookedBy: string
  activityPurpose: string
  expectedAttendance: number
  startTime: Date
  endTime: Date
  status: 'confirmed' | 'cancelled' | 'completed'
  createdAt: Date
  cancelledAt?: Date
  cancelledBy?: string
  cancellationReason?: string
}

interface SeedBlock {
  id: string
  facilityId: string
  startTime: Date
  endTime: Date
  reason: string
  createdBy: string | null
}

function buildSeedBookings(): SeedBooking[] {
  return [
    // Tomorrow morning - the slot the demo booking flow targets.
    {
      id: 'bk-demo-001',
      reference: 'EDU-DEMO-0001',
      facilityId: 'fac-lecture-hall-a',
      bookedBy: 'user-rep-brian',
      activityPurpose: 'Revision session',
      expectedAttendance: 85,
      startTime: instant(1, '09:00'),
      endTime: instant(1, '11:00'),
      status: 'confirmed',
      createdAt: instant(-2, '14:20'),
    },
    // Tomorrow afternoon in a restricted computing lab.
    {
      id: 'bk-demo-002',
      reference: 'EDU-DEMO-0002',
      facilityId: 'fac-computing-lab-a',
      bookedBy: 'user-rep-brian',
      activityPurpose: 'Practical session',
      expectedAttendance: 32,
      startTime: instant(1, '14:00'),
      endTime: instant(1, '16:00'),
      status: 'confirmed',
      createdAt: instant(-2, '14:35'),
    },
    // A second representative, so the demo can show two people competing for
    // the same facility - and one being correctly rejected.
    {
      id: 'bk-demo-003',
      reference: 'EDU-DEMO-0003',
      facilityId: 'fac-seminar-room-a',
      bookedBy: 'user-rep-cynthia',
      activityPurpose: 'Group discussion',
      expectedAttendance: 28,
      startTime: instant(1, '11:00'),
      endTime: instant(1, '13:00'),
      status: 'confirmed',
      createdAt: instant(-1, '09:05'),
    },
    // Adjacent to booking 001: ends exactly when it starts. Proves half-open
    // intervals work, and gives the demo a legitimate back-to-back pair.
    {
      id: 'bk-demo-004',
      reference: 'EDU-DEMO-0004',
      facilityId: 'fac-lecture-hall-a',
      bookedBy: 'user-rep-cynthia',
      activityPurpose: 'Makeup class',
      expectedAttendance: 60,
      startTime: instant(1, '07:00'),
      endTime: instant(1, '09:00'),
      status: 'confirmed',
      createdAt: instant(-1, '16:40'),
    },
    // A cancelled booking, so "cancelled releases the slot" is demonstrable.
    {
      id: 'bk-demo-005',
      reference: 'EDU-DEMO-0005',
      facilityId: 'fac-study-room-a',
      bookedBy: 'user-rep-cynthia',
      activityPurpose: 'Project work',
      expectedAttendance: 10,
      startTime: instant(3, '15:00'),
      endTime: instant(3, '17:00'),
      status: 'cancelled',
      createdAt: instant(-3, '10:00'),
      cancelledAt: instant(-2, '08:15'),
      cancelledBy: 'user-rep-cynthia',
      cancellationReason: 'Group rescheduled to the following week.',
    },
    // A completed booking in the past, so history is not empty.
    {
      id: 'bk-demo-006',
      reference: 'EDU-DEMO-0006',
      facilityId: 'fac-lecture-hall-b',
      bookedBy: 'user-rep-brian',
      activityPurpose: 'CAT',
      expectedAttendance: 110,
      startTime: instant(-4, '10:00'),
      endTime: instant(-4, '12:00'),
      status: 'completed',
      createdAt: instant(-10, '11:30'),
    },
    // A restricted science lab, booked by a representative. Demonstrates that
    // 'restricted' facilities are bookable by eligible users.
    {
      id: 'bk-demo-007',
      reference: 'EDU-DEMO-0007',
      facilityId: 'fac-physics-lab-a',
      bookedBy: 'user-rep-brian',
      activityPurpose: 'Practical session',
      expectedAttendance: 22,
      startTime: instant(2, '08:00'),
      endTime: instant(2, '10:00'),
      status: 'confirmed',
      createdAt: instant(-1, '12:00'),
    },
    // A supervisor booking a facility that requires supervision. Ordinary
    // representatives cannot create this booking.
    {
      id: 'bk-demo-008',
      reference: 'EDU-DEMO-0008',
      facilityId: 'fac-medical-training-lab-a',
      bookedBy: 'user-supervisor',
      activityPurpose: 'Clinical skills session',
      expectedAttendance: 14,
      startTime: instant(2, '11:00'),
      endTime: instant(2, '13:00'),
      status: 'confirmed',
      createdAt: instant(-2, '09:00'),
    },
    // A back-to-back pair in the lab with a 15-minute buffer. The gap between
    // 10:00 and 10:15 is exactly the required buffer, so it is legal - the demo
    // can show that a 10:05 start would be rejected.
    {
      id: 'bk-demo-009',
      reference: 'EDU-DEMO-0009',
      facilityId: 'fac-computing-lab-a',
      bookedBy: 'user-rep-cynthia',
      activityPurpose: 'Programming session',
      expectedAttendance: 30,
      startTime: instant(3, '08:00'),
      endTime: instant(3, '10:00'),
      status: 'confirmed',
      createdAt: instant(-1, '13:00'),
    },
    {
      id: 'bk-demo-010',
      reference: 'EDU-DEMO-0010',
      facilityId: 'fac-computing-lab-a',
      bookedBy: 'user-rep-brian',
      activityPurpose: 'Revision session',
      expectedAttendance: 25,
      startTime: instant(3, '10:15'),
      endTime: instant(3, '12:00'),
      status: 'confirmed',
      createdAt: instant(-1, '13:10'),
    },
  ]
}

function buildSeedBlocks(): SeedBlock[] {
  return [
    // A full-day maintenance closure.
    {
      id: 'blk-demo-001',
      facilityId: 'fac-computing-lab-a',
      startTime: instant(4, '00:00'),
      endTime: instant(4, '23:59'),
      reason: 'Scheduled maintenance: workstation reimaging',
      createdBy: 'user-admin',
    },
    // A partial-day block, so availability filtering is demonstrable within a
    // single day rather than only whole days.
    {
      id: 'blk-demo-002',
      facilityId: 'fac-lecture-hall-a',
      startTime: instant(1, '13:00'),
      endTime: instant(1, '15:00'),
      reason: 'Reserved for examinations office briefing',
      createdBy: 'user-admin',
    },
    // A recurring safety inspection, represented as an explicit block. The
    // application does not model recurrence, so each occurrence is a row.
    {
      id: 'blk-demo-003',
      facilityId: 'fac-chemistry-lab-a',
      startTime: instant(2, '08:00'),
      endTime: instant(2, '17:00'),
      reason: 'Weekly safety inspection',
      createdBy: 'user-admin',
    },
  ]
}

/**
 * Removes all existing rows.
 *
 * Deletion order respects foreign keys: children before parents. Reversing this
 * order would fail, which is a small demonstration that the constraints in
 * schema.sql are genuinely active rather than decorative.
 *
 * Sent as one parameterless statement, so PostgreSQL's simple query protocol
 * runs the whole batch in a single round trip. (The SQLite build additionally
 * reset `sqlite_sequence` here; an identity column has no such separate counter
 * to reset, and `db:reset` drops the tables entirely, which restarts it.)
 */
async function clearAll(tx: Queryable): Promise<void> {
  await tx.execute(`
    delete from bookings;
    delete from facility_blocks;
    delete from audit_logs;
    delete from facilities;
    delete from facility_categories;
    delete from profiles;
    delete from booking_reference_seq;
  `)
}

/**
 * Writes the full demo dataset.
 *
 * Wrapped in a single transaction: either the whole dataset lands, or none of
 * it does. A half-seeded database would be far more confusing to debug than an
 * empty one.
 *
 * NOTE ON jsonb: JSON columns are written with an explicit `JSON.stringify` and
 * a `::jsonb` cast rather than by handing the driver a JavaScript value. `pg`
 * serialises a plain object as JSON but a JavaScript ARRAY as a PostgreSQL array
 * literal (`{a,b}`), which is not valid JSON input - so `closed_days: [0]` would
 * fail to insert, and only for the array-valued columns. Passing text and
 * casting makes the intent explicit and the failure impossible.
 */
export async function seedDatabase(): Promise<void> {
  // A booking snapshots the buffer its facility had at the time, and the
  // database enforces that the widened window matches. Seeding therefore has to
  // compute the same window the booking service would.
  const bufferByFacility = new Map(seedFacilities.map((facility) => [facility.id, facility.bufferMinutes]))

  await withTransaction(async (tx) => {
    await clearAll(tx)

    // --- categories -------------------------------------------------------
    for (const category of seedCategories) {
      await tx.execute(
        `insert into facility_categories (id, name, description, sort_order)
         values (@id, @name, @description, @sortOrder)`,
        { ...category },
      )
    }

    // --- profiles ---------------------------------------------------------
    for (const user of seedUsers) {
      await tx.execute(
        `insert into profiles (id, email, display_name, role, department)
         values (@id, @email, @displayName, @role, @department)`,
        { ...user },
      )
    }

    // --- facilities -------------------------------------------------------
    for (const facility of seedFacilities) {
      await tx.execute(
        `insert into facilities (
           id, name, category_id, building, location_description, capacity, description,
           equipment, accessibility, status, opens_at, closes_at, closed_days,
           slot_minutes, buffer_minutes, booking_policy, min_role, allowed_activities
         ) values (
           @id, @name, @categoryId, @building, @locationDescription, @capacity, @description,
           @equipment::jsonb, @accessibility::jsonb, @status, @opensAt, @closesAt,
           @closedDays::jsonb, @slotMinutes, @bufferMinutes, @bookingPolicy, @minRole,
           @allowedActivities::jsonb
         )`,
        {
          ...facility,
          equipment: JSON.stringify(facility.equipment),
          accessibility: JSON.stringify(facility.accessibility),
          closedDays: JSON.stringify(facility.closedDays),
          allowedActivities: JSON.stringify(facility.allowedActivities),
        },
      )
    }

    // --- blocks -----------------------------------------------------------
    for (const block of buildSeedBlocks()) {
      await tx.execute(
        `insert into facility_blocks (id, facility_id, start_time, end_time, reason, created_by)
         values (@id, @facilityId, @startTime, @endTime, @reason, @createdBy)`,
        { ...block },
      )
    }

    // --- bookings ---------------------------------------------------------
    for (const booking of buildSeedBookings()) {
      const bufferMinutes = bufferByFacility.get(booking.facilityId) ?? 0
      const window = bufferWindow({ start: booking.startTime, end: booking.endTime }, bufferMinutes)

      await tx.execute(
        `insert into bookings (
           id, booking_reference, facility_id, booked_by, activity_purpose,
           expected_attendance, start_time, end_time, buffer_minutes,
           effective_start, effective_end, status,
           created_at, cancelled_at, cancelled_by, cancellation_reason
         ) values (
           @id, @reference, @facilityId, @bookedBy, @activityPurpose,
           @expectedAttendance, @startTime, @endTime, @bufferMinutes,
           @effectiveStart, @effectiveEnd, @status,
           @createdAt, @cancelledAt, @cancelledBy, @cancellationReason
         )`,
        {
          ...booking,
          bufferMinutes,
          effectiveStart: window.start,
          effectiveEnd: window.end,
          cancelledAt: booking.cancelledAt ?? null,
          cancelledBy: booking.cancelledBy ?? null,
          cancellationReason: booking.cancellationReason ?? null,
        },
      )
    }

    // --- audit trail ------------------------------------------------------
    const auditEntries = [
      {
        id: 'aud-demo-001',
        actorId: 'user-admin',
        action: 'facility.deactivated',
        entityType: 'facility',
        entityId: 'fac-classroom-c2',
        metadata: JSON.stringify({
          name: 'Classroom C2',
          reason: 'Withdrawn from booking pending refurbishment',
          note: 'Sample audit entry created by the demo seed',
        }),
        createdAt: instant(-5, '15:30'),
      },
      {
        id: 'aud-demo-002',
        actorId: 'user-admin',
        action: 'facility.blocked',
        entityType: 'facility',
        entityId: 'fac-computing-lab-a',
        metadata: JSON.stringify({
          reason: 'Scheduled maintenance: workstation reimaging',
          note: 'Sample audit entry created by the demo seed',
        }),
        createdAt: instant(-1, '17:45'),
      },
    ]

    for (const entry of auditEntries) {
      await tx.execute(
        `insert into audit_logs (id, actor_id, action, entity_type, entity_id, metadata, created_at)
         values (@id, @actorId, @action, @entityType, @entityId, @metadata::jsonb, @createdAt)`,
        { ...entry },
      )
    }
  })
}

async function main(): Promise<void> {
  const config = getConfig()

  await waitForDatabase()

  console.log(`Seeding: ${redactDatabaseUrl(config.databaseUrl)}`)
  console.log(`         (${DEMO_EMAIL_DOMAIN} addresses are reserved and cannot receive mail)`)

  await seedDatabase()

  // `::int` rather than a bare count(*): PostgreSQL counts are bigint, and the
  // driver returns a bigint as a STRING to avoid losing precision, which would
  // print as "19" but compare as unequal to 19.
  //
  // The alias is `table_name`, not `table`: the shorter name is a reserved word,
  // and although PostgreSQL does accept it as a column label, spelling it out
  // costs nothing and removes a syntax question from a script whose failure mode
  // is "the demo data did not load".
  const counts = await query<{ table_name: string; n: number }>(`
    select 'facility_categories' as table_name, count(*)::int as n from facility_categories
    union all select 'facilities',  count(*)::int from facilities
    union all select 'profiles',    count(*)::int from profiles
    union all select 'bookings',    count(*)::int from bookings
    union all select 'blocks',      count(*)::int from facility_blocks
    union all select 'audit_logs',  count(*)::int from audit_logs
  `)

  console.log('')
  for (const row of counts) {
    console.log(`${row.table_name.padEnd(20)}${row.n}`)
  }
  console.log('')
  console.log('Sample data seeded successfully.')
  console.log(
    'REMINDER: all facility names, capacities and schedules are illustrative sample data.',
  )
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))

if (invokedDirectly) {
  try {
    await main()
  } catch (error) {
    console.error('\nSeeding failed.')
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  } finally {
    await closePool()
  }
}
