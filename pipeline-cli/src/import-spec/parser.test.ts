/**
 * Hermetic tests for `import-spec/parser`.
 *
 * Covers both spec-kit schema shapes (v0.8 headings + legacy checkbox),
 * the unknown-schema fallback, and AC extraction edge cases.
 */

import { describe, expect, it } from 'vitest';
import { detectSchema, parseTasksMd } from './parser.js';

describe('detectSchema', () => {
  it('detects v0.8-headings layout from a ### T- line', () => {
    expect(detectSchema('### T-001 — Build the thing')).toBe('v0.8-headings');
    expect(detectSchema('### T-042 - Title here')).toBe('v0.8-headings');
  });

  it('detects v0.7-checkboxes layout from a - [ ] T- line', () => {
    expect(detectSchema('- [ ] T-001 — Build')).toBe('v0.7-checkboxes');
    expect(detectSchema('- [x] T-2 - Done')).toBe('v0.7-checkboxes');
  });

  it('returns unknown for prose with no task markers', () => {
    expect(detectSchema('# A spec\n\nSome prose here.')).toBe('unknown');
  });

  it('prefers headings when both shapes are present', () => {
    const src = '### T-001 — Heading task\n\n- [ ] T-002 — Checkbox';
    expect(detectSchema(src)).toBe('v0.8-headings');
  });

  it('detects speckit-checklist-labels layout from an unhyphenated T### line', () => {
    expect(detectSchema('- [ ] T001 Create project structure')).toBe('speckit-checklist-labels');
    expect(detectSchema('- [ ] T003 [P] Configure linting')).toBe('speckit-checklist-labels');
    expect(detectSchema('- [ ] T021 [P] [US1] Unit test in src/Foo.test.ts')).toBe(
      'speckit-checklist-labels',
    );
    expect(detectSchema('- [x] T030 [US1] Implement CapturePaymentUseCase')).toBe(
      'speckit-checklist-labels',
    );
  });
});

describe('parseTasksMd — v0.8 headings', () => {
  it('parses a typical spec-kit tasks.md with headings + AC lines', () => {
    const src = [
      '# Tasks for auth-feature',
      '',
      '## Tasks',
      '',
      '### T-001 — Implement bearer-token validator',
      'Body line one.',
      'Body line two.',
      'AC: POST /auth/validate returns 200 on well-formed token',
      'AC: POST /auth/validate returns 401 on malformed token',
      '',
      '### T-002 — Add expiry check',
      'AC: tokens older than 1h return 401',
    ].join('\n');

    const result = parseTasksMd(src);
    expect(result.schemaVersion).toBe('v0.8-headings');
    expect(result.entries).toHaveLength(2);

    expect(result.entries[0]).toMatchObject({
      taskId: 'T-001',
      title: 'Implement bearer-token validator',
      acceptanceCriteria: [
        'POST /auth/validate returns 200 on well-formed token',
        'POST /auth/validate returns 401 on malformed token',
      ],
    });
    expect(result.entries[0].body).toContain('Body line one.');
    expect(result.entries[0].body).toContain('Body line two.');

    expect(result.entries[1].taskId).toBe('T-002');
    expect(result.entries[1].acceptanceCriteria).toEqual(['tokens older than 1h return 401']);
  });

  it('stops a task body at the next top-level ## section', () => {
    const src = [
      '### T-001 — First',
      'Some body.',
      '',
      '## Notes',
      'This should not be in T-001 body.',
    ].join('\n');

    const result = parseTasksMd(src);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].body).toContain('Some body.');
    expect(result.entries[0].body).not.toContain('This should not');
  });

  it('handles bullet-prefixed AC: lines', () => {
    const src = ['### T-005 — Title', '- AC: one', '- AC: two'].join('\n');
    const result = parseTasksMd(src);
    expect(result.entries[0].acceptanceCriteria).toEqual(['one', 'two']);
  });
});

describe('parseTasksMd — v0.7 checkboxes', () => {
  it('parses a checkbox-style tasks.md', () => {
    const src = [
      '## Tasks',
      '',
      '- [ ] T-001 — Build endpoint',
      '  - AC: returns 200 on success',
      '  - AC: returns 400 on bad input',
      '- [x] T-002 — Done already',
      '  - AC: noop',
    ].join('\n');

    const result = parseTasksMd(src);
    expect(result.schemaVersion).toBe('v0.7-checkboxes');
    expect(result.entries).toHaveLength(2);
    expect(result.entries[0].taskId).toBe('T-001');
    expect(result.entries[0].title).toBe('Build endpoint');
    expect(result.entries[0].acceptanceCriteria).toEqual([
      'returns 200 on success',
      'returns 400 on bad input',
    ]);
    expect(result.entries[1].taskId).toBe('T-002');
  });
});

