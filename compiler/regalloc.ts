/**
 * Linear-scan register allocation with store sinking and spilling.
 *
 * Virtual registers are mapped onto the configured register order using
 * live ranges from the converged dataflow (a value used before a loop's
 * back edge stays live to the end of the loop). Under pressure,
 * placeholder stores are first sunk earlier (their order among placeholder
 * accesses is preserved) to shorten live ranges; remaining pressure spills
 * the least-used value to a fixed stack address (STACK_TOP downward:
 * `get r? db addr` / `poke addr value`). Low stack addresses are left free
 * for the future function call stack.
 */

import type { ErrorReporter, SourceRange } from "./syntax.ts";
import {
  assertNever, destOf, setDest, usesOf,
  type IdAllocator, type Inst, type Operand,
} from "./ir.ts";
import { INVERT_BRANCH, STACK_TOP } from "./tables.ts";
import { convergeLiveness } from "./liveness.ts";
import { removeJumpsToNext, collectGarbageLabels } from "./optimize.ts";

export type AllocationResult = {
  /** The program after spill rewrites and post-allocation cleanups. */
  program: Inst[];
  /** Virtual register id to physical register number. */
  registerOf: Map<number, number>;
};

type AllocationContext = {
  registerOrder: readonly number[];
  ids: IdAllocator;
  errors: ErrorReporter;
  /** Fallback error position when a spill failure has no better node. */
  rootNode: SourceRange;
};

/** One contiguous run of positions where a vreg needs its register. */
type Segment = { v: number; start: number; end: number };

/**
 * Live ranges from converged dataflow, split into one segment per code
 * region (main and each function body). A value live across a call is
 * live inside the callee's positions too, so segments capture exactly
 * where a register is needed — between its segments (other functions
 * that never run while it is in flight) the register is free.
 */
function computeSegments(program: Inst[]) {
  const { liveAtLabel, retLive } = convergeLiveness(program);

  // Every position where each vreg needs its register
  const touched = new Map<number, Set<number>>();
  const useCount = new Map<number, number>();
  const defPositions = new Map<number, Set<number>>();
  const touch = (v: number, position: number): void => {
    let positions = touched.get(v);
    if (!positions) touched.set(v, positions = new Set());
    positions.add(position);
  };

  let live = new Set<number>();
  for (let i = program.length - 1; i >= 0; i--) {
    const inst = program[i];
    switch (inst.op) {
      case "label":
        live = new Set(liveAtLabel.get(inst.name) ?? []);
        break;
      case "jump":
        live = new Set(liveAtLabel.get(inst.target) ?? []);
        break;
      case "jal":
        live = new Set(liveAtLabel.get(inst.target) ?? []);
        break;
      case "ret":
        live = new Set(retLive.get(inst.fn) ?? []);
        break;
      case "branch":
        for (const v of liveAtLabel.get(inst.target) ?? []) live.add(v);
        for (const used of usesOf(inst)) live.add(used);
        break;
      default: {
        const dest = destOf(inst);
        if (dest !== null) {
          live.delete(dest);
          touch(dest, i);
          let defs = defPositions.get(dest);
          if (!defs) defPositions.set(dest, defs = new Set());
          defs.add(i);
        }
        for (const used of usesOf(inst)) live.add(used);
      }
    }
    for (const used of usesOf(inst)) {
      useCount.set(used, (useCount.get(used) ?? 0) + 1);
      touch(used, i);
    }
    // `live` is now the live-in set of instruction i
    for (const v of live) touch(v, i);
  }

  // Compress each vreg's positions into maximal contiguous runs. In the
  // gaps the value is dead (it is redefined before its next segment, or
  // those positions cannot execute while it is in flight), so its
  // register is genuinely free there.
  const segments = new Map<number, { start: number; end: number }[]>();
  for (const [v, positions] of touched) {
    const sorted = [...positions].sort((a, b) => a - b);
    const runs: { start: number; end: number }[] = [];
    for (const position of sorted) {
      const last = runs[runs.length - 1];
      if (last && position === last.end + 1) last.end = position;
      else runs.push({ start: position, end: position });
    }
    segments.set(v, runs);
  }
  return { segments, useCount, defPositions };
}

/**
 * Move placeholder stores earlier — right after the value they store is
 * computed — to shorten live ranges under register pressure. A store may
 * not cross another placeholder access, a yield/sleep, control flow, or
 * its own value's definition, so the observable order is unchanged.
 */
function hoistStores(program: Inst[]): Inst[] {
  const defCount = new Map<number, number>();
  for (const inst of program) {
    const dest = destOf(inst);
    if (dest !== null) defCount.set(dest, (defCount.get(dest) ?? 0) + 1);
  }

  const result = [...program];
  for (let i = 0; i < result.length; i++) {
    const inst = result[i];
    if (inst.op !== "storename" || inst.src.kind !== "vreg") continue;
    if (defCount.get(inst.src.id) !== 1) continue;
    const value = inst.src.id;

    let target = i;
    for (let j = i - 1; j >= 0; j--) {
      const other = result[j];
      const barrier =
        other.op === "storename" || other.op === "loadname" || other.op === "call" ||
        other.op === "alias" || other.op === "definedef" ||
        other.op === "poke" || other.op === "get" ||
        other.op === "label" || other.op === "jump" || other.op === "branch" ||
        other.op === "jal" || other.op === "ret" ||
        destOf(other) === value;
      if (barrier) break;
      target = j;
    }
    if (target < i) {
      result.splice(i, 1);
      result.splice(target, 0, inst);
    }
  }
  return result;
}

