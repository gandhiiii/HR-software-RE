/**
 * Task assignment and tracking routes.
 *
 * HR/admin create, assign, edit and delete tasks; an assignee sees the tasks
 * assigned to them and may change a task's status, but nothing else. A user who
 * is not the assignee cannot advance a task's status. Comments are open to every
 * role that can see the task.
 *
 * The `overdue` flag is derived on read from `due_date` (never stored): a task
 * with a past due date that is still in a non-terminal status is overdue.
 *
 * All persistence goes through lib/repo.js and every route declares an explicit
 * roles array, so neither SQL nor authorization is left implicit.
 */
import { requireFields, isIsoDate } from '../lib/validate.js';
import { getRow, listRows, insertRow, updateRow, deleteRow } from '../lib/repo.js';

const HR_ROLES = ['admin', 'hr'];
const ALL_ROLES = ['admin', 'hr', 'employee'];

const STATUSES = new Set(['open', 'in_progress', 'in_review', 'done', 'cancelled']);
const TERMINAL_STATUSES = new Set(['done', 'cancelled']);
const PRIORITIES = new Set(['low', 'medium', 'high', 'urgent']);

// Real columns of the `tasks` table. `assigned_by` is the creator/assigner
// column in the schema (the cross-task note calls it `created_by`, but the live
// schema is authoritative here — repo helpers reject unknown column names).
const TASK_FIELDS = ['title', 'description', 'assigned_to', 'due_date', 'priority', 'status'];

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

/**
 * Strict positive-integer id: only real numbers or numeric strings are allowed.
 * Number() alone would accept booleans (true -> 1), arrays ([1] -> 1) and other
 * type-confused input, which could silently land on an unrelated employee.
 */
