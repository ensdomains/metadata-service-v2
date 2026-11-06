import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';

const [tag, notesPath] = process.argv.slice(2);
const notes = JSON.parse(readFileSync(notesPath, 'utf8'));
const pattern = /^[0-9]{4}-[0-9]{2}-[0-9]{2}(\.([2-9]|[1-9][0-9]+))?$/;
if (!pattern.test(tag) || notes.tag !== tag || (notes.previous !== null && !pattern.test(notes.previous))) {
  console.error('Release notes must match the selected production date tag.');
  process.exit(1);
}
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const head = git('rev-parse', 'HEAD');
if (head !== git('rev-parse', `${tag}^{commit}`)) {
  console.error('Checkout must point at the production tag.');
  process.exit(1);
}
// A divergent hardfork release scans only commits added since the common ancestor.
const base = notes.previous ? git('merge-base', notes.previous, head) : head;
if (notes.previous && base !== git('rev-parse', `${notes.previous}^{commit}`)) {
  console.log('::warning::Previous production tag is not an ancestor; scanning from the common ancestor.');
}
appendFileSync(process.env.GITHUB_OUTPUT, `base-ref=${base}\n`);
