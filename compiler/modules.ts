/**
 * Modules: what one saved script offers the programs that `import` from it.
 *
 * A module is another chip's program, so nothing here compiles one. The scan
 * walks a module's top-level statements and works out, for each name it
 * offers, what an importer would have to do to use it: substitute a value,
 * address a cell on that chip, or take a copy of a function body.
 *
 * The addresses are *recomputed* rather than read out of a compile, so this
 * walk allocates cells exactly as the declarations themselves do - same order,
 * same arithmetic, via `allocateCells`. That is only predictable while every
 * declaration is top level: a list inside a function body is allocated once per
 * lowering of that body, which depends on where the module calls it, so a
 * module with one is rejected instead of guessed at.
 *
 * Three things a module offers travel differently:
 *
 * - A `const` is a compile-time value. It costs nothing, needs no device, and
 *   is the only thing that can cross into an imported function body.
 * - Stack memory - a `stack` variable or a list - is an address on the chip
 *   running the module, so an importer must say which pin it sees that chip on.
 * - A `fn` is source: the importer registers its own copy of the body, and of
 *   every module function that body calls. `checkImportedFunction` is what
 *   makes that safe, since a body that mentions anything but constants,
 *   parameters and its own variables would mean something different on the
 *   chip it is copied to.
 *
 * A module's own imports ARE re-exported, so a name can travel through a chain
 * of modules. What does not travel is the pin: the address (or function body)
 * belongs to the chip that first declared it, and every importer names that
 * chip itself with its own `using`.
 */

import { getAST } from "./ast.ts";
import {
  childrenOf, getFormalAST,
  type ArrayDeclaration as ListDeclaration, type Block, type Device, type DevicePin,
  type FormalSyntaxNode, type FunctionCall, type FunctionDef, type Identifier, type Import,
  type Range, type StringExpr,
} from "./formal-ast.ts";
import { foldExpression, type ConstantLookup } from "./folding.ts";
import type { ConstOperand } from "./ir.ts";
import { CompileError, ErrorReporter } from "./syntax.ts";
import { SELF_DEVICE, STACK_TOP } from "./tables.ts";

/** How the compiler reads another module's source; missing files return nothing. */
export type FileHandler = (path: string) => string | null | undefined;

/** What a module offers the programs that import from it. */
export type ModuleExport =
  // A `const`: a compile-time value, so the import is one too and costs nothing
  | { kind: "const"; value: ConstOperand }
  // A `stack` declaration: one cell of the module's chip's stack memory
  | { kind: "stackvar"; addr: number }
  // A list: `size` cells of it, starting at `start`
  | { kind: "list"; start: number; size: number }
  // A function: the body itself, plus the module that defines it - which is
  // not necessarily the module it was imported from, since a re-export hands
  // on the original
  | { kind: "fn"; owner: ModuleScan; def: FunctionDef };

/** One scanned module: its interface, plus what an imported body may name. */
export type ModuleScan = {
  readonly path: string;
  /** Everything importable from here, including names it re-exports. */
  readonly exports: Map<string, ModuleExport>;
  /** Every top-level `const` that folded. */
  readonly constants: Map<string, ConstOperand>;
  /**
   * Every top-level name that is neither a constant nor stack memory: `let`,
   * `define`, `device`, a `const` of a runtime value, and the module's
   * functions. An imported body naming one of these is rejected - each would
   * mean something different, or nothing at all, on the chip it is copied to.
   */
  readonly blocked: Set<string>;
  /** Diagnostics about this module's own text, so they carry its line numbers. */
  readonly errors: ErrorReporter;
};

/**
 * Take `size` cells from the top of the free stack space below `top`, and
 * report the new top. The cells run *upwards* from the address returned, so a
 * list's first element sits lowest and the space below stays free for the next
 * declaration and, after those, for spilled values.
 *
 * Both the frame that declares stack memory and the scan that works out where
 * an imported module put its own call this, because the two must agree cell
 * for cell: an importer computes addresses it never sees reserved.
 */
export function allocateCells(top: number, size: number): { start: number; top: number } {
  return { start: top - size + 1, top: top - size };
}

