/**
 * Spec-kit `tasks.md` parser.
 *
 * RFC-0036 Phase 4 (AISDLC-329). Reads spec-kit's `tasks.md` and produces
 * a list of structured task entries the import path can translate into
 * backlog tasks.
 *
 * Per OQ-1 the bridge reads `tasks.md` only — no fallback to `spec.md`.
 * Per OQ-11 the parser auto-detects the spec-kit schema version; an
 * unknown layout returns `schemaVersion: 'unknown'` and the import path
 * routes that through a `Decision: upstream-schema-unknown`.
 *
 * Tested layouts (spec-kit ≥ v0.8.x):
 *   ## Tasks
 *
 *   ### T-001 — <title>
 *   <body lines...>
 *
 *   ### T-002 — <title>
 *   ...
 *
 *   OR
 *
 *   - [ ] T-001 — <title>
 *     - AC: <criterion>
 *     - AC: <criterion>
 *
 *   OR (current `/speckit-tasks` checklist output — no hyphen in the task
 *   id; optional `[P]` parallel marker and `[STORY]` label precede the
 *   description, which also carries the target file path inline rather
 *   than via separate `AC:` lines):
 *
 *   - [ ] T001 Description with file path
 *   - [ ] T003 [P] Description with file path
 *   - [ ] T021 [P] [US1] Description with file path
 *   - [ ] T030 [US1] Description with file path
 *
 * All three shapes are present in real spec-kit projects; v0.8 leans on
 * the `### T-NNN` heading form for `/speckit.tasks`, older layouts use
 * the hyphenated checkbox-list form, and current `/speckit-tasks` output
 * uses the unhyphenated `TNNN` checklist form with inline `[P]`/`[Story]`
 * labels (no separate `AC:` lines — the description line is the spec).
 *
 * @module import-spec/parser
 */

export type SpecKitSchemaVersion =
  | 'v0.8-headings'
  | 'v0.7-checkboxes'
  | 'speckit-checklist-labels'
  | 'unknown';

export interface SpecKitTaskEntry {
  /** Upstream task identifier — e.g. 'T-001'. */
  taskId: string;
  /** Human-readable task title. */
  title: string;
  /** Markdown body lines, joined with newlines, trimmed. */
  body: string;
  /** Acceptance criteria extracted from `AC:` / `- AC:` lines. */
  acceptanceCriteria: string[];
}

export interface ParseTasksMdResult {
  schemaVersion: SpecKitSchemaVersion;
  /** Empty when `schemaVersion === 'unknown'`. */
  entries: SpecKitTaskEntry[];
}

// Horizontal-whitespace classes ([ \t]) instead of \s so optional-whitespace
// groups cannot overlap newline-anchored alternatives — avoids polynomial
// backtracking on adversarial imported specs (CodeQL js/polynomial-redos).
// Trailing title/AC text uses a greedy (.+)$ (linear) rather than the lazy
// (.+?)\s*$ form, whose lazy-capture-then-optional-trailing-whitespace overlap
// is also polynomial. Callers .trim() the captured group to preserve the
// prior trailing-strip behaviour.
const HEADING_RE = /^###[ \t]+(T-\d+)[ \t]*[—\-:]?[ \t]*(.+)$/;
const CHECKBOX_RE = /^-[ \t]*\[[ x]\][ \t]*(T-\d+)[ \t]*[—\-:]?[ \t]*(.+)$/i;
// Current `/speckit-tasks` checklist form: `- [ ] T001 [P] [Story] Description`.
// Task id is unhyphenated `T\d{3,}` (vs. legacy `T-\d+`), so this never
// collides with HEADING_RE/CHECKBOX_RE. `[P]` and `[STORY]` are each
// optional, single bracketed tokens consumed before the free-text
// description; both use bounded `[ \t]+` (not `\s*`) around fixed
// literal/charclass tokens, so — per the polynomial-backtracking note
// above — there's no overlapping-optional-whitespace blowup risk.
const CHECKLIST_LABELS_RE =
  /^-[ \t]*\[[ xX]\][ \t]+(T\d{3,})[ \t]+(?:\[P\][ \t]+)?(?:\[([A-Za-z][A-Za-z0-9]*)\][ \t]+)?(.+)$/;
// A markdown list-item continuation: indented ≥2 spaces, non-blank, and
// (checked by the caller) not itself a new `- [ ] T###` line. Real
// spec-kit output wraps long descriptions/file paths onto indented
// follow-on lines rather than keeping every task on one physical line.
const CONTINUATION_RE = /^[ \t]{2,}\S.*$/;
const AC_LINE_RE = /^[ \t]*(?:-[ \t]*)?AC:[ \t]*(.+)$/i;
const TASKS_SECTION_RE = /^##\s+Tasks\s*$/i;

/**
 * Detect the spec-kit schema variant by scanning for the first task-shaped
 * line. Used both as a structural check (`unknown` means we can't parse
 * any task entries safely) and to drive the per-shape parser branch.
 */
