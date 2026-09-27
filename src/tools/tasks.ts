/**
 * Google Tasks tools (task lists + tasks: list, create, update, complete, move, delete, clear).
 * API: https://tasks.googleapis.com/tasks/v1
 *
 * Gotchas baked in:
 *  - Google stores `due` as midnight UTC and ignores any time part; tools accept
 *    YYYY-MM-DD (or RFC3339) and return the date part only.
 *  - Tasks completed in Google's own clients (web UI, mobile apps, Gmail/Calendar
 *    side panel) are `hidden` immediately, so listing completed tasks needs
 *    showHidden=true as well as showCompleted=true (the tool sets both).
 *  - '@default' is the account's primary task list.
 */
import { z } from "zod";
import { API } from "../google/client.js";
import { tool, enc, listResult, PageSize, PageToken, audit, type AnyRec } from "./_shared.js";

const SCOPE = "https://www.googleapis.com/auth/tasks";
const TaskListId = z.string().default("@default").describe("Task list id (from tasks_list_tasklists); '@default' = the primary list");
const TaskId = z.string().describe("Task id (from tasks_list_tasks)");
const TASK_FIELDS = "id,title,notes,status,due,completed,parent,position,updated,webViewLink,links,deleted,hidden";
const TASKLIST_FIELDS = "id,title,updated";

/** Normalize YYYY-MM-DD or RFC3339 to the RFC3339 midnight-UTC form Tasks expects. */
function toRfc3339(value: string, label: string): string {
  const v = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return `${v}T00:00:00.000Z`;
  const ms = Date.parse(v);
  if (Number.isNaN(ms)) throw new Error(`${label} must be YYYY-MM-DD or an RFC3339 timestamp (got '${value}')`);
  return new Date(ms).toISOString();
}

/** Due dates: Google keeps only the date (midnight UTC) → normalize to that exact form. */
function toDueDate(value: string): string {
  // Keep the calendar date the caller wrote (a non-UTC offset must not shift the day).
  const literal = /^(\d{4}-\d{2}-\d{2})(?:T|$)/.exec(value.trim());
  const day = literal ? literal[1] : toRfc3339(value, "due").slice(0, 10);
  return `${day}T00:00:00.000Z`;
}

function compactTask(t: AnyRec): AnyRec {
  return {
    id: t.id,
    title: t.title,
    notes: t.notes,
    status: t.status,
    due: typeof t.due === "string" ? t.due.slice(0, 10) : undefined,
    completed: t.completed,
    parent: t.parent,
    position: t.position,
    updated: t.updated,
    webViewLink: t.webViewLink,
    links: t.links,
    deleted: t.deleted,
    hidden: t.hidden,
  };
}

function compactTaskList(l: AnyRec): AnyRec {
  return { id: l.id, title: l.title, updated: l.updated };
}

/** Flat list ordered as the UI shows it: top-level tasks by position, each followed by its subtasks by position. */
function orderByPosition(items: AnyRec[]): AnyRec[] {
  const byPos = (a: AnyRec, b: AnyRec) => String(a.position ?? "").localeCompare(String(b.position ?? ""));
  const ids = new Set(items.map((t) => t.id));
  const children = new Map<string, AnyRec[]>();
  const roots: AnyRec[] = [];
  for (const t of items) {
    if (t.parent && ids.has(t.parent)) {
      const list = children.get(t.parent) ?? [];
      list.push(t);
      children.set(t.parent, list);
    } else roots.push(t);
  }
  const out: AnyRec[] = [];
  const visit = (t: AnyRec) => {
    out.push(t);
    for (const c of (children.get(t.id) ?? []).sort(byPos)) visit(c);
  };
  for (const r of roots.sort(byPos)) visit(r);
  return out;
}