/**
 * The element count of a list declaration. A `define` is deliberately not
 * usable here (`fold` resolves names through `lookupVar`, which skips defines):
 * the player can retune a define in the chip, and a list whose size had been
 * baked into addresses would not survive that.
 */
export function listSize(
  statement: ListDeclaration,
  constantOf: ConstantLookup,
  errors: ErrorReporter,
): number {
  const sizeOp = foldExpression(statement.size, constantOf);
  if (!sizeOp) throw errors.error("List size must be constant", statement.size);
  const size = parseFloat(sizeOp.text);
  if (!Number.isInteger(size)) throw errors.error("List size must be an integer", statement.size);
  return size;
}

/**
 * The module an `import ... from "x"` names. A StringExpr carries the raw
 * spelling, quotes included - that is what `HASH("...")` wants of every other
 * string - so the quotes come off here. Escapes are left alone: the grammar
 * does not decode them and a module path has no use for one.
 */
export function modulePath(node: StringExpr): string {
  const text = node.value;
  return text.length >= 2 && text.startsWith('"') && text.endsWith('"')
    ? text.slice(1, -1)
    : text;
}

/**
 * Run `body`, re-raising any diagnostic it produced about `scan`'s own text as
 * one about `at`. The inner message keeps the module's line number and the
 * outer one points at the line an editor can actually take the reader to;
 * nested modules simply nest the prefix.
 */
export function inModule<T>(
  scan: ModuleScan,
  at: Range,
  errors: ErrorReporter,
  body: () => T,
): T {
  try {
    return body();
  } catch (e) {
    if (!(e instanceof CompileError)) throw e;
    throw errors.error(`In module ${JSON.stringify(scan.path)}: ${e.message}`, at);
  }
}

/**
 * A structural copy of an AST subtree. Every node is a plain object of
 * primitives, arrays and other nodes, so this is the whole of it.
 *
 * An imported function gets a copy of its body because registering it rewrites
 * the names of the module functions it calls, and the same body may be pulled
 * into one program more than once - through two pins, or through two modules
 * that re-export it - each time needing its own set of those names.
 */
function cloneNode<T>(node: T): T {
  if (Array.isArray(node)) return node.map(cloneNode) as T;
  if (node !== null && typeof node === "object") {
    const copy: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node)) copy[key] = cloneNode(value);
    return copy as T;
  }
  return node;
}

/** One module function an imported body calls, and the call nodes naming it. */
export type ImportedCallee = {
  owner: ModuleScan;
  def: FunctionDef;
  /** The `functioncall` nodes in the copied body, for renaming. */
  calls: FunctionCall[];
};

/**
 * Reject an imported function body that would mean something different on the
 * chip it is copied to, and report the module functions it calls.
 *
 * The body is about to be compiled inside another program, where none of the
 * module's own names exist. Three rules make that safe, and all three are
 * checked here rather than while lowering, because a diagnostic raised then
 * would carry the module's source offsets into the importer's line numbering:
 *
 * - A module `const` and the module's stack memory cross the boundary; nothing
 *   else does. A `let` lives in the module's registers, and a bare identifier
 *   is a placeholder - a name in whichever program is being compiled. Either
 *   would silently read something else here.
 * - `db` is the only device a body may name. Every other pin is wired to
 *   whatever the *importing* chip has on it, which is a different device.
 * - `db` itself means "the chip this code runs on", which for a copied body is
 *   the chip it came from - so the import must say which pin that is, and
 *   `using` supplies it. A cell of the module's stack memory needs the pin on
 *   the same terms and for the same reason: it is an address on that chip, so
 *   reaching one is reaching the chip.
 *
 * A call to anything the module does not define is left alone: it is a raw
 * IC10 opcode or an aggregator, which mean the same thing everywhere.
 */
