const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.resolve(__dirname, '../../data');
const DATA_FILE = path.join(DATA_DIR, 'data.json');

const defaults = {
  GuildConfig: {
    prefix: '!', applicationQuestions: [], ticketCategories: [], ticketSupportRoleIds: [],
    xpRoleRules: [], birthdayRewarded: [], filters: true, totalMessages: 0, totalWords: 0
  },
  UserStats: { totalXp: 0, weeklyXp: 0, level: 0 },
  Ticket: { status: 'open', helpers: [] },
  Giveaway: { entrants: [], ended: false },
  Drop: { ended: false },
  Application: { status: 'pending' },
  Reminder: { sent: false },
  Suggestion: { up: [], down: [] },
  Poll: { votes: {} },
  Tkm: { status: 'pending', choices: {} }
};

let state = {};
let initialized = false;
let writeQueue = Promise.resolve();

function revive(value) {
  if (Array.isArray(value)) return value.map(revive);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) out[key] = revive(item);
    return out;
  }
  if (typeof value === 'string' &&
      /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(value)) {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) return date;
  }
  return value;
}

async function init() {
  if (initialized) return;
  await fs.mkdir(DATA_DIR, { recursive: true });
  try {
    const raw = await fs.readFile(DATA_FILE, 'utf8');
    state = revive(JSON.parse(raw));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    state = {};
    await persist();
  }
  initialized = true;
}

function persist() {
  writeQueue = writeQueue.then(async () => {
    await fs.mkdir(DATA_DIR, { recursive: true });
    const temp = `${DATA_FILE}.tmp`;
    await fs.writeFile(temp, JSON.stringify(state, null, 2), 'utf8');
    await fs.rename(temp, DATA_FILE);
  });
  return writeQueue;
}

function getCollection(name) {
  if (!state[name]) state[name] = [];
  return state[name];
}

function getPath(object, dotted) {
  return dotted.split('.').reduce((value, key) => value == null ? undefined : value[key], object);
}

function matchesValue(actual, expected) {
  if (expected && typeof expected === 'object' && !Array.isArray(expected) && !(expected instanceof Date)) {
    for (const [operator, value] of Object.entries(expected)) {
      if (operator === '$lte' && !(new Date(actual).getTime() <= new Date(value).getTime())) return false;
      if (operator === '$lt' && !(actual < value)) return false;
      if (operator === '$gte' && !(new Date(actual).getTime() >= new Date(value).getTime())) return false;
      if (operator === '$gt' && !(actual > value)) return false;
      if (operator === '$ne' && actual === value) return false;
      if (operator === '$in' && !value.includes(actual)) return false;
      if (operator === '$nin' && value.includes(actual)) return false;
    }
    return true;
  }
  if (Array.isArray(actual)) return actual.includes(expected);
  if (actual instanceof Date || expected instanceof Date) {
    return new Date(actual).getTime() === new Date(expected).getTime();
  }
  return actual === expected;
}

function matches(document, query = {}) {
  return Object.entries(query).every(([key, expected]) => {
    if (key === '$or') return expected.some(part => matches(document, part));
    if (key === '$and') return expected.every(part => matches(document, part));
    return matchesValue(getPath(document, key), expected);
  });
}

function applyUpdate(document, update = {}) {
  const hasOperators = Object.keys(update).some(key => key.startsWith('$'));
  if (!hasOperators) {
    for (const [key, value] of Object.entries(update)) document[key] = value;
    return document;
  }
  if (update.$set) {
    for (const [key, value] of Object.entries(update.$set)) document[key] = value;
  }
  if (update.$inc) {
    for (const [key, value] of Object.entries(update.$inc)) document[key] = (Number(document[key]) || 0) + value;
  }
  if (update.$unset) {
    for (const key of Object.keys(update.$unset)) delete document[key];
  }
  return document;
}

function attachDocument(modelName, raw) {
  const document = raw;
  Object.defineProperties(document, {
    save: {
      enumerable: false,
      value: async function save() {
        await init();
        const collection = getCollection(modelName);
        const index = collection.findIndex(item => item._id === this._id);
        const plain = JSON.parse(JSON.stringify(this));
        if (index >= 0) collection[index] = plain;
        else collection.push(plain);
        await persist();
        return this;
      }
    },
    markModified: { enumerable: false, value: function markModified() {} }
  });
  return document;
}

