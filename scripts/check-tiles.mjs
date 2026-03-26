#!/usr/bin/env node

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import typescript from "typescript";

const ts = typescript;
const DIRECTION_ORDER = ["NE", "E", "SE", "SW", "W", "NW"];
const RUST_EDGE_TYPES = {
  Grass: "grass",
  Water: "water",
  Road: "road",
  River: "river",
  Coast: "coast",
};

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rustTilePath = path.join(repoRoot, "packages", "wfc", "src", "tile.rs");
const tsTilePath = path.join(repoRoot, "packages", "types", "src", "tile-def.ts");

const rustTiles = parseRustTiles(rustTilePath);
const tsTiles = parseTsTiles(tsTilePath);
const diffs = compareTiles(rustTiles, tsTiles);

if (diffs.length > 0) {
  console.error("Tile definition mismatch detected:");
  for (const diff of diffs) {
    console.error(`- ${diff}`);
  }
  process.exit(1);
}

console.log(`Tile definitions are in sync (${rustTiles.length} tiles).`);

function compareTiles(rust, tsTilesList) {
  const diffs = [];

  if (rust.length !== tsTilesList.length) {
    diffs.push(`tile count differs: Rust has ${rust.length}, TypeScript has ${tsTilesList.length}`);
  }

  const count = Math.min(rust.length, tsTilesList.length);
  for (let index = 0; index < count; index += 1) {
    const rustTile = rust[index];
    const tsTile = tsTilesList[index];
    const label = `tile ${index} (${rustTile.name})`;

    if (rustTile.name !== tsTile.name) {
      diffs.push(`${label}: name differs (Rust='${rustTile.name}', TS='${tsTile.name}')`);
    }
    if (rustTile.mesh !== tsTile.mesh) {
      diffs.push(`${label}: mesh differs (Rust='${rustTile.mesh}', TS='${tsTile.mesh}')`);
    }
    if (JSON.stringify(rustTile.edges) !== JSON.stringify(tsTile.edges)) {
      diffs.push(`${label}: edges differ (Rust=${JSON.stringify(rustTile.edges)}, TS=${JSON.stringify(tsTile.edges)})`);
    }
    if (rustTile.weight !== tsTile.weight) {
      diffs.push(`${label}: weight differs (Rust=${rustTile.weight}, TS=${tsTile.weight})`);
    }
    if (rustTile.preventChaining !== tsTile.preventChaining) {
      diffs.push(
        `${label}: preventChaining differs (Rust=${rustTile.preventChaining}, TS=${tsTile.preventChaining})`,
      );
    }
    if (JSON.stringify(rustTile.highEdges) !== JSON.stringify(tsTile.highEdges)) {
      diffs.push(
        `${label}: highEdges differ (Rust=${JSON.stringify(rustTile.highEdges)}, TS=${JSON.stringify(tsTile.highEdges)})`,
      );
    }
    if (rustTile.levelIncrement !== tsTile.levelIncrement) {
      diffs.push(
        `${label}: levelIncrement differs (Rust=${rustTile.levelIncrement}, TS=${tsTile.levelIncrement})`,
      );
    }
  }

  return diffs;
}

