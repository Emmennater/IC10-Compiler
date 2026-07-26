/**
 * Builders for hand-constructed parse trees, matching the node shapes the
 * compiler expects from the editor grammar (keyword/punctuation tokens
 * included where position matters).
 */

import type { SyntaxNode } from "../syntax";

export function node(type: string, text: string, ...children: SyntaxNode[]): SyntaxNode {
  return { type, text, from: 0, to: 0, children };
}

// ----------------------------- expressions ------------------------------

export const num = (n: number | string): SyntaxNode => node("Number", String(n));
export const int = (n: number): SyntaxNode => node("Integer", String(n));
export const bool = (b: boolean): SyntaxNode => node("Bool", b ? "true" : "false");
export const name = (x: string): SyntaxNode => node("VariableName", x);
export const device = (d: string): SyntaxNode => node("Device", d);
export const str = (s: string): SyntaxNode => node("String", `"${s}"`);

const OP_TYPE: Record<string, string> = {
  "+": "AddOp", "-": "AddOp", "*": "MulOp", "/": "MulOp", "%": "MulOp",
  "==": "CompareOp", "!=": "CompareOp", ">": "CompareOp", "<": "CompareOp",
  ">=": "CompareOp", "<=": "CompareOp", "&&": "LogicOp", "||": "LogicOp",
};

export const bin = (left: SyntaxNode, op: string, right: SyntaxNode): SyntaxNode =>
  node("BinaryOp", "", left, node(OP_TYPE[op] ?? "Op", op), right);

export const un = (op: string, operand: SyntaxNode): SyntaxNode =>
  node("UnaryOp", "", node("Op", op), operand);

export const parens = (inner: SyntaxNode): SyntaxNode =>
  node("Parens", "", node("(", "("), inner, node(")", ")"));

/** device.Property or unknownName.Property (a game constant). */
export const prop = (base: SyntaxNode, propName: string): SyntaxNode =>
  node("DeviceProperty", "", base, node("VariableName", propName));

/** device[slot].Property */
export const slotProp = (base: SyntaxNode, index: SyntaxNode, propName: string): SyntaxNode =>
  node("DeviceChannelProperty", "", base, node("[", "["), index, node("]", "]"), node("VariableName", propName));

/** deviceGroup[nameFilter].Property */
export const nameProp = (base: SyntaxNode, index: SyntaxNode, propName: string): SyntaxNode =>
  node("DeviceNameProperty", "", base, node("[", "["), index, node("]", "]"), node("VariableName", propName));

export const fnCall = (fname: string, ...args: SyntaxNode[]): SyntaxNode =>
  node("FunctionCall", "", node("FunctionName", fname), ...args);

// ------------------------------ statements ------------------------------

export const decl = (n: string, init?: SyntaxNode): SyntaxNode =>
  init
    ? node("Declaration", "", node("let", "let"), name(n), node("Assign", "="), init)
    : node("Declaration", "", node("let", "let"), name(n));

export const assign = (target: SyntaxNode | string, value: SyntaxNode): SyntaxNode => {
  const t = typeof target === "string" ? name(target) : target;
  return node("Assignment", "", t, node("Assign", "="), value);
};

/** target op= value (op is "+", "-", "*", "/", or "%"). */
export const compound = (target: SyntaxNode | string, op: string, value: SyntaxNode): SyntaxNode => {
  const t = typeof target === "string" ? name(target) : target;
  return node("Assignment", "", t, node("CompoundAssignOp", `${op}=`), value);
};

export const deviceDecl = (alias: string, pin: string): SyntaxNode =>
  node("DeviceDeclaration", "", node("device", "device"), name(alias), node("Assign", "="), device(pin));

export const defineStmt = (n: string, value: SyntaxNode): SyntaxNode =>
  node("Definition", "", node("define", "define"), name(n), node("Assign", "="), value);

export const ifExpr = (...arms: SyntaxNode[]): SyntaxNode => node("IfExpr", "", ...arms);
export const ifArm = (cond: SyntaxNode, ...body: SyntaxNode[]): SyntaxNode =>
  node("If", "", cond, node("then", "then"), ...body);
export const elifArm = (cond: SyntaxNode, ...body: SyntaxNode[]): SyntaxNode =>
  node("ElseIf", "", cond, node("then", "then"), ...body);
export const elseArm = (...body: SyntaxNode[]): SyntaxNode => node("Else", "", ...body);

export const loopExpr = (...body: SyntaxNode[]): SyntaxNode =>
  node("LoopExpr", "", node("loop", "loop"), ...body);
export const whileExpr = (cond: SyntaxNode, ...body: SyntaxNode[]): SyntaxNode =>
  node("WhileExpr", "", cond, node("do", "do"), ...body);
export const repeatUntil = (body: SyntaxNode[], cond: SyntaxNode): SyntaxNode =>
  node("RepeatUntilExpr", "", node("repeat", "repeat"), ...body, node("until", "until"), cond);

export const brk = (): SyntaxNode => node("break", "break");
export const cont = (): SyntaxNode => node("continue", "continue");
export const yieldStmt = (): SyntaxNode => node("Instruction", "yield");
export const sleepStmt = (duration: SyntaxNode): SyntaxNode => node("Instruction", "sleep", duration);

export const fnDef = (fname: string, params: string[], ...body: SyntaxNode[]): SyntaxNode =>
  node("FunctionDef", "",
    node("FunctionName", fname),
    ...params.map(name),
    node("FunctionBlock", "", ...body));

export const ret = (value: SyntaxNode): SyntaxNode =>
  node("Return", "", node("return", "return"), value);

export const constexprDirective = (): SyntaxNode =>
  node("PreprocessorDirective", "@constexpr", node("DirectiveName", "constexpr"));

export const program = (...statements: SyntaxNode[]): SyntaxNode =>
  node("Program", "", ...statements);