class Query {
  constructor(model, kind, query) {
    this.model = model;
    this.kind = kind;
    this.query = query;
    this.sortSpec = null;
    this.max = null;
  }
  sort(spec) { this.sortSpec = spec; return this; }
  limit(count) { this.max = count; return this; }
  async exec() {
    await init();
    let rows = getCollection(this.model.modelName).filter(row => matches(row, this.query));
    if (this.sortSpec) {
      const entries = Object.entries(this.sortSpec);
      rows = [...rows].sort((a, b) => {
        for (const [key, direction] of entries) {
          const av = getPath(a, key), bv = getPath(b, key);
          const aa = av instanceof Date ? av.getTime() : av;
          const bb = bv instanceof Date ? bv.getTime() : bv;
          if (aa < bb) return -1 * direction;
          if (aa > bb) return 1 * direction;
        }
        return 0;
      });
    }
    if (this.kind === 'findOne') rows = rows.slice(0, 1);
    if (this.max != null) rows = rows.slice(0, this.max);
    const docs = rows.map(row => attachDocument(this.model.modelName, row));
    return this.kind === 'findOne' ? (docs[0] || null) : docs;
  }
  then(resolve, reject) { return this.exec().then(resolve, reject); }
  catch(reject) { return this.exec().catch(reject); }
}

class JsonModel {
  static get modelName() { return this.name; }
  static find(query = {}) { return new Query(this, 'find', query); }
  static findOne(query = {}) { return new Query(this, 'findOne', query); }
  static async findById(id) {
    await init();
    const row = getCollection(this.modelName).find(item => item._id === String(id));
    return row ? attachDocument(this.modelName, row) : null;
  }
  static async create(values = {}) {
    await init();
    const document = {
      ...(defaults[this.modelName] || {}),
      ...values,
      _id: values._id || crypto.randomUUID(),
      createdAt: values.createdAt || new Date(),
      updatedAt: new Date()
    };
    getCollection(this.modelName).push(JSON.parse(JSON.stringify(document)));
    await persist();
    return attachDocument(this.modelName, document);
  }
  static async updateOne(query, update, options = {}) {
    await init();
    const collection = getCollection(this.modelName);
    let row = collection.find(item => matches(item, query));
    if (!row && options.upsert) {
      row = { ...(defaults[this.modelName] || {}), ...query, _id: crypto.randomUUID(), createdAt: new Date() };
      collection.push(row);
    }
    if (!row) return { matchedCount: 0, modifiedCount: 0, upsertedCount: 0 };
    applyUpdate(row, update);
    row.updatedAt = new Date();
    await persist();
    return { matchedCount: 1, modifiedCount: 1, upsertedCount: options.upsert ? 1 : 0 };
  }
  static async updateMany(query, update) {
    await init();
    let count = 0;
    for (const row of getCollection(this.modelName)) {
      if (matches(row, query)) { applyUpdate(row, update); row.updatedAt = new Date(); count++; }
    }
    if (count) await persist();
    return { matchedCount: count, modifiedCount: count };
  }
  static async findOneAndUpdate(query, update, options = {}) {
    await init();
    let row = getCollection(this.modelName).find(item => matches(item, query));
    if (!row && options.upsert) {
      row = { ...(defaults[this.modelName] || {}), ...query, _id: crypto.randomUUID(), createdAt: new Date() };
      getCollection(this.modelName).push(row);
    }
    if (!row) return null;
    applyUpdate(row, update);
    row.updatedAt = new Date();
    await persist();
    return attachDocument(this.modelName, row);
  }
  static async deleteOne(query) {
    await init();
    const collection = getCollection(this.modelName);
    const index = collection.findIndex(item => matches(item, query));
    if (index < 0) return { deletedCount: 0 };
    collection.splice(index, 1);
    await persist();
    return { deletedCount: 1 };
  }
}

const names = [
  'GuildConfig', 'UserStats', 'Warning', 'Ticket', 'Giveaway', 'Drop',
  'Application', 'Reminder', 'Suggestion', 'Birthday', 'Tkm', 'Poll', 'ReactionRole'
];
const exported = {};
for (const name of names) {
  exported[name] = class extends JsonModel {};
  Object.defineProperty(exported[name], 'name', { value: name });
}
module.exports = { ...exported, initDatabase: init };
