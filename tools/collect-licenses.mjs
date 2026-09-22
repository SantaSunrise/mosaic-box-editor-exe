import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.resolve(process.argv[2] || ".cache/dependency-licenses");
fs.mkdirSync(output, { recursive: true });
const index = [];

function collect(name, version, license, directory, source, licenseFile) {
  const destination = path.join(
    output,
    `${name.replaceAll("/", "_")}-${version}`,
  );
  fs.mkdirSync(destination, { recursive: true });
  const files = fs
    .readdirSync(directory)
    .filter((file) => /^(licen[sc]e|copying|notice)([._-]|$)/i.test(file));
  if (licenseFile && !files.includes(licenseFile)) files.push(licenseFile);
  const copied = [];
  for (const file of files) {
    const sourcePath = path.resolve(directory, file);
    if (!fs.statSync(sourcePath).isFile()) continue;
    const name = path.basename(file);
    fs.copyFileSync(sourcePath, path.join(destination, name));
    copied.push(name);
  }
  index.push({ name, version, license, source, notices: copied });
}

const visited = new Set();
function collectNode(name, from) {
  const require = createRequire(path.join(from, "package.json"));
  let manifest;
  try {
    manifest = require.resolve(`${name}/package.json`);
  } catch {
    let directory = path.dirname(require.resolve(name));
    while (!fs.existsSync(path.join(directory, "package.json"))) {
      const parent = path.dirname(directory);
      if (parent === directory) throw Error(`Cannot find manifest for ${name}`);
      directory = parent;
    }
    manifest = path.join(directory, "package.json");
  }
  const directory = path.dirname(manifest);
  if (visited.has(directory)) return;
  visited.add(directory);
  const pkg = JSON.parse(fs.readFileSync(manifest, "utf8"));
  collect(
    pkg.name,
    pkg.version,
    pkg.license,
    directory,
    `https://www.npmjs.com/package/${pkg.name}/v/${pkg.version}`,
  );
  for (const dependency of Object.keys(pkg.dependencies || {}))
    collectNode(dependency, directory);
}
const pkg = JSON.parse(
  fs.readFileSync(path.join(root, "package.json"), "utf8"),
);
for (const dependency of Object.keys(pkg.dependencies))
  collectNode(dependency, root);

const metadata = JSON.parse(
  execFileSync(
    "cargo",
    [
      "metadata",
      "--locked",
      "--format-version",
      "1",
      "--manifest-path",
      path.join(root, "src-tauri/Cargo.toml"),
    ],
    { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
  ),
);
for (const pkg of metadata.packages) {
  if (!pkg.source) continue;
  collect(
    pkg.name,
    pkg.version,
    pkg.license,
    path.dirname(pkg.manifest_path),
    pkg.repository || pkg.source,
    pkg.license_file,
  );
}
index.sort(
  (a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version),
);
fs.writeFileSync(
  path.join(output, "index.json"),
  JSON.stringify(index, null, 2) + "\n",
);
console.log(`Collected notices for ${index.length} dependency packages.`);
