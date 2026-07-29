/**
 * Unit tests for the leaf libraries.
 *
 * These exist to demonstrate - not merely assert - that each library stands
 * on its own: every test below constructs its subject directly and needs no
 * AST, no compiler, and no knowledge of the pipeline. Anything that needs a
 * whole `compile()` call belongs in the differential suite instead.
 */

import { ErrorReporter, kids } from "../compiler/syntax.ts";
import {
  applyArithmetic, applyBinary, applyBitwise, applyBitwiseNot, compare, ic10Mod,
} from "../compiler/tables.ts";
import {
  IdAllocator, assertNever, constOp, destOf, operandsOf, usesOf, hasSideEffect, symsOf,
} from "../compiler/ir.ts";
import { LabelFactory } from "../compiler/labels.ts";
import { StatementScope } from "../compiler/statement-scope.ts";
import { foldExpression, foldTruthy, pressure } from "../compiler/folding.ts";
import { ScopeChain, type Scope } from "../compiler/symbols.ts";
import { resolveLabels } from "../compiler/render.ts";
import { convergeLiveness } from "../compiler/liveness.ts";
import { foldConstantOffsets } from "../compiler/optimize.ts";
import type { Inst, Operand, UnnumberedInst } from "../compiler/ir.ts";
import type { SyntaxNode } from "../compiler/syntax.ts";
import type {
  BinaryOp, BinaryOpcode, ComparisonOp, ComparisonOpcode, Constant, Expression,
  Identifier, LogicalOp, StringExpr, UnaryOp,
} from "../compiler/formal-ast.ts";
import { node, num } from "./ast.ts";

/**
 * `pass` is the verdict; `detail` explains it in one line. A result from
 * `equal` also carries the two operands in `comparison`, so a runner with a
 * diff engine (the vitest wrapper) can show one instead of the flat string.
 */
export type UnitResult = {
  name: string;
  pass: boolean;
  detail?: string;
  comparison?: { actual: unknown; expected: unknown };
};

const results: UnitResult[] = [];

function check(label: string, condition: boolean, detail?: string): void {
  results.push({ name: label, pass: condition, detail: condition ? undefined : detail });
}

