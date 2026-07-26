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
  | Break
  | Continue
  | Yield
  | Sleep
  | Return
  | DefineDef
  | DeviceDef
  | PreprocessorDir
  | FunctionDef
  | FunctionCall
  | ArrayDeclaration;

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
// let <identifier> [= <expression>]
export type Declaration = Range & {
  type: "declaration";
  target: Identifier;
  value?: Expression;
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
  opcode: ArithmeticOpcode;
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

// let <identifier> = [<expression>, ...]
export type ArrayDeclaration = Range & {
  type: "arraydeclaration";
  name: Identifier;
  size: Constant;
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

// <expression> <op> <expression>
export type BinaryOp = Range & {
  type: "binaryop";
  left: Expression;
  right: Expression;
  opcode: ArithmeticOpcode;
};

// <op> <expression>
export type UnaryOp = Range & {
  type: "unaryop";
  value: Expression;
  /** `pos` is unary `+`, which the grammar accepts and which is identity. */
  opcode: "neg" | "pos" | "not";
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
const ARITHMETIC_OPS: Record<string, ArithmeticOpcode | undefined> = {
  "+": "add", "-": "sub", "*": "mul", "/": "div", "%": "mod",
};

const COMPARISON_OPS: Record<string, ComparisonOpcode | undefined> = {
  "==": "eq", "!=": "ne", "<": "lt", "<=": "le", ">": "gt", ">=": "ge",
};

const LOGICAL_OPS: Record<string, LogicalOp["opcode"] | undefined> = {
  "&&": "and", "||": "or",
};

const UNARY_OPS: Record<string, UnaryOp["opcode"] | undefined> = {
  "-": "neg", "+": "pos", "!": "not",
};

const DEVICE_PINS: ReadonlySet<string> = new Set<DevicePin>([
  "d0", "d1", "d2", "d3", "d4", "d5", "db",
]);

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
        channel: { type: "constant", ...rangeOf(indexer), value: parseInt(indexer.text, 10) },
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

  const arithmetic = ARITHMETIC_OPS[opNode.text];
  if (arithmetic) return { type: "binaryop", ...range, left, right, opcode: arithmetic };

  const comparison = COMPARISON_OPS[opNode.text];
  if (comparison) return { type: "comparisonop", ...range, left, right, opcode: comparison };

  const logical = LOGICAL_OPS[opNode.text];
  if (logical) return { type: "logicalop", ...range, left, right, opcode: logical };

  return fail(`Unknown operator ${opNode.text}`, opNode);
}

export function convertExpression(node: SyntaxNode): Expression {
  switch (node.type) {
    case "Integer":
    case "Number":
      return { type: "constant", ...rangeOf(node), value: parseFloat(node.text) };
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
      return { type: "unaryop", ...rangeOf(node), value: convertExpression(parts[1]), opcode };
    }
    case "BinaryOp":
      return convertBinary(node);
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
      const opcode = ARITHMETIC_OPS[opNode.text.slice(0, -1)];
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
      const sizeNode = parts.find(c => c.type === "Integer");
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
    case "arraydeclaration":
      return [node.name, node.size, ...(node.list ? node.list.elements : [])];
    case "listindexing": return [node.list, node.index];
  }
}
