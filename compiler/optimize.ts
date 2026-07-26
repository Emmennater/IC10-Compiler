/**
 * Dead code elimination and control-flow cleanup, alternated to a fixed
 * point: ifs with all-empty arms disappear, a then-arm that is exactly
 * `break`/`continue` fuses into the conditional branch, code after an
 * unconditional jump is unreachable, jumps to the next label vanish,
 * loops with empty bodies are pruned, and a chain of constant add/sub
 * collapses into a single instruction.
 *
 * Passes return a new program array when they change something and null
 * when they do not, so the driver can cheaply detect the fixed point.
 */

import {
  constOp, destOf, usesOf, symsOf, hasSideEffect,
  type IfRegion, type Inst, type LoopRegion, type Operand,
} from "./ir.ts";
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
      case "reserve":
        kept.push(inst);
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

// ----------------------- constant offset folding -------------------------

/**
 * The value an add/sub against a literal produces: a carrier operand,
 * optionally reflected, plus a constant - `sign * carrier + offset`. All
 * four spellings land here, and composing two of them gives another one,
 * which is what makes a chain of them collapsible:
 *
 *     add dest x K   ->   x + K        sub dest x K   ->   x + -K
 *     add dest K x   ->   x + K        sub dest K x   ->   -x + K
 */
type Affine = { carrier: Operand; sign: 1 | -1; offset: number };

/**
 * Read an instruction as an affine value, or null if it is not one.
 *
 * Only integer literals qualify. Combining two offsets re-associates the
 * chip's arithmetic, and in IEEE doubles `(x + 0.1) + 0.2` is genuinely
 * not `x + 0.30000000000000004`; integers combine exactly, so folding
 * those cannot change a result.
 */
function asAffine(inst: Inst): Affine | null {
  if (inst.op !== "alu") return null;
  if (inst.opcode !== "add" && inst.opcode !== "sub") return null;
  if (inst.args.length !== 2) return null;
  const [left, right] = inst.args;
  // Checked first, so `sub dest K x` is only read as a reflection when the
  // literal really is the one being subtracted *from*.
  if (right.kind === "const") {
    const offset = parseFloat(right.text);
    if (!Number.isSafeInteger(offset)) return null;
    return { carrier: left, sign: 1, offset: inst.opcode === "sub" ? -offset : offset };
  }
  if (left.kind === "const") {
    const offset = parseFloat(left.text);
    if (!Number.isSafeInteger(offset)) return null;
    return { carrier: right, sign: inst.opcode === "sub" ? -1 : 1, offset };
  }
  return null;
}

/** The value `outer` produces when its own carrier is `inner`. */
function compose(inner: Affine, outer: Affine): Affine {
  return {
    carrier: inner.carrier,
    sign: (inner.sign * outer.sign) as 1 | -1,
    offset: outer.sign * inner.offset + outer.offset,
  };
}

/** Rebuild an alu instruction as `dest = value`, keeping its id. */
function asAffineInst(inst: Extract<Inst, { op: "alu" }>, value: Affine): Inst | null {
  if (!Number.isSafeInteger(value.offset)) return null;
  if (value.sign < 0) {
    // `offset - carrier`. An offset of 0 leaves `sub dest 0 carrier`,
    // which is exactly what lowering emits for unary minus anyway.
    const literal = constOp(value.offset);
    return literal && {
      id: inst.id, op: "alu", opcode: "sub",
      dest: inst.dest, args: [literal, value.carrier], node: inst.node,
    };
  }
  // Shifting by nothing is a copy, and `move` beats `add dest carrier 0`.
  if (value.offset === 0) return { id: inst.id, op: "movev", dest: inst.dest, src: value.carrier, node: inst.node };
  const literal = constOp(Math.abs(value.offset));
  return literal && {
    id: inst.id, op: "alu", opcode: value.offset > 0 ? "add" : "sub",
    dest: inst.dest, args: [value.carrier, literal], node: inst.node,
  };
}

/** Whether the instruction copies a register onto itself. */
function isSelfMove(inst: Inst): boolean {
  return inst.op === "movev" && inst.src.kind === "vreg" && inst.src.id === inst.dest;
}

/** Whether anything in [from, to) still reads the vreg. */
function readBetween(program: Inst[], from: number, to: number, vreg: number, dropped: Set<number>): boolean {
  for (let i = from; i < to; i++) {
    if (!dropped.has(i) && usesOf(program[i]).includes(vreg)) return true;
  }
  return false;
}

