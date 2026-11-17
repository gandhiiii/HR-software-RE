/**
 * HRMS browser UI — a dependency-free, hash-routed single page application.
 *
 * All data comes from the JSON API under /api/* using the session cookie
 * (credentials: 'same-origin'). There are no inline handlers and no external
 * scripts: every listener is installed programmatically so a strict CSP is
 * satisfied. Routes map to #/dashboard, #/employees, ... so no server rewrites
 * are needed.
 */

const app = document.getElementById('app');
const toasts = document.getElementById('toasts');

const ALL_ROLES = ['admin', 'hr', 'employee'];
const HR_ROLES = ['admin', 'hr'];
const STATE = { user: null };
const uiPeriod = { month: new Date().getMonth() + 1, year: new Date().getFullYear() };

// ---------------------------------------------------------------------------
// Tiny DOM / formatting helpers
// ---------------------------------------------------------------------------

function appendChildren(node, children) {
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false || child === true) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

/** Create an element with attributes, properties and event listeners. */
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'html') node.innerHTML = value;
    else if (key === 'value') node.value = value;
    else if (key === 'checked') node.checked = !!value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (value === true) node.setAttribute(key, '');
    else node.setAttribute(key, String(value));
  }
  appendChildren(node, children);
  return node;
}

async function api(path, { method = 'GET', body } = {}) {
  const options = { method, credentials: 'same-origin' };
  if (body !== undefined) {
    options.headers = { 'Content-Type': 'application/json' };
    options.body = JSON.stringify(body);
  }
  const response = await fetch(path, options);
  const text = await response.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
  if (!response.ok) {
    const error = new Error(data?.error || `Request failed (${response.status})`);
    error.status = response.status;
    throw error;
  }
  return data;
}

function errorMessage(error) {
  return error?.message || 'Something went wrong. Please try again.';
}

function toast(message, kind = 'success') {
  const node = el('div', { class: `toast ${kind}`, text: String(message) });
  toasts.append(node);
  setTimeout(() => node.remove(), 4500);
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function money(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '—';
  return `₹${new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2 }).format(number)}`;
}

function cellText(value) {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  return String(value);
}

function titleCase(key) {
  return String(key).replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function badge(value) {
  const text = value == null || value === '' ? '—' : String(value);
  const tone = text.toLowerCase().replace(/\s+/g, '-');
  return el('span', { class: `badge ${tone}`, text });
}

/**
 * Build a POST/filter payload: blanks are omitted so optional inputs do not
 * send invalid empty values to create/filter endpoints.
 */
function cleanPayload(data) {
  const out = {};
  for (const [key, value] of Object.entries(data)) {
    if (value === '' || value === null || value === undefined) continue;
    out[key] = value;
  }
  return out;
}

/**
 * Build a PATCH payload. PATCH semantics differ: an omitted key means
 * "unchanged", so intentionally blank optional text MUST be sent as '' to let
 * the server clear it. `keepBlank` names text fields whose '' is preserved;
 * `blankToZero` names numeric fields whose blank input clears them to 0.
 * Everything else (null/undefined/blank) stays omitted.
 */
function patchPayload(data, { keepBlank = [], blankToZero = [] } = {}) {
  const keep = new Set(keepBlank);
  const zero = new Set(blankToZero);
  const out = {};
  for (const [key, value] of Object.entries(data)) {
    if (value === null || value === undefined) {
      if (zero.has(key)) out[key] = 0;
      continue;
    }
    if (value === '' && !keep.has(key)) continue;
    out[key] = value;
  }
  return out;
}

function dataTable(columns, rows, { empty = 'No records found.' } = {}) {
  const wrap = el('div', { class: 'table-wrap' });
  if (!Array.isArray(rows) || rows.length === 0) {
    wrap.append(el('p', { class: 'empty', text: empty }));
    return wrap;
  }
  const cols = columns.map((c) => (typeof c === 'string' ? { key: c, label: titleCase(c) } : c));
  const table = el('table', { class: 'data-table' });
  const header = el('tr');
  for (const c of cols) header.append(el('th', { text: c.label }));
  table.append(el('thead', {}, header));
  const body = el('tbody');
  for (const row of rows) {
    const tr = el('tr');
    for (const c of cols) {
      const td = el('td', c.className ? { class: c.className } : {});
      const value = c.render ? c.render(row) : row[c.key];
      if (value instanceof Node) td.append(value);
      else td.textContent = cellText(value);
      tr.append(td);
    }
    body.append(tr);
  }
  table.append(body);
  wrap.append(table);
  return wrap;
}

function panel(title, children = [], actions = null) {
  const head = el('div', { class: 'panel-head' }, el('h2', { text: title }));
  if (actions) head.append(actions);
  const body = el('div', { class: 'panel-body' });
  appendChildren(body, Array.isArray(children) ? children : [children]);
  return el('section', { class: 'panel' }, head, body);
}

function selectControl(options, value, onChange) {
  const select = el('select');
  for (const option of options) {
    const val = typeof option === 'object' ? option.value : option;
    const label = typeof option === 'object' ? option.label : option;
    select.append(el('option', { value: val, text: label }));
  }
  if (value !== null && value !== undefined) select.value = String(value);
  if (onChange) select.addEventListener('change', onChange);
  return select;
}

function openModal(title, content) {
  const overlay = el('div', { class: 'modal-overlay' });
  const close = () => overlay.remove();
  const box = el('div', { class: 'modal' },
    el('div', { class: 'modal-head' },
      el('h2', { text: title }),
      el('button', { class: 'icon-btn', text: '×', onClick: close })),
    el('div', { class: 'modal-body' }, content));
  overlay.append(box);
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) close();
  });
  const onKey = (event) => {
    if (event.key === 'Escape') {
      close();
      document.removeEventListener('keydown', onKey);
    }
  };
  document.addEventListener('keydown', onKey);
  document.body.append(overlay);
  return { close, box };
}

async function confirmAction(message, action) {
  if (!window.confirm(message)) return;
  try {
    await action();
    toast('Done');
    await render();
  } catch (error) {
    toast(errorMessage(error), 'error');
  }
}

// ---------------------------------------------------------------------------
// Form helper
// ---------------------------------------------------------------------------

function collectForm(form, fields) {
  const data = {};
  for (const field of fields) {
    const input = form.elements[field.name];
    if (!input) continue;
    let value;
    if (field.type === 'checkbox') value = input.checked;
    else if (field.type === 'number') value = input.value === '' ? null : Number(input.value);
    else value = input.value;
    data[field.name] = value;
  }
  return data;
}

/**
 * Build a form from field specs. `opts.silent` suppresses the success toast and
 * the automatic re-render (used for filters, login and in-modal forms that
 * manage their own refresh).
 */
