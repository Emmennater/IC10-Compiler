
/**
 * Compiler for translating high-level code to IC10.
 *
 * Custom language reference: ./README.md
 * IC10 Reference: https://stationeers-wiki.com/IC10 (local copy: ./ic10-docs.txt)
 *
 * Pipeline:
 *   1. The AST is lowered to a linear IR over infinite virtual registers.
 *      Constants are folded and propagated through variables, and copies
 *      never generate code (each assignment just remaps the variable name).
 *      Placeholder identifiers (anything not declared with `let`) are read
 *      and written only through `move` — they stand in for the l/s/lb/sb/...
 *      device instructions to come, which cannot appear as ALU operands.
 *   2. Dead code elimination walks the IR backwards, keeping only the
 *      instructions that contribute to a side effect (a placeholder write).
 *   3. Linear-scan register allocation maps virtual registers onto
 *      VAR_REGISTER_ORDER, reusing a register as soon as its value dies.
 *      When pressure exceeds the pool, the least-used value is spilled to a
 *      fixed stack address (511 downward: `get r? db addr` to read,
 *      `poke addr value` to write) and allocation is retried. Low stack
 *      addresses are left free for the future function call stack.
 *
 *   r16 (sp) and r17 (ra) are reserved for stack and function support.
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


// Preferred assignment order for variable registers
const VAR_REGISTER_ORDER = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];

// Spilled values live at fixed stack addresses growing down from here
const STACK_TOP = 511;

const OPCODES: Record<string, string> = {
  "+": "add",
  "-": "sub",
  "*": "mul",
  "/": "div",
};

const EXPRESSION_TYPES = new Set(["Number", "VariableName", "Parens", "UnaryOp", "BinaryOp"]);

type Operand =
  | { kind: "vreg"; id: number }
  | { kind: "const"; text: string }
  | { kind: "name"; text: string };

type Inst =
  | { op: "alu"; opcode: string; dest: number; a: Operand; b: Operand; node: SyntaxNode }
  | { op: "loadname"; dest: number; name: string; node: SyntaxNode }
  | { op: "storename"; name: string; src: Operand; node: SyntaxNode }
  | { op: "get"; dest: number; addr: number; node: SyntaxNode }
  | { op: "poke"; addr: number; src: Operand; node: SyntaxNode };

export function compile(ast: SyntaxNode, registerOrder: number[] = VAR_REGISTER_ORDER): string {
  const source = ast.text;

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

  /** Make a constant operand, or null if the value has no plain IC10 literal. */
  function constOp(value: number): Operand | null {
    if (!Number.isFinite(value)) return null;
    const text = String(value);
    if (text.includes("e") || text.includes("E")) return null;
    return { kind: "const", text };
  }

  function isConst(operand: Operand, text: string): boolean {
    return operand.kind === "const" && operand.text === text;
  }

  // ---------------------------------------------------------------------
  // 1. Lower the AST to IR with folding, propagation, and placeholder moves
  // ---------------------------------------------------------------------

  let instructions: Inst[] = [];
  let nextVreg = 0;
  const scratch = new Set<number>(); // vregs created by spilling; never re-spilled

  const declared = new Set<string>();
  const varValue = new Map<string, Operand>();
  // Placeholder name -> vreg already holding it in the current statement,
  // so `a * a` loads `a` once. Not shared across statements: a placeholder
  // may be written in between, and device reads should stay explicit.
  let statementLoads = new Map<string, number>();

  function vreg(): number {
    return nextVreg++;
  }

  /**
   * How many registers evaluating this subtree keeps busy at once. Only used
   * to pick evaluation order (register-hungrier side first); the real
   * allocation happens later over the whole program.
   */
  function pressure(node: SyntaxNode): number {
    switch (node.type) {
      case "Number":
        return 0;
      case "VariableName":
        // Placeholders must be loaded into a register; variables are free
        return declared.has(node.text) ? 0 : 1;
      case "Parens": {
        const inner = kids(node).find(c => EXPRESSION_TYPES.has(c.type));
        return inner ? pressure(inner) : 0;
      }
      case "UnaryOp": {
        const [op, operand] = kids(node);
        const inner = pressure(operand);
        return op.text === "+" ? inner : Math.max(inner, 1);
      }
      case "BinaryOp": {
        const [left, , right] = kids(node);
        const a = pressure(left);
        const b = pressure(right);
        return Math.max(a === b ? a + 1 : Math.max(a, b), 1);
      }
      default:
        return 0;
    }
  }

  function compileExpression(node: SyntaxNode): Operand {
    switch (node.type) {
      case "Number":
        return constOp(parseFloat(node.text)) ?? { kind: "const", text: node.text };
      case "VariableName": {
        const name = node.text;
        if (declared.has(name)) {
          const value = varValue.get(name);
          if (!value) throw error(`${name} is used before being assigned`, node);
          return value;
        }
        // Placeholder read: must come into a register through a move
        const cached = statementLoads.get(name);
        if (cached !== undefined) return { kind: "vreg", id: cached };
        const dest = vreg();
        instructions.push({ op: "loadname", dest, name, node });
        statementLoads.set(name, dest);
        return { kind: "vreg", id: dest };
      }
      case "Parens": {
        const inner = kids(node).find(c => EXPRESSION_TYPES.has(c.type));
        if (!inner) throw error("Empty parentheses", node);
        return compileExpression(inner);
      }
      case "UnaryOp": {
        const [op, operandNode] = kids(node);
        if (op.text === "+") return compileExpression(operandNode);
        const a = compileExpression(operandNode);
        if (a.kind === "const") {
          const folded = constOp(-parseFloat(a.text));
          if (folded) return folded;
        }
        const dest = vreg();
        instructions.push({ op: "alu", opcode: "sub", dest, a: { kind: "const", text: "0" }, b: a, node });
        return { kind: "vreg", id: dest };
      }
      case "BinaryOp": {
        const [leftNode, opNode, rightNode] = kids(node);
        const op = opNode.text;

        // Evaluate the register-hungrier side first to minimize live values
        let a: Operand;
        let b: Operand;
        if (pressure(rightNode) > pressure(leftNode)) {
          b = compileExpression(rightNode);
          a = compileExpression(leftNode);
        } else {
          a = compileExpression(leftNode);
          b = compileExpression(rightNode);
        }

        // Constant folding (constants propagated through variables included)
        if (a.kind === "const" && b.kind === "const") {
          const x = parseFloat(a.text);
          const y = parseFloat(b.text);
          const value = op === "+" ? x + y : op === "-" ? x - y : op === "*" ? x * y : x / y;
          const folded = constOp(value);
          if (folded) return folded;
        }

        // Algebraic identities that make the whole operation free. Any load
        // emitted for the discarded side is cleaned up by dead code
        // elimination afterwards.
        if (op === "+" && isConst(a, "0")) return b;
        if ((op === "+" || op === "-") && isConst(b, "0")) return a;
        if (op === "*" && isConst(a, "1")) return b;
        if ((op === "*" || op === "/") && isConst(b, "1")) return a;

        const dest = vreg();
        instructions.push({ op: "alu", opcode: OPCODES[op], dest, a, b, node });
        return { kind: "vreg", id: dest };
      }
      default:
        throw error(`Unexpected expression: ${node.type}`, node);
    }
  }

  function processStatement(statement: SyntaxNode) {
    const parts = kids(statement);
    switch (statement.type) {
      case "Declaration": {
        const nameNode = parts.find(c => c.type === "VariableName");
        if (!nameNode) throw error("Malformed declaration", statement);
        if (declared.has(nameNode.text)) {
          throw error(`${nameNode.text} was already defined`, nameNode);
        }
        const initializer = parts.find(c => EXPRESSION_TYPES.has(c.type) && c !== nameNode);
        // The initializer is evaluated before the name is bound, so a
        // same-named reference is still an IC10 passthrough.
        const value = initializer ? compileExpression(initializer) : null;
        declared.add(nameNode.text);
        if (value) varValue.set(nameNode.text, value);
        break;
      }
      case "Assignment": {
        const nameNode = parts.find(c => c.type === "VariableName");
        const expression = parts.find(c => EXPRESSION_TYPES.has(c.type) && c !== nameNode);
        if (!nameNode || !expression) throw error("Malformed assignment", statement);
        const value = compileExpression(expression);
        if (declared.has(nameNode.text)) {
          varValue.set(nameNode.text, value);
        } else {
          // Placeholder write: must leave the registers through a move
          instructions.push({ op: "storename", name: nameNode.text, src: value, node: statement });
        }
        break;
      }
      case "Comment":
        break;
      default:
        throw error(`Unexpected statement: ${statement.type}`, statement);
    }
    statementLoads = new Map();
  }

  // ---------------------------------------------------------------------
  // IR helpers
  // ---------------------------------------------------------------------

  function destOf(inst: Inst): number | null {
    switch (inst.op) {
      case "alu":
      case "loadname":
      case "get":
        return inst.dest;
      default:
        return null;
    }
  }

  function operandsOf(inst: Inst): Operand[] {
    switch (inst.op) {
      case "alu":
        return [inst.a, inst.b];
      case "storename":
      case "poke":
        return [inst.src];
      default:
        return [];
    }
  }

  function usesOf(inst: Inst): number[] {
    return operandsOf(inst)
      .filter(o => o.kind === "vreg")
      .map(o => (o as { kind: "vreg"; id: number }).id);
  }

  // ---------------------------------------------------------------------
  // 2. Dead code elimination: keep only what reaches a placeholder write
  // ---------------------------------------------------------------------

  function eliminateDeadCode(program: Inst[]): Inst[] {
    const live = new Set<number>();
    const kept: Inst[] = [];
    for (let i = program.length - 1; i >= 0; i--) {
      const inst = program[i];
      const sideEffect = inst.op === "storename" || inst.op === "poke";
      const dest = destOf(inst);
      if (!sideEffect && (dest === null || !live.has(dest))) continue;
      kept.push(inst);
      for (const used of usesOf(inst)) live.add(used);
    }
    return kept.reverse();
  }

  // ---------------------------------------------------------------------
  // 3. Linear-scan register allocation with spilling
  // ---------------------------------------------------------------------

  function allocateAndEmit(program: Inst[]): string {
    let nextSpillAddr = STACK_TOP;

    for (;;) {
      // Liveness: each vreg is defined once and dies at its last use
      const lastUse = new Map<number, number>();
      const useCount = new Map<number, number>();
      program.forEach((inst, i) => {
        for (const used of usesOf(inst)) {
          lastUse.set(used, i);
          useCount.set(used, (useCount.get(used) ?? 0) + 1);
        }
      });

      const regOf = new Map<number, number>();
      const active: number[] = [];
      let free = [...registerOrder];
      let victim: number | null = null;

      for (let i = 0; i < program.length && victim === null; i++) {
        const dest = destOf(program[i]);
        if (dest === null) continue;

        // Values whose last use is behind us (or in this very instruction)
        // release their register: IC10 reads operands before writing.
        for (let k = active.length - 1; k >= 0; k--) {
          const v = active[k];
          if ((lastUse.get(v) ?? i) <= i) {
            active.splice(k, 1);
            free.push(regOf.get(v)!);
          }
        }

        if (free.length === 0) {
          // Spill the least-used value; break ties toward the one that
          // blocks its register the longest.
          const candidates = [...active, dest].filter(v => !scratch.has(v));
          if (candidates.length === 0) {
            throw error("Expression too complex: not enough registers", program[i].node);
          }
          candidates.sort((x, y) =>
            (useCount.get(x) ?? 0) - (useCount.get(y) ?? 0) ||
            (lastUse.get(y) ?? 0) - (lastUse.get(x) ?? 0) ||
            y - x);
          victim = candidates[0];
          break;
        }

        free.sort((a, b) => registerOrder.indexOf(a) - registerOrder.indexOf(b));
        regOf.set(dest, free.shift()!);
        active.push(dest);
      }

      if (victim === null) {
        // Success: render the IR with real registers
        function fmt(operand: Operand): string {
          return operand.kind === "vreg" ? `r${regOf.get(operand.id)}` : operand.text;
        }
        return program
          .map(inst => {
            switch (inst.op) {
              case "alu": return `${inst.opcode} r${regOf.get(inst.dest)} ${fmt(inst.a)} ${fmt(inst.b)}`;
              case "loadname": return `move r${regOf.get(inst.dest)} ${inst.name}`;
              case "storename": return `move ${inst.name} ${fmt(inst.src)}`;
              case "get": return `get r${regOf.get(inst.dest)} db ${inst.addr}`;
              case "poke": return `poke ${inst.addr} ${fmt(inst.src)}`;
            }
          })
          .join("\n");
      }

      // Rewrite the program with the victim living on the stack
      const addr = nextSpillAddr--;
      if (addr < 0) throw error("Too many variables: out of stack memory", program[0].node);

      const rewritten: Inst[] = [];
      for (const inst of program) {
        if (destOf(inst) === victim) {
          // Define into a short-lived scratch register, then store
          const s = vreg();
          scratch.add(s);
          rewritten.push({ ...inst, dest: s } as Inst);
          rewritten.push({ op: "poke", addr, src: { kind: "vreg", id: s }, node: inst.node });
        } else if (usesOf(inst).includes(victim)) {
          // Reload before use; both operands of one instruction share it
          const s = vreg();
          scratch.add(s);
          rewritten.push({ op: "get", dest: s, addr, node: inst.node });
          const replace = (o: Operand): Operand =>
            o.kind === "vreg" && o.id === victim ? { kind: "vreg", id: s } : o;
          switch (inst.op) {
            case "alu":
              rewritten.push({ ...inst, a: replace(inst.a), b: replace(inst.b) });
              break;
            case "storename":
            case "poke":
              rewritten.push({ ...inst, src: replace(inst.src) });
              break;
          }
        } else {
          rewritten.push(inst);
        }
      }
      program = rewritten;
    }
  }

  checkSyntax(ast);
  for (const statement of ast.children) {
    processStatement(statement);
  }
  return allocateAndEmit(eliminateDeadCode(instructions));
}
