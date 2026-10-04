# Releases

## Versions and compatibility

The current product version is `0.1.0`. Set the product version in `package.json` and
the root package entries of `package-lock.json`. Release tags must be annotated
`vMAJOR.MINOR.PATCH` tags; prerelease suffixes and build metadata are rejected. Zero-major releases are supported.

Before `1.0.0`, minor releases may introduce incompatible changes; patch releases
remain compatible. From `1.0.0` onward:

- Patch: compatible fixes.
- Minor: compatible functionality.
- Major: incompatible public contracts, stored-data formats, or operator interfaces.

Protocol, API, content, tuning, and database versions are
[independent contracts](../architecture/README.md); update them when their
boundaries change. Deploy central and community servers from the same release
unless its notes document compatibility across releases.

Make and Docker builds embed the product version from `package.json` in both Go
binaries. Direct `go build` / `go run` invocations report `dev` unless the release
version is supplied through `-ldflags '-X baboreborn/backend/release.Version=0.1.0'`.
The version is diagnostic metadata; it never grants gameplay compatibility.

## Prepare a release

1. Prepare a pull request to `main`. Set the intended version with
   `npm version 0.1.0 --no-git-tag-version --ignore-scripts` if needed, and commit
   both npm manifests.
2. Add `docs/releases/0.1.0.md` for that version: player/operator changes,
   compatibility, upgrade requirements, and known limitations. GitHub appends
   generated contributor and pull-request notes.
3. Run `make check` and `make test-docker`. Record browser observations and human
   playtesting separately, especially for input, simulation, networking, and
   rendering changes.
4. Review and merge the pull request; wait for `main` quality checks to pass.
5. From a clean checkout, select the intended `main` commit and create an annotated
   tag. Replace the example version throughout:

   ```sh
   git switch main
   git pull --ff-only origin main
   git tag -a v0.1.0 -m "BaboReborn 0.1.0"
   node scripts/release/validate.mjs v0.1.0
   git push origin refs/tags/v0.1.0
   ```

Pushing the tag publishes the release. Push only the intended tag; never move or
reuse a published tag. Fix a bad release with a new version. This workflow supports
releases without prerelease suffixes from mainline, without parallel maintenance branches.

## Automated publication

The [release workflow](../../.github/workflows/release.yml):

1. Requires an annotated release tag matching both manifests, checked out at its
   tagged commit, included in `origin/main`, with nonempty release notes.
2. Runs the full quality gate, including Chromium tests.
3. Rejects an existing GitHub Release; builds both Docker images and tests them
   with browser and persistence checks.
4. Pushes those exact images as version-specific `baboreborn-central` and
   `baboreborn-server` tags on Docker Hub, without floating aliases.
5. Creates a GitHub Release with authored/generated notes and `images.txt`,
   recording the source commit and image digests.

Only publication has repository write permission. Checkout does not persist
credentials; pull-request checks use read permission and no repository secrets.
Third-party Actions are commit-pinned and updated by Dependabot.

Publication does not deploy servers; follow [deployment](../deployment/DEPLOYMENT.md).

Publication is not atomic: failure can leave images without a GitHub Release.
After fixing infrastructure, retry the failed publication job for the unchanged
tag only while no Release exists. Retries may replace incomplete image tags;
pin the digests attached to the completed Release. Once a Release exists, publish
a new version. GitHub release immutability does not cover Docker Hub tags.

## GitHub setup before opening contributions

Run the quality workflow before selecting its required check on GitHub.

- Make `main` the default branch. Enable squash merging and automatic deletion of
  merged branches; disable merge commits and rebase merging.
- Protect `main` with an active ruleset: require pull requests, the quality
  workflow's `check` status, an up-to-date branch, and resolved discussions;
  block deletion and force pushes. Restrict bypass privileges. Require one
  approval when another maintainer can also review the owner's pull requests.
- Protect `v*` tags: restrict creation to release maintainers and block updates
  and deletions. Separate creation privileges from update/deletion bypass.
- Set `DOCKERHUB_USERNAME` and `DOCKERHUB_TOKEN` Actions secrets with push access
  to the namespace's `baboreborn-central` and `baboreborn-server` repositories.
- Keep default Actions permissions read-only, disable Actions approving pull
  requests, and require approval for outside-contributor workflows.
- Enable private vulnerability reporting, Dependabot alerts, secret scanning,
  and push protection where available. Consider immutable GitHub Releases before
  the first release.
- Enable Issues; label bounded starter tasks `good first issue` or `help wanted`.
  Add `CODEOWNERS` when review ownership is shared by area.

Before publication, review tracked files and Git history for credentials, private
data, and asset provenance. Ignore rules do not remove committed files.

GitHub administration references: [rulesets](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/creating-rulesets-for-a-repository),
[releases](https://docs.github.com/en/repositories/releasing-projects-on-github/managing-releases-in-a-repository),
and [private vulnerability reporting](https://docs.github.com/en/code-security/how-tos/report-and-fix-vulnerabilities/configure-vulnerability-reporting/configure-for-a-repository).
