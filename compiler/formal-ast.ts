/**
 * A formalized version of the abstract syntax tree using strict typing.
 *
 * `ast.ts` hands back the raw Lezer concrete syntax tree: every keyword,
 * bracket and comma is a node, blocks are inlined into their container, and
 * every field lookup is a `children.find(...)` against a string type name.
 * `getFormalAST` walks that tree once and produces a discriminated union
 * where each node carries exactly the fields the grammar guarantees it has.
 *
 * Punctuation and keywords are dropped, `Parens` is unwrapped, and the
 * grammar's three overlapping "operator" productions are split by what the
 * operator actually means (`BinaryOp` / `ComparisonOp` / `LogicalOp`), so a
 * consumer switching on `type` gets exhaustiveness from the compiler.
 *
 * Every node keeps its source `Range` so diagnostics can still point at the
 * original text.
 */

import {
  CompileError,
  EXPRESSION_TYPES,
  STATEMENT_TYPES,
  kids,
  type SourceRange,
  type SyntaxNode,
} from "./syntax.ts";

// Types
/**
 * The source span every node carries. Shared with the raw parse tree, so a
 * formal node can be handed to anything that only wants a position: the
 * error reporter, and the `node` field of an IR instruction.
 */
export type Range = SourceRange;

export type FormalSyntaxNode =
  | Block
  | Statement
  | Expression
  | IfThen;

export type Statement =
  | Declaration
  | Assignment
  | CompoundAssignOp
  | If
  | Loop
  | While
  | Repeat
  | For
  | ForIn
  | ForOf
  | Break
  | Continue
  | Yield
  | Sleep
  | Return
  | DefineDef
  | DeviceDef
  | StackDeclaration
  | PreprocessorDir
  | FunctionDef
  | FunctionCall
  | ArrayDeclaration
  | Import;

export type Expression =
  | Identifier
  | Constant
  | Bool
  | StringExpr
  | DeviceProp
  | DeviceChannelProp
  | DeviceNameProp
  | BinaryOp
  | UnaryOp
  | ComparisonOp
  | LogicalOp
  | TernaryOp
  | Device
  | FunctionCall
  | ListIndexing;

// Used for error handling when a switch case
// consumes all types.
export type Dummy = Range & {
  type: "dummy";
};

// Blocks
export type Block = Range & {
  type: "block";
  statements: Statement[];
};

// Statements
// let <identifier> [= <expression>], or const <identifier> = <expression>
export type Declaration = Range & {
  type: "declaration";
  target: Identifier;
  value?: Expression;
  /** Declared with `const`: reassigning the name is an error. */
  constant: boolean;
};

/** Anything the grammar accepts on the left of `=` or `+=`. */
export type AssignTarget = Identifier | DeviceProp | DeviceChannelProp | DeviceNameProp | ListIndexing;

// x = <expression>
export type Assignment = Range & {
  type: "assignment";
  target: AssignTarget;
  value: Expression;
};

// x <op>= <expression>
export type CompoundAssignOp = Range & {
  type: "compoundassignop";
  target: AssignTarget;
  right: Expression;
  opcode: BinaryOpcode;
};

// if <expression> then <block> elif <expression> then <block> else <block> end
export type If = Range & {
  type: "if";
  /** The `if` arm followed by each `elif` arm, in source order. */
  ifs: IfThen[];
  else?: Block;
};

// if <expression> then <block>
export type IfThen = Range & {
  type: "ifthen";
  condition: Expression;
  then: Block;
};

// loop <block> end
export type Loop = Range & {
  type: "loop";
  body: Block;
};

// while <expression> do <block> end
export type While = Range & {
  type: "while";
  condition: Expression;
  body: Block;
};

// repeat <block> until <expression>
export type Repeat = Range & {
  type: "repeat";
  until: Expression;
  body: Block;
};

// for <statement>, <expression>, <statement> do <block> end
export type For = Range & {
  type: "for";
  init?: Statement;
  condition?: Expression;
  update?: Statement;
  body: Block;
};

// for let <identifier> in <expression> do <block> end
export type ForIn = Range & {
  type: "forin";
  decl: Declaration;
  list: Identifier;
  body: Block;
};

// for let <identifier> of <expression> do <block> end
export type ForOf = Range & {
  type: "forof";
  decl: Declaration;
  list: Identifier;
  body: Block;
};

// break
export type Break = Range & {
  type: "break";
};

