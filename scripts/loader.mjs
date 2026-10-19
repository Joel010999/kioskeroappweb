import { pathToFileURL, fileURLToPath } from "node:url";
import { resolve as pathResolve, dirname } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const swc = require("next/dist/build/swc/index.js");

const rootDir = process.cwd();
const srcDir = pathResolve(rootDir, "src");

export async function resolve(specifier, context, nextResolve) {
  let resolvedSpecifier = specifier;

  if (specifier.startsWith("@/")) {
    const relativePart = specifier.slice(2);
    const candidatePath = pathResolve(srcDir, relativePart);
    for (const ext of [".ts", ".tsx", ".js", "/index.ts", "/index.js"]) {
      if (existsSync(candidatePath + ext)) {
        return nextResolve(pathToFileURL(candidatePath + ext).href, context);
      }
    }
    if (existsSync(candidatePath)) {
      return nextResolve(pathToFileURL(candidatePath).href, context);
    }
  } else if ((specifier.startsWith("./") || specifier.startsWith("../")) && context.parentURL) {
    const parentDir = dirname(fileURLToPath(context.parentURL));
    const targetPath = pathResolve(parentDir, specifier);
    for (const ext of [".ts", ".tsx", ".js", "/index.ts", "/index.js"]) {
      if (existsSync(targetPath + ext)) {
        return nextResolve(pathToFileURL(targetPath + ext).href, context);
      }
    }
  }

  return nextResolve(resolvedSpecifier, context);
}

export async function load(url, context, nextLoad) {
  if (url.endsWith(".ts") || url.endsWith(".tsx")) {
    const filePath = fileURLToPath(url);
    const rawSource = readFileSync(filePath, "utf8");
    const isTsx = url.endsWith(".tsx");
    const transformed = swc.transformSync(rawSource, {
      filename: filePath,
      jsc: {
        parser: {
          syntax: "typescript",
          tsx: isTsx,
        },
        target: "es2022",
      },
    });

    return {
      format: "module",
      shortCircuit: true,
      source: transformed.code,
    };
  }

  return nextLoad(url, context);
}
