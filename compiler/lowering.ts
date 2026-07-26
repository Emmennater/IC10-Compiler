/**
 * Phase 1: lower the AST to a linear IR over infinite virtual registers.
 *
 * Constants are folded and propagated through variables, and copies never
 * generate code (each assignment just remaps the variable name).
 * Placeholder identifiers (anything not declared with `let`) are read and
 * written only through `move` — they stand in for the l/s/lb/sb/... device
 * instructions to come, which cannot appear as ALU operands.
 *
 * If/loop conditions compile to fused branches (ble/bgez/bnez/...);
 * && and || short-circuit. A variable assigned inside a branch or loop
 * body is demoted to a "home" vreg: every path writes the same vreg, so
 * merge points and back edges need no phis. Inside a loop body the
 * variable's compile-time constant is forgotten (the back edge may change
 * it); constant conditions skip branches entirely.
 *
 * The pass is built from FRAMES. A frame is an immutable description of
 * where code is being lowered — which buffer to emit into, which scopes are
 * visible, where `return` and `break` go, which functions are mid-lowering.
 * Entering a function body, a block, a loop, or an inlined parameter's
 * caller scope constructs a NEW frame; leaving it is simply returning from
 * the call. Nothing is saved and nothing is restored, because the caller's
 * frame was never modified — the JavaScript call stack is the only stack.
 */

import {
  kids, blockOf, conditionOf,
  EXPRESSION_TYPES, STATEMENT_TYPES,
  type ErrorReporter, type SyntaxNode,
} from "./syntax.ts";
import {
  constBoolOp, constOp, constTextOp, destOf, idRange, isConstText, isZero, setDest, symOp,
  type ConstOperand, type IdAllocator, type IfRegion, type Inst, type LoopRegion,
  type Operand, type UnnumberedInst,
} from "./ir.ts";
import {
  AGGREGATORS, ALU_OPCODES, BRANCH_FALSE, BRANCH_TRUE, MIRROR, OP_TYPES,
  OPCODE_ALIASES, SET_OPCODES,
  applyArithmetic, compare, isComparison,
} from "./tables.ts";
import { ScopeChain, type Scope, type VarState } from "./symbols.ts";
import { collectAssignedNames, countReturns, fnVarRefs, type FnInfo, type FnTable } from "./functions.ts";
import { ConstexprEvaluator } from "./constexpr.ts";
import { LabelFactory } from "./labels.ts";
import { StatementScope } from "./statement-scope.ts";
import { foldExpression, pressure } from "./folding.ts";

/** Everything phase 2 (optimization) needs from lowering. */
export type LoweredProgram = {
  program: Inst[];
  ifRegions: IfRegion[];
  loopRegions: LoopRegion[];
};

/** What the base of a property access refers to. */
type ResolvedBase =
  | { kind: "device"; text: string }
  | { kind: "define"; text: string }
  | { kind: "unknown"; name: string };

/** Bookkeeping for one variable demoted to a home vreg at a control-flow fork. */
type Demoted = {
  state: VarState;
  savedHome: number | null;
  entryValue: Operand | null;
  entryMaybe: boolean;
};

/** Where `break` / `continue` jump inside the innermost enclosing loop. */
type LoopTargets = { breakLabel: string; continueLabel: string };

/** Where `return` delivers its value and jumps to. */
type ReturnTarget = { home: number; endLabel: string };

/**
 * Services shared by every frame of one compilation: id sequences, label
 * naming, the function table, and the output region records. These are the
 * genuinely global registries — everything contextual lives on the frame.
 */
type Services = {
  readonly errors: ErrorReporter;
  readonly ids: IdAllocator;
  readonly labels: LabelFactory;
  readonly fnTable: FnTable;
  readonly registeredFnNodes: Set<SyntaxNode>;
  // Globals referenced by any jal-called function get a permanent home
  // register the moment they are declared, so initialization stays where
  // the source put it and every later write goes through the home.
  readonly fnGlobalNames: Set<string>;
  /** vregs known to hold an exact 0/1 value. */
  readonly boolVregs: Set<number>;
  readonly ifRegions: IfRegion[];
  readonly loopRegions: LoopRegion[];
  readonly constexpr: ConstexprEvaluator;
};

/** The immutable context one frame lowers code in. */
type FrameContext = {
  /** The buffer this frame appends instructions to. */
  readonly buffer: Inst[];
  /** The scopes visible here and the function-visibility boundary. */
  readonly chain: ScopeChain;
  /** Placeholder-read cache and vreg watermark of the current statement. */
  readonly statements: StatementScope;
  readonly returnTarget: ReturnTarget | null;
  readonly loop: LoopTargets | null;
  /** Functions whose lowering encloses this frame (recursion detection). */
  readonly active: ReadonlySet<string>;
};

/** `set` plus one element, as a new set — frames never mutate their context. */
function including(set: ReadonlySet<string>, name: string): ReadonlySet<string> {
  return new Set(set).add(name);
}

export class Lowerer {
  private readonly services: Services;
  private readonly ast: SyntaxNode;

  constructor(
    ast: SyntaxNode,
    errors: ErrorReporter,
    ids: IdAllocator,
  ) {
    this.ast = ast;
    const fnTable: FnTable = new Map();
    this.services = {
      errors,
      ids,
      labels: new LabelFactory(),
      fnTable,
      registeredFnNodes: new Set(),
      fnGlobalNames: new Set(),
      boolVregs: new Set(),
      ifRegions: [],
      loopRegions: [],
      constexpr: new ConstexprEvaluator(fnTable),
    };
  }

  /** Lower the whole tree and assemble headers, functions, and main code. */
  lower(): LoweredProgram {
    this.registerFunctions();
    this.collectFnGlobalNames();

    const mainBuffer: Inst[] = [];
    const root = new FrameLowerer(this.services, {
      buffer: mainBuffer,
      chain: ScopeChain.root(),
      statements: new StatementScope(0),
      returnTarget: null,
      loop: null,
      active: new Set(),
    });
    for (const statement of this.ast.children) {
      root.processStatement(statement);
    }

    return {
      program: this.assembleProgram(mainBuffer),
      ifRegions: this.services.ifRegions,
      loopRegions: this.services.loopRegions,
    };
  }

