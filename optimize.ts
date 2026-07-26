/**
 * Dead code elimination and control-flow cleanup, alternated to a fixed
 * point: ifs with all-empty arms disappear, a then-arm that is exactly
 * `break`/`continue` fuses into the conditional branch, code after an
 * unconditional jump is unreachable, jumps to the next label vanish, and
 * loops with empty bodies are pruned.
 *
 * Passes return a new program array when they change something and null
 * when they do not, so the driver can cheaply detect the fixed point.
 */

import { destOf, usesOf, symsOf, hasSideEffect, type IfRegion, type Inst, type LoopRegion } from "./ir.ts";
import { INVERT_BRANCH } from "./tables.ts";
import { convergeLiveness } from "./liveness.ts";

/** Keep only instructions that contribute to a side effect. */
export function eliminateDeadCode(program: Inst[]): Inst[] {
  const { liveAtLabel, retLive } = convergeLiveness(program);
  let live = new Set<number>();
  // Symbol names (aliases, defines) referenced by kept instructions.
  // Function bodies sit in front of the main program, so a use can
  // appear at an earlier position than its alias line: decide the
  // alias/define lines in a second sweep once all uses are known.
  const usedSyms = new Set<string>();
  const kept: Inst[] = [];
  const keep = (inst: Inst): void => {
    for (const s of symsOf(inst)) usedSyms.add(s);
    kept.push(inst);
  };
  for (let i = program.length - 1; i >= 0; i--) {
    const inst = program[i];
    switch (inst.op) {
      case "label":
        live = new Set(liveAtLabel.get(inst.name) ?? []);
        keep(inst);
        continue;
      case "jump":
        live = new Set(liveAtLabel.get(inst.target) ?? []);
        keep(inst);
        continue;
      case "branch": {
        for (const v of liveAtLabel.get(inst.target) ?? []) live.add(v);
        for (const used of usesOf(inst)) live.add(used);
        keep(inst);
        continue;
      }
      case "jal":
        live = new Set(liveAtLabel.get(inst.target) ?? []);
        keep(inst);
        continue;
      case "ret":
        live = new Set(retLive.get(inst.fn) ?? []);
        keep(inst);
        continue;
      case "alias":
      case "definedef":
        kept.push(inst); // decided below, once every use is known
        continue;
    }
    const dest = destOf(inst);
    if (!hasSideEffect(inst) && (dest === null || !live.has(dest))) continue;
    if (dest !== null) live.delete(dest);
    for (const used of usesOf(inst)) live.add(used);
    keep(inst);
  }
  return kept
    .reverse()
    .filter(inst => (inst.op !== "alias" && inst.op !== "definedef") || usedSyms.has(inst.name));
}

/**
 * Simplify if-regions whose arms changed shape after DCE:
 *  - all arms empty: delete the whole skeleton
 *  - then-arm is exactly one jump (break/continue): fuse it into the branch
 *  - empty then over a non-empty else: invert the branch
 *  - empty else: branch straight to the end label
 * Returns null if nothing changed.
 */
