// Fallback ESLint flat config used when the target app doesn't ship its own.
// Deliberately conservative: catches real bugs (undefined vars, unreachable
// code, unused vars) without imposing a style opinion the target app didn't ask for.
export default [
  {
    ignores: ["node_modules/**", "dist/**", "build/**", "coverage/**", "sentinel-runs/**"],
  },
  {
    files: ["**/*.js", "**/*.mjs", "**/*.cjs"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "commonjs",
      globals: {
        require: "readonly",
        module: "readonly",
        exports: "writable",
        process: "readonly",
        console: "readonly",
        __dirname: "readonly",
        __filename: "readonly",
        Buffer: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
      },
    },
    rules: {
      "no-undef": "error",
      "no-unused-vars": ["warn", { args: "none" }],
      "no-unreachable": "error",
      "no-dupe-keys": "error",
      "no-dupe-args": "error",
      "no-const-assign": "error",
      "no-dupe-class-members": "error",
      "no-fallthrough": "error",
      "no-irregular-whitespace": "error",
      "valid-typeof": "error",
      "no-compare-neg-zero": "error",
      "no-cond-assign": "error",
      "use-isnan": "error",
    },
  },
  {
    // Jest's globals are injected by the test runner, not `require`d — declare
    // them here rather than flagging every test file as broken.
    files: [
      "**/*.test.js",
      "**/*.spec.js",
      "tests/**/*.js",
      "test/**/*.js",
      "__tests__/**/*.js",
    ],
    languageOptions: {
      globals: {
        describe: "readonly",
        it: "readonly",
        test: "readonly",
        expect: "readonly",
        beforeAll: "readonly",
        beforeEach: "readonly",
        afterAll: "readonly",
        afterEach: "readonly",
        jest: "readonly",
      },
    },
  },
];
