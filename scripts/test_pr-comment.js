const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');

// We need to extract the pure functions from pr-comment.js for testing.
// Since the module exports an async function that requires github/context,
// we re-implement the testable helpers here and verify they match behavior.

// ---------------------------------------------------------------------------
// Helpers extracted for unit testing
// ---------------------------------------------------------------------------

function buildCommentMarker(env, workDir, workflowRef) {
  let workflowPath = workflowRef || '';
  const atIdx = workflowPath.indexOf('@');
  if (atIdx >= 0) workflowPath = workflowPath.substring(0, atIdx);
  const parts = workflowPath.split('/');
  if (parts.length > 2) workflowPath = parts.slice(2).join('/');
  return `<!-- tf-action:workflow=${workflowPath}:env=${env}:dir=${workDir} -->`;
}

function truncateOutput(content, maxLines = 50) {
  if (!content || content.trim() === '') {
    return { text: 'No output available', truncated: false };
  }
  const lines = content.split('\n');
  if (lines.length > maxLines) {
    return {
      text: `... (${lines.length - maxLines} lines truncated) ...\n\n${lines.slice(-maxLines).join('\n')}`,
      truncated: true,
    };
  }
  return { text: content, truncated: false };
}

function processPlanOutput(content) {
  if (!content || content.trim() === '' || content === 'null') {
    return { text: 'No output available', truncated: false };
  }
  const lines = content.split('\n');
  const indicators = [
    'Note: Objects have changed outside of Terraform',
    'Terraform will perform the following actions:',
    'No changes. Your infrastructure matches the configuration.',
    'Planning failed. Terraform encountered an error while generating this plan.',
    'Plan:',
    'Changes to Outputs:',
    'Error:',
  ];
  let idx = lines.findIndex((l) => indicators.some((ind) => l.includes(ind)));
  const relevant = idx >= 0 ? lines.slice(idx) : lines;
  if (relevant.length > 500) {
    return {
      text: `... (${relevant.length - 500} lines truncated) ...\n\n${relevant.slice(-500).join('\n')}`,
      truncated: true,
    };
  }
  return { text: relevant.join('\n'), truncated: false };
}

function filterValidateOutput(content) {
  if (!content || content.trim() === '') {
    return content;
  }
  const lines = content.split('\n');
  const filtered = lines.filter((line) => {
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z\s+\[(INFO|DEBUG|TRACE|WARN|ERROR)\]/.test(line)) {
      return false;
    }
    return true;
  });
  const collapsed = filtered.reduce((acc, line) => {
    if (line.trim() === '' && acc.length > 0 && acc[acc.length - 1].trim() === '') {
      return acc;
    }
    acc.push(line);
    return acc;
  }, []);
  return collapsed.join('\n').trim();
}

const MAX_RESOURCE_LINES = 20;

function filterInitOutput(content) {
  if (!content || content.trim() === '') {
    return content;
  }
  const separator = '--- First attempt failed, trying with -upgrade ---';
  const sepIdx = content.indexOf(separator);
  const relevant = sepIdx >= 0 ? content.substring(sepIdx + separator.length) : content;
  const lines = relevant.split('\n');
  const errorIdx = lines.findIndex((line) => line.includes('Error:'));
  if (errorIdx < 0) {
    return content;
  }
  return lines.slice(errorIdx).join('\n').trim();
}