export function simplifyBranches(program: Inst[], ifRegions: IfRegion[]): Inst[] | null {
  const present = new Map<number, Inst>();
  for (const inst of program) present.set(inst.id, inst);
  const remove = new Set<number>();
  let changed = false;

  function armContents(arm: IfRegion["arms"][number]): Inst[] {
    return program.filter(inst =>
      inst.id >= arm.bodyFrom && inst.id <= arm.bodyTo &&
      !remove.has(inst.id) && inst.op !== "label");
  }

  // Regions were recorded innermost-first, so inner constructs collapse
  // before their parents are examined.
  for (const region of ifRegions) {
    const alive = region.arms.some(arm =>
      arm.condIds.some(id => present.has(id) && !remove.has(id)) ||
      arm.branchIds.some(id => present.has(id) && !remove.has(id)));
    if (!alive) continue;

    // A region that already fused or inverted its branch keeps its
    // meaning inside the branch instruction: never touch it again.
    if (region.simplified) continue;

    const contents = region.arms.map(armContents);

    if (contents.every(c => c.length === 0)) {
      // Nothing in any arm: delete the entire skeleton; the condition's
      // loads die in the next liveness pass.
      for (const arm of region.arms) {
        for (const id of arm.condIds) remove.add(id);
        if (arm.jumpId !== null) remove.add(arm.jumpId);
        if (arm.labelId !== null) remove.add(arm.labelId);
      }
      remove.add(region.endLabelId);
      changed = true;
      continue;
    }

    // A then-arm that is exactly one jump (break/continue/return): jump
    // there directly when the condition holds; any else arm falls through.
    if (region.arms.length <= 2 && region.arms[0].branchIds.length === 1) {
      const thenArm = region.arms[0];
      const only = contents[0];
      if (only.length === 1 && only[0].op === "jump" &&
          (region.arms.length === 1 || thenArm.nextIsElse)) {
        const branch = present.get(thenArm.branchIds[0]);
        if (branch && branch.op === "branch" && INVERT_BRANCH[branch.opcode]) {
          branch.opcode = INVERT_BRANCH[branch.opcode];
          branch.target = only[0].target;
          remove.add(only[0].id);
          if (thenArm.jumpId !== null) remove.add(thenArm.jumpId);
          if (thenArm.labelId !== null) remove.add(thenArm.labelId);
          region.simplified = true;
          changed = true;
          continue;
        }
      }
    }

    // A simple if/else: the then-arm's record says the arm after it is the
    // unconditional `else` that separates the two.
    if (region.arms.length === 2 && region.arms[0].nextIsElse) {
      const thenArm = region.arms[0];
      if (contents[0].length === 0 && contents[1].length > 0 && thenArm.branchIds.length === 1) {
        // Empty then: invert the single branch to jump over the else arm
        const branch = present.get(thenArm.branchIds[0]);
        if (branch && branch.op === "branch" && INVERT_BRANCH[branch.opcode]) {
          branch.opcode = INVERT_BRANCH[branch.opcode];
          branch.target = region.endLabelName;
          if (thenArm.jumpId !== null) remove.add(thenArm.jumpId);
          if (thenArm.labelId !== null) remove.add(thenArm.labelId);
          region.simplified = true;
          changed = true;
          continue;
        }
      }
      if (contents[0].length > 0 && contents[1].length === 0) {
        // Empty else: fall straight through to the end label
        for (const id of thenArm.branchIds) {
          const branch = present.get(id);
          if (branch && branch.op === "branch" && branch.target === thenArm.labelName) {
            branch.target = region.endLabelName;
          }
        }
        if (thenArm.jumpId !== null) remove.add(thenArm.jumpId);
        if (thenArm.labelId !== null) remove.add(thenArm.labelId);
        region.simplified = true;
        changed = true;
        continue;
      }
    }
  }

  if (!changed) return null;
  return program.filter(inst => !remove.has(inst.id));
}

/** Loops whose bodies emptied out are spin cycles with no effects: prune. */
export function pruneEmptyLoops(program: Inst[], loopRegions: LoopRegion[]): Inst[] | null {
  const present = new Map<number, Inst>();
  for (const inst of program) present.set(inst.id, inst);
  const remove = new Set<number>();

  for (const region of loopRegions) {
    if (!present.has(region.backJumpId)) continue;
    const content = program.some(inst =>
      inst.id >= region.bodyFrom && inst.id <= region.bodyTo && inst.op !== "label");
    if (!content) remove.add(region.backJumpId);
  }

  if (remove.size === 0) return null;
  return program.filter(inst => !remove.has(inst.id));
}

/** Instructions after an unconditional jump are unreachable until a label. */
export function removeUnreachable(program: Inst[]): Inst[] | null {
  const kept: Inst[] = [];
  let reachable = true;
  let changed = false;
  for (const inst of program) {
    if (inst.op === "label") reachable = true;
    if (!reachable) {
      changed = true;
      continue;
    }
    kept.push(inst);
    if (inst.op === "jump" || inst.op === "ret") reachable = false;
  }
  return changed ? kept : null;
}

/** A jump whose target label follows immediately (labels between) is a no-op. */
export function removeJumpsToNext(program: Inst[]): Inst[] | null {
  const remove = new Set<number>();
  for (let i = 0; i < program.length; i++) {
    const inst = program[i];
    if (inst.op !== "jump") continue;
    for (let j = i + 1; j < program.length; j++) {
      const next = program[j];
      if (next.op !== "label") break;
      if (next.name === inst.target) {
        remove.add(inst.id);
        break;
      }
    }
  }
  if (remove.size === 0) return null;
  return program.filter(inst => !remove.has(inst.id));
}

/** Drop labels that nothing jumps to anymore. */
export function collectGarbageLabels(program: Inst[]): Inst[] | null {
  const targets = new Set<string>();
  for (const inst of program) {
    if (inst.op === "jump" || inst.op === "branch" || inst.op === "jal") targets.add(inst.target);
  }
  const kept = program.filter(inst => inst.op !== "label" || targets.has(inst.name));
  return kept.length === program.length ? null : kept;
}

/**
 * Run dead code elimination and the structural cleanups until none of them
 * finds anything left to do.
 */
export function optimize(program: Inst[], ifRegions: IfRegion[], loopRegions: LoopRegion[]): Inst[] {
  for (;;) {
    program = eliminateDeadCode(program);
    const next =
      simplifyBranches(program, ifRegions) ??
      pruneEmptyLoops(program, loopRegions) ??
      removeUnreachable(program) ??
      removeJumpsToNext(program) ??
      collectGarbageLabels(program);
    if (!next) return program;
    program = next;
  }
}
