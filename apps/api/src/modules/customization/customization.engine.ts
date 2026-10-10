/**
 * Customization engine — PURE logic (no database, no framework).
 *
 * Input : the group/option definitions that apply to a product + what the shopper selected.
 * Output: validation issues, the resolved selections, the server-computed price delta and an
 *         immutable snapshot. The service layer loads definitions/files from the DB and calls this.
 *
 * The same engine is used for: cart add, cart re-validation, checkout, and editing an order item.
 */
import type { CustomizationGroupType, CustomizationInput, TextCharset } from '@nb/shared';
import { sha256Hex } from '../../common/crypto/tokens.js';

export interface LocalizedName {
  ar: string;
  en: string;
}

export interface OptionDef {
  id: string;
  code: string;
  priceDelta: number;
  active: boolean;
  isDefault: boolean;
  name: LocalizedName;
}

export interface GroupDef {
  id: string;
  code: string;
  stepKey: string;
  type: CustomizationGroupType;
  /** Effective flag: product-level override already applied. */
  required: boolean;
  exclusiveWithinStep: boolean;
  minSelect: number;
  maxSelect: number | null;
  minLength: number | null;
  maxLength: number | null;
  allowedCharsets: TextCharset[];
  pattern: string | null;
  allowedMimeTypes: string[];
  maxFileSizeBytes: number | null;
  minWidthPx: number | null;
  minHeightPx: number | null;
  maxWidthPx: number | null;
  maxHeightPx: number | null;
  priceDelta: number;
  active: boolean;
  name: LocalizedName;
  options: OptionDef[];
}

export interface FileInfo {
  id: string;
  status: 'PENDING_UPLOAD' | 'READY' | 'REJECTED' | 'DELETED';
  groupId: string | null;
  mimeType: string;
  sizeBytes: number;
  widthPx: number | null;
  heightPx: number | null;
  /** True when the file belongs to the current user / guest session. */
  ownedByActor: boolean;
}

export interface Issue {
  field: string;
  code: string;
  params?: Record<string, unknown>;
}

export interface ResolvedSelection {
  stepKey: string;
  groupCode: string;
  groupType: CustomizationGroupType;
  groupName: LocalizedName;
  optionCode: string | null;
  optionName: LocalizedName | null;
  textValue: string | null;
  dateValue: string | null;
  artworkFileId: string | null;
  priceDelta: number;
}

export interface CustomizationSnapshot {
  version: 1;
  summary: Record<string, unknown>;
  selections: ResolvedSelection[];
  priceDelta: number;
}

export interface EvaluationResult {
  ok: boolean;
  issues: Issue[];
  selections: ResolvedSelection[];
  priceDelta: number;
  summary: Record<string, unknown>;
  configHash: string;
}

export const DEFAULT_ARTWORK_MIME_TYPES = ['image/png', 'image/jpeg', 'application/pdf'];

// ---------------------------------------------------------------------------------------------
// Text validation
// ---------------------------------------------------------------------------------------------

const FORBIDDEN_ALWAYS = /[\u0000-\u001F\u007F-\u009F​-‏‪-‮⁠-⁤⁦-⁩﻿<>]/u;

