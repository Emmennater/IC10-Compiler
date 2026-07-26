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
