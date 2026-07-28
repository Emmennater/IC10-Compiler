/**
 * Source strings run through the real parser and `getFormalAST`, asserting
 * the shape of the strictly typed tree (and the errors it rejects).
 */

import { describe, expect, test } from "vitest";
import { getAST } from "../compiler/ast.ts";
import { CompileError } from "../compiler/syntax.ts";
import {
  getFormalAST,
  type Assignment,
  type Block,
  type CompoundAssignOp,
  type Declaration,
  type DefineDef,
  type DeviceDef,
  type FunctionDef,
  type If,
  type Loop,
  type Repeat,
  type Sleep,
  type Statement,
  type While,
} from "../compiler/formal-ast.ts";

function formal(source: string): Block {
  return getFormalAST(getAST(source));
}

/** The single statement of a one-statement program. */
function only(source: string): Statement {
  const block = formal(source);
  expect(block.statements).toHaveLength(1);
  return block.statements[0];
}

describe("declarations and definitions", () => {
  test("let with an initializer", () => {
    const statement = only("let x = 1") as Declaration;
    expect(statement).toMatchObject({
      type: "declaration",
      target: { type: "identifier", name: "x" },
      value: { type: "constant", value: 1 },
    });
  });

  test("let without an initializer", () => {
    const statement = only("let y") as Declaration;
    expect(statement.type).toBe("declaration");
    expect(statement.value).toBeUndefined();
    expect(statement.constant).toBe(false);
  });

  test("const is a declaration flagged constant", () => {
    const statement = only("const X = 1") as Declaration;
    expect(statement).toMatchObject({
      type: "declaration",
      target: { type: "identifier", name: "X" },
      value: { type: "constant", value: 1 },
      constant: true,
    });
  });

  test("define takes an arbitrary expression", () => {
    const statement = only("define MAX = 2 * 3") as DefineDef;
    expect(statement).toMatchObject({
      type: "definedef",
      name: { name: "MAX" },
      value: { type: "binaryop", opcode: "mul" },
    });
  });

  test("device declaration", () => {
    const statement = only("device pump = d0") as DeviceDef;
    expect(statement).toMatchObject({
      type: "devicedef",
      name: { name: "pump" },
      device: { type: "device", name: "d0" },
    });
  });

  test("preprocessor directive", () => {
    expect(only("@constexpr")).toMatchObject({
      type: "preprocessordir",
      name: "constexpr",
    });
  });
});

describe("assignment", () => {
  test("plain assignment to a variable", () => {
    expect(only("x = 1") as Assignment).toMatchObject({
      type: "assignment",
      target: { type: "identifier", name: "x" },
      value: { type: "constant", value: 1 },
    });
  });

  test("compound assignment carries the arithmetic opcode", () => {
    expect(only("x %= 2") as CompoundAssignOp).toMatchObject({
      type: "compoundassignop",
      target: { type: "identifier", name: "x" },
      opcode: "mod",
      right: { type: "constant", value: 2 },
    });
  });

  test("assignment to a device property", () => {
    const statement = only("pump.Setting = 1") as Assignment;
    expect(statement.target).toMatchObject({
      type: "deviceprop",
      device: { type: "identifier", name: "pump" },
      prop: { name: "Setting" },
    });
  });
});

describe("device properties", () => {
  test("device pin as the base", () => {
    const statement = only("x = d1.On") as Assignment;
    expect(statement.value).toMatchObject({
      type: "deviceprop",
      device: { type: "device", name: "d1" },
      prop: { name: "On" },
    });
  });

  test("channel property keeps an integer index", () => {
    const statement = only("x = pump[2].Setting") as Assignment;
    expect(statement.value).toMatchObject({
      type: "devicechannelprop",
      device: { type: "identifier", name: "pump" },
      channel: { type: "constant", value: 2 },
      prop: { name: "Setting" },
    });
  });

  test("name property with a string selector", () => {
    const statement = only('x = pump["Vent"].Setting') as Assignment;
    expect(statement.value).toMatchObject({
      type: "devicenameprop",
      name: { type: "string", value: "\"Vent\"" },
      prop: { name: "Setting" },
    });
  });

  test("name property with a variable selector", () => {
    const statement = only("x = pump[label].Setting") as Assignment;
    expect(statement.value).toMatchObject({
      type: "devicenameprop",
      name: { type: "identifier", name: "label" },
    });
  });
});

