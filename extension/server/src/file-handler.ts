import * as fs from "fs";
import * as nodePath from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { TextDocument } from "vscode-languageserver-textdocument";
import type { FileHandler } from "ic10-compiler/compiler/index.ts";

// The compiler asks for a module by the (quote-stripped) string after `from`,
// e.g. `import Foo from "lib/util"` calls back with "lib/util". In the web
// editor that names a saved script; here it names a file on disk, resolved
// relative to the importing document and allowed to omit the `.icc` extension.
// Open editor buffers win over disk, so features reflect unsaved edits in
// imported files.

/** A resolved module: where it lives and its current text. */
export type ResolvedModule = { uri: string; text: string };

/** fs path for a file: URI, lowercased on Windows so lookups are case-stable. */
function fsPathKey(path: string): string {
  return process.platform === "win32" ? path.toLowerCase() : path;
}

function fsPathOf(uri: string): string | undefined {
  try {
    return fsPathKey(fileURLToPath(uri));
  } catch {
    return undefined; // non-file scheme (untitled, etc.)
  }
}

/** Index the open documents by fs-path key, keeping both text and canonical uri. */
function indexOpen(openDocuments: TextDocument[]): Map<string, ResolvedModule> {
  const byPath = new Map<string, ResolvedModule>();
  for (const doc of openDocuments) {
    const key = fsPathOf(doc.uri);
    if (key !== undefined) byPath.set(key, { uri: doc.uri, text: doc.getText() });
  }
  return byPath;
}

function baseDirOf(sourceUri: string): string | undefined {
  try {
    return nodePath.dirname(fileURLToPath(sourceUri));
  } catch {
    return undefined;
  }
}

/**
 * Resolve an import path (relative to `baseDir`) to a module, preferring open
 * buffers over disk and trying both the exact name and a `.icc` suffix.
 */
function resolve(
  baseDir: string,
  importPath: string,
  open: Map<string, ResolvedModule>,
): ResolvedModule | undefined {
  const resolvedBase = nodePath.isAbsolute(importPath)
    ? importPath
    : nodePath.resolve(baseDir, importPath);

  for (const candidate of [resolvedBase, resolvedBase + ".icc"]) {
    const fromOpen = open.get(fsPathKey(candidate));
    if (fromOpen) return fromOpen;
    try {
      return { uri: pathToFileURL(candidate).toString(), text: fs.readFileSync(candidate, "utf8") };
    } catch {
      // Not this candidate; fall through to the next.
    }
  }
  return undefined;
}

/**
 * Build the compiler's `FileHandler` for a compilation rooted at `sourceUri`.
 * Returns undefined for a module it can't find, which the compiler turns into a
 * "Cannot find module" diagnostic.
 */
export function makeFileHandler(sourceUri: string, openDocuments: TextDocument[]): FileHandler {
  const baseDir = baseDirOf(sourceUri);
  const open = indexOpen(openDocuments);
  return (importPath: string): string | undefined => {
    if (baseDir === undefined) return undefined;
    return resolve(baseDir, importPath, open)?.text;
  };
}

/**
 * Resolve an import path to a module's uri and text -- the extra the file
 * handler doesn't return, needed to point go-to-definition into another file.
 */
export function resolveModule(
  sourceUri: string,
  importPath: string,
  openDocuments: TextDocument[],
): ResolvedModule | undefined {
  const baseDir = baseDirOf(sourceUri);
  if (baseDir === undefined) return undefined;
  return resolve(baseDir, importPath, indexOpen(openDocuments));
}
