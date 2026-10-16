#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

export const THEATER_ID = 'X00UF';
export const TIME_ZONE = 'America/New_York';
const API = 'https://www.showcasecinemas.com/api/gatsby-source-boxofficeapi/';

function localParts(instant) {
  return Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(instant).map(({ type, value }) => [type, value]));
}

export function upcomingTuesday(now = new Date(), includeToday = false, end = '19:00') {
  const cutoff = clockSeconds(end);
  const p = localParts(now);
  const day = new Date(`${p.year}-${p.month}-${p.day}T12:00:00Z`);
  const delta = (2 - day.getUTCDay() + 7) % 7;
  const localSeconds = Number(p.hour) * 3600 + Number(p.minute) * 60
    + Number(p.second) + now.getUTCMilliseconds() / 1000;
  const useToday = includeToday || localSeconds <= cutoff;
  day.setUTCDate(day.getUTCDate() + (delta || (useToday ? 0 : 7)));
  return day.toISOString().slice(0, 10);
}

export function validateDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)
      || Number.isNaN(Date.parse(`${value}T12:00:00Z`))
      || new Date(`${value}T12:00:00Z`).toISOString().slice(0, 10) !== value) {
    throw new Error('Date must be a valid YYYY-MM-DD date.');
  }
  return value;
}

function clockSeconds(value) {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) {
    throw new Error('Times must use 24-hour HH:MM, such as 17:00.');
  }
  const [hour, minute] = value.split(':').map(Number);
  return hour * 3600 + minute * 60;
}

function nextDate(date) {
  const day = new Date(`${date}T12:00:00Z`);
  day.setUTCDate(day.getUTCDate() + 1);
  return day.toISOString().slice(0, 10);
}

export function scheduleUrl(date) {
  validateDate(date);
  // Reproduce the site's theater-local 03:00-to-03:00 business-day request.
  // These are intentionally timezone-less strings, exactly as in the HAR.
  const query = new URLSearchParams({
    from: `${date}T03:00:00`,
    theaters: JSON.stringify({ id: THEATER_ID, timeZone: TIME_ZONE }),
    to: `${nextDate(date)}T03:00:00`,
  });
  return `${API}schedule?${query}`;
}

function movieUrl(ids) {
  const query = new URLSearchParams({ basic: 'false', castingLimit: '3' });
  ids.forEach(id => query.append('ids', id));
  return `${API}movies?${query}`;
}

async function fetchJson(url) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(url, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(20_000),
      });
      if (!response.ok) {
        if ((response.status === 429 || response.status >= 500) && attempt < 2) {
          await new Promise(resolve => setTimeout(resolve, 500 * 2 ** attempt));
          continue;
        }
        throw new Error(`Showcase returned HTTP ${response.status} for ${new URL(url).pathname}.`);
      }
      return await response.json();
    } catch (error) {
      if ((error instanceof TypeError || error.name === 'TimeoutError') && attempt < 2) {
        await new Promise(resolve => setTimeout(resolve, 500 * 2 ** attempt));
        continue;
      }
      throw error;
    }
  }
}

function theaterSchedule(payload) {
  const schedule = payload?.[THEATER_ID]?.schedule;
  if (!schedule || typeof schedule !== 'object' || Array.isArray(schedule)) {
    throw new Error('Schedule response has no valid Farmingdale schedule; the service may have changed.');
  }
  return schedule;
}