export const tasksTools = [
  tool({
    name: "tasks_list_tasklists",
    description: "List all Google Tasks lists (to-do lists) of the account — the way to get tasklist ids. Returns [{id, title, updated}]; use the id as tasklist_id in the other tasks_* tools ('@default' always means the primary list).",
    scope: SCOPE,
    input: { max_results: PageSize(100, 1000), page_token: PageToken },
    handler: async (a, { g }) => {
      const r = await g.get<AnyRec>(`${API.tasks}/users/@me/lists`, { maxResults: a.max_results, pageToken: a.page_token, fields: `nextPageToken,items(${TASKLIST_FIELDS})` });
      return listResult((r.items ?? []).map(compactTaskList), r.nextPageToken);
    },
  }),

  tool({
    name: "tasks_create_tasklist",
    description: "Create a new task list. Returns {id, title, updated}.",
    scope: SCOPE,
    write: true,
    destructive: false,
    input: { title: z.string().min(1).describe("Task list name") },
    handler: async (a, { g }) => {
      const r = await g.post<AnyRec>(`${API.tasks}/users/@me/lists`, { title: a.title });
      audit("tasks_create_tasklist", { tasklist: r.id });
      return compactTaskList(r);
    },
  }),

  tool({
    name: "tasks_update_tasklist",
    description: "Rename a task list (title is the only editable field).",
    scope: SCOPE,
    write: true,
    idempotent: true,
    input: { tasklist_id: z.string().describe("Task list id (not '@default' — use the real id from tasks_list_tasklists)"), title: z.string().min(1) },
    handler: async (a, { g }) => {
      const r = await g.patch<AnyRec>(`${API.tasks}/users/@me/lists/${enc(a.tasklist_id)}`, { title: a.title });
      audit("tasks_update_tasklist", { tasklist: a.tasklist_id });
      return compactTaskList(r);
    },
  }),

  tool({
    name: "tasks_delete_tasklist",
    description: "Delete a task list and every task in it (irreversible). The primary list cannot be deleted.",
    scope: SCOPE,
    write: true,
    destructive: true,
    idempotent: true,
    input: { tasklist_id: z.string().describe("Task list id") },
    handler: async (a, { g }) => {
      await g.delete(`${API.tasks}/users/@me/lists/${enc(a.tasklist_id)}`);
      audit("tasks_delete_tasklist", { tasklist: a.tasklist_id });
      return { deleted: true, tasklistId: a.tasklist_id };
    },
  }),

  tool({
    name: "tasks_list_tasks",
    description:
      "List tasks in a task list (flat, ordered like the UI: top-level tasks by position, each followed by its subtasks; subtasks carry `parent`). By default only open tasks are returned — set show_completed=true to include completed ones (hidden ones, i.e. completed in Google's own apps, are included automatically). Dates accept YYYY-MM-DD or RFC3339; `due` comes back as YYYY-MM-DD.",
    scope: SCOPE,
    input: {
      tasklist_id: TaskListId,
      show_completed: z.boolean().default(false).describe("Include completed tasks (implies show_hidden — Google hides tasks completed in its own apps)"),
      show_hidden: z.boolean().default(false).describe("Include hidden tasks even when show_completed is false"),
      show_deleted: z.boolean().default(false).describe("Include deleted tasks"),
      due_min: z.string().optional().describe("Only tasks due on/after this date (YYYY-MM-DD or RFC3339)"),
      due_max: z.string().optional().describe("Only tasks due before this date (YYYY-MM-DD or RFC3339)"),
      completed_min: z.string().optional().describe("Only tasks completed on/after this time (implies show_completed)"),
      completed_max: z.string().optional().describe("Only tasks completed before this time (implies show_completed)"),
      updated_min: z.string().optional().describe("Only tasks modified on/after this time"),
      max_results: PageSize(100, 100),
      page_token: PageToken,
    },
    handler: async (a, { g }) => {
      const showCompleted = a.show_completed || !!a.completed_min || !!a.completed_max;
      const r = await g.get<AnyRec>(`${API.tasks}/lists/${enc(a.tasklist_id)}/tasks`, {
        showCompleted,
        // Google: "showHidden must also be True to show tasks completed in first party clients".
        showHidden: a.show_hidden || showCompleted,
        showDeleted: a.show_deleted,
        dueMin: a.due_min ? toRfc3339(a.due_min, "due_min") : undefined,
        dueMax: a.due_max ? toRfc3339(a.due_max, "due_max") : undefined,
        completedMin: a.completed_min ? toRfc3339(a.completed_min, "completed_min") : undefined,
        completedMax: a.completed_max ? toRfc3339(a.completed_max, "completed_max") : undefined,
        updatedMin: a.updated_min ? toRfc3339(a.updated_min, "updated_min") : undefined,
        maxResults: a.max_results,
        pageToken: a.page_token,
        fields: `nextPageToken,items(${TASK_FIELDS})`,
      });
      return listResult(orderByPosition(r.items ?? []).map(compactTask), r.nextPageToken, { tasklistId: a.tasklist_id });
    },
  }),

  tool({
    name: "tasks_get_task",
    description: "Get one task by id: title, notes, status (needsAction|completed), due (YYYY-MM-DD), completed time, parent, position, links.",
    scope: SCOPE,
    input: { tasklist_id: TaskListId, task_id: TaskId },
    handler: async (a, { g }) => compactTask(await g.get<AnyRec>(`${API.tasks}/lists/${enc(a.tasklist_id)}/tasks/${enc(a.task_id)}`, { fields: TASK_FIELDS })),
  }),

  tool({
    name: "tasks_create_task",
    description:
      "Create a task. `due` takes YYYY-MM-DD (Google Tasks stores dates only — any time part is dropped). Nest it under another task with `parent`, and/or place it right after a sibling with `previous` (omit both to put it at the top of the list).",
    scope: SCOPE,
    write: true,
    destructive: false,
    input: {
      tasklist_id: TaskListId,
      title: z.string().min(1),
      notes: z.string().optional().describe("Task details / description"),
      due: z.string().optional().describe("Due date YYYY-MM-DD (or RFC3339; only the date is kept)"),
      parent: z.string().optional().describe("Parent task id → creates a subtask"),
      previous: z.string().optional().describe("Sibling task id to insert after (same parent)"),
    },
    handler: async (a, { g }) => {
      const body: AnyRec = { title: a.title, notes: a.notes };
      if (a.due) body.due = toDueDate(a.due);
      const r = await g.post<AnyRec>(`${API.tasks}/lists/${enc(a.tasklist_id)}/tasks`, body, { parent: a.parent, previous: a.previous });
      audit("tasks_create_task", { tasklist: a.tasklist_id, task: r.id, subtask: !!a.parent });
      return compactTask(r);
    },
  }),

  tool({
    name: "tasks_update_task",
    description:
      "Update a task's title, notes, due date and/or status (PATCH — omitted fields are untouched). Pass due='' to clear the due date. status=completed marks it done (Google sets the completion time); status=needsAction reopens it. To move/re-nest a task use tasks_move_task.",
    scope: SCOPE,
    write: true,
    idempotent: true,
    input: {
      tasklist_id: TaskListId,
      task_id: TaskId,
      title: z.string().optional(),
      notes: z.string().optional().describe("New notes ('' clears them)"),
      due: z.string().optional().describe("New due date YYYY-MM-DD; '' clears the due date"),
      status: z.enum(["needsAction", "completed"]).optional(),
    },
    handler: async (a, { g }) => {
      const body: AnyRec = {};
      if (a.title !== undefined) body.title = a.title;
      if (a.notes !== undefined) body.notes = a.notes;
      if (a.due !== undefined) body.due = a.due.trim() === "" ? null : toDueDate(a.due);
      if (a.status !== undefined) {
        body.status = a.status;
        if (a.status === "needsAction") body.completed = null;
      }
      if (Object.keys(body).length === 0) throw new Error("Nothing to update — pass at least one of title, notes, due, status");
      const r = await g.patch<AnyRec>(`${API.tasks}/lists/${enc(a.tasklist_id)}/tasks/${enc(a.task_id)}`, body);
      audit("tasks_update_task", { tasklist: a.tasklist_id, task: a.task_id, fields: Object.keys(body) });
      return compactTask(r);
    },
  }),

  tool({
    name: "tasks_complete_task",
    description: "Mark a task as completed (Google records the completion time). Subtasks are not completed automatically.",
    scope: SCOPE,
    write: true,
    idempotent: true,
    input: { tasklist_id: TaskListId, task_id: TaskId },
    handler: async (a, { g }) => {
      const r = await g.patch<AnyRec>(`${API.tasks}/lists/${enc(a.tasklist_id)}/tasks/${enc(a.task_id)}`, { status: "completed" });
      audit("tasks_complete_task", { tasklist: a.tasklist_id, task: a.task_id });
      return compactTask(r);
    },
  }),

  tool({
    name: "tasks_uncomplete_task",
    description: "Reopen a completed task (status back to needsAction, completion time cleared). Works on hidden/cleared tasks too.",
    scope: SCOPE,
    write: true,
    idempotent: true,
    input: { tasklist_id: TaskListId, task_id: TaskId },
    handler: async (a, { g }) => {
      const r = await g.patch<AnyRec>(`${API.tasks}/lists/${enc(a.tasklist_id)}/tasks/${enc(a.task_id)}`, { status: "needsAction", completed: null });
      audit("tasks_uncomplete_task", { tasklist: a.tasklist_id, task: a.task_id });
      return compactTask(r);
    },
  }),

  tool({
    name: "tasks_move_task",
    description:
      "Move a task: re-nest it under `parent` (omit to make it top-level), place it after `previous` (omit to put it first), and/or move it to another list with destination_tasklist_id. Recurring tasks cannot be moved between lists.",
    scope: SCOPE,
    write: true,
    idempotent: true,
    input: {
      tasklist_id: TaskListId,
      task_id: TaskId,
      parent: z.string().optional().describe("New parent task id (omit → top level)"),
      previous: z.string().optional().describe("Sibling task id to place after (omit → first position)"),
      destination_tasklist_id: z.string().optional().describe("Move to this task list"),
    },
    handler: async (a, { g }) => {
      const r = await g.post<AnyRec>(`${API.tasks}/lists/${enc(a.tasklist_id)}/tasks/${enc(a.task_id)}/move`, undefined, {
        parent: a.parent,
        previous: a.previous,
        destinationTasklist: a.destination_tasklist_id,
      });
      audit("tasks_move_task", { tasklist: a.tasklist_id, task: a.task_id, to: a.destination_tasklist_id, parent: a.parent });
      return compactTask(r);
    },
  }),

  tool({
    name: "tasks_delete_task",
    description: "Delete a task permanently (irreversible; its subtasks are deleted too). To just tick it off use tasks_complete_task.",
    scope: SCOPE,
    write: true,
    destructive: true,
    idempotent: true,
    input: { tasklist_id: TaskListId, task_id: TaskId },
    handler: async (a, { g }) => {
      await g.delete(`${API.tasks}/lists/${enc(a.tasklist_id)}/tasks/${enc(a.task_id)}`);
      audit("tasks_delete_task", { tasklist: a.tasklist_id, task: a.task_id });
      return { deleted: true, tasklistId: a.tasklist_id, taskId: a.task_id };
    },
  }),

  tool({
    name: "tasks_clear_completed_tasks",
    description: "Clear all completed tasks from a list: they become hidden (still retrievable with show_hidden=true, and can be reopened), not deleted.",
    scope: SCOPE,
    write: true,
    idempotent: true,
    destructive: true,
    input: { tasklist_id: TaskListId },
    handler: async (a, { g }) => {
      await g.post(`${API.tasks}/lists/${enc(a.tasklist_id)}/clear`);
      audit("tasks_clear_completed_tasks", { tasklist: a.tasklist_id });
      return { cleared: true, tasklistId: a.tasklist_id };
    },
  }),
];