export function checkImportedFunction(
  def: FunctionDef,
  owner: ModuleScan,
  pin: DevicePin | null,
): Map<string, ImportedCallee> {
  const errors = owner.errors;
  const declared = declaredNames(def);
  const callees = new Map<string, ImportedCallee>();

  const checkDevice = (node: Device): void => {
    if (node.name !== SELF_DEVICE) {
      throw errors.error(
        `${node.name} is a pin of this chip, which an imported function cannot reach; ` +
        "only db, the chip it is imported from", node);
    }
    if (!pin) {
      throw errors.error(
        "db is the chip this module runs on; import this function `using d0` " +
        "to say which device that is", node);
    }
  };

  /**
   * A name read as a value: a parameter, a local, a module constant, or a
   * cell of the module's stack memory - which the copied body reaches on the
   * import's pin, exactly as it reaches `db`.
   */
  const checkName = (id: Identifier, symbolOk: boolean): void => {
    const name = id.name;
    if (declared.has(name) || owner.constants.has(name)) return;
    const exported = owner.exports.get(name);
    if (exported && (exported.kind === "stackvar" || exported.kind === "list")) {
      if (pin) return;
      throw errors.error(
        `${name} lives in this module's stack memory; import this function \`using d0\` ` +
        "to say which device that is", id);
    }
    if (symbolOk && !owner.blocked.has(name)) return;
    throw errors.error(
      `${name} is not a constant of this module; an imported function can use only its ` +
      "parameters, its own variables, the module's constants and its stack memory", id);
  };

  /** The base of a property access: a device, a device alias, or a namespace. */
  const visitBase = (base: Device | Identifier): void => {
    if (base.type === "device") return checkDevice(base);
    // An unknown base is a game constant like `DisplayMode.Seconds`, which
    // means the same thing in any program; a module's own name does not, and
    // none of the kinds it could be is a device to read a property off.
    if (!declared.has(base.name) && (owner.blocked.has(base.name) || owner.exports.has(base.name))) {
      throw errors.error(
        `${base.name} is a name of this module, which an imported function cannot reach`, base);
    }
  };

  /** Whether the call names a module function (so its name needs rewriting). */
  const resolveCallee = (node: FunctionCall): boolean => {
    const exported = owner.exports.get(node.name.name);
    if (exported?.kind !== "fn") return false;
    let callee = callees.get(node.name.name);
    if (!callee) {
      callee = { owner: exported.owner, def: exported.def, calls: [] };
      callees.set(node.name.name, callee);
    }
    callee.calls.push(node);
    return true;
  };

  const visit = (node: FormalSyntaxNode): void => {
    switch (node.type) {
      case "identifier":
        return checkName(node, false);
      case "device":
        return checkDevice(node);
      case "deviceprop":
      case "devicechannelprop":
        // The property, and a channel index, are not names of anything here.
        return visitBase(node.device);
      case "devicenameprop":
        visitBase(node.device);
        // The name filter is hashed, not read - an identifier is its spelling.
        if (node.name.type === "identifier") checkName(node.name, true);
        return;
      case "functioncall": {
        // A raw opcode takes its identifier arguments verbatim (logic types,
        // devices, defines), so those are spellings rather than reads.
        const rawOpcode = !resolveCallee(node);
        for (const param of node.params) {
          if (rawOpcode && param.type === "identifier") checkName(param, true);
          else visit(param);
        }
        return;
      }
      default:
        for (const child of childrenOf(node)) visit(child);
    }
  };

  visit(def.body);
  return callees;
}

/**
 * Every name the body binds for itself. Flat and over-approximate on purpose:
 * it exists only to tell a name the body owns from one it inherits, and a name
 * declared in any block of the body is one it owns.
 */
function declaredNames(def: FunctionDef): Set<string> {
  const names = new Set<string>(def.args.map(arg => arg.name));
  const walk = (node: FormalSyntaxNode): void => {
    switch (node.type) {
      case "declaration": names.add(node.target.name); break;
      case "arraydeclaration":
      case "stackdeclaration":
      case "devicedef":
      case "definedef": names.add(node.name.name); break;
      case "import": for (const n of node.names) names.add(n.name); break;
      case "functiondef": for (const arg of node.args) names.add(arg.name); break;
      default: break;
    }
    for (const child of childrenOf(node)) walk(child);
  };
  walk(def.body);
  return names;
}

/**
 * Reads and scans the modules one compilation imports from. One instance per
 * compile: a module is read once however many names come from it, and the
 * `scanning` set is what turns a cycle of re-exports into a diagnostic rather
 * than a stack overflow.
 */
export class ModuleScanner {
  private readonly fileHandler: FileHandler;
  private readonly cache = new Map<string, ModuleScan>();
  private readonly scanning = new Set<string>();

