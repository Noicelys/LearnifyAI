import { api } from "./api.js";

/* One mutable app state with subscribe/notify, so views re-render from a
   single source instead of each keeping its own copy of the tree. */
export const state = {
  user: null,
  googleClientId: null,
  passwordConfigured: false,
  tree: [],
  roster: [],
  deps: null,
};

const listeners = new Set();

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function notify(reason) {
  for (const fn of listeners) fn(reason, state);
}

export async function loadTree() {
  state.tree = await api.tree();
  notify("tree");
  return state.tree;
}

export async function loadRoster() {
  state.roster = await api.students();
  notify("roster");
  return state.roster;
}

export async function loadDeps() {
  state.deps = await api.deps();
  notify("deps");
  return state.deps;
}

export const findSubject = (id) => state.tree.find((s) => String(s.id) === String(id)) || null;

export function findAssignment(id) {
  for (const subject of state.tree) {
    for (const lesson of subject.lessons) {
      const assignment = lesson.assignments.find((a) => String(a.id) === String(id));
      if (assignment) return { assignment, lesson, subject };
    }
  }
  return null;
}

export const subjectTally = (subject) => {
  const assignments = subject.lessons.flatMap((l) => l.assignments);
  return {
    lessons: subject.lessons.length,
    assignments: assignments.length,
    submissions: assignments.reduce((sum, a) => sum + (a.submission_count || 0), 0),
  };
};