// continue
export type Continue = Range & {
  type: "continue";
};

// yield
export type Yield = Range & {
  type: "yield";
};

// sleep <expression>
export type Sleep = Range & {
  type: "sleep";
  duration: Expression;
};

// return <expression>
export type Return = Range & {
  type: "return";
  value: Expression;
};

// define <identifier> = <expression>
export type DefineDef = Range & {
  type: "definedef";
  name: Identifier;
  value: Expression;
};

// device <identifier> = <device>
export type DeviceDef = Range & {
  type: "devicedef";
  name: Identifier;
  device: Device;
};

// stack <identifier> = <expression>
export type StackDeclaration = Range & {
  type: "stackdeclaration";
  name: Identifier;
  value?: Expression;
}

// let <identifier> = [<expression>, ...]
export type ArrayDeclaration = Range & {
  type: "arraydeclaration";
  name: Identifier;
  size: Expression;
  list?: List;
}

// [<expression>, ...]
export type List = Range & {
  type: "list";
  elements: Expression[];
};

// @<identifier>
export type PreprocessorDir = Range & {
  type: "preprocessordir";
  name: string;
};

// fn <identifier>(<identifier>, ...) <block> end
export type FunctionDef = Range & {
  type: "functiondef";
  name: Identifier;
  args: Identifier[];
  body: Block;
};

export type Import = Range & {
  type: "import";
  name: Identifier;
  path: StringExpr;
  device?: Device;
};

// Expressions
// <identifier>
export type Identifier = Range & {
  type: "identifier";
  name: string;
};

// <number>
export type Constant = Range & {
  type: "constant";
  value: number;
};

// <bool>
export type Bool = Range & {
  type: "bool";
  value: boolean;
};

// <string>
export type StringExpr = Range & {
  type: "string";
  /** The decoded contents: quotes stripped and escapes resolved. */
  value: string;
};

// <identifier | device>.<identifier>
export type DeviceProp = Range & {
  type: "deviceprop";
  device: Device | Identifier;
  prop: Identifier;
};

// <identifier | device>[<integer>].<identifier>
export type DeviceChannelProp = Range & {
  type: "devicechannelprop";
  device: Device | Identifier;
  channel: Constant;
  prop: Identifier;
};

// <identifier | device>[<identifier | string>].<identifier>
export type DeviceNameProp = Range & {
  type: "devicenameprop";
  device: Device | Identifier;
  name: Identifier | StringExpr;
  prop: Identifier;
};

// <identifier>[<expression>]
export type ListIndexing = Range & {
  type: "listindexing";
  list: Identifier;
  index: Expression;
}

export type ArithmeticOpcode = "add" | "sub" | "mul" | "div" | "mod";

/**
 * IC10's bitwise instructions, as reached from an operator. The chip converts
 * both operands to 64-bit two's complement integers first, so these are
 * integer operations even though a register holds a double.
 *
 * Only the six an operator can produce are listed - `nor` and `sla` have no
 * spelling in this language and are reached, like any other opcode, by
 * calling them directly (`nor(a, b)`).
 */
export type BitwiseOpcode = "and" | "or" | "xor" | "sll" | "srl" | "sra";

/** Everything a binary operator or a compound assignment can resolve to. */
export type BinaryOpcode = ArithmeticOpcode | BitwiseOpcode;

// <expression> <op> <expression>
export type BinaryOp = Range & {
  type: "binaryop";
  left: Expression;
  right: Expression;
  opcode: BinaryOpcode;
};

// <op> <expression>
export type UnaryOp = Range & {
  type: "unaryop";
  value: Expression;
  /**
   * `pos` is unary `+`, which the grammar accepts and which is identity.
   * `not` is logical `!` (an exact 0/1); `bitnot` is `~`, IC10's `not`.
   */
  opcode: "neg" | "pos" | "not" | "bitnot";
};

export type ComparisonOpcode = "eq" | "ne" | "lt" | "le" | "gt" | "ge";

// <expression> <op> <expression>
export type ComparisonOp = Range & {
  type: "comparisonop";
  left: Expression;
  right: Expression;
  opcode: ComparisonOpcode;
};

// <expression> <op> <expression>
export type LogicalOp = Range & {
  type: "logicalop";
  left: Expression;
  right: Expression;
  opcode: "and" | "or";
};