function localStart(value) {
  if (typeof value !== 'string') throw new Error('Showtime has no valid startsAt value.');
  // In the capture, startsAt is already theater-local and has no UTC suffix.
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?$/.test(value)) {
    if (Number.isNaN(Date.parse(value + 'Z'))) throw new Error('Invalid startsAt timestamp.');
    return value;
  }
  if (!/(Z|[+-]\d{2}:\d{2})$/.test(value) || Number.isNaN(Date.parse(value))) {
    throw new Error('Unrecognized startsAt timestamp.');
  }
  const p = localParts(new Date(value));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}`;
}

export function selectShowtimes(payload, date, start = '17:00', end = '19:00') {
  validateDate(date);
  const lower = clockSeconds(start);
  const upper = clockSeconds(end);
  if (upper < lower) throw new Error('End time must be at or after start time.');
  const schedule = theaterSchedule(payload);
  const rows = [];
  const seen = new Set();
  let dateShowtimes = 0;
  for (const [movieId, dates] of Object.entries(schedule)) {
    if (!dates || typeof dates !== 'object' || Array.isArray(dates)) {
      throw new Error('Unexpected movie schedule structure.');
    }
    for (const showtimes of Object.values(dates)) {
      if (!Array.isArray(showtimes)) throw new Error('Unexpected showtime list structure.');
      for (const show of showtimes) {
        const startsAt = localStart(show.startsAt);
        if (startsAt.slice(0, 10) !== date) continue;
        dateShowtimes++;
        const [h, m, s] = startsAt.slice(11).split(':').map(Number);
        const seconds = h * 3600 + m * 60 + s;
        if (seconds < lower || seconds > upper || show.isExpired === true) continue;
        const screen = show.screen?.name ?? null;
        const key = JSON.stringify([movieId, startsAt, screen, show.tags ?? []]);
        if (seen.has(key)) continue;
        seen.add(key);
        const ticket = (show.data?.ticketing ?? []).find(t => t.provider === 'default');
        rows.push({ movieId, startsAt, screen, tags: show.tags ?? [],
          ticketUrl: ticket?.urls?.[0] ?? null });
      }
    }
  }
  rows.sort((a, b) => a.startsAt.localeCompare(b.startsAt) || a.movieId.localeCompare(b.movieId));
  return { rows, dateShowtimes };
}

async function readArchive(file, date) {
  const archive = JSON.parse(await readFile(file, 'utf8'));
  const entries = archive.log?.entries;
  if (!Array.isArray(entries)) throw new Error('File is not a HAR archive.');
  const decode = entry => {
    const content = entry.response.content;
    return JSON.parse(content.encoding === 'base64'
      ? Buffer.from(content.text, 'base64').toString('utf8') : content.text);
  };
  const entry = entries.findLast(entry => {
    const url = new URL(entry.request.url);
    return url.pathname === '/api/gatsby-source-boxofficeapi/schedule'
      && url.searchParams.get('from') === `${date}T03:00:00`
      && url.searchParams.get('to') === `${nextDate(date)}T03:00:00`
      && url.searchParams.get('theaters')?.includes(THEATER_ID)
      && entry.response.status === 200;
  });
  if (!entry) throw new Error(`HAR contains no successful Farmingdale schedule request for ${date}.`);
  const movies = entries.filter(entry =>
    new URL(entry.request.url).pathname === '/api/gatsby-source-boxofficeapi/movies'
    && entry.response.status === 200).flatMap(decode);
  return { schedule: decode(entry), movies };
}

export async function lookup({ date, start = '17:00', end = '19:00', har } = {}) {
  if (clockSeconds(start) > clockSeconds(end)) throw new Error('End time must be at or after start time.');
  date = validateDate(date ?? upcomingTuesday(new Date(), false, end));
  const archive = har ? await readArchive(har, date) : null;
  const schedule = archive?.schedule ?? await fetchJson(scheduleUrl(date));
  const { rows, dateShowtimes } = selectShowtimes(schedule, date, start, end);
  const ids = [...new Set(rows.map(row => row.movieId))];
  const movies = archive?.movies ?? (ids.length ? await fetchJson(movieUrl(ids)) : []);
  if (!Array.isArray(movies)) throw new Error('Unexpected movie metadata response.');
  const titles = new Map(movies.map(movie => [String(movie.id), movie.title]));
  const showtimes = rows.map(row => {
    const title = titles.get(row.movieId);
    if (typeof title !== 'string' || !title.trim()) {
      throw new Error(`Movie title missing for ID ${row.movieId}.`);
    }
    return { title, ...row };
  });
  return {
    theater: 'Showcase Cinema de Lux Farmingdale', theaterId: THEATER_ID,
    date, timeZone: TIME_ZONE, start, end, inclusive: true,
    source: har ? 'har' : 'live', checkedAt: new Date().toISOString(),
    status: showtimes.length ? 'ok' : dateShowtimes ? 'no_matches' : 'no_schedule',
    showtimes,
  };
}

function displayTime(clock) {
  const [h, m] = clock.split(':').map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
}

export function formatText(result) {
  const lines = [`${result.theater} | ${result.date}`,
    `${displayTime(result.start)} through ${displayTime(result.end)} Eastern (inclusive)`];
  if (result.source === 'har') lines.push('Source: saved network archive (not a live lookup).');
  if (result.status === 'no_schedule') {
    lines.push('No showtimes returned for this date. The schedule may not be published yet; check again later.');
  } else if (result.status === 'no_matches') {
    lines.push('The date has showtimes, but none currently bookable in this time window.');
  } else {
    for (const show of result.showtimes) {
      const format = show.tags.includes('Internal.Brand.Xplus') ? 'XPlus' : 'Non-XPlus';
      lines.push(`${displayTime(show.startsAt.slice(11, 16))} | ${show.title} | ${format}${show.ticketUrl ? ` | Book: ${show.ticketUrl}` : ''}`);
    }
  }
  return lines.join('\n');
}

async function main() {
  const { values } = parseArgs({ options: {
    date: { type: 'string' }, start: { type: 'string', default: '17:00' },
    end: { type: 'string', default: '19:30' }, json: { type: 'boolean' },
    har: { type: 'string' }, 'include-today': { type: 'boolean' },
    email: { type: 'boolean' }, 'env-file': { type: 'string' },
    'dry-run': { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
  } });
  if (values.help) {
    console.log('Usage: node showcase.mjs [--date YYYY-MM-DD] [--start 17:00] [--end 19:30] [--json] [--har FILE] [--include-today] [--email [--dry-run] [--env-file FILE]]\nDefaults: Farmingdale, next Tuesday (today on Tuesday until the window ends), 5-7 PM Eastern inclusive.\n--include-today forces today on Tuesday, even after the window ends. --date overrides that choice.\n--email sends results via Gmail using .env beside this script. --dry-run previews without sending.\nRequires Node.js 18.17 or newer. Email support requires npm install.');
    return;
  }
  if (!values.email && (values['dry-run'] || values['env-file'])) {
    throw new Error('--dry-run and --env-file require --email.');
  }
  const mail = values.email ? await import('./email.mjs') : null;
  const config = mail ? await mail.loadEmailConfig(values['env-file']) : null;
  const result = await lookup({ ...values, date: values.date ?? upcomingTuesday(new Date(), values['include-today'], values.end) });
  if (mail) {
    if (values['dry-run']) {
      const preview = mail.buildEmail(result, config);
      console.error(`Email preview (not sent)\nFrom: ${preview.from}\nTo: ${preview.to.join(', ')}\nSubject: ${preview.subject}\n\n${preview.text}`);
    } else {
      const delivery = await mail.sendEmail(result, config);
      console.error(`Gmail accepted the email for ${delivery.accepted} recipient(s).`);
    }
  }
  console.log(values.json ? JSON.stringify(result, null, 2) : formatText(result));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(`Showcase check failed: ${error.message}${error.cause?.message ? ` (${error.cause.message})` : ''}`);
    process.exitCode = 1;
  });
}
