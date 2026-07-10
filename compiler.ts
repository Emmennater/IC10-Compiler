
/**
 * Compiler for translating high-level code to IC10.
 *
 * Custom language reference: ./README.md
 * IC10 Reference: https://stationeers-wiki.com/IC10
 *
 * Registers:
 *   r0-r9:   Temporaries for expression evaluation
 *   r10-r15: Variables
 *   r16 (sp): Stack pointer
 *   r17 (ra): Return address
 */

export type SyntaxNode = {
  type: string;
  text: string;
  from: number;
  to: number;
  children: SyntaxNode[];
};

export class CompileError extends Error {
  from: number;
  to: number;

  constructor(message: string, node: SyntaxNode) {
    super(message);
    this.from = node.from;
    this.to = node.to;
  }
}

const VAR_REGISTERS = ["r10", "r11", "r12", "r13", "r14", "r15"];
const TEMP_REGISTERS = ["r0", "r1", "r2", "r3", "r4", "r5", "r6", "r7", "r8", "r9"];

const OPCODES: Record<string, string> = {
  "+": "add",
  "-": "sub",
  "*": "mul",
  "/": "div",
};

const EXPRESSION_TYPES = new Set(["Number", "VariableName", "Parens", "UnaryOp", "BinaryOp"]);

export function compile(ast: SyntaxNode): string {
  const source = ast.text;
  const lines: string[] = [];
  const vars = new Map<string, string>();
  const allocatedTemps = new Set<string>();

  // The editor gutter is 0-based, so error lines are too.
  function lineOf(node: SyntaxNode): number {
    let line = 0;
    for (let i = 0; i < node.from && i < source.length; i++) {
      if (source[i] === "\n") line++;
    }
    return line;
  }

  function error(message: string, node: SyntaxNode): CompileError {
    return new CompileError(`Line ${lineOf(node)}: ${message}`, node);
  }

  function emit(line: string) {
    lines.push(line);
  }

  // Comments are skipped tokens and can be attached anywhere in the tree.
  function kids(node: SyntaxNode): SyntaxNode[] {
    return node.children.filter(c => c.type !== "Comment");
  }

  function checkSyntax(node: SyntaxNode) {
    if (node.type === "⚠") {
      throw error("Syntax error", node);
    }
    for (const child of node.children) checkSyntax(child);
  }

  function allocTemp(node: SyntaxNode): string {
    for (const reg of TEMP_REGISTERS) {
      if (!allocatedTemps.has(reg)) {
        allocatedTemps.add(reg);
        return reg;
      }
    }
    throw error("Expression too complex: out of temporary registers", node);
  }

  function freeOperand(operand: string) {
    allocatedTemps.delete(operand);
  }

  /** Format a number as an IC10 literal, or null if it can't be represented plainly. */
  function formatNumber(value: number): string | null {
    if (!Number.isFinite(value)) return null;
    const text = String(value);
    if (text.includes("e") || text.includes("E")) return null;
    return text;
  }

  /** Evaluate a compile-time constant expression, or null if not constant. */
  function evalConst(node: SyntaxNode): number | null {
    switch (node.type) {
      case "Number":
        return parseFloat(node.text);
      case "Parens": {
        const inner = kids(node).find(c => EXPRESSION_TYPES.has(c.type));
        return inner ? evalConst(inner) : null;
      }
      case "UnaryOp": {
        const [op, operand] = kids(node);
        const value = evalConst(operand);
        if (value === null) return null;
        return op.text === "-" ? -value : value;
      }
      case "BinaryOp": {
        const [left, op, right] = kids(node);
        const a = evalConst(left);
        const b = evalConst(right);
        if (a === null || b === null) return null;
        switch (op.text) {
          case "+": return a + b;
          case "-": return a - b;
          case "*": return a * b;
          case "/": return a / b;
        }
        return null;
      }
      default:
        return null;
    }
  }

  /** Fold a constant subexpression into a literal operand, or null. */
  function tryFold(node: SyntaxNode): string | null {
    const value = evalConst(node);
    if (value === null) return null;
    return formatNumber(value);
  }

  /** Number of temporary registers needed to evaluate this subtree (Sethi-Ullman). */
  function tempsNeeded(node: SyntaxNode): number {
    if (tryFold(node) !== null) return 0;
    switch (node.type) {
      case "Number":
      case "VariableName":
        return 0;
      case "Parens": {
        const inner = kids(node).find(c => EXPRESSION_TYPES.has(c.type));
        return inner ? tempsNeeded(inner) : 0;
      }
      case "UnaryOp": {
        const [op, operand] = kids(node);
        const inner = tempsNeeded(operand);
        return op.text === "+" ? inner : Math.max(inner, 1);
      }
      case "BinaryOp": {
        const [left, , right] = kids(node);
        const a = tempsNeeded(left);
        const b = tempsNeeded(right);
        return Math.max(a === b ? a + 1 : Math.max(a, b), 1);
      }
      default:
        return 0;
    }
  }

  /**
   * Compile an expression and return the operand holding its value: a literal,
   * a register, or a passthrough IC10 identifier. When `target` is given and an
   * instruction has to be emitted, the result goes directly into `target`.
   * `target` is only used for the root instruction, never as scratch space, so
   * it may safely appear in the expression itself (e.g. `x = x + 1`).
   */
  function compileExpression(node: SyntaxNode, target: string | null): string {
    switch (node.type) {
      case "Number":
        return formatNumber(parseFloat(node.text)) ?? node.text;
      case "VariableName":
        // Unknown identifiers pass through verbatim (IC10 defines, aliases, ...)
        return vars.get(node.text) ?? node.text;
      case "Parens": {
        const inner = kids(node).find(c => EXPRESSION_TYPES.has(c.type));
        if (!inner) throw error("Empty parentheses", node);
        return compileExpression(inner, target);
      }
      case "UnaryOp": {
        const folded = tryFold(node);
        if (folded !== null) return folded;
        const [op, operandNode] = kids(node);
        if (op.text === "+") return compileExpression(operandNode, target);
        const operand = compileExpression(operandNode, null);
        freeOperand(operand);
        const dest = target ?? allocTemp(node);
        emit(`sub ${dest} 0 ${operand}`);
        return dest;
      }
      case "BinaryOp": {
        const folded = tryFold(node);
        if (folded !== null) return folded;

        const [leftNode, opNode, rightNode] = kids(node);
        const op = opNode.text;

        // Algebraic identities that make the whole operation free
        const leftConst = tryFold(leftNode);
        const rightConst = tryFold(rightNode);
        if (op === "+" && leftConst === "0") return compileExpression(rightNode, target);
        if ((op === "+" || op === "-") && rightConst === "0") return compileExpression(leftNode, target);
        if (op === "*" && leftConst === "1") return compileExpression(rightNode, target);
        if ((op === "*" || op === "/") && rightConst === "1") return compileExpression(leftNode, target);

        // Evaluate the register-hungrier side first to minimize live temps
        let left: string;
        let right: string;
        if (tempsNeeded(rightNode) > tempsNeeded(leftNode)) {
          right = compileExpression(rightNode, null);
          left = compileExpression(leftNode, null);
        } else {
          left = compileExpression(leftNode, null);
          right = compileExpression(rightNode, null);
        }

        // Free before allocating so the destination can reuse an operand's
        // register: IC10 reads all operands before writing the destination.
        freeOperand(left);
        freeOperand(right);
        const dest = target ?? allocTemp(node);
        emit(`${OPCODES[op]} ${dest} ${left} ${right}`);
        return dest;
      }
      default:
        throw error(`Unexpected expression: ${node.type}`, node);
    }
  }

  /** Compile an expression into `target`, emitting a move if it folded away. */
  function compileInto(node: SyntaxNode, target: string) {
    const value = compileExpression(node, target);
    if (value !== target) {
      emit(`move ${target} ${value}`);
    }
  }

  function processDeclaration(node: SyntaxNode) {
    const parts = kids(node);
    const nameNode = parts.find(c => c.type === "VariableName");
    if (!nameNode) throw error("Malformed declaration", node);
    const name = nameNode.text;

    if (vars.has(name)) {
      throw error(`${name} was already defined`, nameNode);
    }
    if (vars.size >= VAR_REGISTERS.length) {
      throw error(
        `Too many variables: only ${VAR_REGISTERS.length} registers (r10-r15) are available`,
        nameNode
      );
    }
    const register = VAR_REGISTERS[vars.size];

    // Compile the initializer before binding the name, so a reference to the
    // same identifier on the right-hand side still passes through verbatim.
    const initializer = parts.find(c => EXPRESSION_TYPES.has(c.type) && c !== nameNode);
    if (initializer) {
      compileInto(initializer, register);
    }
    vars.set(name, register);
  }

  function processAssignment(node: SyntaxNode) {
    const parts = kids(node);
    const nameNode = parts.find(c => c.type === "VariableName");
    const expression = parts.find(c => EXPRESSION_TYPES.has(c.type) && c !== nameNode);
    if (!nameNode || !expression) throw error("Malformed assignment", node);

    // Unknown destinations pass through verbatim (IC10 aliases, sp, ...)
    const target = vars.get(nameNode.text) ?? nameNode.text;
    compileInto(expression, target);
  }

  function processStatement(statement: SyntaxNode) {
    switch (statement.type) {
      case "Declaration":
        processDeclaration(statement);
        break;
      case "Assignment":
        processAssignment(statement);
        break;
      case "Comment":
        break;
      default:
        throw error(`Unexpected statement: ${statement.type}`, statement);
    }
  }

  function processBlock(block: SyntaxNode) {
    for (const statement of block.children) {
      processStatement(statement);
    }
  }

  checkSyntax(ast);
  processBlock(ast);

  return lines.join("\n");
}
