# Browser playground

The playground is a static Vite/TypeScript application deployed by GitHub Actions to [GitHub Pages](https://momeak9.github.io/script-vm-next/). It uses the same source compiler as the npm `@momeak/script-vm-next/core` entry and displays the package version and source commit for traceability.

## Use it

Choose an example or enter a standalone script, compile it, inspect the output, then run the generated program. The ES6 compatibility example demonstrates automatic iterable destructuring, default-parameter scope, class static inheritance, and template-object reuse and freezing; no source rewrites or extra build configuration are required. Console output appears below the editor. You can stop a run, restore the example, copy the generated code, or download it. Compile diagnostics include the error code and source position when the compiler provides one. The output panel reports compilation time, generated output size, bytecode length, and function count.

Compilation and execution happen in the browser; the application has no compiler server and does not upload source code. Static application assets are loaded from the hosting site. This first version accepts one JavaScript script and produces an IIFE. The editor does not provide a filesystem, dependency installation, module imports/exports, `require`, dynamic `import()`, or DOM access during execution. Those restrictions are narrower than the Node file API's capabilities.

The [compatibility matrix](compatibility.md) applies to the compiler in the playground. An example working in the browser does not establish full support for that language feature. Use the Node file API when testing supported local module bundles.

## Isolation and limits

Compilation runs in a dedicated, terminable worker. Each execution uses a fresh worker hosted inside an iframe with `sandbox="allow-scripts"` and no `allow-same-origin`, giving it an opaque origin. The runner has its own Content Security Policy that denies network connections and restricts executable resources. The parent validates the iframe source, opaque origin, message token, and message shape before displaying results. Console values are displayed as text.

The compiler output itself does not contain these isolation controls. Downloaded code executes with its host's globals and permissions. Do not treat virtualization as a security boundary or execute arbitrary downloaded code in a privileged Node.js process.

The demo bounds source input, compilation time, generated code size, execution duration, and retained console output. Stop and timeout dispose of the current execution context so a new run can start. These controls make the interactive demonstration usable; they do not establish browser-engine-level memory isolation or a general service for executing hostile workloads. Asynchronous output is limited to the demo's run lifetime; it is not a long-running application host.

The Playwright suite exercises the deployed subpath, regular examples, diagnostic handling, stop/timeout recovery, output bounds, and selected network/DOM isolation behaviors. Use that suite when changing worker creation, the runner CSP, iframe flags, or message validation. Do not weaken the sandbox to work around a broken example.

## Local development

Use Node.js 20.19+, 22.13+, or 24, and pnpm 10.34.6:

```sh
pnpm install --frozen-lockfile --ignore-scripts --registry=https://registry.npmjs.org
pnpm demo:dev
```

Use the URL printed by Vite; the project's base path is `/script-vm-next/`. To verify the generated static site:

```sh
pnpm demo:build
pnpm demo:preview
```

The deployable files are written to **`demo-dist/`**. Compiler library output uses **`dist/`**; these directories serve different purposes. Worker and runner URLs must continue to resolve below the configured Vite base path. A site that works at `/` alone has not been tested for GitHub project Pages.

Run the browser suite:

```sh
pnpm exec playwright install --with-deps chromium
pnpm test:e2e
```

The Playwright configuration builds the demo and starts its own preview server at `http://127.0.0.1:4173/script-vm-next/`. It uses one browser worker to keep execution-limit tests predictable and saves traces/screenshots on failure. `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` can point to an existing Chromium executable in a local environment; CI installs Playwright's matching Chromium version.

## GitHub Pages setup

1. In repository Settings → Pages, choose **GitHub Actions** as the build and deployment source.
2. Ensure the repository permits the official Pages actions. The workflow uses `actions/configure-pages`, `actions/upload-pages-artifact`, and `actions/deploy-pages`.
3. Ensure the **`github-pages`** environment permits deployment from `main` and, if using demo tags, `demo-v*`. Keep any desired maintainer review rules in that environment.
4. Merge the workflow to `main`, run it manually on an available ref, or push an authorized `demo-v*` tag containing the workflow. Do not confuse that deployment tag with the npm `v*` release tags.
5. Wait for all validation and deployment jobs, then check the Pages URL and execute an example there. Inspect browser console/network failures as well as the workflow status.

`.github/workflows/pages.yml` calls the reusable CI workflow before deploying. CI builds the library, runs the compiler tests on Node.js 20/22/24, and on Node.js 24 runs lint, type checks, independent npm package checks, and production browser tests. Pages downloads the validated `verified-playground` artifact and deploys it unchanged. The deployment job has only the Pages and OIDC permissions it needs, uses the `github-pages` environment, and reports its URL through the workflow environment.

The configured project base is `/script-vm-next/`. Renaming the repository, deploying to a user-root site, or adding a custom domain can require changing the Vite base and updating the browser test URL. Rebuild and rerun the browser suite after such a change.

The default `main` deployment can include changes newer than the latest npm package. The page's source commit identifies what it runs. To keep a demonstration aligned with a release, deploy that release's exact commit and verify the displayed version/commit afterward.

## Search and AI discovery

The public landing page contains its project description, usage steps, frequently asked questions, compatibility limits, and documentation links in the initial HTML. Search crawlers and readers do not need to initialize the editor or execute user code to read that information. Its canonical URL is `https://momeak9.github.io/script-vm-next/`; the page also supplies social-sharing metadata and structured data that describe the visible application and its limits.

The static build includes two discovery files under the same project base:

- [`sitemap.xml`](https://momeak9.github.io/script-vm-next/sitemap.xml) lists the canonical public landing page. It excludes URL fragments, the internal execution runner, and invented modification dates.
- [`llms.txt`](https://momeak9.github.io/script-vm-next/llms.txt) summarizes the project and points to the source documentation, compatibility matrix, and release status. It is an optional discovery convention, not a standardized guarantee that an AI service will read or cite the project.

The internal `runner.html` carries a `noindex, nofollow, noarchive` robots meta tag. It is an execution implementation detail rather than a separate public tool page. GitHub project Pages lives below `/script-vm-next/`, while crawlers discover robots policy at the origin's `/robots.txt`. A file at `/script-vm-next/robots.txt` cannot set that origin policy, so the project does not publish one or claim to control `https://momeak9.github.io/robots.txt`. If the site moves to a dedicated domain, configure its root robots policy there and reference the sitemap's new absolute URL.

Keep the canonical URL, Open Graph URLs, structured data, sitemap, and `llms.txt` links aligned when changing the domain, repository name, public description, or release status. Discovery metadata describes the same visible content as the page; it must not claim complete JavaScript conformance, a published npm package, or isolation in downloaded output. These changes improve access to accurate information; they do not guarantee search ranking, indexing, or AI citations.

The social-sharing image is `demo/public/images/social-preview.png` (1200 × 630); its editable SVG source is alongside it. When updating the artwork, render the SVG at its original dimensions and replace the PNG too, because social platforms vary in their SVG preview support. The page favicon is served from `demo/public/favicon.svg`.

## WeChat follow card

The landing page displays a public-account QR code with a text explanation and a direct image link for saving or opening it on a phone. The image is hosted with the static application at `images/wechat-qrcode.jpg`; showing the card does not contact WeChat, add analytics, upload source code, or alter the execution runner's isolation policy. Following the account is optional and is not required to compile or run a program.

When replacing the QR code, update the source asset at `demo/public/images/wechat-qrcode.jpg`, preserve its readable quiet zone, and confirm the account destination by scanning the resulting production image. Rebuild and check both mobile and desktop layouts. The card and discovery changes become public through the existing Pages workflow after the MR is merged to `main`; opening the MR alone does not deploy them.
