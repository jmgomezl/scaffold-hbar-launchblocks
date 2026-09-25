// In a project scaffolded with npm, check the commands the docs and workflows
// show. The CLI rewrites every `yarn <word>` to `npm run <word>`, so a command
// can come out naming a script that does not exist, or with a flag npm keeps
// for itself instead of passing it on (it needs a `--` first).
//
//   node .github/scripts/check-npm-commands.mjs [project dir]
//
// Prints one line per problem and exits 1 if there are any.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const dir = path.resolve(process.argv[2] ?? ".");
const json = file => JSON.parse(readFileSync(path.join(dir, file), "utf8"));

const rootScripts = json("package.json").scripts ?? {};
const workspaceScripts = name => {
  const file = `packages/${name.replace(/^@sh\//, "")}/package.json`;
  return existsSync(path.join(dir, file)) ? (json(file).scripts ?? {}) : {};
};

const workflows = existsSync(path.join(dir, ".github/workflows"))
  ? readdirSync(path.join(dir, ".github/workflows")).map(file => `.github/workflows/${file}`)
  : [];
const files = ["README.md", "AGENTS.md", "packages/hardhat/README.md", ...workflows].filter(file =>
  existsSync(path.join(dir, file)),
);

// `npm run <script>` and its arguments, up to the end of the inline code, the line, or the next command.
const COMMAND = /npm run ([\w:-]+)((?: (?!&&|\|\||\||;)[^\s`]+)*)/g;

const problems = [];
for (const file of files) {
  readFileSync(path.join(dir, file), "utf8")
    .split("\n")
    .forEach((line, index) => {
      for (const [command, script, rest] of line.matchAll(COMMAND)) {
        const where = `${file}:${index + 1}`;
        const args = rest.trim() ? rest.trim().split(" ") : [];
        const workspace = args[args.indexOf("-w") + 1];
        const scripts = args.includes("-w") ? workspaceScripts(workspace) : rootScripts;
        if (!(script in scripts)) {
          problems.push(`${where}: "${command}" names no script${args.includes("-w") ? ` in ${workspace}` : ""}`);
        }
        const beforeDashes = args.includes("--") ? args.slice(0, args.indexOf("--")) : args;
        const kept = beforeDashes.filter(arg => arg.startsWith("-") && arg !== "-w");
        if (kept.length) problems.push(`${where}: "${command}" gives npm ${kept.join(" ")}, not the script`);
      }
    });
}

for (const problem of problems) console.log(problem);
console.log(`${files.length} files, ${problems.length} problem${problems.length === 1 ? "" : "s"}`);
process.exit(problems.length ? 1 : 0);
