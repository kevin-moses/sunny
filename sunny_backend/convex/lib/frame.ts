// lib/frame.ts
// Purpose: The server-drawn frames of the e-ink home display: a pure function from a device
// state (lib/deviceState.ts), a screen ({ width, height, greys }, as the device reported it on
// PUT /device/info) and a page ("now" or "today", the carousel's pages) to a grey-level frame
// (lib/frameRaster.ts), which lib/framePng.ts and lib/framePacked.ts encode. GET /device/frame
// (deviceApi.ts) serves it. Nothing here reads a clock: the frame depends only on its inputs.
//
// Two steps. buildFrameModel picks what the page shows (the words, marks and icons, already
// cleaned for drawing); its JSON, the screen, the format and FRAME_RENDERER_VERSION make the
// frame's ETag (frameEtag), so a device polling an unchanged screen costs no drawing. drawFrame
// then lays the model out and draws it.
//
// The design is the iPad's (sunny_app/src/display/DisplayParts.tsx and theme.ts, drawn at a
// 1194 x 834 point canvas): an orientation header (day and part of day, the date with the year,
// a thick rule), the page body, and the going-out strip ("Going out?  Wallet · Keys · Glasses ·
// Phone") at the bottom. Now page: the Now card (black tab, thick box: icon, title, pill
// description and "Taken them? Press [Done]", with "Not sure? Press [Talk]" once overdue; one
// step of a multi-step task with its progress boxes; or "Nothing to do right now." / "Everything
// is done.") beside Next up (a circle with the visitor's initial or an icon, the title, when).
// Today page: one row per task or event, the Now task boxed and tagged, finished rows grey with
// a check, missed rows grey without one, "And N more later" when the state left rows out.
// Layout: every size is the design's points times one scale, s = min(width / 1194, height /
// 834); the space a different aspect ratio leaves goes to the parts that stretch on the iPad
// (the Next up column, the row labels, the body), so any reported size from 478 x 334 (where
// the smallest text reaches MIN_TEXT_PX) to 2048 x 2048 works. Rows are exactly the state's
// rows (its own overflow rule chose them; seven rows of 70 points fit the 500-point body).
//
// Rules of the wall display that differ from the device state:
// - The state makes a task inside its early hour the Now task (early: true, the phone's rule).
//   The wall display offers Done only for a task that is due, so an early task is drawn as
//   upcoming: the Now card is clear ("Nothing to do right now."), its row is plain, and it is
//   Next up unless an event today comes before it.
// - A snoozed Now task (the senior said "not yet") keeps its card; its tab reads "Later · 8:00".
//   The iPad writes that one time with AM or PM; the state carries only the clock form.
// - A multi-step task's current step lives on the device until the backend tracks steps; the
//   frame shows the step it is given (the first by default).
// Where the Now card's parts do not all fit its box (a two-line title and a two-line pill
// description), the icon goes first, then the description's second line, so nothing is clipped.
//
// Last modified: 2026-11-14

import type { CarouselPage, DeviceState, NextItem, NowTask, TodayRow } from "./deviceState";
import { canonicalJson, fnv1a64 } from "./deviceState";
import type { FrameIcon } from "./frameIcons";
import { drawIcon } from "./frameIcons";
import { Canvas, Path, addCircle, addRoundRect } from "./frameRaster";
import type { Frame, Paint, Screen } from "./frameRaster";
import { breakLines, cleanText, drawLine, fitText, measure } from "./frameText";
import type { FaceName, Lines, TextStyle } from "./frameText";

export type { Frame, Screen } from "./frameRaster";

/** Change whenever a drawing change should make every device fetch its frames again. */
export const FRAME_RENDERER_VERSION = 1;

/** The pages a frame can show (the carousel's pages, lib/deviceState.ts deviceTuning). */
export const FRAME_PAGES: readonly CarouselPage[] = ["now", "today"];

/** The screen of a device that has not reported one: the 13.3 inch Waveshare panel. */
export const DEFAULT_SCREEN: Screen = { width: 960, height: 680, greys: 4 };

