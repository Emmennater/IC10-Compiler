import { compile, CompileError } from "./compiler.ts";
import { getAST } from "./ast.js";
import { editor, output, updateTextEditor, initListeners } from "./codemirror.js";
import { setup } from "./save-load.js"

const LINE_LIMIT = 128;
const BYTE_LIMIT = 4096;

const stats = document.querySelector("#stats");

function run() {
  const txt = editor.state.doc.toString();

  let ic10;
  try {
    let ast = getAST(txt);
    // console.log(ast);
    let config = { removeLabels: true };
    ic10 = compile(ast, config);
  } catch (e) {
    if (e instanceof CompileError) {
      updateTextEditor(output, `# ${e.message}`);
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