function createForm(fields, submitLabel, onSubmit, opts = {}) {
  const form = el('form', { class: 'form-grid' });
  for (const field of fields) {
    const label = el('label', { class: 'field', text: field.label });
    let input;
    if (field.type === 'select') {
      input = selectControl(field.options ?? [], field.value);
      input.name = field.name;
      input.required = !!field.required;
    } else if (field.type === 'textarea') {
      input = el('textarea', {
        name: field.name,
        rows: field.rows ?? 3,
        placeholder: field.placeholder ?? '',
        required: !!field.required,
      });
      if (field.value !== undefined) input.value = field.value;
    } else if (field.type === 'checkbox') {
      input = el('input', { type: 'checkbox', name: field.name, checked: !!field.value });
    } else {
      const props = {
        type: field.type ?? 'text',
        name: field.name,
        required: !!field.required,
        placeholder: field.placeholder ?? '',
      };
      if (field.min !== undefined) props.min = field.min;
      if (field.step !== undefined) props.step = field.step;
      if (field.value !== undefined) props.value = field.value;
      input = el('input', props);
    }
    label.append(input);
    form.append(label);
  }
  form.append(el('div', { class: 'form-actions' },
    el('button', { type: 'submit', class: 'btn primary', text: submitLabel })));

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = form.querySelector('button[type="submit"]');
    button.disabled = true;
    try {
      await onSubmit(collectForm(form, fields));
      if (!opts.silent) {
        toast(opts.successMessage ?? `${submitLabel} completed`);
        form.reset();
        await render();
      }
    } catch (error) {
      toast(errorMessage(error), 'error');
    } finally {
      button.disabled = false;
    }
  });
  return form;
}

// ---------------------------------------------------------------------------
// Auth, navigation and routing
// ---------------------------------------------------------------------------

const NAV = [
  { key: 'dashboard', label: 'Dashboard', glyph: '▦', roles: ALL_ROLES },
  { key: 'employees', label: 'Employees', glyph: '◉', roles: HR_ROLES },
  { key: 'attendance', label: 'Attendance', glyph: '◷', roles: ALL_ROLES },
  { key: 'leave', label: 'Leave', glyph: '✈', roles: ALL_ROLES },
  { key: 'payroll', label: 'Payroll', glyph: '₹', roles: ALL_ROLES },
  { key: 'expenses', label: 'Expenses', glyph: '▤', roles: ALL_ROLES },
  { key: 'tasks', label: 'Tasks', glyph: '✓', roles: ALL_ROLES },
  { key: 'assets', label: 'Assets', glyph: '▣', roles: HR_ROLES },
  { key: 'reports', label: 'Reports', glyph: '◫', roles: ALL_ROLES },
  { key: 'settings', label: 'Settings', glyph: '⚙', roles: HR_ROLES },
];

const SCREENS = {
  dashboard: screenDashboard,
  employees: screenEmployees,
  attendance: screenAttendance,
  leave: screenLeave,
  payroll: screenPayroll,
  expenses: screenExpenses,
  tasks: screenTasks,
  assets: screenAssets,
  reports: screenReports,
  settings: screenSettings,
};

function isHr() {
  return HR_ROLES.includes(STATE.user?.role);
}

function allowed(roles) {
  return roles.includes(STATE.user?.role);
}

function loginScreen() {
  const form = createForm([
    { name: 'username', label: 'Username', required: true, placeholder: 'admin', value: 'admin' },
    { name: 'password', label: 'Password', type: 'password', required: true, value: 'admin123' },
  ], 'Sign in', async (data) => {
    STATE.user = await api('/api/auth/login', { method: 'POST', body: data });
    location.hash = '#/dashboard';
    render();
  }, { silent: true });

  return el('main', { class: 'login-page' },
    el('div', { class: 'login-card' },
      el('div', { class: 'login-brand' },
        el('span', { class: 'brand-mark', text: 'H' }), el('span', { text: 'HRMS' })),
      el('h1', { text: 'Welcome back' }),
      el('p', { class: 'muted', text: 'Sign in to your HR workspace.' }),
      form,
      el('div', { class: 'login-hint' },
        el('strong', { text: 'Demo accounts ' }),
        el('span', { text: '(password ' }), el('code', { text: 'admin123' }), el('span', { text: '): ' }),
        el('code', { text: 'admin' }), el('span', { text: ' · ' }),
        el('code', { text: 'hr' }), el('span', { text: ' · ' }),
        el('code', { text: 'employee' }))));
}

async function logout() {
  try {
    await api('/api/auth/logout', { method: 'POST' });
  } catch {
    // Even if the server call fails, clear local state so the UI is usable.
  }
  STATE.user = null;
  location.hash = '#/';
  render();
}

function layout(route) {
  const nav = el('nav', { class: 'nav' });
  for (const item of NAV) {
    if (!allowed(item.roles)) continue;
    nav.append(el('a', {
      href: `#/${item.key}`,
      class: route === item.key ? 'active' : '',
    },
    el('span', { class: 'glyph', text: item.glyph }),
    el('span', { text: item.label })));
  }

  const sidebar = el('aside', { class: 'sidebar' },
    el('div', { class: 'brand' },
      el('span', { class: 'brand-mark', text: 'H' }),
      el('div', {}, el('span', { text: 'HRMS' }),
        el('span', { class: 'brand-sub', text: 'People operations' }))),
    el('div', { class: 'nav-label', text: 'Workspace' }),
    nav,
    el('div', { class: 'user-box' },
      el('div', { class: 'user-name', text: STATE.user.username }),
      el('div', { class: 'user-role', text: STATE.user.role }),
      el('button', { class: 'logout-btn', text: 'Sign out', onClick: logout })));

  const title = NAV.find((item) => item.key === route)?.label ?? 'Dashboard';
  const topbar = el('header', { class: 'topbar' },
    el('div', {}, el('h1', { text: title }),
      el('p', { class: 'muted small', text: 'HR management system' })),
    el('div', { class: 'small muted', text: `${STATE.user.username} · ${STATE.user.role}` }));
  const view = el('div', { class: 'content', id: 'view' });
  return el('div', { class: 'layout' }, sidebar, el('main', { class: 'main' }, topbar, view));
}

let renderToken = 0;

