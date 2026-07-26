import { getAST } from "./compiler/ast.ts";
import { compile, CompileError } from "./compiler/index.ts";
import { getFormalAST } from "./compiler/formal-ast.ts";

const DEFAULT_SOURCE = `
let x = a
if x > 1 then
  b = 1
elif x < -1 then
  b = 2
else
  b = 3
end
`.substring(1);

const sourceEl = document.getElementById("source");
const outputEl = document.getElementById("output");
const compileEl = document.getElementById("compile");

sourceEl.value = DEFAULT_SOURCE;

function compileCurrentSource() {
  const source = sourceEl.value;
  outputEl.classList.remove("error");
  try {
    const ast = getAST(source);
    const formalAST = getFormalAST(ast);
    console.log(formalAST);
    outputEl.textContent = compile(ast, { removeLabels: true });
  } catch (e) {
    outputEl.classList.add("error");
    outputEl.textContent = e instanceof CompileError ? e.message : String(e);
  }
}

compileEl.addEventListener("click", compileCurrentSource);
compileCurrentSource();
