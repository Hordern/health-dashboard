// Seeds Daniel's lifting plan (26 Oct 2026) from the tables he shared, plus the
// current lifting block worked out from his JEFIT history. Writes through the
// logged store. After this, edit the plan through the connector or an agent.
//   npm run seed-lifting -- [--apply]

import { pool } from "../src/db.js";
import { setLiftingPlan } from "../src/plan/store.js";

// step_kg: the load jump once every set reaches the top of the rep range.
// jefit: the exercise name(s) JEFIT logs it under.
const ex = (name, jefit, load_kg, sets, reps, step_kg, extra = {}) => {
  const [sets_min, sets_max] = Array.isArray(sets) ? sets : [sets, sets];
  const [reps_min, reps_max] = reps;
  return { name, jefit: [jefit].flat(), load_kg, sets_min, sets_max, reps_min, reps_max, step_kg, ...extra };
};
const DERIVED = { derived: "From your latest completed session, not a stated prescription. Confirm or adjust." };

const plan = {
  version: 1,
  updated_from: "Daniel's lifting plan tables, 26 Oct 2026",
  block: {
    name: "Lower-body rebuild",
    start: "2026-09-28",
    detected_from_history:
      "Leg press A peaked at 225 kg × 9 (14–21 Sep), reset to 200 kg on Mon 28 Sep and has risen 2.5 kg a week since (210 kg on 26 Oct). " +
      "Legs B reset 175 → 160 kg and is rising 2.5 kg a week. The weeks of 28 Sep and 5 Oct were light (116 and 79 working sets vs ~150). " +
      "Upper body didn't reset: incline row A 85 kg since 8 Sep, chin-up +25 kg since 15 Sep, close-grip bench A 62.5 kg since late July, all progressing on reps. " +
      "Previous block: 18 May – 21 Sep, leg press A 170 → 225 kg.",
    method: "Double progression: A days heavy (8–12 reps), B days lighter (12–20 reps). Hold the load until every set reaches the top of the range, then add the step.",
    key_lifts: [
      { name: "Leg press A", jefit: "Machine Leg Press (Wide Stance)", min_kg: 190 },
      { name: "Barbell RDL", jefit: "Barbell Romanian Deadlift" },
      { name: "DB incline row", jefit: "Dumbbell Incline Bench Row", min_kg: 80 },
      { name: "Close-grip bench A", jefit: "Barbell Bench Press (Close Grip)", min_kg: 60 },
    ],
  },
  sessions: [
    {
      name: "Legs A", weekday: "Mon", variation: "Usually one complete session",
      parts: [{ name: "Main", exercises: [
        ex("Leg press, deep controlled ROM", "Machine Leg Press (Wide Stance)", 210, 4, [8, 9], 2.5),
        ex("Calf raise", "Machine Calf Raise", 165, 3, [12, 15], 5, { load_note: "about" }),
        ex("Barbell RDL", ["Barbell Romanian Deadlift"], 82.5, 3, [8, 10], 2.5),
        ex("Seated leg curl", "Machine Seated Leg Curl", 47.5, 3, [10, 12], 2.3, { load_note: "about" }),
        ex("Leg extension, knee permitting", "Machine Leg Extension", 45, [2, 3], [12, 18], 2.3, { load_note: "45–50 kg" }),
      ] }],
    },
    {
      name: "Back & Chest A", weekday: "Tue", variation: "P1 back/rear delts; P2 chest",
      parts: [
        { name: "P1 back / rear delts", exercises: [
          ex("DB incline bench-supported row", "Dumbbell Incline Bench Row", 85, 4, [8, 10], 5),
          ex("Weighted neutral-grip chin-up", "Chin-Up", 25, 4, [6, 8], 2.5, { load_note: "added weight" }),
          ex("Machine seated row", "Machine Seated Row", 111.4, 2, [8, 10], 2.3),
          ex("Rear-delt PC-deck row", "rear delt PC deck row", null, 3, [12, 15], null),
          ex("Face pull", "Cable Rope Face Pull", 13.6, 2, [12, 15], 2.3),
        ] },
        { name: "P2 chest", exercises: [
          ex("DB incline press", "Dumbbell Incline Bench Press", 60, 3, [12, 14], 5),
          ex("Machine bench press", "Machine Bench Press", 68, 3, [10, 12], 2.3),
          ex("Machine fly", "Machine Fly", 93, 3, [12, 15], 2.3),
        ] },
      ],
    },
    {
      name: "Arms & Shoulders A", weekday: "Wed", variation: "Usually combined",
      parts: [{ name: "Main", exercises: [
        ex("Close-grip bench", "Barbell Bench Press (Close Grip)", 62.5, 4, [8, 12], 2.5, DERIVED),
        ex("Preacher curl", "Barbell Preacher Curl", 35, 4, [8, 12], 2.5, DERIVED),
        ex("V-bar pushdown", "Cable Tricep Pushdown (V-Bar)", 36.3, 3, [10, 12], 2.3, DERIVED),
        ex("Cable lateral raise", "Cable Lateral Raise", 6.8, 3, [12, 15], 1.1, { ...DERIVED, load_note: "per side" }),
        ex("Overhead extension", "Cable Rope Overhead Tricep Extension", 18.1, 3, [12, 15], 2.3, DERIVED),
        ex("DB hammer curl", "Dumbbell Hammer Curl", 10, 4, [12, 15], 2, { ...DERIVED, load_note: "per hand" }),
        ex("Dips", "Dip", null, 2, [10, 15], null, { ...DERIVED, load_note: "bodyweight" }),
      ] }],
    },
    {
      name: "Legs B", weekday: "Thu", variation: "Usually one complete session",
      parts: [{ name: "Main", exercises: [
        ex("Leg press", "Machine Leg Press (Wide Stance)", 167.5, 4, [15, 16], 2.5),
        ex("Calf raise", "Machine Calf Raise", 120, 3, [17, 20], 5),
        ex("Seated leg curl", "Machine Seated Leg Curl", 42.1, 4, [12, 15], 2.3),
        ex("Leg extension", "Machine Leg Extension", 45, [3, 4], [15, 20], 2.3, { load_note: "45–47.3 kg" }),
      ] }],
    },
    {
      name: "Back & Chest B", weekday: "Fri", variation: "Can be divided into back and chest parts",
      parts: [{ name: "Main", exercises: [
        ex("Overhand bent-over row", "Barbell Bent-Over Row", 75, 3, [12, 15], 2.5),
        ex("DB incline press", "Dumbbell Incline Bench Press", 55, 3, [12, 15], 5),
        ex("Underhand pulldown", ["Machine Reverse Lat Pulldown (Close Grip)", "Cable Lat Pulldown (Wide Grip)"], 68.3, 3, [12, 15], 2.3),
        ex("Machine bench press", "Machine Bench Press", 59, 3, [12, 16], 2.3),
        ex("Machine seated row", "Machine Seated Row", 96, 3, [12, 15], 2.3, { load_note: "about" }),
        ex("Machine fly", "Machine Fly", 86, 3, [14, 17], 2.3),
      ] }],
    },
    {
      name: "Arms & Shoulders B", weekday: "Sat", variation: "P1 triceps; P2 biceps/shoulders (P2 sometimes Sunday)",
      parts: [
        { name: "P1 triceps", exercises: [
          ex("Close-grip bench", "Barbell Bench Press (Close Grip)", 52.5, 3, [14, 17], 2.5, DERIVED),
          ex("V-bar pushdown", "Cable Tricep Pushdown (V-Bar)", 29.5, 3, [17, 20], 2.3, DERIVED),
          ex("Overhead extension", "Cable Rope Overhead Tricep Extension", 15.9, 3, [17, 20], 2.3, DERIVED),
          ex("Dips", "Dip", null, 3, [11, 15], null, { ...DERIVED, load_note: "bodyweight" }),
        ] },
        { name: "P2 biceps / shoulders", exercises: [
          ex("Preacher curl", "Barbell Preacher Curl", 30, 3, [15, 20], 2.5, DERIVED),
          ex("Cable lateral raise", "Cable Lateral Raise", 4.5, 4, [20, 25], 1.1, { ...DERIVED, load_note: "per side" }),
          ex("Incline DB curl", "Dumbbell Incline Curl", 10, 3, [15, 18], 2, { ...DERIVED, load_note: "per hand" }),
          ex("Face pull", "Cable Rope Face Pull", 11.3, 2, [16, 24], 2.3, DERIVED),
          ex("Cable curl", "Cable Bicep Curl", 22.7, 3, [14, 15], 2.3, DERIVED),
        ] },
      ],
    },
  ],
  rest_day: { weekday: "Sun", note: "Rest from lifting and running; sometimes Arms B P2 moves here." },
};

const count = plan.sessions.reduce((n, s) => n + s.parts.reduce((m, p) => m + p.exercises.length, 0), 0);
console.log(`${plan.sessions.length} sessions, ${count} exercises; block "${plan.block.name}" from ${plan.block.start}`);
if (process.argv.includes("--apply")) {
  await setLiftingPlan(plan, { author: "Daniel (shared plan)", reason: "Lifting plan from Daniel's tables; current block worked out from JEFIT history" });
  console.log("Saved.");
}
await pool.end();