// <expression> ? <expression> : <expression>
/**
 * The field names match `IfThen`'s deliberately - it is the same three parts
 * in expression position - but this is *not* control flow: IC10's `select`
 * takes both results as operands, so both arms are evaluated.
 */
export type TernaryOp = Range & {
  type: "ternaryop";
  condition: Expression;
  then: Expression;
  else: Expression;
};

export type DevicePin = "d0" | "d1" | "d2" | "d3" | "d4" | "d5" | "db";

// <device>
export type Device = Range & {
  type: "device";
  name: DevicePin;
};

// <identifier>(<expression>, ...)
export type FunctionCall = Range & {
  type: "functioncall";
  name: Identifier;
  params: Expression[];
};

// Operator tables. Keyed by the operator's source text; the value type is
// what splits the grammar's single `BinaryOp` production three ways.
const BINARY_OPS: Record<string, BinaryOpcode | undefined> = {
  "+": "add", "-": "sub", "*": "mul", "/": "div", "%": "mod",
  // `>>` keeps the sign bit and `>>>` does not, the same split JavaScript
  // makes; IC10 spells them `sra` and `srl`.
  "&": "and", "|": "or", "^": "xor", "<<": "sll", ">>": "sra", ">>>": "srl",
};

const COMPARISON_OPS: Record<string, ComparisonOpcode | undefined> = {
  "==": "eq", "!=": "ne", "<": "lt", "<=": "le", ">": "gt", ">=": "ge",
};

const LOGICAL_OPS: Record<string, LogicalOp["opcode"] | undefined> = {
  "&&": "and", "||": "or",
};

const UNARY_OPS: Record<string, UnaryOp["opcode"] | undefined> = {
  "-": "neg", "+": "pos", "!": "not", "~": "bitnot",
};

const DEVICE_PINS: ReadonlySet<string> = new Set<DevicePin>([
  "d0", "d1", "d2", "d3", "d4", "d5", "db",
]);

/**
 * Zero Celsius in kelvin. Every temperature the chip reads or writes is in
 * kelvin, so a `c`-suffixed literal is converted once, here, and nothing
 * downstream ever sees a Celsius value.
 */
const KELVIN_AT_ZERO_CELSIUS = 273.15;

/**
 * The value a numeric literal token stands for. Four spellings:
 *
 *     42        decimal            0x2a    hexadecimal
 *     0b101010  binary             23c     a Celsius reading, in kelvin
 *
 * A based literal is read as a **64-bit two's complement word**, so
 * sixty-four 1 bits is -1 rather than 2^64 - 1. That is the reading the
 * game documents for its own binary notation, and it is the same width the
 * bitwise instructions work in - a mask written out bit by bit means the
 * same thing to `and` as it does here.
 *
 * `sign` folds a unary minus into the literal instead of applying it after,
 * which only matters for Celsius: -40c is the temperature -40 degrees, not
 * the negation of what 40 degrees is in kelvin.
 */
function decodeNumber(text: string, sign: 1 | -1 = 1): number {
  const digits = text.replace(/_/g, "");
  const base = digits.slice(0, 2).toLowerCase();
  if (base === "0x" || base === "0b") {
    return sign * Number(BigInt.asIntN(64, BigInt(base + digits.slice(2))));
  }
  if (digits.endsWith("c") || digits.endsWith("C")) {
    const reading = digits.slice(0, -1);
    // The offset is exact to two decimals and the reading to however many it
    // was written with; rounding to that keeps -40c at 233.15 instead of the
    // 233.14999999999998 the raw double addition produces.
    const decimals = Math.max(2, reading.split(".")[1]?.length ?? 0);
    return Number((sign * parseFloat(reading) + KELVIN_AT_ZERO_CELSIUS).toFixed(decimals));
  }
  return sign * parseFloat(digits);
}

/** Whether a node is a bare numeric literal token, not a larger expression. */
function isNumberToken(node: SyntaxNode): boolean {
  return node.type === "Number" || node.type === "Integer";
}

/** Escape sequences the grammar's String token allows. */
// const STRING_ESCAPES: Record<string, string | undefined> = {
//   n: "\n", r: "\r", t: "\t", "0": "\0",
// };

function fail(message: string, node: SyntaxNode): never {
  throw new CompileError(message, node);
}

function rangeOf(node: SyntaxNode): Range {
  return { from: node.from, to: node.to };
}

/** Reject any parse-error node before conversion drops it on the floor. */
function checkSyntax(node: SyntaxNode): void {
  if (node.type === "⚠") fail("Syntax error", node);
  for (const child of node.children) checkSyntax(child);
}

