/**
 * Differential test programs. Each case is source text, parsed once with the
 * frozen pre-Value grammar (ast-original.ts) for the pristine original
 * compiler and once with the current grammar (compiler/ast.ts) for the
 * refactor, then the two outputs are compared. Source text is the only
 * shared representation between the two grammars; original.ts hardcodes the
 * old node shapes (DeviceProperty et al.) and can never learn the new one, so
 * this is the only way to keep the byte-for-byte oracle comparison alive
 * across a grammar change without hand-authoring two trees per case.
 *
 * Invariants checked by the runner:
 *  - refactored output === pristine-original output, byte for byte, except
 *    for cases flagged expectOriginalDiff (which exercise a documented fix)
 *  - every flagged case instead pins its full output with `expected`, since
 *    the oracle cannot ratify a deliberate divergence from it
 *  - every string in `expect` appears in the refactored output
 *
 * There used to be a third run against original-patched.ts - the original
 * carrying only the documented fixes - so that flagged cases still had a
 * byte-for-byte oracle. Keeping a 2,800-line legacy compiler in step with
 * every new fix and optimization cost more than it caught, so the flagged
 * cases now carry goldens (captured from that patched compiler before it was
 * removed) and the pristine original stays as the oracle everywhere else.
 */

export type TestCase = {
  name: string;
  source: string | string[];
  config?: { removeLabels?: boolean; registerOrder?: number[] };
  /** Substrings that must appear in the refactored output. */
  expect?: string[];
  /**
   * Exact expected output, asserted byte for byte. Required on every case
   * flagged expectOriginalDiff: the pristine original disagrees there by
   * design, so this golden is that case's only full-output check.
   */
  expected?: string | string[];
  /** True when the pristine original is expected to differ (documented fix). */
  expectOriginalDiff?: boolean;
};