describe('parseTasksMd — speckit-checklist-labels', () => {
  it('parses unhyphenated TNNN ids with optional [P]/[Story] labels', () => {
    const src = [
      '# Tasks: Payment Gateway MVP',
      '',
      '## Phase 1: Setup (Shared Infrastructure)',
      '',
      '- [ ] T001 Create the multi-module layout in settings.gradle.kts',
      '- [ ] T003 [P] Initialize mock-psp-stripe in mock-psp-stripe/build.gradle.kts',
      '',
      '## Phase 3: User Story 1 - Authorize and Capture a Payment (Priority: P1)',
      '',
      '**Goal**: core flow.',
      '',
      '- [ ] T021 [P] [US1] Unit test PaymentStateMachine in src/test/PaymentStateMachineTest.kt',
      '- [ ] T030 [US1] Implement AuthorizePaymentUseCase in src/main/AuthorizePaymentUseCase.kt',
    ].join('\n');

    const result = parseTasksMd(src);
    expect(result.schemaVersion).toBe('speckit-checklist-labels');
    expect(result.entries).toHaveLength(4);

    expect(result.entries[0]).toMatchObject({
      taskId: 'T001',
      title: 'Create the multi-module layout in settings.gradle.kts',
      body: '',
      acceptanceCriteria: [],
    });
    expect(result.entries[1]).toMatchObject({
      taskId: 'T003',
      title: 'Initialize mock-psp-stripe in mock-psp-stripe/build.gradle.kts',
    });
    // Phase headers and **Goal**-style prose between tasks are not folded
    // into either neighbour's body.
    expect(result.entries[2]).toMatchObject({
      taskId: 'T021',
      title: 'Unit test PaymentStateMachine in src/test/PaymentStateMachineTest.kt',
      body: '',
    });
    expect(result.entries[3]).toMatchObject({
      taskId: 'T030',
      title: 'Implement AuthorizePaymentUseCase in src/main/AuthorizePaymentUseCase.kt',
    });
  });

  it('treats a completed checkbox ([x]) the same as an open one', () => {
    const result = parseTasksMd('- [x] T058 Wire CI quality gates in .github/workflows/gate.yml');
    expect(result.schemaVersion).toBe('speckit-checklist-labels');
    expect(result.entries[0].taskId).toBe('T058');
  });

  it('folds indented continuation lines into the title and stops at the next non-indented line', () => {
    const src = [
      '## Phase 5: User Story 3 (Priority: P3)',
      '',
      '**Goal**: Operations users can find payments stuck in an unknown state.',
      '',
      '- [ ] T050 [US3] Implement',
      '  `GET /v1/payments?merchantId=&correlationId=`',
      '  search endpoint in',
      '  `payment-gateway/src/main/kotlin/.../PaymentResource.kt`',
      '- [ ] T051 [US3] Add a latency assertion to the search contract test',
      '',
      '**Checkpoint**: All three user stories are independently functional.',
    ].join('\n');

    const result = parseTasksMd(src);
    expect(result.schemaVersion).toBe('speckit-checklist-labels');
    expect(result.entries).toHaveLength(2);
    expect(result.entries[0].taskId).toBe('T050');
    expect(result.entries[0].title).toBe(
      'Implement `GET /v1/payments?merchantId=&correlationId=` search endpoint in `payment-gateway/src/main/kotlin/.../PaymentResource.kt`',
    );
    expect(result.entries[1].taskId).toBe('T051');
    expect(result.entries[1].title).toBe('Add a latency assertion to the search contract test');
  });
});

describe('parseTasksMd — unknown schema', () => {
  it('returns empty entries for prose-only input', () => {
    const result = parseTasksMd('# Hello\n\nNo tasks here.');
    expect(result.schemaVersion).toBe('unknown');
    expect(result.entries).toEqual([]);
  });

  it('returns empty entries for completely empty input', () => {
    const result = parseTasksMd('');
    expect(result.schemaVersion).toBe('unknown');
    expect(result.entries).toEqual([]);
  });
});
