"use strict";
const fs = require("node:fs");
const path = require("node:path");
const Ajv = require("ajv/dist/2020");
const addFormats = require("ajv-formats");

const ROOT = path.resolve(__dirname, "..", "..");
const DIRS = {
  sellers: path.join(ROOT, "sellers"),
  state: path.join(ROOT, "state"),
  partners: path.join(ROOT, "partners"),
  badges: path.join(ROOT, "badges"),
  dist: path.join(ROOT, "dist"),
  schema: path.join(ROOT, "schema"),
};

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
const validators = {};
function validator(name) {
  if (!validators[name]) validators[name] = ajv.compile(JSON.parse(fs.readFileSync(path.join(DIRS.schema, `${name}.schema.json`), "utf8")));
  return validators[name];
}

const SHORTENERS = ["bit.ly", "t.co", "tinyurl.com", "cutt.ly", "rb.gy", "is.gd", "goo.gl", "ow.ly", "buff.ly", "shorturl.at", "tiny.cc"];
const TWO_PART_TLDS = new Set(["co.uk", "org.uk", "ac.uk", "com.au", "net.au", "org.au", "co.jp", "co.nz", "com.br", "co.in", "com.sg", "co.kr", "com.mx", "com.ar"]);

function registrableDomain(hostname) {
  const parts = hostname.toLowerCase().split(".");
  if (parts.length <= 2) return parts.join(".");
  const last2 = parts.slice(-2).join(".");
  return TWO_PART_TLDS.has(last2) ? parts.slice(-3).join(".") : last2;
}

function readJson(file) { return JSON.parse(fs.readFileSync(file, "utf8")); }
function writeJsonAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n");
  fs.renameSync(tmp, file);
}
function listJson(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith(".json") && !f.startsWith("_")).sort();
}

function loadSellers() { return listJson(DIRS.sellers).map((f) => ({ file: path.join(DIRS.sellers, f), data: readJson(path.join(DIRS.sellers, f)) })); }
function loadPartners() { return listJson(DIRS.partners).map((f) => readJson(path.join(DIRS.partners, f))); }
function loadState(slug) {
  const file = path.join(DIRS.state, `${slug}.json`);
  return fs.existsSync(file) ? readJson(file) : { probes: [], proof_check: null, forgemesh_paid: null, bazaar_listed: false };
}
function saveState(slug, state) { writeJsonAtomic(path.join(DIRS.state, `${slug}.json`), state); }

// Static checks that need no network: schema, slug/filename, shorteners, domains, duplicates.
function staticErrors(entry, all) {
  const errors = [];
  const v = validator("seller");
  if (!v(entry.data)) errors.push(...v.errors.map((e) => `schema: ${e.instancePath || "/"} ${e.message}`));
  const s = entry.data;
  if (!s.slug) return errors;
  if (path.basename(entry.file, ".json") !== s.slug) errors.push(`filename must be ${s.slug}.json`);
  const urls = [s.homepage, ...(s.endpoints || []).map((e) => e.url), s.manifest, s.llms_txt].filter(Boolean);
  for (const u of urls) {
    let h; try { h = new URL(u).hostname.toLowerCase(); } catch { errors.push(`invalid URL ${u}`); continue; }
    if (SHORTENERS.includes(h)) errors.push(`URL shorteners are not allowed: ${u}`);
  }
  try {
    const home = registrableDomain(new URL(s.homepage).hostname);
    for (const e of s.endpoints || []) {
      if (registrableDomain(new URL(e.url).hostname) !== home && !String(s.contact).startsWith("github:")) {
        errors.push(`endpoint ${e.url} is not on the homepage domain ${home} (allowed only with a github: contact)`);
      }
    }
  } catch { /* reported above */ }
  const idx = s.nominated_endpoint ?? 0;
  if (s.endpoints && idx >= s.endpoints.length) errors.push(`nominated_endpoint ${idx} is out of range`);
  if (s.endpoints && s.endpoints[idx] && Number(s.endpoints[idx].price_usdc) > 0.01) errors.push(`nominated endpoint price ${s.endpoints[idx].price_usdc} exceeds the $0.01 cap`);
  if (s.proof && s.endpoints && s.proof.endpoint >= s.endpoints.length) errors.push(`proof.endpoint ${s.proof.endpoint} is out of range`);
  for (const other of all) {
    if (other.file === entry.file) continue;
    const o = other.data;
    if (o.slug === s.slug) errors.push(`duplicate slug ${s.slug}`);
    if (o.payTo && s.payTo && o.payTo.toLowerCase() === s.payTo.toLowerCase()) errors.push(`payTo already used by ${o.slug}`);
    if (o.proof?.tx_hash && s.proof?.tx_hash && o.proof.tx_hash.toLowerCase() === s.proof.tx_hash.toLowerCase()) errors.push(`proof tx already used by ${o.slug}`);
    try {
      if (registrableDomain(new URL(o.homepage).hostname) === registrableDomain(new URL(s.homepage).hostname)) errors.push(`homepage domain already used by ${o.slug}`);
    } catch { /* ignore */ }
  }
  return errors;
}

function partnerErrors(p) {
  const v = validator("partner");
  return v(p) ? [] : v.errors.map((e) => `schema: ${e.instancePath || "/"} ${e.message}`);
}

function feedErrors(feed) {
  const v = validator("verified-feed");
  return v(feed) ? [] : v.errors.map((e) => `feed: ${e.instancePath || "/"} ${e.message}`);
}

module.exports = { ROOT, DIRS, readJson, writeJsonAtomic, loadSellers, loadPartners, loadState, saveState, staticErrors, partnerErrors, feedErrors, registrableDomain, SHORTENERS };