// function decodeString(raw: string): string {
//   // The token always carries its surrounding quotes.
//   const body = raw.slice(1, -1);
//   return body.replace(/\\(.)/g, (_match, char: string) => STRING_ESCAPES[char] ?? char);
// }

/**
 * The statements of a block. Blocks are inlined by the grammar, so a block
 * is a run of statement children of its container, delimited by keyword
 * tokens (a function call is both a statement and an expression, so node
 * type alone cannot find the boundary).
 */
function convertBlock(
  node: SyntaxNode,
  afterKeyword: string | null,
  beforeKeyword: string | null,
): Block {
  const parts = kids(node);
  let start = 0;
  let end = parts.length;
  if (afterKeyword) {
    const i = parts.findIndex(c => c.type === afterKeyword);
    if (i >= 0) start = i + 1;
  }
  if (beforeKeyword) {
    const i = parts.findIndex(c => c.type === beforeKeyword);
    if (i >= 0) end = i;
  }
  const span = parts.slice(start, end).filter(c => STATEMENT_TYPES.has(c.type));
  // An empty block still needs a position: collapse it onto the keyword
  // that opened it.
  const anchor = start > 0 ? parts[start - 1].to : node.from;
  return {
    type: "block",
    from: span.length ? span[0].from : anchor,
    to: span.length ? span[span.length - 1].to : anchor,
    statements: span.map(convertStatement),
  };
}

/** The first expression child appearing before `boundary` (or anywhere). */
function conditionOf(node: SyntaxNode, boundary: string | null): SyntaxNode {
  const parts = kids(node);
  const i = boundary ? parts.findIndex(c => c.type === boundary) : -1;
  const searched = i < 0 ? parts : parts.slice(0, i);
  const found = searched.find(c => EXPRESSION_TYPES.has(c.type));
  if (!found) fail("Missing condition", node);
  return found;
}

/** The expression child following `keyword`. */
function expressionAfter(node: SyntaxNode, keyword: string, what: string): SyntaxNode {
  const parts = kids(node);
  const i = parts.findIndex(c => c.type === keyword);
  const found = parts.slice(i + 1).find(c => EXPRESSION_TYPES.has(c.type));
  if (!found) fail(what, node);
  return found;
}

function convertIdentifier(node: SyntaxNode): Identifier {
  if (node.type !== "VariableName" && node.type !== "FunctionName") {
    fail(`Expected a name, got ${node.type}`, node);
  }
  return { type: "identifier", ...rangeOf(node), name: node.text };
}

function convertDevice(node: SyntaxNode): Device {
  if (!DEVICE_PINS.has(node.text)) fail(`Unknown device pin ${node.text}`, node);
  return { type: "device", ...rangeOf(node), name: node.text as DevicePin };
}

/** The `deviceBase` production: a device pin or a name bound to one. */
function convertDeviceBase(node: SyntaxNode): Device | Identifier {
  return node.type === "Device" ? convertDevice(node) : convertIdentifier(node);
}

function convertValue(node: SyntaxNode): Identifier | Device | DeviceProp | DeviceChannelProp | DeviceNameProp | ListIndexing {
  const parts = kids(node);

  if (parts.length === 1) {
    return convertDeviceBase(parts[0]);
  } else if (parts.length === 2) {
    // Check for array access
    if (parts[0].type === "VariableName" && parts[1].type === "Indexing") {
      const identifier = convertIdentifier(parts[0]);
      const indexer = kids(parts[1]).find(c => EXPRESSION_TYPES.has(c.type));

      if (!indexer) fail("Malformed value: indexer", node);

      return {
        ...rangeOf(node),
        type: "listindexing",
        list: identifier,
        index: convertExpression(indexer),
      } as ListIndexing;
    }

    if (parts[1].type !== "PropertyAccessor") fail("Malformed value: device", node);
    return {
      ...rangeOf(node),
      type: "deviceprop",
      device: convertDeviceBase(parts[0]),
      prop: convertIdentifier(kids(parts[1])[1]),
    } as DeviceProp;
  } else if (parts.length === 3) {
    const indexer = kids(parts[1]).find(c => EXPRESSION_TYPES.has(c.type));

    if (parts[1].type !== "Indexing") fail("Malformed value: indexer", node);
    if (parts[2].type !== "PropertyAccessor") fail("Malformed value: property accessor", node);
    if (!indexer) fail("Malformed value: indexer", node);
    
    const device = convertDeviceBase(parts[0]);
    const prop = convertIdentifier(kids(parts[2])[1]);

    if (indexer.type === "Number") {
      return {
        ...rangeOf(node),
        type: "devicechannelprop",
        device,
        channel: { type: "constant", ...rangeOf(indexer), value: Math.trunc(decodeNumber(indexer.text)) },
        prop,
      } as DeviceChannelProp;
    } else {
      return {
        ...rangeOf(node),
        type: "devicenameprop",
        device,
        name: indexer.type === "String"
          ? { type: "string", ...rangeOf(indexer), value: indexer.text }
          : convertExpression(indexer),
        prop,
      } as DeviceNameProp;
    }
  } else {
    fail("Malformed value", node);
  }
}