export function detectSchema(source: string): SpecKitSchemaVersion {
  const lines = source.split('\n');
  for (const line of lines) {
    if (HEADING_RE.test(line)) return 'v0.8-headings';
    if (CHECKBOX_RE.test(line)) return 'v0.7-checkboxes';
    if (CHECKLIST_LABELS_RE.test(line)) return 'speckit-checklist-labels';
  }
  return 'unknown';
}

/**
 * Parse the spec-kit `tasks.md` source into structured entries.
 *
 * When `schemaVersion` is `unknown` the caller MUST treat it as an
 * upstream-schema-mismatch and emit `Decision: upstream-schema-unknown`
 * via the Decision Catalog rather than producing zero tasks silently.
 */
export function parseTasksMd(source: string): ParseTasksMdResult {
  const schemaVersion = detectSchema(source);
  if (schemaVersion === 'unknown') return { schemaVersion, entries: [] };

  // Optionally narrow to a `## Tasks` section if present; not required.
  const lines = source.split('\n');
  let startIdx = 0;
  for (let i = 0; i < lines.length; i += 1) {
    if (TASKS_SECTION_RE.test(lines[i])) {
      startIdx = i + 1;
      break;
    }
  }

  if (schemaVersion === 'v0.8-headings') {
    return { schemaVersion, entries: parseHeadings(lines, startIdx) };
  }
  if (schemaVersion === 'speckit-checklist-labels') {
    return { schemaVersion, entries: parseChecklistLabels(lines, startIdx) };
  }
  return { schemaVersion, entries: parseCheckboxes(lines, startIdx) };
}

function parseHeadings(lines: string[], startIdx: number): SpecKitTaskEntry[] {
  const entries: SpecKitTaskEntry[] = [];
  let current: SpecKitTaskEntry | null = null;
  const flush = (): void => {
    if (current) {
      current.body = current.body.trim();
      entries.push(current);
    }
    current = null;
  };

  for (let i = startIdx; i < lines.length; i += 1) {
    const line = lines[i];
    const headingMatch = HEADING_RE.exec(line);
    if (headingMatch) {
      flush();
      current = {
        taskId: headingMatch[1],
        title: headingMatch[2].trim(),
        body: '',
        acceptanceCriteria: [],
      };
      continue;
    }
    // Stop the current entry when a new top-level section starts.
    if (/^##\s+/.test(line) && !/^##\s+Tasks/i.test(line)) {
      flush();
      continue;
    }
    if (current) {
      const acMatch = AC_LINE_RE.exec(line);
      if (acMatch) {
        current.acceptanceCriteria.push(acMatch[1].trim());
      } else {
        current.body += line + '\n';
      }
    }
  }
  flush();
  return entries;
}

function parseCheckboxes(lines: string[], startIdx: number): SpecKitTaskEntry[] {
  const entries: SpecKitTaskEntry[] = [];
  let current: SpecKitTaskEntry | null = null;
  const flush = (): void => {
    if (current) {
      current.body = current.body.trim();
      entries.push(current);
    }
    current = null;
  };

  for (let i = startIdx; i < lines.length; i += 1) {
    const line = lines[i];
    const cbMatch = CHECKBOX_RE.exec(line);
    if (cbMatch) {
      flush();
      current = {
        taskId: cbMatch[1],
        title: cbMatch[2].trim(),
        body: '',
        acceptanceCriteria: [],
      };
      continue;
    }
    if (/^##\s+/.test(line) && !/^##\s+Tasks/i.test(line)) {
      flush();
      continue;
    }
    if (current) {
      const acMatch = AC_LINE_RE.exec(line);
      if (acMatch) {
        current.acceptanceCriteria.push(acMatch[1].trim());
      } else if (line.trim().length > 0) {
        current.body += line.trim() + '\n';
      }
    }
  }
  flush();
  return entries;
}

/**
 * Current `/speckit-tasks` checklist form. There's no separate `AC:`
 * block — the description (optionally wrapped across indented
 * continuation lines, since long descriptions/file paths routinely
 * exceed one line) is the entire spec for the task, so it's folded into
 * `title` rather than split title/body.
 *
 * Intervening *non-indented* lines (phase headers, blank lines,
 * "**Goal**: ..." prose, the next task) end the current task's
 * continuation — unlike {@link parseHeadings}/{@link parseCheckboxes},
 * this parser never folds section prose into a task.
 */
function parseChecklistLabels(lines: string[], startIdx: number): SpecKitTaskEntry[] {
  const entries: SpecKitTaskEntry[] = [];
  let current: SpecKitTaskEntry | null = null;

  for (let i = startIdx; i < lines.length; i += 1) {
    const line = lines[i];
    const match = CHECKLIST_LABELS_RE.exec(line);
    if (match) {
      current = {
        taskId: match[1],
        title: match[3].trim(),
        body: '',
        acceptanceCriteria: [],
      };
      entries.push(current);
      continue;
    }
    if (current && CONTINUATION_RE.test(line)) {
      current.title += ' ' + line.trim();
      continue;
    }
    current = null;
  }
  return entries;
}