export const CASES: TestCase[] = [
  {
    name: "constant-fold-device-write",
    source: [
      "let a = 2 + 3 * 4",
      "d0.Setting = a",
    ],
    expect: ["s d0 Setting 14"],
  },
  {
    name: "placeholder-arithmetic",
    source: "x = y + 1",
    expect: ["move r0 y", "add r0 r0 1", "move x r0"],
  },
  {
    name: "if-else-device",
    source: [
      "let x = d0.Temperature",
      "if x > 20 then",
      "  d1.Setting = 1",
      "else",
      "  d1.Setting = 0",
      "end",
    ],
    expect: ["l r0 d0 Temperature"],
  },
  {
    name: "elif-chain-constant-arms",
    source: [
      "let x = d0.Temperature",
      "if false then",
      "  d1.Setting = 1",
      "elif x > 1 then",
      "  d1.Setting = 2",
      "elif true then",
      "  d1.Setting = 3",
      "else",
      "  d1.Setting = 4",
      "end",
    ],
  },
  {
    name: "while-counter",
    source: [
      "let i = 0",
      "while i < 10 do",
      "  i += 1",
      "  yield",
      "end",
      "d0.Setting = i",
    ],
    // The exit branch must exist: the original folded `i < 10` with i's
    // entry constant 0 and emitted an infinite loop with no store.
    expect: ["yield", "bge r0 10", "s d0 Setting r0"],
    expected: [
      "move r0 0",
      "while0:",
      "bge r0 10 endwhile0",
      "add r0 r0 1",
      "yield",
      "j while0",
      "endwhile0:",
      "s d0 Setting r0",
    ],
    expectOriginalDiff: true,
  },
  {
    name: "loop-break-continue",
    source: [
      "loop",
      "  if d0.Activate == 1 then",
      "    break",
      "  end",
      "  if d1.Activate == 1 then",
      "    continue",
      "  end",
      "  d2.Setting = 1",
      "  yield",
      "end",
      "d2.Setting = 0",
    ],
  },
  {
    name: "repeat-until",
    source: [
      "let n = 0",
      "repeat",
      "  n += 1",
      "  yield",
      "until n >= 5",
      "d0.Setting = n",
    ],
  },
  {
    name: "function-jal-two-sites",
    source: [
      "fn double(a)",
      "  return a * 2",
      "end",
      "d0.Setting = double(3)",
      "d1.Setting = double(d2.Temperature)",
    ],
    expect: ["jal double", "j ra"],
  },
  {
    name: "function-inline-single-site",
    source: [
      "fn clamp(v)",
      "  if v > 100 then",
      "    return 100",
      "  end",
      "  return v",
      "end",
      "d0.Setting = clamp(d0.Temperature)",
    ],
  },
  {
    name: "function-if-inside-jal-body",
    source: [
      "fn cap(v)",
      "  if v > 10 then",
      "    return 10",
      "  else",
      "    return v",
      "  end",
      "end",
      "d0.Setting = cap(d0.Temperature)",
      "d1.Setting = cap(d1.Temperature)",
    ],
  },
  {
    name: "function-writes-global",
    source: [
      "let counter = 0",
      "fn bump()",
      "  counter = counter + 1",
      "  return counter",
      "end",
      "d0.Setting = bump()",
      "d1.Setting = bump()",
    ],
    expect: ["jal bump"],
  },
  {
    name: "constexpr-factorial",
    source: [
      "@constexpr",
      "fn fact(n)",
      "  if n <= 1 then",
      "    return 1",
      "  end",
      "  return n * fact(n - 1)",
      "end",
      "d0.Setting = fact(5)",
    ],
    expect: ["s d0 Setting 120"],
  },
  {
    name: "aggregator-average",
    source: [
      "let t = Average(StructureGasSensor.Temperature)",
      "d0.Setting = t",
    ],
    expect: ['lb r0 HASH("StructureGasSensor") Temperature Average'],
  },
  {
    name: "define-and-device-alias",
    source: [
      "define limit = 500",
      "device pump = d3",
      "if pump.Pressure > limit then",
      "  pump.On = 0",
      "end",
    ],
    expect: ["define limit 500", "alias pump d3"],
  },
  {
    name: "mod-constant-fold-fix",
    source: [
      "define m = 7 % 3",
      "d0.Setting = m",
    ],
    expect: ["define m 1"],
    expected: ["define m 1", "s d0 Setting m"],
    expectOriginalDiff: true, // original folds 7 % 3 as 7 / 3
  },
  {
    name: "spill-under-pressure",
    config: { registerOrder: [0, 1, 2] },
    source: [
      "let v1 = d0.Temperature",
      "let v2 = d1.Temperature",
      "let v3 = d2.Temperature",
      "let v4 = d3.Temperature",
      "let v5 = d4.Temperature",
      "yield",
      "d0.Setting = v1",
      "d1.Setting = v2",
      "d2.Setting = v3",
      "d3.Setting = v4",
      "d4.Setting = v5",
    ],
    expect: ["poke", "get"],
  },
  {
    // Spilling a value that is both read and written by one instruction
    // (`i += 1` -> `add home home 1`). The original redirected the
    // destination to scratch but never reloaded the use, so the counter
    // ended up reading a second, never-written stack slot every iteration.
    name: "spill-accumulator-read-write",
    config: { registerOrder: [0, 1] },
    source: [
      "let i = 0",
      "let a = d0.Temperature",
      "let b = d1.Temperature",
      "while i < 100 do",
      "  i += 1",
      "  d2.Setting = a + b",
      "  yield",
      "end",
      "d3.Setting = i",
    ],
    expect: ["poke", "get"],
    expected: [
      "l r0 d0 Temperature",
      "l r1 d1 Temperature",
      "poke 510 r1",
      "move r1 0",
      "poke 511 r1",
      "while0:",
      "get r1 db 511",
      "bge r1 100 endwhile0",
      "get r1 db 511",
      "add r1 r1 1",
      "poke 511 r1",
      "get r1 db 510",
      "add r1 r0 r1",
      "s d2 Setting r1",
      "yield",
      "j while0",
      "endwhile0:",
      "get r0 db 511",
      "s d3 Setting r0",
    ],
    expectOriginalDiff: true,
  },
  {
    name: "logical-ops-as-data",
    source: "res = p && q || !r",
  },
  {
    name: "short-circuit-condition",
    source: [
      "if p > 1 && q < 2 then",
      "  d0.Setting = 1",
      "end",
      "if p > 3 || q < 4 then",
      "  d0.Setting = 2",
      "end",
    ],
  },
  {
    name: "unary-operators",
    source: [
      "o1 = -p",
      "o2 = !p",
      "o3 = +p",
      "o4 = -(p + 2)",
    ],
    // fix 8: `-(p + 2)` lowers to `add r0 r0 2` then the `sub r0 0 r0` of
    // unary minus - a shift feeding a reflection, so the two compose into
    // `sub r0 -2 r0`. The pristine original keeps both.
    expect: ["sub r0 -2 r0"],
    expected: [
      "move r0 p",
      "sub r0 0 r0",
      "move o1 r0",
      "move r0 p",
      "seqz r0 r0",
      "move o2 r0",
      "move r0 p",
      "move o3 r0",
      "move r0 p",
      "sub r0 -2 r0",
      "move o4 r0",
    ],
    expectOriginalDiff: true,
  },
  {
    name: "dead-code-eliminated",
    source: [
      "let unused = x + 1",
      "d0.Setting = 1",
    ],
  },
  {
    name: "slot-operations",
    source: [
      "let occupied = d0[0].Occupied",
      "let viaAlias = loadSlot(d0, 1, Quantity)",
      "d0[0].Open = 1",
      'define batts = "StructureBattery"',
      'batts["Main"].On = 1',
      "d1.Setting = occupied + viaAlias",
    ],
    expect: ["ls r", 'sbn batts HASH("Main") On 1'],
  },
  {
    name: "demotion-in-loop",
    source: [
      "let mode = 0",
      "loop",
      "  if d0.Activate == 1 then",
      "    mode = 1",
      "  else",
      "    mode = 2",
      "  end",
      "  d1.Setting = mode",
      "  yield",
      "end",
    ],
  },
  {
    name: "compound-assign-device-read",
    source: [
      "let total = 0",
      "while total < 100 do",
      "  total += d0.Temperature",
      "  sleep 1",
      "end",
      "d1.Setting = total",
    ],
    expect: ["sleep 1", "bge"],
    expected: [
      "move r0 0",
      "while0:",
      "bge r0 100 endwhile0",
      "l r1 d0 Temperature",
      "add r0 r0 r1",
      "sleep 1",
      "j while0",
      "endwhile0:",
      "s d1 Setting r0",
    ],
    expectOriginalDiff: true, // original folded the while condition to true
  },
  {
    name: "remove-labels-config",
    config: { removeLabels: true },
    source: [
      "let i = 0",
      "while i < 10 do",
      "  i += 1",
      "  yield",
      "end",
      "d0.Setting = i",
    ],
    expected: [
      "move r0 0",
      "bge r0 10 5",
      "add r0 r0 1",
      "yield",
      "j 1",
      "s d0 Setting r0",
    ],
    expectOriginalDiff: true, // same while-condition fix as while-counter
  },
  {
    name: "non-leaf-function-push-pop-ra",
    source: [
      "fn inner(x)",
      "  return x + 1",
      "end",
      "fn outer(y)",
      "  return inner(y) * 2",
      "end",
      "d0.Setting = outer(1)",
      "d1.Setting = outer(2)",
      "d2.Setting = inner(5)",
    ],
    expect: ["push ra", "pop ra", "jal inner", "jal outer"],
  },
  {
    name: "aggregator-lbn-named-group",
    source: [
      'let c = Sum(StructureBattery["Main"].Charge)',
      "d0.Setting = c",
    ],
    expect: ['lbn r0 HASH("StructureBattery") HASH("Main") Charge Sum'],
  },
  {
    name: "define-chains",
    source: [
      "define base = 10",
      "define aliasOfBase = base",
      "define bareIdent = StructureFurnace",
      "define gameConst = LogicType.Temperature",
      "d0.Setting = aliasOfBase",
      "d1.Setting = bareIdent",
      "d2.Setting = gameConst",
    ],
    expect: ["define base 10", "s d1 Setting StructureFurnace", "s d2 Setting LogicType.Temperature"],
  },
  {
    name: "constexpr-bails-to-runtime",
    source: [
      "@constexpr",
      "fn readTemp(scale)",
      "  return d5.Temperature * scale",
      "end",
      "d0.Setting = readTemp(2)",
    ],
    expect: ["l r0 d5 Temperature"],
  },
  {
    // A placeholder read whose name matches a generated label. The original
    // substituted *any* token equal to a label name on *any* line, turning
    // `move r0 scale` into `move r0 <lineNumber>` - a silent miscompile.
    name: "remove-labels-name-collision",
    config: { removeLabels: true },
    source: [
      "fn scale(v)",
      "  return v * 2",
      "end",
      "d0.Setting = scale(1)",
      "d1.Setting = scale(2)",
      "d2.Setting = scale",
    ],
    expect: ["move r0 scale"],
    expected: [
      "j 3",
      "mul r0 r0 2",
      "j ra",
      "move r0 1",
      "jal 1",
      "s d0 Setting r0",
      "move r0 2",
      "jal 1",
      "s d1 Setting r0",
      "move r0 scale",
      "s d2 Setting r0",
    ],
    expectOriginalDiff: true,
  },
  {
    // A break inside a jal-lowered function body. The original let it see
    // the loop enclosing whichever CALL SITE triggered lowering, emitting a
    // jump across the function boundary to that loop's end label (with `ra`
    // still pending) - nonsense for every other call site. Now it errors.
    name: "error-break-inside-function",
    source: [
      "fn f()",
      "  if d0.Setting > 0 then",
      "    break",
      "  end",
      "  return 1",
      "end",
      "loop",
      "  d1.Setting = f()",
      "  d2.Setting = f()",
      "  yield",
      "end",
    ],
    expect: ["ERROR: Line 2: break outside of a loop"],
    expected: "ERROR: Line 2: break outside of a loop",
    expectOriginalDiff: true,
  },
  {
    name: "error-nested-function-def",
    source: [
      "if d0.Setting > 0 then",
      "  fn nested()",
      "    return 1",
      "  end",
      "end",
    ],
  },
  {
    name: "error-use-before-assign",
    source: [
      "let u",
      "d0.Setting = u",
    ],
  },
  {
    name: "error-maybe-undefined",
    source: [
      "let w",
      "if d0.Setting > 0 then",
      "  w = 1",
      "end",
      "d1.Setting = w",
    ],
  },
  {
    name: "error-break-outside-loop",
    source: "break",
  },
  {
    name: "error-recursive-function",
    source: [
      "fn r()",
      "  if d0.Setting > 0 then",
      "    r()",
      "  end",
      "end",
      "r()",
    ],
  },
  {
    name: "error-device-as-value",
    source: [
      "device p = d0",
      "q = p",
    ],
  },
  // ------------------- fix 8: constant offset folding --------------------
  // The pristine original has no such pass and emits one instruction per
  // link of the chain, so all three cases below flag expectOriginalDiff.
  {
    name: "fold-offsets-accumulator",
    // Both shifts write the register the previous one wrote, so folding
    // has to delete the producer, not just redirect the read.
    source: [
      "let x = a",
      "x += 1",
      "x += 1",
      "b = x",
    ],
    expect: ["move r0 a", "add r0 r0 2", "move b r0"],
    expected: ["move r0 a", "add r0 r0 2", "move b r0"],
    expectOriginalDiff: true,
  },
  {
    name: "fold-offsets-through-temporaries",
    // Each shift writes a fresh temporary, so the consumer reads the
    // producer's carrier instead and dead code elimination retires the
    // producers. The two deltas also cancel in sign: -2 then +3 is +1.
    source: [
      "let x = a",
      "b = x - 2 + 3",
    ],
    expect: ["move r0 a", "add r0 r0 1", "move b r0"],
    expected: ["move r0 a", "add r0 r0 1", "move b r0"],
    expectOriginalDiff: true,
  },
  {
    name: "fold-offsets-into-a-reflection",
    // `sub r0 511 r0` reflects rather than shifts, so composing it with
    // the shift feeding it flips that shift's sign: 511 - (a + 1) is
    // 510 - a. This is the shape list address arithmetic lowers to.
    source: [
      "let y = a + 1",
      "z = 511 - y",
    ],
    expect: ["move r0 a", "sub r0 510 r0", "move z r0"],
    expected: ["move r0 a", "sub r0 510 r0", "move z r0"],
    expectOriginalDiff: true,
  },
  {
    name: "fold-offsets-cancelling-to-a-copy",
    // A chain summing to zero is a copy, so it renders as `move`, never
    // as `add r0 r0 0`.
    source: [
      "let x = a",
      "b = x + 2 - 2",
    ],
    expect: ["move r0 a", "move b r0"],
    expected: ["move r0 a", "move b r0"],
    expectOriginalDiff: true,
  },
];
