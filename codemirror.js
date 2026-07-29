
import { EditorView, lineNumbers, highlightActiveLine,
  highlightActiveLineGutter, keymap } from "@codemirror/view";
import { insertTab, indentLess, indentMore, history, historyKeymap, toggleComment } from "@codemirror/commands";
import { EditorState, Compartment } from "@codemirror/state";
import { acceptCompletion } from "@codemirror/autocomplete";
import { LRLanguage, HighlightStyle, syntaxHighlighting, indentUnit } from "@codemirror/language";
import { styleTags, tags as t, Tag } from "@lezer/highlight";
import { parser } from "./lezer/parser.js";
import { parser as parser_ic10 } from "./lezer/parser-ic10.js";
import { saveScript, documentChanged } from "./save-load.js";
import { loadTheme, applyTheme, themeNames, themeName } from "./theme.js";

const initialText = `
let x = a + b
let y = x * 2
c = y - x`.slice(1);

// Set by main.js; invoked on Mod-Enter and on every document change.
let runCallback = () => {};

function setRunCallback(fn) {
  runCallback = fn;
}

const device = Tag.define();
const register = Tag.define();
const declaration = Tag.define();

const themeColors = loadTheme();

// Element colors are read live from the css root, so only the token colors
// baked into the HighlightStyle have to be rebuilt when the theme changes.
const highlightStyle = new Compartment();

const theme = EditorView.theme({
  // The main editor container
  "&": {
    color: "var(--theme-text-element)",
    backgroundColor: "var(--theme-background)",
    width: "100%",
    height: "100%",
    padding: "0px",
    fontSize: "24px",
  },
  "&.cm-editor.cm-focused": {
    outline: "none"
  },
  // The main editor area
  ".cm-content, .cm-gutter": {
    minHeight: "200px",
    padding: "0px",
    paddingBottom: "var(--scroll-padding)",
    lineHeight: "33px",
    caretColor: "white",
  },
  ".cm-content ::selection": {
    backgroundColor: "#ffffff22",
  },
  // The background area containing line numbers
  ".cm-gutters": {
    backgroundColor: "var(--theme-background)",
    color: "var(--theme-line-number)",
    border: "none",
    padding: "0px",
    borderRight: "2px solid var(--theme-border)",
    userSelect: "none",
  },
  // Line number gutter
  "& .cm-gutterElement": {
    display: "flex",
    width: "60px",
    alignItems: "center",
    justifyContent: "center",
    boxSizing: "border-box"
  },
  // Line
  "& .cm-line": {
    paddingLeft: "4px",
  },
  // Active line
  "& .cm-activeLine": {
    backgroundColor: "#ffffff11"
  },
  "& .cm-activeLineGutter": {
    color: "var(--theme-text-element)",
    backgroundColor: "var(--theme-background-element)"
  },
  // Hide active line
  "&.cm-hide-active-line .cm-activeLine": {
    backgroundColor: "transparent"
  },

  "&.cm-hide-active-line .cm-activeLineGutter": {
    backgroundColor: "transparent",
    color: "inherit"
  },
  // Scrollbar
  "& .cm-scroller": {
    lineHeight: "normal",
  },
  ".cm-scroller::-webkit-scrollbar": {
    width: "16px",
    height: "16px",
  },
  ".cm-scroller::-webkit-scrollbar-thumb": {
    backgroundColor: "#ffffff22",
  },
  // Error linting
  ".cm-inline-error-msg": {
    color: "#ff0000",
  }
});

function highlightsFor(colors) {
  return syntaxHighlighting(HighlightStyle.define([
    { tag: device, color: colors.special },
    { tag: register, color: colors.special },
    { tag: declaration, color: colors.declaration },
    { tag: t.keyword, color: colors.keyword },
    { tag: t.comment, color: colors.comment },
    { tag: [t.string, t.special(t.string)], color: colors.string },
    { tag: [t.number, t.bool], color: colors.number },
    { tag: [t.variableName], color: colors.variable },
    { tag: [t.function(t.variableName), t.labelName], color: colors.function },
    { tag: t.operator, color: colors.operator },
  ]));
}

