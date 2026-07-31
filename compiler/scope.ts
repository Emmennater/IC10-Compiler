/**
 * Lexical scope analysis for editor features (completion, scope-aware
 * highlighting). This is a *separate, lighter* pass than lowering: it does not
 * build IR, it only answers "what names are in scope here" and "what does this
 * identifier occurrence refer to". Both editors (the VS Code language server
 * and CodeMirror) can consume it, so name resolution stays in one place.
 *
 * Scoping mirrors what the lowerer's ScopeChain does (symbols.ts): blocks nest,
 * a function body hides the caller's non-global locals, and globals are visible
 * everywhere. Visibility here is position-insensitive within a scope (a name is
 * visible in the whole scope it is declared in, not only after its line) -- that
 * suits "declared vs not" highlighting and forward references like recursion or
 * a function called above its definition.
 */

import type { SyntaxNode } from "./ast.ts";
import { getFormalAST } from "./formal-ast.ts";
import type {
  Block,
  Statement,
  Expression,
  AssignTarget,
  Identifier,
  Range,
} from "./formal-ast.ts";

/** What a name refers to. */
export type SymbolKind =
  | "var"
  | "const"
  | "define"
  | "device"
  | "function"
  | "param"
  | "list"
  | "stackvar"
  | "import";

export type SymbolInfo = { name: string; kind: SymbolKind };

/** How scope-aware highlighting should treat an identifier occurrence. */
export type HighlightHint = "readonly" | "undeclared";

export type ScopeAnalysis = {
  /** The hint for the identifier that starts at `from`, if any. */
  hintAt(from: number): HighlightHint | undefined;
  /** The names visible at a source offset, innermost shadowing outermost. */
  symbolsAt(offset: number): SymbolInfo[];
};

type ScopeNode = {
  range: Range;
  parent: ScopeNode | null;
  /** True for a function body: caller locals above it are hidden. */
  functionBoundary: boolean;
  symbols: Map<string, SymbolKind>;
  children: ScopeNode[];
};

type Reference = { name: string; from: number; scope: ScopeNode };

/** `const`/`define` are the read-only bindings the highlighter tints. */
function isReadonlyKind(kind: SymbolKind): boolean {
  return kind === "const" || kind === "define";
}

/**
 * Analyze the program's scopes. Throws whatever `getFormalAST` throws on a
 * syntax error, so callers doing best-effort work on half-typed source should
 * catch and fall back.
 */