function parseTsTiles(filePath) {
  const sourceText = readFileSync(filePath, "utf8");
  const sourceFile = ts.createSourceFile(
    filePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );

  let tileList = null;

  const visit = (node) => {
    if (ts.isVariableDeclaration(node) && node.name.getText(sourceFile) === "TILE_LIST") {
      const initializer = unwrapExpression(node.initializer);
      if (!initializer || !ts.isArrayLiteralExpression(initializer)) {
        throw new Error("TILE_LIST is not an array literal.");
      }
      tileList = initializer.elements.map((element, index) => parseTsTileObject(element, sourceFile, index));
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);

  if (!tileList) {
    throw new Error("Could not find TILE_LIST in packages/types/src/tile-def.ts.");
  }

  return tileList;
}

function parseTsTileObject(node, sourceFile, index) {
  const object = unwrapExpression(node);
  if (!ts.isObjectLiteralExpression(object)) {
    throw new Error(`TILE_LIST[${index}] is not an object literal.`);
  }

  const props = propertyMap(object);
  const edgesNode = unwrapExpression(getRequired(props, "edges", index));
  if (!ts.isObjectLiteralExpression(edgesNode)) {
    throw new Error(`TILE_LIST[${index}].edges is not an object literal.`);
  }

  const edgeProps = propertyMap(edgesNode);

  return {
    name: literalString(getRequired(props, "name", index), sourceFile),
    mesh: literalString(getRequired(props, "mesh", index), sourceFile),
    edges: DIRECTION_ORDER.map((dir) => literalString(getRequired(edgeProps, dir, index), sourceFile)),
    weight: literalNumber(getRequired(props, "weight", index), sourceFile),
    preventChaining: props.has("preventChaining")
      ? literalBoolean(props.get("preventChaining"), sourceFile)
      : false,
    highEdges: props.has("highEdges")
      ? literalStringArray(props.get("highEdges"), sourceFile)
      : null,
    levelIncrement: props.has("levelIncrement")
      ? literalNumber(props.get("levelIncrement"), sourceFile)
      : 0,
  };
}

function propertyMap(object) {
  const props = new Map();

  for (const property of object.properties) {
    if (!ts.isPropertyAssignment(property)) {
      continue;
    }

    const name = propertyName(property.name);
    props.set(name, property.initializer);
  }

  return props;
}

function propertyName(name) {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) {
    return name.text;
  }

  throw new Error(`Unsupported property name syntax: ${name.getText()}`);
}

function getRequired(props, name, index) {
  const value = props.get(name);
  if (!value) {
    throw new Error(`Missing property '${name}' in tile ${index}.`);
  }
  return value;
}

function literalString(node, sourceFile) {
  const value = unwrapExpression(node);
  if (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value)) {
    return value.text;
  }
  throw new Error(`Expected string literal, got: ${value.getText(sourceFile)}`);
}

function literalNumber(node, sourceFile) {
  const value = unwrapExpression(node);

  if (ts.isNumericLiteral(value)) {
    return Number(value.text);
  }

  if (ts.isPrefixUnaryExpression(value) && value.operator === ts.SyntaxKind.MinusToken) {
    return -literalNumber(value.operand, sourceFile);
  }

  throw new Error(`Expected numeric literal, got: ${value.getText(sourceFile)}`);
}

function literalBoolean(node, sourceFile) {
  const value = unwrapExpression(node);
  if (value.kind === ts.SyntaxKind.TrueKeyword) {
    return true;
  }
  if (value.kind === ts.SyntaxKind.FalseKeyword) {
    return false;
  }
  throw new Error(`Expected boolean literal, got: ${value.getText(sourceFile)}`);
}

function literalStringArray(node, sourceFile) {
  const value = unwrapExpression(node);
  if (!ts.isArrayLiteralExpression(value)) {
    throw new Error(`Expected string array literal, got: ${value.getText(sourceFile)}`);
  }

  return value.elements.map((element) => literalString(element, sourceFile));
}

function unwrapExpression(node) {
  let current = node;

  while (
    current
    && (ts.isAsExpression(current) || ts.isParenthesizedExpression(current))
  ) {
    current = current.expression;
  }

  return current;
}

function parseRustTiles(filePath) {
  const sourceText = readFileSync(filePath, "utf8");
  const highEdgeConstants = parseHighEdgeConstants(sourceText);
  return sourceText
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("tile("))
    .map((line) => {
      const normalizedLine = line.endsWith(",") ? line.slice(0, -1) : line;
      const { content } = extractDelimited(normalizedLine, normalizedLine.indexOf("("), "(", ")");
      const args = splitTopLevel(content);
      if (args.length !== 7) {
        throw new Error(`Expected 7 arguments for Rust tile definition, got ${args.length}.`);
      }

      return {
        name: parseRustString(args[0]),
        mesh: parseRustString(args[1]),
        edges: parseRustEdges(args[2]),
        weight: Number(args[3]),
        preventChaining: parseRustBoolean(args[4]),
        highEdges: parseRustHighEdges(args[5], highEdgeConstants),
        levelIncrement: Number(args[6]),
      };
    });
}