  /** Register all top-level function definitions before lowering anything. */
  private registerFunctions(): void {
    const { errors, fnTable, registeredFnNodes } = this.services;
    let pendingConstexpr = false;
    for (const statement of kids(this.ast)) {
      if (statement.type === "PreprocessorDirective") {
        const directive = kids(statement).find(c => c.type === "DirectiveName");
        if (directive?.text !== "constexpr") {
          throw errors.error(`Unknown directive @${directive?.text ?? ""}`, statement);
        }
        pendingConstexpr = true;
        continue;
      }
      if (statement.type === "FunctionDef") {
        const parts = kids(statement);
        const nameNode = parts.find(c => c.type === "FunctionName");
        const block = parts.find(c => c.type === "FunctionBlock");
        if (!nameNode || !block) throw errors.error("Malformed function definition", statement);
        if (fnTable.has(nameNode.text)) {
          throw errors.error(`${nameNode.text} was already defined`, nameNode);
        }
        const blockIdx = parts.indexOf(block);
        const params = parts.slice(0, blockIdx).filter(c => c.type === "VariableName").map(c => c.text);
        fnTable.set(nameNode.text, {
          name: nameNode.text,
          params,
          body: kids(block).filter(c => STATEMENT_TYPES.has(c.type)),
          constexpr: pendingConstexpr,
          node: statement,
          callCount: 0,
          paramVregs: null,
          retVreg: null,
          lowered: null,
          varRefs: null,
          varWrites: null,
        });
        registeredFnNodes.add(statement);
      }
      pendingConstexpr = false;
    }

    // Count call sites for the inline-single-use decision
    const countIn = (node: SyntaxNode): void => {
      if (node.type === "FunctionCall") {
        const name = kids(node).find(c => c.type === "FunctionName")?.text;
        const fn = name ? fnTable.get(name) : undefined;
        if (fn) fn.callCount++;
      }
      for (const child of node.children) countIn(child);
    };
    countIn(this.ast);
  }

  private collectFnGlobalNames(): void {
    const { fnTable, fnGlobalNames } = this.services;
    for (const fn of fnTable.values()) {
      if (fn.callCount < 2) continue; // single-site functions inline
      for (const name of fnVarRefs(fn, fnTable).refs) fnGlobalNames.add(name);
    }
  }

  /**
   * Assemble the final instruction stream: alias/define lines first (from
   * line 0), then jal-lowered function bodies (jumped over), then the main
   * program.
   */
  private assembleProgram(mainBuffer: Inst[]): Inst[] {
    const { fnTable, ids, labels } = this.services;
    const loweredFns = [...fnTable.values()].filter(fn => fn.lowered);
    const isHeader = (inst: Inst): boolean => inst.op === "alias" || inst.op === "definedef";
    const buffers = [mainBuffer, ...loweredFns.map(fn => fn.lowered!)];
    const headers = buffers.flatMap(buffer => buffer.filter(isHeader)).sort((a, b) => a.id - b.id);
    const mainBody = mainBuffer.filter(inst => !isHeader(inst));
    if (loweredFns.length === 0) {
      return [...headers, ...mainBody];
    }
    return [
      ...headers,
      { op: "jump", target: labels.programStart, node: this.ast, id: ids.newInstId() },
      ...loweredFns.flatMap(fn => fn.lowered!.filter(inst => !isHeader(inst))),
      { op: "label", name: labels.programStart, node: this.ast, id: ids.newInstId() },
      ...mainBody,
    ];
  }
}

/**
 * One lexical frame of the lowering pass. `this` IS the context: the
 * methods below read their surroundings from immutable fields, and every
 * construct that changes those surroundings — a block, a loop body, a
 * function body, an inlined parameter's caller scope — runs in a new frame
 * built by `withContext`. There is no save/restore anywhere in this file;
 * an error thrown from any depth simply unwinds through frames that were
 * never mutated in the first place.
 */
class FrameLowerer {
  private readonly shared: Services;
  private readonly cx: FrameContext;

  constructor(shared: Services, cx: FrameContext) {
    this.shared = shared;
    this.cx = cx;
  }

  /** A frame like this one, differing only in the given context fields. */
  private withContext(overrides: Partial<FrameContext>): FrameLowerer {
    return new FrameLowerer(this.shared, { ...this.cx, ...overrides });
  }

  // Shorthands so method bodies read naturally
  private get errors() { return this.shared.errors; }
  private get ids() { return this.shared.ids; }
  private get labels() { return this.shared.labels; }
  private get fnTable() { return this.shared.fnTable; }
  private get boolVregs() { return this.shared.boolVregs; }
  private get buffer() { return this.cx.buffer; }
  private get chain() { return this.cx.chain; }
  private get statements() { return this.cx.statements; }

  // ------------------------------ emission ------------------------------

  private emit(inst: UnnumberedInst): Inst {
    const complete = this.createInst(inst);
    this.buffer.push(complete);
    return complete;
  }

  /** Number an instruction without appending it (for the push-ra splice). */
  private createInst(inst: UnnumberedInst): Inst {
    // The cast is sound: spreading a distributed Omit<Inst, "id"> and
    // restoring "id" reconstructs the same union member.
    return { ...inst, id: this.ids.newInstId() } as Inst;
  }

  private lastEmitted(): Inst | undefined {
    return this.buffer[this.buffer.length - 1];
  }

  // -------------------------- constant folding --------------------------

  /**
   * Fold an expression to a compile-time constant, resolving variable names
   * against this frame's chain. The folding itself lives in `folding.ts`;
   * this supplies the only thing it cannot know on its own.
   */
  private fold(node: SyntaxNode): ConstOperand | null {
    return foldExpression(node, name => {
      const state = this.chain.lookupVar(name);
      if (state && !state.maybe && state.value?.kind === "const") return state.value;
      return null;
    });
  }

  /** Register pressure of a subtree, used only to pick evaluation order. */
  private pressureOf(node: SyntaxNode): number {
    return pressure(node, name => this.chain.lookup(name) !== null);
  }

  // ---------------------------- booleans --------------------------------

  private isBoolOperand(operand: Operand): boolean {
    if (operand.kind === "const") return operand.text === "0" || operand.text === "1";
    return operand.kind === "vreg" && this.boolVregs.has(operand.id);
  }

  /** Coerce an operand to an exact 0/1 value (IC10 and/or are bitwise). */
  private toBool(operand: Operand, node: SyntaxNode): Operand {
    if (this.isBoolOperand(operand)) return operand;
    if (operand.kind === "const") {
      return constBoolOp(parseFloat(operand.text) !== 0);
    }
    const dest = this.ids.newVreg();
    this.emit({ op: "alu", opcode: "snez", dest, args: [operand], node });
    this.boolVregs.add(dest);
    return { kind: "vreg", id: dest };
  }

  /** Emit a comparison as a 0/1 value, using the zero-compare forms when possible. */
  private emitComparison(op: string, a: Operand, b: Operand, node: SyntaxNode): Operand {
    if (a.kind === "const" && b.kind === "const") {
      return constBoolOp(compare(op, parseFloat(a.text), parseFloat(b.text)));
    }
    if (isZero(a)) {
      [op, a, b] = [MIRROR[op], b, a];
    }
    const dest = this.ids.newVreg();
    if (isZero(b)) {
      this.emit({ op: "alu", opcode: `${SET_OPCODES[op]}z`, dest, args: [a], node });
    } else {
      this.emit({ op: "alu", opcode: SET_OPCODES[op], dest, args: [a, b], node });
    }
    this.boolVregs.add(dest);
    return { kind: "vreg", id: dest };
  }

  // ------------------------ property accesses ---------------------------

  /** Pieces of a Device*Property node: base, property name, bracket index. */
  private propertyParts(node: SyntaxNode) {
    const parts = kids(node);
    return {
      base: parts[0],
      prop: parts[parts.length - 1],
      index: node.type === "DeviceProperty" ? null : parts[2],
    };
  }

