# Live testing

The live tests have the real agent, on free models, do real tasks on real sites in your own Chrome. Each run is scored from what its run log shows it did, never from what the agent says it did.

The goal is that the agent can do what a person does with a browser: search, filter, compare, collect, save, sign in, and finish long multi-step jobs. The tests below are a **ladder**. The lower rungs are cheap, so they run constantly and widely. They exist to make the agent solid on the basics, so that the upper rungs tell you something. Nothing here says the tests should stop at the lower rungs.

## Running it

```sh
scripts/live.sh setup                      # build, load the extension, check the host and key
scripts/live.sh activities                 # one browse run on the next site in the rotation
scripts/live.sh activities --repeat 6      # six runs, six different sites
scripts/live.sh activities --site mercari.com --query "Ryzen 5 5600X"   # pin a site and part
NB_LIVE_LEADER=poolside/laguna-s-2.1:free NB_LIVE_FOLLOWER=poolside/laguna-s-2.1:free \
  scripts/live.sh activities               # another free model pair
node scripts/harness/activities.mjs board  # model pair by site, from every saved run
```

Each run opens a fresh tab and closes it when the run ends. Results go to `runs/activities-<time>/`: the task, the live stream, the run log, and the scored report. Every run is also appended to `runs/history.jsonl`.

## What a run does

### Rung 1: `browse`, go to a URL and click

This is the floor: any site, one search, one listing. It is what almost every other task is built from, so if it is flaky nothing above it can be trusted.

1. Open a site from `scripts/harness/sites.json`. It lists 245 sites that sell used computer parts: marketplaces, refurbishers, surplus and liquidation sites, enthusiast forums, and retailers' renewed sections, across more than 25 countries.
2. Use the site's own search to look for a part: DDR4 or DDR5 RAM, a GPU, a CPU, an SSD, a ThinkPad or an OptiPlex.
3. Open one listing.
4. Call `done` with only `{"title", "price", "url"}`.

**Rotation.** Each run goes to the operator tested least recently. Every country domain of one operator counts as one site, so eBay.com, eBay UK and eBay.de are one. A long series spreads across the whole list instead of returning to the same few sites, and no single account or site sees a pattern of repeated automated visits. The part rotates too.

### Rung 2 and up: multi-step jobs

These are the real tests of the product. They exist today for eBay, and run by name (`scripts/live.sh activities ebay_compare,ebay_csv`):

| Activity | What it asks of the agent |
|---|---|
| `ebay_compare` | apply eBay's own Buy It Now and price filters, open three listings, read title, price, shipping and seller, report JSON |
| `ebay_csv` | extract every listing on a results page with a userscript and save it as a CSV (checked on disk: 60 rows) |
| `ebay_sold_median` | use the Sold Items filter across two pages and work out the median |
| `ebay_watchlist` | read a signed-in watchlist without changing it |

The last two need the Chrome profile signed in to eBay: eBay sends a signed-out visitor to sign-in, behind a CAPTCHA. Until that profile is signed in, these two come back **invalid**, which is a fact about the setup, not a verdict on the agent.

**What to build next.** None of this is built yet, and the order is not fixed. Each item is a multi-step job on any of the 245 sites, scored by the same run-log method:

- **Filter and sort:** apply a condition, a price cap and a sort order through the site's own controls, and prove from the URL or the page that they applied (#51).
- **Compare across sites:** find the same part on three different sites and report the cheapest with shipping.
- **Collect:** walk several pages of results into a file, with a count, deduplicated.
- **Cart and forms, up to checkout:** add to a cart, fill an address form, stop before paying. Test credentials and addresses only.
- **Sign-in:** reuse the current session, and complete a sign-in the user has authorized.
- **Recover:** a task that starts behind a cookie banner, a modal, or a moved search box.
- **Long runs:** 40 or more steps, with replans, where the cost and the cache share matter.

Start a new activity as a rung-1 `browse` on the same site if that is quicker to get working, then climb.

## How a run is scored

`browse` is scored as a ladder, so a failed run shows how far it got:

| Checkpoint | What counts |
|---|---|
| reached the site | a page on the site's host |
| searched | a results page that carries the query, or the query typed into a field |
| opened a listing | a product-shaped page (`/dp/`, `/itm/`, `/item/`, `/products/`, `/s-anzeige/`, `/threads/`...) after the results, or any new path that is not a results page |
| reported JSON | `done` summary parses, with title, price and url |
| **grounded** | the reported listing is one it visited, matched by listing id (ASIN, numeric id), so a trimmed tracking suffix still matches and a different product does not |
| price | a number above 0 |
| right part | the title has most of the query's distinctive words (a Ryzen 7 5800X is not a Ryzen 5 5600X) |
| ended done | the run ended `done` |

**Invalid** means the run says nothing about the model: it ended behind a bot wall or CAPTCHA, the site was unreachable, or the model provider rate-limited it (429). Invalid runs are kept out of pass rates.

## Telemetry

**Live:** one line per step, with role, tool, arguments, tokens in and cache share, tokens out, latency and any tool error. Each new page prints its URL and snapshot size.

**Per run:**
- calls, tokens, cache share and model id per role
- steps, seconds, and gaps over 30 s between model calls
- tool errors and repeated identical calls
- tool results over 20k characters fed to the model
- the pages visited
- the change since the last run on the same site

**Not yet:** a screenshot per step (#50), and any sign of life during a long model call (#52).

## Models

Agent-initiated runs use free OpenRouter models only. Before adding a pair, probe each model with one tool-call request. `thinkingmachines/inkling` returns 403 ("only available on agentic harnesses"), and some free models 429 for long stretches. Compare pairs with `board`, never by reading logs.

Results on 2026-10-12 (small samples):

| Leader + Follower | Valid passes | Mean score | Calls/run | Tokens in/run |
|---|---|---|---|---|
| laguna-s-2.1 + laguna-s-2.1 | 2/2 | 100% | 10 | 96k |
| nemotron-3-ultra + nemotron-3-super | 2/3 | 73% | 19 | 250k |
| gemma-4-31b + gemma-4-26b | 1/2 | 90% | 9 | 90k |
| nemotron-3-ultra + nemotron-3.5-lightning (default) | 2/13 | 48% | 19 | 207k |

The default pair's 13 runs include six on the build before the fixes below.

## Rules for whoever works on this

- **A recoverable error must not end a run.** That covers a failed screenshot, a swapped tab id, one 429, and two failed clicks: each is information for the agent, not a verdict. Each of those ended runs at some point and was fixed. Treat any new one as a product bug.
- **Check the scorer before blaming the model.** Rescore with `board` and read the run log. The scorer was wrong four times on 2026-10-12 (Amazon product URLs carry the search keywords, Kleinanzeigen's results path, trimmed listing URLs, wrong-part listings), and every fix is pinned by a test in `tests/activities.test.ts`.
- **Keep climbing.** Rung 1 is cheap and runs often and broadly, and that is all it is for. A day with only rung-1 results has not tested the agent's real work. Add the next harder activity when the current one passes, and write down what the failures showed.
- **Breadth and depth both.** Spread the cheap runs across sites and models, and the deep ones across the hardest jobs. Do not run the deep jobs on one site over and over: that is how you get an account flagged.
- **Paste real output** when reporting a result: the report lines, the board, the run id.

## Product bugs these runs found

| Found live | Fixed by |
|---|---|
| a tab id swap made every page op fail with `No tab with id` | following `chrome.tabs.onReplaced` |
| a stalled `captureVisibleTab` ended the run at step 0 | a failed screenshot costs one observation |
| Enter in a search box never submitted (untrusted keydown has no default action) | Enter submits the form via `requestSubmit` |
| clicks refused as "occluded by another element", with no way to tell what was in the way | the error names the cover and its ref |
| every run asked for JSON answered in prose | `done.summary` describes the result, in the format asked |
| two identical failures ended the run | they hand back to the Leader first |
| one free-tier 429 ended the run after 0 to 4 steps | 429s are retried with backoff |
| test tabs were never closed | the `closeTabWhenDone` run option |
