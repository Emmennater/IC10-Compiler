import { SyntaxNode } from "./ast";

/** A formalized version of the abstract syntax tree using strict typing */

// Types
export type Range = {
  to: number;
  from: number;
};

export type FormalSyntaxNode =
  | Block
  | Statement
  | Expression;

export type Statement =
  | Declaration
  | Assignment
  | If
  | IfThen
  | Loop
  | While
  | Repeat
  | DeviceDef
  | PreprocessorDir
  | FunctionDef;

export type Expression =
  | Identifier
  | Constant
  | Bool
  | StringExpr
  | DeviceProp
  | DeviceNameProp
  | BinaryOp
  | UnaryOp
  | CompoundAssignOp
  | ComparisonOp
  | LogicalOp
  | Device
  | FunctionCall;

export type Dummy = Range & {
  type: "dummy";
};

// Blocks
export type Block = Range & {
  type: "block";
  statements: Statement[];
};

// Statements
export type Declaration = Range & {
  type: "declaration";
  target: Identifier;
  value?: Expression;
};

// x = <expression>
export type Assignment = Range & {
  type: "assignment";
  target: Identifier | DeviceProp | DeviceNameProp;
  value: Expression;
};

// if <expression> then <block> elif <expression> then <block> else <block> end
export type If = Range & {
  type: "if";
  ifs: IfThen[];
  else?: Block;
}

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

// define <identifier> = <expression>
export type DefineDef = Range & {
  type: "define";
  name: Identifier;
  value: Constant | string;
};

// device <identifier> = <device>
export type DeviceDef = Range & {
  type: "device";
  name: Identifier;
  device: Device;
};

// @<identifier>
export type PreprocessorDir = Range & {
  type: "preprocessordir";
  name: string;
};

// fn <identifier>(<identifier>, ...) do <block> end
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
  value: string;
};

// <identifier | device>.<identifier>
export type DeviceProp = Range & {
  type: "deviceprop";
  device: Device | Identifier;
  prop: Identifier;
};

// <identifier | device>[<identifier | string>].<identifier>
export type DeviceNameProp = Range & {
  type: "devicename";
  device: Device | Identifier;
  name: Identifier | StringExpr;
  prop: Identifier;
};

// <expression> <op> <expression>
export type BinaryOp = Range & {
  type: "binaryop";
  left: Expression;
  right: Expression;
  opcode: "add" | "sub" | "mul" | "div" | "mod";
};

// <op> <expression>
export type UnaryOp = Range & {
  type: "unaryop";
  value: Expression;
  opcode: "neg" | "not";
}

// <identifier> <op>= <expression>
export type CompoundAssignOp = Range & {
  type: "compoundassignop";
  target: Identifier | DeviceProp | DeviceNameProp;
  right: Expression;
  opcode: "add" | "sub" | "mul" | "div" | "mod";
}

// <expression> <op> <expression>
export type ComparisonOp = Range & {
  type: "comparisonop";
  left: Expression;
  right: Expression;
  opcode: "eq" | "ne" | "lt" | "le" | "gt" | "ge";
};

// <expression> <op> <expression>
export type LogicalOp = Range & {
  type: "logicalop";
  left: Expression;
  right: Expression;
  opcode: "and" | "or";
};

// <device>
export type Device = Range & {
  type: "device";
  name: "d0" | "d1" | "d2" | "d3" | "d4" | "d5" | "db";
};

// <identifier>(<expression>, ...)
export type FunctionCall = Range & {
  type: "functioncall";
  name: Identifier;
  params: Expression[];
};

export function getFormalAST(root: SyntaxNode): Block {
  return {
    type: "block", to: 0, from: 0, statements: []
  } as Block;
}
