# Stationeers-ICC
ICC is a small custom programming language that compiles to [IC10](https://stationeers-wiki.com/IC10), the scripting language used in [Stationeers](https://store.steampowered.com/app/544550/Stationeers/).

![Example](assets/example.png)

This tool was made to *enhance* the experience of writing IC10 by providing a powerful, yet intuitive syntax to support the development of complex programs. Several optimizations were put in place to keep programs compact so that you don't need to worry about the compiler generating unoptimized code.

This programming language is different from most other languages in that it was designed *explicitly* for IC10. This syntax might feel familiar for those who have written IC10 in the past. In fact, you can use all of the available IC10 instructions just by calling them as a function!

To get started, visit the [documentation page](https://emmennater.github.io/IC10-Compiler/docs.html) to learn more about ICC. Once you are ready, try writing your first program in the [editor](https://emmennater.github.io/IC10-Compiler/index.html). Find a bug? Leave an issue and I'll look into it!

### VS Code Extension
If you would like to write ICC in vscode, install the extension by following these steps:
1. Clone this repository: `https://github.com/Emmennater/IC10-Compiler.git`
2. Install dependencies (with node installed): `npm install`
3. Create the vsix file: `npm run package:ext`
4. Install the extension:
  1. Navigate to the extensions marketplace.
  2. Press the three dots ... in the top right.
  3. Click "Install from VSIX...".
  4. Find the vsix file you generated and click install.

Now you should have the plugin installed. Try it out by opening a .icc file. Run a program with Ctrl+Enter (configure keybinds if needed) or with the run button in the top right.