function equal<T>(label: string, actual: T, expected: T): void {
  const same = JSON.stringify(actual) === JSON.stringify(expected);
  check(label, same, same ? undefined : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  if (!same) results[results.length - 1].comparison = { actual, expected };
}

function throws(label: string, body: () => unknown): void {
  try {
    body();
    check(label, false, "expected a throw, but it returned normally");
  } catch {
    check(label, true);
  }
}

// UnnumberedInst, not Omit<Inst, "id">: the plain Omit collapses the union
// and every instruction-specific field disappears.
const inst = (partial: UnnumberedInst, id: number): Inst => ({ ...partial, id }) as Inst;
const dummyNode: SyntaxNode = { type: "x", text: "", from: 0, to: 0, children: [] };

// Folding and pressure consume the formal AST, so their subjects are built
// directly in it - no parser, no conversion, no pipeline.
const at = { from: 0, to: 0 };
const k = (value: number): Constant => ({ type: "constant", ...at, value });
const id = (name: string): Identifier => ({ type: "identifier", ...at, name });
const text = (value: string): StringExpr => ({ type: "string", ...at, value: `"${value}"` });
const arith = (left: Expression, opcode: BinaryOpcode, right: Expression): BinaryOp =>
  ({ type: "binaryop", ...at, left, right, opcode });
const cmp = (left: Expression, opcode: ComparisonOpcode, right: Expression): ComparisonOp =>
  ({ type: "comparisonop", ...at, left, right, opcode });
const logic = (left: Expression, opcode: "and" | "or", right: Expression): LogicalOp =>
  ({ type: "logicalop", ...at, left, right, opcode });
const unary = (opcode: UnaryOp["opcode"], value: Expression): UnaryOp =>
  ({ type: "unaryop", ...at, value, opcode });

export function runUnitTests(): UnitResult[] {
  results.length = 0;

  // ------------------------------ tables --------------------------------
  // IC10's mod is a true modulo: the result takes the divisor's sign. This
  // is the rule the original's folding bug violated.
  equal("ic10Mod(7, 3) === 1", ic10Mod(7, 3), 1);
  equal("ic10Mod(-7, 3) === 2 (not -1)", ic10Mod(-7, 3), 2);
  equal("ic10Mod(7, -3) === -2", ic10Mod(7, -3), -2);
  // The tables are keyed by the opcode the formal AST resolved the operator
  // to, so "not an arithmetic operator" is a type error, not a runtime one.
  equal("applyArithmetic mod matches ic10Mod", applyArithmetic("mod", -7, 3), ic10Mod(-7, 3));
  equal("applyArithmetic div", applyArithmetic("div", 7, 2), 3.5);
  check("compare('ge', 2, 2)", compare("ge", 2, 2));
  check("compare('gt', 2, 2) is false", !compare("gt", 2, 2));

  // Bitwise: the chip's words are 64 bits and JavaScript's own operators are
  // 32, so every one of these is computed in BigInt. `1 << 40` is the case
  // that catches a lapse back to plain JS - it would come out as 256.
  equal("applyBitwise and", applyBitwise("and", 12, 10), 8);
  equal("applyBitwise or", applyBitwise("or", 12, 3), 15);
  equal("applyBitwise xor", applyBitwise("xor", 12, 10), 6);
  equal("applyBitwise sll past 32 bits", applyBitwise("sll", 1, 40), 1099511627776);
  equal("applyBitwise sll wraps at 64 bits", applyBitwise("sll", 1, 63), -9223372036854775808);
  // The two right shifts differ only on a negative value: sra replicates the
  // sign bit, srl shifts zeroes into it.
  equal("applyBitwise sra keeps the sign", applyBitwise("sra", -8, 2), -2);
  equal("applyBitwise srl fills with zeroes", applyBitwise("srl", -8, 60), 15);
  equal("applyBitwise srl of a positive matches sra", applyBitwise("srl", 8, 2), applyBitwise("sra", 8, 2));
  // Shift counts run modulo 64, as a 64-bit shift instruction does.
  equal("applyBitwise shift count wraps at 64", applyBitwise("sll", 5, 64), 5);
  // Operands are truncated toward zero first: these are integer operations
  // even though a register holds a double.
  equal("applyBitwise truncates its operands", applyBitwise("and", 5.9, 3), 1);
  equal("applyBitwise truncates toward zero", applyBitwise("or", -1.9, 0), -1);
  check("applyBitwise of a non-integer value is NaN", Number.isNaN(applyBitwise("and", 1 / 0, 1)));
  equal("applyBitwiseNot(0) is -1 (all bits set)", applyBitwiseNot(0), -1);
  equal("applyBitwiseNot is its own inverse", applyBitwiseNot(applyBitwiseNot(1234)), 1234);
  check("applyBitwiseNot(NaN) is NaN", Number.isNaN(applyBitwiseNot(0 / 0)));
  // applyBinary is the single entry point both kinds share
  equal("applyBinary dispatches arithmetic", applyBinary("mod", -7, 3), 2);
  equal("applyBinary dispatches bitwise", applyBinary("xor", 12, 10), 6);

  // constOp must reject values with no plain IC10 literal
  equal("constOp(1/0) is null", constOp(1 / 0), null);
  equal("constOp(NaN) is null", constOp(0 / 0), null);
  equal("constOp(1e21) is null (exponent form)", constOp(1e21), null);
  equal("constOp(3.5)", constOp(3.5), { kind: "const", text: "3.5" });

  // ---------------------------- ErrorReporter ---------------------------
  const reporter = new ErrorReporter("a\nbb\n\nccc");
  equal("lineOf offset 0", reporter.lineOf({ ...dummyNode, from: 0 }), 0);
  equal("lineOf offset 2 (start of line 1)", reporter.lineOf({ ...dummyNode, from: 2 }), 1);
  equal("lineOf offset 5 (the blank line 2)", reporter.lineOf({ ...dummyNode, from: 5 }), 2);
  equal("lineOf offset 7 (line 3)", reporter.lineOf({ ...dummyNode, from: 7 }), 3);
  equal("lineOf past end clamps", reporter.lineOf({ ...dummyNode, from: 9999 }), 3);
  const err = reporter.error("boom", { ...dummyNode, from: 2, to: 4 });
  check("error carries the source range", err.from === 2 && err.to === 4);
  check("error message carries the line", err.message === "Line 1: boom");

  // -------------------------------- syntax ------------------------------
  const withComment = node("X", "", num(1), node("Comment", "// hi"), num(2));
  equal("kids drops comments", kids(withComment).length, 2);

  // ------------------------------- folding ------------------------------
  const noConstants = () => null;
  equal("fold 2 + 3 * 4",
    foldExpression(arith(k(2), "add", arith(k(3), "mul", k(4))), noConstants)?.text, "14");
  equal("fold 7 % 3 (the original's bug)",
    foldExpression(arith(k(7), "mod", k(3)), noConstants)?.text, "1");
  equal("fold -7 % 3",
    foldExpression(arith(unary("neg", k(7)), "mod", k(3)), noConstants)?.text, "2");
  equal("fold 1 / 0 gives null, not Infinity",
    foldExpression(arith(k(1), "div", k(0)), noConstants), null);
  equal("fold comparison to 0/1", foldExpression(cmp(k(2), "gt", k(3)), noConstants)?.text, "0");
  equal("fold !0", foldExpression(unary("not", k(0)), noConstants)?.text, "1");
  // Bitwise folds through the same shared semantics, so a folded `1 << 40`
  // cannot disagree with what the chip computes.
  equal("fold 12 & 10", foldExpression(arith(k(12), "and", k(10)), noConstants)?.text, "8");
  equal("fold 1 << 40 at 64 bits",
    foldExpression(arith(k(1), "sll", k(40)), noConstants)?.text, "1099511627776");
  equal("fold ~0", foldExpression(unary("bitnot", k(0)), noConstants)?.text, "-1");
  // `~` is not `!`: one flips every bit, the other is an exact 0/1.
  equal("fold ~1 is -2, not 0", foldExpression(unary("bitnot", k(1)), noConstants)?.text, "-2");
  equal("fold !1 is 0", foldExpression(unary("not", k(1)), noConstants)?.text, "0");
  // && / || fold when one side settles the outcome, even if the other is unknown
  equal("fold 0 && unknown", foldExpression(logic(k(0), "and", id("x")), noConstants)?.text, "0");
  equal("fold 1 || unknown", foldExpression(logic(k(1), "or", id("x")), noConstants)?.text, "1");
  equal("fold unknown && 1 stays unknown", foldExpression(logic(id("x"), "and", k(1)), noConstants), null);
  equal("fold string is not constant", foldExpression(text("hi"), noConstants), null);
  // the constant lookup is the only outside knowledge folding needs
  const withK = (n: string) => (n === "k" ? ({ kind: "const", text: "5" } as const) : null);
  equal("fold k + 1 via lookup", foldExpression(arith(id("k"), "add", k(1)), withK)?.text, "6");
  equal("fold unknown name", foldExpression(id("other"), withK), null);
  equal("foldTruthy(null)", foldTruthy(null), null);
  equal("foldTruthy(0)", foldTruthy({ kind: "const", text: "0" }), false);

  // pressure: known names are free, placeholders cost a register
  const known = (n: string) => n === "v";
  equal("pressure of a literal", pressure(k(1), known), 0);
  equal("pressure of a known variable", pressure(id("v"), known), 0);
  equal("pressure of a placeholder", pressure(id("p"), known), 1);
  equal("pressure of balanced binary grows", pressure(arith(id("p"), "add", id("q")), known), 2);
  equal("pressure of unbalanced binary does not", pressure(arith(id("p"), "add", k(1)), known), 1);

  // ------------------------------- labels -------------------------------
  const labels = new LabelFactory();
  const chain = labels.newIf();
  equal("if end label", chain.end, "endif0");
  equal("first elif", chain.nextElif(), "if0elif0");
  equal("second elif", chain.nextElif(), "if0elif1");
  equal("else label", chain.otherwise, "else0");
  equal("second if gets its own index", labels.newIf().end, "endif1");
  equal("loop labels", labels.newLoop(), { head: "loop0", end: "endloop0" });
  equal("while labels", labels.newWhile(), { head: "while0", end: "endwhile0" });
  equal("repeat labels", labels.newRepeat(), { head: "repeat0", until: "until0", end: "endrepeat0" });
  equal("short circuit labels increment", [labels.newShortCircuit(), labels.newShortCircuit()], ["sc0", "sc1"]);
  equal("function end label", labels.functionEnd("scale"), "endscale");

  // --------------------------- StatementScope ---------------------------
  const statements = new StatementScope(10);
  check("vreg below base is not owned", !statements.ownsVreg(9));
  check("vreg at base is owned", statements.ownsVreg(10));
  statements.rememberLoad("p", 3);
  equal("cached load", statements.cachedLoad("p"), 3);
  statements.clearLoads();
  equal("clearLoads drops the cache", statements.cachedLoad("p"), undefined);
  check("clearLoads keeps the vreg base", statements.ownsVreg(10) && !statements.ownsVreg(9));
  statements.beginStatement(20);
  check("beginStatement rebases", !statements.ownsVreg(19) && statements.ownsVreg(20));
  const nested = new StatementScope(20).forNestedBody();
  check("nested body inherits the base", nested.ownsVreg(20) && !nested.ownsVreg(19));

  // ---------------------------- IdAllocator -----------------------------
  const ids = new IdAllocator();
  equal("first vreg is 0", ids.newVreg(), 0);
  equal("vregs increment", ids.newVreg(), 1);
  equal("nextVregId is a watermark, not an allocation", ids.nextVregId, 2);
  equal("inst ids are an independent sequence", ids.newInstId(), 0);
  equal("nextInstId watermark", ids.nextInstId, 1);

  // -------------------------------- ir ----------------------------------
  const alu = inst({ op: "alu", opcode: "add", dest: 5, args: [{ kind: "vreg", id: 1 }, { kind: "const", text: "2" }], node: dummyNode }, 0);
  equal("destOf(alu)", destOf(alu), 5);
  equal("usesOf(alu)", usesOf(alu), [1]);
  check("alu has no side effect", !hasSideEffect(alu));
  const store = inst({ op: "storename", name: "p", src: { kind: "vreg", id: 2 }, node: dummyNode }, 1);
  equal("destOf(storename) is null", destOf(store), null);
  check("storename has a side effect", hasSideEffect(store));
  const voidCall = inst({ op: "call", opcode: "yield", dest: null, args: [], node: dummyNode }, 2);
  check("call without dest has a side effect", hasSideEffect(voidCall));
  const valueCall = inst({ op: "call", opcode: "l", dest: 3, args: [{ kind: "sym", text: "d0" }, { kind: "sym", text: "Setting" }], node: dummyNode }, 3);
  check("call with dest has no side effect", !hasSideEffect(valueCall));
  equal("symsOf(call)", symsOf(valueCall), ["d0", "Setting"]);
  equal("operandsOf(label) is empty", operandsOf(inst({ op: "label", name: "L", node: dummyNode }, 4)), []);
  // The exhaustiveness guard: only reachable if a union grew and a switch did not
  throws("assertNever throws on a value no switch handled",
    () => assertNever("surprise" as never, "instruction"));

  // ------------------------------ symbols -------------------------------
  // ScopeChain is a value: derived chains never affect the one they came
  // from, so there is nothing to unwind and nothing a throw can corrupt.
  const root = ScopeChain.root();
  root.declare("g", { kind: "var", state: { value: { kind: "const", text: "1" }, maybe: false, home: null } });
  check("global resolves at the root", root.lookup("g") !== null);
  equal("root depth is 1", root.depth, 1);

  const block = root.child();
  block.declare("local", { kind: "device", pin: "d0" });
  check("block sees its own name", block.lookup("local") !== null);
  check("block still sees globals", block.lookup("g") !== null);
  equal("parent never sees the block's names", root.lookup("local"), null);

  // late declarations in a SHARED scope are visible through both chains -
  // the maps are shared even though the chains are values
  root.declare("late", { kind: "device", pin: "d5" });
  check("block sees a global declared after the block was made",
    block.lookup("late") !== null);

  // a function frame hides caller locals but keeps globals
  block.declare("callerLocal", { kind: "var", state: { value: null, maybe: false, home: null } });
  const fnParams: Scope = new Map();
  fnParams.set("p", { kind: "var", state: { value: { kind: "const", text: "2" }, maybe: false, home: null } });
  const fnFrame = block.functionFrame(fnParams);
  equal("function frame cannot see caller locals", fnFrame.lookup("callerLocal"), null);
  check("function frame still sees globals", fnFrame.lookup("g") !== null);
  check("function frame sees its parameters", fnFrame.lookup("p") !== null);
  check("caller chain is untouched by the function frame",
    block.lookup("callerLocal") !== null && block.lookup("p") === null);

  // hidden caller variables still count toward vreg ownership
  block.declare("hidden", { kind: "var", state: { value: { kind: "vreg", id: 42 }, maybe: false, home: null } });
  equal("valueRefCount sees variables hidden by the boundary",
    fnFrame.functionFrame(new Map()).valueRefCount(42), 1);
  equal("globalGet reads scope 0 from any depth", fnFrame.globalGet("g")?.kind, "var");

  // ------------------------------ liveness ------------------------------
  // A value defined before a loop and used inside it must stay live across
  // the back edge - the case a single backward sweep gets wrong.
  const loopProgram: Inst[] = [
    inst({ op: "movev", dest: 0, src: { kind: "const", text: "1" }, node: dummyNode }, 0),
    inst({ op: "label", name: "top", node: dummyNode }, 1),
    inst({ op: "storename", name: "out", src: { kind: "vreg", id: 0 }, node: dummyNode }, 2),
    inst({ op: "jump", target: "top", node: dummyNode }, 3),
  ];
  const live = convergeLiveness(loopProgram);
  check("value used in a loop body is live at the loop head",
    live.liveAtLabel.get("top")?.has(0) === true);

  // ------------------------ constant offset folding ---------------------
  // The pass takes IR and returns IR, so it is exercised here directly:
  // no AST, no compile() call, no register allocator.
  const shift = (opcode: string, dest: number, args: Operand[], id: number): Inst =>
    inst({ op: "alu", opcode, dest, args, node: dummyNode }, id);
  const vreg = (id: number): Operand => ({ kind: "vreg", id });
  const lit = (t: string): Operand => ({ kind: "const", text: t });
  /** Render just the opcode/operand shape, so ids and nodes stay out of the way. */
  const shapes = (program: Inst[] | null): string[] =>
    (program ?? []).map(i =>
      i.op === "alu" ? `${i.opcode} v${i.dest} ${i.args.map(a => a.kind === "vreg" ? `v${a.id}` : a.text).join(" ")}`
      : i.op === "movev" ? `move v${i.dest} ${i.src.kind === "vreg" ? `v${i.src.id}` : i.src.text}`
      : i.op);

  // Accumulator shape: both shifts write v0, so the producer must be
  // deleted - redirecting the read alone would double-count it.
  equal("folding merges a chained accumulator",
    shapes(foldConstantOffsets([
      shift("add", 0, [vreg(0), lit("1")], 0),
      shift("add", 0, [vreg(0), lit("1")], 1),
    ])),
    ["add v0 v0 2"]);

  // Temporary shape: the consumer takes over the producer's carrier and
  // the producer is left for dead code elimination, still present here.
  equal("folding redirects through a temporary and cancels signs",
    shapes(foldConstantOffsets([
      shift("sub", 1, [vreg(0), lit("2")], 0),
      shift("add", 2, [vreg(1), lit("3")], 1),
    ])),
    ["sub v1 v0 2", "add v2 v0 1"]);

  equal("a chain summing to zero becomes a copy",
    shapes(foldConstantOffsets([
      shift("add", 1, [vreg(0), lit("2")], 0),
      shift("sub", 2, [vreg(1), lit("2")], 1),
    ])),
    ["add v1 v0 2", "move v2 v0"]);

  // Three links collapse in one sweep: the middle instruction is already
  // rewritten by the time the last one scans back for its definition.
  equal("three links collapse in a single pass",
    shapes(foldConstantOffsets([
      shift("add", 1, [vreg(0), lit("1")], 0),
      shift("add", 2, [vreg(1), lit("2")], 1),
      shift("add", 3, [vreg(2), lit("3")], 2),
    ])).slice(-1),
    ["add v3 v0 6"]);

  // `add` commutes, so a const-first producer folds too.
  equal("folding reads a commuted const-first add",
    shapes(foldConstantOffsets([
      shift("add", 1, [lit("4"), vreg(0)], 0),
      shift("add", 2, [vreg(1), lit("1")], 1),
    ])).slice(-1),
    ["add v2 v0 5"]);

  // `sub v1 5 v0` reflects rather than shifts, so composing it with a
  // shift flips that shift's sign: 5 - v0 + 1 is 6 - v0.
  equal("a shift after a reflection keeps the reflection",
    shapes(foldConstantOffsets([
      shift("sub", 1, [lit("5"), vreg(0)], 0),
      shift("add", 2, [vreg(1), lit("1")], 1),
    ])).slice(-1),
    ["sub v2 6 v0"]);

  // The reverse order: 511 - (v0 + 1) is 510 - v0.
  equal("a reflection after a shift absorbs it",
    shapes(foldConstantOffsets([
      shift("add", 1, [vreg(0), lit("1")], 0),
      shift("sub", 2, [lit("511"), vreg(1)], 1),
    ])).slice(-1),
    ["sub v2 510 v0"]);

  // Two reflections cancel back to a shift: 20 - (511 - v0) is v0 - 491.
  equal("two reflections compose back to a shift",
    shapes(foldConstantOffsets([
      shift("sub", 1, [lit("511"), vreg(0)], 0),
      shift("sub", 2, [lit("20"), vreg(1)], 1),
    ])).slice(-1),
    ["sub v2 v0 491"]);

  // Composing to the identity leaves the register holding what it already
  // held, so the copy is dropped outright rather than emitted as a move.
  equal("a chain composing to the identity disappears",
    shapes(foldConstantOffsets([
      shift("sub", 0, [lit("5"), vreg(0)], 0),
      shift("sub", 0, [lit("5"), vreg(0)], 1),
    ])),
    []);

  // A second reader means folding would stretch v0's live range to save
  // v1's instead of retiring one, so the guard declines.
  check("a producer with two readers is left alone",
    foldConstantOffsets([
      shift("add", 1, [vreg(0), lit("1")], 0),
      shift("add", 2, [vreg(1), lit("2")], 1),
      shift("mul", 3, [vreg(1), lit("2")], 2),
    ]) === null);

  // Non-integer literals re-associate the chip's arithmetic, so they are
  // not folded: (x + 0.1) + 0.2 is not x + 0.30000000000000004.
  check("fractional shifts are not merged",
    foldConstantOffsets([
      shift("add", 1, [vreg(0), lit("0.1")], 0),
      shift("add", 2, [vreg(1), lit("0.2")], 1),
    ]) === null);

  // A label can be entered from anywhere, so the run ends there and the
  // second shift never finds the first as its reaching definition.
  check("folding does not cross a label",
    foldConstantOffsets([
      shift("add", 0, [vreg(0), lit("1")], 0),
      inst({ op: "label", name: "top", node: dummyNode }, 1),
      shift("add", 0, [vreg(0), lit("1")], 2),
    ]) === null);

  // Deleting the producer would strand the reader between the two.
  check("an accumulator read in between is not fused",
    foldConstantOffsets([
      shift("add", 0, [vreg(0), lit("1")], 0),
      inst({ op: "storename", name: "out", src: vreg(0), node: dummyNode }, 1),
      shift("add", 0, [vreg(0), lit("1")], 2),
    ]) === null);

  // ---------------------------- resolveLabels ---------------------------
  equal("resolveLabels rewrites a jump target",
    resolveLabels("top:\nyield\nj top"), "yield\nj 0");
  equal("resolveLabels rewrites a branch target",
    resolveLabels("bge r0 10 done\nyield\ndone:\nyield"), "bge r0 10 2\nyield\nyield");
  // the original replaced any token anywhere; a placeholder read named like
  // a label must survive untouched
  equal("resolveLabels leaves a same-named operand alone",
    resolveLabels("scale:\nj ra\nmove r0 scale"), "j ra\nmove r0 scale");
  equal("resolveLabels leaves alias/define lines alone",
    resolveLabels("alias scale d0\nscale:\nj scale"), "alias scale d0\nj 1");

  return results;
}
