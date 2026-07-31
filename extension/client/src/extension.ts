import * as path from "path";
import {
  workspace,
  window,
  commands,
  Uri,
  EventEmitter,
  ViewColumn,
  ExtensionContext,
  TextDocumentContentProvider,
} from "vscode";

import {
  LanguageClient,
  LanguageClientOptions,
  ServerOptions,
  TransportKind,
} from "vscode-languageclient/node";

let client: LanguageClient;
// Resolves once the server is ready; the compile command awaits it so an
// early keypress doesn't race the server launch.
let clientReady: Promise<void>;

// Mirrors the web editor's limits (see IC10-Compiler/main.js) so the status
// bar reads the same budget the user is used to.
const LINE_LIMIT = 128;
const BYTE_LIMIT = 4096;

/** Read-only scheme backing the compiled-output pane. */
const OUTPUT_SCHEME = "icc-output";

type CompileResult =
  | { ok: true; ic10: string }
  | { ok: false; message: string };

/**
 * Backs the compiled-output documents. Content is keyed by the output Uri and
 * refreshed in place on each recompile, so re-running reuses the same pane
 * instead of piling up editors.
 */
class CompiledOutputProvider implements TextDocumentContentProvider {
  private readonly contents = new Map<string, string>();
  private readonly changed = new EventEmitter<Uri>();
  readonly onDidChange = this.changed.event;

  provideTextDocumentContent(uri: Uri): string {
    return this.contents.get(uri.toString()) ?? "";
  }

  set(uri: Uri, content: string): void {
    this.contents.set(uri.toString(), content);
    this.changed.fire(uri);
  }
}

/**
 * Stable output Uri for a source file: `icc-output:/<name>.ic10`, with the
 * source Uri in the query so different files never collide and re-compiling
 * the same file always targets the same pane.
 */
function outputUriFor(source: Uri): Uri {
  return Uri.from({
    scheme: OUTPUT_SCHEME,
    path: "/" + path.basename(source.path).replace(/\.icc$/i, "") + ".ic10",
    query: source.toString(),
  });
}

export function activate(context: ExtensionContext) {
  // The server is implemented in node
  const serverModule = context.asAbsolutePath(
    path.join("server", "out", "server.js")
  );

  // If the extension is launched in debug mode then the debug server options are used
  // Otherwise the run options are used
  const serverOptions: ServerOptions = {
    run: { module: serverModule, transport: TransportKind.ipc },
    debug: {
      module: serverModule,
      transport: TransportKind.ipc,
    },
  };

  // Options to control the language client
  const clientOptions: LanguageClientOptions = {
    // Drive the server for ICC documents (the language id contributed in the
    // extension manifest).
    documentSelector: [{ scheme: "file", language: "icc" }],
    synchronize: {
      // Notify the server about file changes to '.clientrc files contained in the workspace
      fileEvents: workspace.createFileSystemWatcher("**/.clientrc"),
    },
  };

  // Create the language client and start the client.
  client = new LanguageClient(
    "icc-language-server-id",
    "icc-language-server-name",
    serverOptions,
    clientOptions
  );

  const output = new CompiledOutputProvider();

  context.subscriptions.push(
    workspace.registerTextDocumentContentProvider(OUTPUT_SCHEME, output),
    commands.registerCommand("icc.compile", () => compileActiveFile(output))
  );

  // Start the client. This will also launch the server.
  clientReady = client.start();
}

/**
 * Compile the active ICC file via the server and show the result in a
 * read-only pane beside the editor. Errors are shown the same way the web
 * editor shows them: as a leading `#` comment in the output.
 */
async function compileActiveFile(output: CompiledOutputProvider): Promise<void> {
  const editor = window.activeTextEditor;
  if (!editor || editor.document.languageId !== "icc") {
    window.showInformationMessage("Open an ICC (.icc) file to compile.");
    return;
  }
  const source = editor.document.uri;

  await clientReady;
  let result: CompileResult;
  try {
    result = await client.sendRequest<CompileResult>("icc/compile", {
      uri: source.toString(),
    });
  } catch (error) {
    window.showErrorMessage(`ICC: compile request failed: ${error}`);
    return;
  }

  const outputUri = outputUriFor(source);

  if (result.ok) {
    output.set(outputUri, result.ic10);
    const lineCount = result.ic10 === "" ? 0 : result.ic10.split("\n").length;
    const byteCount = Buffer.byteLength(result.ic10, "utf8");
    window.setStatusBarMessage(
      `ICC: ${lineCount}/${LINE_LIMIT} lines · ${byteCount}/${BYTE_LIMIT} bytes`,
      5000
    );
  } else {
    // Mirror the web editor, which prints the error as a leading comment.
    output.set(outputUri, `# ${result.message}`);
  }

  const document = await workspace.openTextDocument(outputUri);
  await window.showTextDocument(document, {
    viewColumn: ViewColumn.Beside,
    preview: true,
    preserveFocus: true,
  });
}

export function deactivate(): Thenable<void> | undefined {
  if (!client) {
    return undefined;
  }
  return client.stop();
}
