// Shared Lezer highlighting setup for both the ICC and IC10 grammars. This is
// the single source of truth for "which grammar node maps to which token
// class" - codemirror.js feeds these configured parsers straight to
// CodeMirror's LRLanguage, and docs.js calls highlightSegments to color code
// fences in the rendered documentation, so the two surfaces cannot drift.

import { styleTags, tags as t, Tag, tagHighlighter, highlightTree } from "@lezer/highlight";
import { parser } from "./lezer/parser.js";
import { parser as parser_ic10 } from "./lezer/parser-ic10.js";

// Tags for tokens the two grammars distinguish that @lezer/highlight's
// built-in vocabulary has no dedicated tag for.
export const device = Tag.define();
export const register = Tag.define();
export const declaration = Tag.define();
export const instruction = Tag.define();
export const label = Tag.define();

export const iccParser = parser.configure({
  props: [
    styleTags({
      "AddOp MulOp CompareOp LogicAnd LogicOr ParenLeft ParenRight Assign CompoundAssignOp \
      UnaryOp BracketLeft BracketRight Dot Not Comma ShiftOp BitAnd BitOr BitXor BitNot \
      Question Colon": t.operator,
      "if then elif else end loop while do repeat until break continue \
      return At DirectiveName for in of fn import from using": t.keyword,
      "let const define device stack": declaration,
      "FunctionName": t.function(t.variableName),
      "Number Integer": t.number,
      Instruction: instruction,
      Bool: t.bool,
      Comment: t.comment,
      String: t.string,
      VariableName: t.variableName,
      Device: device
    })
  ]
});

export const ic10Parser = parser_ic10.configure({
  props: [
    styleTags({
      "InstructionName": instruction,
      "FunctionName": t.function(t.variableName),
      "ParenLeft ParenRight Dot AddOp": t.operator,
      "Number Integer": t.number,
      String: t.string,
      Channel: device,
      DeviceName: device,
      Register: register,
      "LabelName Colon": label,
      Comment: t.comment,
      VariableName: t.variableName
    })
  ]
});

// Class names, not colors: each maps to a `.tok-*` rule in main.css that
// reads the same `--theme-*` custom property the CodeMirror editor paints
// with, so a code fence re-colors the instant the theme toggle fires.
const highlighter = tagHighlighter([
  { tag: instruction, class: "tok-instruction" },
  { tag: register, class: "tok-register" },
  { tag: device, class: "tok-device" },
  { tag: declaration, class: "tok-declaration" },
  { tag: label, class: "tok-label" },
  { tag: t.keyword, class: "tok-keyword" },
  { tag: t.comment, class: "tok-comment" },
  { tag: [t.string, t.special(t.string)], class: "tok-string" },
  { tag: t.number, class: "tok-number" },
  { tag: t.bool, class: "tok-bool" },
  { tag: t.variableName, class: "tok-variable" },
  { tag: [t.function(t.variableName), t.labelName], class: "tok-function" },
  { tag: t.operator, class: "tok-operator" },
]);

const parsersByLanguage = { icc: iccParser, ic10: ic10Parser };

export const highlightLanguages = Object.keys(parsersByLanguage);

/**
 * Split `code` into `{ text, class }` runs for `language` ("icc" or "ic10").
 * `class` is null for the unstyled gaps between highlighted tokens (e.g.
 * whitespace). An unrecognized language returns the whole string as one
 * unstyled run rather than throwing, so a fence with a typo'd or unrelated
 * language tag still renders as plain code.
 */
export function highlightSegments(code, language) {
  const langParser = parsersByLanguage[language];
  if (!langParser) return [{ text: code, class: null }];

  const tree = langParser.parse(code);
  const segments = [];
  let pos = 0;

  highlightTree(tree, highlighter, (from, to, classes) => {
    if (from > pos) segments.push({ text: code.slice(pos, from), class: null });
    segments.push({ text: code.slice(from, to), class: classes });
    pos = to;
  });

  if (pos < code.length) segments.push({ text: code.slice(pos), class: null });

  return segments;
}