  private resolveBase(base: SyntaxNode): ResolvedBase {
    if (base.type === "Device") return { kind: "device", text: base.text };
    const symbol = this.chain.lookup(base.text);
    if (symbol?.kind === "device") return { kind: "device", text: base.text };
    if (symbol?.kind === "define") return { kind: "define", text: symbol.text };
    if (symbol?.kind === "var") {
      throw this.errors.error(`${base.text} is a variable, not a device or define`, base);
    }
    return { kind: "unknown", name: base.text };
  }

  /**
   * Function-call arguments: identifiers pass through verbatim (logic types,
   * devices, defines — they are instruction operands, not values to load);
   * strings name IC10 symbols directly; everything else compiles normally.
   */
  private compileCallArg(node: SyntaxNode): Operand {
    if (node.type === "Device") return symOp(node.text);
    if (node.type === "String") return symOp(node.text.slice(1, -1));
    if (node.type === "VariableName") {
      const symbol = this.chain.lookup(node.text);
      if (!symbol) return symOp(node.text);
      if (symbol.kind === "device") return symOp(node.text);
    }
    return this.compileExpression(node);
  }

  /** The slot index of a device[...] access. */
  private slotIndexOperand(index: SyntaxNode): Operand {
    if (index.type === "Integer") return constTextOp(index.text);
    if (index.type === "String") throw this.errors.error("Slot indexes must be numbers", index);
    return this.compileCallArg(index);
  }

  /** The name filter of a deviceGroup[...] access, hashed when a string. */
  private nameHashOperand(index: SyntaxNode): Operand {
    if (index.type === "String") return symOp(`HASH(${index.text})`);
    return this.compileCallArg(index);
  }

  // ------------------------------ calls ---------------------------------

  /**
   * A function call maps directly onto an IC10 instruction: the name is the
   * opcode and, when the result is used, the destination register is the
   * first operand. Aggregators (Sum/Average/...) become batch reads.
   * User-defined functions take precedence over raw opcodes.
   */
  private compileCall(node: SyntaxNode, wantValue: boolean): Operand | null {
    const parts = kids(node);
    const name = parts[0].text;
    const argNodes = parts.filter(c => EXPRESSION_TYPES.has(c.type));

    const fn = this.fnTable.get(name);
    if (fn) return this.compileUserCall(fn, argNodes, node, wantValue);

    if (AGGREGATORS.has(name)) {
      return this.compileAggregator(name, argNodes, node, wantValue);
    }

    const opcode = OPCODE_ALIASES[name] ?? name;
    const args = argNodes.map(a => this.compileCallArg(a));
    if (!wantValue) {
      this.emit({ op: "call", opcode, dest: null, args, node });
      return null;
    }
    const dest = this.ids.newVreg();
    this.emit({ op: "call", opcode, dest, args, node });
    return { kind: "vreg", id: dest };
  }

  private compileUserCall(
    fn: FnInfo,
    argNodes: SyntaxNode[],
    node: SyntaxNode,
    wantValue: boolean,
  ): Operand | null {
    if (argNodes.length !== fn.params.length) {
      throw this.errors.error(
        `${fn.name} expects ${fn.params.length} argument${fn.params.length === 1 ? "" : "s"}`, node);
    }

    // Constant arguments to a @constexpr function: run it now
    if (fn.constexpr) {
      const folded = argNodes.map(a => this.fold(a));
      if (folded.every(v => v !== null)) {
        const result = this.shared.constexpr.evaluate(fn, folded.map(v => parseFloat(v!.text)));
        if (result !== null) {
          const value = constOp(result);
          if (value) return wantValue ? value : null;
        }
      }
    }

    // A function with a single call site is inlined at that site
    if (fn.callCount === 1) return this.inlineCall(fn, argNodes, node, wantValue);

    // jal-style call: arguments land in the function's parameter vregs
    const args = argNodes.map(a => this.compileExpression(a));
    if (!fn.lowered) this.lowerFunction(fn, node);
    args.forEach((a, i) => this.emit({ op: "movev", dest: fn.paramVregs![i], src: a, node }));
    this.emit({ op: "jal", target: fn.name, node });
    // Globals the function assigns are no longer compile-time constants
    for (const globalName of fnVarRefs(fn, this.fnTable).writes) {
      const symbol = this.chain.globalGet(globalName);
      if (symbol?.kind !== "var" || symbol.state.home === null) continue;
      symbol.state.value = { kind: "vreg", id: symbol.state.home };
    }
    if (!wantValue) return null;
    // Copy the result out so a later call cannot clobber it; the copy
    // vanishes when the allocator gives both sides the same register.
    const copy = this.ids.newVreg();
    this.emit({ op: "movev", dest: copy, src: { kind: "vreg", id: fn.retVreg! }, node });
    return { kind: "vreg", id: copy };
  }

  private compileAggregator(
    name: string,
    argNodes: SyntaxNode[],
    node: SyntaxNode,
    wantValue: boolean,
  ): Operand {
    if (!wantValue) throw this.errors.error(`${name}(...) must be assigned to something`, node);
    const arg = argNodes.length === 1 ? argNodes[0] : null;
    if (!arg || (arg.type !== "DeviceProperty" && arg.type !== "DeviceNameProperty")) {
      throw this.errors.error(`${name} expects one deviceHash.LogicType argument`, arg ?? node);
    }
    const { base, prop, index } = this.propertyParts(arg);
    const resolved = this.resolveBase(base);
    if (resolved.kind === "device") {
      throw this.errors.error(`${name} works on device groups, not single devices`, base);
    }
    const hash = resolved.kind === "define" ? symOp(resolved.text) : symOp(`HASH("${resolved.name}")`);
    const dest = this.ids.newVreg();
    if (arg.type === "DeviceProperty") {
      this.emit({ op: "call", opcode: "lb", dest, args: [hash, symOp(prop.text), symOp(name)], node });
    } else {
      this.emit({
        op: "call", opcode: "lbn", dest,
        args: [hash, this.nameHashOperand(index!), symOp(prop.text), symOp(name)],
        node,
      });
    }
    return { kind: "vreg", id: dest };
  }

  // ---------------------------- expressions -----------------------------

  private compileExpression(node: SyntaxNode): Operand {
    switch (node.type) {
      case "Number":
        return constOp(parseFloat(node.text)) ?? constTextOp(node.text);
      case "Bool":
        return constBoolOp(node.text === "true");
      case "String":
        // Strings are hashed; HASH("...") is resolved by the game
        return symOp(`HASH(${node.text})`);
      case "Device":
        throw this.errors.error(`${node.text} is a device, not a value`, node);
      case "DeviceProperty": {
        const { base, prop } = this.propertyParts(node);
        const resolved = this.resolveBase(base);
        if (resolved.kind === "device") {
          const dest = this.ids.newVreg();
          this.emit({ op: "call", opcode: "l", dest, args: [symOp(resolved.text), symOp(prop.text)], node });
          return { kind: "vreg", id: dest };
        }
        if (resolved.kind === "define") {
          throw this.errors.error(
            "Reading from a device group needs an aggregator (Sum, Average, Minimum, Maximum)", node);
        }
        // Unknown identifiers: a game constant like DisplayMode.Seconds
        return symOp(`${resolved.name}.${prop.text}`);
      }
      case "DeviceChannelProperty":
      case "DeviceNameProperty": {
        const { base, prop, index } = this.propertyParts(node);
        const resolved = this.resolveBase(base);
        if (resolved.kind !== "device") {
          throw this.errors.error(
            "Reading from a device group needs an aggregator (Sum, Average, Minimum, Maximum)", node);
        }
        const dest = this.ids.newVreg();
        this.emit({
          op: "call", opcode: "ls", dest,
          args: [symOp(resolved.text), this.slotIndexOperand(index!), symOp(prop.text)],
          node,
        });
        return { kind: "vreg", id: dest };
      }
      case "FunctionCall":
        return this.compileCall(node, true)!;
      case "VariableName":
        return this.compileVariableRead(node);
      case "Parens": {
        const inner = kids(node).find(c => EXPRESSION_TYPES.has(c.type));
        if (!inner) throw this.errors.error("Empty parentheses", node);
        return this.compileExpression(inner);
      }
      case "UnaryOp":
        return this.compileUnaryOp(node);
      case "BinaryOp":
        return this.compileBinaryOp(node);
      default:
        throw this.errors.error(`Unexpected expression: ${node.type}`, node);
    }
  }