const lang = LRLanguage.define({
  parser: parser.configure({
    props: [
      styleTags({
        "AddOp MulOp CompareOp LogicAnd LogicOr ParenLeft ParenRight Assign CompoundAssignOp \
        UnaryOp BracketLeft BracketRight Dot Not Comma ShiftOp BitAnd BitOr BitXor BitNot": t.operator,
        "if then elif else end loop while do repeat until break continue \
        return At DirectiveName for in of fn": t.keyword,
        "let const define device": declaration,
        "Instruction FunctionName": t.function(t.variableName),
        "Number Integer": t.number,
        Bool: t.bool,
        Comment: t.comment,
        String: t.string,
        VariableName: t.variableName,
        Device: device
      })
    ]
  }),
  languageData: {
    commentTokens: { line: "#" },
  }
});

const lang_ic10 = LRLanguage.define({
  parser: parser_ic10.configure({
    props: [
      styleTags({
        "InstructionName FunctionName": t.function(t.variableName),
        "ParenLeft ParenRight Colon Dot AddOp": t.operator,
        "Number Integer": t.number,
        String: t.string,
        Channel: device,
        DeviceName: device,
        Register: register,
        LabelName: t.labelName,
        Comment: t.comment,
        VariableName: t.variableName
      })
    ]
  }),
  languageData: {
    commentTokens: { line: "#" },
  }
});

const ext = [
  theme,
  highlightStyle.of(highlightsFor(themeColors)),
  lineNumbers({ formatNumber: n => n - 1 }),
  highlightActiveLine(),
  highlightActiveLineGutter(),
  EditorView.updateListener.of(update => {
    const view = update.view;
    const hasSelection = !view.state.selection.main.empty;
    const isFocused = view.hasFocus;
    const hideActiveLine = hasSelection || !isFocused;
    view.dom.classList.toggle("cm-hide-active-line", hideActiveLine);
  })
];

