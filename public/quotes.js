// Quotes about giving from philosophers and writers (no religious texts).
// All are public domain (pre-1929 authors or translations).
// Every 5th page load (or shuffle) shows a Latin quote with its translation.

export const QUOTES = [
  { text: "To give money away is an easy matter and in any man's power. But to decide to whom to give it and how large and when, and for what purpose and how, is neither in every man's power nor an easy matter.", who: "Aristotle", source: "Nicomachean Ethics, tr. W. D. Ross" },
  { text: "You give but little when you give of your possessions. It is when you give of yourself that you truly give.", who: "Kahlil Gibran", source: "The Prophet" },
  { text: "The only gift is a portion of thyself.", who: "Ralph Waldo Emerson", source: "Gifts" },
  { text: "The liberal man will give for the sake of the noble, and rightly; for he will give to the right people, the right amounts, and at the right time.", who: "Aristotle", source: "Nicomachean Ethics, tr. W. D. Ross" },
  { text: "Goodness is the only investment that never fails.", who: "Henry David Thoreau", source: "Walden" },
];

export const LATIN = [
  { latin: "Bis dat qui cito dat.", text: "He gives twice who gives quickly.", who: "Latin proverb", source: "after Publilius Syrus" },
  { latin: "Ubicumque homo est, ibi beneficii locus est.", text: "Wherever there is a human being, there is a chance for a kindness.", who: "Seneca", source: "De Vita Beata" },
  { latin: "Non nobis solum nati sumus.", text: "We are not born for ourselves alone.", who: "Cicero", source: "De Officiis" },
  { latin: "Qui dedit beneficium taceat; narret qui accepit.", text: "Let the one who gave a kindness keep quiet; let the one who received it tell of it.", who: "Seneca", source: "De Beneficiis" },
  { latin: "Beneficium dando accepit, qui digno dedit.", text: "Whoever gives to someone deserving receives a kindness in the giving.", who: "Publilius Syrus", source: "Sententiae" },
];

const get = (k) => { try { return localStorage.getItem("jolly:" + k); } catch { return null; } };
const set = (k, v) => { try { localStorage.setItem("jolly:" + k, v); } catch {} };

let memoryCount = 0; // fallback when storage is unavailable

export function nextQuote() {
  const count = Number(get("quoteCount") || memoryCount) + 1;
  memoryCount = count;
  set("quoteCount", String(count));

  const latin = count % 5 === 0;
  const pool = latin ? LATIN : QUOTES;
  const lastKey = latin ? "lastLatin" : "lastQuote";
  const last = Number(get(lastKey));
  let i = Math.floor(Math.random() * pool.length);
  if (pool.length > 1 && i === last) i = (i + 1) % pool.length; // no repeats back to back
  set(lastKey, String(i));
  return { ...pool[i], isLatin: latin };
}

export function renderQuote(el) {
  const q = nextQuote();
  el.classList.toggle("is-latin", q.isLatin);
  el.querySelector(".q-latin").textContent = q.isLatin ? q.latin : "";
  el.querySelector(".q-text").textContent = q.text;
  el.querySelector(".q-who").textContent = "— " + q.who + (q.source ? ", " + q.source : "");
}
