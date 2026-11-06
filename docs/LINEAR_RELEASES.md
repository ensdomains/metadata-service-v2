# Linear release tracking

Create two continuous pipelines in Linear Settings → Releases: Metadata service
(staging), with its production designation off, and Metadata service
(production), with production enabled. Aaron's pipeline access keys are pending;
personal API tokens cannot replace them. Add these repository Actions secrets:

| Pipeline | Secret |
| --- | --- |
| Staging | `LINEAR_RELEASE_METADATA_STAGING` |
| Production | `LINEAR_RELEASE_METADATA_PRODUCTION` |

Review release-completion automations separately; staging completion must not
mark work delivered to production. This PR does not change workspace settings.

Staging tracking runs on every push to main, independently of Workers Builds.
It records merges rather than confirming deployment availability. Production
tracking runs only after successful deployment and GitHub release creation.
It scans changes since the previous date tag with a published GitHub release,
sets the name and version to the deploy tag, and attaches the generated notes,
GitHub release and workflow links. Failed deploy tags do not advance the baseline.
The first production sync without a previous successful tag initializes an
empty issue list; its notes retain the existing full-history first-release behavior.

Missing keys produce warnings without failing deployments. Configured sync
failures fail the tracking job; Slack reports the deployment result separately
and includes either a Linear release link or a tracking warning. Deployment
step details remain available in failure notifications.

Run **Linear Production Release** manually with a published production date tag
to retry or backfill without redeploying. It uses tooling from the workflow
revision, so tags predating this integration can be synced. Replay missed tags
chronologically. A repeated version updates the existing release. Alternatively,
rerun the failed tracking job while the original notes artifact is retained.

Run `node --test scripts/*.test.mjs`; CI runs these alongside the existing tests.
Validate workflows with actionlint v1.7.12 and
`-ignore '^unexpected key "queue"'` for its missing support for GitHub's
[`queue: max`](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#concurrency).
Once keys are installed, check that merges only enter staging, successful tags
enter production with expected issues, failed deploys create no Linear release,
and retrying a sync updates the same version. No live sync was performed while
the keys were pending.
