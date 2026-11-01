// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

// Fixes a tree-validation bug in ts-mls (1.6.2 through at least 1.6.4).
//
// RFC 9420, 7.9.1: for every unmerged leaf L of a parent node P, each
// non-blank node BETWEEN L and P must also list L. ts-mls instead demands
// that every non-blank node on L's whole direct path (above P too) has
// exactly the same unmerged list as P. A higher node legitimately lists
// more leaves (adds from its other subtree), so ordinary groups - two
// adds into different subtrees with no path update between - were
// refused when a device joined, by welcome or externally: "non-blank
// intermediate node must list leaf node in its unmerged_leaves". Found
// 2026-11-01 in the cloud test of voice in client-web.
//
// Patched in place in node_modules, idempotently. Run by build.mjs and
// by client-web's build (which bundles client-core's node_modules). If
// ts-mls changes so the expected code is gone, this fails loudly rather
// than shipping an unpatched copy: check the new version for the bug.

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const file = fileURLToPath(new URL("../node_modules/ts-mls/dist/src/clientState.js", import.meta.url));
const MARK = "/* OPENVOXA-PATCHED unmerged_leaves (RFC 9420 7.9.1) */";

const before = `                for (const parentIdx of dp) {
                    const dpNode = tree[parentIdx];
                    if (dpNode !== undefined) {
                        if (dpNode.nodeType !== "parent")
                            return new InternalError("Expected parent node");
                        if (!arraysEqual(dpNode.parent.unmergedLeaves, n.parent.unmergedLeaves))
                            return new ValidationError("non-blank intermediate node must list leaf node in its unmerged_leaves");
                    }
                }`;

const after = `                ${MARK}
                for (const parentIdx of dp.slice(0, Math.max(0, dp.indexOf(toNodeIndex(i))))) {
                    const dpNode = tree[parentIdx];
                    if (dpNode !== undefined) {
                        if (dpNode.nodeType !== "parent")
                            return new InternalError("Expected parent node");
                        if (!dpNode.parent.unmergedLeaves.some((l) => Number(l) === Number(unmergedLeaf)))
                            return new ValidationError("non-blank intermediate node must list leaf node in its unmerged_leaves");
                    }
                }`;

const src = await readFile(file, "utf8");
if (src.includes(MARK)) {
  console.log("ts-mls: unmerged_leaves fix already applied");
} else if (src.includes(before)) {
  await writeFile(file, src.replace(before, after));
  console.log("ts-mls: applied unmerged_leaves fix (scripts/patch-ts-mls.mjs)");
} else {
  throw new Error("ts-mls: expected code for the unmerged_leaves fix not found; " +
    "check whether this ts-mls version still has the bug (scripts/patch-ts-mls.mjs)");
}