/** The design canvas (points) every size below is given in (sunny_app/src/display/theme.ts). */
const CANVAS = { width: 1194, height: 834 };

/**
 * Smallest text drawn, in pixels: the design's smallest text style may not scale below it,
 * which sets the smallest screen frames are drawn for (DRAWABLE_SCREEN).
 */
const MIN_TEXT_PX = 12;

/** What separates the parts of a tab ("Now  ·  8:00"). */
const TAB_SEPARATOR = "  ·  ";

/** Up to this many steps get progress boxes; longer tasks show only "Step 2 of 7". */
const MAX_PROGRESS_BOXES = 5;

/** The going-out strip's words. */
const STRIP_LEAD = "Going out?";
const STRIP_ITEMS = "Wallet · Keys · Glasses · Phone";

/** The design's text styles: face, size in points, line height as a percentage. */
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

/** A style name. */
type StyleName = keyof typeof STYLES;

/** The smallest scale drawn: the smallest design text (30 points) at MIN_TEXT_PX. */
const MIN_SCALE = MIN_TEXT_PX / Math.min(...Object.values(STYLES).map(([, points]) => points));

/**
 * The screens frames are drawn for (others are refused): at least MIN_SCALE times the design
 * canvas on each side (478 x 334), so every text is at least MIN_TEXT_PX and nothing collides,
 * and at most 2048 x 2048, which keeps a frame's buffers well inside an isolate's memory.
 */
export const DRAWABLE_SCREEN = {
  minWidth: Math.ceil(CANVAS.width * MIN_SCALE),
  minHeight: Math.ceil(CANVAS.height * MIN_SCALE),
  maxWidth: 2048,
  maxHeight: 2048,
};

/** The Now card as the wall display draws it. */
export type NowView =
  | { kind: "clear"; allDone: boolean }
  | {
      kind: "task";
      /** "Now  ·  8:00", "Still to do  ·  8:00", "Later  ·  8:00" or the lead and the label. */
      tab: string;
      label: string;
      icon: FrameIcon;
      /** "Taken them?" or "Finished?". */
      question: string;
      pillDescription: string | null;
      /** Adds "Not sure? Press [Talk]" and drops the icon. */
      overdue: boolean;
      /** Two or more steps, or null. */
      steps: string[] | null;
      /** The step shown (0-based, within steps). */
      step: number;
    };

/** Everything one page draws. */
export type FrameModel = {
  header: string;
  date: string;
} & (
  | { page: "now"; now: NowView; next: NextItem | null }
  | { page: "today"; rows: TodayRow[]; hidden: number }
);

/**
 * purpose: Whether the state's Now task is one the wall display draws as Now: due (not inside
 *          its early hour).
 * @param state: (DeviceState) The state.
 * @return: (NowTask | null) The task, or null when the card is clear or the task is early.
 */
function dueNowTask(state: DeviceState): NowTask | null {
  const task = state.now.task;
  return task !== null && !task.early ? task : null;
}

/**
 * purpose: The Now card of a due task.
 * @param state: (DeviceState) The state (for the task's snooze).
 * @param task: (NowTask) The task.
 * @param step: (number) The step to show of a multi-step task.
 * @return: (NowView) The card.
 */
function taskView(state: DeviceState, task: NowTask, step: number): NowView {
  const snoozed = state.cues.some((c) => c.instanceId === task.instanceId && c.snoozed);
  const steps = task.steps === null ? null : task.steps.map(cleanText);
  const label = cleanText(task.label);
  const lead = snoozed ? "Later" : task.overdue ? "Still to do" : "Now";
  return {
    kind: "task",
    tab: `${lead}${TAB_SEPARATOR}${steps !== null ? label : task.time}`,
    label,
    icon: task.icon,
    question: task.question,
    pillDescription: task.pillDescription === null ? null : cleanText(task.pillDescription),
    overdue: task.overdue,
    steps,
    step: steps === null ? 0 : Math.max(0, Math.min(Math.floor(step), steps.length - 1)),
  };
}

