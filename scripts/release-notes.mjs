#!/usr/bin/env node
/**
 * Release notes for a prod release tag: the changes on main since the previous
 * release tag, one line per merged PR (or direct commit).
 * Usage: node scripts/release-notes.mjs <tag> [<out dir>]
 *
 * Writes <out dir>/release-notes.md (full, for the GitHub release) and
 * <out dir>/release-message.txt (the same notes cut to whole lines within
 * 1000 bytes, Cloudflare's limit for a Worker version message). Default out
 * dir: the current directory.
 *
 * Release tags are YYYY-MM-DD, then YYYY-MM-DD.2, .3, ... the same day; the
 * previous release is the highest such tag below <tag>.
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const MESSAGE_MAX_BYTES = 1000;
const RELEASE_TAG = /^(\d{4}-\d{2}-\d{2})(?:\.([2-9]|[1-9]\d+))?$/;

const [tag, outDir = '.'] = process.argv.slice(2);
if (!tag || !RELEASE_TAG.test(tag)) {
  console.error('Usage: node scripts/release-notes.mjs <YYYY-MM-DD[.COUNT]> [<out dir>]');
  process.exit(1);
}

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();

// Sort key: the date, then the day's counter (a bare date is release 1).
const releaseKey = t => {
  const [, day, count] = t.match(RELEASE_TAG);
  return `${day}.${String(count ?? 1).padStart(6, '0')}`;
};

const previous = git('tag', '--list')
  .split('\n')
  .filter(t => RELEASE_TAG.test(t) && releaseKey(t) < releaseKey(tag))
  .sort((a, b) => releaseKey(a).localeCompare(releaseKey(b)))
  .pop();

// First-parent history of main: one entry per merged PR. GitHub's merge
// commits read "Merge pull request #N from <branch>", with the PR title as
// the first line of the body; a squash merge or direct commit is its subject.
const range = previous ? `${previous}..${tag}` : tag;
const SEP = '\x1f';
const changes = git('log', '--first-parent', `--format=%h${SEP}%s${SEP}%b%x1e`, range)
  .split('\x1e')
  .map(entry => entry.trim())
  .filter(Boolean)
  .map(entry => {
    const [sha, subject, body] = entry.split(SEP);
    const pr = subject.match(/^Merge pull request #(\d+) from /);
    if (pr) {
      const title = body.split('\n').map(l => l.trim()).find(Boolean) ?? subject;
      return `- ${title} (#${pr[1]})`;
    }
    return `- ${subject} (${sha})`;
  });

const header = previous
  ? `Release ${tag}: ${changes.length} change${changes.length === 1 ? '' : 's'} since ${previous}`
  : `Release ${tag}: first release`;
const lines = changes.length ? changes : ['- No changes since the previous release (redeploy).'];

const repo = process.env.GITHUB_REPOSITORY;
const compare = repo && previous
  ? `\n\nFull diff: https://github.com/${repo}/compare/${previous}...${tag}`
  : '';
const notes = `${header}\n\n${lines.join('\n')}${compare}\n`;

// The version message: as many whole lines as fit, then how many were left out.
const bytes = s => Buffer.byteLength(s, 'utf8');
let message = header;
let included = 0;
for (const line of lines) {
  const rest = lines.length - included - 1;
  const more = rest ? `\n…and ${rest} more` : '';
  if (bytes(`${message}\n${line}${more}`) > MESSAGE_MAX_BYTES) break;
  message += `\n${line}`;
  included++;
}
if (included < lines.length) message += `\n…and ${lines.length - included} more`;

writeFileSync(resolve(outDir, 'release-notes.md'), notes);
writeFileSync(resolve(outDir, 'release-message.txt'), message);
console.log(notes);