  private compileVariableRead(node: SyntaxNode): Operand {
    const name = node.text;
    const symbol = this.chain.lookup(name);
    if (symbol?.kind === "var") {
      const state = symbol.state;
      if (state.maybe) throw this.errors.error(`${name} may be undefined`, node);
      if (!state.value) throw this.errors.error(`${name} is used before being assigned`, node);
      return state.value;
    }
    if (symbol?.kind === "define") return symOp(symbol.text);
    if (symbol?.kind === "device") {
      throw this.errors.error(`${name} is a device, not a value`, node);
    }
    if (symbol?.kind === "alias") {
      // Inlined read-only parameter: compile the argument expression in the
      // caller's chain, where its names resolve. The chain is an immutable
      // value the alias captured for free — nothing to swap in or out.
      return this.withContext({ chain: symbol.callerChain }).compileExpression(symbol.argNode);
    }
    // Placeholder read: must come into a register through a move
    const cached = this.statements.cachedLoad(name);
    if (cached !== undefined) return { kind: "vreg", id: cached };
    const dest = this.ids.newVreg();
    this.emit({ op: "loadname", dest, name, node });
    this.statements.rememberLoad(name, dest);
    return { kind: "vreg", id: dest };
  }

  private compileUnaryOp(node: SyntaxNode): Operand {
    const [op, operandNode] = kids(node);
    if (op.text === "+") return this.compileExpression(operandNode);
    const a = this.compileExpression(operandNode);
    if (op.text === "!") {
      // Logical NOT: seqz gives an exact 0/1 for any input
      if (a.kind === "const") {
        return constBoolOp(parseFloat(a.text) === 0);
      }
      const dest = this.ids.newVreg();
      this.emit({ op: "alu", opcode: "seqz", dest, args: [a], node });
      this.boolVregs.add(dest);
      return { kind: "vreg", id: dest };
    }
    if (a.kind === "const") {
      const folded = constOp(-parseFloat(a.text));
      if (folded) return folded;
    }
    const dest = this.ids.newVreg();
    this.emit({ op: "alu", opcode: "sub", dest, args: [constTextOp("0"), a], node });
    return { kind: "vreg", id: dest };
  }

  private compileBinaryOp(node: SyntaxNode): Operand {
    const [leftNode, opNode, rightNode] = kids(node);
    const op = opNode.text;

    // Evaluate the register-hungrier side first to minimize live values
    let a: Operand;
    let b: Operand;
    if (this.pressureOf(rightNode) > this.pressureOf(leftNode)) {
      b = this.compileExpression(rightNode);
      a = this.compileExpression(leftNode);
    } else {
      a = this.compileExpression(leftNode);
      b = this.compileExpression(rightNode);
    }

    if (isComparison(op)) return this.emitComparison(op, a, b, node);

    if (op === "&&" || op === "||") {
      // As data, outside a condition. Dropped operands were pure; any
      // loads they emitted are cleaned up by dead code elimination.
      if (a.kind === "const") {
        const truthy = parseFloat(a.text) !== 0;
        if (op === "&&") return truthy ? this.toBool(b, node) : constBoolOp(false);
        return truthy ? constBoolOp(true) : this.toBool(b, node);
      }
      if (b.kind === "const") {
        const truthy = parseFloat(b.text) !== 0;
        if (op === "&&") return truthy ? this.toBool(a, node) : constBoolOp(false);
        return truthy ? constBoolOp(true) : this.toBool(a, node);
      }
      const dest = this.ids.newVreg();
      this.emit({
        op: "alu", opcode: op === "&&" ? "and" : "or", dest,
        args: [this.toBool(a, node), this.toBool(b, node)], node,
      });
      this.boolVregs.add(dest);
      return { kind: "vreg", id: dest };
    }

    // Arithmetic: constant folding first
    // (constants propagated through variables included)
    if (a.kind === "const" && b.kind === "const") {
      const folded = constOp(applyArithmetic(op, parseFloat(a.text), parseFloat(b.text)));
      if (folded) return folded;
    }

    // Algebraic identities that make the whole operation free
    if (op === "+" && isConstText(a, "0")) return b;
    if ((op === "+" || op === "-") && isConstText(b, "0")) return a;
    if (op === "*" && isConstText(a, "1")) return b;
    if ((op === "*" || op === "/") && isConstText(b, "1")) return a;

    const dest = this.ids.newVreg();
    this.emit({ op: "alu", opcode: ALU_OPCODES[op], dest, args: [a, b], node });
    return { kind: "vreg", id: dest };
  }

  // ---------------------------- conditions ------------------------------

  /**
   * Compile a condition as control flow: branch to `target` when the
   * condition's truth equals `jumpWhen`, fall through otherwise.
   * Comparisons fuse into a single branch instruction; && and ||
   * short-circuit (so a placeholder load on the right is skipped when the
   * left side already decided).
   */
  private compileCondition(node: SyntaxNode, target: string, jumpWhen: boolean): void {
    switch (node.type) {
      case "Parens": {
        const inner = kids(node).find(c => EXPRESSION_TYPES.has(c.type));
        if (!inner) throw this.errors.error("Empty parentheses", node);
        this.compileCondition(inner, target, jumpWhen);
        return;
      }
      case "UnaryOp": {
        // Logical NOT in a condition is free: flip the branch polarity
        const [op, operandNode] = kids(node);
        if (op.text === "!") {
          this.compileCondition(operandNode, target, !jumpWhen);
          return;
        }
        break; // arithmetic negation: fall through to truthiness
      }
      case "BinaryOp": {
        const [leftNode, opNode, rightNode] = kids(node);
        const op = opNode.text;
        if (isComparison(op)) {
          let a = this.compileExpression(leftNode);
          let b = this.compileExpression(rightNode);
          let cmp = op;
          if (a.kind === "const" && b.kind === "const") {
            const outcome = compare(cmp, parseFloat(a.text), parseFloat(b.text));
            if (outcome === jumpWhen) this.emit({ op: "jump", target, node });
            return;
          }
          if (isZero(a)) {
            [cmp, a, b] = [MIRROR[cmp], b, a];
          }
          const table = jumpWhen ? BRANCH_TRUE : BRANCH_FALSE;
          if (isZero(b)) {
            this.emit({ op: "branch", opcode: `${table[cmp]}z`, args: [a], target, node });
          } else {
            this.emit({ op: "branch", opcode: table[cmp], args: [a, b], target, node });
          }
          return;
        }
        if (op === "&&" || op === "||") {
          // Short-circuit: chain branches instead of materializing a boolean
          const bothMustDecide = (op === "&&") === !jumpWhen;
          if (bothMustDecide) {
            // (&& jumping on false) or (|| jumping on true): either side decides alone
            this.compileCondition(leftNode, target, jumpWhen);
            this.compileCondition(rightNode, target, jumpWhen);
          } else {
            // The left side alone can settle the outcome the other way
            const skip = this.labels.newShortCircuit();
            this.compileCondition(leftNode, skip, !jumpWhen);
            this.compileCondition(rightNode, target, jumpWhen);
            this.emit({ op: "label", name: skip, node });
          }
          return;
        }
        break; // arithmetic: fall through to truthiness
      }
    }
    // Truthiness of an arbitrary value: compare against zero
    const value = this.compileExpression(node);
    if (value.kind === "const") {
      const truthy = parseFloat(value.text) !== 0;
      if (truthy === jumpWhen) this.emit({ op: "jump", target, node });
      return;
    }
    this.emit({ op: "branch", opcode: jumpWhen ? "bnez" : "beqz", args: [value], target, node });
  }

