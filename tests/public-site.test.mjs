import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import test from 'node:test';

const root = process.cwd();
const siteOutput = join(root, 'site', 'dist', 'index.html');

function escapeHtml(value) {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function buildSite() {
  const result = spawnSync('npm', ['run', 'site:build'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, PUBLIC_BASE_PATH: '/' },
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.ok(existsSync(siteOutput), 'Astro must emit the static index page.');
  return readFileSync(siteOutput, 'utf8');
}

test('builds a root-path learning experience for the custom domain', () => {
  const html = buildSite();
  assert.match(html, /Make repositories that keep moving/);
  for (const step of ['Understand', 'Plan', 'Build', 'Verify', 'Review', 'Learn', 'Continue']) {
    assert.match(html, new RegExp(`>${step}<`));
  }
  assert.match(html, /href="\/"/);
  assert.match(html, /OPEN-SOURCE GUIDE FOR SELF-SUSTAINING REPOSITORIES/);
  assert.match(html, /OPEN SOURCE · MIT LICENSE/);
  assert.doesNotMatch(html, /custom domain/i);
  assert.doesNotMatch(html, /project status/i);
  assert.doesNotMatch(html, /not a live/i);
  assert.doesNotMatch(html, /no accounts|hosted control plane/i);
  assert.match(html, /href="\/favicon\.svg"/);
  assert.doesNotMatch(html, /(?:href|src)="\/AutoRepo\.ai\//);
  assert.equal(readFileSync(join(root, 'site/public/CNAME'), 'utf8'), 'autorepo.ai\n');
  assert.ok(existsSync(join(root, 'site', 'dist', 'favicon.svg')), 'Astro must emit the project favicon.');
  assert.match(readFileSync(join(root, 'site/astro.config.mjs'), 'utf8'), /site: 'https:\/\/autorepo\.ai'/);
});

test('ships copyable template controls and versioned source templates', () => {
  const html = buildSite();
  const pageSource = readFileSync(join(root, 'site', 'src', 'pages', 'index.astro'), 'utf8');
  assert.match(pageSource, /const templateCards = \[/);
  assert.match(pageSource, /templateCards\.map/);
  assert.doesNotMatch(pageSource, /const (?:goal|work|decision|agent)Template/);
  assert.equal([...pageSource.matchAll(/class="template-card"/g)].length, 1);
  for (const template of ['GOAL', 'WORK', 'DECISION', 'AGENTS']) {
    const templatePath = join(root, 'templates', `${template}.md`);
    assert.ok(existsSync(templatePath), `${template} template must be present in the repository.`);
    const content = readFileSync(templatePath, 'utf8');
    assert.match(content, /^# /);
    assert.ok(html.includes(escapeHtml(content.trimEnd())), `${template} source must be rendered in the static site.`);
  }
  assert.match(html, /data-copy-target="goal-template"/);
  assert.match(html, /data-copy-target="agent-template"/);
  assert.match(html, /navigator\.clipboard\.writeText/);
});

test('keeps the public guide, templates, and first-loop example aligned on autonomy boundaries', () => {
  const approvalBoundary = /routine, reversible preview or staging deployments may continue when repository policy explicitly permits them/i;
  const humanApprovalBoundary = /production or public release, an irreversible or destructive action, an access or credential change, spending, a legal or security posture change, or an unclear material trade-off/i;
  const readme = readFileSync(join(root, 'README.md'), 'utf8');
  const agentInstructions = readFileSync(join(root, 'templates', 'AGENTS.md'), 'utf8');
  const html = buildSite();

  assert.match(readme, /https:\/\/autorepo\.ai\//);
  assert.match(readme, approvalBoundary);
  assert.match(readme, humanApprovalBoundary);
  assert.match(agentInstructions, approvalBoundary);
  assert.match(agentInstructions, humanApprovalBoundary);
  assert.match(html, approvalBoundary);
  assert.match(html, /Production or public releases, destructive actions, access or credential changes, spending, and legal or security posture changes require explicit human approval/i);

  for (const file of ['GOAL.md', 'WORK.md', 'DECISION.md', 'AGENTS.md']) {
    assert.ok(existsSync(join(root, 'examples', 'first-loop', file)), `${file} must be available in the first-loop example.`);
  }
});

test('uses audience starting points rather than a role-based curriculum', () => {
  const html = buildSite();
  assert.match(html, /Three prompts for the work in front of you/);
  assert.match(html, /They are not a role curriculum or a prescribed sequence/);
  assert.doesNotMatch(html, /Product leader|Engineer|Maintainer|PATH 0|>Pathways</);
});

test('keeps local serving private and scopes the shared preview host allowance', () => {
  const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const astroConfig = readFileSync(join(root, 'site', 'astro.config.mjs'), 'utf8');
  assert.equal(packageJson.scripts['site:dev'], 'astro dev --root site');
  assert.match(packageJson.scripts['site:preview'], /--host 0\.0\.0\.0 --allowed-hosts \.vorflux\.com/);
  assert.doesNotMatch(astroConfig, /allowedHosts|host:/);
});

test('uses a trusted-only GitHub Pages deployment workflow with a static artifact', () => {
  const workflow = readFileSync(join(root, '.github', 'workflows', 'pages.yml'), 'utf8');
  assert.match(workflow, /branches: \[main\]/);
  assert.doesNotMatch(workflow, /pull_request/);
  assert.doesNotMatch(workflow, /workflow_dispatch/);
  assert.match(workflow, /fetch-depth: 0/);
  assert.match(workflow, /Validate the trusted revision in metadata mode/);
  assert.match(workflow, /CI=1 npm run validate/);
  assert.match(workflow, /node \.github\/scripts\/validate-github-baseline\.mjs/);
  assert.match(workflow, /node \.github\/scripts\/scan-clean-room\.mjs/);
  assert.match(workflow, /PUBLIC_BASE_PATH: \//);
  assert.match(workflow, /path: site\/dist/);
});
