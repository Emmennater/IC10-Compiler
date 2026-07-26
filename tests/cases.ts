/**
 * Differential test programs. Each case is compiled by the pristine
 * original, the bug-patched original, and the refactored compiler.
 *
 * Invariants checked by the runner:
 *  - refactored output === patched-original output, byte for byte, always
 *  - refactored output === pristine-original output, except for cases
 *    flagged expectOriginalDiff (which exercise a documented bug fix)
 *  - every string in `expect` appears in the refactored output
 */

import type { SyntaxNode } from "../syntax.ts";
import {
  assign, bin, bool, brk, compound, constexprDirective, cont, decl, defineStmt,
  device, deviceDecl, elifArm, elseArm, fnCall, fnDef, ifArm, ifExpr, int,
  loopExpr, name, nameProp, num, parens, program, prop, repeatUntil, ret,
  sleepStmt, slotProp, str, un, whileExpr, yieldStmt,
} from "./ast.ts";

export type TestCase = {
  name: string;
  ast: SyntaxNode;
  config?: { removeLabels?: boolean; registerOrder?: number[] };
  /** Substrings that must appear in the refactored output. */
  expect?: string[];
  /** True when the pristine original is expected to differ (documented fix). */
  expectOriginalDiff?: boolean;
};

export const CASES: TestCase[] = [
  {
    name: "constant-fold-device-write",
    ast: program(
      decl("a", bin(num(2), "+", bin(num(3), "*", num(4)))),
      assign(prop(device("d0"), "Setting"), name("a")),
    ),
    expect: ["s d0 Setting 14"],
  },
  {
    name: "placeholder-arithmetic",
    ast: program(
      assign("x", bin(name("y"), "+", num(1))),
    ),
    expect: ["move r0 y", "move x"],
  },
  {
    name: "if-else-device",
    ast: program(
      decl("x", prop(device("d0"), "Temperature")),
      ifExpr(
        ifArm(bin(name("x"), ">", num(20)),
          assign(prop(device("d1"), "Setting"), num(1))),
        elseArm(
          assign(prop(device("d1"), "Setting"), num(0))),
      ),
    ),
    expect: ["l r0 d0 Temperature"],
  },
  {
    name: "elif-chain-constant-arms",
    ast: program(
      decl("x", prop(device("d0"), "Temperature")),
      ifExpr(
        ifArm(bool(false),
          assign(prop(device("d1"), "Setting"), num(1))),
        elifArm(bin(name("x"), ">", num(1)),
          assign(prop(device("d1"), "Setting"), num(2))),
        elifArm(bool(true),
          assign(prop(device("d1"), "Setting"), num(3))),
        elseArm(
          assign(prop(device("d1"), "Setting"), num(4))),
      ),
    ),
  },
  {
    name: "while-counter",
    ast: program(
      decl("i", num(0)),
      whileExpr(bin(name("i"), "<", num(10)),
        compound("i", "+", num(1)),
        yieldStmt()),
      assign(prop(device("d0"), "Setting"), name("i")),
    ),
    // The exit branch must exist: the original folded `i < 10` with i's
    // entry constant 0 and emitted an infinite loop with no store.
    expect: ["yield", "bge r0 10", "s d0 Setting r0"],
    expectOriginalDiff: true,
  },
  {
    name: "loop-break-continue",
    ast: program(
      loopExpr(
        ifExpr(ifArm(bin(prop(device("d0"), "Activate"), "==", num(1)), brk())),
        ifExpr(ifArm(bin(prop(device("d1"), "Activate"), "==", num(1)), cont())),
        assign(prop(device("d2"), "Setting"), num(1)),
        yieldStmt()),
      assign(prop(device("d2"), "Setting"), num(0)),
    ),
  },
  {
    name: "repeat-until",
    ast: program(
      decl("n", num(0)),
      repeatUntil([
        compound("n", "+", num(1)),
        yieldStmt(),
      ], bin(name("n"), ">=", num(5))),
      assign(prop(device("d0"), "Setting"), name("n")),
    ),
  },
  {
    name: "function-jal-two-sites",
    ast: program(
      fnDef("double", ["a"], ret(bin(name("a"), "*", num(2)))),
      assign(prop(device("d0"), "Setting"), fnCall("double", num(3))),
      assign(prop(device("d1"), "Setting"), fnCall("double", prop(device("d2"), "Temperature"))),
    ),
    expect: ["jal double", "j ra"],
  },
  {
    name: "function-inline-single-site",
    ast: program(
      fnDef("clamp", ["v"],
        ifExpr(ifArm(bin(name("v"), ">", num(100)), ret(num(100)))),
        ret(name("v"))),
      assign(prop(device("d0"), "Setting"), fnCall("clamp", prop(device("d0"), "Temperature"))),
    ),
  },
  {
    name: "function-if-inside-jal-body",
    ast: program(
      fnDef("cap", ["v"],
        ifExpr(
          ifArm(bin(name("v"), ">", num(10)), ret(num(10))),
          elseArm(ret(name("v"))))),
      assign(prop(device("d0"), "Setting"), fnCall("cap", prop(device("d0"), "Temperature"))),
      assign(prop(device("d1"), "Setting"), fnCall("cap", prop(device("d1"), "Temperature"))),
    ),
  },
  {
    name: "function-writes-global",
    ast: program(
      decl("counter", num(0)),
      fnDef("bump", [],
        assign("counter", bin(name("counter"), "+", num(1))),
        ret(name("counter"))),
      assign(prop(device("d0"), "Setting"), fnCall("bump")),
      assign(prop(device("d1"), "Setting"), fnCall("bump")),
    ),
    expect: ["jal bump"],
  },
  {
    name: "constexpr-factorial",
    ast: program(
      constexprDirective(),
      fnDef("fact", ["n"],
        ifExpr(ifArm(bin(name("n"), "<=", num(1)), ret(num(1)))),
        ret(bin(name("n"), "*", fnCall("fact", bin(name("n"), "-", num(1)))))),
      assign(prop(device("d0"), "Setting"), fnCall("fact", num(5))),
    ),
    expect: ["s d0 Setting 120"],
  },
  {
    name: "aggregator-average",
    ast: program(
      decl("t", fnCall("Average", prop(name("StructureGasSensor"), "Temperature"))),
      assign(prop(device("d0"), "Setting"), name("t")),
    ),
    expect: ['lb r0 HASH("StructureGasSensor") Temperature Average'],
  },
  {
    name: "define-and-device-alias",
    ast: program(
      defineStmt("limit", num(500)),
      deviceDecl("pump", "d3"),
      ifExpr(ifArm(bin(prop(name("pump"), "Pressure"), ">", name("limit")),
        assign(prop(name("pump"), "On"), num(0)))),
    ),
    expect: ["define limit 500", "alias pump d3"],
  },
  {
    name: "mod-constant-fold-fix",
    ast: program(
      defineStmt("m", bin(num(7), "%", num(3))),
      assign(prop(device("d0"), "Setting"), name("m")),
    ),
    expect: ["define m 1"],
    expectOriginalDiff: true, // original folds 7 % 3 as 7 / 3
  },
  {
    name: "spill-under-pressure",
    config: { registerOrder: [0, 1, 2] },
    ast: program(
      decl("v1", prop(device("d0"), "Temperature")),
      decl("v2", prop(device("d1"), "Temperature")),
      decl("v3", prop(device("d2"), "Temperature")),
      decl("v4", prop(device("d3"), "Temperature")),
      decl("v5", prop(device("d4"), "Temperature")),
      yieldStmt(),
      assign(prop(device("d0"), "Setting"), name("v1")),
      assign(prop(device("d1"), "Setting"), name("v2")),
      assign(prop(device("d2"), "Setting"), name("v3")),
      assign(prop(device("d3"), "Setting"), name("v4")),
      assign(prop(device("d4"), "Setting"), name("v5")),
    ),
    expect: ["poke", "get"],
  },
  {
    // Spilling a value that is both read and written by one instruction
    // (`i += 1` -> `add home home 1`). The original redirected the
    // destination to scratch but never reloaded the use, so the counter
    // ended up reading a second, never-written stack slot every iteration.
    name: "spill-accumulator-read-write",
    config: { registerOrder: [0, 1] },
    ast: program(
      decl("i", num(0)),
      decl("a", prop(device("d0"), "Temperature")),
      decl("b", prop(device("d1"), "Temperature")),
      whileExpr(bin(name("i"), "<", num(100)),
        compound("i", "+", num(1)),
        assign(prop(device("d2"), "Setting"), bin(name("a"), "+", name("b"))),
        yieldStmt()),
      assign(prop(device("d3"), "Setting"), name("i")),
    ),
    expect: ["poke", "get"],
    expectOriginalDiff: true,
  },
  {
    name: "logical-ops-as-data",
    ast: program(
      assign("res", bin(bin(name("p"), "&&", name("q")), "||", un("!", name("r")))),
    ),
  },
  {
    name: "short-circuit-condition",
    ast: program(
      ifExpr(ifArm(
        bin(bin(name("p"), ">", num(1)), "&&", bin(name("q"), "<", num(2))),
        assign(prop(device("d0"), "Setting"), num(1)))),
      ifExpr(ifArm(
        bin(bin(name("p"), ">", num(3)), "||", bin(name("q"), "<", num(4))),
        assign(prop(device("d0"), "Setting"), num(2)))),
    ),
  },
  {
    name: "unary-operators",
    ast: program(
      assign("o1", un("-", name("p"))),
      assign("o2", un("!", name("p"))),
      assign("o3", un("+", name("p"))),
      assign("o4", un("-", parens(bin(name("p"), "+", num(2))))),
    ),
  },
  {
    name: "dead-code-eliminated",
    ast: program(
      decl("unused", bin(name("x"), "+", num(1))),
      assign(prop(device("d0"), "Setting"), num(1)),
    ),
  },
  {
    name: "slot-operations",
    ast: program(
      decl("occupied", slotProp(device("d0"), int(0), "Occupied")),
      decl("viaAlias", fnCall("loadSlot", device("d0"), num(1), name("Quantity"))),
      assign(slotProp(device("d0"), int(0), "Open"), num(1)),
      defineStmt("batts", str("StructureBattery")),
      assign(nameProp(name("batts"), str("Main"), "On"), num(1)),
      assign(prop(device("d1"), "Setting"), bin(name("occupied"), "+", name("viaAlias"))),
    ),
    expect: ["ls r", 'sbn batts HASH("Main") On 1'],
  },
  {
    name: "demotion-in-loop",
    ast: program(
      decl("mode", num(0)),
      loopExpr(
        ifExpr(
          ifArm(bin(prop(device("d0"), "Activate"), "==", num(1)), assign("mode", num(1))),
          elseArm(assign("mode", num(2)))),
        assign(prop(device("d1"), "Setting"), name("mode")),
        yieldStmt()),
    ),
  },
  {
    name: "compound-assign-device-read",
    ast: program(
      decl("total", num(0)),
      whileExpr(bin(name("total"), "<", num(100)),
        compound("total", "+", prop(device("d0"), "Temperature")),
        sleepStmt(num(1))),
      assign(prop(device("d1"), "Setting"), name("total")),
    ),
    expect: ["sleep 1", "bge"],
    expectOriginalDiff: true, // original folded the while condition to true
  },
  {
    name: "remove-labels-config",
    config: { removeLabels: true },
    ast: program(
      decl("i", num(0)),
      whileExpr(bin(name("i"), "<", num(10)),
        compound("i", "+", num(1)),
        yieldStmt()),
      assign(prop(device("d0"), "Setting"), name("i")),
    ),
    expectOriginalDiff: true, // same while-condition fix as while-counter
  },
  {
    name: "non-leaf-function-push-pop-ra",
    ast: program(
      fnDef("inner", ["x"], ret(bin(name("x"), "+", num(1)))),
      fnDef("outer", ["y"], ret(bin(fnCall("inner", name("y")), "*", num(2)))),
      assign(prop(device("d0"), "Setting"), fnCall("outer", num(1))),
      assign(prop(device("d1"), "Setting"), fnCall("outer", num(2))),
      assign(prop(device("d2"), "Setting"), fnCall("inner", num(5))),
    ),
    expect: ["push ra", "pop ra", "jal inner", "jal outer"],
  },
  {
    name: "aggregator-lbn-named-group",
    ast: program(
      decl("c", fnCall("Sum", nameProp(name("StructureBattery"), str("Main"), "Charge"))),
      assign(prop(device("d0"), "Setting"), name("c")),
    ),
    expect: ['lbn r0 HASH("StructureBattery") HASH("Main") Charge Sum'],
  },
  {
    name: "define-chains",
    ast: program(
      defineStmt("base", num(10)),
      defineStmt("aliasOfBase", name("base")),
      defineStmt("bareIdent", name("StructureFurnace")),
      defineStmt("gameConst", prop(name("LogicType"), "Temperature")),
      assign(prop(device("d0"), "Setting"), name("aliasOfBase")),
      assign(prop(device("d1"), "Setting"), name("bareIdent")),
      assign(prop(device("d2"), "Setting"), name("gameConst")),
    ),
    expect: ["define base 10", "s d1 Setting StructureFurnace", "s d2 Setting LogicType.Temperature"],
  },
  {
    name: "constexpr-bails-to-runtime",
    ast: program(
      constexprDirective(),
      fnDef("readTemp", ["scale"], ret(bin(prop(device("d5"), "Temperature"), "*", name("scale")))),
      assign(prop(device("d0"), "Setting"), fnCall("readTemp", num(2))),
    ),
    expect: ["l r0 d5 Temperature"],
  },
  {
    // A placeholder read whose name matches a generated label. The original
    // substituted *any* token equal to a label name on *any* line, turning
    // `move r0 scale` into `move r0 <lineNumber>` — a silent miscompile.
    name: "remove-labels-name-collision",
    config: { removeLabels: true },
    ast: program(
      fnDef("scale", ["v"], ret(bin(name("v"), "*", num(2)))),
      assign(prop(device("d0"), "Setting"), fnCall("scale", num(1))),
      assign(prop(device("d1"), "Setting"), fnCall("scale", num(2))),
      assign(prop(device("d2"), "Setting"), name("scale")),
    ),
    expect: ["move r0 scale"],
    expectOriginalDiff: true,
  },
  {
    // A break inside a jal-lowered function body. The original let it see
    // the loop enclosing whichever CALL SITE triggered lowering, emitting a
    // jump across the function boundary to that loop's end label (with `ra`
    // still pending) — nonsense for every other call site. Now it errors.
    name: "error-break-inside-function",
    ast: program(
      fnDef("f", [],
        ifExpr(ifArm(bin(prop(device("d0"), "Setting"), ">", num(0)), brk())),
        ret(num(1))),
      loopExpr(
        assign(prop(device("d1"), "Setting"), fnCall("f")),
        assign(prop(device("d2"), "Setting"), fnCall("f")),
        yieldStmt()),
    ),
    expect: ["ERROR: Line 0: break outside of a loop"],
    expectOriginalDiff: true,
  },
  {
    name: "error-nested-function-def",
    ast: program(
      ifExpr(ifArm(bin(prop(device("d0"), "Setting"), ">", num(0)),
        fnDef("nested", [], ret(num(1))))),
    ),
  },
  {
    name: "error-use-before-assign",
    ast: program(
      decl("u"),
      assign(prop(device("d0"), "Setting"), name("u")),
    ),
  },
  {
    name: "error-maybe-undefined",
    ast: program(
      decl("w"),
      ifExpr(ifArm(bin(prop(device("d0"), "Setting"), ">", num(0)), assign("w", num(1)))),
      assign(prop(device("d1"), "Setting"), name("w")),
    ),
  },
  {
    name: "error-break-outside-loop",
    ast: program(brk()),
  },
  {
    name: "error-recursive-function",
    ast: program(
      fnDef("r", [],
        ifExpr(ifArm(bin(prop(device("d0"), "Setting"), ">", num(0)), fnCall("r")))),
      fnCall("r"),
    ),
  },
  {
    name: "error-device-as-value",
    ast: program(
      deviceDecl("p", "d0"),
      assign("q", name("p")),
    ),
  },
];