function parseHighEdgeConstants(sourceText) {
  const constants = new Map();
  const regex = /const\s+(\w+):\s*&\[usize\]\s*=\s*&\[(.*?)\];/g;

  for (const match of sourceText.matchAll(regex)) {
    const [, name, values] = match;
    const directions = values
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)
      .map((value) => DIRECTION_ORDER[Number(value)]);
    constants.set(name, directions);
  }

  return constants;
}

function parseRustEdges(sourceText) {
  const trimmed = sourceText.trim();
  const { content } = extractDelimited(trimmed, trimmed.indexOf("["), "[", "]");
  return splitTopLevel(content).map((edge) => {
    const normalized = RUST_EDGE_TYPES[edge.trim()];
    if (!normalized) {
      throw new Error(`Unknown Rust edge type: ${edge}`);
    }
    return normalized;
  });
}

function parseRustHighEdges(sourceText, constants) {
  const trimmed = sourceText.trim();
  if (trimmed === "None") {
    return null;
  }

  const match = /^Some\((\w+)\)$/.exec(trimmed);
  if (!match) {
    throw new Error(`Unsupported high edge expression: ${trimmed}`);
  }

  const value = constants.get(match[1]);
  if (!value) {
    throw new Error(`Unknown high edge constant: ${match[1]}`);
  }

  return value;
}

function parseRustString(sourceText) {
  const match = /^"(.*)"$/.exec(sourceText.trim());
  if (!match) {
    throw new Error(`Expected Rust string literal, got: ${sourceText}`);
  }
  return match[1];
}

function parseRustBoolean(sourceText) {
  const trimmed = sourceText.trim();
  if (trimmed === "true") {
    return true;
  }
  if (trimmed === "false") {
    return false;
  }
  throw new Error(`Expected Rust boolean literal, got: ${sourceText}`);
}

function extractDelimited(sourceText, openIndex, openChar, closeChar) {
  if (sourceText[openIndex] !== openChar) {
    throw new Error(`Expected '${openChar}' at index ${openIndex}.`);
  }

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = openIndex; index < sourceText.length; index += 1) {
    const char = sourceText[index];

    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
      continue;
    }

    if (char === openChar) {
      depth += 1;
      continue;
    }

    if (char === closeChar) {
      depth -= 1;
      if (depth === 0) {
        return {
          content: sourceText.slice(openIndex + 1, index),
          end: index,
        };
      }
    }
  }

  throw new Error(`Unterminated delimiter '${openChar}${closeChar}'.`);
}

function splitTopLevel(sourceText) {
  const parts = [];
  let parenDepth = 0;
  let bracketDepth = 0;
  let braceDepth = 0;
  let inString = false;
  let escaped = false;
  let start = 0;

  for (let index = 0; index < sourceText.length; index += 1) {
    const char = sourceText[index];

    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
      continue;
    }

    if (char === "(") {
      parenDepth += 1;
      continue;
    }
    if (char === ")") {
      parenDepth -= 1;
      continue;
    }
    if (char === "[") {
      bracketDepth += 1;
      continue;
    }
    if (char === "]") {
      bracketDepth -= 1;
      continue;
    }
    if (char === "{") {
      braceDepth += 1;
      continue;
    }
    if (char === "}") {
      braceDepth -= 1;
      continue;
    }

    if (
      char === ","
      && parenDepth === 0
      && bracketDepth === 0
      && braceDepth === 0
    ) {
      parts.push(sourceText.slice(start, index).trim());
      start = index + 1;
    }
  }

  const tail = sourceText.slice(start).trim();
  if (tail) {
    parts.push(tail);
  }

  return parts;
}
