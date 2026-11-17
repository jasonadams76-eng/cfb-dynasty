# CFB Dynasty Online: deploy guide

You do this once. It uses a free Cloudflare account. Run every command in a terminal (PowerShell is fine) inside this `mp` folder.

## 0. One-time prerequisites
1. Install Node.js (LTS) from https://nodejs.org if `node -v` does not print a version.
2. Create a free account at https://dash.cloudflare.com/sign-up (no credit card needed).

## 1. Go to the folder
```
cd "C:\CFB Dynasty Game\mp"
```

## 2. Install the Cloudflare tool and sign in
```
npm install
npx wrangler login
```
A browser tab opens. Click Allow.

## 3. Create the database
```
npx wrangler d1 create cfb-dynasty
```
The output contains a line like `database_id = "xxxxxxxx-xxxx-..."`.
Open `wrangler.toml` in Notepad and replace `PASTE-YOUR-DATABASE-ID-HERE` with that id. Save.

## 4. Create the tables
```
npx wrangler d1 execute cfb-dynasty --remote --file schema.sql
```
Answer `y` if it asks to confirm.

## 5. Put the game in the site folder
Copy `dynasty.html` to `public\index.html` and `rosters-data.js` to `public\rosters-data.js` (the deploy folder already contains copies; re-copy whenever you update the game).

## 6. Deploy
```
npx wrangler deploy
```
It prints your address, like `https://cfb-dynasty.YOURNAME.workers.dev`. That is your online game. Open it, and share it with friends.

## Using it
1. Host: open your address, start a dynasty as usual, then go to Dynasty Central > Online > Create online dynasty. Share the 6-letter code and the address.
2. Friends: open the address, Dynasty Central > Online, enter the code, Look up, pick a school, Join.
3. Everyone plays their own recruiting and roster. The game sends your changes to the host automatically.
4. Press "I'm ready" when you are done for the week. The host sets a deadline, then presses "Advance for everyone".

## Updating the game later
Copy the new `dynasty.html` over `public\index.html`, then run `npx wrangler deploy` again. The database and dynasties are kept.

## Free tier notes
Each saved week is about 3 MB. The server keeps only the latest save per dynasty, so you will not run out of space. The free tier allows far more traffic than eight friends will use.

---

# Alternative: no command line (browser only), game stays on GitHub

You do NOT need wrangler. Only the small server (`worker.js`) lives on Cloudflare; the game page can stay on GitHub Pages like your other projects.

1. Cloudflare dashboard > Storage & Databases > D1 > Create database, name it `cfb-dynasty`. Open it > Console, paste the contents of `schema.sql` and run it.
2. Workers & Pages > Create > Create Worker (name it `cfb-dynasty`) > Deploy, then Edit code. Delete the sample, paste all of `worker.js`, and Deploy.
3. Worker > Settings > Bindings > Add > D1 database. Variable name must be exactly `DB`; pick `cfb-dynasty`. Deploy.
4. Copy the worker address (like `https://cfb-dynasty.yourname.workers.dev`).
5. Open `dynasty.html`, find `const MP_DEFAULT_URL=''` and put the address between the quotes. Push to GitHub as usual.

Friends can also open the game once with `?server=https://cfb-dynasty.yourname.workers.dev` on the end of the link.
