import { readFile } from 'node:fs/promises';
import dotenv from 'dotenv';
import nodemailer from 'nodemailer';
import { formatText } from './showcase.mjs';

export const DEFAULT_ENV_FILE = new URL('./.env', import.meta.url);
const ADDRESS = /^[^\s@<>,;:"()\\]+@[^\s@<>,;:"()\\]+\.[^\s@<>,;:"()\\]+$/;

export function emailConfig(env) {
  const required = ['GMAIL_USER', 'GMAIL_APP_PASSWORD', 'EMAIL_TO'];
  const missing = required.filter(key => !env[key]?.trim());
  if (missing.length) {
    throw new Error(`Missing email settings: ${missing.join(', ')}. Fill in .env using .env.example.`);
  }
  const user = env.GMAIL_USER.trim();
  const to = [...new Set(env.EMAIL_TO.split(',').map(address => address.trim()))];
  if (!ADDRESS.test(user)) throw new Error('GMAIL_USER must be a plain email address.');
  if (!to.every(address => ADDRESS.test(address))) {
    throw new Error('EMAIL_TO must contain plain email addresses separated by commas.');
  }
  const password = env.GMAIL_APP_PASSWORD.replace(/\s/g, '');
  if (!password) throw new Error('GMAIL_APP_PASSWORD must not be blank.');
  return { user, password, to };
}

export async function loadEmailConfig(file = DEFAULT_ENV_FILE, environment = process.env) {
  let settings = {};
  try {
    settings = dotenv.parse(await readFile(file, 'utf8'));
  } catch (error) {
    // Environment variables can supply all settings without a default .env file.
    if (error.code !== 'ENOENT' || file !== DEFAULT_ENV_FILE) {
      throw new Error('Unable to read the email .env file. Check its path and permissions.');
    }
  }
  return emailConfig({ ...settings, ...environment });
}

export function buildEmail(result, config) {
  const prefix = result.source === 'har' ? '[Archive] ' : '';
  return {
    from: config.user,
    to: config.to,
    subject: `${prefix}Farmingdale movies | ${result.date} | ${result.start}-${result.end} Eastern`,
    text: `${formatText(result)}\n\nChecked: ${result.checkedAt}\nShowtimes may change.\n`,
  };
}

export async function sendEmail(result, config, createTransport = nodemailer.createTransport) {
  const transport = createTransport({
    host: 'smtp.gmail.com', port: 465, secure: true,
    auth: { user: config.user, pass: config.password },
    connectionTimeout: 20_000, greetingTimeout: 20_000, socketTimeout: 30_000,
    disableFileAccess: true, disableUrlAccess: true,
  });
  try {
    let info;
    try {
      info = await transport.sendMail(buildEmail(result, config));
    } catch (error) {
      // Do not expose raw SMTP errors or credentials in console output.
      if (error.code === 'EAUTH') {
        throw new Error('Gmail authentication failed. Check GMAIL_USER and use a Google App Password with 2-Step Verification enabled.');
      }
      throw new Error('Gmail delivery failed. Check connectivity and recipient settings; delivery may be uncertain, so check Sent mail before retrying.');
    }
    const accepted = info.accepted?.length ?? 0;
    if (info.rejected?.length || accepted !== config.to.length) {
      throw new Error(`Gmail accepted ${accepted} of ${config.to.length} recipients. Check Sent mail and recipient addresses before retrying.`);
    }
    return { accepted };
  } finally {
    transport.close();
  }
}