  constructor(fileHandler: FileHandler) {
    this.fileHandler = fileHandler;
  }

  /**
   * The interface of the module `statement` names. `errors` reports against
   * whichever source that statement came from - the importing program, or an
   * outer module when this is a re-export.
   */
  scan(statement: Import, errors: ErrorReporter): ModuleScan {
    const path = modulePath(statement.path);
    const cached = this.cache.get(path);
    if (cached) return cached;
    if (this.scanning.has(path)) {
      throw errors.error(`Circular import of module ${JSON.stringify(path)}`, statement);
    }

    const source = this.fileHandler(path);
    if (typeof source !== "string") {
      throw errors.error(`Cannot find module ${JSON.stringify(path)}`, statement.path);
    }

    const scan: ModuleScan = {
      path,
      exports: new Map(),
      constants: new Map(),
      blocked: new Set(),
      errors: new ErrorReporter(source),
    };
    this.scanning.add(path);
    try {
      this.fill(scan, getFormalAST(getAST(source)));
    } catch (e) {
      if (!(e instanceof CompileError)) throw e;
      throw errors.error(`In module ${JSON.stringify(path)}: ${e.message}`, statement);
    } finally {
      this.scanning.delete(path);
    }
    this.cache.set(path, scan);
    return scan;
  }

  /**
   * Walk a module's top-level statements into its interface. Statement order
   * is the point: cells are allocated in it, and a `const` or a list size may
   * name any constant declared - or imported - above it.
   */
  private fill(scan: ModuleScan, module: Block): void {
    const errors = scan.errors;
    const constantOf: ConstantLookup = name => scan.constants.get(name) ?? null;
    let top = STACK_TOP;

    for (const statement of module.statements) {
      // Only the statement's *children* are searched: the statement itself
      // being a declaration is the case this whole function is about.
      for (const child of childrenOf(statement)) {
        const nested = nestedDeclaration(child);
        if (nested) {
          throw errors.error(
            "stack memory declared outside the top level cannot be imported", nested);
        }
      }

      switch (statement.type) {
        case "declaration": {
          const name = statement.target.name;
          const value = statement.constant && statement.value
            ? foldExpression(statement.value, constantOf)
            : null;
          // A `let`, or a `const` of a runtime value: named, but not offered.
          if (!value) {
            scan.blocked.add(name);
            break;
          }
          scan.constants.set(name, value);
          scan.exports.set(name, { kind: "const", value });
          break;
        }
        case "stackdeclaration": {
          const cell = allocateCells(top, 1);
          top = cell.top;
          scan.exports.set(statement.name.name, { kind: "stackvar", addr: cell.start });
          break;
        }
        case "arraydeclaration": {
          const size = listSize(statement, constantOf, errors);
          const cells = allocateCells(top, size);
          top = cells.top;
          scan.exports.set(statement.name.name, { kind: "list", start: cells.start, size });
          break;
        }
        case "functiondef": {
          scan.blocked.add(statement.name.name);
          scan.exports.set(statement.name.name, { kind: "fn", owner: scan, def: statement });
          break;
        }
        case "definedef":
        case "devicedef": {
          scan.blocked.add(statement.name.name);
          break;
        }
        case "import": {
          const inner = this.scan(statement, errors);
          for (const ident of statement.names) {
            const name = ident.name;
            // A name this module cannot offer either is still a name it binds.
            const exported = inner.exports.get(name);
            if (!exported) {
              scan.blocked.add(name);
              continue;
            }
            scan.exports.set(name, exported);
            if (exported.kind === "const") scan.constants.set(name, exported.value);
            else if (exported.kind === "fn") scan.blocked.add(name);
          }
          break;
        }
        default:
          break;
      }
    }
  }
}

/** The first `stack` or list declaration anywhere in a subtree, if any. */
function nestedDeclaration(node: FormalSyntaxNode): FormalSyntaxNode | null {
  if (node.type === "stackdeclaration" || node.type === "arraydeclaration") return node;
  for (const child of childrenOf(node)) {
    const found = nestedDeclaration(child);
    if (found) return found;
  }
  return null;
}

/** A copy of an imported function's body, private to one registration of it. */
export function copyFunction(def: FunctionDef): FunctionDef {
  return cloneNode(def);
}