const keymapExtensions = [
  history(),
  indentUnit.of("  "),
  keymap.of([
    ...historyKeymap,
    {
      key: "Tab",
      run(view) {
        if (acceptCompletion(view))
          return true;

        let { state, dispatch } = view;

        // keep normal multi-line/selection indent behavior
        if (state.selection.ranges.some(r => !r.empty)) {
          return indentMore({ state, dispatch })
        }

        let { from, to } = state.selection.main;
        let column = from - state.doc.lineAt(from).from;

        if (column % 2 == 0) {
          dispatch(state.replaceSelection("  "));
        } else {
          dispatch(state.replaceSelection(" "));
        }

        return true;
      }
    },
    {
      key: "Shift-Tab",
      run: indentLess
    },
    {
      key: "Enter",
      run(view) {
        const { state } = view;
        const { from } = state.selection.main;

        const line = state.doc.lineAt(from);
        const beforeCursor = line.text.slice(0, from - line.from);

        // Copy the current line's indentation
        let indent = (line.text.match(/^\s*/) ?? [""])[0];

        // If the line ends with "then", "do", or "else", indent one more level
        if (/\b(?:then|do|else|loop|repeat)\s*$/.test(beforeCursor)) {
          indent += "  ";
        }

        // If the line starts with "fn", ident one more level
        if (/^\s*fn\s/.test(beforeCursor)) {
          indent += "  ";
        }

        view.dispatch({
          changes: {
            from,
            to: from,
            insert: "\n" + indent
          },
          selection: {
            anchor: from + 1 + indent.length
          },
          scrollIntoView: true
        });

        return true;
      }
    },
    {
      key: "Backspace",
      run(view) {
        const { state } = view;
        const { from, to, empty } = state.selection.main;

        // Let the default behavior handle selections
        if (!empty) return false;

        // If on an odd column only delete one
        let column = from - state.doc.lineAt(from).from;
        if (column % 2 === 1) return false;

        if (from >= 2 && state.doc.sliceString(from - 2, from) === "  ") {
          view.dispatch({
            changes: {
              from: from - 2,
              to: from
            }
          });
          return true;
        }

        return false;
      }
    },
    {
      key: "Mod-/",
      run: toggleComment
    },
    {
      key: "Mod-Enter",
      run: () => { runCallback(); return true; }
    },
    {
      key: "Mod-s",
      run: () => {
        saveScript();
        return true;
      }
    }
  ]),
  EditorView.updateListener.of(update => {
    if (update.docChanged) documentChanged();
  }),
  EditorView.updateListener.of(update => {
    // Only act when the selection actually changed in this update.
    // This also skips viewport-only updates (e.g. manual scrolling),
    // which otherwise have an empty transactions array and slip past
    // the filters below.
    if (!update.selectionSet) return;

    // Ignore cursor movements made with the mouse
    if (update.transactions.some(tr => tr.isUserEvent("select.pointer"))) {
      return;
    }

    // Ignore scroll-triggered transactions
    if (update.transactions.some(tr => tr.isUserEvent("scroll"))) {
      return;
    }

    const view = update.view;
    const margin = 3 * view.defaultLineHeight;

    const pos = update.state.selection.main.head;
    const coords = view.coordsAtPos(pos);
    if (!coords) return;

    const scroller = view.scrollDOM;
    const rect = scroller.getBoundingClientRect();

    if (coords.top < rect.top + margin) {
      scroller.scrollTop -= (rect.top + margin) - coords.top;
    }

    if (coords.bottom > rect.bottom - margin) {
      scroller.scrollTop += coords.bottom - (rect.bottom - margin);
    }
  }),
  EditorView.updateListener.of(update => {
    const view = update.view;
    const hasSelection = !view.state.selection.main.empty;
    const isFocused = view.hasFocus;
    const hideActiveLine = hasSelection || !isFocused;
    view.dom.classList.toggle("cm-hide-active-line", hideActiveLine);
  })
];

const editable = [
  keymapExtensions
];

const nonEditable = [
  EditorState.readOnly.of(true),
  EditorView.contentAttributes.of({tabindex: "0"})
];

const editor = new EditorView({
  doc: initialText,
  extensions: [lang, ...ext, ...editable],
  parent: document.querySelector('#editor')
});

const output = new EditorView({
  doc: "",
  extensions: [lang_ic10, ...nonEditable, ...ext],
  parent: document.querySelector('#output')
});

function setTheme(name) {
  const effects = highlightStyle.reconfigure(highlightsFor(applyTheme(name)));
  editor.dispatch({ effects });
  output.dispatch({ effects });
}

export function initListeners() {
  // Theme switching
  const themeSelect = document.querySelector("#theme-select");

  for (const name of themeNames) {
    const option = document.createElement("option");
    option.value = name;
    option.textContent = name;
    themeSelect.appendChild(option);
  }

  themeSelect.value = themeName();
  themeSelect.addEventListener("change", () => setTheme(themeSelect.value));

  // Editor scrolling
  const scrollerEditor = editor.scrollDOM;

  const resizeEditor = new ResizeObserver(() => {
    scrollerEditor.style.setProperty(
      "--scroll-padding",
      `${scrollerEditor.clientHeight - editor.defaultLineHeight}px`
    );
  });

  resizeEditor.observe(scrollerEditor);

  // Output scrolling
  const scrollerOutput = output.scrollDOM;

  const resizeOutput = new ResizeObserver(() => {
    scrollerOutput.style.setProperty(
      "--scroll-padding",
      `${scrollerOutput.clientHeight - output.defaultLineHeight}px`
    );
  });

  resizeOutput.observe(scrollerOutput);
}

function updateTextEditor(view, text) {
  view.dispatch({
    changes: {
      from: 0,
      to: view.state.doc.length,
      insert: text
    }
  });
}

export {
  editor,
  output,
  updateTextEditor,
  setRunCallback
};