/** The children between the parentheses of a call or a definition. */
function betweenParens(node: SyntaxNode): SyntaxNode[] {
  const parts = kids(node);
  const open = parts.findIndex(c => c.type === "ParenLeft");
  const close = parts.findIndex(c => c.type === "ParenRight");
  if (open < 0 || close < open) fail("Malformed parameter list", node);
  return parts.slice(open + 1, close);
}

function betweenBrackets(node: SyntaxNode): SyntaxNode[] {
  const parts = kids(node);
  const open = parts.findIndex(c => c.type === "BracketLeft");
  const close = parts.findIndex(c => c.type === "BracketRight");
  if (open < 0 || close < open) fail("Malformed parameter list", node);
  return parts.slice(open + 1, close);
}

function betweenKeywords(node: SyntaxNode, open: string, close: string): SyntaxNode[] {
  const parts = kids(node);
  const openIdx = parts.findIndex(c => c.text === open);
  const closeIdx = parts.slice(openIdx + 1).findIndex(c => c.text === close) + openIdx + 1;
  if (openIdx < 0 || closeIdx < 0) fail("Malformed parameter list", node);
  return parts.slice(openIdx + 1, closeIdx);
}

function convertCall(node: SyntaxNode): FunctionCall {
  const nameNode = kids(node).find(c => c.type === "FunctionName");
  if (!nameNode) fail("Malformed function call", node);
  return {
    type: "functioncall",
    ...rangeOf(node),
    name: convertIdentifier(nameNode),
    params: betweenParens(node)
      .filter(c => EXPRESSION_TYPES.has(c.type))
      .map(convertExpression),
  };
}

function convertBinary(node: SyntaxNode): BinaryOp | ComparisonOp | LogicalOp {
  const parts = kids(node);
  if (parts.length !== 3) fail("Malformed binary operation", node);
  const [leftNode, opNode, rightNode] = parts;
  const left = convertExpression(leftNode);
  const right = convertExpression(rightNode);
  const range = rangeOf(node);

  const binary = BINARY_OPS[opNode.text];
  if (binary) return { type: "binaryop", ...range, left, right, opcode: binary };

  const comparison = COMPARISON_OPS[opNode.text];
  if (comparison) return { type: "comparisonop", ...range, left, right, opcode: comparison };

  const logical = LOGICAL_OPS[opNode.text];
  if (logical) return { type: "logicalop", ...range, left, right, opcode: logical };

  return fail(`Unknown operator ${opNode.text}`, opNode);
}

function convertTernary(node: SyntaxNode): TernaryOp {
  // `<cond> ? <then> : <else>`: five children, the two punctuation tokens
  // included. A nested ternary is a TernaryOp node of its own, so the
  // positions are fixed however the arms are spelled.
  const parts = kids(node);
  if (parts.length !== 5 || parts[1].type !== "Question" || parts[3].type !== "Colon") {
    fail("Malformed conditional expression", node);
  }
  return {
    type: "ternaryop",
    ...rangeOf(node),
    condition: convertExpression(parts[0]),
    then: convertExpression(parts[2]),
    else: convertExpression(parts[4]),
  };
}

