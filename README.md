# Bratislava Lead Pipeline (Google Apps Script)

Runs inside your "Leads" Google Sheet. It finds local businesses with the
Google Places API and adds them to the sheet. Later stages will check their
websites, score them, and write Slovak call briefs.

**Built so far:** Stage 1, which finds businesses and adds them to the Leads tab.

- The code is in `apps-script/Code.gs`, a single file you paste into the sheet.
- **Live install:** the "leads" sheet of rsezganov@gmail.com, daily run ON. To deploy code changes: `cd apps-script && clasp push --force` (no pasting needed; `.clasp.json` points at the bound script).
- Local tests: `node --test apps-script/test/code.test.js` (no live API calls).
- The Python files (`run.py`, `leads/`, `tests/`) are from the earlier approach and are not used.

## Install (once)
1. Get a Google API key:
   1. At https://console.cloud.google.com, create a project and turn on **billing**.
   2. Under **APIs & Services → Library**, enable **Places API (New)**.
   3. Under **Credentials → Create credentials → API key**, create a key.
   4. Optional but recommended: restrict the key to Places API (New). Under **Places API (New) → Quotas**, set *Text Search requests per day* to 100.
2. In the sheet, open **Extensions → Apps Script**.
3. Delete the sample code, paste in all of `apps-script/Code.gs`, and save (Ctrl+S).
4. Reload the sheet. A **Lead pipeline** menu appears.
5. Run **Lead pipeline → 1. Set Google API key**. The first time, Google asks you to authorize the script: click **Continue**, choose your account, then **Advanced → Go to (project) → Allow**.
6. Run **Lead pipeline → 2. Check setup**. Every line should show ✔.

## Use
- **Find leads: 1 search (test)** runs one Places request and adds the new businesses.
- **Find leads: full run** runs the next 30 searches in the rotation.
- **Turn on daily run** runs a full run every day around 7:00 without your computer. If a run fails, Google emails you.
- Each run adds a line to the **Runs** tab.

## Rules the script follows
- New businesses are added as new rows. Duplicates are skipped by Place ID. No row is ever deleted.
- Yellow header = your column: Status, Next action date, Call outcome, Notes, Last contacted. The script never writes to these, except setting Status to "New" when it adds a row.
- Columns are matched by header name, so you can reorder them or add your own.

## Costs (kept at €0)
Hard limits set in Google Cloud (project `project-23222bf3-aa40-487b-a97`):
- **Places Text Search: max 32 requests/day.** Google blocks anything above this. 32 × 31 days = 992, under the free 1,000/month for Text Search Enterprise.
- **All other Places methods: 0/day** (blocked, not used), including the media, review-post and user-content methods.
- **The API key only works for** Places API (New) and PageSpeed Insights (PageSpeed is free).
- **Unused default services are disabled** (BigQuery, Cloud Storage, Datastore, etc.). Only Places, PageSpeed, budgets, logging/monitoring and service management stay on.
- Apps Script, Sheets and clasp are free.
- **Budget alert:** a €1 budget emails you if any charge appears.

In the script:
- 30 searches per daily run. The whole city (221 searches) is covered in about 8 days.
- A monthly cap of 900 is set in `CONFIG`.
- The "Check setup" test uses an IDs-only request, which is in Google's free tier.

## Data protection (GDPR)
- Only what's needed for calling is stored: business name, public business phone, address, website, rating, review count and Google place ID.
- No reviews, reviewer names, owner names or emails are collected.
- If someone asks not to be contacted, set Status to "Do not contact". The row stays, so the business is never re-added.