export function analyzeScopes(ast: SyntaxNode): ScopeAnalysis {
  const module = getFormalAST(ast);

  const root: ScopeNode = {
    range: { from: ast.from, to: ast.to },
    parent: null,
    functionBoundary: false,
    symbols: new Map(),
    children: [],
  };
  const references: Reference[] = [];
  const hints = new Map<number, HighlightHint>();

  function childScope(parent: ScopeNode, range: Range, functionBoundary = false): ScopeNode {
    const scope: ScopeNode = { range, parent, functionBoundary, symbols: new Map(), children: [] };
    parent.children.push(scope);
    return scope;
  }

  function bind(scope: ScopeNode, ident: Identifier, kind: SymbolKind): void {
    scope.symbols.set(ident.name, kind);
    // A declaration site is highlighted by its own kind; readonly ones get the
    // same tint as their uses.
    if (isReadonlyKind(kind)) hints.set(ident.from, "readonly");
  }

  function reference(ident: Identifier, scope: ScopeNode): void {
    references.push({ name: ident.name, from: ident.from, scope });
  }

  function walkBlock(block: Block, scope: ScopeNode): void {
    for (const statement of block.statements) walkStatement(statement, scope);
  }

  function walkStatement(statement: Statement, scope: ScopeNode): void {
    switch (statement.type) {
      case "declaration":
        bind(scope, statement.target, statement.constant ? "const" : "var");
        if (statement.value) walkExpr(statement.value, scope);
        break;
      case "assignment":
        walkTarget(statement.target, scope);
        walkExpr(statement.value, scope);
        break;
      case "compoundassignop":
        walkTarget(statement.target, scope);
        walkExpr(statement.right, scope);
        break;
      case "if":
        for (const arm of statement.ifs) {
          walkExpr(arm.condition, scope);
          walkBlock(arm.then, childScope(scope, arm.then));
        }
        if (statement.else) walkBlock(statement.else, childScope(scope, statement.else));
        break;
      case "loop":
        walkBlock(statement.body, childScope(scope, statement.body));
        break;
      case "while":
        walkExpr(statement.condition, scope);
        walkBlock(statement.body, childScope(scope, statement.body));
        break;
      case "repeat": {
        // `until` runs after the body and can read what the body declared.
        const bodyScope = childScope(scope, statement.body);
        walkBlock(statement.body, bodyScope);
        walkExpr(statement.until, bodyScope);
        break;
      }
      case "for": {
        // The loop variable(s) live in a scope spanning the whole `for`.
        const forScope = childScope(scope, statement);
        if (statement.init) walkStatement(statement.init, forScope);
        if (statement.condition) walkExpr(statement.condition, forScope);
        if (statement.update) walkStatement(statement.update, forScope);
        walkBlock(statement.body, forScope);
        break;
      }
      case "forin":
      case "forof": {
        const forScope = childScope(scope, statement);
        walkStatement(statement.decl, forScope);
        reference(statement.list, scope);
        walkBlock(statement.body, forScope);
        break;
      }
      case "sleep":
        walkExpr(statement.duration, scope);
        break;
      case "return":
        walkExpr(statement.value, scope);
        break;
      case "definedef":
        bind(scope, statement.name, "define");
        walkExpr(statement.value, scope);
        break;
      case "devicedef":
        bind(scope, statement.name, "device");
        break;
      case "stackdeclaration":
        bind(scope, statement.name, "stackvar");
        if (statement.value) walkExpr(statement.value, scope);
        break;
      case "arraydeclaration":
        bind(scope, statement.name, "list");
        walkExpr(statement.size, scope);
        if (statement.list) for (const el of statement.list.elements) walkExpr(el, scope);
        break;
      case "functiondef": {
        bind(scope, statement.name, "function");
        const fnScope = childScope(scope, statement, true);
        for (const arg of statement.args) bind(fnScope, arg, "param");
        walkBlock(statement.body, fnScope);
        break;
      }
      case "functioncall":
        walkExpr(statement, scope);
        break;
      case "import":
        bind(scope, statement.name, "import");
        break;
      // No names, no sub-expressions.
      case "break":
      case "continue":
      case "yield":
      case "preprocessordir":
        break;
    }
  }

  function walkTarget(target: AssignTarget, scope: ScopeNode): void {
    // Every assignable form is also an expression form; walkExpr already
    // references the device/list identifier and skips the property name.
    walkExpr(target, scope);
  }

  function walkExpr(expr: Expression, scope: ScopeNode): void {
    switch (expr.type) {
      case "identifier":
        reference(expr, scope);
        break;
      case "deviceprop":
        if (expr.device.type === "identifier") reference(expr.device, scope);
        break;
      case "devicechannelprop":
        if (expr.device.type === "identifier") reference(expr.device, scope);
        break;
      case "devicenameprop":
        if (expr.device.type === "identifier") reference(expr.device, scope);
        if (expr.name.type === "identifier") reference(expr.name, scope);
        break;
      case "listindexing":
        reference(expr.list, scope);
        walkExpr(expr.index, scope);
        break;
      case "functioncall":
        reference(expr.name, scope);
        for (const param of expr.params) walkExpr(param, scope);
        break;
      case "binaryop":
      case "comparisonop":
      case "logicalop":
        walkExpr(expr.left, scope);
        walkExpr(expr.right, scope);
        break;
      case "unaryop":
        walkExpr(expr.value, scope);
        break;
      case "ternaryop":
        walkExpr(expr.condition, scope);
        walkExpr(expr.then, scope);
        walkExpr(expr.else, scope);
        break;
      // Literals and bare device pins reference no declared name.
      case "constant":
      case "bool":
      case "string":
      case "device":
        break;
    }
  }

  /** Resolve a name from `scope` outward, honouring the function boundary. */
  function resolve(name: string, scope: ScopeNode): SymbolKind | undefined {
    let crossedBoundary = false;
    for (let s: ScopeNode | null = scope; s; s = s.parent) {
      const isGlobal = s.parent === null;
      if (isGlobal) return s.symbols.get(name);
      if (!crossedBoundary) {
        const kind = s.symbols.get(name);
        if (kind !== undefined) return kind;
      }
      if (s.functionBoundary) crossedBoundary = true;
    }
    return undefined;
  }

  // Phase 1: collect every declaration and reference occurrence.
  walkBlock(module, root);

  // Phase 2: every declaration is in place, so references resolve against the
  // complete tree (this is what makes forward references and recursion work).
  for (const ref of references) {
    const kind = resolve(ref.name, ref.scope);
    if (kind === undefined) {
      hints.set(ref.from, "undeclared");
    } else if (isReadonlyKind(kind) && !hints.has(ref.from)) {
      hints.set(ref.from, "readonly");
    }
  }

  function innermostScopeAt(offset: number): ScopeNode {
    let scope = root;
    outer: for (;;) {
      for (const child of scope.children) {
        if (offset >= child.range.from && offset <= child.range.to) {
          scope = child;
          continue outer;
        }
      }
      return scope;
    }
  }

  return {
    hintAt: (from) => hints.get(from),
    symbolsAt: (offset) => {
      const seen = new Map<string, SymbolKind>();
      let crossedBoundary = false;
      for (let s: ScopeNode | null = innermostScopeAt(offset); s; s = s.parent) {
        const isGlobal = s.parent === null;
        if (!crossedBoundary || isGlobal) {
          for (const [name, kind] of s.symbols) if (!seen.has(name)) seen.set(name, kind);
        }
        if (s.functionBoundary) crossedBoundary = true;
      }
      return [...seen].map(([name, kind]) => ({ name, kind }));
    },
  };
}