  // ---------------------------- assignment ------------------------------

  /**
   * Put a value into a specific vreg, retargeting the instruction that just
   * produced it instead of adding a move whenever possible.
   */
  private writeThrough(home: number, value: Operand, node: SyntaxNode): void {
    const last = this.lastEmitted();
    if (
      value.kind === "vreg" &&
      this.statements.ownsVreg(value.id) &&
      last !== undefined &&
      destOf(last) === value.id
    ) {
      setDest(last, home);
    } else {
      this.emit({ op: "movev", dest: home, src: value, node });
    }
  }

  /**
   * Record an assignment's value. For demoted variables (inside an if/loop
   * that assigns them) the value is also written to the home vreg.
   */
  private assignVariable(state: VarState, value: Operand, node: SyntaxNode): void {
    if (state.home !== null) {
      this.writeThrough(state.home, value, node);
      state.value = value.kind === "const" ? value : { kind: "vreg", id: state.home };
    } else {
      state.value = value;
    }
    state.maybe = false;
  }

  // ---------------------- variable demotion at merges -------------------
  //
  // Demotion deliberately saves and restores VARIABLE KNOWLEDGE (what value
  // a variable holds on this control-flow path) — that is the phi-avoidance
  // algorithm itself, modeling the program being compiled. It is not
  // compiler context; frames carry that.

  /**
   * Demote every visible variable in `names` to a home vreg: reuse the
   * variable's own vreg when it owns one outright, otherwise materialize
   * the current value into a fresh register before the control flow forks.
   */
  private demoteVariables(names: Set<string>, node: SyntaxNode): Demoted[] {
    const demoted: Demoted[] = [];
    for (const name of names) {
      const symbol = this.chain.lookup(name);
      if (symbol?.kind !== "var") continue; // placeholder writes need no merge handling
      const state = symbol.state;
      const record: Demoted = {
        state,
        savedHome: state.home,
        entryValue: state.value,
        entryMaybe: state.maybe,
      };
      if (state.home === null) {
        if (state.value?.kind === "vreg" && this.chain.valueRefCount(state.value.id) === 1) {
          // The variable owns this vreg outright: adopt it as the home.
          // (Scratch spill registers cannot appear here: spilling only
          // happens after all lowering is finished.)
          state.home = state.value.id;
        } else {
          state.home = this.ids.newVreg();
          if (state.value) {
            this.emit({ op: "movev", dest: state.home, src: state.value, node });
            state.value = { kind: "vreg", id: state.home };
          }
        }
      }
      demoted.push(record);
    }
    return demoted;
  }

  /** After the construct: the variable lives in its home register. */
  private finalizeDemoted(demoted: Demoted[], definitelyAssigned: (d: Demoted) => boolean): void {
    for (const d of demoted) {
      d.state.value = { kind: "vreg", id: d.state.home! };
      d.state.maybe = !definitelyAssigned(d);
      d.state.home = d.savedHome;
    }
  }

  // ------------------------------- if -----------------------------------

  /** Lower a block's statements in a frame with one fresh scope on top. */
  private processBlockScoped(statements: SyntaxNode[]): void {
    const block = this.withContext({ chain: this.chain.child() });
    for (const statement of statements) block.processStatement(statement);
  }

  private processIf(node: SyntaxNode): void {
    type Arm = { cond: SyntaxNode | null; block: SyntaxNode[]; node: SyntaxNode };
    const parsedArms: Arm[] = [];
    for (const part of kids(node)) {
      if (part.type === "If" || part.type === "ElseIf" || part.type === "Else") {
        const cond = part.type === "Else" ? null : conditionOf(part);
        parsedArms.push({ cond, block: blockOf(part), node: part });
      }
    }

    // Resolve compile-time constant conditions: a false arm disappears, a
    // true arm becomes the unconditional tail of the chain.
    const arms: Arm[] = [];
    for (const arm of parsedArms) {
      if (!arm.cond) {
        arms.push(arm);
        break;
      }
      const folded = this.fold(arm.cond);
      if (!folded) {
        arms.push(arm);
        continue;
      }
      if (parseFloat(folded.text) !== 0) {
        arms.push({ ...arm, cond: null });
        break;
      }
      // Constant false: drop the arm entirely
    }

    if (arms.length === 0) return;
    if (arms[0].cond === null) {
      // The whole if reduced to one unconditional arm
      this.processBlockScoped(arms[0].block);
      return;
    }

    // Demote every outer variable assigned in any arm, so all paths agree
    // on where the variable lives at the merge point.
    const assignedNames = new Set<string>();
    for (const arm of arms) collectAssignedNames(arm.block, this.fnTable, assignedNames);
    const demoted = this.demoteVariables(assignedNames, node);

    const chainLabels = this.labels.newIf();
    const endLabel = chainLabels.end;
    const armLabels: (string | null)[] = arms.map((arm, i) => {
      if (i === 0) return null;
      return arm.cond ? chainLabels.nextElif() : chainLabels.otherwise;
    });

    const region: IfRegion = { arms: [], endLabelName: endLabel, endLabelId: -1 };
    let assignedInAllArms = true;

    for (let i = 0; i < arms.length; i++) {
      const arm = arms[i];
      // Each arm starts from the pre-if variable state
      for (const d of demoted) {
        d.state.value = d.entryValue;
        d.state.maybe = d.entryMaybe;
      }

      const condFrom = this.ids.nextInstId;
      if (arm.cond) {
        const next = armLabels[i + 1] ?? endLabel;
        this.compileCondition(arm.cond, next, false);
        this.statements.clearLoads();
      }
      const condIds = idRange(condFrom, this.ids.nextInstId);
      const branchIds = this.buffer
        .filter(inst => inst.id >= condFrom && inst.id < this.ids.nextInstId && inst.op === "branch")
        .map(inst => inst.id);

      const bodyFrom = this.ids.nextInstId;
      this.processBlockScoped(arm.block);
      const bodyTo = this.ids.nextInstId - 1;

      // Did this arm leave every demoted variable definitely assigned?
      for (const d of demoted) {
        if (d.state.maybe || d.state.value === null) assignedInAllArms = false;
      }

      if (i < arms.length - 1) {
        const jumpId = this.emit({ op: "jump", target: endLabel, node: arm.node }).id;
        const labelName = armLabels[i + 1]!;
        const labelId = this.emit({ op: "label", name: labelName, node: arm.node }).id;
        region.arms.push({
          condIds, branchIds, bodyFrom, bodyTo, jumpId, labelName, labelId,
          nextIsElse: arms[i + 1].cond === null,
        });
      } else {
        region.arms.push({
          condIds, branchIds, bodyFrom, bodyTo,
          jumpId: null, labelName: null, labelId: null, nextIsElse: false,
        });
      }
    }

    // A chain without an else has an implicit empty arm
    const hasElse = arms[arms.length - 1].cond === null;

    region.endLabelId = this.emit({ op: "label", name: endLabel, node }).id;
    this.shared.ifRegions.push(region);

    this.finalizeDemoted(demoted, d =>
      (d.entryValue !== null && !d.entryMaybe) || (hasElse && assignedInAllArms));
  }

