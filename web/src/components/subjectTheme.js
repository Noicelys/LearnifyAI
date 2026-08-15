/* A subject keeps the same colour forever because it is derived from its id,
   unless the teacher picked one explicitly. */
export const SUBJECT_COLORS = [
  "#1f6f78", "#2f6b3f", "#8a3b2f", "#5a3d86",
  "#a35a12", "#1f5c8a", "#8a2f5c", "#48555c",
];

export const safeHex = (v) =>
  /^#[0-9a-f]{6}$/i.test(String(v ?? "").trim()) ? String(v).trim() : null;

export const subjectColor = (subject) =>
  safeHex(subject?.theme_color) || SUBJECT_COLORS[(subject?.id ?? 0) % SUBJECT_COLORS.length];

export const backgroundUrl = (subject) =>
  subject?.has_bg ? `/api/subjects/${subject.id}/background` : null;

export function bannerStyle(subject) {
  const color = subjectColor(subject);
  const image = backgroundUrl(subject);
  return image
    ? `background-color:${color};background-image:url('${image}')`
    : `background-color:${color}`;
}
