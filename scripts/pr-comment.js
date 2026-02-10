const fs = require('fs');

module.exports = async ({ github, context, core }) => {
  const environment = process.env.ENVIRONMENT;
  const planSummary = process.env.PLAN_SUMMARY || '';
  const lockChanged = process.env.LOCK_CHANGED === 'true';
  const workingDirectory = process.env.WORKING_DIRECTORY || '.';
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
    if (relevant.length > 100) {
      return {
        text: `... (${relevant.length - 100} lines truncated) ...\n\n${relevant.slice(-100).join('\n')}`,
        truncated: true,
      };
    }
    return { text: relevant.join('\n'), truncated: false };
  }

  const tempDir = process.env.RUNNER_TEMP || '/tmp';
  const fmtResult = truncateOutput(readFileSafe(`${tempDir}/terraform-outputs-fmt.txt`), 30);
  const initResult = truncateOutput(readFileSafe(`${tempDir}/terraform-outputs-init.txt`), 50);
  const validateResult = truncateOutput(readFileSafe(`${tempDir}/terraform-outputs-validate.txt`), 50);
  const planResult = processPlanOutput(readFileSafe(`${tempDir}/terraform-outputs-plan.txt`));
  const costOutput = readFileSafe(`${tempDir}/terraform-outputs-cost.txt`);

  const fmtOutput = fmtResult.text;
  const initOutput = initResult.text;
  const validateOutput = validateResult.text;
  const planOutput = planResult.text;
  hasTruncation = fmtResult.truncated || initResult.truncated || validateResult.truncated || planResult.truncated;

  // Build header with plan summary if available
  let headerSummary = '';
  if (planSummary && planSummary.includes('to add')) {
    headerSummary = `\n> 📊 **${planSummary}**\n`;
  } else if (planSummary && planSummary.includes('No changes')) {
    headerSummary = `\n> ✨ **No changes.** Your infrastructure matches the configuration.\n`;
  }

  // Build lock file warning if changed
  let lockWarning = '';
  if (lockChanged) {
    lockWarning = `\n> ⚠️ **Lock file outdated** - Run locally:\n> \`\`\`bash\n> cd ${workingDirectory} && terraform init -upgrade && git add .terraform.lock.hcl && git commit -m "chore: update terraform lock"\n> \`\`\`\n`;
  }

  // Build fmt section
  let fmtSection = '';
  if (process.env.FMT_OUTCOME === 'failure') {
    fmtSection = `\n<details><summary>❌ Format Issues Found</summary>\n\n\`\`\`diff\n${fmtOutput}\n\`\`\`\n\n</details>\n`;
  }

  // Build init section (only show if failed)
  let initSection = '';
  if (process.env.INIT_OUTCOME === 'failure') {
    initSection = `\n<details><summary>❌ Init Failed - Show Details</summary>\n\n\`\`\`\n${initOutput}\n\`\`\`\n\n</details>\n`;
  }

  // Build cost estimation section if available
  let costSection = '';
  if (costOutput && costOutput.trim() !== '' && !costOutput.includes('Cost estimation failed')) {
    const costResult = truncateOutput(costOutput, 100);
    if (costResult.truncated) hasTruncation = true;
    costSection = `\n#### Cost Estimation 💰\n\n<details><summary>Show Cost Breakdown</summary>\n\n\`\`\`\n${costResult.text}\n\`\`\`\n\n</details>\n`;
  }

  // Build plan section based on outcomes
  let planSection;
  if (process.env.INIT_OUTCOME === 'failure') {
    planSection = `#### Terraform Plan 📖 \`skipped\` ⏭️\n\n> ❌ **Terraform init failed!** Fix the errors above before merging.${initSection}`;
  } else if (process.env.VALIDATE_OUTCOME === 'failure') {
    planSection = `#### Terraform Plan 📖 \`skipped\` ⏭️\n\n<details><summary>Validation Failed - Show Details</summary>\n\n\`\`\`\n${validateOutput}\n\`\`\`\n\n</details>\n\n> ❌ **Terraform validation failed!** Fix the errors above before merging.`;
  } else if (process.env.PLAN_OUTCOME === 'success') {
    planSection = `#### Terraform Plan 📖 \`success\` ✅\n\n<details><summary>Show Plan</summary>\n\n\`\`\`terraform\n${planOutput}\n\`\`\`\n\n</details>${costSection}`;
  } else if (process.env.PLAN_OUTCOME === 'failure') {
    planSection = `#### Terraform Plan 📖 \`failure\` ❌\n\n<details><summary>Plan Failed - Show Details</summary>\n\n\`\`\`\n${planOutput}\n\`\`\`\n\n</details>\n\n> ❌ **Terraform plan failed!** Fix the errors above before merging.`;
  } else {
    planSection = '#### Terraform Plan 📖 `skipped` ⏭️\n\n> Plan was skipped.';
  }

  // Build validate section (only expand if failed, otherwise collapsed)
  let validateSection;
  if (process.env.INIT_OUTCOME === 'failure') {
    validateSection = `#### Terraform Validation 🤖 \`skipped\``;
  } else if (process.env.VALIDATE_OUTCOME === 'failure') {
    validateSection = `#### Terraform Validation 🤖 \`failure\` ❌`;
  } else {
    validateSection = `#### Terraform Validation 🤖 \`${process.env.VALIDATE_OUTCOME}\` ✅\n\n<details><summary>Validation Output</summary>\n\n\`\`\`\n${validateOutput}\n\`\`\`\n\n</details>`;
  }

  const comment = [
    `## Terraform ${environment}`,
    headerSummary,
    lockWarning,
    `#### Terraform Format and Style 🖌 \`${process.env.FMT_OUTCOME}\`${process.env.FMT_OUTCOME === 'failure' ? ' ❌' : ' ✅'}${fmtSection}`,
    `#### Terraform Initialization ⚙️ \`${process.env.INIT_OUTCOME}\`${process.env.INIT_OUTCOME === 'failure' ? ' ❌' : ' ✅'}`,
    validateSection,
    '',
    planSection,
    '',
    `*Pushed by: @${context.actor}, Action: \`${context.eventName}\`*`,
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

  const botComment = comments.find((c) => c.body && c.body.includes(`## Terraform ${environment}\n`));
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
