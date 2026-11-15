import type {
  CarouselPage,
  DeviceState,
  ItemType,
  NextItem,
  NowTask,
  TodayRow,
} from "./deviceState";
import { canonicalJson, fnv1a64 } from "./deviceState";
import type { DeviceIcon } from "./deviceWording";
import type { FrameIcon } from "./frameIcons";
import { drawIcon } from "./frameIcons";
import { Canvas, Path, addCircle, addRoundRect } from "./frameRaster";
import type { Frame, Paint, Screen } from "./frameRaster";
import { breakLines, cleanText, drawLine, fitText, measure } from "./frameText";
import type { FaceName, Lines, TextStyle } from "./frameText";

export type { Frame, Screen } from "./frameRaster";

export const FRAME_RENDERER_VERSION = 2;

export const FRAME_PAGES: readonly CarouselPage[] = ["now", "today"];

export const DEFAULT_SCREEN: Screen = { width: 960, height: 680, greys: 4 };

const CANVAS = { width: 1194, height: 834 };

const MIN_TEXT_PX = 12;

const TAB_SEPARATOR = "  ·  ";

const MAX_PROGRESS_BOXES = 5;

const STRIP_LEAD = "Going out?";
const STRIP_ITEMS = "Wallet · Keys · Glasses · Phone";

const STYLES = {
  header: ["serifBold", 72, 105],
  date: ["serifMedium", 32, 120],
  tab: ["extraBold", 30, 120],
  nextLabel: ["bold", 30, 120],
  taskTitle: ["extraBold", 72, 110],
  stepTitle: ["extraBold", 64, 110],
  clearTitle: ["extraBold", 56, 115],
  taskDetail: ["regular", 40, 120],
  prompt: ["bold", 34, 120],
  keycap: ["extraBold", 32, 120],
  nextTitle: ["extraBold", 44, 115],
  nextTime: ["bold", 36, 120],
  initial: ["serifBold", 38, 121],
  rowTime: ["bold", 34, 120],
  rowLabel: ["semiBold", 36, 120],
  rowLabelNow: ["extraBold", 36, 120],
  stripLead: ["extraBold", 30, 130],
  stripItems: ["medium", 30, 130],
} as const satisfies Record<string, readonly [FaceName, number, number]>;

type StyleName = keyof typeof STYLES;

const MIN_SCALE = MIN_TEXT_PX / Math.min(...Object.values(STYLES).map(([, points]) => points));

export const DRAWABLE_SCREEN = {
  minWidth: Math.ceil(CANVAS.width * MIN_SCALE),
  minHeight: Math.ceil(CANVAS.height * MIN_SCALE),
  maxWidth: 2048,
  maxHeight: 2048,
};

export type NowView =
  | { kind: "clear"; allDone: boolean }
  | {
      kind: "task";
      tab: string;
      label: string;
      icon: FrameIcon | null;
      question: string;
      pillDescription: string | null;
      overdue: boolean;
    }
  | {
      kind: "steps";
      tab: string;
      steps: string[];
      step: number;
      overdue: boolean;
    };

export interface FrameNext {
  title: string;
  when: string;
  icon: DeviceIcon | null;
  initial: string | null;
}

export interface FrameRow {
  time: string;
  label: string;
  mark: TodayRow["mark"] | "later";
}

export type FrameModel = {
  header: string;
  date: string;
} & (
  | { page: "now"; now: NowView; next: FrameNext | null }
  | { page: "today"; rows: FrameRow[]; hidden: number }
);

const TYPE_WORDS: Record<ItemType, string> = {
  medication: "Medication",
  appointment: "Appointment",
  routine: "Routine",
  checklist: "Checklist",
  reminder: "Reminder",
  event: "Event",
};

function labelOr(text: string, type: ItemType): string {
  return cleanText(text) || TYPE_WORDS[type];
}

function dueNowTask(state: DeviceState): NowTask | null {
  const task = state.now.task;
  return task !== null && !task.early ? task : null;
}

function isSnoozed(state: DeviceState, task: NowTask): boolean {
  return state.cues.some((c) => c.instanceId === task.instanceId && c.snoozed);
}

