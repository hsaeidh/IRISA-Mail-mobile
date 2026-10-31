# Upstream maintenance

Upstream: https://github.com/bulwarkmail/native

## Branch roles

- `upstream-sync`: clean mirror of upstream `main`; the scheduled workflow may force-update this branch.
- `development`: IRISA changes and the target of upstream integration PRs.
- `main`: stable, tested IRISA release branch.

Do not commit IRISA changes to `upstream-sync`. Do not make `development` or `main` the target of a force push.

## Automated update

Run **Actions → Sync upstream Bulwark → Run workflow**, or wait for the weekly schedule. The workflow fetches upstream `main`, updates `upstream-sync`, and opens/updates a PR into `development`. It does not merge automatically.

## Review checklist for each upstream PR

1. Read upstream release notes and commit range.
2. Inspect changes to authentication, OAuth redirects, JMAP, credential storage, push, Android services/manifest, iOS entitlements/extensions, Expo config plugins, and release workflows.
3. Resolve conflicts in `development`, preserving IRISA adapters/configuration.
4. Run `npm ci`, `npm run typecheck`, and `npm test`.
5. Build Android and iOS; verify OAuth, account switching, notification delivery, deep links, Persian RTL, and upgrade behavior on devices.
6. Merge only after required checks and review pass.
7. Record the upstream commit SHA in the IRISA release notes.

## Local Git commands (Windows CMD)

```bat
git remote add upstream https://github.com/bulwarkmail/native.git
git fetch upstream
git checkout upstream-sync
git reset --hard upstream/main
git push --force-with-lease origin upstream-sync
git checkout development
git merge --no-ff upstream-sync
```

The final merge command is intentionally manual. Review conflicts and run tests before pushing.