describe("expressions", () => {
  test("operators split into arithmetic, comparison and logical", () => {
    const statement = only("x = 1 + 2 < 3 && 4") as Assignment;
    expect(statement.value).toMatchObject({
      type: "logicalop",
      opcode: "and",
      left: {
        type: "comparisonop",
        opcode: "lt",
        left: { type: "binaryop", opcode: "add" },
        right: { type: "constant", value: 3 },
      },
      right: { type: "constant", value: 4 },
    });
  });

  test("parentheses are unwrapped but still regroup", () => {
    const statement = only("x = (1 + 2) * 3") as Assignment;
    expect(statement.value).toMatchObject({
      type: "binaryop",
      opcode: "mul",
      left: { type: "binaryop", opcode: "add" },
      right: { type: "constant", value: 3 },
    });
  });

  test("unary operators", () => {
    const statement = only("x = -!y") as Assignment;
    expect(statement.value).toMatchObject({
      type: "unaryop",
      opcode: "neg",
      value: { type: "unaryop", opcode: "not", value: { type: "identifier", name: "y" } },
    });
  });

  test("~ is a distinct unary operator from !", () => {
    const statement = only("x = ~y") as Assignment;
    expect(statement.value).toMatchObject({
      type: "unaryop",
      opcode: "bitnot",
      value: { type: "identifier", name: "y" },
    });
  });

  test("bitwise operators resolve to their IC10 opcodes", () => {
    const opcodeOf = (source: string): string =>
      ((only(`x = ${source}`) as Assignment).value as { opcode: string }).opcode;
    expect(opcodeOf("a & b")).toBe("and");
    expect(opcodeOf("a | b")).toBe("or");
    expect(opcodeOf("a ^ b")).toBe("xor");
    expect(opcodeOf("a << b")).toBe("sll");
    // `>>` keeps the sign bit, `>>>` does not - the JavaScript split.
    expect(opcodeOf("a >> b")).toBe("sra");
    expect(opcodeOf("a >>> b")).toBe("srl");
  });

  test("bitwise precedence follows C", () => {
    // & tighter than ^ tighter than |, and all three looser than comparison.
    const statement = only("x = 1 | 2 ^ 3 & 4 == 5") as Assignment;
    expect(statement.value).toMatchObject({
      type: "binaryop",
      opcode: "or",
      left: { type: "constant", value: 1 },
      right: {
        type: "binaryop",
        opcode: "xor",
        left: { type: "constant", value: 2 },
        right: {
          type: "binaryop",
          opcode: "and",
          left: { type: "constant", value: 3 },
          right: { type: "comparisonop", opcode: "eq" },
        },
      },
    });
  });

  test("shifts bind tighter than comparison and looser than addition", () => {
    const statement = only("x = 1 + 2 << 3 < 4") as Assignment;
    expect(statement.value).toMatchObject({
      type: "comparisonop",
      opcode: "lt",
      left: {
        type: "binaryop",
        opcode: "sll",
        left: { type: "binaryop", opcode: "add" },
        right: { type: "constant", value: 3 },
      },
    });
  });

  test("&& and || are still logical, not bitwise", () => {
    const statement = only("x = a && b") as Assignment;
    expect(statement.value).toMatchObject({ type: "logicalop", opcode: "and" });
  });

  test("compound assignment carries the bitwise opcode", () => {
    const opcodeOf = (source: string): string => (only(source) as CompoundAssignOp).opcode;
    expect(opcodeOf("x &= 1")).toBe("and");
    expect(opcodeOf("x |= 1")).toBe("or");
    expect(opcodeOf("x ^= 1")).toBe("xor");
    expect(opcodeOf("x <<= 1")).toBe("sll");
    expect(opcodeOf("x >>= 1")).toBe("sra");
    expect(opcodeOf("x >>>= 1")).toBe("srl");
  });

  test("hexadecimal and binary literals", () => {
    const valueOf = (source: string): number =>
      ((only(`x = ${source}`) as Assignment).value as { value: number }).value;
    expect(valueOf("0x1F")).toBe(31);
    expect(valueOf("0XfF")).toBe(255);
    expect(valueOf("0b1011")).toBe(11);
    expect(valueOf("0B1")).toBe(1);
    // `_` separates digits, as the game's own %0110_1000 notation does
    expect(valueOf("0xDEAD_BEEF")).toBe(3735928559);
    expect(valueOf("0b0110_1000")).toBe(104);
    // A `c` in a hex literal is a digit, not the Celsius suffix
    expect(valueOf("0x10c")).toBe(268);
  });

  test("a based literal is a 64-bit two's complement word", () => {
    const valueOf = (source: string): number =>
      ((only(`x = ${source}`) as Assignment).value as { value: number }).value;
    // Sixty-four 1 bits is -1, the reading the game documents - not 2^64 - 1
    expect(valueOf(`0b${"1".repeat(64)}`)).toBe(-1);
    expect(valueOf("0xFFFF_FFFF_FFFF_FFFF")).toBe(-1);
    // and a 32-bit mask is still positive at that width
    expect(valueOf("0xFFFFFFFF")).toBe(4294967295);
  });

  test("the c suffix converts a Celsius reading to kelvin", () => {
    const valueOf = (source: string): number =>
      ((only(`x = ${source}`) as Assignment).value as { value: number }).value;
    expect(valueOf("0c")).toBe(273.15);
    expect(valueOf("23c")).toBe(296.15);
    expect(valueOf("100C")).toBe(373.15);
    expect(valueOf("25.5c")).toBe(298.65);
    expect(valueOf("36.6c")).toBe(309.75);
  });

  test("a minus directly on a Celsius literal is part of the reading", () => {
    const valueOf = (source: string): number =>
      ((only(`x = ${source}`) as Assignment).value as { value: number }).value;
    // -40c is the temperature -40 degrees (233.15 K), not the negation of
    // what 40 degrees is in kelvin (-313.15). The raw double addition gives
    // 233.14999999999998, so this also pins the rounding.
    expect(valueOf("-40c")).toBe(233.15);
    expect(valueOf("-273.15c")).toBe(0);
    // Parentheses ask for the negation explicitly, and get it: the minus is
    // a real operation over the kelvin value, not part of the reading.
    expect((only("x = -(40c)") as Assignment).value).toMatchObject({
      type: "unaryop",
      opcode: "neg",
      value: { type: "constant", value: 313.15 },
    });
  });

  test("a minus directly on any literal folds into it", () => {
    // The sign-folding rule is not Celsius-specific: -7 is the constant -7,
    // not a negation node over 7.
    expect((only("x = -7") as Assignment).value).toMatchObject({
      type: "constant",
      value: -7,
    });
    // but a minus on anything else is still a unary operation
    expect((only("x = -y") as Assignment).value).toMatchObject({ type: "unaryop", opcode: "neg" });
  });

  test("booleans, strings and floats", () => {
    const block = formal('let a = true\nlet b = "hi\\n"\nlet c = 1.5');
    expect((block.statements[0] as Declaration).value).toMatchObject({ type: "bool", value: true });
    expect((block.statements[1] as Declaration).value).toMatchObject({ type: "string", value: "\"hi\\n\"" });
    expect((block.statements[2] as Declaration).value).toMatchObject({ type: "constant", value: 1.5 });
  });

  test("call as an expression", () => {
    const statement = only("x = foo(1, y)") as Assignment;
    expect(statement.value).toMatchObject({
      type: "functioncall",
      name: { name: "foo" },
      params: [{ type: "constant", value: 1 }, { type: "identifier", name: "y" }],
    });
  });

  test("call as a statement", () => {
    expect(only("foo()")).toMatchObject({ type: "functioncall", params: [] });
  });
});

