<a id="readme-top"></a>

[![Tests][tests-shield]][tests-url]
[![Contributors][contributors-shield]][contributors-url]
[![Forks][forks-shield]][forks-url]
[![Stars][stars-shield]][stars-url]
[![Issues][issues-shield]][issues-url]
[![MIT License][license-shield]][license-url]

<div align="center">
  <h1>Kindrd</h1>
  <p>
    Your family, connected.
    <br />
    A self-hostable family tree with collaborative editing and a portable offline viewer.
    <br />
    <br />
    <a href="#getting-started"><strong>Get started &raquo;</strong></a>
    <br />
    <br />
    <a href="#about-the-project">View Screenshot</a>
    &middot;
    <a href="https://github.com/AMBIENTCORE/Kindrd/issues/new?labels=bug">Report Bug</a>
    &middot;
    <a href="https://github.com/AMBIENTCORE/Kindrd/issues/new?labels=enhancement">Request Feature</a>
  </p>
</div>

<details>
  <summary>Table of Contents</summary>
  <ol>
    <li>
      <a href="#about-the-project">About The Project</a>
      <ul>
        <li><a href="#built-with">Built With</a></li>
      </ul>
    </li>
    <li>
      <a href="#getting-started">Getting Started</a>
      <ul>
        <li><a href="#prerequisites">Prerequisites</a></li>
        <li><a href="#installation">Installation</a></li>
      </ul>
    </li>
    <li>
      <a href="#usage">Usage</a>
      <ul>
        <li><a href="#use-your-own-family">Use Your Own Family</a></li>
        <li><a href="#offline-viewer-and-backups">Offline Viewer And Backups</a></li>
        <li><a href="#privacy-and-access">Privacy And Access</a></li>
        <li><a href="#cloudflare-deployment">Cloudflare Deployment</a></li>
        <li><a href="#development-and-tests">Development And Tests</a></li>
      </ul>
    </li>
    <li><a href="#roadmap">Roadmap</a></li>
    <li><a href="#contributing">Contributing</a></li>
    <li><a href="#license">License</a></li>
    <li><a href="#contact">Contact</a></li>
    <li><a href="#acknowledgments">Acknowledgments</a></li>
  </ol>
</details>

## About The Project

[![Kindrd showing the fictional Example family and person details][product-screenshot]](images/screenshot.png)

*Every person, relationship, date, place and note in this screenshot is fictional.*

Kindrd helps you map family connections, keep track of the evidence behind them,
and record what changes as your research grows. Use it as a standalone offline
file, or host a shared tree for relatives on your own Cloudflare account.

- **Explore connections.** Search names and aliases, follow ancestors and
  descendants, or focus on a selected family branch.
- **Keep the context.** Attach evidence, sources and notes, mark uncertain facts,
  and review attributed before/after history.
- **Work together.** Compatible edits merge; conflicting changes are presented
  for review rather than silently overwritten.
- **Keep your own copies.** Download records as JSON or as a self-contained HTML
  viewer that works without a server or network connection.

**This repository contains fictional example data only.** Keep real family
records in ignored local files and your own private database, not in Git.

### Built With

[![JavaScript][javascript-shield]][javascript-url]
[![Node.js][node-shield]][node-url]
[![Cloudflare Workers][workers-shield]][workers-url]
[![Cloudflare D1][d1-shield]][d1-url]

The viewer embeds Dagre, Kiwi.js and Lucide for diagram layout and icons.
Playwright and Miniflare support the browser and Worker integration checks.

<p align="right">(<a href="#readme-top">back to top</a>)</p>

## Getting Started

The local preview runs on your machine and does not require a Cloudflare account.
Online shared hosting is optional.

### Prerequisites

