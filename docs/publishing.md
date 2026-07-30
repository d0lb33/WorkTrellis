# Publishing

## Repository setup

1. In the npm package settings, configure a GitHub Actions trusted publisher:
   - repository owner and name: `d0lb33/WorkTrellis`;
   - workflow filename: `publish.yml`;
   - allowed action: `npm publish`.
2. Enable GitHub private vulnerability reporting and branch protection.

The release workflow uses npm trusted publishing with OIDC. It has no
long-lived npm token and receives only `contents: read` and `id-token: write`.

## Release checklist

1. Confirm `npm view worktrellis version` does not already show the target.
2. Update `version` in `package.json`.
3. Move the changelog entries from `Unreleased` to the dated version.
4. Run:

   ```bash
   pnpm install --frozen-lockfile
   pnpm typecheck
   pnpm test
   pnpm build
   npm pack --dry-run
   ```

5. Inspect the packed file list and confirm `dist/`, `bin/`, `examples/`, and
   public docs are present.
6. Merge the release commit.
7. Create a GitHub release tagged exactly `v<package-version>`.

Publishing is then performed by `.github/workflows/publish.yml`. The workflow
verifies that the release tag matches `package.json` before invoking npm.