/**
 * purpose: Next up while the state's Now task is early: the state skipped that task, so it is
 *          Next up itself unless the state's Next up is an event today that comes before it in
 *          the day's order (found among the rows, which are in that order).
 * @param state: (DeviceState) The state.
 * @param task: (NowTask) The early task.
 * @return: (NextItem) The item.
 */
function nextBeforeEarly(state: DeviceState, task: NowTask): NextItem {
  const own: NextItem = { title: task.label, when: task.time, icon: task.icon, initial: null };
  const next = state.nextUp;
  if (next === null) return own;
  const taskRow = state.rows.findIndex((r) => r.key === `task-${task.instanceId}`);
  const eventRow = state.rows.findIndex(
    (r) => r.key.startsWith("event-") && r.label === next.title && r.time === next.when,
  );
  return eventRow !== -1 && (taskRow === -1 || eventRow < taskRow) ? next : own;
}

/**
 * purpose: What a page shows, decided from the state (the wall display's rules above).
 * @param state: (DeviceState) The device state.
 * @param page: (CarouselPage) The page.
 * @param step: (number, optional) The step of a multi-step Now task to show (default 0).
 * @return: (FrameModel) The model.
 */
export function buildFrameModel(state: DeviceState, page: CarouselPage, step = 0): FrameModel {
  const header = { header: cleanText(state.header), date: cleanText(state.fullDate) };
  const task = dueNowTask(state);
  if (page === "today") {
    const rows = state.rows.map((r) => ({
      ...r,
      label: cleanText(r.label),
      mark: r.mark === "now" && task === null ? ("none" as const) : r.mark,
    }));
    return { ...header, page, rows, hidden: state.rowsHidden };
  }
  const early = state.now.task !== null && task === null ? state.now.task : null;
  const next = early !== null ? nextBeforeEarly(state, early) : state.nextUp;
  return {
    ...header,
    page,
    now:
      task !== null ? taskView(state, task, step) : { kind: "clear", allDone: state.now.allDone },
    next:
      next === null
        ? null
        : {
            ...next,
            title: cleanText(next.title),
            when: cleanText(next.when),
            initial: next.initial === null ? null : cleanText(next.initial) || null,
          },
  };
}

/** The output encodings of a frame. */
export type FrameFormat = "png" | "packed";

/**
 * purpose: The entity tag of a frame: a hash of everything the bytes depend on (the page's
 *          model, the screen, the encoding and the renderer version), so it changes exactly
 *          when the frame can.
 * @param model: (FrameModel) The page's model.
 * @param screen: (Screen) The screen.
 * @param format: (FrameFormat) The encoding.
 * @param renderer: (number, optional) The renderer version (default FRAME_RENDERER_VERSION).
 * @return: (string) 16 hex characters.
 */
export function frameEtag(
  model: FrameModel,
  screen: Screen,
  format: FrameFormat,
  renderer: number = FRAME_RENDERER_VERSION,
): string {
  const { width, height, greys } = screen;
  return fnv1a64(canonicalJson({ renderer, model, screen: { width, height, greys }, format }));
}

/** Sizes on one screen: design points to pixels. */
class Ruler {
  readonly scale: number;

  /**
   * purpose: The ruler of a screen.
   * @param screen: (Screen) The screen.
   */
  constructor(screen: Screen) {
    this.scale = Math.min(screen.width / CANVAS.width, screen.height / CANVAS.height);
  }

  /**
   * purpose: A length in pixels (fractional).
   * @param points: (number) Design points.
   * @return: (number) Pixels.
   */
  u(points: number): number {
    return points * this.scale;
  }

  /**
   * purpose: A rule or border width in whole pixels, at least one.
   * @param points: (number) Design points.
   * @return: (number) Pixels.
   */
  line(points: number): number {
    return Math.max(1, Math.round(points * this.scale));
  }