function taskView(state: DeviceState, task: NowTask): NowView {
  const label = labelOr(task.label, task.type);
  const lead = isSnoozed(state, task) ? "Later" : task.overdue ? "Still to do" : "Now";
  if (task.steps !== null) {
    const steps = task.steps.map((s, i) => cleanText(s) || `Step ${i + 1}`);
    return {
      kind: "steps",
      tab: `${lead}${TAB_SEPARATOR}${label}`,
      steps,
      step: task.step?.index ?? 0,
      overdue: task.overdue,
    };
  }
  return {
    kind: "task",
    tab: `${lead}${TAB_SEPARATOR}${task.time}`,
    label,
    icon: task.overdue ? null : task.icon,
    question: task.question,
    pillDescription: task.pillDescription === null ? null : cleanText(task.pillDescription) || null,
    overdue: task.overdue,
  };
}

function nextView(next: NextItem): FrameNext {
  const initial = next.initial === null ? null : cleanText(next.initial) || null;
  return {
    title: labelOr(next.title, next.type),
    when: cleanText(next.when),
    icon: initial === null ? next.icon : null,
    initial,
  };
}

export function buildFrameModel(state: DeviceState, page: CarouselPage): FrameModel {
  const header = { header: cleanText(state.header), date: cleanText(state.fullDate) };
  const task = dueNowTask(state);
  if (page === "today") {
    const nowMark = task === null ? "none" : isSnoozed(state, task) ? "later" : "now";
    const rows = state.rows.map((r): FrameRow => ({
      time: r.time,
      label: labelOr(r.label, r.type),
      mark: r.mark === "now" ? nowMark : r.mark,
    }));
    return { ...header, page, rows, hidden: state.rowsHidden };
  }
  return {
    ...header,
    page,
    now: task !== null ? taskView(state, task) : { kind: "clear", allDone: state.now.allDone },
    next: state.nextUpAfterDue === null ? null : nextView(state.nextUpAfterDue),
  };
}

export function frameDoneInstance(state: DeviceState): string | null {
  return state.done !== null && !state.done.early ? state.done.instanceId : null;
}

export type FrameFormat = "png" | "packed";

export function frameEtag(
  model: FrameModel,
  screen: Screen,
  format: FrameFormat,
  renderer: number = FRAME_RENDERER_VERSION,
): string {
  const { width, height, greys } = screen;
  return fnv1a64(canonicalJson({ renderer, model, screen: { width, height, greys }, format }));
}

class Ruler {
  readonly scale: number;

  constructor(screen: Screen) {
    this.scale = Math.min(screen.width / CANVAS.width, screen.height / CANVAS.height);
  }

  u(points: number): number {
    return points * this.scale;
  }

  line(points: number): number {
    return Math.max(1, Math.round(points * this.scale));
  }

