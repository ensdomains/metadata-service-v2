const RELEASE_TAG = /^(\d{4}-\d{2}-\d{2})(?:\.([2-9]|[1-9]\d+))?$/;
const releaseKey = tag => {
  const [, day, count] = tag.match(RELEASE_TAG);
  return `${day}.${String(count ?? 1).padStart(6, '0')}`;
};

export const getPreviousRelease = ({ tag, tags, releasedTags }) => tags
  .filter(candidate => RELEASE_TAG.test(candidate) && releaseKey(candidate) < releaseKey(tag) && releasedTags.includes(candidate))
  .toSorted((a, b) => releaseKey(a).localeCompare(releaseKey(b)))
  .at(-1);