const CHARSET_TESTS: Record<TextCharset, RegExp> = {
  ARABIC: /[ء-يٮ-ۓۺ-ۿݐ-ݿً-ٰٟـ]/u,
  LATIN: /[A-Za-zÀ-ɏ]/u,
  DIGITS: /[0-9٠-٩۰-۹]/u,
  SYMBOLS: /[.,\-_'"!?&@#()/:;+*%=~★☆♥❤•·؟،]/u,
  SPACE: / /u,
};

export function normalizeText(raw: string): string {
  return raw.normalize('NFC').replace(/\s+/g, ' ').trim();
}

export function graphemeLength(text: string): number {
  const SegmenterCtor = (Intl as any).Segmenter as undefined | (new (l?: string, o?: object) => { segment(s: string): Iterable<unknown> });
  if (SegmenterCtor) {
    let n = 0;
    for (const _ of new SegmenterCtor(undefined, { granularity: 'grapheme' }).segment(text)) n++;
    return n;
  }
  return Array.from(text).length;
}

export function validateText(raw: string, group: Pick<GroupDef, 'minLength' | 'maxLength' | 'allowedCharsets' | 'pattern'>): { value: string; issues: Array<Omit<Issue, 'field'>> } {
  const issues: Array<Omit<Issue, 'field'>> = [];
  const value = normalizeText(raw);

  if (value.length === 0) return { value, issues: [{ code: 'CUSTOM_TEXT_REQUIRED' }] };
  if (FORBIDDEN_ALWAYS.test(value)) issues.push({ code: 'CUSTOM_TEXT_CHARSET' });

  const len = graphemeLength(value);
  if (group.minLength !== null && len < group.minLength) issues.push({ code: 'CUSTOM_TEXT_TOO_SHORT', params: { min: group.minLength } });
  if (group.maxLength !== null && len > group.maxLength) issues.push({ code: 'CUSTOM_TEXT_TOO_LONG', params: { max: group.maxLength } });

  if (group.allowedCharsets.length > 0) {
    const tests = group.allowedCharsets.map((c) => CHARSET_TESTS[c]);
    const bad = Array.from(value).some((ch) => !tests.some((t) => t.test(ch)));
    if (bad) issues.push({ code: 'CUSTOM_TEXT_CHARSET' });
  }

  if (group.pattern) {
    try {
      if (!new RegExp(group.pattern, 'u').test(value)) issues.push({ code: 'CUSTOM_TEXT_PATTERN' });
    } catch {
      // A broken admin-defined pattern must not block ordering; ignore it.
    }
  }
  return { value, issues };
}

export function isValidIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  if (y < 1900 || y > 2200) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

// ---------------------------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------------------------

export function evaluateCustomization(
  groups: GroupDef[],
  input: CustomizationInput | undefined | null,
  files: Map<string, FileInfo> = new Map(),
): EvaluationResult {
  const issues: Issue[] = [];
  const selections: ResolvedSelection[] = [];
  const activeGroups = groups.filter((g) => g.active);
  const byCode = new Map(activeGroups.map((g) => [g.code, g]));

  // index input by group code, flag unknown / duplicate groups
  const entries = new Map<string, NonNullable<CustomizationInput>[number]>();
  for (const entry of input ?? []) {
    if (!byCode.has(entry.groupCode)) {
      issues.push({ field: entry.groupCode, code: 'CUSTOM_UNKNOWN_GROUP', params: { groupCode: entry.groupCode } });
      continue;
    }
    if (entries.has(entry.groupCode)) {
      issues.push({ field: entry.groupCode, code: 'CUSTOM_SINGLE_ONLY', params: { groupCode: entry.groupCode } });
      continue;
    }
    entries.set(entry.groupCode, entry);
  }

  const filledByStep = new Map<string, string[]>(); // exclusive groups only

  for (const group of activeGroups) {
    const entry = entries.get(group.code);
    const before = selections.length;

    switch (group.type) {
      case 'SINGLE_CHOICE':
      case 'MULTI_CHOICE':
        evaluateChoice(group, entry, selections, issues);
        break;
      case 'TEXT':
        evaluateText(group, entry, selections, issues);
        break;
      case 'DATE':
        evaluateDate(group, entry, selections, issues);
        break;
      case 'FILE':
        evaluateFile(group, entry, files, selections, issues);
        break;
    }

    const filled = selections.length > before;
    if (group.exclusiveWithinStep && filled) {
      const list = filledByStep.get(group.stepKey) ?? [];
      list.push(group.code);
      filledByStep.set(group.stepKey, list);
    }
  }

  // exclusive steps: at most one filled; "required" means at least one of the step's groups is filled
  const stepsSeen = new Set<string>();
  for (const group of activeGroups.filter((g) => g.exclusiveWithinStep)) {
    if (stepsSeen.has(group.stepKey)) continue;
    stepsSeen.add(group.stepKey);
    const filled = filledByStep.get(group.stepKey) ?? [];
    if (filled.length > 1) {
      issues.push({ field: group.stepKey, code: 'CUSTOM_EXCLUSIVE', params: { stepKey: group.stepKey } });
    }
    const stepRequired = activeGroups.some((g) => g.exclusiveWithinStep && g.stepKey === group.stepKey && g.required);
    if (stepRequired && filled.length === 0) {
      issues.push({ field: group.stepKey, code: 'CUSTOM_REQUIRED', params: { groupCode: group.stepKey } });
    }
  }

  const priceDelta = selections.reduce((sum, s) => sum + s.priceDelta, 0);
  const ordered = [...selections].sort((a, b) => a.groupCode.localeCompare(b.groupCode) || (a.optionCode ?? '').localeCompare(b.optionCode ?? ''));
  const summary = buildSummary(activeGroups, selections);
  const configHash = sha256Hex(JSON.stringify(ordered.map((s) => [s.groupCode, s.optionCode, s.textValue, s.dateValue, s.artworkFileId])));

  return { ok: issues.length === 0, issues, selections, priceDelta, summary, configHash };
}

function pushRequired(group: GroupDef, issues: Issue[]) {
  // For exclusive groups "required" is satisfied by any sibling, handled by the caller below.
  issues.push({ field: group.code, code: 'CUSTOM_REQUIRED', params: { groupCode: group.code } });
}

function evaluateChoice(
  group: GroupDef,
  entry: { optionCodes?: string[]; text?: string; date?: string; artworkFileId?: string } | undefined,
  selections: ResolvedSelection[],
  issues: Issue[],
) {
  if (entry && (entry.text !== undefined || entry.date !== undefined || entry.artworkFileId !== undefined)) {
    issues.push({ field: group.code, code: 'CUSTOM_VALUE_NOT_ALLOWED', params: { groupCode: group.code } });
  }

  let codes = [...new Set(entry?.optionCodes ?? [])];
  if (codes.length === 0 && group.required) {
    const defaults = group.options.filter((o) => o.isDefault && o.active);
    if (group.type === 'SINGLE_CHOICE' && defaults.length === 1) codes = [defaults[0].code];
  }

  if (codes.length === 0) {
    if (group.required || group.minSelect > 0) pushRequired(group, issues);
    return;
  }
  if (group.type === 'SINGLE_CHOICE' && codes.length > 1) {
    issues.push({ field: group.code, code: 'CUSTOM_SINGLE_ONLY', params: { groupCode: group.code } });
    return;
  }
  const min = Math.max(group.minSelect, group.required ? 1 : 0);
  if (codes.length < min) issues.push({ field: group.code, code: 'CUSTOM_TOO_FEW', params: { groupCode: group.code, min } });
  if (group.maxSelect !== null && codes.length > group.maxSelect) {
    issues.push({ field: group.code, code: 'CUSTOM_TOO_MANY', params: { groupCode: group.code, max: group.maxSelect } });
  }

  for (const code of codes) {
    const option = group.options.find((o) => o.code === code);
    if (!option) {
      issues.push({ field: group.code, code: 'CUSTOM_UNKNOWN_OPTION', params: { groupCode: group.code, optionCode: code } });
      continue;
    }
    if (!option.active) {
      issues.push({ field: group.code, code: 'CUSTOM_OPTION_INACTIVE', params: { groupCode: group.code, optionCode: code } });
      continue;
    }
    selections.push({
      stepKey: group.stepKey,
      groupCode: group.code,
      groupType: group.type,
      groupName: group.name,
      optionCode: option.code,
      optionName: option.name,
      textValue: null,
      dateValue: null,
      artworkFileId: null,
      priceDelta: option.priceDelta,
    });
  }
}

function evaluateText(
  group: GroupDef,
  entry: { optionCodes?: string[]; text?: string; date?: string; artworkFileId?: string } | undefined,
  selections: ResolvedSelection[],
  issues: Issue[],
) {
  if (entry && (entry.optionCodes?.length || entry.date !== undefined || entry.artworkFileId !== undefined)) {
    issues.push({ field: group.code, code: 'CUSTOM_VALUE_NOT_ALLOWED', params: { groupCode: group.code } });
  }
  const raw = entry?.text;
  if (raw === undefined || normalizeText(raw) === '') {
    if (group.required && !group.exclusiveWithinStep) pushRequired(group, issues);
    return;
  }
  const { value, issues: textIssues } = validateText(raw, group);
  for (const i of textIssues) issues.push({ field: group.code, ...i, params: { groupCode: group.code, ...(i.params ?? {}) } });
  if (textIssues.length > 0) return;

  selections.push({
    stepKey: group.stepKey,
    groupCode: group.code,
    groupType: group.type,
    groupName: group.name,
    optionCode: null,
    optionName: null,
    textValue: value,
    dateValue: null,
    artworkFileId: null,
    priceDelta: group.priceDelta,
  });
}

function evaluateDate(
  group: GroupDef,
  entry: { optionCodes?: string[]; text?: string; date?: string; artworkFileId?: string } | undefined,
  selections: ResolvedSelection[],
  issues: Issue[],
) {
  if (entry && (entry.optionCodes?.length || entry.text !== undefined || entry.artworkFileId !== undefined)) {
    issues.push({ field: group.code, code: 'CUSTOM_VALUE_NOT_ALLOWED', params: { groupCode: group.code } });
  }
  const raw = entry?.date?.trim();
  if (!raw) {
    if (group.required && !group.exclusiveWithinStep) pushRequired(group, issues);
    return;
  }
  if (!isValidIsoDate(raw)) {
    issues.push({ field: group.code, code: 'CUSTOM_DATE_INVALID', params: { groupCode: group.code } });
    return;
  }
  selections.push({
    stepKey: group.stepKey,
    groupCode: group.code,
    groupType: group.type,
    groupName: group.name,
    optionCode: null,
    optionName: null,
    textValue: null,
    dateValue: raw,
    artworkFileId: null,
    priceDelta: group.priceDelta,
  });
}

function evaluateFile(
  group: GroupDef,
  entry: { optionCodes?: string[]; text?: string; date?: string; artworkFileId?: string } | undefined,
  files: Map<string, FileInfo>,
  selections: ResolvedSelection[],
  issues: Issue[],
) {
  if (entry && (entry.optionCodes?.length || entry.text !== undefined || entry.date !== undefined)) {
    issues.push({ field: group.code, code: 'CUSTOM_VALUE_NOT_ALLOWED', params: { groupCode: group.code } });
  }
  const id = entry?.artworkFileId;
  if (!id) {
    if (group.required && !group.exclusiveWithinStep) issues.push({ field: group.code, code: 'CUSTOM_FILE_REQUIRED', params: { groupCode: group.code } });
    return;
  }
  const file = files.get(id);
  const fail = (code: string, params: Record<string, unknown> = {}) => issues.push({ field: group.code, code, params: { groupCode: group.code, ...params } });

  if (!file || file.status === 'DELETED') return fail('CUSTOM_FILE_NOT_FOUND');
  if (!file.ownedByActor) return fail('CUSTOM_FILE_FORBIDDEN');
  if (file.status !== 'READY') return fail('CUSTOM_FILE_NOT_READY');
  if (file.groupId && file.groupId !== group.id) return fail('CUSTOM_FILE_WRONG_GROUP');

  const mimes = group.allowedMimeTypes.length > 0 ? group.allowedMimeTypes : DEFAULT_ARTWORK_MIME_TYPES;
  if (!mimes.includes(file.mimeType)) return fail('FILE_TYPE_NOT_ALLOWED');
  if (group.maxFileSizeBytes !== null && file.sizeBytes > group.maxFileSizeBytes) {
    return fail('FILE_TOO_LARGE', { maxMb: Math.round((group.maxFileSizeBytes / 1_048_576) * 10) / 10 });
  }
  if (file.widthPx !== null && file.heightPx !== null) {
    const { minWidthPx, minHeightPx, maxWidthPx, maxHeightPx } = group;
    if (
      (minWidthPx !== null && file.widthPx < minWidthPx) ||
      (minHeightPx !== null && file.heightPx < minHeightPx) ||
      (maxWidthPx !== null && file.widthPx > maxWidthPx) ||
      (maxHeightPx !== null && file.heightPx > maxHeightPx)
    ) {
      return fail('FILE_DIMENSIONS_INVALID');
    }
  }

  selections.push({
    stepKey: group.stepKey,
    groupCode: group.code,
    groupType: group.type,
    groupName: group.name,
    optionCode: null,
    optionName: null,
    textValue: null,
    dateValue: null,
    artworkFileId: file.id,
    priceDelta: group.priceDelta,
  });
}

/**
 * Compact spec in the same shape as the product document, e.g.
 * { purpose:'study', size:'A5', cover:'burgundy', paper:'dot_grid',
 *   personalization:{type:'initials', value:'TA'}, accessories:['bookmark','gold_charm'], packaging:'gift' }
 */
export function buildSummary(groups: GroupDef[], selections: ResolvedSelection[]): Record<string, unknown> {
  const summary: Record<string, unknown> = {};
  const exclusiveSteps = new Set(groups.filter((g) => g.exclusiveWithinStep).map((g) => g.stepKey));

  for (const sel of selections) {
    if (sel.groupType === 'SINGLE_CHOICE') {
      summary[sel.groupCode] = sel.optionCode;
    } else if (sel.groupType === 'MULTI_CHOICE') {
      const list = (summary[sel.groupCode] as string[] | undefined) ?? [];
      list.push(sel.optionCode as string);
      summary[sel.groupCode] = list;
    } else {
      const value = sel.textValue ?? sel.dateValue ?? sel.artworkFileId;
      if (exclusiveSteps.has(sel.stepKey)) summary[sel.stepKey] = { type: sel.groupCode, value };
      else summary[sel.groupCode] = value;
    }
  }
  return summary;
}

export function buildSnapshot(result: Pick<EvaluationResult, 'selections' | 'summary' | 'priceDelta'>): CustomizationSnapshot {
  return { version: 1, summary: result.summary, selections: result.selections, priceDelta: result.priceDelta };
}

/** Rebuilds a customizer input from a stored snapshot (used when a shopper edits personalization). */
export function snapshotToInput(snapshot: CustomizationSnapshot | null | undefined): CustomizationInput {
  const byGroup = new Map<string, { groupCode: string; optionCodes?: string[]; text?: string; date?: string; artworkFileId?: string }>();
  for (const s of snapshot?.selections ?? []) {
    const e = byGroup.get(s.groupCode) ?? { groupCode: s.groupCode };
    if (s.optionCode) e.optionCodes = [...(e.optionCodes ?? []), s.optionCode];
    if (s.textValue) e.text = s.textValue;
    if (s.dateValue) e.date = s.dateValue;
    if (s.artworkFileId) e.artworkFileId = s.artworkFileId;
    byGroup.set(s.groupCode, e);
  }
  return [...byGroup.values()];
}

/**
 * Keeps the CHOICE selections of `existing` and replaces the personalization groups (TEXT / DATE / FILE)
 * with `edits`. Edits that target a choice group (size, cover, ...) are reported in `illegalGroupCodes`
 * because changing them after ordering would change the price / production plan.
 */
export function applyPersonalizationEdit(
  groups: Array<Pick<GroupDef, 'code' | 'type'>>,
  existing: CustomizationInput,
  edits: CustomizationInput,
): { input: CustomizationInput; illegalGroupCodes: string[] } {
  const personalCodes = new Set(groups.filter((g) => g.type === 'TEXT' || g.type === 'DATE' || g.type === 'FILE').map((g) => g.code));
  const kept = existing.filter((e) => !personalCodes.has(e.groupCode));
  const replacement = edits.filter((e) => personalCodes.has(e.groupCode));
  const illegalGroupCodes = edits.filter((e) => !personalCodes.has(e.groupCode)).map((e) => e.groupCode);
  return { input: [...kept, ...replacement], illegalGroupCodes };
}