async function render() {
  const token = ++renderToken;
  if (!STATE.user) {
    app.replaceChildren(loginScreen());
    return;
  }

  let route = location.hash.replace(/^#\/?/, '').split('?')[0] || 'dashboard';
  if (!SCREENS[route] || !allowed(NAV.find((item) => item.key === route).roles)) route = 'dashboard';
  if (location.hash !== `#/${route}`) {
    location.hash = `#/${route}`;
    return; // the hashchange event will render the canonical URL
  }

  app.replaceChildren(layout(route));
  const view = document.getElementById('view');
  view.replaceChildren(el('div', { class: 'loading', text: 'Loading…' }));
  try {
    const screen = await SCREENS[route]();
    if (token !== renderToken) return;
    view.replaceChildren(screen);
  } catch (error) {
    if (token !== renderToken) return;
    if (error.status === 401) {
      STATE.user = null;
      render();
      return;
    }
    view.replaceChildren(el('div', { class: 'error-box', text: errorMessage(error) }));
  }
}

function pageHead(title, subtitle) {
  return el('div', { class: 'page-head' }, el('h1', { text: title }),
    el('p', { class: 'muted', text: subtitle }));
}

function screen(title, subtitle, ...children) {
  return el('div', { class: 'screen' }, pageHead(title, subtitle), ...children);
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

async function screenDashboard() {
  const data = await api('/api/reports/dashboard');
  const cards = el('div', { class: 'card-grid' });
  const addCard = (label, value, note, tone) => cards.append(
    el('div', { class: `card ${tone ?? ''}` },
      el('div', { class: 'card-label', text: label }),
      el('div', { class: 'card-value', text: String(value) }),
      note ? el('div', { class: 'card-note', text: note }) : null));

  addCard('Active employees', data.headcount, 'on the payroll');
  addCard("Today's attendance", data.todayAttendance,
    `${data.attendance.present} present · ${data.attendance.half_day} half-day`, 'ok');
  addCard('Pending leaves', data.pendingLeaves, 'awaiting decision', 'warn');
  addCard('Pending expenses', data.pendingExpenses, 'awaiting decision', 'warn');
  addCard('Monthly payroll', money(data.monthlyPayrollCost), `net · ${data.month}/${data.year}`, 'info');
  addCard('Open tasks', data.openTasks, 'not done or cancelled');
  addCard('Asset utilization', `${data.assetUtilization}%`,
    `${data.assets.assigned} of ${data.assets.total} assigned`, 'info');

  const attendanceRows = [{
    date: data.attendance.date,
    present: data.attendance.present,
    half_day: data.attendance.half_day,
    leave: data.attendance.leave,
    holiday: data.attendance.holiday,
    absent: data.attendance.absent,
    worked_minutes: data.attendance.worked_minutes,
    overtime_minutes: data.attendance.overtime_minutes,
  }];
  const payrollRows = [{
    month: `${data.payroll.month}/${data.payroll.year}`,
    slips: data.payroll.slips,
    gross: money(data.payroll.gross),
    deductions: money(data.payroll.deductions),
    net: money(data.payroll.net),
  }];

  return screen('Dashboard', `Live overview for ${data.date}`, cards,
    panel("Attendance today", [dataTable(
      ['date', 'present', 'half_day', 'leave', 'holiday', 'absent', 'worked_minutes', 'overtime_minutes'],
      attendanceRows)]),
    panel('Payroll snapshot', [dataTable(['month', 'slips', 'gross', 'deductions', 'net'], payrollRows)]));
}

// ---------------------------------------------------------------------------
// Employees
// ---------------------------------------------------------------------------

async function screenEmployees() {
  const [employees, departments, designations, shifts] = await Promise.all([
    api('/api/employees'), api('/api/departments'), api('/api/designations'), api('/api/shifts'),
  ]);
  const deptNames = new Map(departments.map((d) => [d.id, d.name]));
  const desigNames = new Map(designations.map((d) => [d.id, d.name]));

  const employeeFields = (row = {}) => [
    { name: 'code', label: 'Code', required: true, value: row.code },
    { name: 'name', label: 'Full name', required: true, value: row.name },
    { name: 'joining_date', label: 'Joining date', type: 'date', required: true, value: row.joining_date ?? today() },
    { name: 'status', label: 'Status', type: 'select', options: ['active', 'inactive'], value: row.status ?? 'active' },
    { name: 'department_id', label: 'Department', type: 'select', options: departments.map((d) => ({ value: d.id, label: d.name })), value: row.department_id },
    { name: 'designation_id', label: 'Designation', type: 'select', options: designations.map((d) => ({ value: d.id, label: d.name })), value: row.designation_id },
    { name: 'shift_id', label: 'Shift', type: 'select', options: shifts.map((s) => ({ value: s.id, label: s.name })), value: row.shift_id },
    { name: 'basic', label: 'Basic', type: 'number', min: 0, step: 1, value: row.basic },
    { name: 'hra', label: 'HRA', type: 'number', min: 0, step: 1, value: row.hra },
    { name: 'allowances', label: 'Allowances', type: 'number', min: 0, step: 1, value: row.allowances },
    { name: 'email', label: 'Email', type: 'email', value: row.email },
    { name: 'phone', label: 'Phone', value: row.phone },
    { name: 'bank_account', label: 'Bank account', value: row.bank_account },
  ];

  const columns = [
    { key: 'code', label: 'Code' },
    { key: 'name', label: 'Employee', render: (r) => el('div', {},
      el('div', { text: r.name }), el('div', { class: 'small muted', text: r.email || '—' })) },
    { key: 'department_id', label: 'Department', render: (r) => deptNames.get(r.department_id) || '—' },
    { key: 'designation_id', label: 'Designation', render: (r) => desigNames.get(r.designation_id) || '—' },
    { key: 'joining_date', label: 'Joined' },
    { key: 'status', label: 'Status', render: (r) => badge(r.status) },
    { key: 'basic', label: 'Basic', className: 'num', render: (r) => money(r.basic) },
    { key: 'actions', label: 'Actions', render: (r) => el('div', { class: 'row-actions' },
      el('button', { class: 'btn small', text: 'Edit', onClick: () => {
        const modal = openModal(`Edit ${r.name}`, createForm(employeeFields(r), 'Save changes', async (data) => {
          await api(`/api/employees/${r.id}`, {
            method: 'PATCH',
            body: patchPayload(data, { keepBlank: ['email', 'phone', 'bank_account'] }),
          });
          modal.close();
        }, { successMessage: 'Employee updated' }));
      } }),
      el('button', { class: 'btn small danger', text: 'Delete', onClick: () => confirmAction(
        `Delete ${r.name}?`, () => api(`/api/employees/${r.id}`, { method: 'DELETE' })) })) },
  ];

  const tableHost = el('div');
  tableHost.replaceChildren(dataTable(columns, employees));

  const filters = createForm([
    { name: 'status', label: 'Status', type: 'select', options: [{ value: '', label: 'All statuses' }, 'active', 'inactive'] },
    { name: 'department', label: 'Department', type: 'select', options: [{ value: '', label: 'All departments' }, ...departments.map((d) => ({ value: d.id, label: d.name }))] },
  ], 'Apply filters', async (data) => {
    const query = new URLSearchParams(cleanPayload(data));
    const rows = await api(`/api/employees?${query}`);
    tableHost.replaceChildren(dataTable(columns, rows));
  }, { silent: true });

  return screen('Employees', 'Create, search and maintain employee records.',
    panel('Add employee', [createForm(employeeFields(), 'Add employee', async (data) =>
      api('/api/employees', { method: 'POST', body: cleanPayload(data) }))]),
    panel('Filters', [filters]),
    panel('Employee directory', [tableHost]));
}

// ---------------------------------------------------------------------------
// Attendance
// ---------------------------------------------------------------------------

async function screenAttendance() {
  if (!isHr()) {
    const selfForm = createForm([
      { name: 'date', label: 'Date', type: 'date', required: true, value: today() },
      { name: 'punchIn', label: 'Punch in', type: 'time' },
      { name: 'punchOut', label: 'Punch out', type: 'time' },
    ], 'Record attendance', async (data) =>
      api('/api/attendance/self', { method: 'POST', body: cleanPayload(data) }),
    { successMessage: 'Attendance recorded' });
    return screen('Attendance', 'Record your own attendance. History is available under Reports.',
      panel('My attendance', [selfForm]));
  }

  const employees = await api('/api/employees');
  const names = new Map(employees.map((e) => [e.id, e.name]));
  const employeeOptions = [{ value: '', label: 'All employees' }, ...employees.map((e) => ({ value: e.id, label: `${e.code} · ${e.name}` }))];

  const recordForm = createForm([
    { name: 'employeeId', label: 'Employee', type: 'select', required: true, options: employeeOptions.slice(1) },
    { name: 'date', label: 'Date', type: 'date', required: true, value: today() },
    { name: 'punchIn', label: 'Punch in', type: 'time' },
    { name: 'punchOut', label: 'Punch out', type: 'time' },
    { name: 'approvedLeave', label: 'Approved leave', type: 'checkbox' },
    { name: 'holiday', label: 'Holiday', type: 'checkbox' },
  ], 'Record attendance', async (data) =>
    api('/api/attendance', { method: 'POST', body: cleanPayload(data) }),
  { successMessage: 'Attendance recorded' });

  const columns = [
    { key: 'date' },
    { key: 'employee_id', label: 'Employee', render: (r) => names.get(r.employee_id) || `#${r.employee_id}` },
    { key: 'punch_in', label: 'Punch in' },
    { key: 'punch_out', label: 'Punch out' },
    { key: 'status', label: 'Status', render: (r) => badge(r.status) },
    { key: 'worked_minutes', label: 'Worked', render: (r) => `${Math.round((Number(r.worked_minutes) || 0) / 6) / 10} h` },
    { key: 'overtime_minutes', label: 'Overtime', render: (r) => `${r.overtime_minutes || 0} min` },
  ];

  const listHost = el('div');
  listHost.replaceChildren(dataTable(columns, await api('/api/attendance')));
  const listFilters = createForm([
    { name: 'employeeId', label: 'Employee', type: 'select', options: employeeOptions },
    { name: 'from', label: 'From', type: 'date' },
    { name: 'to', label: 'To', type: 'date' },
  ], 'Apply filters', async (data) => {
    const query = new URLSearchParams(cleanPayload(data));
    listHost.replaceChildren(dataTable(columns, await api(`/api/attendance?${query}`)));
  }, { silent: true });

  const summaryHost = el('div', {}, el('p', { class: 'muted small', text: 'Choose a month and load the summary.' }));
  const summaryForm = createForm([
    { name: 'month', label: 'Month', type: 'number', min: 1, required: true, value: uiPeriod.month },
    { name: 'year', label: 'Year', type: 'number', min: 1, required: true, value: uiPeriod.year },
  ], 'Load summary', async (data) => {
    const query = new URLSearchParams(cleanPayload(data));
    const summary = await api(`/api/attendance/summary?${query}`);
    const rows = summary.employees.map((row) => ({
      ...row, employee_name: names.get(row.employee_id) || `#${row.employee_id}`,
    }));
    summaryHost.replaceChildren(
      dataTable(['employee_name', 'present', 'half_day', 'leave', 'holiday', 'absent', 'present_days', 'worked_minutes', 'overtime_minutes'], rows),
      el('div', { class: 'small muted mt-1', text:
        `Totals — present ${summary.totals.present}, half-day ${summary.totals.half_day}, ` +
        `leave ${summary.totals.leave}, absent ${summary.totals.absent}, ` +
        `worked ${summary.totals.worked_minutes} min, overtime ${summary.totals.overtime_minutes} min.` }));
  }, { silent: true });

  return screen('Attendance', 'Record punches, browse entries and review monthly summaries.',
    panel('Record attendance', [recordForm]),
    panel('Attendance entries', [listFilters, listHost]),
    panel('Monthly summary', [summaryForm, summaryHost]));
}

// ---------------------------------------------------------------------------
// Leave
// ---------------------------------------------------------------------------

async function screenLeave() {
  const [types, balances, requests] = await Promise.all([
    api('/api/leave/types'), api('/api/leave/balances'), api('/api/leave/requests'),
  ]);
  const employees = isHr() ? await api('/api/employees') : [];
  const names = new Map(employees.map((e) => [e.id, e.name]));
  const leaveOptions = types.map((t) => ({ value: t.id, label: t.name }));

  const applyFields = [
    { name: 'leaveTypeId', label: 'Leave type', type: 'select', required: true, options: leaveOptions },
    { name: 'fromDate', label: 'From date', type: 'date', required: true, value: today() },
    { name: 'toDate', label: 'To date', type: 'date', required: true, value: today() },
    { name: 'days', label: 'Days', type: 'number', min: 0.5, step: 0.5, required: true },
    { name: 'reason', label: 'Reason', type: 'textarea' },
  ];
  if (isHr()) {
    applyFields.unshift({ name: 'employeeId', label: 'Employee', type: 'select', required: true,
      options: employees.map((e) => ({ value: e.id, label: `${e.code} · ${e.name}` })) });
  }

  const decide = (id, action, label, cls) => el('button', {
    class: `btn small ${cls}`, text: label, onClick: async () => {
      try {
        await api(`/api/leave/requests/${id}/decision`, { method: 'POST', body: { action } });
        toast(`Request ${action === 'approve' ? 'approved' : 'rejected'}`);
        render();
      } catch (error) {
        toast(errorMessage(error), 'error');
      }
    },
  });

  const requestColumns = [
    { key: 'id', label: 'ID' },
    ...(isHr() ? [{ key: 'employee_id', label: 'Employee', render: (r) => names.get(r.employee_id) || `#${r.employee_id}` }] : []),
    { key: 'leave_type_name', label: 'Type' },
    { key: 'from_date', label: 'From' },
    { key: 'to_date', label: 'To' },
    { key: 'days', label: 'Days' },
    { key: 'reason', label: 'Reason' },
    { key: 'status', label: 'Status', render: (r) => badge(r.status) },
    // The decision endpoint is HR_ROLES only; never offer it to employees.
    ...(isHr() ? [{ key: 'actions', label: 'Decision', render: (r) => el('div', { class: 'row-actions' },
      r.status === 'pending' ? decide(r.id, 'approve', 'Approve', 'ok') : null,
      (r.status === 'pending' || r.status === 'approved') ? decide(r.id, 'reject', 'Reject', 'danger') : null) }] : []),
  ];

  const requestHost = el('div');
  requestHost.replaceChildren(dataTable(requestColumns, requests));
  const requestFilters = createForm([
    { name: 'status', label: 'Status', type: 'select', options: [{ value: '', label: 'All statuses' }, 'pending', 'approved', 'rejected'] },
    ...(isHr() ? [{ name: 'employeeId', label: 'Employee', type: 'select', options: [{ value: '', label: 'All employees' }, ...employees.map((e) => ({ value: e.id, label: e.name }))] }] : []),
  ], 'Apply filters', async (data) => {
    const query = new URLSearchParams(cleanPayload(data));
    requestHost.replaceChildren(dataTable(requestColumns, await api(`/api/leave/requests?${query}`)));
  }, { silent: true });

  const balanceColumns = [
    ...(isHr() ? [{ key: 'employee_id', label: 'Employee', render: (r) => names.get(r.employee_id) || `#${r.employee_id}` }] : []),
    { key: 'leave_type_name', label: 'Leave type' },
    { key: 'opening_balance', label: 'Opening' },
    { key: 'used', label: 'Used' },
    { key: 'remaining', label: 'Remaining', render: (r) => el('strong', { text: cellText(r.remaining) }) },
  ];

  return screen('Leave', 'Apply for leave, review balances and decide requests.',
    panel('Apply for leave', [createForm(applyFields, 'Submit request', async (data) =>
      api('/api/leave/requests', { method: 'POST', body: cleanPayload(data) }),
    { successMessage: 'Leave request submitted' })]),
    panel('Leave balances', [dataTable(balanceColumns, balances)]),
    panel('Leave requests', [requestFilters, requestHost]));
}

// ---------------------------------------------------------------------------
// Payroll
// ---------------------------------------------------------------------------

async function screenPayroll() {
  const employees = isHr() ? await api('/api/employees') : [];
  const names = new Map(employees.map((e) => [e.id, e.name]));
  const query = new URLSearchParams({ month: uiPeriod.month, year: uiPeriod.year });

  const runForm = createForm([
    { name: 'month', label: 'Month', type: 'number', min: 1, required: true, value: uiPeriod.month },
    { name: 'year', label: 'Year', type: 'number', min: 1, required: true, value: uiPeriod.year },
  ], 'Run payroll', async (data) => {
    const result = await api('/api/payroll/run', { method: 'POST', body: cleanPayload(data) });
    toast(`Payroll run: ${result.created} created, ${result.updated} updated, ${result.skipped} skipped`);
  });

  const payslipModal = async (id) => {
    const slip = await api(`/api/payroll/slips/${id}`);
    const earnings = ['basic', 'hra', 'allowances', 'overtime_pay', 'reimbursement', 'gross'];
    const deductions = ['pf', 'esic', 'professional_tax', 'income_tax', 'unpaid_leave_deduction', 'deductions'];
    const rowsFor = (keys) => keys.map((key) => ({ label: titleCase(key), amount: money(slip[key]) }));
    openModal(`Payslip · ${slip.month}/${slip.year}`, el('div', {},
      el('p', { class: 'muted', text: `${names.get(slip.employee_id) || `Employee #${slip.employee_id}`} · status: ${slip.status}` }),
      el('h3', { text: 'Earnings' }),
      dataTable(['label', 'amount'], rowsFor(earnings)),
      el('h3', { class: 'mt-2', text: 'Deductions' }),
      dataTable(['label', 'amount'], rowsFor(deductions)),
      el('div', { class: 'card mt-2' },
        el('div', { class: 'card-label', text: 'Net pay' }),
        el('div', { class: 'card-value', text: money(slip.net) }))));
  };

  const editSlip = (slip) => {
    const fields = ['basic', 'hra', 'allowances', 'overtimePay', 'reimbursement', 'pf', 'esic',
      'professionalTax', 'incomeTax', 'unpaidLeaveDeduction'].map((key) => ({
      name: key, label: titleCase(key), type: 'number', min: 0, step: 1,
      value: slip[key] ?? slip[key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)] ?? 0,
    }));
    const modal = openModal('Edit draft payslip', createForm(fields, 'Save components', async (data) => {
      await api(`/api/payroll/slips/${slip.id}`, {
        method: 'PATCH',
        body: patchPayload(data, { blankToZero: fields.map((f) => f.name) }),
      });
      modal.close();
    }, { successMessage: 'Payslip updated' }));
  };

  const lifecycle = (slip, action, label, cls) => el('button', {
    class: `btn small ${cls}`, text: label, onClick: async () => {
      try {
        await api(`/api/payroll/slips/${slip.id}/${action}`, { method: 'POST' });
        toast(`Payslip ${action === 'pay' ? 'marked paid' : 'finalized'}`);
        render();
      } catch (error) {
        toast(errorMessage(error), 'error');
      }
    },
  });

  const slipColumns = [
    ...(isHr() ? [{ key: 'employee_id', label: 'Employee', render: (r) => names.get(r.employee_id) || `#${r.employee_id}` }] : []),
    { key: 'gross', label: 'Gross', className: 'num', render: (r) => money(r.gross) },
    { key: 'deductions', label: 'Deductions', className: 'num', render: (r) => money(r.deductions) },
    { key: 'net', label: 'Net', className: 'num', render: (r) => el('strong', { text: money(r.net) }) },
    { key: 'present_days', label: 'Present days' },
    { key: 'status', label: 'Status', render: (r) => badge(r.status) },
    { key: 'actions', label: 'Actions', render: (r) => el('div', { class: 'row-actions' },
      el('button', { class: 'btn small', text: 'View', onClick: () => payslipModal(r.id) }),
      isHr() && r.status === 'draft' ? el('button', { class: 'btn small', text: 'Edit', onClick: () => editSlip(r) }) : null,
      isHr() && r.status === 'draft' ? lifecycle(r, 'finalize', 'Finalize', 'ok') : null,
      isHr() && r.status === 'finalized' ? lifecycle(r, 'pay', 'Mark paid', 'ok') : null) },
  ];

  const csvLink = el('a', {
    class: 'btn small', text: 'Download register (CSV)',
    href: `/api/payroll/register.csv?month=${uiPeriod.month}&year=${uiPeriod.year}`,
    download: '',
  });
  const csvHost = el('div', {}, csvLink);

  let slips = await api(`/api/payroll/slips?${query}`);
  const slipHost = el('div');
  slipHost.replaceChildren(dataTable(slipColumns, slips, { empty: 'No payslips for this period. Run payroll to generate them.' }));
  const filterForm = createForm([
    { name: 'month', label: 'Month', type: 'number', min: 1, required: true, value: uiPeriod.month },
    { name: 'year', label: 'Year', type: 'number', min: 1, required: true, value: uiPeriod.year },
    ...(isHr() ? [{ name: 'employeeId', label: 'Employee', type: 'select', options: [{ value: '', label: 'All employees' }, ...employees.map((e) => ({ value: e.id, label: e.name }))] }] : []),
  ], 'Load slips', async (data) => {
    uiPeriod.month = Number(data.month);
    uiPeriod.year = Number(data.year);
    const params = new URLSearchParams(cleanPayload(data));
    slips = await api(`/api/payroll/slips?${params}`);
    slipHost.replaceChildren(dataTable(slipColumns, slips, { empty: 'No payslips for this period.' }));
    csvLink.href = `/api/payroll/register.csv?month=${uiPeriod.month}&year=${uiPeriod.year}`;
  }, { silent: true });

  return screen('Payroll', 'Run monthly payroll and manage payslips.',
    ...(isHr() ? [panel('Run payroll', [runForm])] : []),
    panel('Payslips', [filterForm, slipHost]),
    ...(isHr() ? [panel('Payroll register', [
      el('p', { class: 'muted small', text: 'Export the currently loaded month as a CSV register.' }),
      csvHost,
    ])] : []));
}

// ---------------------------------------------------------------------------
// Expenses
// ---------------------------------------------------------------------------

async function screenExpenses() {
  const employees = isHr() ? await api('/api/employees') : [];
  const names = new Map(employees.map((e) => [e.id, e.name]));

  const submitFields = [
    { name: 'category', label: 'Category', required: true, placeholder: 'Travel' },
    { name: 'amount', label: 'Amount', type: 'number', min: 0, step: 1, required: true },
    { name: 'receiptNote', label: 'Receipt note', type: 'textarea' },
  ];
  if (isHr()) {
    submitFields.push({ name: 'employeeId', label: 'Employee', type: 'select', required: true,
      options: employees.map((e) => ({ value: e.id, label: `${e.code} · ${e.name}` })) });
  }

  const decide = (id, action, label, cls) => el('button', {
    class: `btn small ${cls}`, text: label, onClick: async () => {
      try {
        await api(`/api/expenses/${id}/decision`, { method: 'POST', body: { action } });
        toast(`Claim ${action === 'approve' ? 'approved' : 'rejected'}`);
        render();
      } catch (error) {
        toast(errorMessage(error), 'error');
      }
    },
  });

  const flag = (expense) => el('button', { class: 'btn small', text: 'Flag for payroll', onClick: () => {
    const modal = openModal('Flag reimbursement', createForm([
      { name: 'month', label: 'Month', type: 'number', min: 1, required: true, value: uiPeriod.month },
      { name: 'year', label: 'Year', type: 'number', min: 1, required: true, value: uiPeriod.year },
    ], 'Flag', async (data) => {
      await api(`/api/expenses/${expense.id}/flag-reimbursement`, { method: 'POST', body: cleanPayload(data) });
      modal.close();
    }, { successMessage: 'Flagged for reimbursement' }));
  } });

  const columns = [
    { key: 'id', label: 'ID' },
    ...(isHr() ? [{ key: 'employee_id', label: 'Employee', render: (r) => names.get(r.employee_id) || `#${r.employee_id}` }] : []),
    { key: 'category', label: 'Category' },
    { key: 'amount', label: 'Amount', className: 'num', render: (r) => money(r.amount) },
    { key: 'status', label: 'Status', render: (r) => badge(r.status) },
    { key: 'reimbursement_month', label: 'Reimburse', render: (r) => r.reimbursement_month ? `${r.reimbursement_month}/${r.reimbursement_year}` : '—' },
    ...(isHr() ? [{ key: 'actions', label: 'Actions', render: (r) => el('div', { class: 'row-actions' },
      r.status === 'pending' ? decide(r.id, 'approve', 'Approve', 'ok') : null,
      r.status === 'pending' ? decide(r.id, 'reject', 'Reject', 'danger') : null,
      r.status === 'approved' ? flag(r) : null) }] : []),
  ];

  const host = el('div');
  host.replaceChildren(dataTable(columns, await api('/api/expenses')));
  const filters = createForm([
    { name: 'status', label: 'Status', type: 'select', options: [{ value: '', label: 'All statuses' }, 'pending', 'approved', 'rejected', 'reimbursed'] },
    ...(isHr() ? [{ name: 'employeeId', label: 'Employee', type: 'select', options: [{ value: '', label: 'All employees' }, ...employees.map((e) => ({ value: e.id, label: e.name }))] }] : []),
  ], 'Apply filters', async (data) => {
    const query = new URLSearchParams(cleanPayload(data));
    host.replaceChildren(dataTable(columns, await api(`/api/expenses?${query}`)));
  }, { silent: true });

  return screen('Expenses', 'Submit claims and review reimbursements.',
    panel('Submit a claim', [createForm(submitFields, 'Submit claim', async (data) =>
      api('/api/expenses', { method: 'POST', body: cleanPayload(data) }),
    { successMessage: 'Claim submitted' })]),
    panel('Expense claims', [filters, host]));
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

async function screenTasks() {
  const employees = isHr() ? await api('/api/employees') : [];
  const names = new Map(employees.map((e) => [e.id, e.name]));
  const statuses = ['open', 'in_progress', 'in_review', 'done', 'cancelled'];
  const priorities = ['low', 'medium', 'high', 'urgent'];

  const createFields = [
    { name: 'title', label: 'Title', required: true },
    { name: 'assigned_to', label: 'Assign to', type: 'select', required: true,
      options: employees.map((e) => ({ value: e.id, label: `${e.code} · ${e.name}` })) },
    { name: 'due_date', label: 'Due date', type: 'date' },
    { name: 'priority', label: 'Priority', type: 'select', options: priorities, value: 'medium' },
    { name: 'description', label: 'Description', type: 'textarea' },
  ];

  const statusCell = (task) => selectControl(statuses, task.status, async (event) => {
    try {
      await api(`/api/tasks/${task.id}`, { method: 'PATCH', body: { status: event.target.value } });
      toast('Status updated');
      render();
    } catch (error) {
      toast(errorMessage(error), 'error');
      event.target.value = task.status;
    }
  });

  const comments = (task) => el('button', { class: 'btn small', text: 'Comments', onClick: async () => {
    const listHost = el('div', {}, el('p', { class: 'muted small', text: 'Loading…' }));
    const modal = openModal(`Comments · ${task.title}`, el('div', {}, listHost,
      el('div', { class: 'mt-2' }, createForm([
        { name: 'comment', label: 'Add a comment', type: 'textarea', required: true },
      ], 'Post comment', async (data) => {
        await api(`/api/tasks/${task.id}/comments`, { method: 'POST', body: data });
        const rows = await api(`/api/tasks/${task.id}/comments`);
        listHost.replaceChildren(dataTable(['user_id', 'comment', 'created_at'], rows));
        modal.box.querySelector('textarea').value = '';
        toast('Comment posted');
      }, { silent: true }))));
    try {
      const rows = await api(`/api/tasks/${task.id}/comments`);
      listHost.replaceChildren(dataTable(['user_id', 'comment', 'created_at'], rows,
        { empty: 'No comments yet.' }));
    } catch (error) {
      listHost.replaceChildren(el('div', { class: 'error-box', text: errorMessage(error) }));
    }
  } });

  const columns = [
    { key: 'title', label: 'Task', render: (t) => el('div', {},
      el('div', { text: t.title }), t.description ? el('div', { class: 'small muted', text: t.description }) : null) },
    { key: 'assigned_to', label: 'Assignee', render: (t) => isHr() ? (names.get(t.assigned_to) || 'Unassigned') : 'You' },
    { key: 'due_date', label: 'Due', render: (t) => el('div', {},
      el('span', { text: t.due_date || '—' }),
      t.overdue ? el('span', { class: 'badge overdue ml-1', text: 'overdue' }) : null) },
    { key: 'priority', label: 'Priority', render: (t) => badge(t.priority) },
    { key: 'status', label: 'Status', render: (t) => el('div', { class: 'row-actions' }, statusCell(t)) },
    { key: 'actions', label: 'Actions', render: (t) => el('div', { class: 'row-actions' },
      comments(t),
      isHr() ? el('button', { class: 'btn small', text: 'Edit', onClick: () => {
        const modal = openModal('Edit task', createForm([
          { name: 'title', label: 'Title', required: true, value: t.title },
          { name: 'description', label: 'Description', type: 'textarea', value: t.description ?? '' },
          { name: 'assigned_to', label: 'Assign to', type: 'select', required: true,
            options: employees.map((e) => ({ value: e.id, label: `${e.code} · ${e.name}` })), value: t.assigned_to },
          { name: 'due_date', label: 'Due date', type: 'date', value: t.due_date },
          { name: 'priority', label: 'Priority', type: 'select', options: priorities, value: t.priority },
        ], 'Save changes', async (data) => {
          await api(`/api/tasks/${t.id}`, {
            method: 'PATCH',
            body: patchPayload(data, { keepBlank: ['description'] }),
          });
          modal.close();
        }, { successMessage: 'Task updated' }));
      } }) : null,
      isHr() ? el('button', { class: 'btn small danger', text: 'Delete', onClick: () => confirmAction(
        `Delete “${t.title}”?`, () => api(`/api/tasks/${t.id}`, { method: 'DELETE' })) }) : null) },
  ];

  const host = el('div');
  host.replaceChildren(dataTable(columns, await api('/api/tasks')));
  const filters = createForm([
    { name: 'status', label: 'Status', type: 'select', options: [{ value: '', label: 'All statuses' }, ...statuses] },
    { name: 'priority', label: 'Priority', type: 'select', options: [{ value: '', label: 'All priorities' }, ...priorities] },
    ...(isHr() ? [{ name: 'assigned_to', label: 'Assignee', type: 'select', options: [{ value: '', label: 'All employees' }, ...employees.map((e) => ({ value: e.id, label: e.name }))] }] : []),
  ], 'Apply filters', async (data) => {
    const query = new URLSearchParams(cleanPayload(data));
    host.replaceChildren(dataTable(columns, await api(`/api/tasks?${query}`)));
  }, { silent: true });

  return screen('Tasks', 'Assign work, track status and discuss progress.',
    ...(isHr() ? [panel('Assign a task', [createForm(createFields, 'Assign task', async (data) =>
      api('/api/tasks', { method: 'POST', body: cleanPayload(data) }), { successMessage: 'Task created' })])] : []),
    panel('Tasks', [filters, host]));
}

// ---------------------------------------------------------------------------
// Assets (HR/admin only)
// ---------------------------------------------------------------------------

async function screenAssets() {
  const [assets, employees] = await Promise.all([api('/api/assets'), api('/api/employees')]);
  const names = new Map(employees.map((e) => [e.id, e.name]));

  const assign = (asset) => el('button', { class: 'btn small ok', text: 'Assign', onClick: () => {
    const modal = openModal(`Assign · ${asset.name}`, createForm([
      { name: 'employeeId', label: 'Employee', type: 'select', required: true,
        options: employees.map((e) => ({ value: e.id, label: `${e.code} · ${e.name}` })) },
    ], 'Assign', async (data) => {
      await api(`/api/assets/${asset.id}/assign`, { method: 'POST', body: cleanPayload(data) });
      modal.close();
    }, { successMessage: 'Asset assigned' }));
  } });

  const returnAsset = (asset) => el('button', { class: 'btn small', text: 'Return', onClick: async () => {
    try {
      await api(`/api/assets/${asset.id}/return`, { method: 'POST' });
      toast('Asset returned');
      render();
    } catch (error) {
      toast(errorMessage(error), 'error');
    }
  } });

  const history = (asset) => el('button', { class: 'btn small', text: 'History', onClick: async () => {
    const host = el('div', {}, el('p', { class: 'muted small', text: 'Loading…' }));
    openModal(`History · ${asset.name}`, host);
    const rows = await api(`/api/assets/${asset.id}/history`);
    host.replaceChildren(dataTable(['id', 'employee_id', 'assigned_at', 'returned_at', 'status'], rows.map((r) => ({
      ...r, employee_id: names.get(r.employee_id) || `#${r.employee_id}`,
    })), { empty: 'No assignments recorded.' }));
  } });

  const columns = [
    { key: 'name' },
    { key: 'type' },
    { key: 'serial' },
    { key: 'value', className: 'num', render: (r) => money(r.value) },
    { key: 'status', label: 'Status', render: (r) => badge(r.status) },
    { key: 'actions', label: 'Actions', render: (r) => el('div', { class: 'row-actions' },
      r.status === 'available' ? assign(r) : null,
      r.status === 'assigned' ? returnAsset(r) : null,
      history(r),
      el('button', { class: 'btn small', text: 'Edit', onClick: () => {
        const modal = openModal(`Edit · ${r.name}`, createForm([
          { name: 'name', label: 'Name', required: true, value: r.name },
          { name: 'type', label: 'Type', value: r.type ?? '' },
          { name: 'serial', label: 'Serial', value: r.serial ?? '' },
          { name: 'purchase_date', label: 'Purchase date', type: 'date', value: r.purchase_date },
          { name: 'value', label: 'Value', type: 'number', min: 0, step: 1, value: r.value },
        ], 'Save changes', async (data) => {
          await api(`/api/assets/${r.id}`, {
            method: 'PATCH',
            body: patchPayload(data, { keepBlank: ['type', 'serial'] }),
          });
          modal.close();
        }, { successMessage: 'Asset updated' }));
      } }),
      el('button', { class: 'btn small danger', text: 'Delete', onClick: () => confirmAction(
        `Delete “${r.name}” and its history?`, () => api(`/api/assets/${r.id}`, { method: 'DELETE' })) })) },
  ];

  const host = el('div');
  host.replaceChildren(dataTable(columns, assets));
  const filters = createForm([
    { name: 'status', label: 'Status', type: 'select', options: [{ value: '', label: 'All statuses' }, 'available', 'assigned'] },
    { name: 'type', label: 'Type' },
  ], 'Apply filters', async (data) => {
    const query = new URLSearchParams(cleanPayload(data));
    host.replaceChildren(dataTable(columns, await api(`/api/assets?${query}`)));
  }, { silent: true });

  return screen('Assets', 'Register equipment and track assignments.',
    panel('Register an asset', [createForm([
      { name: 'name', label: 'Name', required: true },
      { name: 'type', label: 'Type' },
      { name: 'serial', label: 'Serial number' },
      { name: 'purchase_date', label: 'Purchase date', type: 'date' },
      { name: 'value', label: 'Value', type: 'number', min: 0, step: 1, value: 0 },
    ], 'Register asset', async (data) => api('/api/assets', { method: 'POST', body: cleanPayload(data) }))]),
    panel('Asset register', [filters, host]));
}

// ---------------------------------------------------------------------------
// Reports (all roles; employee-scoped by the server)
// ---------------------------------------------------------------------------

async function reportBlock({ title, fields, load, columns, path }) {
  const tableHost = el('div', {}, el('p', { class: 'loading', text: 'Loading…' }));
  const csvLink = el('a', { class: 'btn small', text: 'Download CSV', href: '#', download: '' });

  const run = async (data) => {
    const query = new URLSearchParams(cleanPayload(data));
    const rows = await load(query);
    tableHost.replaceChildren(dataTable(columns, rows));
    csvLink.href = `${path}?${query}${query.size ? '&' : ''}format=csv`;
  };

  const form = createForm(fields, 'Load report', (data) => run(data), { silent: true });
  // Populate with default period values without blocking the whole screen.
  run(collectForm(form, fields)).catch((error) => {
    tableHost.replaceChildren(el('div', { class: 'error-box', text: errorMessage(error) }));
  });

  return el('div', { class: 'report-block' },
    panel(title, [form, tableHost], el('div', { class: 'row-actions' }, csvLink)));
}

async function screenReports() {
  const employees = isHr() ? await api('/api/employees') : [];
  const employeeFilter = { name: 'employeeId', label: 'Employee', type: 'select',
    options: [{ value: '', label: 'All employees' }, ...employees.map((e) => ({ value: e.id, label: `${e.code} · ${e.name}` }))] };
  const period = [
    { name: 'month', label: 'Month', type: 'number', min: 1, required: true, value: uiPeriod.month },
    { name: 'year', label: 'Year', type: 'number', min: 1, required: true, value: uiPeriod.year },
  ];
  // Expense reimbursement month/year are optional: leaving them blank shows
  // all claims (including those not yet flagged for a payroll month).
  const optionalPeriod = [
    { name: 'month', label: 'Month', type: 'number', min: 1 },
    { name: 'year', label: 'Year', type: 'number', min: 1 },
  ];
  const load = (name, key) => (query) => api(`/api/reports/${name}?${query}`).then((result) => result[key]);

  const blocks = [
    await reportBlock({
      title: 'Attendance report',
      fields: [...period, employeeFilter],
      load: load('attendance', 'employees'),
      path: '/api/reports/attendance',
      columns: ['employee_id', 'employee_name', 'present', 'half_day', 'leave', 'holiday', 'absent', 'present_days', 'worked_minutes', 'overtime_minutes'],
    }),
    await reportBlock({
      title: 'Leave balance report',
      fields: [employeeFilter],
      load: load('leave', 'balances'),
      path: '/api/reports/leave',
      columns: ['employee_name', 'leave_type', 'opening_balance', 'used', 'remaining'],
    }),
    await reportBlock({
      title: 'Payroll report',
      fields: [...period, employeeFilter],
      load: load('payroll', 'slips'),
      path: '/api/reports/payroll',
      columns: ['employee_name', 'gross', 'deductions', 'net', 'present_days', 'status'],
    }),
    await reportBlock({
      title: 'Expense report',
      fields: [...optionalPeriod, { name: 'status', label: 'Status', type: 'select', options: [{ value: '', label: 'All statuses' }, 'pending', 'approved', 'rejected', 'reimbursed'] }, employeeFilter],
      load: load('expenses', 'expenses'),
      path: '/api/reports/expenses',
      columns: ['employee_name', 'category', 'amount', 'status', 'reimbursement_month', 'reimbursement_year'],
    }),
  ];

  return screen('Reports', 'Filterable tables with CSV downloads for every module.', ...blocks);
}

// ---------------------------------------------------------------------------
// Settings (HR/admin only)
// ---------------------------------------------------------------------------

async function screenSettings() {
  const [settings, holidays] = await Promise.all([
    api('/api/settings'), api('/api/settings/holidays'),
  ]);
  const numericKeys = new Set([
    'working_days_per_month', 'pf_rate', 'pf_ceiling', 'esic_rate', 'esic_ceiling',
    'professional_tax', 'income_tax_rate', 'overtime_cap_minutes', 'overtime_multiplier',
    'grace_minutes', 'weekly_off_day',
  ]);
  const timeKeys = new Set(['shift_start_time', 'shift_end_time']);
  const keys = Object.keys(settings);
  const fieldFor = (key) => ({
    name: key,
    label: titleCase(key),
    type: numericKeys.has(key) ? 'number' : timeKeys.has(key) ? 'time' : 'text',
    min: numericKeys.has(key) ? 0 : undefined,
    step: numericKeys.has(key) ? 'any' : undefined,
    value: settings[key],
  });
  const groups = [
    ['Company', keys.filter((k) => ['company_name', 'currency', 'locale', 'date_format', 'calendar'].includes(k))],
    ['Payroll rates', keys.filter((k) => k.includes('rate') || k.includes('ceiling') || k.includes('tax') || ['working_days_per_month', 'overtime_cap_minutes', 'overtime_multiplier'].includes(k))],
    ['Shifts & calendar', keys.filter((k) => ['shift_start_time', 'shift_end_time', 'grace_minutes', 'weekly_off_day'].includes(k))],
  ];
  const settingPanels = groups.map(([title, groupKeys]) =>
    panel(title, [createForm(groupKeys.map(fieldFor), 'Save section', async (data) => {
      const payload = {};
      const skipped = [];
      for (const [key, value] of Object.entries(data)) {
        if (!numericKeys.has(key)) {
          payload[key] = value;
          continue;
        }
        // A blank number input is collected as null; Number(null) === 0, which
        // would silently persist a zero rate. Never send blank numerics.
        if (value === null || value === undefined || value === '' || !Number.isFinite(Number(value))) {
          skipped.push(titleCase(key));
          continue;
        }
        payload[key] = Number(value);
      }
      if (skipped.length > 0) {
        toast(`Skipped blank/invalid numeric fields: ${skipped.join(', ')}`, 'error');
      }
      if (Object.keys(payload).length === 0) return;
      await api('/api/settings', { method: 'PATCH', body: payload });
      Object.assign(settings, payload);
    }, { successMessage: `${title} saved` })]));

  const holidayColumns = [
    { key: 'date' },
    { key: 'name' },
    { key: 'actions', label: 'Actions', render: (h) => el('button', { class: 'btn small danger', text: 'Delete',
      onClick: () => confirmAction(`Delete holiday on ${h.date}?`,
        () => api(`/api/settings/holidays/${h.id}`, { method: 'DELETE' })) }) },
  ];
  const holidayHost = el('div');
  holidayHost.replaceChildren(dataTable(holidayColumns, holidays, { empty: 'No holidays configured.' }));

  return screen('Settings', 'Configure company details, payroll rates and holidays.',
    ...settingPanels,
    panel('Add holiday', [createForm([
      { name: 'date', label: 'Date', type: 'date', required: true, value: today() },
      { name: 'name', label: 'Name' },
    ], 'Add holiday', async (data) => api('/api/settings/holidays', { method: 'POST', body: cleanPayload(data) }),
    { successMessage: 'Holiday added' })]),
    panel('Holidays', [holidayHost]));
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function boot() {
  try {
    STATE.user = await api('/api/auth/me');
  } catch {
    STATE.user = null;
  }
  window.addEventListener('hashchange', render);
  await render();
}

boot();
