/* Single place that knows the server's URL shape.
   401 means the 12h session cookie expired; 428 means Google Classroom
   needs reconnecting and must NOT be treated as a logout. */

let onUnauthorized = () => {};
export function setUnauthorizedHandler(fn) { onUnauthorized = fn; }

export class ApiError extends Error {
  constructor(message, status, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function request(url, { method = "GET", body, signal } = {}) {
  const init = { method, signal, headers: {} };
  if (body instanceof FormData) init.body = body;
  else if (body !== undefined) {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }

  const res = await fetch(url, init);
  if (res.status === 401) {
    onUnauthorized();
    throw new ApiError("ต้องเข้าสู่ระบบก่อน", 401);
  }
  if (res.status === 204) return null;

  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new ApiError(data?.error || "เกิดข้อผิดพลาด", res.status, data?.code);
  return data;
}

const qs = (params) => {
  const usable = Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== "");
  return usable.length ? "?" + new URLSearchParams(usable) : "";
};

export const api = {
  raw: request,

  me: () => request("/api/me"),
  deps: () => request("/api/health/deps"),
  login: (body) => request("/api/login", { method: "POST", body }),
  register: (body) => request("/api/register", { method: "POST", body }),
  logout: () => request("/api/logout", { method: "POST" }),
  googleCredential: (credential) =>
    request("/api/auth/google/credential", { method: "POST", body: { credential } }),
  updateProfile: (body) => request("/api/user/profile", { method: "PATCH", body }),
  uploadAvatar: (form) => request("/api/user/avatar", { method: "POST", body: form }),
  removeAvatar: () => request("/api/user/avatar", { method: "DELETE" }),

  tree: () => request("/api/tree"),

  createSubject: (name) => request("/api/subjects", { method: "POST", body: { name } }),
  updateSubject: (id, body) => request(`/api/subjects/${id}`, { method: "PATCH", body }),
  deleteSubject: (id) => request(`/api/subjects/${id}`, { method: "DELETE" }),
  uploadSubjectBackground: (id, form) =>
    request(`/api/subjects/${id}/background`, { method: "POST", body: form }),
  clearSubjectBackground: (id) => request(`/api/subjects/${id}/background`, { method: "DELETE" }),
  addStudentsToSubject: (id, studentIds) =>
    request(`/api/subjects/${id}/students`, { method: "POST", body: { studentIds } }),
  removeStudentFromSubject: (subjectId, studentId) =>
    request(`/api/subjects/${subjectId}/students/${studentId}`, { method: "DELETE" }),

  createLesson: (body) => request("/api/lessons", { method: "POST", body }),
  updateLesson: (id, title) => request(`/api/lessons/${id}`, { method: "PATCH", body: { title } }),
  deleteLesson: (id) => request(`/api/lessons/${id}`, { method: "DELETE" }),

  assignments: () => request("/api/assignments"),
  createAssignment: (body) => request("/api/assignments", { method: "POST", body }),
  updateAssignment: (id, body) => request(`/api/assignments/${id}`, { method: "PATCH", body }),
  deleteAssignment: (id) => request(`/api/assignments/${id}`, { method: "DELETE" }),
  assignmentSource: (id) => request(`/api/assignments/${id}/source`),
  refreshAssignmentSource: (id) => request(`/api/assignments/${id}/refresh`, { method: "POST" }),

  students: (params = {}) => request("/api/students" + qs(params)),
  createStudent: (body) => request("/api/students", { method: "POST", body }),
  updateStudent: (id, body) => request(`/api/students/${id}`, { method: "PATCH", body }),
  deleteStudent: (id) => request(`/api/students/${id}`, { method: "DELETE" }),
  studentDetails: (id) => request(`/api/students/${id}/details`),
  importStudents: (body) => request("/api/students/import-csv", { method: "POST", body }),

  submissions: (params = {}) => request("/api/submissions" + qs(params)),
  submission: (id) => request(`/api/submissions/${id}`),
  createSubmission: (assignmentId, form) =>
    request(`/api/assignments/${assignmentId}/submissions`, { method: "POST", body: form }),
  updateSubmission: (id, body) => request(`/api/submissions/${id}`, { method: "PATCH", body }),
  deleteSubmission: (id) => request(`/api/submissions/${id}`, { method: "DELETE" }),
  reanalyze: (id) => request(`/api/submissions/${id}/reanalyze`, { method: "POST" }),
  generateCoaching: (id) => request(`/api/submissions/${id}/coaching`, { method: "POST" }),
  share: (id) => request(`/api/submissions/${id}/share`, { method: "POST" }),
  unshare: (id) => request(`/api/submissions/${id}/share`, { method: "DELETE" }),

  drivePreview: (params) => request("/api/drive/preview-file" + qs(params)),
  driveFolderFiles: (url) => request("/api/drive/folder-files" + qs({ url })),

  classroomStatus: () => request("/api/classroom/status"),
  classroomCourses: () => request("/api/classroom/courses"),
  classroomImport: (body) => request("/api/classroom/import", { method: "POST", body }),
  classroomImportJob: (jobId) => request(`/api/classroom/import/${jobId}`),
  classroomDisconnect: () => request("/api/classroom/disconnect", { method: "POST" }),

  feedback: (token) => request(`/api/feedback/${token}`),
};
