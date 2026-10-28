# Kindrd

A self-hostable family tree with an interactive diagram, evidence and notes,
attributed edit history, and a portable offline viewer.

The repository contains **fictional example data only**. Your records belong in
ignored local files and your own private database, not in Git.

## Quick start

Requires Node.js 22 or newer and npm.

```text
git clone https://github.com/AMBIENTCORE/Kindrd.git
cd Kindrd
npm ci
npm run dev
```

Open <http://localhost:8788/family-tree/>. Enter any test email and the local
development password `local-development-only`. No Cloudflare account is needed
for this local preview. The development credentials are not production secrets.

The first run initializes a local D1 database with the fictional starter family.
Subsequent runs preserve existing database records rather than overwriting edits.

For a standalone offline copy, run `npm run build` and open
[build/index.html](build/index.html) in your browser. The generated page includes
its libraries and needs no server or network connection. Do not open the root
[index.html](index.html) directly: it is a deliberately data-free source template.

## Use your own family

1. Copy [family-data.example.json](family-data.example.json) to
   `family-data.local.json` in the project root.
2. Replace the fictional people, relationships, notes and evidence with your own.
   Every person and family needs a unique ID, `focusPersonId` must name an existing
   person, and family references must refer to existing people.
3. Run `npm run build`. It selects the private local file when present; otherwise
   it uses the fictional example. Invalid private data stops the build rather
   than falling back to the example.
4. Open the regenerated offline viewer. Alternatively, use **Load family data**
   in an offline viewer to import an existing Kindrd JSON export.

Prepare your seed before the first hosted or local database initialization.
Rebuilding does not replace an already initialized database. To switch families,
use a separate local database/project rather than deleting an existing database
without a backup.

Offline edits live in browser storage, not in the source files. Download JSON
or a standalone HTML copy to back up your work. A downloaded JSON file can become
the next `family-data.local.json` input after you review it.

## Keep personal data private

- `family-data.local.json`, legacy `family-data.json`, `*.local.*`, environment
  files, database files, backups, exports and the entire `build` directory are
  ignored by Git.
- The committed HTML contains no records or family-specific protected IDs.
  Builds derive the baseline protections from your selected input.
- Generated offline HTML, SQL seeds and exported history **contain personal
  information**. A downloaded HTML copy is not encrypted or protected by the
  hosted password.
- Store additional personal material in the ignored `backups` or `exports`
  directories. Do not put family photographs, research notes, screenshots,
  passwords or real records in tracked example files.
- Inspect `git status` and the staged contents before publishing. Ignore rules
  do not remove data from existing commits; if a secret or record was committed,
  do not assume adding it to `.gitignore` makes the history private.

## Features and behavior

- Search names and aliases; inspect ancestors, descendants, or a family branch.
- Find recorded connections, organize all or part of the tree, and undo the last
  organization in the current session.
- Record uncertain facts without inventing exact dates or ages. Partnerships and
  co-parent links do not establish biological ancestry or marriage.
- Add relatives, correct facts, attach notes and evidence, and review attributed
  before/after history.
- Shared edits merge compatible changes and request explicit choices for
  conflicts. Only accepted changes create history entries.
- Seed people and their initial note identities are protected from deletion.
  Their facts and note text can be corrected; added relatives and notes can be
  deleted. Activity retains historical and deleted values.
- Offline JSON imports replace records while preserving compatible activity
  histories. Hosted bulk imports and activity deletion are not supported.
- The hosted page does not store family records in local storage. Shared layouts
  are saved; camera position remains personal. Use refresh to fetch others' edits.

## Shared hosting with Cloudflare

Hosting is optional. The shared mode uses a Worker and a D1 database.

1. Authenticate with Wrangler: `npx wrangler login`.
2. Create your own database: `npx wrangler d1 create kindrd`.
3. Copy [wrangler.example.jsonc](wrangler.example.jsonc) to
   `wrangler.local.jsonc`, which is ignored by Git. Replace the all-zero database
   ID with your database's ID and set `APP_ORIGINS` to your exact HTTPS origin.
   Choose a unique Worker name if required by your account.
4. Prepare your private input, then run `npm run build`,
   `npm run db:migrate:remote`, and `npm run db:seed:remote`.
5. Set both production secrets using Wrangler's hidden prompts:

   ```text
   npx wrangler secret put FAMILY_PASSWORD --config wrangler.local.jsonc
   npx wrangler secret put SESSION_SECRET --config wrangler.local.jsonc
   ```

   Use a unique family passphrase of 16-256 characters and a cryptographically
   random session secret of at least 32 characters. Do not put their values in
   source files, command-line arguments, screenshots or commits.

6. Run `npm run deploy`. Visit your Worker origin; it redirects to `/family-tree/`.

The example configuration is for local development and contains no real account,
database ID, production hostname or password. Remote commands deliberately
require your ignored local configuration. Database seeding is for initialization,
not ongoing synchronization. Back up your hosted records before schema changes.

### Access model

Relatives enter a shared password and a **self-reported email address**. Email
ownership is not verified: possession of the password does not establish a
person's identity. Do not present contributor emails as verified identities.

The server checks sessions, origins and CSRF tokens, throttles sign-in attempts,
and issues Secure, HttpOnly, SameSite cookies. Sessions last up to 14 days;
password/session-secret rotation invalidates prior sessions. The Cloudflare
account owner controls the database, so history is not a tamper-proof audit log.

## Development and tests

```text
npm test
npm run dev
```

Tests always build with fictional example data, even when a private input exists.
Run `npm run build` again afterward to regenerate your own offline copy.

`npm run test:browser` creates its own temporary local Worker/database and checks
sign-in, search, organization, export, offline persistence and responsive layouts.
It defaults to Microsoft Edge; set `PLAYWRIGHT_CHANNEL` for another installed
Playwright channel. Its default port is 8796; pass a different unused port after
`--` if needed.

`npm run test:collaboration` creates its own temporary local Worker/database and
two browser sessions to check merging, conflict review, drafts, shared layouts
and retries. Screenshots are written only into the ignored `build` directory.
Neither test command connects to production.

## License

Kindrd's application code is available under the [MIT license](LICENSE).
Bundled libraries retain their own licenses; see
[THIRD_PARTY_NOTICES.txt](THIRD_PARTY_NOTICES.txt). Those notices are included in
generated standalone viewers.