  // ------------------------------ loops ---------------------------------

  /** Shared lowering for all loop kinds once labels and demotion are set up. */
  private lowerLoopBody(
    body: SyntaxNode[],
    demoted: Demoted[],
    headLabel: string,
    breakLabel: string,
    continueLabel: string,
    node: SyntaxNode,
  ): { headLabelId: number; bodyFrom: number; bodyTo: number } {
    // Inside the body, a demoted variable's value may come from a previous
    // iteration: forget constants, and treat unassigned entries as maybes.
    for (const d of demoted) {
      d.state.value = { kind: "vreg", id: d.state.home! };
      d.state.maybe = d.entryMaybe || d.entryValue === null;
    }
    const headLabelId = this.emit({ op: "label", name: headLabel, node }).id;
    const bodyFrom = this.ids.nextInstId;
    this.withContext({ loop: { breakLabel, continueLabel } }).processBlockScoped(body);
    const bodyTo = this.ids.nextInstId - 1;
    return { headLabelId, bodyFrom, bodyTo };
  }

  private processLoop(node: SyntaxNode): void {
    const body = blockOf(node);
    const assigned = new Set<string>();
    collectAssignedNames(body, this.fnTable, assigned);
    const demoted = this.demoteVariables(assigned, node);

    const { head, end } = this.labels.newLoop();
    const { headLabelId, bodyFrom, bodyTo } = this.lowerLoopBody(body, demoted, head, end, head, node);
    const backJumpId = this.emit({ op: "jump", target: head, node }).id;
    this.emit({ op: "label", name: end, node });
    this.shared.loopRegions.push({ headLabelId, backJumpId, bodyFrom, bodyTo });

    // `loop` only exits through break: whether a variable was assigned by
    // the time of the break is path-dependent, so stay conservative.
    this.finalizeDemoted(demoted, d => d.entryValue !== null && !d.entryMaybe);
  }

  private processWhile(node: SyntaxNode): void {
    const cond = conditionOf(node);
    if (!cond) throw this.errors.error("Malformed while loop", node);

    // Entry-state fold: sound only for the "never runs" decision, because
    // it is decided once, before any body assignment can change a variable.
    const entryFolded = this.fold(cond);
    if (entryFolded && parseFloat(entryFolded.text) === 0) return; // never runs

    const body = blockOf(node);
    const assigned = new Set<string>();
    collectAssignedNames(body, this.fnTable, assigned);
    const demoted = this.demoteVariables(assigned, node);

    const { head, end } = this.labels.newWhile();

    for (const d of demoted) {
      d.state.value = { kind: "vreg", id: d.state.home! };
      d.state.maybe = d.entryMaybe || d.entryValue === null;
    }
    // Steady-state fold, after demoted variables forgot their entry
    // constants: the branch at the head runs on every iteration, so a
    // variable the body assigns must not decide it with its entry value
    // (`let i = 0; while i < 10 do i += 1` is not an infinite loop).
    const folded = this.fold(cond);
    const headLabelId = this.emit({ op: "label", name: head, node }).id;
    if (!folded || parseFloat(folded.text) === 0) {
      this.compileCondition(cond, end, false);
      this.statements.clearLoads();
    }
    const bodyFrom = this.ids.nextInstId;
    this.withContext({ loop: { breakLabel: end, continueLabel: head } }).processBlockScoped(body);
    const bodyTo = this.ids.nextInstId - 1;
    const backJumpId = this.emit({ op: "jump", target: head, node }).id;
    this.emit({ op: "label", name: end, node });
    this.shared.loopRegions.push({ headLabelId, backJumpId, bodyFrom, bodyTo });

    // The body may run zero times
    this.finalizeDemoted(demoted, d => d.entryValue !== null && !d.entryMaybe);
  }

  private processRepeat(node: SyntaxNode): void {
    const cond = conditionOf(node);
    if (!cond) throw this.errors.error("Malformed repeat loop", node);

    const body = blockOf(node);
    const assigned = new Set<string>();
    collectAssignedNames(body, this.fnTable, assigned);
    const demoted = this.demoteVariables(assigned, node);

    const { head, until: untilLabel, end } = this.labels.newRepeat();

    const { headLabelId, bodyFrom } = this.lowerLoopBody(body, demoted, head, end, untilLabel, node);
    this.emit({ op: "label", name: untilLabel, node });
    // Loop back while the until-condition is FALSE
    const folded = this.fold(cond);
    const condFrom = this.ids.nextInstId;
    if (folded) {
      // Constant condition: always-false loops forever, always-true falls out
      if (parseFloat(folded.text) === 0) this.emit({ op: "jump", target: head, node });
    } else {
      this.compileCondition(cond, head, false);
    }
    this.statements.clearLoads();
    const bodyTo = this.ids.nextInstId - 1;
    // The back jump may not exist (constant-true condition); use the last
    // emitted branch/jump if there is one.
    const last = this.lastEmitted();
    const backJumpId = last && last.id >= condFrom ? last.id : -1;
    this.emit({ op: "label", name: end, node });
    if (backJumpId >= 0) {
      this.shared.loopRegions.push({ headLabelId, backJumpId, bodyFrom, bodyTo });
    }

    // The body always runs at least once
    this.finalizeDemoted(demoted, d =>
      (d.entryValue !== null && !d.entryMaybe) || (!d.state.maybe && d.state.value !== null));
  }

  // ---------------------------- functions -------------------------------

  /** Reject a call that would re-enter a function already being lowered. */
  private checkNotRecursive(fn: FnInfo, node: SyntaxNode): void {
    if (this.cx.active.has(fn.name)) {
      throw this.errors.error(`Recursive functions are not supported: ${fn.name}`, node);
    }
  }