describe("control flow", () => {
  test("if/elif/else collapses into one arm list", () => {
    const statement = only(
      "if a then\n x = 1\nelif b then\n x = 2\nelif c then\n x = 3\nelse\n x = 4\nend",
    ) as If;
    expect(statement.type).toBe("if");
    expect(statement.ifs).toHaveLength(3);
    expect(statement.ifs[1]).toMatchObject({
      type: "ifthen",
      condition: { type: "identifier", name: "b" },
      then: { type: "block", statements: [{ type: "assignment" }] },
    });
    expect(statement.else?.statements).toHaveLength(1);
  });

  test("if without an else", () => {
    const statement = only("if a then\n x = 1\nend") as If;
    expect(statement.ifs).toHaveLength(1);
    expect(statement.else).toBeUndefined();
  });

  test("loop with break and continue", () => {
    const statement = only("loop\n break\n continue\nend") as Loop;
    expect(statement.type).toBe("loop");
    expect(statement.body.statements.map(s => s.type)).toEqual(["break", "continue"]);
  });

  test("while", () => {
    const statement = only("while i < 10 do\n i += 1\nend") as While;
    expect(statement).toMatchObject({
      type: "while",
      condition: { type: "comparisonop", opcode: "lt" },
      body: { statements: [{ type: "compoundassignop" }] },
    });
  });

  test("repeat/until", () => {
    const statement = only("repeat\n i += 1\nuntil i == 3") as Repeat;
    expect(statement).toMatchObject({
      type: "repeat",
      until: { type: "comparisonop", opcode: "eq" },
      body: { statements: [{ type: "compoundassignop" }] },
    });
  });

  test("an empty body is an empty block, not a missing one", () => {
    const statement = only("loop\nend") as Loop;
    expect(statement.body.statements).toEqual([]);
    expect(statement.body.from).toBe(statement.body.to);
  });
});