  /**
   * purpose: A text style in pixels: the design size and line height scaled (at least
   *          MIN_TEXT_PX on every drawable screen).
   * @param name: (StyleName) The design style.
   * @return: (TextStyle) The style.
   */
  text(name: StyleName): TextStyle {
    const [face, points, percent] = STYLES[name];
    const lineHeight = Math.round((points * percent) / 100);
    const size = points * this.scale;
    return { face, size, lineHeight: (lineHeight * size) / points };
  }
}

/** A rectangle in pixels. */
interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** What drawing a page needs. */
interface Ctx {
  canvas: Canvas;
  r: Ruler;
}

/**
 * purpose: Draw lines of text one under another.
 * @param ctx: (Ctx) Canvas and ruler.
 * @param lines: (string[]) The lines.
 * @param style: (TextStyle) The style.
 * @param x: (number) Left.
 * @param top: (number) Top of the first line box.
 * @param paint: (Paint) The paint.
 * @return: (number) The height drawn.
 */
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

/**
 * purpose: One line of text cut to a width with "…" when it is too long.
 * @param text: (string) The text.
 * @param style: (TextStyle) The style.
 * @param width: (number) Width in pixels.
 * @return: (string) The line.
 */
function oneLineIn(text: string, style: TextStyle, width: number): string {
  return breakLines(text, style, width, 1).lines[0] ?? "";
}

/**
 * purpose: Draw the orientation header (day and part of day, the date line, the rule below).
 * @param ctx: (Ctx) Canvas and ruler.
 * @param model: (FrameModel) The model.
 * @param area: (Rect) The content area (its top is the header's top).
 * @return: (number) The header's bottom (below the rule).
 */
function drawHeader(ctx: Ctx, model: FrameModel, area: Rect): number {
  const { r } = ctx;
  const header = r.text("header");
  const date = r.text("date");
  let y = area.y;
  drawLine(ctx.canvas, oneLineIn(model.header, header, area.w), header, area.x, y, "ink");
  y += header.lineHeight + r.u(6);
  drawLine(ctx.canvas, oneLineIn(model.date, date, area.w), date, area.x, y, "ink");
  y += date.lineHeight + r.u(24);
  const rule = r.line(6);
  ctx.canvas.fillRect(area.x, y, area.w, rule, "ink");
  return y + rule;
}

/**
 * purpose: Draw the going-out strip across the bottom: a rule, the walking figure, "Going out?"
 *          and the items. Nothing on it looks pressable.
 * @param ctx: (Ctx) Canvas and ruler.
 * @param top: (number) The strip's top (its rule).
 * @param padX: (number) The page's side margin.
 * @return: (void)
 */
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

/**
 * purpose: Draw a keycap: an outlined, rounded key with a symbol and a word, pointing at a
 *          physical key ("[check Done]"). Not pressable.
 * @param ctx: (Ctx) Canvas and ruler.
 * @param icon: (FrameIcon) The symbol.
 * @param label: (string) The word.
 * @param x: (number) Left.
 * @param top: (number) Top.
 * @return: (number) The keycap's width.
 */