function positiveId(value) {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/** The employee id an employee-role session is allowed to act as. */
function ownEmployeeId(user) {
  const id = positiveId(user?.employee_id);
  if (id === null) throw httpError(400, 'No employee is linked to this account');
  return id;
}

function pick(source, fields) {
  const result = {};
  for (const field of fields) {
    if (source && Object.prototype.hasOwnProperty.call(source, field)) {
      result[field] = source[field];
    }
  }
  return result;
}

/** Today as a local YYYY-MM-DD string, for lexical comparison with due_date. */
function todayIso() {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${month}-${day}`;
}

/** Attach the derived `overdue` boolean to a task (or a list of tasks). */
function withOverdue(task) {
  if (!task) return task;
  const overdue =
    task.due_date != null &&
    !TERMINAL_STATUSES.has(task.status) &&
    task.due_date < todayIso();
  return { ...task, overdue };
}

function validateTaskData(data, { partial = false } = {}) {
  if (!partial) requireFields(data, ['title', 'assigned_to']);
  if (data.title !== undefined && (typeof data.title !== 'string' || data.title.trim() === '')) {
    throw httpError(400, 'title must be a non-empty string');
  }
  if (data.due_date !== undefined && data.due_date !== null && !isIsoDate(data.due_date)) {
    throw httpError(400, 'due_date must be a valid ISO date (YYYY-MM-DD)');
  }
  if (data.priority !== undefined && !PRIORITIES.has(data.priority)) {
    throw httpError(400, `priority must be one of: ${[...PRIORITIES].join(', ')}`);
  }
  if (data.status !== undefined && !STATUSES.has(data.status)) {
    throw httpError(400, `status must be one of: ${[...STATUSES].join(', ')}`);
  }
}

/** Validate assigned_to as a strict id and confirm the employee exists. */
function resolveAssignee(db, value) {
  const id = positiveId(value);
  if (id === null) throw httpError(400, 'assigned_to must be a positive integer');
  if (!getRow(db, 'employees', id)) throw httpError(404, 'Assigned employee not found');
  return id;
}

/** Employees may only read tasks assigned to them; HR/admin may read any. */
function assertCanView(task, user) {
  if (!task) throw httpError(404, 'Task not found');
  if (user?.role === 'employee' && task.assigned_to !== user.employee_id) {
    throw httpError(404, 'Task not found');
  }
}

// ---------------------------------------------------------------------------
// Create / read
// ---------------------------------------------------------------------------

function createTask(db, user, body) {
  requireFields(body, ['title', 'assigned_to']);
  const data = pick(body, TASK_FIELDS);
  validateTaskData(data);
  const assignedTo = resolveAssignee(db, data.assigned_to);

  const id = insertRow(db, 'tasks', {
    title: data.title.trim(),
    description: data.description ?? null,
    assigned_to: assignedTo,
    assigned_by: user?.id ?? null,
    due_date: data.due_date ?? null,
    priority: data.priority ?? 'medium',
    ...(data.status !== undefined ? { status: data.status } : {}),
  });
  return { status: 201, body: withOverdue(getRow(db, 'tasks', id)) };
}

function listTasks(db, user, query) {
  const clauses = [];
  const params = [];

  // Employees always see only their own tasks. `?mine=1` requests the same
  // scoped view for HR/admin.
  if (user?.role === 'employee' || query.mine === '1') {
    clauses.push('assigned_to = ?');
    params.push(ownEmployeeId(user));
  } else if (query.assigned_to !== undefined && query.assigned_to !== '') {
    const id = positiveId(query.assigned_to);
    if (id === null) throw httpError(400, 'assigned_to must be a positive integer');
    clauses.push('assigned_to = ?');
    params.push(id);
  }
  if (query.status !== undefined && query.status !== '') {
    clauses.push('status = ?');
    params.push(query.status);
  }
  if (query.priority !== undefined && query.priority !== '') {
    clauses.push('priority = ?');
    params.push(query.priority);
  }

  const rows = listRows(db, 'tasks', clauses.length > 0 ? clauses.join(' AND ') : '1=1', params);
  return { status: 200, body: rows.map(withOverdue) };
}

// ---------------------------------------------------------------------------
// Update / delete
// ---------------------------------------------------------------------------

function updateTask(db, user, id, body) {
  const task = getRow(db, 'tasks', id);
  if (!task) throw httpError(404, 'Task not found');

  const data = pick(body, TASK_FIELDS);
  if (user?.role === 'employee') {
    // Only the assignee may change status, and status is the only field they
    // may change. assertCanView already confirmed the task is theirs to see.
    if (task.assigned_to !== user.employee_id) {
      throw httpError(403, 'Only the assignee may change task status');
    }
    const extraFields = Object.keys(data).filter((field) => field !== 'status');
    if (extraFields.length > 0) {
      throw httpError(403, 'Assignees may only change the status of a task');
    }
  }

  if (data.assigned_to !== undefined) {
    data.assigned_to = resolveAssignee(db, data.assigned_to);
  }
  validateTaskData(data, { partial: true });
  if (data.title !== undefined) data.title = data.title.trim();
  if (Object.keys(data).length > 0) updateRow(db, 'tasks', id, data);
  return { status: 200, body: withOverdue(getRow(db, 'tasks', id)) };
}

// ---------------------------------------------------------------------------
// Comments
// ---------------------------------------------------------------------------

function addComment(db, user, id, body) {
  const task = getRow(db, 'tasks', id);
  assertCanView(task, user);
  const comment = typeof body?.comment === 'string' ? body.comment.trim() : '';
  if (!comment) throw httpError(400, 'comment must be a non-empty string');

  const commentId = insertRow(db, 'task_comments', {
    task_id: id,
    user_id: user?.id ?? null,
    comment,
  });
  return { status: 201, body: getRow(db, 'task_comments', commentId) };
}

function listComments(db, user, id) {
  assertCanView(getRow(db, 'tasks', id), user);
  return { status: 200, body: listRows(db, 'task_comments', 'task_id = ?', [id]) };
}

/** Register all task routes. */
export function registerTaskRoutes(router) {
  router.register('POST', '/api/tasks', HR_ROLES, async ({ db, user, body }) =>
    createTask(db, user, body),
  );

  router.register('GET', '/api/tasks', ALL_ROLES, async ({ db, user, query }) =>
    listTasks(db, user, query),
  );

  router.register('GET', '/api/tasks/:id', ALL_ROLES, async ({ db, user, params }) => {
    const task = getRow(db, 'tasks', positiveId(params.id) ?? -1);
    assertCanView(task, user);
    return { status: 200, body: withOverdue(task) };
  });

  router.register('PATCH', '/api/tasks/:id', ALL_ROLES, async ({ db, user, params, body }) =>
    updateTask(db, user, positiveId(params.id) ?? -1, body),
  );

  router.register('DELETE', '/api/tasks/:id', HR_ROLES, async ({ db, params }) => {
    if (!deleteRow(db, 'tasks', positiveId(params.id) ?? -1)) {
      throw httpError(404, 'Task not found');
    }
    return { status: 200, body: { ok: true } };
  });

  router.register('POST', '/api/tasks/:id/comments', ALL_ROLES, async ({ db, user, params, body }) =>
    addComment(db, user, positiveId(params.id) ?? -1, body),
  );

  router.register('GET', '/api/tasks/:id/comments', ALL_ROLES, async ({ db, user, params }) =>
    listComments(db, user, positiveId(params.id) ?? -1),
  );
}
