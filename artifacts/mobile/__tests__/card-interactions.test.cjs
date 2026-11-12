const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

function assertSiblingButtons(source) {
  const tree = ts.createSourceFile("card.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  function walk(node, depth = 0) {
    const element = ts.isJsxElement(node) ? node.openingElement : ts.isJsxSelfClosingElement(node) ? node : null;
    const button = element?.tagName.getText(tree) === "Pressable";
    assert.ok(!button || depth === 0, "A Pressable must not contain another interactive Pressable");
    ts.forEachChild(node, child => walk(child, depth + (button ? 1 : 0)));
  }
  walk(tree);
}
for (const filename of ["VideoCard.tsx", "SermonCard.tsx"]) {
  test(`${filename} keeps playback and secondary actions separate`, () => {
    assertSiblingButtons(fs.readFileSync(path.join(__dirname, "../components", filename), "utf8"));
  });
}
for (const filename of ["search.tsx", "(tabs)/index.tsx"]) {
  test(`${filename} keeps primary and secondary controls separate`, () => {
    assertSiblingButtons(fs.readFileSync(path.join(__dirname, "../app", filename), "utf8"));
  });
}
test("the nesting guard detects the original invalid hierarchy", () => {
  assert.throws(() => assertSiblingButtons("<Pressable><View><Pressable /></View></Pressable>"));
});