  /** Inline a single-call-site function at its call site (textual inlining). */
  private inlineCall(fn: FnInfo, argNodes: SyntaxNode[], node: SyntaxNode, wantValue: boolean): Operand | null {
    this.checkNotRecursive(fn, node);

    // Parameters that the body reassigns must become real variables,
    // evaluated once up front (in the caller's frame); read-only parameters
    // stay lazy aliases carrying the caller's chain.
    const callerChain = this.chain;
    const reassigned = new Set<string>();
    collectAssignedNames(fn.body, this.fnTable, reassigned);
    const paramScope: Scope = new Map();
    fn.params.forEach((param, i) => {
      if (reassigned.has(param)) {
        const value = this.compileExpression(argNodes[i]);
        paramScope.set(param, { kind: "var", state: { value, maybe: false, home: null } });
      } else {
        paramScope.set(param, { kind: "alias", argNode: argNodes[i], callerChain });
      }
    });

    // The inlined body emits into this frame's buffer but resolves names in
    // its own function frame. The caller's loop stays visible: textual
    // inlining places the body physically inside it, macro-style.
    const inlined = this.withContext({
      chain: this.chain.functionFrame(paramScope),
      active: including(this.cx.active, fn.name),
    });

    const last = fn.body[fn.body.length - 1];
    if (last?.type === "Return" && countReturns(fn.body) === 1) {
      // Single trailing return: the result is just an operand
      for (const statement of fn.body.slice(0, -1)) inlined.processStatement(statement);
      const expr = kids(last).find(c => EXPRESSION_TYPES.has(c.type));
      if (!expr) throw this.errors.error("return needs a value", last);
      return wantValue ? inlined.compileExpression(expr) : null;
    }

    const home = this.ids.newVreg();
    const endLabel = this.labels.newInlineEnd();
    const withReturn = inlined.withContext({ returnTarget: { home, endLabel } });
    for (const statement of fn.body) withReturn.processStatement(statement);
    this.emit({ op: "label", name: endLabel, node });
    return wantValue ? { kind: "vreg", id: home } : null;
  }

  /** Lower a function body into its own buffer for jal-style calls. */
  private lowerFunction(fn: FnInfo, node: SyntaxNode): void {
    this.checkNotRecursive(fn, node);

    const buffer: Inst[] = [];
    fn.paramVregs = fn.params.map(() => this.ids.newVreg());
    fn.retVreg = this.ids.newVreg();
    const paramScope: Scope = new Map();
    fn.params.forEach((param, i) => {
      paramScope.set(param, {
        kind: "var",
        state: { value: { kind: "vreg", id: fn.paramVregs![i] }, maybe: false, home: null },
      });
    });

    // The body is one new frame: its own buffer, its own function scope,
    // its own return target, a fresh statement cache — and NO enclosing
    // loop, because a jal body must not jump to a loop label chosen at
    // whichever call site happened to trigger lowering (fix 7).
    const body = this.withContext({
      buffer,
      chain: this.chain.functionFrame(paramScope),
      statements: this.statements.forNestedBody(),
      returnTarget: { home: fn.retVreg, endLabel: this.labels.functionEnd(fn.name) },
      loop: null,
      active: including(this.cx.active, fn.name),
    });
    body.emitFunctionBody(fn);
    fn.lowered = buffer;
  }

  /** The body of a jal-lowered function, run in the body's own frame. */
  private emitFunctionBody(fn: FnInfo): void {
    // Inside the body a global's value may come from any call site: it
    // lives in its home register and compile-time constants are forgotten.
    // (This save/restore is of variable KNOWLEDGE, like demotion — the
    // algorithm modeling the program — not of compiler context.)
    const globalViews: { state: VarState; value: Operand | null; maybe: boolean }[] = [];
    for (const name of fnVarRefs(fn, this.fnTable).refs) {
      const symbol = this.chain.globalGet(name);
      if (symbol?.kind !== "var") continue;
      const state = symbol.state;
      const home = state.home;
      if (home === null) continue;
      globalViews.push({ state, value: state.value, maybe: state.maybe });
      state.maybe = state.maybe || state.value === null;
      state.value = { kind: "vreg", id: home };
    }

    const entryLabel = this.emit({ op: "label", name: fn.name, node: fn.node });
    for (const statement of fn.body) this.processStatement(statement);
    this.emit({ op: "label", name: this.labels.functionEnd(fn.name), node: fn.node });

    for (const view of globalViews) {
      view.state.value = view.value;
      view.state.maybe = view.maybe;
    }

    // Non-leaf functions must save the return address around their calls
    if (this.buffer.some(inst => inst.op === "jal")) {
      const entryIndex = this.buffer.indexOf(entryLabel);
      this.buffer.splice(entryIndex + 1, 0, this.createInst({
        op: "call", opcode: "push", dest: null, args: [symOp("ra")], node: fn.node,
      }));
      this.emit({ op: "call", opcode: "pop", dest: null, args: [symOp("ra")], node: fn.node });
    }
    this.emit({ op: "ret", fn: fn.name, node: fn.node });
  }

  // ---------------------------- statements ------------------------------

  processStatement(statement: SyntaxNode): void {
    const parts = kids(statement);

    switch (statement.type) {
      case "Declaration":
        this.processDeclaration(statement, parts);
        break;
      case "Assignment":
        this.processAssignment(statement, parts);
        break;
      case "DeviceDeclaration": {
        const nameNode = parts.find(c => c.type === "VariableName");
        const deviceNode = parts.find(c => c.type === "Device");
        if (!nameNode || !deviceNode) throw this.errors.error("Malformed device declaration", statement);
        if (this.chain.lookup(nameNode.text) || this.fnTable.has(nameNode.text)) {
          throw this.errors.error(`${nameNode.text} was already defined`, nameNode);
        }
        this.chain.declare(nameNode.text, { kind: "device", pin: deviceNode.text });
        this.emit({ op: "alias", name: nameNode.text, device: deviceNode.text, node: statement });
        break;
      }
      case "Definition":
        this.processDefinition(statement, parts);
        break;
      case "FunctionCall":
        this.compileCall(statement, false);
        break;
      case "IfExpr":
        this.processIf(statement);
        break;
      case "LoopExpr":
        this.processLoop(statement);
        break;
      case "WhileExpr":
        this.processWhile(statement);
        break;
      case "RepeatUntilExpr":
        this.processRepeat(statement);
        break;
      case "break": {
        if (!this.cx.loop) throw this.errors.error("break outside of a loop", statement);
        this.emit({ op: "jump", target: this.cx.loop.breakLabel, node: statement });
        break;
      }
      case "continue": {
        if (!this.cx.loop) throw this.errors.error("continue outside of a loop", statement);
        this.emit({ op: "jump", target: this.cx.loop.continueLabel, node: statement });
        break;
      }
      case "Instruction": {
        // yield, or sleep with one operand
        const expression = parts.find(c => EXPRESSION_TYPES.has(c.type));
        if (statement.text.startsWith("sleep")) {
          if (!expression) throw this.errors.error("sleep needs a duration", statement);
          const value = this.compileExpression(expression);
          this.emit({ op: "call", opcode: "sleep", dest: null, args: [value], node: statement });
        } else {
          this.emit({ op: "call", opcode: "yield", dest: null, args: [], node: statement });
        }
        break;
      }
      case "FunctionDef": {
        if (!this.shared.registeredFnNodes.has(statement)) {
          throw this.errors.error("Functions must be defined at the top level", statement);
        }
        break; // registered up front; lowered lazily when called
      }
      case "PreprocessorDirective": {
        if (this.chain.depth > 1) {
          throw this.errors.error("Directives must appear at the top level", statement);
        }
        break; // handled during function registration
      }
      case "Return": {
        const target = this.cx.returnTarget;
        if (!target) throw this.errors.error("return outside of a function", statement);
        const expression = parts.find(c => EXPRESSION_TYPES.has(c.type));
        if (!expression) throw this.errors.error("return needs a value", statement);
        const value = this.compileExpression(expression);
        this.writeThrough(target.home, value, statement);
        this.emit({ op: "jump", target: target.endLabel, node: statement });
        break;
      }
      case "Comment":
        break;
      default:
        throw this.errors.error(`Unexpected statement: ${statement.type}`, statement);
    }
    this.statements.beginStatement(this.ids.nextVregId);
  }

