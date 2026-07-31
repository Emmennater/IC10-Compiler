# Stationeers-ICC Language Support
VS Code extension for developing ICC scripts. 
## Links
- [GitHub](https://github.com/Emmennater/IC10-Compiler)
- [ICC Documentation](https://emmennater.github.io/IC10-Compiler/docs.html)
- [ICC Editor](https://emmennater.github.io/IC10-Compiler/index.html)
## How to Use
1. Open a .icc file and write a program.
2. Compile the file with Ctrl+Enter (configure keybinds if needed) or with the run button in the top right.
### Imports
You can import a file by referencing the path just like in most other languages. For example,

File Structure:
```
foo.icc
bar/
├─ baz.icc
```

baz.icc
```
let arr[10]
```

foo.icc
```
import arr from "bar/baz.icc"
db.Setting = arr[0]
```