/** Replace every reference to `victim` among an instruction's operands. */
function replaceUses(inst: Inst, victim: number, replacement: number): Inst {
  const replace = (o: Operand): Operand =>
    o.kind === "vreg" && o.id === victim ? { kind: "vreg", id: replacement } : o;
  switch (inst.op) {
    case "alu":
    case "branch":
    case "call":
      return { ...inst, args: inst.args.map(replace) };
    case "movev":
    case "storename":
    case "poke":
      return { ...inst, src: replace(inst.src) };
    // The rest carry no value operands (see operandsOf), so there is
    // nothing to rewrite. Listed explicitly so that adding an
    // operand-carrying instruction kind is a compile error here.
    case "loadname":
    case "get":
    case "alias":
    case "definedef":
    case "label":
    case "jump":
    case "jal":
    case "ret":
      return { ...inst };
    default:
      return assertNever(inst, "instruction in replaceUses");
  }
}

/**
 * Rewrite every definition and use of `victim` to go through a fresh
 * scratch register backed by a fixed stack address.
 *
 * An instruction may both use and define the victim — `i += 1` lowers to
 * `add home home 1` — so the reload and the store must be able to happen
 * around the *same* instruction, sharing one scratch register:
 *
 *     get  s db addr
 *     add  s s 1
 *     poke addr s
 */
function spill(
  program: Inst[],
  victim: number,
  addr: number,
  scratch: Set<number>,
  ids: IdAllocator,
): Inst[] {
  const rewritten: Inst[] = [];
  for (const inst of program) {
    const defines = destOf(inst) === victim;
    const uses = usesOf(inst).includes(victim);
    if (!defines && !uses) {
      rewritten.push(inst);
      continue;
    }

    const s = ids.newVreg();
    scratch.add(s);
    // Reload before the instruction; all operands of one instruction share it
    if (uses) {
      rewritten.push({ op: "get", dest: s, addr, node: inst.node, id: ids.newInstId() });
    }
    const copy = replaceUses(inst, victim, s);
    if (defines) setDest(copy, s);
    rewritten.push(copy);
    // Store the freshly defined value back to its stack slot
    if (defines) {
      rewritten.push({ op: "poke", addr, src: { kind: "vreg", id: s }, node: inst.node, id: ids.newInstId() });
    }
  }
  return rewritten;
}

/**
 * Post-allocation cleanup: copies where both sides landed in the same
 * register are no-ops; dropping them can expose branch-over-jump patterns
 * (e.g. a return inside an if), so fuse and re-clean until stable.
 */
function cleanupAfterAllocation(program: Inst[], registerOf: Map<number, number>): Inst[] {
  program = program.filter(inst =>
    !(inst.op === "movev" && inst.src.kind === "vreg" &&
      registerOf.get(inst.src.id) === registerOf.get(inst.dest)));
  for (;;) {
    const refs = new Map<string, number>();
    for (const inst of program) {
      if (inst.op === "jump" || inst.op === "branch" || inst.op === "jal") {
        refs.set(inst.target, (refs.get(inst.target) ?? 0) + 1);
      }
    }
    let fused = false;
    for (let i = 0; i + 2 < program.length; i++) {
      const branch = program[i];
      const jump = program[i + 1];
      const label = program[i + 2];
      if (branch.op === "branch" && jump.op === "jump" && label.op === "label" &&
          branch.target === label.name && refs.get(label.name) === 1 &&
          INVERT_BRANCH[branch.opcode]) {
        branch.opcode = INVERT_BRANCH[branch.opcode];
        branch.target = jump.target;
        program.splice(i + 1, 2);
        fused = true;
        break;
      }
    }
    if (fused) continue;
    const next = removeJumpsToNext(program) ?? collectGarbageLabels(program);
    if (!next) return program;
    program = next;
  }
}

/**
 * Map every virtual register onto a physical register, sinking stores and
 * spilling to the stack when the program needs more registers than exist.
 */
