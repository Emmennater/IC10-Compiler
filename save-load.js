import { editor, output, updateTextEditor, setRunCallback } from "./codemirror.js";
import { setupDropdown, dropdownItem, dropdownPlaceholder } from "./dropdown.js";

const SCRIPTS_KEY = "ic10-compiler-scripts";
const LAST_KEY = "ic10-compiler-last-script";
const DEFAULT_NAME = "new-script";

const nameInput = document.querySelector("#script-name");
const listToggle = document.querySelector("#script-list-toggle");
const listBox = document.querySelector("#script-list");
const savedIcon = document.querySelector("#saved-icon");

// `currentScript` is the name in the box; `savedName` is the key the buffer is
// actually stored under ("" when it has never been saved). They differ while a
// rename is pending, which is what makes the rename a move rather than a copy:
// saving writes the new name and drops the old one.
let currentScript = "";
let savedName = "";
let savedStatus = false;

function readScripts() {
  try {
    return JSON.parse(localStorage.getItem(SCRIPTS_KEY)) ?? {};
  } catch {
    return {};
  }
}

function writeScripts(scripts) {
  localStorage.setItem(SCRIPTS_KEY, JSON.stringify(scripts));
}

/** `base`, or the first `base2`, `base3`, … that no saved script uses. */
function unusedName(base) {
  const scripts = readScripts();
  if (scripts[base] === undefined) return base;
  for (let n = 2; ; n++) {
    if (scripts[`${base}${n}`] === undefined) return `${base}${n}`;
  }
}

function setStatus(saved) {
  savedIcon.textContent = saved ? "✔" : "✖";
  savedIcon.title = saved ? "Saved" : "Unsaved changes";
  savedIcon.classList.toggle("unsaved", !saved);
  savedStatus = saved;
}

function getStatus() {
  return savedStatus;
}

function setName(name) {
  currentScript = name;
  nameInput.value = name;
}

function refreshScriptList() {
  listBox.innerHTML = "";
  const names = Object.keys(readScripts()).sort();

  if (names.length === 0) {
    listBox.appendChild(dropdownPlaceholder("No saved scripts"));
    return;
  }

  for (const name of names) {
    listBox.appendChild(dropdownItem(name, name === savedName, () => {
      scriptMenu.close();
      loadScript(name);
    }));
  }
}

const scriptMenu = setupDropdown(listToggle, listBox, refreshScriptList);

function loadScript(name) {
  const scripts = readScripts();
  if (scripts[name] === undefined) return;

  if (!getStatus()) {
    if (window.confirm("Save changes?")) saveScript();
  }

  updateTextEditor(editor, scripts[name]);
  savedName = name;
  setName(name);
  localStorage.setItem(LAST_KEY, name);
  // After the edit, which marks the document dirty: a freshly loaded script is
  // saved by definition.
  setStatus(true);
}

function newScript() {
  const scripts = readScripts();

  if (!getStatus()) {
    if (window.confirm("Save changes?")) saveScript();
  }

  updateTextEditor(editor, "");
  savedName = "";
  localStorage.removeItem(LAST_KEY);
  setName(unusedName(DEFAULT_NAME));
  setStatus(false);
}

/**
 * Fold whatever is in the name box into `currentScript`. A name already taken
 * by another script is refused and the box reverts, so a rename can never
 * clobber a saved script.
 */
function commitName() {
  const name = nameInput.value.trim();

  if (!name || name === currentScript) {
    nameInput.value = currentScript;
    return;
  }

  const scripts = readScripts();
  if (name !== savedName && scripts[name] !== undefined) {
    window.alert(`A script named "${name}" already exists.`);
    nameInput.value = currentScript;
    return;
  }

  setName(name);
  saveScript();
}

export function documentChanged() {
  setStatus(false);
}

export function saveScript() {
  // Ctrl+S from inside the box beats the change event, so fold the name first.
  commitName();

  const name = currentScript;
  if (!name) return;

  const scripts = readScripts();
  if (savedName && savedName !== name) delete scripts[savedName];
  scripts[name] = editor.state.doc.toString();
  writeScripts(scripts);

  savedName = name;
  localStorage.setItem(LAST_KEY, name);
  setStatus(true);
}

nameInput.addEventListener("change", commitName);

nameInput.addEventListener("keydown", event => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
    event.preventDefault();
    saveScript();
  } else if (event.key === "Enter") {
    event.preventDefault();
    commitName();
    nameInput.blur();
  } else if (event.key === "Escape") {
    nameInput.value = currentScript;
    nameInput.blur();
  } else {
    setStatus(false);
  }
});

document.querySelector("#script-save").addEventListener("click", saveScript);

document.querySelector("#script-new").addEventListener("click", newScript);

document.querySelector("#script-delete").addEventListener("click", () => {
  const scripts = readScripts();

  if (!savedName || scripts[savedName] === undefined) {
    window.alert(`"${currentScript}" has not been saved yet, so there is nothing to delete.`);
    return;
  }

  if (!window.confirm(`Delete "${savedName}"? This cannot be undone.`)) return;

  delete scripts[savedName];
  writeScripts(scripts);
  
  if (Object.keys(scripts).length === 0) newScript();
  else loadScript(Object.keys(scripts)[0]);
});

document.querySelector("#copy-output").addEventListener("click", () => {
  navigator.clipboard.writeText(output.state.doc.toString());
});

export function setup(run) {
  if (!run) throw new Error("Missing run callback");

  // Restore the last opened script before the first compile
  const scripts = readScripts();
  const last = localStorage.getItem(LAST_KEY) ?? "";

  if (last && scripts[last] !== undefined) {
    updateTextEditor(editor, scripts[last]);
    savedName = last;
    setName(last);
    setStatus(true);
  } else {
    savedName = "";
    localStorage.removeItem(LAST_KEY);
    setName(unusedName(DEFAULT_NAME));
    setStatus(false);
  }

  document.querySelector("#script-run").addEventListener("click", run);

  refreshScriptList();
  setRunCallback(run);
  run();
}
