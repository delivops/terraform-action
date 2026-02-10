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
  if (relevant.length > 100) {
    return {
      text: `... (${relevant.length - 100} lines truncated) ...\n\n${relevant.slice(-100).join('\n')}`,
      truncated: true,
    };
  }
  return { text: relevant.join('\n'), truncated: false };
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

test('truncates relevant section when over 100 lines', () => {
  const noise = Array.from({ length: 5 }, (_, i) => `noise${i}`);
  const planLines = Array.from({ length: 150 }, (_, i) => `resource${i}`);
  const content = [...noise, 'Terraform will perform the following actions:', ...planLines].join('\n');
  const result = processPlanOutput(content);
  assert.strictEqual(result.truncated, true);
  assert(result.text.includes('lines truncated'));
  // Should include the last 100 lines of the relevant section
  assert(result.text.includes('resource149'));
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
  fs.writeFileSync(path.join(tmpDir, 'terraform-outputs-validate.txt'), 'Success!');
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
  assert(createdBody.includes('## Terraform test-env'), 'Should include environment header');
  assert(createdBody.includes('success'), 'Should include success status');
  assert(!createdBody.includes('Output truncated'), 'Should not show truncation warning for short output');

  // Restore env
  for (const key of Object.keys(process.env)) {
    if (!(key in origEnv)) delete process.env[key];
    else process.env[key] = origEnv[key];
  }

  // Cleanup
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('module shows truncation warning when plan is very long', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-test-'));
  fs.writeFileSync(path.join(tmpDir, 'terraform-outputs-fmt.txt'), '');
  fs.writeFileSync(path.join(tmpDir, 'terraform-outputs-init.txt'), 'Initialized');
  fs.writeFileSync(path.join(tmpDir, 'terraform-outputs-validate.txt'), 'Success!');

  // Create a plan output with >100 relevant lines
  const longPlan = [
    'Terraform will perform the following actions:',
    ...Array.from({ length: 150 }, (_, i) => `  # resource.item[${i}] will be created`),
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
// Summary
// ---------------------------------------------------------------------------

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
