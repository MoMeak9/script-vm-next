# Releasing script-vm-next

The release target for this milestone is `0.2.0-beta.1`. Package validation, browser validation, Pages deployment, and registry publication are separate operations. A passing build does not prove that npm publication or Pages deployment has occurred.

## Maintainer prerequisites

1. Confirm the package name and publishing rights on npm. The workflow targets the public package `script-vm-next` on `https://registry.npmjs.org`.
2. Select the project's license, add the complete `LICENSE` text, and update `package.json` from `UNLICENSED`. This is a copyright-holder decision. The workflow intentionally refuses to publish while the decision is pending.
3. Create a GitHub Actions environment named **`npm`** under repository Settings → Environments. Restrict it to release tags and, if appropriate for your project, require a maintainer review. The workflow's `environment: npm` must match the npm Trusted Publisher settings exactly.
4. Configure an npm **Trusted Publisher** for the package: provider **GitHub Actions**, owner **`MoMeak9`**, repository **`script-vm-next`**, workflow filename **`release.yml`**, and environment **`npm`**. These identifiers are case-sensitive where enforced by the service. Use the workflow filename, not its display name or a filesystem path.
5. Ensure Actions can run in the repository and that the chosen ref contains the release workflow. OIDC publication runs on GitHub-hosted Ubuntu runners with `id-token: write` and npm **11.5.1 or newer**.

Publishing credentials belong in npm's secure login flow or GitHub's environment/secret settings. Do not put tokens in source files, `.npmrc`, issues, or chat. The normal release workflow uses OIDC and does not need `NPM_TOKEN` or `NODE_AUTH_TOKEN`.

The package's `repository` URL must match the GitHub repository. Public npm publication with `--provenance` also requires a supported public source repository. The release workflow is intended for this public GitHub project.

## First publication when the package does not yet exist

npm Trusted Publisher configuration is normally attached to an existing package. If the package does not yet exist and npm does not offer its publisher configuration, an authorized maintainer must establish the initial package using npm's secure authentication before switching subsequent versions to OIDC.

On a trusted maintainer machine, check out the reviewed release commit and run all validation commands below. Log in interactively with `npm login --registry=https://registry.npmjs.org`, complete the account's required two-factor authentication, then publish the **verified tarball**, for example:

```sh
npm publish artifacts/script-vm-next-0.2.0-beta.1.tgz --access public --tag beta --ignore-scripts --registry=https://registry.npmjs.org
```

Do this only after the license decision is complete and the manifest and tarball contain that license. The local initial-publication path does not create a GitHub Actions provenance attestation; subsequent releases use the OIDC workflow with provenance. Configure the Trusted Publisher immediately after the initial package exists. An already published version cannot be published again; the next automated release needs a new version, such as `0.2.0-beta.2`.

If a Trusted Publisher can already be configured for the package, use the automated workflow directly instead of the bootstrap path. This setup does not request or create registry credentials automatically.

## Validate a release

Use Node.js 24 and pnpm 10.34.6:

```sh
pnpm install --frozen-lockfile --ignore-scripts --registry=https://registry.npmjs.org
pnpm build
pnpm lint
pnpm typecheck
pnpm test:unit
pnpm test:package
pnpm exec playwright install --with-deps chromium
pnpm test:e2e
```

The independent consumer check packs with lifecycle scripts disabled, checks the archive file list, installs it into a temporary production consumer, verifies named ESM and CommonJS imports, checks strict TypeScript declarations, compiles through both public entry points, and executes the installed CLI. The verified archive is saved as `artifacts/script-vm-next-<version>.tgz`.

`pnpm test:e2e` builds the production playground and tests its project-subpath deployment, compilation, execution, diagnostics, limits, stopping and recovery, and selected isolation boundaries in Chromium. Keep the compatibility document and example expectations aligned with these checks. A passing suite only establishes the cases it exercises.

## Automated version release

1. Update `package.json` and `src/version.ts` to the same intended version; the build checks that they match. Update the lockfile as needed, along with release notes and relevant docs. Do not reuse an already published npm version.
2. Review and merge the changes through the MR. Confirm CI has passed on the commit to be released.
3. Create and push a matching tag, for example `v0.2.0-beta.2`, on that reviewed commit. This is the publication action: it triggers `.github/workflows/release.yml`.
4. Review any configured `npm` environment approval, then monitor the workflow. Verify the registry version, its provenance, dist-tags, and a clean installation.

The workflow checks that the tag equals `v` + `package.json.version`, requires an approved license and `LICENSE`, and runs the reusable CI workflow. The publish job downloads the same tarball that the independent consumer tests verified. It publishes that artifact with `--ignore-scripts`, `--access public`, and `--provenance`; it does not rebuild it after validation.

Every prerelease version, including `0.2.0-beta.1`, is published to the **`beta`** dist-tag. Only a version without a prerelease suffix is assigned **`latest`**. Promoting a beta to a stable release requires a deliberate new stable version and matching tag; a beta tag must not replace `latest`.

Verify using the exact released version:

```sh
npm view script-vm-next@0.2.0-beta.2 version dist.integrity --registry=https://registry.npmjs.org
npm dist-tag ls script-vm-next --registry=https://registry.npmjs.org
```

Inspect provenance on the package's npm page and test a fresh consumer installation. Preserve the release tag and workflow run so consumers can trace the artifact to its source commit.

## GitHub Pages releases

See [playground deployment](playground.md). The Pages workflow publishes the validated static demo on a `main` push or manual workflow dispatch. A **`demo-v*`** tag can deploy a specifically reviewed demo commit before its MR is merged; for example `demo-v0.2.0-beta.1`. That tag does not trigger the npm workflow, which only matches `v*` tags.

The page displays its package version and source commit. `main` may contain unreleased changes, so the displayed npm version alone does not prove parity with a registry release; use the commit identifier or deploy the exact release commit. If npm and the demo must match strictly, dispatch Pages at that release ref.

## Troubleshooting

- **License gate failed:** select the license through the copyright holder and include its text. Do not remove the gate or publish an `UNLICENSED` artifact to get a green run.
- **Tag mismatch:** tag the commit whose manifest has the desired version; do not publish a differently versioned archive under the tag.
- **OIDC authentication failed:** check npm's exact owner, repository, workflow filename, environment, the workflow's `id-token: write` permission, GitHub-hosted runner, npm version, and package ownership. GitHub checkout access does not establish npm publishing rights.
- **Provenance failed:** check repository visibility, the manifest's repository URL, and npm/GitHub OIDC requirements. Preserve the provenance requirement for automated releases.
- **Version already exists:** npm versions are immutable. Inspect the published version and bump the next release instead of repeatedly rerunning the same publish.
- **Pages failed:** first check validation, then Pages' Actions source and the `github-pages` environment's allowed deployment refs. The demo requires its configured `/script-vm-next/` base path.

References: [npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers/), [npm provenance](https://docs.npmjs.com/generating-provenance-statements/), and [GitHub custom Pages workflows](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages).
