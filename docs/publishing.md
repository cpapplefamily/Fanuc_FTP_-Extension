# Publishing a release

GitHub Actions builds the extension and creates a GitHub Release. The `.vsix` from that release is uploaded to the Visual Studio Marketplace by hand. No token, Azure subscription, or secret is needed.

| Workflow | Runs when | Does |
|---|---|---|
| [CI](../.github/workflows/ci.yml) | Any push or pull request | Lint, snippet tests, test package (download it from the run's **Artifacts**) |
| [Release](../.github/workflows/release.yml) | A `v*` tag is pushed | The same checks, checks the tag matches `package.json`, creates a GitHub Release with the `.vsix` and the CHANGELOG notes |

## Version numbers

The Marketplace accepts only `major.minor.patch` versions (no `-dev` suffix).

| Minor number | Example | Published as |
|---|---|---|
| Even | `0.10.0`, `0.10.1`, `0.12.0` | Stable release (everyone gets it) |
| Odd | `0.11.0`, `0.11.1`, `0.13.0` | Pre-release (only users who choose **Switch to Pre-Release Version**) |

Local test builds can keep the `-dev` suffix (`vsce package`); they are never released.

## Steps

1. Set the version: `npm version 0.10.1 --no-git-tag-version` (updates `package.json` and `package-lock.json`).
2. In `CHANGELOG.md`, add a `## [0.10.1] - YYYY-MM-DD` section. Its text becomes the release notes.
3. Commit and push to `main`.
4. Tag and push the tag:

   ```powershell
   git tag v0.10.1
   git push origin v0.10.1
   ```

5. On GitHub, open **Actions → Release** and wait for the green check. Then open **Releases → Robot FTP 0.10.1** and download `robot-ftp-0.10.1.vsix`.
6. Go to [Marketplace publisher management](https://marketplace.visualstudio.com/manage/publishers/CoreyApplegate), click **···** next to **Robot FTP** → **Update**, and choose the `.vsix`. The new version appears for users after the Marketplace verifies it (usually a few minutes).

## If the Release run fails

Nothing is published. Fix the problem, then move the tag:

```powershell
git tag -d v0.10.1
git push origin :refs/tags/v0.10.1
# fix, commit, push, then tag again
git tag v0.10.1
git push origin v0.10.1
```

A version number can be uploaded to the Marketplace only once. If a bad version was uploaded, release the next patch version.
