#!/usr/bin/env node
/**
 * Posts a prod release's outcome to Slack: the changes it shipped, or the step
 * it failed at. Runs as the last step of release.yml whatever the earlier
 * steps did, so a rerun of the job posts again.
 * Usage: node scripts/release-slack.mjs [<notes dir>]
 *
 * Reads <notes dir>/release-notes.json from scripts/release-notes.mjs (it is
 * missing when the release failed before the notes were written). STEPS is
 * the job's toJSON(steps): each step with an id and its outcome.
 * Posts to SLACK_WEBHOOK_URL; without it, or with DRY_RUN=1, prints the
 * message instead, so a repo without the secret still releases cleanly.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const STEPS = {
  tag: 'tag check',
  branch: 'main check',
  setup: 'setup',
  checks: 'lint, typecheck and test',
  notes: 'release notes',
  migrate: 'D1 migrations',
  deploy: 'deploy',
  release: 'GitHub release',
};
// Linear team keys that get linked; a bare prefix would also catch EIP-2612.
const LINEAR_TICKET = /\b(?:WEB|FET)-\d+\b/g;
// Slack rejects a section over 3000 characters.
const SECTION_MAX = 2900;
const MAX_CHANGES = 40;
const TITLE_MAX = 200;

const [notesDir = '.'] = process.argv.slice(2);
const {
  TAG: tag,
  STEPS: stepsJson = '{}',
  SLACK_WEBHOOK_URL: webhookUrl,
  DRY_RUN: dryRun,
  GITHUB_SERVER_URL: server = 'https://github.com',
  GITHUB_REPOSITORY: repo,
  GITHUB_RUN_ID: runId,
  GITHUB_RUN_ATTEMPT: attempt = '1',
  GITHUB_ACTOR: actor,
  GITHUB_SHA: sha,
} = process.env;

const notesPath = resolve(notesDir, 'release-notes.json');
const notes = existsSync(notesPath) ? JSON.parse(readFileSync(notesPath, 'utf8')) : null;
const steps = JSON.parse(stepsJson);

const repoUrl = `${server}/${repo}`;
const runUrl = `${repoUrl}/actions/runs/${runId}${attempt === '1' ? '' : `/attempts/${attempt}`}`;
const releaseUrl = `${repoUrl}/releases/tag/${tag}`;

// Titles are contributor-controlled; escape Slack's control characters so a
// title containing e.g. <!channel> can't ping anyone.
const escapeSlack = s => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const linkTickets = s => s.replace(LINEAR_TICKET, id => `<https://linear.app/enslabs/issue/${id}|${id}>`);
const changeLine = c =>
  `• ${linkTickets(escapeSlack(c.title.slice(0, TITLE_MAX)))} ${
    c.pr ? `<${repoUrl}/pull/${c.pr}|#${c.pr}>` : `<${repoUrl}/commit/${c.sha}|${c.sha}>`
  }`;

const results = Object.entries(steps).map(([id, { outcome }]) => ({ step: STEPS[id] ?? id, outcome }));
const failed = results.filter(r => r.outcome === 'failure');
const succeeded = results.filter(r => r.outcome === 'success');
const isReleased = results.length > 0 && succeeded.length === results.length;

const changes = notes?.changes ?? [];
const shown = changes.slice(0, MAX_CHANGES).map(changeLine);
if (changes.length > shown.length) {
  shown.push(`…and ${changes.length - shown.length} more in the <${releaseUrl}|GitHub release>`);
}

// Whole lines per section, each within Slack's limit.
const sections = shown.reduce((acc, line) => {
  const last = acc.at(-1);
  if (last && last.length + line.length + 1 <= SECTION_MAX) acc[acc.length - 1] = `${last}\n${line}`;
  else acc.push(line);
  return acc;
}, []);

const summary = !notes
  ? `\`${tag}\``
  : !notes.previous
    ? `<${releaseUrl}|${tag}>: first release`
    : `${isReleased ? `<${releaseUrl}|${tag}>` : `\`${tag}\``}: ${changes.length} change${
        changes.length === 1 ? '' : 's'
      } since \`${notes.previous}\``;

const outcome = isReleased
  ? null
  : failed.length
    ? `Failed at *${failed.map(r => r.step).join(', ')}*.${
        succeeded.length ? ` Done: ${succeeded.map(r => r.step).join(', ')}.` : ''
      } <${runUrl}|Open the run>.`
    : `Did not finish. <${runUrl}|Open the run>.`;

const footer = [
  actor && `Tagged by <${server}/${actor}|${actor}>`,
  sha && `<${repoUrl}/commit/${sha}|${sha.slice(0, 9)}>`,
  notes?.compareUrl && `<${notes.compareUrl}|Full diff>`,
  `<${runUrl}|Workflow run${attempt === '1' ? '' : ` (attempt ${attempt})`}>`,
]
  .filter(Boolean)
  .join(' · ');

const title = isReleased ? ':rocket: Metadata service released to prod' : ':x: Metadata service release failed';
const section = text => ({ type: 'section', text: { type: 'mrkdwn', text } });
const blocks = [
  { type: 'header', text: { type: 'plain_text', text: title, emoji: true } },
  section([summary, outcome].filter(Boolean).join('\n')),
  ...sections.map(section),
  { type: 'context', elements: [{ type: 'mrkdwn', text: footer }] },
];
const message = { text: `${title.replace(/^:\w+: /, '')}: ${tag}`, blocks, unfurl_links: false };

if (!webhookUrl || dryRun === '1') {
  console.log(`${webhookUrl ? 'DRY_RUN' : 'No SLACK_WEBHOOK_URL'}: would post to Slack:`);
  console.log(JSON.stringify(message, null, 2));
  process.exit(0);
}

const res = await fetch(webhookUrl, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(message),
  // Releases queue behind each other; a stuck post must not hold the next one.
  signal: AbortSignal.timeout(10_000),
});
if (!res.ok) throw new Error(`Slack webhook failed: ${res.status} ${await res.text()}`);
console.log(`Posted ${tag} (${isReleased ? 'released' : 'failed'}) to Slack.`);