/** Whether anything in [from, to) overwrites what the operand reads. */
function writtenBetween(program: Inst[], from: number, to: number, carrier: Operand, dropped: Set<number>): boolean {
  // Literals, and the alias/define names a sym operand spells, are immutable.
  if (carrier.kind !== "vreg") return false;
  for (let i = from; i < to; i++) {
    if (!dropped.has(i) && destOf(program[i]) === carrier.id) return true;
  }
  return false;
}

/**
 * Instructions that end a straight-line run, so a backward scan for a
 * reaching definition can never cross one: a label is entered from
 * anywhere, a jump or branch skips what follows, and a jal runs a body
 * that writes the shared parameter and result vregs.
 */
function leavesStraightLine(inst: Inst): boolean {
  return inst.op === "label" || inst.op === "jump" || inst.op === "branch" ||
    inst.op === "jal" || inst.op === "ret";
}

/**
 * Collapse a chain of constant add/sub into one instruction.
 *
 *     sub v1 v0 2        add v2 v0 1        add v1 v0 1        sub v2 510 v0
 *     add v2 v1 3   ->                      sub v2 511 v1  ->
 *
 * Two shapes reach that from opposite directions:
 *
 *  - The producer writes some *other* register, so the consumer can read
 *    the producer's own carrier instead. Nothing is deleted here - the
 *    producer is simply left with no consumer, and dead code elimination
 *    is what retires it. Only done when the producer's result has exactly
 *    one reader, so the rewrite always shortens a live range rather than
 *    trading one for a longer one.
 *  - The producer accumulates into the very register the consumer
 *    overwrites (`add h h 1` twice, the shape a demoted loop counter
 *    lowers to). The carrier *is* what the producer clobbers, so the
 *    consumer can only see the pre-producer value if the producer goes
 *    away: the rewrite and the deletion are one edit, legal only when
 *    nothing in between reads the register.
 */
export function foldConstantOffsets(program: Inst[]): Inst[] | null {
  // Rewrites land in a working copy so that a consumer scanning backward
  // sees folds already made ahead of it and chains of three or more
  // collapse in a single sweep.
  const working = [...program];
  const dropped = new Set<number>(); // indices into working, not instruction ids

  // Readers per vreg. Counted once up front: a rewrite only ever moves a
  // read from a producer's dest onto that producer's carrier, and the
  // guard below is always asked about a dest, whose count never grows.
  const readers = new Map<number, number>();
  for (const inst of program) {
    for (const v of usesOf(inst)) readers.set(v, (readers.get(v) ?? 0) + 1);
  }

  let changed = false;
  let runStart = 0;
  for (let end = 0; end <= working.length; end++) {
    if (end < working.length && !leavesStraightLine(working[end])) continue;

    for (let j = runStart; j < end; j++) {
      const consumer = working[j];
      if (consumer.op !== "alu") continue;
      const outer = asAffine(consumer);
      if (outer === null || outer.carrier.kind !== "vreg") continue;
      const carried = outer.carrier.id;

      // The reaching definition is the nearest earlier write in the run.
      let k = j - 1;
      while (k >= runStart && (dropped.has(k) || destOf(working[k]) !== carried)) k--;
      if (k < runStart) continue;

      const inner = asAffine(working[k]);
      if (inner === null) continue;

      const accumulates = inner.carrier.kind === "vreg" && inner.carrier.id === carried;
      if (accumulates) {
        if (consumer.dest !== carried) continue;
        if (readBetween(working, k + 1, j, carried, dropped)) continue;
      } else {
        if (readers.get(carried) !== 1) continue;
        if (writtenBetween(working, k + 1, j, inner.carrier, dropped)) continue;
      }

      const folded = asAffineInst(consumer, compose(inner, outer));
      if (folded === null) continue;
      working[j] = folded;
      // A chain that composes back to the identity leaves the register
      // holding what it already held, so the copy itself goes too.
      if (isSelfMove(folded)) dropped.add(j);
      if (accumulates) dropped.add(k);
      changed = true;
    }

    runStart = end + 1;
  }

  if (!changed) return null;
  return working.filter((_, i) => !dropped.has(i));
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
      collectGarbageLabels(program) ??
      // Last: the structural passes merge straight-line runs by deleting
      // the jumps and labels between them, so folding sees the longest
      // runs once they have finished.
      foldConstantOffsets(program);
    if (!next) return program;
    program = next;
  }
}