function drawKeycap(ctx: Ctx, icon: FrameIcon, label: string, x: number, top: number): number {
  const { canvas, r } = ctx;
  const style = r.text("keycap");
  const border = r.line(3);
  const iconSize = r.u(28);
  const height = keycapHeight(ctx);
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

/**
 * purpose: The keycap's height.
 * @param ctx: (Ctx) Canvas and ruler.
 * @return: (number) Pixels.
 */
function keycapHeight(ctx: Ctx): number {
  const { r } = ctx;
  return 2 * r.line(3) + 2 * r.u(6) + Math.max(r.text("keycap").lineHeight, r.u(28));
}

/** A prompt line: the words before "Press" and the key drawn after it. */
interface Prompt {
  question: string;
  icon: FrameIcon;
  key: string;
}

/**
 * purpose: The height of the prompts block (a rule, then one line per prompt).
 * @param ctx: (Ctx) Canvas and ruler.
 * @param count: (number) Prompt lines.
 * @return: (number) Pixels.
 */
function promptsHeight(ctx: Ctx, count: number): number {
  const { r } = ctx;
  return r.line(3) + r.u(24) + count * keycapHeight(ctx) + (count - 1) * r.u(16);
}

/**
 * purpose: Draw the prompts block at the bottom of the Now card's inside.
 * @param ctx: (Ctx) Canvas and ruler.
 * @param prompts: (Prompt[]) The lines.
 * @param inner: (Rect) The card's inside.
 * @return: (number) The block's top.
 */
function drawPrompts(ctx: Ctx, prompts: Prompt[], inner: Rect): number {
  const { canvas, r } = ctx;
  const top = inner.y + inner.h - promptsHeight(ctx, prompts.length);
  const rule = r.line(3);
  canvas.fillRect(inner.x, top, inner.w, rule, "ink");
  const style = r.text("prompt");
  const keyHeight = keycapHeight(ctx);
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

/**
 * purpose: Draw a one-step task's card inside: icon, title (up to two lines, shrinking to 70%),
 *          pill description (up to two lines) and the prompts. When they do not all fit, the
 *          icon is left out first, then the description's second line.
 * @param ctx: (Ctx) Canvas and ruler.
 * @param card: (Extract<NowView, { kind: "task" }>) The card.
 * @param inner: (Rect) The card's inside.
 * @return: (void)
 */
function drawTaskContent(ctx: Ctx, card: Extract<NowView, { kind: "task" }>, inner: Rect): void {
  const { canvas, r } = ctx;
  const prompts: Prompt[] = [{ question: card.question, icon: "checkmark", key: "Done" }];
  if (card.overdue) prompts.push({ question: "Not sure?", icon: "mic", key: "Talk" });
  const room = inner.h - promptsHeight(ctx, prompts.length) - r.u(24);
  const detail = r.text("taskDetail");
  const title = fitText(card.label, r.text("taskTitle"), 0.7, inner.w, 2);
  const pillCount =
    card.pillDescription === null
      ? 0
      : breakLines(card.pillDescription, detail, inner.w, 2).lines.length;
  /**
   * purpose: The stack's height for a choice of icon and pill description lines.
   * @param icon: (boolean) The icon is drawn.
   * @param pillLines: (number) Most lines of the pill description.
   * @return: (number) Pixels.
   */
  const stackHeight = (icon: boolean, pillLines: number): number => {
    const pill =
      card.pillDescription === null
        ? 0
        : r.u(12) + Math.min(pillLines, pillCount) * detail.lineHeight;
    return (icon ? r.u(64) + r.u(12) : 0) + title.lines.length * title.style.lineHeight + pill;
  };
  const showIcon = !card.overdue && stackHeight(true, 2) <= room;
  const pillLines = stackHeight(showIcon, 2) <= room ? 2 : 1;
  let y = inner.y;
  if (showIcon) {
    drawIcon(canvas, card.icon, inner.x, y, r.u(64), "ink");
    y += r.u(64) + r.u(12);
  }
  y += drawLines(ctx, title.lines, title.style, inner.x, y, "ink");
  if (card.pillDescription !== null) {
    const pill = breakLines(card.pillDescription, detail, inner.w, pillLines);
    drawLines(ctx, pill.lines, detail, inner.x, y + r.u(12), "ink");
  }
  drawPrompts(ctx, prompts, inner);
}

/**
 * purpose: Draw a multi-step task's card inside: progress boxes (up to five steps) with
 *          "Step n of N", the current step large (up to three lines, shrinking to 70%), and
 *          "Finished? Press [Done]".
 * @param ctx: (Ctx) Canvas and ruler.
 * @param steps: (string[]) The steps.
 * @param step: (number) The current step index.
 * @param inner: (Rect) The card's inside.
 * @return: (void)
 */
function drawStepContent(ctx: Ctx, steps: string[], step: number, inner: Rect): void {
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
  const title = fitText(steps[step] ?? "", r.text("stepTitle"), 0.7, inner.w, 3);
  drawLines(ctx, title.lines, title.style, inner.x, titleTop, "ink");
  drawPrompts(ctx, [{ question: "Finished?", icon: "checkmark", key: "Done" }], inner);
}

/**
 * purpose: Draw the clear card inside: a check and "Everything is done." when the day is
 *          finished, otherwise "Nothing to do right now.".
 * @param ctx: (Ctx) Canvas and ruler.
 * @param allDone: (boolean) The day is finished.
 * @param inner: (Rect) The card's inside.
 * @return: (void)
 */
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

/**
 * purpose: Draw a black tab with paper text (the Now card's tab, a row's "Now" tag).
 * @param ctx: (Ctx) Canvas and ruler.
 * @param text: (string) The words.
 * @param x: (number) Left.
 * @param top: (number) Top.
 * @param padY: (number) Vertical padding in points.
 * @param padX: (number) Horizontal padding in points.
 * @param maxWidth: (number) Widest the tab may be.
 * @return: (Rect) The tab.
 */
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

/**
 * purpose: The size of a black tab holding one line of words (drawTab, untruncated).
 * @param ctx: (Ctx) Canvas and ruler.
 * @param words: (string) The words.
 * @param padY: (number) Vertical padding in points.
 * @param padX: (number) Horizontal padding in points.
 * @return: ({ w: number; h: number }) Width and height in pixels.
 */
function tabSize(ctx: Ctx, words: string, padY: number, padX: number): { w: number; h: number } {
  const { r } = ctx;
  const style = r.text("tab");
  return { w: measure(words, style) + 2 * r.u(padX), h: style.lineHeight + 2 * r.u(padY) };
}

/**
 * purpose: Draw the Now page's body: the Now card (600 points wide) and the Next up column.
 * @param ctx: (Ctx) Canvas and ruler.
 * @param model: (Extract<FrameModel, { page: "now" }>) The model.
 * @param body: (Rect) The body.
 * @return: (void)
 */
function drawNowBody(ctx: Ctx, model: Extract<FrameModel, { page: "now" }>, body: Rect): void {
  const { canvas, r } = ctx;
  const columnWidth = Math.min(body.w, r.u(600));
  const tabText = model.now.kind === "task" ? model.now.tab : "Now";
  const tab = drawTab(ctx, tabText, body.x, body.y, 8, 20, columnWidth);
  const box = { x: body.x, y: body.y + tab.h, w: columnWidth, h: body.h - tab.h };
  const border = r.line(6);
  canvas.strokeRect(box.x, box.y, box.w, box.h, border, "ink");
  const inner = {
    x: box.x + border + r.u(36),
    y: box.y + border + r.u(36),
    w: box.w - 2 * border - 2 * r.u(36),
    h: box.h - 2 * border - r.u(36) - r.u(32),
  };
  const now = model.now;
  if (now.kind === "clear") drawClearContent(ctx, now.allDone, inner);
  else if (now.steps !== null) drawStepContent(ctx, now.steps, now.step, inner);
  else drawTaskContent(ctx, now, inner);
  const nextX = body.x + columnWidth + r.u(32);
  if (model.next !== null && body.x + body.w - nextX > r.u(120)) {
    drawNextCard(ctx, model.next, { x: nextX, y: body.y, w: body.x + body.w - nextX, h: body.h });
  }
}

/**
 * purpose: Draw the Next up column: its label, and a box with a circle (the visitor's initial
 *          or the item's icon), the title (up to two lines) and when.
 * @param ctx: (Ctx) Canvas and ruler.
 * @param item: (NextItem) The next item.
 * @param column: (Rect) The column.
 * @return: (void)
 */
function drawNextCard(ctx: Ctx, item: NextItem, column: Rect): void {
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
  } else {
    const size = r.u(36);
    drawIcon(canvas, item.icon, cx - size / 2, middle - size / 2, size, "ink");
  }
  const textTop = middle - textHeight / 2;
  const titleHeight = drawLines(ctx, title.lines, titleStyle, textX, textTop, "ink");
  drawLine(canvas, when, whenStyle, textX, textTop + titleHeight + r.u(2), "ink");
}

/**
 * purpose: Draw the Today page's body: the state's rows (finished grey with a check, missed
 *          grey alone, the Now row boxed with a black "Now" tag), "And N more later" when rows
 *          were left out, or "Nothing planned today.".
 * @param ctx: (Ctx) Canvas and ruler.
 * @param model: (Extract<FrameModel, { page: "today" }>) The model.
 * @param body: (Rect) The body.
 * @return: (void)
 */
function drawTodayBody(ctx: Ctx, model: Extract<FrameModel, { page: "today" }>, body: Rect): void {
  const { canvas, r } = ctx;
  const rowHeight = r.u(70);
  const pad = r.u(20);
  const timeStyle = r.text("rowTime");
  const timeWidth = r.u(150);
  const labelX = body.x + pad + timeWidth + r.u(24);
  /**
   * purpose: The top of a line box centered in a row.
   * @param row: (number) Row index.
   * @param style: (TextStyle) The line's style.
   * @return: (number) Pixels.
   */
  const lineTop = (row: number, style: TextStyle): number =>
    body.y + row * rowHeight + (rowHeight - style.lineHeight) / 2;
  model.rows.forEach((row, i) => {
    const y = body.y + i * rowHeight;
    const now = row.mark === "now";
    const grey = row.mark === "done" || row.mark === "missed";
    const paint: Paint = grey ? "grey" : "ink";
    const labelStyle = r.text(now ? "rowLabelNow" : "rowLabel");
    let right = body.x + body.w - pad;
    if (now) {
      canvas.strokeRect(body.x, y, body.w, rowHeight, r.line(5), "ink");
      const tag = tabSize(ctx, "Now", 4, 16);
      drawTab(ctx, "Now", right - tag.w, y + (rowHeight - tag.h) / 2, 4, 16, tag.w);
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

/**
 * purpose: Draw a page's model on a screen.
 * @param model: (FrameModel) The model.
 * @param screen: (Screen) The screen (within DRAWABLE_SCREEN).
 * @return: (Frame) The frame.
 */
export function drawFrame(model: FrameModel, screen: Screen): Frame {
  const canvas = new Canvas(screen);
  const r = new Ruler(screen);
  const ctx = { canvas, r };
  const padX = r.u(48);
  const stripTop = screen.height - r.u(100);
  const area = { x: padX, y: r.u(28), w: screen.width - 2 * padX, h: 0 };
  const headerBottom = drawHeader(ctx, model, area);
  const bodyTop = headerBottom + r.u(28);
  const body = { x: padX, y: bodyTop, w: area.w, h: stripTop - r.u(28) - bodyTop };
  if (model.page === "now") drawNowBody(ctx, model, body);
  else drawTodayBody(ctx, model, body);
  drawStrip(ctx, stripTop, padX);
  return canvas.toFrame();
}

/**
 * purpose: Render a page of a device state for a screen: buildFrameModel then drawFrame. Pure.
 * @param state: (DeviceState) The device state.
 * @param screen: (Screen) The screen (within DRAWABLE_SCREEN).
 * @param page: (CarouselPage) The page.
 * @param step: (number, optional) The step of a multi-step Now task (default 0).
 * @return: (Frame) The frame.
 */
export function renderFrame(
  state: DeviceState,
  screen: Screen,
  page: CarouselPage,
  step = 0,
): Frame {
  return drawFrame(buildFrameModel(state, page, step), screen);
}

/**
 * purpose: Whether frames can be drawn for a screen (sizes within DRAWABLE_SCREEN, 2 to 256
 *          greys, all whole numbers).
 * @param screen: (Screen) The screen.
 * @return: (boolean) True when drawable.
 */
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
