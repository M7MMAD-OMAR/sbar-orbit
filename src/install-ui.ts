/**
 * What the person watches while an installation runs.
 *
 * Installing Orbit is mostly waiting on other programs: a dependency install, a service that has to
 * come up, a broker that has to answer. The display exists so that the wait is legible, so that a
 * step that fails says so beside the step rather than in a wall of output afterwards, and so that a
 * person who has just met this project learns what it gives them while they wait for it.
 *
 * It never invents progress. Every line here is driven by a step that actually reported something.
 */

export type StepState = "pending" | "running" | "done" | "skipped" | "failed";
export type StepView = { id: string; title: string; state: StepState; detail: string; elapsedMs: number };

const mark = [
  "                                                              ",
  "   ◯ ·    S B A R   O R B I T                                 ",
  "          Every agent gets a screen of its own. You keep yours.",
  "                                                              ",
];

/** Honest claims only: each one is a capability this repository demonstrates. */
export const offerings = [
  "Each agent gets its own headless browser, with its own profile and storage.",
  "Native Fedora applications run on a private Wayland display, never on yours.",
  "The viewer is optional. Nothing opens a window on your desktop by itself.",
  "You can pause a session, take the keyboard yourself, then hand it back.",
  "Every action is journalled, and a session can be put back to an earlier point.",
  "Files are reserved cooperatively, so two agents do not edit the same one.",
  "A session's secret service holds exactly one item, not your whole keyring.",
  "An origin lease is enforced below the browser, not by asking it politely.",
  "The broker runs inside a shared CPU and memory budget, so your desktop stays yours.",
];

const glyph: Record<StepState, string> = { pending: "○", running: "◐", done: "✔", skipped: "·", failed: "✘" };
const spinner = ["◐", "◓", "◑", "◒"];
const color = { dim: "\x1b[2m", bold: "\x1b[1m", green: "\x1b[32m", red: "\x1b[31m", yellow: "\x1b[33m", cyan: "\x1b[36m", reset: "\x1b[0m" };

export function supportsDisplay(stream: { isTTY?: boolean } = process.stdout, env = process.env) {
  return !!stream.isTTY && !env.NO_COLOR && env.TERM !== "dumb";
}

function paint(text: string, code: string, enabled: boolean) {
  return enabled ? `${code}${text}${color.reset}` : text;
}

function seconds(ms: number) {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/** A block of lines repainted in place. Falls back to one line per change when there is no terminal. */
export class InstallDisplay {
  private painted = 0;
  private frame = 0;
  private timer?: ReturnType<typeof setInterval>;
  private steps: StepView[] = [];
  private note = "";
  private live: boolean;
  constructor(private write: (text: string) => void = text => process.stdout.write(text), live = supportsDisplay()) {
    this.live = live;
  }

  start(steps: StepView[]) {
    // A copy, because the caller mutates its own views in place and a shared reference would make
    // every comparison against "what it was before" compare a value with itself.
    this.steps = steps.map(step => ({ ...step }));
    this.write(`${paint(mark.join("\n"), color.cyan, this.live)}\n\n`);
    if (!this.live) return;
    this.steps = steps;
    this.write("\x1b[?25l");
    this.render();
    // Only the spinner and the rotating line need a clock. Everything else repaints on a real event.
    this.timer = setInterval(() => { this.frame++; this.render(); }, 120);
  }

  update(steps: StepView[]) {
    if (!this.live) {
      for (const step of steps) {
        const previous = this.steps.find(known => known.id === step.id);
        if (previous && previous.state === step.state) continue;
        if (step.state === "running") this.write(`  ${step.title} ...\n`);
        else if (step.state !== "pending") this.write(`  ${glyph[step.state]} ${step.title}: ${step.detail || step.state}\n`);
      }
      this.steps = steps.map(step => ({ ...step }));
      return;
    }
    this.steps = steps;
    this.render();
  }

  /** One rotating line of context under the steps, so a slow step is not a silent one. */
  setNote(note: string) {
    this.note = note;
    if (this.live) this.render();
  }

  private render() {
    const done = this.steps.filter(step => ["done", "skipped"].includes(step.state)).length;
    const width = 28;
    const filled = Math.round((done / Math.max(this.steps.length, 1)) * width);
    const lines = this.steps.map(step => {
      const icon = step.state === "running" ? (spinner[this.frame % spinner.length] ?? "") : glyph[step.state];
      const tint = step.state === "done" ? color.green : step.state === "failed" ? color.red
        : step.state === "skipped" ? color.yellow : step.state === "running" ? color.cyan : color.dim;
      const elapsed = step.elapsedMs ? paint(` ${seconds(step.elapsedMs)}`, color.dim, this.live) : "";
      const detail = step.detail ? paint(`  ${step.detail}`, color.dim, this.live) : "";
      const title = step.state === "pending" ? paint(step.title, color.dim, this.live) : step.title;
      return `  ${paint(icon, tint, this.live)} ${title}${elapsed}${detail}`;
    });
    lines.push("");
    lines.push(`  ${paint("█".repeat(filled) + "░".repeat(width - filled), color.cyan, this.live)}  ${done}/${this.steps.length}`);
    lines.push("");
    lines.push(`  ${paint(this.note, color.dim, this.live)}`);
    const text = lines.join("\n");
    this.write(`${this.painted ? `\x1b[${this.painted}A` : ""}\x1b[0J${text}\n`);
    this.painted = lines.length;
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    if (this.live) { this.render(); this.write("\x1b[?25h\n"); }
    else this.write("\n");
  }

  /** Anything the person still has to decide or run themselves, never mixed into the step list. */
  summary(title: string, lines: string[], tone: "good" | "warn" | "bad" = "good") {
    const tint = tone === "good" ? color.green : tone === "warn" ? color.yellow : color.red;
    this.write(`${paint(title, `${color.bold}${tint}`, this.live)}\n`);
    for (const line of lines) this.write(`${line}\n`);
    this.write("\n");
  }
}