export function convertExpression(node: SyntaxNode): Expression {
  switch (node.type) {
    case "Integer":
    case "Number":
      return { type: "constant", ...rangeOf(node), value: decodeNumber(node.text) };
    case "Bool":
      return { type: "bool", ...rangeOf(node), value: node.text === "true" };
    case "String":
      return { type: "string", ...rangeOf(node), value: node.text };
    case "Value":
      return convertValue(node);
    case "Parens": {
      // Grouping only exists to steer the parser; the tree already records it.
      const inner = kids(node).find(c => EXPRESSION_TYPES.has(c.type));
      if (!inner) fail("Empty parentheses", node);
      return convertExpression(inner);
    }
    case "UnaryOp": {
      const parts = kids(node);
      if (parts.length !== 2) fail("Malformed unary operation", node);
      const opcode = UNARY_OPS[parts[0].text];
      if (!opcode) fail(`Unknown operator ${parts[0].text}`, parts[0]);
      // A minus directly on a literal belongs to the literal. For every
      // spelling but Celsius that is the same number either way; for -40c it
      // is the difference between 233.15 K and -313.15 K. The rule is
      // deliberately narrow - only a minus whose operand *is* the token, so
      // -(40c) still negates the kelvin value, as the parentheses ask.
      if (opcode === "neg" && isNumberToken(parts[1])) {
        return { type: "constant", ...rangeOf(node), value: decodeNumber(parts[1].text, -1) };
      }
      return { type: "unaryop", ...rangeOf(node), value: convertExpression(parts[1]), opcode };
    }
    case "BinaryOp":
      return convertBinary(node);
    case "TernaryOp":
      return convertTernary(node);
    case "FunctionCall":
      return convertCall(node);
    default:
      return fail(`Expected an expression, got ${node.type}`, node);
  }
}

