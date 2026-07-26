/**
 * Backward liveness dataflow over the linear program.
 *
 * Loops branch backwards, so a single sweep is not enough: the live set at
 * every label is iterated to a fixed point. Both dead code elimination and
 * the register allocator consume the converged label/return live-sets.
 */

import { destOf, usesOf, hasSideEffect, type Inst } from "./ir";

export type LivenessInfo = {
  /** Live vregs at each label, i.e. live-in of the instruction following it. */
  liveAtLabel: Map<string, Set<number>>;
  /** Live vregs after a function returns: the union over its call sites. */
  retLive: Map<string, Set<number>>;
};

function setsEqual(a: Set<number>, b: Set<number>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

/**
 * Converge the live set at every label. Definitions that are dead (and
 * side-effect free) contribute no uses, so liveness and deadness are
 * computed against each other until stable.
 *
 * The analysis is monotone — facts are only ever added to `liveAtLabel` and
 * `retLive` — so it terminates, but the number of sweeps needed is bounded
 * by the lattice height (labels x vregs, plus the interprocedural coupling),
 * not by the program length. The iteration cap below is therefore a
 * runaway guard, not a proof of sufficiency: exhausting it would mean the
 * live sets are an *under*-approximation, which would make dead code
 * elimination delete instructions whose results are still live. That is a
 * silent miscompile, so it is a hard failure instead.
 */
const MAX_LIVENESS_PASSES = 10_000;

export function convergeLiveness(program: Inst[]): LivenessInfo {
  const liveAtLabel = new Map<string, Set<number>>();
  const retLive = new Map<string, Set<number>>();
  let converged = false;
  for (let pass = 0; pass < MAX_LIVENESS_PASSES; pass++) {
    let changed = false;
    let live = new Set<number>();
    for (let i = program.length - 1; i >= 0; i--) {
      const inst = program[i];
      switch (inst.op) {
        case "label": {
          const previous = liveAtLabel.get(inst.name);
          if (!previous || !setsEqual(previous, live)) {
            liveAtLabel.set(inst.name, new Set(live));
            changed = true;
          }
          break;
        }
        case "jump":
          live = new Set(liveAtLabel.get(inst.target) ?? []);
          break;
        case "branch": {
          for (const v of liveAtLabel.get(inst.target) ?? []) live.add(v);
          for (const used of usesOf(inst)) live.add(used);
          break;
        }
        case "jal": {
          // Values live after the call flow through the callee's body
          let after = retLive.get(inst.target);
          if (!after) retLive.set(inst.target, after = new Set());
          for (const v of live) {
            if (!after.has(v)) {
              after.add(v);
              changed = true;
            }
          }
          live = new Set(liveAtLabel.get(inst.target) ?? []);
          break;
        }
        case "ret":
          live = new Set(retLive.get(inst.fn) ?? []);
          break;
        default: {
          const dest = destOf(inst);
          if (!hasSideEffect(inst) && dest !== null && !live.has(dest)) break; // dead
          if (dest !== null) live.delete(dest);
          for (const used of usesOf(inst)) live.add(used);
        }
      }
    }
    if (!changed) {
      converged = true;
      break;
    }
  }
  if (!converged) {
    throw new Error(
      `Internal error: liveness did not converge in ${MAX_LIVENESS_PASSES} passes`);
  }
  return { liveAtLabel, retLive };
}
