
export function transpile(tree, text) {
  function visit(node) {
    // console.log(node.name);
  }

  function walk(tree) {
    tree.iterate({
      enter(node) {
        visit(node);
      }
    });
  }

  walk(tree);
}
