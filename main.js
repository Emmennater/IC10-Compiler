import { compile, diagnose, CompileError } from "./compiler/index.ts";
import { getAST } from "./compiler/ast.ts";
import { editor, output, updateTextEditor, initListeners } from "./codemirror.js";
import { setup, scriptSource } from "./save-load.js"

const LINE_LIMIT = 128;
const BYTE_LIMIT = 4096;

const stats = document.querySelector("#stats");

function run() {
  const txt = editor.state.doc.toString();

  let ast = getAST(txt);
  // console.log(ast);
  let config = { removeLabels: true };

  let ic10;
  try {
    // `import` resolves against the saved scripts, so a module is just
    // another script in the list, named by the name it was saved under.
    ic10 = compile(ast, config, scriptSource);
  } catch (e) {
    if (e instanceof CompileError) {
      // `compile` stops at the first error; re-run collecting so the pane
      // lists everything wrong at once. Only on failure, so a program that
      // compiles is never compiled twice.
      const errors = diagnose(ast, config, scriptSource);
      const messages = errors.length > 0 ? errors.map(d => d.message) : [e.message];
      updateTextEditor(output, messages.map(m => `# ${m}`).join("\n"));
      stats.textContent = "";
      return;
    }
    throw e;
  }

  updateTextEditor(output, ic10);

  const lineCount = ic10 === "" ? 0 : ic10.split("\n").length;
  const byteCount = new TextEncoder().encode(ic10).length;
  stats.textContent = `${lineCount}/${LINE_LIMIT} lines · ${byteCount}/${BYTE_LIMIT} bytes`;
  stats.classList.toggle("over-limit", lineCount > LINE_LIMIT || byteCount > BYTE_LIMIT);
}

initListeners();
setup(run);