export function convertStatement(node: SyntaxNode): Statement {
  const parts = kids(node);

  switch (node.type) {
    case "Declaration": {
      const nameNode = parts.find(c => c.type === "VariableName");
      if (!nameNode) fail("Malformed declaration", node);
      const assign = parts.findIndex(c => c.type === "Assign");
      return {
        type: "declaration",
        ...rangeOf(node),
        target: convertIdentifier(nameNode),
        value: assign >= 0 ? convertExpression(parts[assign + 1]) : undefined,
        constant: parts[0]?.type === "const",
      };
    }

    case "Assignment": {
      const opNode = parts.find(c => c.type === "Assign" || c.type === "CompoundAssignOp");
      const opIndex = opNode ? parts.indexOf(opNode) : -1;
      const valueNode = opIndex >= 0 ? parts[opIndex + 1] : undefined;
      if (!opNode || !valueNode) fail("Malformed assignment", node);

      const targetNode = parts[0];
      const target = convertValue(targetNode);
      const value = convertExpression(valueNode);

      if (target.type === "device") fail("Cannot assign to device", targetNode);

      if (opNode.type === "Assign") {
        return { type: "assignment", ...rangeOf(node), target, value };
      }
      // `+=` etc: the opcode is the operator with the `=` stripped.
      const opcode = BINARY_OPS[opNode.text.slice(0, -1)];
      if (!opcode) fail(`Unknown operator ${opNode.text}`, opNode);
      return { type: "compoundassignop", ...rangeOf(node), target, right: value, opcode };
    }

    case "IfExpr": {
      const ifs: IfThen[] = [];
      let elseBlock: Block | undefined;
      for (const part of parts) {
        if (part.type === "If" || part.type === "ElseIf") {
          ifs.push({
            type: "ifthen",
            ...rangeOf(part),
            condition: convertExpression(conditionOf(part, "then")),
            then: convertBlock(part, "then", null),
          });
        } else if (part.type === "Else") {
          elseBlock = convertBlock(part, "else", null);
        }
      }
      if (ifs.length === 0) fail("Malformed if", node);
      return { type: "if", ...rangeOf(node), ifs, else: elseBlock };
    }

    case "LoopExpr":
      return { type: "loop", ...rangeOf(node), body: convertBlock(node, "loop", "end") };

    case "WhileExpr":
      return {
        type: "while",
        ...rangeOf(node),
        condition: convertExpression(conditionOf(node, "do")),
        body: convertBlock(node, "do", "end"),
      };

    case "RepeatUntilExpr":
      return {
        type: "repeat",
        ...rangeOf(node),
        until: convertExpression(expressionAfter(node, "until", "repeat needs a condition")),
        body: convertBlock(node, "repeat", "until"),
      };

    case "ForExpr": {
      // `for <init>? , <cond>? , <update>? do`: the grammar makes all three
      // slots optional and only the two commas mandatory, so split the head
      // on its commas rather than walking fixed positions - an omitted
      // trailing slot just ends the list early.
      const slots: (SyntaxNode | undefined)[] = [undefined, undefined, undefined];
      let slot = 0;
      for (const part of betweenKeywords(node, "for", "do")) {
        if (part.type === "Comma") slot++;
        else if (slot > 2) fail("Malformed for header", node);
        else slots[slot] = part;
      }
      const [init, cond, updt] = slots;
      return {
        ...rangeOf(node),
        type: "for",
        init: init ? convertStatement(init) : undefined,
        condition: cond ? convertExpression(cond) : undefined,
        update: updt ? convertStatement(updt) : undefined,
        body: convertBlock(node, "do", "end"),
      }
    }

    case "ForInExpr": {
      const decl = parts.find(c => c.type === "Declaration");
      const list = parts.find(c => c.type === "VariableName");
      
      if (!decl || !list) fail("Malformed forin", node);
      
      return {
        ...rangeOf(node),
        type: "forin",
        decl: convertStatement(decl) as Declaration,
        list: convertIdentifier(list) as Identifier,
        body: convertBlock(node, "do", "end"),
      }
    }

    case "ForOfExpr": {
      const decl = parts.find(c => c.type === "Declaration");
      const list = parts.find(c => c.type === "VariableName");
      
      if (!decl || !list) fail("Malformed forin", node);
      
      return {
        ...rangeOf(node),
        type: "forof",
        decl: convertStatement(decl) as Declaration,
        list: convertIdentifier(list) as Identifier,
        body: convertBlock(node, "do", "end"),
      }
    }

    case "break":
      return { type: "break", ...rangeOf(node) };

    case "continue":
      return { type: "continue", ...rangeOf(node) };

    case "Instruction": {
      // `yield` carries no operand; `sleep` takes a duration. The keyword
      // token is specialized without a name, so the text is what tells them
      // apart.
      if (!node.text.startsWith("sleep")) return { type: "yield", ...rangeOf(node) };
      const duration = parts.find(c => EXPRESSION_TYPES.has(c.type));
      if (!duration) fail("sleep needs a duration", node);
      return { type: "sleep", ...rangeOf(node), duration: convertExpression(duration) };
    }

    case "Return":
      return {
        type: "return",
        ...rangeOf(node),
        value: convertExpression(expressionAfter(node, "return", "return needs a value")),
      };

    case "Definition": {
      const nameNode = parts.find(c => c.type === "VariableName");
      const assign = parts.findIndex(c => c.type === "Assign");
      if (!nameNode || assign < 0) fail("Malformed definition", node);
      return {
        type: "definedef",
        ...rangeOf(node),
        name: convertIdentifier(nameNode),
        value: convertExpression(parts[assign + 1]),
      };
    }

    case "DeviceDeclaration": {
      const nameNode = parts.find(c => c.type === "VariableName");
      const deviceNode = parts.find(c => c.type === "Device");
      if (!nameNode || !deviceNode) fail("Malformed device declaration", node);
      return {
        type: "devicedef",
        ...rangeOf(node),
        name: convertIdentifier(nameNode),
        device: convertDevice(deviceNode),
      };
    }

    case "StackDeclaration": {
      const nameNode = parts.find(c => c.type === "VariableName");
      // The initializer is whatever follows the `=`, not the first expression
      // in the statement - a VariableName is itself one, so searching for the
      // first would find the name being declared.
      const assign = parts.findIndex(c => c.type === "Assign");
      if (!nameNode) fail("Malformed stack declaration", node);
      return {
        ...rangeOf(node),
        type: "stackdeclaration",
        name: convertIdentifier(nameNode),
        value: assign < 0 ? undefined : convertExpression(parts[assign + 1]),
      };
    }

    case "PreprocessorDirective": {
      const nameNode = parts.find(c => c.type === "DirectiveName");
      if (!nameNode) fail("Malformed directive", node);
      return { type: "preprocessordir", ...rangeOf(node), name: nameNode.text };
    }

    case "FunctionDef": {
      const nameNode = parts.find(c => c.type === "FunctionName");
      const bodyNode = parts.find(c => c.type === "FunctionBlock");
      if (!nameNode) fail("Malformed function definition", node);
      return {
        type: "functiondef",
        ...rangeOf(node),
        name: convertIdentifier(nameNode),
        args: betweenParens(node)
          .filter(c => c.type === "VariableName")
          .map(convertIdentifier),
        // An empty body produces no FunctionBlock node at all.
        body: bodyNode
          ? convertBlock(bodyNode, null, null)
          : { type: "block", from: node.to, to: node.to, statements: [] },
      };
    }

    case "FunctionCall":
      return convertCall(node);

    case "ArrayDeclaration": {
      const nameNode = parts.find(c => c.type === "VariableName");
      const sizeNode = betweenBrackets(node).find(c => EXPRESSION_TYPES.has(c.type));
      if (!nameNode || !sizeNode) fail("Malformed array declaration", node);
      const listNode = parts.find(c => c.type === "List");
      if (listNode) {
        const list = betweenBrackets(listNode).filter(c => EXPRESSION_TYPES.has(c.type)).map(convertExpression);
        return {
          ...rangeOf(node),
          type: "arraydeclaration",
          name: convertIdentifier(nameNode),
          size: convertExpression(sizeNode),
          list: {
            type: "list",
            from: listNode.from,
            to: listNode.to,
            elements: list,
          } as List,
        } as ArrayDeclaration;
      } else {
        return {
          ...rangeOf(node),
          type: "arraydeclaration",
          name: convertIdentifier(nameNode),
          size: convertExpression(sizeNode),
        } as ArrayDeclaration;
      }
    }

    case "Import": {
      const nameNode = parts.find(c => c.type === "VariableName");
      const pathNode = parts.find(c => c.type === "String");
      const deviceNode = parts.find(c => c.type === "Device");
      if (!nameNode || !pathNode) fail("Malformed import", node);
      return {
        ...rangeOf(node),
        type: "import",
        name: convertIdentifier(nameNode),
        path: { type: "string", from: pathNode.from, to: pathNode.to, value: pathNode.text },
        device: deviceNode ? convertDevice(deviceNode) : undefined,
      };
    }
    
    default:
      return fail(`Expected a statement, got ${node.type}`, node);
  }
}

