// Compiler regression tests: node test.mjs
import { getAST } from "./ast.js";
import { compile, CompileError } from "./compiler.ts";

const cases = [
  {
    name: "variables and passthrough identifiers",
    source: "let x = a + b\nlet y = x * 2\nc = y - x",
    expected: "add r10 a b\nmul r11 r10 2\nsub c r11 r10",
  },
  {
    name: "constant folding",
    source: "let x = 2 * 2 + 3\nlet y = -2",
    expected: "move r10 7\nmove r11 -2",
  },
  {
    name: "algebraic identities are free",
    source: "let x = 5\nlet y = x * 1\nlet z = (x + 0) / 1",
    expected: "move r10 5\nmove r11 r10\nmove r12 r10",
  },
  {
    name: "operands used directly, no moves for constants",
    source: "let x = 1\nx = x + 1",
    expected: "move r10 1\nadd r10 r10 1",
  },
  {
    name: "temporaries are reused",
    source: "c = (a + b) * (d - e)",
    expected: "add r0 a b\nsub r1 d e\nmul c r0 r1",
  },
  {
    name: "right-nested chain needs one temp (Sethi-Ullman)",
    source: "let x = a - (b - (c - (d - e)))",
    expected: "sub r0 d e\nsub r0 c r0\nsub r0 b r0\nsub r10 a r0",
  },
  {
    name: "unary minus of non-constant",
    source: "let x = -y",
    expected: "sub r10 0 y",
  },
  {
    name: "declaration without initializer emits nothing",
    source: "let x\nx = 42",
    expected: "move r10 42",
  },
  {
    name: "comments are dropped",
    source: "# header\nlet x = 1 # trailing",
    expected: "move r10 1",
  },
  {
    name: "non-finite folds are left to the game",
    source: "let x = 1 / 0",
    expected: "div r10 1 0",
  },
  {
    name: "redeclaration is an error",
    source: "let x = 1\nlet x = 2",
    error: "Line 1: x was already defined",
  },
  {
    name: "running out of variable registers is an error",
    source: "let a=1\nlet b=1\nlet c=1\nlet d=1\nlet e=1\nlet f=1\nlet g=1",
    error: "Line 6: Too many variables: only 6 registers (r10-r15) are available",
  },
  {
    name: "syntax errors are reported",
    source: "let = 3",
    error: "Line 0: Syntax error",
  },
];

let failures = 0;

for (const { name, source, expected, error } of cases) {
  let actual;
  try {
    actual = compile(getAST(source));
  } catch (e) {
    if (!(e instanceof CompileError)) throw e;
    actual = e;
  }

  const ok = actual instanceof CompileError
    ? actual.message === error
    : actual === expected;

  if (ok) {
    console.log(`PASS ${name}`);
  } else {
    failures++;
    console.log(`FAIL ${name}`);
    console.log(`  expected: ${JSON.stringify(error ?? expected)}`);
    console.log(`  actual:   ${JSON.stringify(actual instanceof CompileError ? actual.message : actual)}`);
  }
}

console.log(`\n${cases.length - failures}/${cases.length} passed`);
process.exit(failures > 0 ? 1 : 0);