export function allocateRegisters(program: Inst[], context: AllocationContext): AllocationResult {
  const { registerOrder, ids, errors } = context;
  let nextSpillAddr = STACK_TOP;
  let storesHoisted = false;
  // vregs created by spilling; never re-spilled (freeing them relieves nothing)
  const scratch = new Set<number>();

  // Repeatedly spill registers based on number of uses, breaking ties
  // by choosing the variable that blocks its register the longest.
  // Once all registers can be assigned, clean up and return the mapping.
  for (;;) {
    const { segments, useCount, defPositions } = computeSegments(program);

    // One work item per (vreg, region) segment, in position order. The
    // first segment of a vreg picks its register; later segments occupy
    // the same register in other regions.
    const items: Segment[] = [];
    for (const [v, runs] of segments) {
      for (const span of runs) items.push({ v, start: span.start, end: span.end });
    }
    // At equal starts, segments that begin with a definition go last:
    // the values they read at that position must re-occupy their
    // registers first, so read-then-write sharing works out.
    const startsAtDef = (s: Segment): boolean => defPositions.get(s.v)?.has(s.start) ?? false;
    items.sort((a, b) =>
      a.start - b.start ||
      (startsAtDef(a) ? 1 : 0) - (startsAtDef(b) ? 1 : 0) ||
      a.v - b.v);

    const lastEnd = new Map<number, number>();
    for (const item of items) {
      lastEnd.set(item.v, Math.max(lastEnd.get(item.v) ?? -1, item.end));
    }

    // Two segments conflict unless they only meet where one is being
    // read for the last time as the other is defined (read-then-write:
    // IC10 reads all operands before writing the destination).
    const conflicts = (a: Segment, b: Segment): boolean => {
      if (a.start > b.end || b.start > a.end) return false;
      if (a.start === b.end && defPositions.get(a.v)?.has(a.start)) return false;
      if (b.start === a.end && defPositions.get(b.v)?.has(b.start)) return false;
      return true;
    };

    const registerOf = new Map<number, number>();
    const active: { v: number; reg: number; end: number }[] = [];
    let victim: number | null = null;
    let victimNode: SourceRange = context.rootNode;

    for (const item of items) {
      const itemStartsAtDef = startsAtDef(item);
      // Release registers whose values are not live past this point:
      // IC10 reads operands before writing the destination.
      for (let k = active.length - 1; k >= 0; k--) {
        const entry = active[k];
        if (entry.end < item.start || (entry.end === item.start && itemStartsAtDef && entry.v !== item.v)) {
          active.splice(k, 1);
        }
      }

      const assigned = registerOf.get(item.v);
      if (assigned !== undefined) {
        // A later segment of an already-placed value re-occupies its register
        const holder = active.find(a => a.reg === assigned && a.v !== item.v);
        if (holder) {
          victim = holder.v;
          victimNode = program[item.start].node;
          break;
        }
        const existing = active.find(a => a.v === item.v);
        if (existing) existing.end = Math.max(existing.end, item.end);
        else active.push({ v: item.v, reg: assigned, end: item.end });
        continue;
      }

      // Registers claimed by future segments of already-placed values
      // that overlap this one are off limits.
      const forbidden = new Set<number>();
      for (const [w, reg] of registerOf) {
        if (w === item.v) continue;
        const wRuns = segments.get(w);
        if (!wRuns) continue;
        for (const span of wRuns) {
          if (conflicts(item, { v: w, start: span.start, end: span.end })) {
            forbidden.add(reg);
            break;
          }
        }
      }

      const allowed = (r: number): boolean => !forbidden.has(r) && !active.some(a => a.reg === r);
      // Prefer sharing a register with a copy's other side, so the move
      // can be elided at emission: the source when this value starts as
      // a copy, or the destination when it ends by being copied away.
      let preferred: number | undefined;
      const startInst = program[item.start];
      if (startInst?.op === "movev" && startInst.dest === item.v && startInst.src.kind === "vreg") {
        preferred = registerOf.get(startInst.src.id);
      }
      if (preferred === undefined || !allowed(preferred)) {
        const endInst = program[item.end];
        if (endInst?.op === "movev" && endInst.src.kind === "vreg" && endInst.src.id === item.v) {
          preferred = registerOf.get(endInst.dest);
        }
      }
      const pick = preferred !== undefined && allowed(preferred)
        ? preferred
        : registerOrder.find(allowed);
      if (pick === undefined) {
        // Spill the value that blocks its register the longest; break
        // ties toward the least-used one. Scratch values are never
        // worth spilling — freeing their register relieves nothing.
        const candidates = [...active.map(a => a.v), item.v].filter(v => !scratch.has(v));
        if (candidates.length === 0) {
          throw errors.error("Expression too complex: not enough registers", program[item.start].node);
        }
        candidates.sort((x, y) =>
          (lastEnd.get(y) ?? 0) - (lastEnd.get(x) ?? 0) ||
          (useCount.get(x) ?? 0) - (useCount.get(y) ?? 0) ||
          y - x);
        victim = candidates[0];
        victimNode = program[item.start].node;
        break;
      }

      registerOf.set(item.v, pick);
      active.push({ v: item.v, reg: pick, end: item.end });
    }

    if (victim === null) {
      return { program: cleanupAfterAllocation(program, registerOf), registerOf };
    }

    // First response to pressure: shorten live ranges by storing
    // placeholder results as soon as they are ready.
    if (!storesHoisted) {
      storesHoisted = true;
      program = hoistStores(program);
      continue;
    }

    // Rewrite the program with the victim living on the stack
    const addr = nextSpillAddr--;
    if (addr < 0) throw errors.error("Too many variables: out of stack memory", victimNode);
    program = spill(program, victim, addr, scratch, ids);
  }
}
