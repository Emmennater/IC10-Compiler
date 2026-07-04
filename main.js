
import { EditorView, keymap, lineNumbers } from "@codemirror/view";
import { javascript } from "@codemirror/lang-javascript";
import { acceptCompletion } from "@codemirror/autocomplete";
import { insertTab, indentLess } from "@codemirror/commands";
import { parser } from "./parser.js";
import { LRLanguage, HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { styleTags, tags as t, Tag } from "@lezer/highlight";

// const starterCode = `
// // Testing
// define analyzer HASH("StructurePipeAnalyzer")
// alias pump r0
// let x = 1 + 1
// if x == 2:
//   s pump Setting 1
// else:
//   s pump Setting 2
// `.substring(1);

// const starterCode = `
// define analyzer HASH("StructurePipeAnalyzer")
// alias pump d0
// let x = 1 + 1

// if x == 2 then
//   s pump Setting 1
// elseif x == 3 then
//   s pump Setting 2
//   move r1 true
// else
//   s pump Setting 3
// end
// `.substring(1);

const starterCode = `
let machine = d0
let stacker = d1

machine.ClearMemory = 1

while true do
  yield
  if machine.ExportCount == stacker.Setting then
    machine.Activate = 0
    machine.ClearMemory = 1
  elseif machine.Activate == 0 then
    machine.ClearMemory = 1
  end
end
`.substring(1);

const device = Tag.define();
const register = Tag.define();

// 1. Define the structural layout and editor UI colors
const myCustomTheme = EditorView.theme({
  // The main editor container
  "&": {
    color: "#e0e0e0",
    backgroundColor: "#282C34",
    width: "100%",
    height: "100%"
  },
  // The background area containing line numbers
  ".cm-gutters": {
    backgroundColor: "#282C34",
    color: "#858585",
    border: "none",
    paddingRight: "14px",
    borderRight: "2px solid #535964"
  },
  // Style for the text selection
  ".cm-content, .cm-gutter": {
    minHeight: "200px"
  },
  "&.cm-focused": {
    outline: "none"
  },
  // Style for the flashing cursor
  ".cm-cursor, & .cm-dropCursor": {
    borderLeftColor: "#ffffff"
  }
}, { dark: true }); // Use dark: false for a light theme

// 2. Define the token colors for syntax highlighting
const myHighlightStyle = HighlightStyle.define([
  { tag: device, color: '#72ffec' },
  { tag: register, color: '#72ffec' },
  { tag: t.keyword, color: "#ff7b72" },
  { tag: t.comment, color: "#8b949e" },
  { tag: [t.string, t.special(t.string)], color: "#a5d6ff" },
  { tag: [t.number, t.bool], color: "#ffa657" },
  { tag: [t.variableName], color: "#79c0ff" },
  { tag: [t.function(t.variableName), t.labelName], color: "#d2a8ff" },
  { tag: t.operator, color: "#7d91a8" },
]);

// 3. Combine both parts into a single extension export
const myCustomThemeExtension = [
  myCustomTheme,
  syntaxHighlighting(myHighlightStyle)
];

const lang = LRLanguage.define({
  parser: parser.configure({
    props: [
      styleTags({
        Number: t.number,
        "AddOp MulOp CompareOp LogicAnd LogicOr ParenLeft ParenRight Assign Dot Colon": t.operator,
        "InstructionName FunctionName": t.function(t.variableName),
        "if then elseif else end let while do": t.keyword,
        String: t.string,
        Device: device,
        Register: register,
        Bool: t.bool,
        LabelName: t.labelName,
        Comment: t.comment,
      })
    ]
  })
});

const editor = new EditorView({
  parent: document.getElementById("editor-container"),
  doc: starterCode,
  extensions: [
    myCustomThemeExtension,
    lang,
    lineNumbers(),
    keymap.of([
      {
        key: "Tab",
        run(view) {
          if (acceptCompletion(view))
            return true;

          view.dispatch(view.state.replaceSelection("  "));
          return true;
        }
      },
      {
        key: "Shift-Tab",
        run: indentLess
      }
    ])
  ]
});

function nodeToJSON(cursor) {
  const result = {
    type: cursor.type.name,
    from: cursor.from,
    to: cursor.to,
    children: []
  };

  if (cursor.firstChild()) {
    do {
      result.children.push(nodeToJSON(cursor));
    } while (cursor.nextSibling());
    cursor.parent();
  }

  return result;
}

function showTree() {
  const text = editor.state.doc.toString();
  const tree = parser.parse(text);

  const getLineNum = pos => {
    const line = editor.state.doc.lineAt(pos);
    return line.number;
  };

  const getColumnNum = pos => {
    const line = editor.state.doc.lineAt(pos);
    return pos - line.from;
  };

  tree.iterate({
    enter(node) {
      const lineNum = getLineNum(node.from);
      const columnNum = getColumnNum(node.from);
      const str = text.substring(node.from, node.to).replace(/\n/g, "\\n\n");
      console.log(
        "  ".repeat(node.node.depth) +
        `${node.type.name}\n${str}`
      );
    }
  });

  // const json = nodeToJSON(tree.cursor());
  // console.log(JSON.stringify(json, null, 2));
}

document.getElementById("run").addEventListener("click", showTree);