  private processDeclaration(statement: SyntaxNode, parts: SyntaxNode[]): void {
    const nameNode = parts.find(c => c.type === "VariableName");
    if (!nameNode) throw this.errors.error("Malformed declaration", statement);
    if (this.chain.lookup(nameNode.text) || this.fnTable.has(nameNode.text)) {
      throw this.errors.error(`${nameNode.text} was already defined`, nameNode);
    }
    const assignIdx = parts.findIndex(c => c.type === "Assign");
    const initializer = assignIdx >= 0 ? parts[assignIdx + 1] : undefined;
    // The initializer is evaluated before the name is bound, so a
    // same-named reference is still an IC10 passthrough.
    const value = initializer ? this.compileExpression(initializer) : null;
    const state: VarState = { value, maybe: false, home: null };
    // Globals used inside jal-called functions live in a permanent
    // home register from the start; writes go through it from here on.
    if (this.chain.depth === 1 && this.shared.fnGlobalNames.has(nameNode.text)) {
      state.home = this.ids.newVreg();
      if (value) this.emit({ op: "movev", dest: state.home, src: value, node: statement });
    }
    this.chain.declare(nameNode.text, { kind: "var", state });
  }

  private processAssignment(statement: SyntaxNode, parts: SyntaxNode[]): void {
    const target = parts[0];
    const opNode = parts.find(c => c.type === "Assign" || c.type === "CompoundAssignOp");
    const opIdx = opNode ? parts.indexOf(opNode) : -1;
    const expression = opIdx >= 0 ? parts[opIdx + 1] : undefined;
    if (!target || !opNode || !expression) throw this.errors.error("Malformed assignment", statement);

    // `x += e` reads as `x = x + e`. Synthesizing a BinaryOp node and
    // handing it to the ordinary expression compiler reuses its folding,
    // algebraic identities (`+= 0` is free), and register-pressure
    // evaluation order instead of duplicating that logic here.
    const compoundOp = opNode.type === "CompoundAssignOp" ? opNode.text[0] : null;
    const value = compoundOp
      ? this.compileExpression({
          type: "BinaryOp",
          text: statement.text,
          from: statement.from,
          to: statement.to,
          children: [
            target,
            { type: OP_TYPES[compoundOp], text: compoundOp, from: opNode.from, to: opNode.to, children: [] },
            expression,
          ],
        })
      : this.compileExpression(expression);

    if (target.type === "VariableName") {
      const symbol = this.chain.lookup(target.text);
      if (symbol && symbol.kind !== "var") {
        throw this.errors.error(`Cannot assign to ${target.text}`, target);
      }
      if (symbol) {
        this.assignVariable(symbol.state, value, statement);
      } else {
        // Placeholder write: must leave the registers through a move
        this.emit({ op: "storename", name: target.text, src: value, node: statement });
      }
      return;
    }

    // Device and device-group writes
    const { base, prop, index } = this.propertyParts(target);
    const resolved = this.resolveBase(base);
    if (resolved.kind === "unknown") {
      throw this.errors.error(`Unknown device or define ${resolved.name}`, base);
    }
    if (target.type === "DeviceProperty") {
      const opcode = resolved.kind === "device" ? "s" : "sb";
      this.emit({
        op: "call", opcode, dest: null,
        args: [symOp(resolved.text), symOp(prop.text), value],
        node: statement,
      });
    } else if (resolved.kind === "device") {
      this.emit({
        op: "call", opcode: "ss", dest: null,
        args: [symOp(resolved.text), this.slotIndexOperand(index!), symOp(prop.text), value],
        node: statement,
      });
    } else {
      if (target.type === "DeviceChannelProperty") {
        throw this.errors.error("Device groups are selected by name, not slot", target);
      }
      this.emit({
        op: "call", opcode: "sbn", dest: null,
        args: [symOp(resolved.text), this.nameHashOperand(index!), symOp(prop.text), value],
        node: statement,
      });
    }
  }

  private processDefinition(statement: SyntaxNode, parts: SyntaxNode[]): void {
    const nameNode = parts.find(c => c.type === "VariableName");
    const assignIdx = parts.findIndex(c => c.type === "Assign");
    const valueNode = assignIdx >= 0 ? parts[assignIdx + 1] : undefined;
    if (!nameNode || !valueNode) throw this.errors.error("Malformed definition", statement);
    if (this.chain.lookup(nameNode.text) || this.fnTable.has(nameNode.text)) {
      throw this.errors.error(`${nameNode.text} was already defined`, nameNode);
    }
    const name = nameNode.text;
    const folded = this.fold(valueNode);
    if (folded) {
      // Numbers keep their name in the output via an IC10 define line
      this.chain.declare(name, { kind: "define", text: name, needsLine: true });
      this.emit({ op: "definedef", name, value: folded.text, node: statement });
      return;
    }
    if (valueNode.type === "String") {
      this.chain.declare(name, { kind: "define", text: name, needsLine: true });
      this.emit({ op: "definedef", name, value: `HASH(${valueNode.text})`, node: statement });
      return;
    }
    if (valueNode.type === "VariableName") {
      const referenced = this.chain.lookup(valueNode.text);
      if (referenced?.kind === "define") {
        this.chain.declare(name, { kind: "define", text: referenced.text, needsLine: false });
        return;
      }
      if (!referenced) {
        // Bare identifier: substituted verbatim, no define line
        this.chain.declare(name, { kind: "define", text: valueNode.text, needsLine: false });
        return;
      }
      throw this.errors.error("define values must be constant", valueNode);
    }
    if (valueNode.type === "DeviceProperty") {
      // Game constants like LogicType.Temperature substitute verbatim
      const { base, prop } = this.propertyParts(valueNode);
      if (base.type === "Device" || this.chain.lookup(base.text)) {
        throw this.errors.error("define values must be constant", valueNode);
      }
      this.chain.declare(name, { kind: "define", text: `${base.text}.${prop.text}`, needsLine: false });
      return;
    }
    throw this.errors.error("define values must be constant", valueNode);
  }
}