describe("instructions and functions", () => {
  test("yield takes no operand", () => {
    expect(only("yield")).toMatchObject({ type: "yield" });
  });

  test("sleep takes a duration", () => {
    expect(only("sleep 1 + 1") as Sleep).toMatchObject({
      type: "sleep",
      duration: { type: "binaryop", opcode: "add" },
    });
  });

  test("function definition with arguments and a return", () => {
    const statement = only("fn add(a, b)\n return a + b\nend") as FunctionDef;
    expect(statement).toMatchObject({
      type: "functiondef",
      name: { name: "add" },
      args: [{ name: "a" }, { name: "b" }],
      body: { statements: [{ type: "return", value: { type: "binaryop", opcode: "add" } }] },
    });
  });

  test("function definition with no arguments and an empty body", () => {
    const statement = only("fn noop()\nend") as FunctionDef;
    expect(statement.args).toEqual([]);
    expect(statement.body.statements).toEqual([]);
  });
});

describe("ranges and errors", () => {
  test("every node carries its source range", () => {
    const source = "let x = 41 + 1";
    const statement = only(source) as Declaration;
    expect(source.slice(statement.from, statement.to)).toBe(source);
    expect(source.slice(statement.target.from, statement.target.to)).toBe("x");
    const value = statement.value!;
    expect(source.slice(value.from, value.to)).toBe("41 + 1");
  });

  test("a syntax error is rejected instead of silently dropped", () => {
    expect(() => formal("let = = 1")).toThrow(CompileError);
  });

  test("an empty program is an empty block", () => {
    expect(formal("")).toMatchObject({ type: "block", statements: [] });
  });

  test("comments are not statements", () => {
    const block = formal("# a comment\nlet x = 1 # trailing\n");
    expect(block.statements.map(s => s.type)).toEqual(["declaration"]);
  });
});
