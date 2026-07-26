/**
 * Unit tests for the leaf libraries.
 *
 * These exist to demonstrate — not merely assert — that each library stands
 * on its own: every test below constructs its subject directly and needs no
 * AST, no compiler, and no knowledge of the pipeline. Anything that needs a
 * whole `compile()` call belongs in the differential suite instead.
 */

import { ErrorReporter, kids } from "../compiler/syntax.ts";
import { applyArithmetic, compare, ic10Mod } from "../compiler/tables.ts";
import {
  IdAllocator, assertNever, constOp, destOf, operandsOf, usesOf, hasSideEffect, symsOf,
} from "../compiler/ir.ts";
import { LabelFactory } from "../compiler/labels.ts";
import { StatementScope } from "../compiler/statement-scope.ts";
import { foldExpression, foldTruthy, pressure } from "../compiler/folding.ts";
import { ScopeChain, type Scope } from "../compiler/symbols.ts";
import { resolveLabels } from "../compiler/render.ts";
import { convergeLiveness } from "../compiler/liveness.ts";
import type { Inst, UnnumberedInst } from "../compiler/ir.ts";
import type { SyntaxNode } from "../compiler/syntax.ts";
import type {
  ArithmeticOpcode, BinaryOp, ComparisonOp, ComparisonOpcode, Constant, Expression,
  Identifier, LogicalOp, StringExpr, UnaryOp,
} from "../compiler/formal-ast.ts";
import { node, num } from "./ast.ts";

export type UnitResult = { name: string; pass: boolean; detail?: string };

const results: UnitResult[] = [];

function check(label: string, condition: boolean, detail?: string): void {
  results.push({ name: label, pass: condition, detail: condition ? undefined : detail });
}

function equal<T>(label: string, actual: T, expected: T): void {
  const same = JSON.stringify(actual) === JSON.stringify(expected);
  check(label, same, same ? undefined : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
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
// directly in it — no parser, no conversion, no pipeline.
const at = { from: 0, to: 0 };
const k = (value: number): Constant => ({ type: "constant", ...at, value });
const id = (name: string): Identifier => ({ type: "identifier", ...at, name });
const text = (value: string): StringExpr => ({ type: "string", ...at, value: `"${value}"` });
const arith = (left: Expression, opcode: ArithmeticOpcode, right: Expression): BinaryOp =>
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

  // late declarations in a SHARED scope are visible through both chains —
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
  // the back edge — the case a single backward sweep gets wrong.
  const loopProgram: Inst[] = [
    inst({ op: "movev", dest: 0, src: { kind: "const", text: "1" }, node: dummyNode }, 0),
    inst({ op: "label", name: "top", node: dummyNode }, 1),
    inst({ op: "storename", name: "out", src: { kind: "vreg", id: 0 }, node: dummyNode }, 2),
    inst({ op: "jump", target: "top", node: dummyNode }, 3),
  ];
  const live = convergeLiveness(loopProgram);
  check("value used in a loop body is live at the loop head",
    live.liveAtLabel.get("top")?.has(0) === true);

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
