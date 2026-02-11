const fs = require('fs');

// Build a unique hidden HTML marker to identify this comment.
// Uses workflow file path + environment + working directory to avoid
// collisions between projects that share the same environment name prefix.
function buildCommentMarker(env, workDir, workflowRef) {
  // Extract workflow file path from GITHUB_WORKFLOW_REF
  // Format: "owner/repo/.github/workflows/file.yml@refs/heads/main"
  let workflowPath = workflowRef || '';
  const atIdx = workflowPath.indexOf('@');
  if (atIdx >= 0) workflowPath = workflowPath.substring(0, atIdx);
  // Strip "owner/repo/" prefix (first two path segments)
  const parts = workflowPath.split('/');
  if (parts.length > 2) workflowPath = parts.slice(2).join('/');
  return `<!-- tf-action:workflow=${workflowPath}:env=${env}:dir=${workDir} -->`;
}

module.exports = async ({ github, context, core }) => {
  const environment = process.env.ENVIRONMENT;
  const planSummary = process.env.PLAN_SUMMARY || '';
  const lockChanged = process.env.LOCK_CHANGED === 'true';
  const workingDirectory = process.env.WORKING_DIRECTORY || '.';
  const marker = buildCommentMarker(environment, workingDirectory, process.env.GITHUB_WORKFLOW_REF);
  let hasTruncation = false;

  // Helper to safely read file; returns empty string on error
  function readFileSafe(path) {
    try {
      return fs.readFileSync(path, 'utf8');
    } catch (_) {
      return '';
    }
  }

  // Function to truncate output if too long
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

  // Function to filter terraform init output - keep only errors.
  // When init retries with -upgrade, discard first attempt output.
  function filterInitOutput(content) {
    if (!content || content.trim() === '') {
      return content;
    }
    // If retry separator exists, only consider the last attempt
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

  // Function to filter terraform validate output - keep only warnings, errors, and status.
  // Strips provider SDK diagnostic metadata (key=value log lines) and keeps
  // only human-readable messages like "Warning:", "Error:", resource context, etc.
  function filterValidateOutput(content) {
    if (!content || content.trim() === '') {
      return content;
    }
    const lines = content.split('\n');
    const filtered = lines.filter((line) => {
      // Drop timestamp-prefixed provider log lines (INFO, DEBUG, TRACE, WARN)
      if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z\s+\[(INFO|DEBUG|TRACE|WARN|ERROR)\]/.test(line)) {
        return false;
      }
      // Drop provider SDK structured log lines containing diagnostic metadata key=value pairs
      if (/(?:diagnostic_detail|diagnostic_severity|diagnostic_summary|diagnostic_attribute|tf_provider_addr|tf_resource_type|tf_proto_version|tf_rpc|tf_req_id|@caller|@module)=/.test(line)) {
        return false;
      }
      // Drop pipe-prefixed continuation lines from diagnostic_detail blocks
      if (/^\s+\|/.test(line)) {
        return false;
      }
      return true;
    });
    // Collapse consecutive blank lines
    const collapsed = filtered.reduce((acc, line) => {
      if (line.trim() === '' && acc.length > 0 && acc[acc.length - 1].trim() === '') {
        return acc;
      }
      acc.push(line);
      return acc;
    }, []);
    return collapsed.join('\n').trim();
  }

  // Extract resource change lines from plan output, categorized by action type
  const MAX_RESOURCE_LINES = 20;
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

  // Build categorized markdown lists of resource changes
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
      sections.push(`### ${label}\n${lines.join('\n')}`);
    }
    if (sections.length === 0) return '';
    return '\n' + sections.join('\n\n') + '\n##\n';
  }

  // Function to process terraform plan output - find relevant section
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

  const tempDir = process.env.RUNNER_TEMP || '/tmp';
  const initResult = truncateOutput(filterInitOutput(readFileSafe(`${tempDir}/terraform-outputs-init.txt`)), 50);
  const validateResult = truncateOutput(filterValidateOutput(readFileSafe(`${tempDir}/terraform-outputs-validate.txt`)), 50);
  const rawPlanContent = readFileSafe(`${tempDir}/terraform-outputs-plan.txt`);
  const planResult = processPlanOutput(rawPlanContent);

  const initOutput = initResult.text;
  const validateOutput = validateResult.text;
  const planOutput = planResult.text;
  const isCleanValidation = validateOutput.trim() === 'Success! The configuration is valid.';
  // Only track truncation for outputs that are actually displayed in the comment
  if (process.env.INIT_OUTCOME === 'failure') {
    hasTruncation = initResult.truncated;
  } else {
    hasTruncation = !isCleanValidation && validateResult.truncated;
    if (process.env.VALIDATE_OUTCOME !== 'failure') {
      hasTruncation = hasTruncation || planResult.truncated;
    }
  }

  // Build resource change summary from raw (un-truncated) plan content
  const resourceChanges = extractResourceChanges(rawPlanContent);
  const resourceSummary = buildResourceSummary(resourceChanges);

  // Build header with plan summary if available
  let headerTitle = `Terraform ${environment}`;
  if (planSummary && planSummary.includes('to add')) {
    const m = planSummary.match(/(\d+ to add, \d+ to change, \d+ to destroy)/);
    if (m) headerTitle += ` (${m[1]})`;
  } else if (planSummary && planSummary.includes('No changes')) {
    headerTitle += ' (no changes)';
  }

  // Build descriptive status labels for the compact table
  const fmtStatus = process.env.FMT_OUTCOME === 'failure' ? '⚠️ Need Formatting' : '✅ Valid';
  const initStatus = process.env.INIT_OUTCOME === 'failure' ? '❌ Failed' : '✅ Passed';
  let validateStatus = isCleanValidation ? '✅ Passed' : '⚠️ Warnings';
  if (process.env.INIT_OUTCOME === 'failure') validateStatus = '⏭️ Skipped';
  else if (process.env.VALIDATE_OUTCOME === 'failure') validateStatus = '❌ Failed';
  let planStatus = '✅ Passed';
  if (process.env.INIT_OUTCOME === 'failure' || process.env.VALIDATE_OUTCOME === 'failure') planStatus = '⏭️ Skipped';
  else if (process.env.PLAN_OUTCOME === 'failure') planStatus = '❌ Failed';
  else if (process.env.PLAN_OUTCOME !== 'success') planStatus = '⏭️ Skipped';
  const lockStatus = lockChanged ? '⚠️ Changed' : '✅ Up to date';
  const tfVersion = process.env.TERRAFORM_VERSION || '';

  const statusTable = tfVersion
    ? `\n| Format | Init | Validate | Plan | Lock File | Version |\n|:-:|:-:|:-:|:-:|:-:|:-:|\n| ${fmtStatus} | ${initStatus} | ${validateStatus} | ${planStatus} | ${lockStatus} | ${tfVersion} |`
    : `\n| Format | Init | Validate | Plan | Lock File |\n|:-:|:-:|:-:|:-:|:-:|\n| ${fmtStatus} | ${initStatus} | ${validateStatus} | ${planStatus} | ${lockStatus} |`;

  // Build init section (only show if failed)
  let initSection = '';
  if (process.env.INIT_OUTCOME === 'failure') {
    initSection = `\n<details><summary>❌ Init Failed - Show Details</summary>\n\n\`\`\`\n${initOutput}\n\`\`\`\n\n</details>\n`;
  }

  // Build validation details (collapsible, only when there are warnings)
  let validateDetails = '';
  if (process.env.INIT_OUTCOME !== 'failure' && process.env.VALIDATE_OUTCOME !== 'failure' && !isCleanValidation) {
    validateDetails = `<details><summary>Validation Output</summary>\n\n\`\`\`\n${validateOutput}\n\`\`\`\n\n</details>`;
  }

  // Build plan body based on outcomes (heading is now in the status table)
  let planBody;
  if (process.env.INIT_OUTCOME === 'failure') {
    planBody = `> ❌ **Terraform init failed!** Fix the errors above before merging.${initSection}`;
  } else if (process.env.VALIDATE_OUTCOME === 'failure') {
    planBody = `<details><summary>Validation Failed - Show Details</summary>\n\n\`\`\`\n${validateOutput}\n\`\`\`\n\n</details>\n\n> ❌ **Terraform validation failed!** Fix the errors above before merging.`;
  } else if (process.env.PLAN_OUTCOME === 'success') {
    planBody = `<details><summary>Show Full Plan</summary>\n\n\`\`\`terraform\n${planOutput}\n\`\`\`\n\n</details>`;
  } else if (process.env.PLAN_OUTCOME === 'failure') {
    planBody = `<details><summary>Plan Failed - Show Details</summary>\n\n\`\`\`\n${planOutput}\n\`\`\`\n\n</details>\n\n> ❌ **Terraform plan failed!** Fix the errors above before merging.`;
  } else {
    planBody = '> Plan was skipped.';
  }

  const comment = [
    marker,
    `## ${headerTitle}`,
    resourceSummary,
    '### Details',
    validateDetails,
    planBody,
    statusTable,
    hasTruncation ? `\n**⚠️ Output truncated due to length. [View full logs](${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}).**` : '',
  ].filter(Boolean).join('\n');

  // Find existing comment or create new one
  const comments = await github.paginate(
    github.rest.issues.listComments,
    {
      issue_number: context.issue.number,
      owner: context.repo.owner,
      repo: context.repo.repo,
      per_page: 100,
    }
  );

  // Match by unique hidden marker; fall back to legacy heading match for backward compatibility
  let botComment = comments.find((c) => c.body && c.body.includes(marker));
  if (!botComment) {
    botComment = comments.find((c) => c.body && c.body.includes(`## Terraform ${environment}`) && !c.body.includes('<!-- tf-action:'));
  }
  if (botComment) {
    await github.rest.issues.updateComment({
      comment_id: botComment.id,
      owner: context.repo.owner,
      repo: context.repo.repo,
      body: comment,
    });
  } else {
    await github.rest.issues.createComment({
      issue_number: context.issue.number,
      owner: context.repo.owner,
      repo: context.repo.repo,
      body: comment,
    });
  }
};