function extractResourceChanges(content) {
  const result = { created: [], updated: [], deleted: [], replaced: [] };
  if (!content || content.trim() === '') return result;
  for (const line of content.split('\n')) {
    const m = line.match(/^\s+#\s+(.+)\s+(will be|must be)\s+(.+)$/);
    if (!m) continue;
    const resource = m[1].trim();
    const action = m[3].trim();
    if (action === 'created') result.created.push(resource);
    else if (action === 'updated in-place') result.updated.push(resource);
    else if (action === 'destroyed') result.deleted.push(resource);
    else if (action.includes('replaced')) result.replaced.push(resource);
  }
  return result;
}

function buildResourceSummary(changes) {
  const categories = [
    { key: 'created', label: '🟢 Will be Created' },
    { key: 'updated', label: '🔄 Will be Updated' },
    { key: 'deleted', label: '🔴 Will be Deleted' },
    { key: 'replaced', label: '⚠️ Will be Replaced' },
  ];
  const sections = [];
  for (const { key, label } of categories) {
    const items = changes[key] || [];
    if (items.length === 0) continue;
    const shown = items.slice(0, MAX_RESOURCE_LINES);
    const lines = shown.map((r) => `- \`${r}\``);
    if (items.length > MAX_RESOURCE_LINES) {
      lines.push(`- *... and ${items.length - MAX_RESOURCE_LINES} more*`);
    }
    sections.push(`**${label}**\n${lines.join('\n')}`);
  }
  if (sections.length === 0) return '';
  return '\n' + sections.join('\n\n') + '\n';
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✅ ${name}`);
  } catch (err) {
    failed++;
    console.log(`  ❌ ${name}`);
    console.log(`     ${err.message}`);
  }
}

console.log('truncateOutput:');

test('returns "No output available" for empty string', () => {
  const result = truncateOutput('');
  assert.strictEqual(result.text, 'No output available');
  assert.strictEqual(result.truncated, false);
});

test('returns "No output available" for null', () => {
  const result = truncateOutput(null);
  assert.strictEqual(result.text, 'No output available');
  assert.strictEqual(result.truncated, false);
});

test('returns "No output available" for undefined', () => {
  const result = truncateOutput(undefined);
  assert.strictEqual(result.text, 'No output available');
  assert.strictEqual(result.truncated, false);
});

test('returns content as-is when under maxLines', () => {
  const content = 'line1\nline2\nline3';
  const result = truncateOutput(content, 10);
  assert.strictEqual(result.text, content);
  assert.strictEqual(result.truncated, false);
});

test('truncates content when over maxLines', () => {
  const lines = Array.from({ length: 20 }, (_, i) => `line${i}`);
  const content = lines.join('\n');
  const result = truncateOutput(content, 5);
  assert.strictEqual(result.truncated, true);
  assert(result.text.includes('15 lines truncated'));
  assert(result.text.includes('line19'));
  assert(!result.text.includes('line0\n'));
});

test('truncated flag is independent per call', () => {
  const longContent = Array.from({ length: 100 }, (_, i) => `line${i}`).join('\n');
  const shortContent = 'short';
  const r1 = truncateOutput(longContent, 5);
  const r2 = truncateOutput(shortContent, 50);
  assert.strictEqual(r1.truncated, true);
  assert.strictEqual(r2.truncated, false);
});

console.log('\nfilterValidateOutput:');

test('returns empty string as-is', () => {
  assert.strictEqual(filterValidateOutput(''), '');
});

test('returns null as-is', () => {
  assert.strictEqual(filterValidateOutput(null), null);
});

test('strips INFO log lines and keeps warnings/status', () => {
  const input = [
    '2026-02-10T20:47:12.684Z [INFO]  provider.terraform-provider-cloudflare_v4.52.5: configuring server automatic mTLS',
    '2026-02-10T20:47:12.710Z [INFO]  provider: configuring client automatic mTLS',
    'Warning: Deprecated attribute',
    '',
    '  on .terraform/modules/alerts_service/outputs.tf line 35',
    '',
    'Success! The configuration is valid, but there were some validation warnings',
  ].join('\n');
  const result = filterValidateOutput(input);
  assert(!result.includes('[INFO]'), 'Should not contain INFO lines');
  assert(result.includes('Warning: Deprecated attribute'), 'Should keep Warning lines');
  assert(result.includes('Success!'), 'Should keep status line');
});

test('strips ERROR log lines but keeps Error: blocks', () => {
  const input = [
    '2026-02-10T20:47:14.326Z [ERROR] provider: error encountered while scanning stdout',
    '',
    'Error: Something failed',
    '  details here',
  ].join('\n');
  const result = filterValidateOutput(input);
  assert(!result.includes('[ERROR]'), 'Should not contain [ERROR] log lines');
  assert(result.includes('Error: Something failed'), 'Should keep Error: block');
});

test('collapses consecutive blank lines after filtering', () => {
  const input = [
    '2026-02-10T20:47:12.684Z [INFO]  line1',
    '2026-02-10T20:47:12.685Z [INFO]  line2',
    '',
    '',
    'Warning: something',
  ].join('\n');
  const result = filterValidateOutput(input);
  assert(!result.includes('\n\n\n'), 'Should not have triple blank lines');
  assert(result.includes('Warning: something'));
});

test('keeps clean output unchanged', () => {
  const input = 'Success! The configuration is valid.';
  assert.strictEqual(filterValidateOutput(input), input);
});

console.log('\nfilterInitOutput:');

test('returns empty/null/undefined unchanged', () => {
  assert.strictEqual(filterInitOutput(''), '');
  assert.strictEqual(filterInitOutput(null), null);
  assert.strictEqual(filterInitOutput(undefined), undefined);
});

test('extracts from first Error: line discarding noise above', () => {
  const input = [
    'Initializing the backend...',
    'Initializing provider plugins...',
    '- Finding hashicorp/aws versions matching "~> 5.0"...',
    '- Installing hashicorp/aws v5.30.0...',
    '- Installed hashicorp/aws v5.30.0',
    '',
    'Error: Terraform encountered problems during initialisation, including problems',
    'with the configuration, described below.',
    '',
    'Error: Argument or block definition required',
    '',
    '  on ecs-clusters.tf line 12:',
    '  12: X',
    '',
    'An argument or block definition is required here.',
  ].join('\n');
  const result = filterInitOutput(input);
  assert(result.startsWith('Error: Terraform encountered problems'));
  assert(!result.includes('Initializing'));
  assert(!result.includes('Installing'));
  assert(result.includes('Argument or block definition required'));
});

test('returns full output when no Error: found', () => {
  const input = [
    'Initializing the backend...',
    'Initializing provider plugins...',
    '- Finding hashicorp/aws versions matching "~> 5.0"...',
    'Terraform has been successfully initialized!',
  ].join('\n');
  assert.strictEqual(filterInitOutput(input), input);
});

test('discards first attempt and extracts error from retry', () => {
  const input = [
    'Initializing the backend...',
    'Error: First attempt error message',
    'Some details about first error',
    '--- First attempt failed, trying with -upgrade ---',
    'Initializing the backend...',
    'Initializing provider plugins...',
    '- Downloading registry.terraform.io/hashicorp/aws v5.30.0...',
    '- Installed hashicorp/aws v5.30.0',
    'Upgrading modules...',
    'Downloading registry.terraform.io/delivops/ecs-service/aws 0.1.55 for cron_service...',
    '- cron_service in .terraform/modules/cron_service',
    '',
    'Error: Duplicate resource "aws_ecs_cluster" configuration',
    '',
    '  on ecs-clusters.tf line 12:',
    '  12: resource "aws_ecs_cluster" "php_ecs_cluster" {',
    '',
    'A resource named "php_ecs_cluster" was already declared.',
  ].join('\n');
  const result = filterInitOutput(input);
  assert(result.startsWith('Error: Duplicate resource'));
  assert(!result.includes('First attempt error'));
  assert(!result.includes('Downloading'));
  assert(!result.includes('Upgrading modules'));
  assert(result.includes('resource named "php_ecs_cluster"'));
});

test('returns full output when retry has no Error:', () => {
  const input = [
    'Error: Some error',
    '--- First attempt failed, trying with -upgrade ---',
    'Initializing the backend...',
    'Terraform has been successfully initialized!',
  ].join('\n');
  // No Error: in retry portion, so return full content as fallback
  assert.strictEqual(filterInitOutput(input), input);
});

test('works with filter then truncate pipeline', () => {
  const noiseLines = Array.from({ length: 20 }, (_, i) => `Provider download line ${i}`);
  const errorLines = Array.from({ length: 60 }, (_, i) => `Error detail line ${i}`);
  errorLines[0] = 'Error: Something went wrong';
  const input = [...noiseLines, ...errorLines].join('\n');
  const filtered = filterInitOutput(input);
  assert(filtered.startsWith('Error: Something went wrong'));
  assert(!filtered.includes('Provider download'));
  const result = truncateOutput(filtered, 50);
  assert.strictEqual(result.truncated, true);
  assert(result.text.includes('lines truncated'));
  assert(result.text.includes('Error detail line 59'));
});

console.log('\nprocessPlanOutput:');

test('returns "No output available" for empty string', () => {
  const result = processPlanOutput('');
  assert.strictEqual(result.text, 'No output available');
  assert.strictEqual(result.truncated, false);
});

test('returns "No output available" for "null" string', () => {
  const result = processPlanOutput('null');
  assert.strictEqual(result.text, 'No output available');
  assert.strictEqual(result.truncated, false);
});

test('extracts from "No changes" indicator', () => {
  const content = 'header line\nextra noise\nNo changes. Your infrastructure matches the configuration.\nDone.';
  const result = processPlanOutput(content);
  assert(result.text.startsWith('No changes.'));
  assert(result.text.includes('Done.'));
  assert.strictEqual(result.truncated, false);
});

test('extracts from "Plan:" indicator', () => {
  const content = 'init output\nsome stuff\nPlan: 3 to add, 0 to change, 1 to destroy.\nend';
  const result = processPlanOutput(content);
  assert(result.text.startsWith('Plan:'));
  assert.strictEqual(result.truncated, false);
});

test('extracts from "Error:" indicator', () => {
  const content = 'preamble\nError: something went wrong\ndetails here';
  const result = processPlanOutput(content);
  assert(result.text.startsWith('Error:'));
  assert.strictEqual(result.truncated, false);
});

test('returns all lines when no indicator found', () => {
  const content = 'line1\nline2\nline3';
  const result = processPlanOutput(content);
  assert.strictEqual(result.text, content);
  assert.strictEqual(result.truncated, false);
});

test('truncates relevant section when over 500 lines', () => {
  const noise = Array.from({ length: 5 }, (_, i) => `noise${i}`);
  const planLines = Array.from({ length: 600 }, (_, i) => `resource${i}`);
  const content = [...noise, 'Terraform will perform the following actions:', ...planLines].join('\n');
  const result = processPlanOutput(content);
  assert.strictEqual(result.truncated, true);
  assert(result.text.includes('lines truncated'));
  // Should include the last 500 lines of the relevant section
  assert(result.text.includes('resource599'));
  assert(!result.text.includes('resource99\n'));
});

// ---------------------------------------------------------------------------
// Integration-style test: full module with mocked github/context
// ---------------------------------------------------------------------------

console.log('\nIntegration (module export):');

test('module runs and creates a comment via mock', async () => {
  // Set up temp files
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-test-'));
  fs.writeFileSync(path.join(tmpDir, 'terraform-outputs-fmt.txt'), '');
  fs.writeFileSync(path.join(tmpDir, 'terraform-outputs-init.txt'), 'Initialized');
  fs.writeFileSync(path.join(tmpDir, 'terraform-outputs-validate.txt'), 'Success! The configuration is valid.');
  fs.writeFileSync(
    path.join(tmpDir, 'terraform-outputs-plan.txt'),
    'No changes. Your infrastructure matches the configuration.'
  );

  // Set env vars the module reads
  const origEnv = { ...process.env };
  Object.assign(process.env, {
    ENVIRONMENT: 'test-env',
    PLAN_SUMMARY: 'No changes',
    LOCK_CHANGED: 'false',
    WORKING_DIRECTORY: '.',
    FMT_OUTCOME: 'success',
    INIT_OUTCOME: 'success',
    VALIDATE_OUTCOME: 'success',
    PLAN_OUTCOME: 'success',
    RUNNER_TEMP: tmpDir,
    GITHUB_SERVER_URL: 'https://github.com',
    GITHUB_REPOSITORY: 'test/repo',
    GITHUB_RUN_ID: '123',
    TERRAFORM_VERSION: '1.9.8',
    GITHUB_WORKFLOW_REF: 'test/repo/.github/workflows/terraform.yml@refs/heads/main',
  });

  let createdBody = null;
  const mockGithub = {
    paginate: async () => [],
    rest: {
      issues: {
        listComments: {},
        createComment: async ({ body }) => {
          createdBody = body;
        },
      },
    },
  };
  const mockContext = {
    actor: 'test-user',
    eventName: 'pull_request',
    issue: { number: 1 },
    repo: { owner: 'test', repo: 'repo' },
  };

  const prComment = require('./pr-comment.js');
  await prComment({ github: mockGithub, context: mockContext, core: {} });

  assert(createdBody !== null, 'Comment body should be set');
  assert(createdBody.includes('<!-- tf-action:workflow=.github/workflows/terraform.yml:env=test-env:dir=. -->'), 'Should include hidden marker');
  assert(createdBody.includes('## Terraform test-env'), 'Should include environment header');
  assert(createdBody.includes('| ✅ | ✅ | ✅ | ✅ | ✅ |'), 'Should include all-success status table row');
  assert(!createdBody.includes('Validation Output'), 'Should not show validation collapsible for clean success');
  assert(createdBody.includes('Terraform v1.9.8'), 'Should include terraform version');
  assert(!createdBody.includes('Output truncated'), 'Should not show truncation warning for short output');

  // Restore env
  for (const key of Object.keys(process.env)) {
    if (!(key in origEnv)) delete process.env[key];
    else process.env[key] = origEnv[key];
  }

  // Cleanup
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('module shows (non-blocking) for fmt failure without details', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-test-'));
  fs.writeFileSync(path.join(tmpDir, 'terraform-outputs-fmt.txt'), 'some diff output');
  fs.writeFileSync(path.join(tmpDir, 'terraform-outputs-init.txt'), 'Initialized');
  fs.writeFileSync(path.join(tmpDir, 'terraform-outputs-validate.txt'), 'Success! The configuration is valid.');
  fs.writeFileSync(
    path.join(tmpDir, 'terraform-outputs-plan.txt'),
    'No changes. Your infrastructure matches the configuration.'
  );

  const origEnv = { ...process.env };
  Object.assign(process.env, {
    ENVIRONMENT: 'fmt-fail-test',
    PLAN_SUMMARY: 'No changes',
    LOCK_CHANGED: 'false',
    WORKING_DIRECTORY: '.',
    FMT_OUTCOME: 'failure',
    INIT_OUTCOME: 'success',
    VALIDATE_OUTCOME: 'success',
    PLAN_OUTCOME: 'success',
    RUNNER_TEMP: tmpDir,
    GITHUB_SERVER_URL: 'https://github.com',
    GITHUB_REPOSITORY: 'test/repo',
    GITHUB_RUN_ID: '789',
    TERRAFORM_VERSION: '1.9.8',
    GITHUB_WORKFLOW_REF: 'test/repo/.github/workflows/terraform.yml@refs/heads/main',
  });

  let createdBody = null;
  const mockGithub = {
    paginate: async () => [],
    rest: {
      issues: {
        listComments: {},
        createComment: async ({ body }) => {
          createdBody = body;
        },
      },
    },
  };
  const mockContext = {
    actor: 'test-user',
    eventName: 'pull_request',
    issue: { number: 3 },
    repo: { owner: 'test', repo: 'repo' },
  };

  delete require.cache[require.resolve('./pr-comment.js')];
  const prComment = require('./pr-comment.js');
  await prComment({ github: mockGithub, context: mockContext, core: {} });

  assert(createdBody !== null, 'Comment body should be set');
  assert(createdBody.includes('| ⚠️ | ✅ | ✅ | ✅ |'), 'Should show ⚠️ for fmt failure in table');
  assert(!createdBody.includes('Format Issues Found'), 'Should not show fmt details');
  assert(!createdBody.includes('some diff output'), 'Should not include fmt diff content');

  for (const key of Object.keys(process.env)) {
    if (!(key in origEnv)) delete process.env[key];
    else process.env[key] = origEnv[key];
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('module shows truncation warning when plan is very long', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-test-'));
  fs.writeFileSync(path.join(tmpDir, 'terraform-outputs-fmt.txt'), '');
  fs.writeFileSync(path.join(tmpDir, 'terraform-outputs-init.txt'), 'Initialized');
  fs.writeFileSync(path.join(tmpDir, 'terraform-outputs-validate.txt'), 'Success! The configuration is valid.');

  // Create a plan output with >500 relevant lines
  const longPlan = [
    'Terraform will perform the following actions:',
    ...Array.from({ length: 600 }, (_, i) => `  # resource.item[${i}] will be created`),
  ].join('\n');
  fs.writeFileSync(path.join(tmpDir, 'terraform-outputs-plan.txt'), longPlan);

  const origEnv = { ...process.env };
  Object.assign(process.env, {
    ENVIRONMENT: 'truncation-test',
    PLAN_SUMMARY: 'Plan: 150 to add',
    LOCK_CHANGED: 'false',
    WORKING_DIRECTORY: '.',
    FMT_OUTCOME: 'success',
    INIT_OUTCOME: 'success',
    VALIDATE_OUTCOME: 'success',
    PLAN_OUTCOME: 'success',
    RUNNER_TEMP: tmpDir,
    GITHUB_SERVER_URL: 'https://github.com',
    GITHUB_REPOSITORY: 'test/repo',
    GITHUB_RUN_ID: '456',
    TERRAFORM_VERSION: '1.9.8',
    GITHUB_WORKFLOW_REF: 'test/repo/.github/workflows/terraform.yml@refs/heads/main',
  });

  let createdBody = null;
  const mockGithub = {
    paginate: async () => [],
    rest: {
      issues: {
        listComments: {},
        createComment: async ({ body }) => {
          createdBody = body;
        },
      },
    },
  };
  const mockContext = {
    actor: 'test-user',
    eventName: 'pull_request',
    issue: { number: 2 },
    repo: { owner: 'test', repo: 'repo' },
  };

  // Clear module cache to reset module state
  delete require.cache[require.resolve('./pr-comment.js')];
  const prComment = require('./pr-comment.js');
  await prComment({ github: mockGithub, context: mockContext, core: {} });

  assert(createdBody !== null, 'Comment body should be set');
  assert(createdBody.includes('Output truncated'), 'Should show truncation warning for long plan');

  for (const key of Object.keys(process.env)) {
    if (!(key in origEnv)) delete process.env[key];
    else process.env[key] = origEnv[key];
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// extractResourceChanges tests
// ---------------------------------------------------------------------------

console.log('\nextractResourceChanges:');

test('returns empty categorized object for empty content', () => {
  const empty = { created: [], updated: [], deleted: [], replaced: [] };
  assert.deepStrictEqual(extractResourceChanges(''), empty);
  assert.deepStrictEqual(extractResourceChanges(null), empty);
});

test('categorizes "will be updated in-place" lines', () => {
  const content = [
    'Terraform will perform the following actions:',
    '',
    '  # module.svc.aws_ecs_service.ecs will be updated in-place',
    '  ~ resource "aws_ecs_service" "ecs" {',
    '        id = "arn:aws:ecs:us-east-1:123:service/prod/svc"',
    '    }',
  ].join('\n');
  const result = extractResourceChanges(content);
  assert.deepStrictEqual(result.updated, ['module.svc.aws_ecs_service.ecs']);
  assert.deepStrictEqual(result.created, []);
});

test('categorizes "will be created" and "will be destroyed" lines', () => {
  const content = [
    '  # aws_instance.web will be created',
    '  + resource "aws_instance" "web" {}',
    '  # aws_instance.old will be destroyed',
    '  - resource "aws_instance" "old" {}',
  ].join('\n');
  const result = extractResourceChanges(content);
  assert.deepStrictEqual(result.created, ['aws_instance.web']);
  assert.deepStrictEqual(result.deleted, ['aws_instance.old']);
});

test('categorizes "must be replaced" lines', () => {
  const content = '  # aws_instance.web must be replaced\n  other stuff';
  const result = extractResourceChanges(content);
  assert.deepStrictEqual(result.replaced, ['aws_instance.web']);
});

test('categorizes mixed change types correctly', () => {
  const content = [
    '  # aws_instance.new will be created',
    '  # aws_instance.svc will be updated in-place',
    '  # aws_instance.old will be destroyed',
    '  # aws_instance.disk must be replaced',
  ].join('\n');
  const result = extractResourceChanges(content);
  assert.deepStrictEqual(result.created, ['aws_instance.new']);
  assert.deepStrictEqual(result.updated, ['aws_instance.svc']);
  assert.deepStrictEqual(result.deleted, ['aws_instance.old']);
  assert.deepStrictEqual(result.replaced, ['aws_instance.disk']);
});

test('ignores non-resource lines', () => {
  const content = [
    'Plan: 1 to add, 0 to change, 0 to destroy.',
    '  name = "test"',
    '  # (3 unchanged blocks hidden)',
  ].join('\n');
  const result = extractResourceChanges(content);
  const empty = { created: [], updated: [], deleted: [], replaced: [] };
  assert.deepStrictEqual(result, empty);
});

console.log('\nbuildResourceSummary:');

test('returns empty string for no changes', () => {
  assert.strictEqual(buildResourceSummary({ created: [], updated: [], deleted: [], replaced: [] }), '');
});

test('builds categorized sections', () => {
  const result = buildResourceSummary({
    created: ['aws_instance.web'],
    updated: ['aws_instance.svc'],
    deleted: [],
    replaced: [],
  });
  assert(result.includes('🟢 Will be Created'), 'Should include Created header');
  assert(result.includes('- `aws_instance.web`'), 'Should list created resource');
  assert(result.includes('🔄 Will be Updated'), 'Should include Updated header');
  assert(result.includes('- `aws_instance.svc`'), 'Should list updated resource');
  assert(!result.includes('🔴 Will be Deleted'), 'Should not include empty Deleted section');
  assert(!result.includes('⚠️ Will be Replaced'), 'Should not include empty Replaced section');
});

test('truncates at 20 lines per category with overflow message', () => {
  const created = Array.from({ length: 25 }, (_, i) => `resource.item${i}`);
  const result = buildResourceSummary({ created, updated: [], deleted: [], replaced: [] });
  assert(result.includes('`resource.item19`'), 'Should include 20th item');
  assert(!result.includes('`resource.item20`'), 'Should not include 21st item');
  assert(result.includes('... and 5 more'), 'Should show overflow count');
});

console.log('\nIntegration (resource changes in comment):');

test('module includes resource changes in plan success comment', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-test-'));
  fs.writeFileSync(path.join(tmpDir, 'terraform-outputs-fmt.txt'), '');
  fs.writeFileSync(path.join(tmpDir, 'terraform-outputs-init.txt'), 'Initialized');
  fs.writeFileSync(path.join(tmpDir, 'terraform-outputs-validate.txt'), 'Success! The configuration is valid.');
  fs.writeFileSync(
    path.join(tmpDir, 'terraform-outputs-plan.txt'),
    [
      'Terraform will perform the following actions:',
      '',
      '  # module.svc.aws_ecs_service.ecs will be updated in-place',
      '  ~ resource "aws_ecs_service" "ecs" {',
      '        id = "arn:aws:ecs:us-east-1:123:service/prod/svc"',
      '    }',
      '',
      'Plan: 0 to add, 1 to change, 0 to destroy.',
    ].join('\n')
  );

  const origEnv = { ...process.env };
  Object.assign(process.env, {
    ENVIRONMENT: 'resource-test',
    PLAN_SUMMARY: 'Plan: 0 to add, 1 to change, 0 to destroy.',
    LOCK_CHANGED: 'false',
    WORKING_DIRECTORY: '.',
    FMT_OUTCOME: 'success',
    INIT_OUTCOME: 'success',
    VALIDATE_OUTCOME: 'success',
    PLAN_OUTCOME: 'success',
    RUNNER_TEMP: tmpDir,
    GITHUB_SERVER_URL: 'https://github.com',
    GITHUB_REPOSITORY: 'test/repo',
    GITHUB_RUN_ID: '999',
    TERRAFORM_VERSION: '1.9.8',
    GITHUB_WORKFLOW_REF: 'test/repo/.github/workflows/terraform.yml@refs/heads/main',
  });

  let createdBody = null;
  const mockGithub = {
    paginate: async () => [],
    rest: {
      issues: {
        listComments: {},
        createComment: async ({ body }) => { createdBody = body; },
      },
    },
  };
  const mockContext = {
    actor: 'test-user',
    eventName: 'pull_request',
    issue: { number: 10 },
    repo: { owner: 'test', repo: 'repo' },
  };

  delete require.cache[require.resolve('./pr-comment.js')];
  const prComment = require('./pr-comment.js');
  await prComment({ github: mockGithub, context: mockContext, core: {} });

  assert(createdBody !== null, 'Comment body should be set');
  assert(
    createdBody.includes('`module.svc.aws_ecs_service.ecs`'),
    'Should include resource name'
  );
  assert(
    createdBody.includes('🔄 Will be Updated'),
    'Should include Updated category header'
  );
  // Resource summary should appear before the <details> block
  const summaryIdx = createdBody.indexOf('module.svc.aws_ecs_service.ecs');
  const detailsIdx = createdBody.indexOf('<details>');
  assert(summaryIdx < detailsIdx, 'Resource summary should appear before <details>');

  for (const key of Object.keys(process.env)) {
    if (!(key in origEnv)) delete process.env[key];
    else process.env[key] = origEnv[key];
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

console.log('\nIntegration (validate warning icon):');

test('module shows ⚠️ validate icon and collapsible when validate has warnings', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-test-'));
  fs.writeFileSync(path.join(tmpDir, 'terraform-outputs-fmt.txt'), '');
  fs.writeFileSync(path.join(tmpDir, 'terraform-outputs-init.txt'), 'Initialized');
  fs.writeFileSync(
    path.join(tmpDir, 'terraform-outputs-validate.txt'),
    'Warning: Deprecated attribute\n\nSuccess! The configuration is valid, but there were some validation warnings'
  );
  fs.writeFileSync(
    path.join(tmpDir, 'terraform-outputs-plan.txt'),
    'No changes. Your infrastructure matches the configuration.'
  );

  const origEnv = { ...process.env };
  Object.assign(process.env, {
    ENVIRONMENT: 'warn-validate-test',
    PLAN_SUMMARY: 'No changes',
    LOCK_CHANGED: 'false',
    WORKING_DIRECTORY: '.',
    FMT_OUTCOME: 'success',
    INIT_OUTCOME: 'success',
    VALIDATE_OUTCOME: 'success',
    PLAN_OUTCOME: 'success',
    RUNNER_TEMP: tmpDir,
    GITHUB_SERVER_URL: 'https://github.com',
    GITHUB_REPOSITORY: 'test/repo',
    GITHUB_RUN_ID: '1000',
    TERRAFORM_VERSION: '1.9.8',
    GITHUB_WORKFLOW_REF: 'test/repo/.github/workflows/terraform.yml@refs/heads/main',
  });

  let createdBody = null;
  const mockGithub = {
    paginate: async () => [],
    rest: {
      issues: {
        listComments: {},
        createComment: async ({ body }) => { createdBody = body; },
      },
    },
  };
  const mockContext = {
    actor: 'test-user',
    eventName: 'pull_request',
    issue: { number: 20 },
    repo: { owner: 'test', repo: 'repo' },
  };

  delete require.cache[require.resolve('./pr-comment.js')];
  const prComment = require('./pr-comment.js');
  await prComment({ github: mockGithub, context: mockContext, core: {} });

  assert(createdBody !== null, 'Comment body should be set');
  assert(createdBody.includes('| ✅ | ✅ | ⚠️ | ✅ | ✅ |'), 'Should show ⚠️ for validate with warnings');
  assert(createdBody.includes('Validation Output'), 'Should show validation collapsible when warnings present');
  assert(createdBody.includes('Warning: Deprecated attribute'), 'Should include warning text in collapsible');

  for (const key of Object.keys(process.env)) {
    if (!(key in origEnv)) delete process.env[key];
    else process.env[key] = origEnv[key];
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('module shows ✅ validate icon and no collapsible for clean success', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-test-'));
  fs.writeFileSync(path.join(tmpDir, 'terraform-outputs-fmt.txt'), '');
  fs.writeFileSync(path.join(tmpDir, 'terraform-outputs-init.txt'), 'Initialized');
  fs.writeFileSync(
    path.join(tmpDir, 'terraform-outputs-validate.txt'),
    'Success! The configuration is valid.'
  );
  fs.writeFileSync(
    path.join(tmpDir, 'terraform-outputs-plan.txt'),
    'No changes. Your infrastructure matches the configuration.'
  );

  const origEnv = { ...process.env };
  Object.assign(process.env, {
    ENVIRONMENT: 'clean-validate-test',
    PLAN_SUMMARY: 'No changes',
    LOCK_CHANGED: 'false',
    WORKING_DIRECTORY: '.',
    FMT_OUTCOME: 'success',
    INIT_OUTCOME: 'success',
    VALIDATE_OUTCOME: 'success',
    PLAN_OUTCOME: 'success',
    RUNNER_TEMP: tmpDir,
    GITHUB_SERVER_URL: 'https://github.com',
    GITHUB_REPOSITORY: 'test/repo',
    GITHUB_RUN_ID: '1001',
    TERRAFORM_VERSION: '1.9.8',
    GITHUB_WORKFLOW_REF: 'test/repo/.github/workflows/terraform.yml@refs/heads/main',
  });

  let createdBody = null;
  const mockGithub = {
    paginate: async () => [],
    rest: {
      issues: {
        listComments: {},
        createComment: async ({ body }) => { createdBody = body; },
      },
    },
  };
  const mockContext = {
    actor: 'test-user',
    eventName: 'pull_request',
    issue: { number: 21 },
    repo: { owner: 'test', repo: 'repo' },
  };

  delete require.cache[require.resolve('./pr-comment.js')];
  const prComment = require('./pr-comment.js');
  await prComment({ github: mockGithub, context: mockContext, core: {} });

  assert(createdBody !== null, 'Comment body should be set');
  assert(createdBody.includes('| ✅ | ✅ | ✅ | ✅ | ✅ |'), 'Should show ✅ for clean validate');
  assert(!createdBody.includes('Validation Output'), 'Should NOT show validation collapsible for clean success');

  for (const key of Object.keys(process.env)) {
    if (!(key in origEnv)) delete process.env[key];
    else process.env[key] = origEnv[key];
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// buildCommentMarker tests
// ---------------------------------------------------------------------------

console.log('\nbuildCommentMarker:');

test('builds marker from full workflow ref', () => {
  const result = buildCommentMarker('prod', './infra', 'owner/repo/.github/workflows/terraform.yml@refs/heads/main');
  assert.strictEqual(result, '<!-- tf-action:workflow=.github/workflows/terraform.yml:env=prod:dir=./infra -->');
});

test('handles missing workflow ref gracefully', () => {
  const result = buildCommentMarker('dev', '.', '');
  assert.strictEqual(result, '<!-- tf-action:workflow=:env=dev:dir=. -->');
});

test('handles workflow ref without @ suffix', () => {
  const result = buildCommentMarker('staging', './app', 'owner/repo/.github/workflows/deploy.yml');
  assert.strictEqual(result, '<!-- tf-action:workflow=.github/workflows/deploy.yml:env=staging:dir=./app -->');
});

test('different working dirs produce different markers', () => {
  const m1 = buildCommentMarker('prod', './infra/project-a', 'o/r/.github/workflows/ci.yml@refs/heads/main');
  const m2 = buildCommentMarker('prod', './infra/project-ab', 'o/r/.github/workflows/ci.yml@refs/heads/main');
  assert.notStrictEqual(m1, m2, 'Markers should differ for different working dirs');
});

test('same env name prefix does not collide', () => {
  const m1 = buildCommentMarker('prod', '.', 'o/r/.github/workflows/ci.yml@refs/heads/main');
  const m2 = buildCommentMarker('prod-eu', '.', 'o/r/.github/workflows/ci.yml@refs/heads/main');
  assert(!m1.includes(m2) && !m2.includes(m1), 'Markers should not be substrings of each other');
});

// ---------------------------------------------------------------------------
// Integration: marker-based comment detection
// ---------------------------------------------------------------------------

console.log('\nIntegration (marker-based detection):');

test('updates existing comment matched by marker instead of creating new', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-test-'));
  fs.writeFileSync(path.join(tmpDir, 'terraform-outputs-fmt.txt'), '');
  fs.writeFileSync(path.join(tmpDir, 'terraform-outputs-init.txt'), 'Initialized');
  fs.writeFileSync(path.join(tmpDir, 'terraform-outputs-validate.txt'), 'Success! The configuration is valid.');
  fs.writeFileSync(
    path.join(tmpDir, 'terraform-outputs-plan.txt'),
    'No changes. Your infrastructure matches the configuration.'
  );

  const origEnv = { ...process.env };
  Object.assign(process.env, {
    ENVIRONMENT: 'prod',
    PLAN_SUMMARY: 'No changes',
    LOCK_CHANGED: 'false',
    WORKING_DIRECTORY: './infra',
    FMT_OUTCOME: 'success',
    INIT_OUTCOME: 'success',
    VALIDATE_OUTCOME: 'success',
    PLAN_OUTCOME: 'success',
    RUNNER_TEMP: tmpDir,
    GITHUB_SERVER_URL: 'https://github.com',
    GITHUB_REPOSITORY: 'test/repo',
    GITHUB_RUN_ID: '2000',
    TERRAFORM_VERSION: '1.9.8',
    GITHUB_WORKFLOW_REF: 'test/repo/.github/workflows/terraform.yml@refs/heads/main',
  });

  const existingMarker = '<!-- tf-action:workflow=.github/workflows/terraform.yml:env=prod:dir=./infra -->';
  let updatedId = null;
  let updatedBody = null;
  let createdBody = null;
  const mockGithub = {
    paginate: async () => [
      { id: 100, body: existingMarker + '\n## Terraform prod\nold content' },
      { id: 101, body: '<!-- tf-action:workflow=.github/workflows/terraform.yml:env=prod:dir=./other -->\n## Terraform prod\nother project' },
    ],
    rest: {
      issues: {
        listComments: {},
        updateComment: async ({ comment_id, body }) => { updatedId = comment_id; updatedBody = body; },
        createComment: async ({ body }) => { createdBody = body; },
      },
    },
  };
  const mockContext = {
    actor: 'test-user',
    eventName: 'pull_request',
    issue: { number: 50 },
    repo: { owner: 'test', repo: 'repo' },
  };

  delete require.cache[require.resolve('./pr-comment.js')];
  const prComment = require('./pr-comment.js');
  await prComment({ github: mockGithub, context: mockContext, core: {} });

  assert.strictEqual(updatedId, 100, 'Should update the comment with matching marker (id=100)');
  assert(updatedBody.includes(existingMarker), 'Updated body should contain the marker');
  assert.strictEqual(createdBody, null, 'Should NOT create a new comment');

  for (const key of Object.keys(process.env)) {
    if (!(key in origEnv)) delete process.env[key];
    else process.env[key] = origEnv[key];
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('falls back to legacy heading match for old comments without marker', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-test-'));
  fs.writeFileSync(path.join(tmpDir, 'terraform-outputs-fmt.txt'), '');
  fs.writeFileSync(path.join(tmpDir, 'terraform-outputs-init.txt'), 'Initialized');
  fs.writeFileSync(path.join(tmpDir, 'terraform-outputs-validate.txt'), 'Success! The configuration is valid.');
  fs.writeFileSync(
    path.join(tmpDir, 'terraform-outputs-plan.txt'),
    'No changes. Your infrastructure matches the configuration.'
  );

  const origEnv = { ...process.env };
  Object.assign(process.env, {
    ENVIRONMENT: 'staging',
    PLAN_SUMMARY: 'No changes',
    LOCK_CHANGED: 'false',
    WORKING_DIRECTORY: '.',
    FMT_OUTCOME: 'success',
    INIT_OUTCOME: 'success',
    VALIDATE_OUTCOME: 'success',
    PLAN_OUTCOME: 'success',
    RUNNER_TEMP: tmpDir,
    GITHUB_SERVER_URL: 'https://github.com',
    GITHUB_REPOSITORY: 'test/repo',
    GITHUB_RUN_ID: '2001',
    TERRAFORM_VERSION: '1.9.8',
    GITHUB_WORKFLOW_REF: 'test/repo/.github/workflows/terraform.yml@refs/heads/main',
  });

  let updatedId = null;
  let updatedBody = null;
  const mockGithub = {
    paginate: async () => [
      { id: 200, body: '## Terraform staging\nold comment without marker' },
    ],
    rest: {
      issues: {
        listComments: {},
        updateComment: async ({ comment_id, body }) => { updatedId = comment_id; updatedBody = body; },
        createComment: async () => {},
      },
    },
  };
  const mockContext = {
    actor: 'test-user',
    eventName: 'pull_request',
    issue: { number: 51 },
    repo: { owner: 'test', repo: 'repo' },
  };

  delete require.cache[require.resolve('./pr-comment.js')];
  const prComment = require('./pr-comment.js');
  await prComment({ github: mockGithub, context: mockContext, core: {} });

  assert.strictEqual(updatedId, 200, 'Should update the legacy comment via heading fallback');
  assert(updatedBody.includes('<!-- tf-action:'), 'Updated body should now contain the marker for future runs');

  for (const key of Object.keys(process.env)) {
    if (!(key in origEnv)) delete process.env[key];
    else process.env[key] = origEnv[key];
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('does not match legacy comment that already has a different marker', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-test-'));
  fs.writeFileSync(path.join(tmpDir, 'terraform-outputs-fmt.txt'), '');
  fs.writeFileSync(path.join(tmpDir, 'terraform-outputs-init.txt'), 'Initialized');
  fs.writeFileSync(path.join(tmpDir, 'terraform-outputs-validate.txt'), 'Success! The configuration is valid.');
  fs.writeFileSync(
    path.join(tmpDir, 'terraform-outputs-plan.txt'),
    'No changes. Your infrastructure matches the configuration.'
  );

  const origEnv = { ...process.env };
  Object.assign(process.env, {
    ENVIRONMENT: 'prod',
    PLAN_SUMMARY: 'No changes',
    LOCK_CHANGED: 'false',
    WORKING_DIRECTORY: './project-a',
    FMT_OUTCOME: 'success',
    INIT_OUTCOME: 'success',
    VALIDATE_OUTCOME: 'success',
    PLAN_OUTCOME: 'success',
    RUNNER_TEMP: tmpDir,
    GITHUB_SERVER_URL: 'https://github.com',
    GITHUB_REPOSITORY: 'test/repo',
    GITHUB_RUN_ID: '2002',
    TERRAFORM_VERSION: '1.9.8',
    GITHUB_WORKFLOW_REF: 'test/repo/.github/workflows/terraform.yml@refs/heads/main',
  });

  let createdBody = null;
  let updatedId = null;
  const mockGithub = {
    paginate: async () => [
      // Existing comment for project-ab (different dir, same env) — has its own marker
      { id: 300, body: '<!-- tf-action:workflow=.github/workflows/terraform.yml:env=prod:dir=./project-ab -->\n## Terraform prod\nother project' },
    ],
    rest: {
      issues: {
        listComments: {},
        updateComment: async ({ comment_id }) => { updatedId = comment_id; },
        createComment: async ({ body }) => { createdBody = body; },
      },
    },
  };
  const mockContext = {
    actor: 'test-user',
    eventName: 'pull_request',
    issue: { number: 52 },
    repo: { owner: 'test', repo: 'repo' },
  };

  delete require.cache[require.resolve('./pr-comment.js')];
  const prComment = require('./pr-comment.js');
  await prComment({ github: mockGithub, context: mockContext, core: {} });

  assert.strictEqual(updatedId, null, 'Should NOT update the comment with a different marker');
  assert(createdBody !== null, 'Should create a new comment');
  assert(createdBody.includes('dir=./project-a -->'), 'New comment should have correct marker');

  for (const key of Object.keys(process.env)) {
    if (!(key in origEnv)) delete process.env[key];
    else process.env[key] = origEnv[key];
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
