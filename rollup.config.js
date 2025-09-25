import resolve from "@rollup/plugin-node-resolve";
import commonjs from "@rollup/plugin-commonjs";
import typescript from "@rollup/plugin-typescript";
import { readFileSync } from "fs";

// Read package.json
const pkg = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8")
);

export default [
  // UMD build for browsers (minified) - for direct script tag usage
  {
    input: "src/index.ts",
    output: {
      name: "LayercodeClient",
      file: pkg.browser,
      format: "umd",
      sourcemap: true,
      globals: {},
    },
    context: "window",
    plugins: [
      resolve({
        browser: true,
        extensions: [".js", ".ts"],
      }),
      commonjs(),
      typescript({
        tsconfig: "./tsconfig.json",
        sourceMap: true,
        inlineSources: true,
      }),
    ],
  },
  // ESM build for modern browsers and frameworks
  {
    input: "src/index.ts",
    output: {
      file: pkg.module || pkg.main,
      format: "esm",
      sourcemap: true,
    },
    plugins: [
      resolve({
        browser: true,
        extensions: [".js", ".ts"],
      }),
      commonjs(),
      typescript({
        tsconfig: "./tsconfig.json",
        sourceMap: true,
        inlineSources: true,
        declaration: true,
        declarationDir: "./dist/types",
      }),
    ],
  },
];
