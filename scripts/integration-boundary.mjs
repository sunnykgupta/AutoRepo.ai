import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import Ajv2020 from 'ajv/dist/2020.js';

const NOTICE = 'NON-CANONICAL — FAKE — NO DESTINATION WRITE';
const JSON_SCHEMA_URL = 'https://json-schema.org/draft/2020-12/schema';
const EXPECTED_INTEGRATION_PATHS = new Set([
  'integrations/confluence/README.md',
  'integrations/confluence/fixtures/work-item.json',
  'integrations/fakes/atlassian-fakes.mjs',
  'integrations/fakes/fixture.schema.json',
  'integrations/jira/README.md',
  'integrations/jira/fixtures/work-item.json',
  'scripts/integrations/validate.mjs',
  'scripts/integrations/runtime-transport-denial.mjs',
]);
const APPROVED_EXECUTABLE_SURFACES = new Set([
  '.github/scripts/generate-codeowners.mjs',
  'integrations/fakes/atlassian-fakes.mjs',
  'scripts/governance/validate.mjs',
  'scripts/integrations/runtime-transport-denial.mjs',
  'scripts/integrations/validate.mjs',
  'tests/g1-validation.test.mjs',
]);
const HARNESS_PATH = 'scripts/integrations/runtime-transport-denial.mjs';
const PROVIDER_INDICATOR = /jira|confluence|atlassian|adapter|integration|provider/iu;
const REPOSITORY_SCAN_EXEMPT_PATHS = new Set([
  HARNESS_PATH,
  'scripts/integration-boundary.mjs',
  'tests/governance.test.mjs',
]);
const CODE_EXTENSIONS = new Set([
  '.cjs',
  '.js',
  '.jsx',
  '.mjs',
  '.ts',
  '.tsx',
  '.py',
  '.rb',
  '.php',
  '.java',
  '.go',
  '.rs',
  '.sh',
  '.bash',
  '.zsh',
  '.ps1',
]);
const ALLOWED_EXTENSIONS = new Map([
  ['integrations', new Set(['.json', '.md', '.mjs'])],
  ['scripts/integrations', new Set(['.mjs'])],
]);
const FORBIDDEN_DEPENDENCY = /(?:^|[/@-])(?:atlassian|jira|confluence|forge|axios|got|undici|fetch|superagent|request|octokit|ky|needle|bent|phin|wreck|ws)(?:$|[/@-])/iu;
const CODE_RULES = [
  {
    name: 'network transport import',
    pattern: /(?:from\s*|import\s*\(|require\s*\()\s*['"](?:node:)?(?:http|https|http2|net|tls|dgram|dns|undici|ws|axios|got|node-fetch|@?atlassian|jira|confluence)/u,
  },
  {
    name: 'network transport call',
    pattern: /\b(?:fetch|WebSocket|XMLHttpRequest|EventSource)\s*\(/u,
  },
  {
    name: 'child process surface',
    pattern: /(?:node:child_process|\b(?:spawn|spawnSync|exec|execSync|execFile|execFileSync|fork)\s*\()/u,
  },
  {
    name: 'credential input surface',
    pattern: /\bprocess\.env\b|\b(?:token|credential|secret|apiKey|api_key|authToken|auth_token|accessToken|access_token)\s*[),:=]/iu,
  },
  {
    name: 'provider destination or URL surface',
    pattern: /https?:\/\/|\b(?:destination|remote)(?:Id|ID|_id|Url|URL|_url|Map|Mapping|_map|_mapping)\b/u,
  },
  {
    name: 'live apply or publication surface',
    pattern: /\b(?:function\s+)?(?:apply|publish|deploy|reverseSync|reverse_sync)\s*(?:\(|=|:)/u,
  },
];
const MARKDOWN_RULES = [
  {
    name: 'credential configuration surface',
    pattern: /(?:--(?:token|credential|secret|api[-_]?key)\b|(?:token|credential|secret|api[-_]?key|access[-_]?token|auth[-_]?token)\s*[:=])/iu,
  },
  {
    name: 'provider URL surface',
    pattern: /https?:\/\//iu,
  },
  {
    name: 'destination configuration surface',
    pattern: /(?:destination|remote|endpoint|base)[-_ ]?(?:url|id|map|mapping)\s*[:=]/iu,
  },
  {
    name: 'live delivery command',
    pattern: /(?:\bnpm\s+(?:run\s+)?(?:apply|publish|deploy)\b|(?:^|\n)\s*(?:run\s*:\s*)?(?:apply|publish|deploy|reverse[-_ ]?sync)\b|`[^`]*(?:apply|publish|deploy|reverse[-_ ]?sync)[^`]*`)/iu,
  },
];
const WORKFLOW_RULES = [
  { name: 'network command', pattern: /\b(?:curl|wget|nc|telnet)\b/iu },
  { name: 'child process surface', pattern: /node:child_process|\b(?:spawn|exec|execFile|fork)\s*\(/u },
  { name: 'credential input', pattern: /\bsecrets\.|\b(?:ATLASSIAN|JIRA|CONFLUENCE)_[A-Z0-9_]*(?:TOKEN|SECRET|KEY|URL)\b/u },
  { name: 'credential field', pattern: /^\s*(?:token|credential|secret|api[-_]?key|access[-_]?token)\s*:/imu },
  { name: 'destination field', pattern: /^\s*(?:destination|endpoint|remote|base)[-_]?(?:url|id|map|mapping)\s*:/imu },
  { name: 'live delivery command', pattern: /^\s*(?:-\s*)?run\s*:\s*(?:[>|-]\s*)?[^\n]*(?:apply|publish|deploy|reverse[-_: ]?sync)\b/imu },
  { name: 'provider URL', pattern: /https?:\/\//iu },
  { name: 'provider action', pattern: /\buses:\s*[^\s]*(?:atlassian|jira|confluence)[^\s]*/iu },
];

function walk(root, directory, errors) {
  const absolute = join(root, directory);
  const files = [];
  for (const entry of readdirSync(absolute, { withFileTypes: true })) {
    const path = join(absolute, entry.name);
    const relativePath = relative(root, path);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) {
      errors.push(`${relativePath}: symlinks are forbidden in the integration boundary`);
      continue;
    }
    if (stat.isDirectory()) {
      files.push(...walk(root, relativePath, errors));
      continue;
    }
    if (!stat.isFile()) {
      errors.push(`${relativePath}: only regular files are allowed in the integration boundary`);
      continue;
    }
    files.push(path);
  }
  return files;
}

function validateFileTypes(root, directory, files, errors) {
  const allowed = ALLOWED_EXTENSIONS.get(directory);
  for (const file of files) {
    const path = relative(root, file);
    const extension = extname(file);
    if (!allowed.has(extension)) {
      const executable = CODE_EXTENSIONS.has(extension) || (lstatSync(file).mode & 0o111) !== 0;
      errors.push(
        `${path}: ${executable ? 'executable code extension' : 'unknown file extension'} is not allowed`,
      );
    }
  }
}

function validateExpectedPaths(root, files, errors) {
  const actual = new Set(files.map((file) => relative(root, file)));
  for (const path of EXPECTED_INTEGRATION_PATHS) {
    if (!actual.has(path)) errors.push(`${path}: expected integration boundary file is missing`);
  }
  for (const path of actual) {
    if (!EXPECTED_INTEGRATION_PATHS.has(path)) {
      errors.push(`${path}: unexpected file in the closed integration boundary`);
    }
  }
}

function validateCode(root, files, errors) {
  for (const file of files.filter((path) => extname(path) === '.mjs')) {
    if (relative(root, file) === HARNESS_PATH) continue;
    const text = readFileSync(file, 'utf8');
    for (const rule of CODE_RULES) {
      if (rule.pattern.test(text)) errors.push(`${relative(root, file)}: forbidden ${rule.name}`);
    }
  }
}

function repositoryFiles(root, directory = root) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (
      directory === root &&
      [
        '.git',
        'node_modules',
        'coverage',
        '.tmp',
        'tmp',
        '.generated_artifacts',
        '.uploaded_artifacts',
      ].includes(entry.name)
    ) {
      continue;
    }
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) files.push(...repositoryFiles(root, path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

function validateRepositorySurfaces(root, errors) {
  const executable = repositoryFiles(root).filter((file) => CODE_EXTENSIONS.has(extname(file)));
  for (const file of executable) {
    const path = relative(root, file);
    if (REPOSITORY_SCAN_EXEMPT_PATHS.has(path)) continue;
    const text = readFileSync(file, 'utf8');
    const indicatedByPath = PROVIDER_INDICATOR.test(path);
    const indicatedByContent = PROVIDER_INDICATOR.test(text);
    if ((indicatedByPath || indicatedByContent) && !APPROVED_EXECUTABLE_SURFACES.has(path)) {
      errors.push(`${path}: unapproved repository executable integration/provider surface`);
    }
    if (indicatedByPath || indicatedByContent) {
      for (const rule of CODE_RULES) {
        if (rule.pattern.test(text)) errors.push(`${path}: forbidden ${rule.name}`);
      }
    }
  }
}

function validateJsonValue(value, path, errors, location = '$') {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => validateJsonValue(entry, path, errors, `${location}[${index}]`));
    return;
  }
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'string' && value !== JSON_SCHEMA_URL && /https?:\/\//iu.test(value)) {
      errors.push(`${path}: forbidden provider URL surface at ${location}`);
    }
    if (typeof value === 'string' && /\bprocess\.env\b|\$\{\{\s*secrets\./u.test(value)) {
      errors.push(`${path}: forbidden credential input at ${location}`);
    }
    return;
  }
  for (const [key, entry] of Object.entries(value)) {
    const normalized = key.toLowerCase().replaceAll(/[-_]/gu, '');
    const entryLocation = `${location}.${key}`;
    if (
      /^(?:token|credential|secret|apikey|accesstoken|authtoken)$/u.test(normalized) ||
      /(?:token|credential|secret|apikey)$/u.test(normalized)
    ) {
      errors.push(`${path}: forbidden credential key at ${entryLocation}`);
    }
    if (/^(?:url|endpoint|baseurl|destinationurl|destinationid|remoteurl|remoteid|destinationmap|remotemap)$/u.test(normalized)) {
      errors.push(`${path}: forbidden provider destination key at ${entryLocation}`);
    }
    if (/^(?:apply|publish|deploy|reversesync)$/u.test(normalized)) {
      errors.push(`${path}: forbidden live delivery key at ${entryLocation}`);
    }
    if (
      /^(?:command|script|run|action)$/u.test(normalized) &&
      typeof entry === 'string' &&
      /\b(?:apply|publish|deploy|reverse[-_ ]?sync)\b/iu.test(entry)
    ) {
      errors.push(`${path}: forbidden live delivery command at ${entryLocation}`);
    }
    validateJsonValue(entry, path, errors, entryLocation);
  }
}

function validateTextFiles(root, files, errors) {
  for (const file of files) {
    const path = relative(root, file);
    const extension = extname(file);
    const text = readFileSync(file, 'utf8');
    if (extension === '.json') {
      let value;
      try {
        value = JSON.parse(text);
      } catch {
        errors.push(`${path}: JSON text must parse before boundary inspection`);
        continue;
      }
      validateJsonValue(value, path, errors);
    }
    if (extension === '.md') {
      const semanticText = text.replaceAll(NOTICE, '');
      for (const rule of MARKDOWN_RULES) {
        if (rule.pattern.test(semanticText)) errors.push(`${path}: forbidden ${rule.name}`);
      }
    }
  }
}

function allWorkflows(root, errors) {
  const directory = join(root, '.github/workflows');
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        errors.push(`${relative(root, path)}: workflow symlinks are forbidden`);
        return [];
      }
      if (!entry.isFile() || !['.yml', '.yaml'].includes(extname(entry.name))) return [];
      return [path];
    });
}

function validateWorkflows(root, errors) {
  for (const file of allWorkflows(root, errors)) {
    const text = readFileSync(file, 'utf8');
    for (const rule of WORKFLOW_RULES) {
      if (rule.pattern.test(text)) errors.push(`${relative(root, file)}: forbidden ${rule.name}`);
    }
  }
}

function validatePackageManifest(root, manifestPath, errors) {
  const packageJson = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const path = relative(root, manifestPath);
  const scripts = packageJson.scripts ?? {};
  for (const [name, command] of Object.entries(scripts)) {
    if (/\b(?:apply|publish|deploy|reverse[-_:]?sync)\b/iu.test(name) || /\b(?:apply|publish|deploy|reverse[-_:]?sync)\b/iu.test(command)) {
      errors.push(`${path}: forbidden live/apply script ${name}`);
    }
    const invokedSources = command.match(/[A-Za-z0-9_./-]+\.(?:cjs|js|jsx|mjs|ts|tsx|py|rb|php|java|go|rs|sh|bash|zsh|ps1)\b/gu) ?? [];
    const unapprovedInvokedSource = invokedSources.find(
      (source) =>
        PROVIDER_INDICATOR.test(source) &&
        !APPROVED_EXECUTABLE_SURFACES.has(source) &&
        !REPOSITORY_SCAN_EXEMPT_PATHS.has(source),
    );
    if (unapprovedInvokedSource) {
      errors.push(`${path}: unapproved package script integration/provider surface ${name}`);
      for (const rule of CODE_RULES) {
        if (rule.pattern.test(command)) errors.push(`${path}: forbidden ${rule.name} in script ${name}`);
      }
    }
  }
  const direct = Object.keys(packageJson.dependencies ?? {});
  const development = Object.keys(packageJson.devDependencies ?? {});
  for (const dependency of new Set([...direct, ...development])) {
    if (FORBIDDEN_DEPENDENCY.test(dependency)) {
      errors.push(`${path}: dependency ${dependency} is a forbidden network/Atlassian/live client`);
    }
  }
}

function validatePackages(root, errors) {
  const manifests = repositoryFiles(root).filter((file) => file.endsWith('/package.json'));
  for (const manifest of manifests) validatePackageManifest(root, manifest, errors);
  const rootPackage = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const packageLock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
  const direct = Object.keys(rootPackage.dependencies ?? {}).sort();
  const lockedDirect = Object.keys(packageLock.packages?.['']?.dependencies ?? {}).sort();
  if (JSON.stringify(direct) !== JSON.stringify(lockedDirect)) {
    errors.push('package-lock.json: root direct dependencies differ from package.json');
  }
  for (const dependency of lockedDirect) {
    if (FORBIDDEN_DEPENDENCY.test(dependency)) {
      errors.push(`package-lock.json: forbidden root network/Atlassian dependency ${dependency}`);
    }
  }
  const nestedLocks = repositoryFiles(root).filter(
    (file) => file.endsWith('/package-lock.json') && file !== join(root, 'package-lock.json'),
  );
  for (const lockPath of nestedLocks) {
    const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
    const path = relative(root, lockPath);
    for (const dependency of Object.keys(lock.packages?.['']?.dependencies ?? {})) {
      if (FORBIDDEN_DEPENDENCY.test(dependency)) {
        errors.push(`${path}: forbidden root network/Atlassian dependency ${dependency}`);
      }
    }
  }
}

function validateFixtures(root, fakeModule, errors) {
  const schemaPath = join(root, 'integrations/fakes/fixture.schema.json');
  const schema = JSON.parse(readFileSync(schemaPath, 'utf8'));
  const validate = new Ajv2020({ allErrors: true, strict: false }).compile(schema);
  const fixturePaths = [
    'integrations/jira/fixtures/work-item.json',
    'integrations/confluence/fixtures/work-item.json',
  ];
  for (const path of fixturePaths) {
    const fixture = JSON.parse(readFileSync(join(root, path), 'utf8'));
    if (!validate(fixture)) errors.push(`${path}: synthetic fixture fails the closed schema`);
    if (fixture.synthetic !== true || fixture.canonical !== false || fixture.notice !== NOTICE) {
      errors.push(`${path}: fixture synthetic/canonical/notice boundary is not exact`);
    }
  }
  const fakeText = readFileSync(fakeModule, 'utf8');
  if (/fixtures?\//iu.test(fakeText) || /\bFAKE-[0-9]+\b/u.test(fakeText)) {
    errors.push('integrations/fakes/atlassian-fakes.mjs: fake module may not import fixtures or default IDs');
  }
}

export function validateIntegrationBoundary(root = resolve('.')) {
  const errors = [];
  const integrationFiles = walk(root, 'integrations', errors);
  const scriptFiles = walk(root, 'scripts/integrations', errors);
  validateFileTypes(root, 'integrations', integrationFiles, errors);
  validateFileTypes(root, 'scripts/integrations', scriptFiles, errors);
  const boundaryFiles = [...integrationFiles, ...scriptFiles];
  validateExpectedPaths(root, boundaryFiles, errors);
  validateCode(root, boundaryFiles, errors);
  validateTextFiles(root, boundaryFiles, errors);
  validateWorkflows(root, errors);
  validateRepositorySurfaces(root, errors);
  validatePackages(root, errors);
  validateFixtures(root, join(root, 'integrations/fakes/atlassian-fakes.mjs'), errors);
  return errors;
}

export function runRuntimeTransportDenialHarness(root = resolve('.')) {
  const result = spawnSync(process.execPath, [join(root, HARNESS_PATH)], {
    cwd: root,
    encoding: 'utf8',
  });
  return {
    status: result.status,
    output: `${result.stdout}${result.stderr}`,
  };
}

export function runtimeBoundaryDescription() {
  return process.allowedNodeEnvironmentFlags.has('--allow-net')
    ? 'Node permission-model network denial is available.'
    : 'Transport-surface absence verified; this Node permission model has no network-denial flag.';
}
