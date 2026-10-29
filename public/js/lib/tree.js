/** Nests file paths into folders: {dirs: Map(name -> node), files: [path]}. */
export function buildTree(files) {
  const top = { dirs: new Map(), files: [] };
  for (const file of files) {
    let node = top;
    for (const dir of file.split("/").slice(0, -1)) {
      if (!node.dirs.has(dir)) node.dirs.set(dir, { dirs: new Map(), files: [] });
      node = node.dirs.get(dir);
    }
    node.files.push(file);
  }
  return compact(top);
}

/** Joins folders that hold only one folder, so a deep path reads "src/lib/util" on one row, as GitHub shows it. */
function compact(node) {
  const dirs = new Map();
  for (let [name, child] of node.dirs) {
    while (child.files.length === 0 && child.dirs.size === 1) {
      const [[inner, grandchild]] = child.dirs;
      name = `${name}/${inner}`;
      child = grandchild;
    }
    dirs.set(name, compact(child));
  }
  return { dirs, files: node.files };
}

/**
 * Lays a stack's entries out for the sidebar, top of the stack first, as
 * `gt log` draws it. Each row gets a depth: a branch's first child stays in
 * its column, and each further child starts a column to the right.
 */
export function stackRows(entries) {
  const byId = new Map(entries.map((e) => [e.id, e]));
  const rows = [];
  const visit = (entry, depth) => {
    rows.push({ entry, depth });
    entry.children.forEach((id, i) => {
      if (byId.has(id)) visit(byId.get(id), depth + i);
    });
  };
  if (entries.length) visit(entries[0], 0);
  return rows.reverse();
}
