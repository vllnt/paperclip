// Test loader for the skill-injecting harness.
//
// Reads every ../tests/*.yaml unchanged and fixes one input-plumbing gap: ten tests carry
// their scenario in a test-level `prompt:` key, which promptfoo does not pass to the model.
// This loader copies that text into vars.scenario so the harness shows it. The test files and
// their assertions stay as they are, so the legacy config keeps its original behavior.

const fs = require("node:fs");
const path = require("node:path");
const { createRequire } = require("node:module");

function loadYamlParser() {
  // Runs inside the promptfoo process, so resolve js-yaml next to promptfoo's own entrypoint.
  const entry = fs.realpathSync(process.argv[1]);
  return createRequire(entry)("js-yaml");
}

module.exports = function loadTests() {
  const yaml = loadYamlParser();
  const testsDir = path.resolve(__dirname, "../tests");
  return fs
    .readdirSync(testsDir)
    .filter((name) => name.endsWith(".yaml"))
    .sort()
    .flatMap((name) => yaml.load(fs.readFileSync(path.join(testsDir, name), "utf8")))
    .map(({ prompt, ...test }) => {
      if (!prompt) return test;
      const vars = test.vars ?? {};
      return { ...test, vars: vars.scenario ? vars : { ...vars, scenario: prompt } };
    });
};
