/**
 * Final text emission: turn allocated IR into IC10 assembly lines, and
 * optionally resolve labels to absolute line numbers (the game accepts
 * both, but resolved programs save lines).
 */

import type { Inst, Operand } from "./ir.ts";

/** Render the allocated program as IC10 assembly text. */
export function renderProgram(program: Inst[], registerOf: Map<number, number>): string {
  const reg = (id: number): string => {
    const physical = registerOf.get(id);
    if (physical === undefined) {
      // Every vreg surviving allocation has a mapping; a miss is a compiler bug.
      throw new Error(`Internal error: virtual register ${id} was never allocated`);
    }
    return `r${physical}`;
  };
  const fmt = (operand: Operand): string =>
    operand.kind === "vreg" ? reg(operand.id) : operand.text;

  const lines: string[] = [];
  for (const inst of program) {
    switch (inst.op) {
      case "alu":
        lines.push(`${inst.opcode} ${reg(inst.dest)} ${inst.args.map(fmt).join(" ")}`);
        break;
      case "movev":
        lines.push(`move ${reg(inst.dest)} ${fmt(inst.src)}`);
        break;
      case "loadname":
        lines.push(`move ${reg(inst.dest)} ${inst.name}`);
        break;
      case "storename":
        lines.push(`move ${inst.name} ${fmt(inst.src)}`);
        break;
      case "get":
        lines.push(`get ${reg(inst.dest)} db ${inst.addr}`);
        break;
      case "poke":
        lines.push(`poke ${inst.addr} ${fmt(inst.src)}`);
        break;
      case "call":
        lines.push(inst.dest === null
          ? [inst.opcode, ...inst.args.map(fmt)].join(" ")
          : [inst.opcode, reg(inst.dest), ...inst.args.map(fmt)].join(" "));
        break;
      case "alias":
        lines.push(`alias ${inst.name} ${inst.device}`);
        break;
      case "definedef":
        lines.push(`define ${inst.name} ${inst.value}`);
        break;
      case "label":
        lines.push(`${inst.name}:`);
        break;
      case "jump":
        lines.push(`j ${inst.target}`);
        break;
      case "branch":
        lines.push(`${inst.opcode} ${inst.args.map(fmt).join(" ")} ${inst.target}`);
        break;
      case "jal":
        lines.push(`jal ${inst.target}`);
        break;
      case "ret":
        lines.push("j ra");
        break;
    }
  }
  return lines.join("\n");
}

/**
 * Strip label definition lines and replace each jump/branch target with the
 * absolute line number the label ends up on. Only the final token of a line
 * is ever a label reference (`j label`, `jal label`, `b.. args label`), so
 * only that token is substituted — an alias or define that happens to share
 * a label's name is left alone.
 */
export function resolveLabels(output: string): string {
  const lines = output.split("\n");
  const labelLine = new Map<string, number>();
  const kept: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.endsWith(":")) {
      // The label resolves to the next real instruction line (line 0-based)
      labelLine.set(trimmed.slice(0, -1).trim(), kept.length);
    } else {
      kept.push(line);
    }
  }

  return kept
    .map(line => {
      const tokens = line.trim().split(" ");
      const last = tokens[tokens.length - 1];
      const target = labelLine.get(last);
      if (target !== undefined && (tokens[0] === "j" || tokens[0] === "jal" || tokens[0].startsWith("b"))) {
        tokens[tokens.length - 1] = String(target);
      }
      return tokens.join(" ");
    })
    .join("\n");
}