- [Node.js](https://nodejs.org/) **22 or newer**, with npm.
- [Git](https://git-scm.com/) to clone the repository.
- A modern browser.

### Installation

1. Clone the repository.

   ```sh
   git clone https://github.com/AMBIENTCORE/Kindrd.git
   cd Kindrd
   ```

2. Install the pinned dependencies.

   ```sh
   npm ci
   ```

3. Start the local preview with the fictional starter family.

   **Starting with your own records instead?** Complete
   [Use Your Own Family](#use-your-own-family) before this first database start.

   ```sh
   npm run dev
   ```

4. Open <http://localhost:8788/family-tree/>. Enter any test email and the
   development password **`local-development-only`**.

The first run initializes a local D1 database. Later runs preserve existing
records instead of replacing edits. The development credentials are only for
the local preview; they are not production secrets.

<p align="right">(<a href="#readme-top">back to top</a>)</p>

## Usage

Search for a person to open their details, then use the view selector to explore
the whole tree, a family branch, ancestors or descendants. The toolbar provides
connection finding, organization, export and history controls.

Organize the whole tree or a selected family, and undo the last organization in
the current session. Shared layouts are saved for contributors; camera position
remains personal. Use refresh to fetch other people's accepted edits.

Facts can be marked uncertain without inventing exact dates or ages. Partnership
and co-parent links do not establish biological ancestry or marriage.

### Use Your Own Family

1. Copy [family-data.example.json](family-data.example.json) to
   `family-data.local.json` in the project root.
2. Replace the fictional people, relationships, notes and evidence with your own.
   Give every person and family a unique ID, point `focusPersonId` at an existing
   person, and keep relationship references consistent.
3. Build your viewer:

   ```sh
   npm run build
   ```

4. Open the generated `build/index.html`, or initialize a new local/shared
   database with the generated seed.

The build selects `family-data.local.json` when it exists and the fictional
example otherwise. Invalid private data stops the build; it does not silently
fall back to the example.

**Prepare your seed before the first database initialization.** Rebuilding does
not replace an existing database. To switch families, use a separate local
database/project rather than deleting an existing database without a backup.

Seed people and their initial note identities are protected from deletion.
Their facts and note text can be corrected; added relatives and notes can be
deleted. History retains corrected and deleted values.

### Offline Viewer And Backups

Run `npm run build`, then open `build/index.html` directly in your browser. The
page includes its libraries and needs no server. The root
[index.html](index.html) is a deliberately data-free source template, not the
standalone viewer to open.

- **Download family data** saves JSON records and their activity history.
- **Download standalone HTML** saves a portable copy of the current tree.
- **Load family data**, available in offline mode, previews a JSON snapshot
  before replacing local records while preserving compatible activity histories.
- Offline edits live in browser storage, not in the source files. Storage can be
  cleared or unavailable, so keep downloaded backups.

Review a JSON export before using it as your next `family-data.local.json` input.
An offline import does not update a hosted database. Hosted bulk imports and
activity deletion are not supported.

### Privacy And Access

**Real family data must never be committed.**

[.gitignore](.gitignore) excludes private inputs, `*.local.*`, environment files,
database files, backups, exports and the entire `build` directory. The committed
HTML contains no records or family-specific protected IDs; builds derive the
baseline protections from the selected input.

Store extra personal material in the ignored `backups` or `exports` directories.
Do not put real records, photographs, research notes, screenshots or passwords
in tracked example files, issues or pull requests. Inspect the staged contents
before publishing: ignoring a file does not remove it from existing Git history.

**Exports contain personal information, including historical values.** A
downloaded HTML file is neither encrypted nor protected by the hosted password.

Shared hosting uses a family password and a **self-reported email address**.
Email ownership is not verified; knowing the password does not establish a
person's identity. Do not present contributor emails as verified identities.

The server checks sessions, origins and CSRF tokens, throttles sign-in attempts,
and issues Secure, HttpOnly, SameSite cookies. Sessions last up to 14 days;
password/session-secret rotation invalidates prior sessions. The hosted page
does not store family records in local storage.

The Cloudflare account owner controls the database. Activity history is not a
tamper-proof audit log.

### Cloudflare Deployment

Shared hosting uses a Worker and a D1 database in **your own** Cloudflare account.

1. Authenticate and create a database.

   ```sh
   npx wrangler login
   npx wrangler d1 create kindrd
   ```

2. Copy [wrangler.example.jsonc](wrangler.example.jsonc) to
   `wrangler.local.jsonc`, which is ignored by Git. Replace the all-zero database
   ID with your database's ID and set `APP_ORIGINS` to your exact HTTPS origin.
   Choose a unique Worker name if required by your account.
3. Prepare your private input, build, and initialize the database.

   ```sh
   npm run build
   npm run db:migrate:remote
   npm run db:seed:remote
   ```

4. Enter both production secrets at Wrangler's hidden prompts.

   ```sh
   npx wrangler secret put FAMILY_PASSWORD --config wrangler.local.jsonc
   npx wrangler secret put SESSION_SECRET --config wrangler.local.jsonc
   ```

   Use a unique family passphrase of 16-256 characters and a cryptographically
   random session secret of at least 32 characters. Do not put their values in
   source files, command-line arguments, screenshots or commits.

5. Deploy.

   ```sh
   npm run deploy
   ```

Visit your Worker origin; it redirects to `/family-tree/`.

The example configuration is local-only scaffolding with no real account,
database ID, production hostname or password. Remote commands deliberately
require your ignored local configuration. Seeding initializes a database; it
does not synchronize later edits. Back up hosted records before schema changes.

### Development And Tests

```sh
npm test
npm run test:browser
npm run test:collaboration
```

- `npm test` builds with fictional example data and checks the record model,
  private-data build safeguards, and Worker/database behavior.
- `npm run test:browser` uses its own temporary local Worker/database to check
  sign-in, search, organization, exports, offline persistence and responsive
  layouts. Its default port is 8796.
- `npm run test:collaboration` uses a separate temporary local Worker/database
  and two browser sessions to check merging, conflict review, drafts, shared
  layouts and retries. Its default port is 8795.

Browser checks default to Microsoft Edge. Set `PLAYWRIGHT_CHANNEL` for another
installed Playwright channel, and pass a different unused port after `--` if
needed. Screenshots go only into the ignored `build` directory; these checks do
not connect to production.

Tests use the fictional example even when a private input exists. Run
`npm run build` again afterward to regenerate your own offline copy.

<p align="right">(<a href="#readme-top">back to top</a>)</p>

## Roadmap

- [x] Interactive family diagrams, search and relationship views.
- [x] Evidence, notes, uncertainty and attributed change history.
- [x] Standalone offline viewing and JSON/HTML exports.
- [x] Self-hosted shared editing with conflict review.
- [x] Automated model, build, Worker and browser checks.

Suggest improvements and follow feature discussions in the
[issue tracker][issues-url].

<p align="right">(<a href="#readme-top">back to top</a>)</p>

## Contributing

Bug reports, documentation improvements and focused pull requests are welcome.

1. Fork the repository and create a branch for your change.
2. Use fictional fixtures only. Do not include real family data, private exports,
   screenshots, passwords or deployment configuration.
3. Run `npm test`. For viewer or collaboration changes, also run the relevant
   browser checks.
4. Commit your changes and open a pull request describing the behavior and
   verification.

For ideas or questions, [open an issue][issues-url] before starting a large change.

<p align="right">(<a href="#readme-top">back to top</a>)</p>

## License

Kindrd's application code is distributed under the **MIT License**. See
[LICENSE](LICENSE).

Bundled libraries retain their own licenses. See
[THIRD_PARTY_NOTICES.txt](THIRD_PARTY_NOTICES.txt); those notices are also included
in generated standalone viewers.

<p align="right">(<a href="#readme-top">back to top</a>)</p>

## Contact

Maintainer: [AMBIENTCORE](https://github.com/AMBIENTCORE)

Project: [AMBIENTCORE/Kindrd](https://github.com/AMBIENTCORE/Kindrd)

Questions and bug reports: [GitHub Issues][issues-url]

<p align="right">(<a href="#readme-top">back to top</a>)</p>

## Acknowledgments

- [Best-README-Template](https://github.com/othneildrew/Best-README-Template) for
  the README structure and presentation.
- [Dagre](https://github.com/dagrejs/dagre) and
  [Kiwi.js](https://github.com/IjzerenHein/kiwi.js) for diagram layout.
- [Lucide](https://lucide.dev/) for the interface icons.
- [Playwright](https://playwright.dev/) and
  [Miniflare](https://github.com/cloudflare/workers-sdk/tree/main/packages/miniflare)
  for browser and Worker testing.
- [Shields.io](https://shields.io/) for the badges.

<p align="right">(<a href="#readme-top">back to top</a>)</p>

[tests-shield]: https://img.shields.io/github/actions/workflow/status/AMBIENTCORE/Kindrd/test.yml?branch=main&style=for-the-badge&label=tests
[tests-url]: https://github.com/AMBIENTCORE/Kindrd/actions/workflows/test.yml
[contributors-shield]: https://img.shields.io/github/contributors/AMBIENTCORE/Kindrd.svg?style=for-the-badge
[contributors-url]: https://github.com/AMBIENTCORE/Kindrd/graphs/contributors
[forks-shield]: https://img.shields.io/github/forks/AMBIENTCORE/Kindrd.svg?style=for-the-badge
[forks-url]: https://github.com/AMBIENTCORE/Kindrd/forks
[stars-shield]: https://img.shields.io/github/stars/AMBIENTCORE/Kindrd.svg?style=for-the-badge
[stars-url]: https://github.com/AMBIENTCORE/Kindrd/stargazers
[issues-shield]: https://img.shields.io/github/issues/AMBIENTCORE/Kindrd.svg?style=for-the-badge
[issues-url]: https://github.com/AMBIENTCORE/Kindrd/issues
[license-shield]: https://img.shields.io/github/license/AMBIENTCORE/Kindrd.svg?style=for-the-badge
[license-url]: https://github.com/AMBIENTCORE/Kindrd/blob/main/LICENSE
[product-screenshot]: images/screenshot.png
[javascript-shield]: https://img.shields.io/badge/JavaScript-F7DF1E?style=for-the-badge&logo=javascript&logoColor=black
[javascript-url]: https://developer.mozilla.org/en-US/docs/Web/JavaScript
[node-shield]: https://img.shields.io/badge/Node.js-22%2B-5FA04E?style=for-the-badge&logo=nodedotjs&logoColor=white
[node-url]: https://nodejs.org/
[workers-shield]: https://img.shields.io/badge/Cloudflare_Workers-F38020?style=for-the-badge&logo=cloudflareworkers&logoColor=white
[workers-url]: https://developers.cloudflare.com/workers/
[d1-shield]: https://img.shields.io/badge/Cloudflare_D1-F38020?style=for-the-badge&logo=cloudflare&logoColor=white
[d1-url]: https://developers.cloudflare.com/d1/