/**
 * Convert a parse tree from `getAST` into the strictly typed form above.
 * `root` is the `program` node; the result is its top-level block.
 */
export function getFormalAST(root: SyntaxNode): Block {
  checkSyntax(root);
  return convertBlock(root, null, null);
}

/**
 * Every child of a node, for the analyses that care about what appears
 * *somewhere* in a subtree - which names it reads, which it assigns - rather
 * than about the shape those names appear in. The formal analogue of `kids`.
 *
 * The name of a function (in a call or a definition) is deliberately not a
 * child: it names a function, not a value, and a walk looking for name
 * references must not mistake one for the other. Consumers that want the
 * callee read `name` directly.
 */
export function childrenOf(node: FormalSyntaxNode): FormalSyntaxNode[] {
  switch (node.type) {
    case "block": return node.statements;
    case "declaration": return node.value ? [node.target, node.value] : [node.target];
    case "assignment": return [node.target, node.value];
    case "compoundassignop": return [node.target, node.right];
    case "if": return node.else ? [...node.ifs, node.else] : [...node.ifs];
    case "ifthen": return [node.condition, node.then];
    case "loop": return [node.body];
    case "while": return [node.condition, node.body];
    case "repeat": return [node.body, node.until];
    case "for": return [node.init, node.condition, node.update, node.body].filter(c => c !== undefined);
    case "forin": return [node.decl, node.list, node.body];
    case "forof": return [node.decl, node.list, node.body];
    case "break":
    case "continue":
    case "yield":
    case "preprocessordir":
    case "identifier":
    case "constant":
    case "bool":
    case "string":
    case "device":
      return [];
    case "sleep": return [node.duration];
    case "return": return [node.value];
    case "definedef": return [node.name, node.value];
    case "devicedef": return [node.name, node.device];
    case "stackdeclaration": return [node.name, node.value].filter(c => c !== undefined);
    case "functiondef": return [...node.args, node.body];
    case "functioncall": return node.params;
    case "deviceprop": return [node.device, node.prop];
    case "devicechannelprop": return [node.device, node.channel, node.prop];
    case "devicenameprop": return [node.device, node.name, node.prop];
    case "binaryop":
    case "comparisonop":
    case "logicalop":
      return [node.left, node.right];
    case "unaryop": return [node.value];
    case "ternaryop": return [node.condition, node.then, node.else];
    case "arraydeclaration":
      return [node.name, node.size, ...(node.list ? node.list.elements : [])];
    case "listindexing": return [node.list, node.index];
    case "import": return [node.name, node.path, node.device].filter(c => c !== undefined);
  }
}