  text(name: StyleName): TextStyle {
    const [face, points, percent] = STYLES[name];
    const lineHeight = Math.round((points * percent) / 100);
    const size = points * this.scale;
    return { face, size, lineHeight: (lineHeight * size) / points };
  }
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Ctx {
  canvas: Canvas;
  r: Ruler;
}

function drawLines(
  ctx: Ctx,
  lines: string[],
  style: TextStyle,
  x: number,
  top: number,
  paint: Paint,
): number {
  lines.forEach((text, i) =>
    drawLine(ctx.canvas, text, style, x, top + i * style.lineHeight, paint),
  );
  return lines.length * style.lineHeight;
}

function oneLineIn(text: string, style: TextStyle, width: number): string {
  return breakLines(text, style, width, 1).lines[0] ?? "";
}

function drawHeader(ctx: Ctx, model: FrameModel, area: Rect): void {
  const { r } = ctx;
  const header = r.text("header");
  const date = r.text("date");
  let y = area.y;
  drawLine(ctx.canvas, oneLineIn(model.header, header, area.w), header, area.x, y, "ink");
  y += header.lineHeight + r.u(6);
  drawLine(ctx.canvas, oneLineIn(model.date, date, area.w), date, area.x, y, "ink");
  y += date.lineHeight + r.u(24);
  ctx.canvas.fillRect(area.x, y, area.w, r.line(6), "ink");
}

function drawStrip(ctx: Ctx, top: number, padX: number): void {
  const { canvas, r } = ctx;
  const rule = r.line(3);
  canvas.fillRect(0, top, canvas.width, rule, "ink");
  const lead = r.text("stripLead");
  const items = r.text("stripItems");
  const middle = (top + rule + canvas.height) / 2;
  const icon = r.u(40);
  drawIcon(canvas, "walk", padX, middle - icon / 2, icon, "ink");
  let x = padX + icon + r.u(16);
  x += drawLine(canvas, STRIP_LEAD, lead, x, middle - lead.lineHeight / 2, "ink");
  x += r.u(16);
  const room = canvas.width - padX - x;
  drawLine(
    canvas,
    oneLineIn(STRIP_ITEMS, items, room),
    items,
    x,
    middle - items.lineHeight / 2,
    "ink",
  );
}

function drawKeycap(ctx: Ctx, icon: FrameIcon, label: string, x: number, top: number): number {
  const { canvas, r } = ctx;
  const style = r.text("keycap");
  const border = r.line(3);
  const iconSize = r.u(28);
  const height = keycapHeight(r);
  const width = 2 * border + r.u(14) + iconSize + r.u(6) + measure(label, style) + r.u(18);
  const radius = r.u(12);
  canvas.fillPath(addRoundRect(new Path(), x, top, width, height, radius), "ink");
  canvas.fillPath(
    addRoundRect(
      new Path(),
      x + border,
      top + border,
      width - 2 * border,
      height - 2 * border,
      radius - border,
    ),
    "paper",
  );
  const middle = top + height / 2;
  const iconX = x + border + r.u(14);
  drawIcon(canvas, icon, iconX, middle - iconSize / 2, iconSize, "ink");
  drawLine(canvas, label, style, iconX + iconSize + r.u(6), middle - style.lineHeight / 2, "ink");
  return width;
}

function keycapHeight(r: Ruler): number {
  return 2 * r.line(3) + 2 * r.u(6) + Math.max(r.text("keycap").lineHeight, r.u(28));
}

interface Prompt {
  question: string;
  icon: FrameIcon;
  key: string;
}

function taskPrompts(question: string, overdue: boolean): Prompt[] {
  const prompts: Prompt[] = [{ question, icon: "checkmark", key: "Done" }];
  if (overdue) prompts.push({ question: "Not sure?", icon: "mic", key: "Talk" });
  return prompts;
}

function promptsTopIn(r: Ruler, inner: Rect, count: number): number {
  const height = r.line(3) + r.u(24) + count * keycapHeight(r) + (count - 1) * r.u(16);
  return inner.y + inner.h - height;
}

function drawPrompts(ctx: Ctx, prompts: Prompt[], inner: Rect): number {
  const { canvas, r } = ctx;
  const top = promptsTopIn(r, inner, prompts.length);
  const rule = r.line(3);
  canvas.fillRect(inner.x, top, inner.w, rule, "ink");
  const style = r.text("prompt");
  const keyHeight = keycapHeight(r);
  prompts.forEach((p, i) => {
    const y = top + rule + r.u(24) + i * (keyHeight + r.u(16));
    const words = `${p.question} Press`;
    const width = drawLine(
      canvas,
      words,
      style,
      inner.x,
      y + (keyHeight - style.lineHeight) / 2,
      "ink",
    );
    drawKeycap(ctx, p.icon, p.key, inner.x + width + r.u(16), y);
  });
  return top;
}

function fitTitle(
  text: string,
  style: TextStyle,
  minScale: number,
  maxWidth: number,
  maxLines: number,
  maxHeight: number,
): { style: TextStyle } & Lines {
  const fitted = fitText(text, style, minScale, maxWidth, maxLines);
  if (fitted.lines.length * fitted.style.lineHeight <= maxHeight) return fitted;
  const floor = Math.min(1, MIN_TEXT_PX / style.size);
  for (let step = 0; ; step += 1) {
    const scale = Math.max(floor, minScale - step * 0.05);
    const sized = { ...style, size: style.size * scale, lineHeight: style.lineHeight * scale };
    const lines = Math.max(1, Math.min(maxLines, Math.floor(maxHeight / sized.lineHeight)));
    const broken = breakLines(text, sized, maxWidth, lines);
    const fits = broken.lines.length * sized.lineHeight <= maxHeight;
    if ((fits && !broken.truncated) || scale <= floor) return { style: sized, ...broken };
  }
}

function drawTaskContent(ctx: Ctx, card: Extract<NowView, { kind: "task" }>, inner: Rect): void {
  const { canvas, r } = ctx;
  const prompts = taskPrompts(card.question, card.overdue);
  const room = promptsTopIn(r, inner, prompts.length) - r.u(24) - inner.y;
  const detail = r.text("taskDetail");
  const titleStyle = r.text("taskTitle");
  const first = fitText(card.label, titleStyle, 0.7, inner.w, 2);
  const pillAll =
    card.pillDescription === null
      ? 0
      : breakLines(card.pillDescription, detail, inner.w, 2).lines.length;
  const stackHeight = (icon: boolean, pillLines: number, titleHeight: number): number =>
    (icon ? r.u(64) + r.u(12) : 0) +
    titleHeight +
    (pillLines > 0 ? r.u(12) + pillLines * detail.lineHeight : 0);
  const firstHeight = first.lines.length * first.style.lineHeight;
  const showIcon = card.icon !== null && stackHeight(true, pillAll, firstHeight) <= room;
  const pillLines = [pillAll, Math.min(1, pillAll), 0].find(
    (lines) => stackHeight(showIcon, lines, firstHeight) <= room,
  );
  const title =
    pillLines === undefined
      ? fitTitle(card.label, titleStyle, 0.7, inner.w, 2, room - stackHeight(showIcon, 0, 0))
      : first;
  let y = inner.y;
  if (showIcon && card.icon !== null) {
    drawIcon(canvas, card.icon, inner.x, y, r.u(64), "ink");
    y += r.u(64) + r.u(12);
  }
  y += drawLines(ctx, title.lines, title.style, inner.x, y, "ink");
  if (card.pillDescription !== null && pillLines !== undefined && pillLines > 0) {
    const pill = breakLines(card.pillDescription, detail, inner.w, pillLines);
    drawLines(ctx, pill.lines, detail, inner.x, y + r.u(12), "ink");
  }
  drawPrompts(ctx, prompts, inner);
}

function drawStepContent(ctx: Ctx, card: Extract<NowView, { kind: "steps" }>, inner: Rect): void {
  const { steps, step } = card;
  const { canvas, r } = ctx;
  const counterStyle = r.text("prompt");
  const boxSize = r.u(52);
  const showBoxes = steps.length <= MAX_PROGRESS_BOXES;
  const rowHeight = showBoxes ? boxSize : counterStyle.lineHeight;
  let x = inner.x;
  if (showBoxes) {
    const by = Math.round(inner.y);
    const size = Math.round(boxSize);
    steps.forEach((_, i) => {
      const bx = Math.round(x);
      if (i < step) {
        canvas.fillRect(bx, by, size, size, "ink");
        const check = r.u(32);
        drawIcon(
          canvas,
          "checkmark",
          bx + (size - check) / 2,
          by + (size - check) / 2,
          check,
          "paper",
          "ink",
        );
      } else {
        canvas.strokeRect(bx, by, size, size, r.line(i === step ? 6 : 3), "ink");
      }
      x += boxSize + r.u(12);
    });
  }
  const counter = `Step ${step + 1} of ${steps.length}`;
  drawLine(
    canvas,
    counter,
    counterStyle,
    x,
    inner.y + (rowHeight - counterStyle.lineHeight) / 2,
    "ink",
  );
  const titleTop = inner.y + rowHeight + r.u(12) + r.u(12);
  const prompts = taskPrompts("Finished?", card.overdue);
  const room = promptsTopIn(r, inner, prompts.length) - r.u(24) - titleTop;
  const title = fitTitle(steps[step] ?? "", r.text("stepTitle"), 0.7, inner.w, 3, room);
  drawLines(ctx, title.lines, title.style, inner.x, titleTop, "ink");
  drawPrompts(ctx, prompts, inner);
}

function drawClearContent(ctx: Ctx, allDone: boolean, inner: Rect): void {
  const { canvas, r } = ctx;
  let y = inner.y;
  if (allDone) {
    drawIcon(canvas, "checkmark", inner.x, y, r.u(64), "ink");
    y += r.u(64) + r.u(12);
  }
  const style = r.text("clearTitle");
  const text = allDone ? "Everything is done." : "Nothing to do right now.";
  const lines = Math.max(1, Math.floor((inner.y + inner.h - y) / style.lineHeight));
  drawLines(ctx, breakLines(text, style, inner.w, lines).lines, style, inner.x, y, "ink");
}

function drawTab(
  ctx: Ctx,
  text: string,
  x: number,
  top: number,
  padY: number,
  padX: number,
  maxWidth: number,
): Rect {
  const { canvas, r } = ctx;
  const style = r.text("tab");
  const words = oneLineIn(text, style, maxWidth - 2 * r.u(padX));
  const size = tabSize(ctx, words, padY, padX);
  const w = Math.min(maxWidth, size.w);
  canvas.fillRect(x, top, w, size.h, "ink");
  drawLine(canvas, words, style, x + r.u(padX), top + r.u(padY), "paper");
  return { x, y: top, w, h: size.h };
}

function tabSize(ctx: Ctx, words: string, padY: number, padX: number): { w: number; h: number } {
  const { r } = ctx;
  const style = r.text("tab");
  return { w: measure(words, style) + 2 * r.u(padX), h: style.lineHeight + 2 * r.u(padY) };
}

function drawNowBody(ctx: Ctx, model: Extract<FrameModel, { page: "now" }>, body: Rect): void {
  const { canvas, r } = ctx;
  const { box, inner, border } = cardGeometry(r, body);
  drawTab(ctx, model.now.kind === "clear" ? "Now" : model.now.tab, body.x, body.y, 8, 20, box.w);
  canvas.strokeRect(box.x, box.y, box.w, box.h, border, "ink");
  const now = model.now;
  if (now.kind === "clear") drawClearContent(ctx, now.allDone, inner);
  else if (now.kind === "steps") drawStepContent(ctx, now, inner);
  else drawTaskContent(ctx, now, inner);
  const nextX = body.x + box.w + r.u(32);
  if (model.next !== null) {
    drawNextCard(ctx, model.next, { x: nextX, y: body.y, w: body.x + body.w - nextX, h: body.h });
  }
}

function cardGeometry(r: Ruler, body: Rect): { box: Rect; inner: Rect; border: number } {
  const tabHeight = r.text("tab").lineHeight + 2 * r.u(8);
  const box = { x: body.x, y: body.y + tabHeight, w: r.u(600), h: body.h - tabHeight };
  const border = r.line(6);
  const inner = {
    x: box.x + border + r.u(36),
    y: box.y + border + r.u(36),
    w: box.w - 2 * border - 2 * r.u(36),
    h: box.h - 2 * border - r.u(36) - r.u(32),
  };
  return { box, inner, border };
}

function pageGeometry(r: Ruler, screen: Screen): { body: Rect; stripTop: number; padX: number } {
  const padX = r.u(48);
  const stripTop = screen.height - r.u(100);
  let headerBottom = r.u(28);
  headerBottom += r.text("header").lineHeight + r.u(6);
  headerBottom += r.text("date").lineHeight + r.u(24);
  const bodyTop = headerBottom + r.line(6) + r.u(28);
  const body = {
    x: padX,
    y: bodyTop,
    w: screen.width - 2 * padX,
    h: stripTop - r.u(28) - bodyTop,
  };
  return { body, stripTop, padX };
}

export function nowCardGeometry(
  screen: Screen,
  promptLines: number,
): { box: Rect; inner: Rect; promptsTop: number } {
  const r = new Ruler(screen);
  const { box, inner } = cardGeometry(r, pageGeometry(r, screen).body);
  return { box, inner, promptsTop: promptsTopIn(r, inner, promptLines) };
}

function drawNextCard(ctx: Ctx, item: FrameNext, column: Rect): void {
  const { canvas, r } = ctx;
  const label = r.text("nextLabel");
  drawLine(canvas, "Next up", label, column.x, column.y + r.u(8), "ink");
  const top = column.y + label.lineHeight + 2 * r.u(8);
  const border = r.line(3);
  const avatar = r.u(72);
  const textX = column.x + border + r.u(28) + avatar + r.u(18);
  const textWidth = column.x + column.w - border - r.u(28) - textX;
  const titleStyle = r.text("nextTitle");
  const whenStyle = r.text("nextTime");
  const title: Lines = breakLines(item.title, titleStyle, textWidth, 2);
  const when = oneLineIn(item.when, whenStyle, textWidth);
  const textHeight = title.lines.length * titleStyle.lineHeight + r.u(2) + whenStyle.lineHeight;
  const innerHeight = Math.max(avatar, textHeight);
  const boxHeight = 2 * border + 2 * r.u(32) + innerHeight;
  canvas.strokeRect(column.x, top, column.w, boxHeight, border, "ink");
  const middle = top + boxHeight / 2;
  const cx = column.x + border + r.u(28) + avatar / 2;
  canvas.fillPath(addCircle(new Path(), cx, middle, avatar / 2), "ink");
  canvas.fillPath(addCircle(new Path(), cx, middle, avatar / 2 - border), "paper");
  if (item.initial !== null) {
    const style = r.text("initial");
    const w = measure(item.initial, style);
    drawLine(canvas, item.initial, style, cx - w / 2, middle - style.lineHeight / 2, "ink");
  } else if (item.icon !== null) {
    const size = r.u(36);
    drawIcon(canvas, item.icon, cx - size / 2, middle - size / 2, size, "ink");
  }
  const textTop = middle - textHeight / 2;
  const titleHeight = drawLines(ctx, title.lines, titleStyle, textX, textTop, "ink");
  drawLine(canvas, when, whenStyle, textX, textTop + titleHeight + r.u(2), "ink");
}

function drawTodayBody(ctx: Ctx, model: Extract<FrameModel, { page: "today" }>, body: Rect): void {
  const { canvas, r } = ctx;
  const rowHeight = r.u(70);
  const pad = r.u(20);
  const timeStyle = r.text("rowTime");
  const timeWidth = r.u(150);
  const labelX = body.x + pad + timeWidth + r.u(24);
  const lineTop = (row: number, style: TextStyle): number =>
    body.y + row * rowHeight + (rowHeight - style.lineHeight) / 2;
  model.rows.forEach((row, i) => {
    const y = body.y + i * rowHeight;
    const tagText = row.mark === "now" ? "Now" : row.mark === "later" ? "Later" : null;
    const grey = row.mark === "done" || row.mark === "missed" || row.mark === "past";
    const paint: Paint = grey ? "grey" : "ink";
    const labelStyle = r.text(tagText !== null ? "rowLabelNow" : "rowLabel");
    let right = body.x + body.w - pad;
    if (tagText !== null) {
      canvas.strokeRect(body.x, y, body.w, rowHeight, r.line(5), "ink");
      const tag = tabSize(ctx, tagText, 4, 16);
      drawTab(ctx, tagText, right - tag.w, y + (rowHeight - tag.h) / 2, 4, 16, tag.w);
      right -= tag.w + r.u(24);
    } else if (row.mark === "done") {
      const check = r.u(30);
      drawIcon(canvas, "checkmark", right - check, y + (rowHeight - check) / 2, check, "grey");
      right -= check + r.u(24);
    }
    drawLine(
      canvas,
      oneLineIn(row.time, timeStyle, timeWidth),
      timeStyle,
      body.x + pad,
      lineTop(i, timeStyle),
      paint,
    );
    const label = oneLineIn(row.label, labelStyle, right - labelX);
    drawLine(canvas, label, labelStyle, labelX, lineTop(i, labelStyle), paint);
  });
  const style = r.text("rowLabel");
  const last = model.rows.length;
  if (model.hidden > 0) {
    drawLine(
      canvas,
      `And ${model.hidden} more later`,
      style,
      body.x + pad,
      lineTop(last, style),
      "grey",
    );
  } else if (last === 0) {
    drawLine(canvas, "Nothing planned today.", style, body.x + pad, lineTop(0, style), "ink");
  }
}

export function drawFrame(model: FrameModel, screen: Screen): Frame {
  const canvas = new Canvas(screen);
  const r = new Ruler(screen);
  const ctx = { canvas, r };
  const { body, stripTop, padX } = pageGeometry(r, screen);
  drawHeader(ctx, model, { x: padX, y: r.u(28), w: body.w, h: 0 });
  if (model.page === "now") drawNowBody(ctx, model, body);
  else drawTodayBody(ctx, model, body);
  drawStrip(ctx, stripTop, padX);
  return canvas.toFrame();
}

export function renderFrame(state: DeviceState, screen: Screen, page: CarouselPage): Frame {
  return drawFrame(buildFrameModel(state, page), screen);
}

export function isDrawableScreen(screen: Screen): boolean {
  const { width, height, greys } = screen;
  return (
    Number.isInteger(width) &&
    Number.isInteger(height) &&
    Number.isInteger(greys) &&
    width >= DRAWABLE_SCREEN.minWidth &&
    width <= DRAWABLE_SCREEN.maxWidth &&
    height >= DRAWABLE_SCREEN.minHeight &&
    height <= DRAWABLE_SCREEN.maxHeight &&
    greys >= 2 &&
    greys <= 256
  );
}
